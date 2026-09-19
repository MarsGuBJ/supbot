/**
 * 摄入队列：串行执行摄入任务，状态持久化到 <projectRoot>/.kbase/ingest-tasks.json。
 * 端口自 k-pipeline app/ingest/queue.py 的 sync 模式（无线程/Redis 语义）：
 * enqueue 后在进程内串行执行（一个任务跑完再下一个），失败在进程内重试 ≤ maxRetries 次。
 *
 * 任务状态：pending / parsing / ingesting / done / failed（+ 错误信息），
 * 每次状态变更即持久化并通过 onEvent 回调通知外部。
 *
 * 中断恢复：进程在任务执行中途被杀时，状态会停在非终态。resumeIncomplete()
 * （启动时调用）把这些任务重置为 pending 并重新执行；源文件已消失的任务直接标记 failed。
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { KbIngestTask, KbIngestTaskStatus } from "@supbot/shared";
import { KbStore } from "../kbStore";
import { convertFile, type ConvertFileOptions } from "../pipelines/orchestrator";
import { sha256Of } from "../pipelines/base";
import type { ReviewQueue } from "../review";
import { IngestCache } from "./cache";
import type { TwoStepIngest } from "./twoStep";

/** 实际处理器（convertFile + TwoStepIngest 的组合回调）；抛异常视为任务失败。 */
export type IngestTaskHandler = (taskId: string, filePath: string, queue: IngestQueue) => Promise<unknown>;

export interface IngestQueueOptions {
  /** kb_root 目录。 */
  projectRoot: string;
  /** 写入 KbIngestTask.projectId，默认取 projectRoot 目录名。 */
  projectId?: string;
  /** 摄入处理器（必填，阶段 6 组装时注入真实组合回调）。 */
  handler: IngestTaskHandler;
  /** Review 队列（供组合处理器复用，可选）。 */
  reviewQueue?: ReviewQueue;
  /** 进程内重试次数上限（对应 Python settings.ingest_max_retries），默认 2。 */
  maxRetries?: number;
  /** 任务状态每次变更时回调（持久化之后触发）。 */
  onEvent?: (task: KbIngestTask) => void;
}

export interface DeleteSourceResult {
  /** 被删除的 wiki 页 rel 路径。 */
  deletedPages: string[];
  /** 被删除的磁盘文件（raw 源文件 + markdown 产物）绝对路径。 */
  deletedFiles: string[];
}

/** 持久化到 JSON 的任务记录（KbIngestTask + 源文件路径）。 */
interface PersistedTask extends KbIngestTask {
  filePath: string;
}

const PROGRESS_BY_STATUS: Record<KbIngestTaskStatus, number | null> = {
  pending: 0,
  parsing: 0.3,
  ingesting: 0.6,
  done: 1,
  failed: null, // 保留失败前进度
};

export class IngestQueue {
  readonly projectRoot: string;
  readonly reviewQueue?: ReviewQueue;

  private readonly projectId: string;
  private readonly handler: IngestTaskHandler;
  private readonly maxRetries: number;
  private readonly onEvent?: (task: KbIngestTask) => void;
  private readonly filePath: string;
  /** 串行链尾：所有任务/删除操作都挂在这条链上依次执行。 */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: IngestQueueOptions) {
    this.projectRoot = options.projectRoot;
    this.projectId = options.projectId ?? basename(options.projectRoot);
    this.handler = options.handler;
    this.reviewQueue = options.reviewQueue;
    this.maxRetries = options.maxRetries ?? 2;
    this.onEvent = options.onEvent;
    this.filePath = join(this.projectRoot, ".kbase", "ingest-tasks.json");
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  /** 提交摄入任务；串行执行完成后 resolve 为最终状态的任务。 */
  enqueue(filePath: string): Promise<KbIngestTask> {
    const now = new Date().toISOString();
    const task: PersistedTask = {
      id: randomUUID(),
      projectId: this.projectId,
      documentId: filePath,
      filePath,
      status: "pending",
      progress: 0,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    const tasks = this.load();
    tasks.push(task);
    this.save(tasks);
    this.emit(task);
    return this.schedule(task.id, filePath);
  }

  /** 全部任务（按创建时间升序）。 */
  list(): KbIngestTask[] {
    return this.load().map((task) => IngestQueue.stripFilePath(task));
  }

  get(id: string): KbIngestTask | undefined {
    const task = this.load().find((entry) => entry.id === id);
    if (!task) {
      return undefined;
    }
    return IngestQueue.stripFilePath(task);
  }

  /** 剥离内部字段 filePath 后返回对外任务。 */
  private static stripFilePath(task: PersistedTask): KbIngestTask {
    const copy: Partial<PersistedTask> = { ...task };
    delete copy.filePath;
    return copy as KbIngestTask;
  }

  /**
   * 恢复中断任务：非终态（pending/parsing/ingesting）任务重置为 pending 并串行重跑，
   * 返回恢复的任务 id；源文件已消失的任务直接标记 failed。
   */
  async resumeIncomplete(): Promise<string[]> {
    const incomplete = this.load().filter(
      (task) => task.status === "pending" || task.status === "parsing" || task.status === "ingesting",
    );
    const resumed: string[] = [];
    const runs: Promise<KbIngestTask>[] = [];
    for (const task of incomplete) {
      if (!existsSync(task.filePath)) {
        this.setStatus(task.id, "failed", "源文件已不存在，无法恢复中断任务");
        continue;
      }
      this.setStatus(task.id, "pending");
      resumed.push(task.id);
      runs.push(this.schedule(task.id, task.filePath));
    }
    await Promise.all(runs);
    return resumed;
  }

  /**
   * 删除级联：删 raw 源文件与 markdown 产物、按 cache 反查受影响 wiki 页并删除、
   * 清理缓存记录、rebuild index、log.md 记录。
   *
   * @param docName 文档名（stem），匹配缓存记录的源文件名
   */
  deleteSource(docName: string): Promise<DeleteSourceResult> {
    const run = this.tail.then(() => this.doDeleteSource(docName));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 推进任务状态并持久化；每次变更触发 onEvent。 */
  setStatus(taskId: string, status: KbIngestTaskStatus, error?: string): void {
    const tasks = this.load();
    const task = tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error(`未知摄入任务: ${taskId}`);
    }
    task.status = status;
    task.error = error;
    const progress = PROGRESS_BY_STATUS[status];
    if (progress !== null) {
      task.progress = progress;
    }
    task.updatedAt = new Date().toISOString();
    this.save(tasks);
    this.emit(task);
  }

  // ---- 执行 ----

  /** 挂到串行链尾执行，resolve 为最终任务状态。 */
  private schedule(taskId: string, filePath: string): Promise<KbIngestTask> {
    const run = this.tail.then(() => this.runWithRetry(taskId, filePath));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then(() => this.mustGet(taskId));
  }

  /** 进程内重试 ≤ maxRetries 次，最终失败落 failed + 错误信息。 */
  private async runWithRetry(taskId: string, filePath: string): Promise<void> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      try {
        this.bumpAttempts(taskId);
        await this.handler(taskId, filePath, this);
        this.setStatus(taskId, "done");
        return;
      } catch (error) {
        if (attempt >= this.maxRetries) {
          const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          this.setStatus(taskId, "failed", message);
          return;
        }
      }
    }
  }

  private bumpAttempts(taskId: string): void {
    const tasks = this.load();
    const task = tasks.find((entry) => entry.id === taskId);
    if (task) {
      task.attempts += 1;
      task.updatedAt = new Date().toISOString();
      this.save(tasks);
    }
  }

  private doDeleteSource(docName: string): DeleteSourceResult {
    const store = new KbStore(this.projectRoot);
    const cache = new IngestCache(this.projectRoot);
    const records = cache.listAll().filter((record) => stemOf(basename(record.sourcePath)) === docName);

    const deletedFiles: string[] = [];
    const deletedSet = new Set<string>();
    const deleteFile = (absolute: string) => {
      if (deletedSet.has(absolute) || !existsSync(absolute)) {
        return;
      }
      unlinkSync(absolute);
      deletedSet.add(absolute);
      deletedFiles.push(absolute);
    };
    for (const record of records) {
      if (!record.sourcePath) {
        continue;
      }
      deleteFile(isAbsolute(record.sourcePath) ? record.sourcePath : join(this.projectRoot, record.sourcePath));
    }
    // 摄入失败的文档没有缓存记录，直接按 stem 扫 raw/sources 兜底删除。
    const sourcesDir = join(this.projectRoot, "raw", "sources");
    if (existsSync(sourcesDir)) {
      for (const entry of readdirSync(sourcesDir, { withFileTypes: true })) {
        if (entry.isFile() && stemOf(entry.name) === docName) {
          deleteFile(join(sourcesDir, entry.name));
        }
      }
    }
    deleteFile(join(this.projectRoot, "raw", "markdown", `${docName}.md`));

    const pages = [...new Set(records.flatMap((record) => record.pages))];
    const deletedPages: string[] = [];
    for (const page of pages) {
      if (store.deletePage(page)) {
        deletedPages.push(page);
        store.appendLog("delete", page, docName);
      }
    }
    for (const record of records) {
      cache.remove(record.sha256);
    }
    store.rebuildIndex();
    this.purgeTasksFor(docName);
    return { deletedPages, deletedFiles };
  }

  /** 从任务持久化文件中移除该文档的全部摄入任务记录（含 failed）。 */
  private purgeTasksFor(docName: string): void {
    const tasks = this.load();
    const kept = tasks.filter((task) => !task.documentId || stemOf(basename(task.documentId)) !== docName);
    if (kept.length !== tasks.length) {
      this.save(kept);
    }
  }

  private mustGet(taskId: string): KbIngestTask {
    const task = this.get(taskId);
    if (!task) {
      throw new Error(`摄入任务丢失: ${taskId}`);
    }
    return task;
  }

  private emit(task: PersistedTask): void {
    if (!this.onEvent) {
      return;
    }
    this.onEvent(IngestQueue.stripFilePath(task));
  }

  private load(): PersistedTask[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error(`Invalid ingest tasks file: ${this.filePath}`);
    }
    return raw as PersistedTask[];
  }

  private save(tasks: PersistedTask[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(tasks, null, 2)}\n`, "utf8");
    renameSync(tempPath, this.filePath);
  }
}

/** createConvertIngestHandler 的依赖：真实 convertFile + TwoStepIngest 的组合。 */
export interface ConvertIngestHandlerDeps {
  store: KbStore;
  twoStep: TwoStepIngest;
  cache: IngestCache;
  /** 透传给 convertFile（vision / reviewQueue / 阈值等）。 */
  convertOptions?: ConvertFileOptions;
}

/**
 * 默认组合处理器：sha 未变跳过 → convertFile（parsing）→ TwoStepIngest（ingesting）→ 记录缓存。
 * 对应 Python queue.default_handler + ingest_document 的缓存短路逻辑。
 */
export function createConvertIngestHandler(deps: ConvertIngestHandlerDeps): IngestTaskHandler {
  return async (taskId, filePath, queue) => {
    const sha = await sha256Of(filePath);
    if (deps.cache.shouldSkip(sha)) {
      return { status: "skipped", pages: deps.cache.affectedPages(sha) };
    }
    queue.setStatus(taskId, "parsing");
    const bundle = await convertFile(filePath, deps.store.kbRoot, deps.convertOptions);
    queue.setStatus(taskId, "ingesting");
    const docName = stemOf(basename(filePath));
    const ref = sourceRefFor(deps.store.kbRoot, filePath);
    const result = await deps.twoStep.ingest(docName, bundle.markdown, ref);
    deps.cache.record(sha, result.pages, ref);
    return result;
  };
}

/** 源文件在 frontmatter.sources[] / 缓存中的规范化引用（kb_root 内取 posix 相对路径）。 */
export function sourceRefFor(kbRoot: string, filePath: string): string {
  const rel = relative(kbRoot, filePath);
  const ref = rel && !rel.startsWith("..") ? rel : filePath;
  return ref.replace(/\\/g, "/");
}

function stemOf(name: string): string {
  return name.replace(/\.[^.]*$/, "");
}
