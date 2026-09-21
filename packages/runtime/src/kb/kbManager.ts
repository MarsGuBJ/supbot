/**
 * 资料管理（kb）子系统 facade：把 kbStore / ingest / query / review / graph
 * 各模块按「多项目」组装成一组可供 IPC 调用的方法。
 *
 * 目录布局：
 *   <kbRoot>/projects/<项目名>/        # 每个项目一份完整 kb_root（KbStore 初始化）
 *   <kbRoot>/graph-templates/<名>.md   # 全局图谱模版（GraphTemplateStore）
 *
 * LLM 依赖（adapter + resolveModel）由 runtime 注入，复用 chat 路径的
 * 当前 ModelProvider 解析。所有 LLM 调用经一层包装 adapter：调用时重新解析
 * 当前模型配置与 API Key；未配置 Key 时抛带中文消息的错误——
 * TwoStepIngest 捕获后走保底源摘要页，chat/graphExtract 由本类显式前置校验。
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type {
  GraphExtraction,
  GraphTemplate,
  KbChatHistoryMessage,
  KbChatResponse,
  KbDeleteSourceResult,
  KbDocumentWithProgress,
  KbGraphStatus,
  KbIngestTask,
  KbLintReport,
  KbMarkdownDocument,
  KbProject,
  KbRescanResult,
  KbReviewItem,
  KbSearchResult,
  KbWikiGraph,
  ModelConfig,
  WikiPage,
} from "@supbot/shared";
import { normalizeModelApiKey, type ModelAdapter, type ModelTurnRequest } from "../modelAdapter";
import { GraphExtractor } from "./graph/extractor";
import { GraphTemplateStore } from "./graph/templates";
import { IngestCache } from "./ingest/cache";
import { lintWiki } from "./ingest/lint";
import { createConvertIngestHandler, IngestQueue } from "./ingest/queue";
import { TwoStepIngest } from "./ingest/twoStep";
import { KbStore, removeWikilink } from "./kbStore";
import { sha256Of } from "./pipelines/base";
import type { VisionLlm } from "./pipelines/vision";
import { KbQueryPipeline } from "./query/pipeline";
import { ReviewQueue } from "./review";
import { buildWikiGraph } from "./wikiGraph";

export const KB_MODEL_REQUIRED_MESSAGE = "知识库该功能需要先配置大模型（模型与 API Key）。";

/**
 * 阻断上传的可执行/脚本扩展名（端口 k-pipeline documents.py 的阻断清单）。
 */
export const KB_BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  "exe",
  "bat",
  "cmd",
  "ps1",
  "sh",
  "js",
  "vbs",
  "dll",
  "com",
  "msi",
  "scr",
]);

const PROJECT_NAME_RE = /^[\p{L}\p{N}_-]+$/u;
const MAX_PROJECT_NAME_LENGTH = 60;

export interface KbUploadInput {
  name: string;
  data: Uint8Array;
}

export interface KbManagerOptions {
  /** kb 根目录（<数据目录>/kb-root），下挂 projects/ 与 graph-templates/。 */
  kbRoot: string;
  /** LLM adapter（缺省时摄入只转换不入库，chat/graphExtract 抛中文错误）。 */
  adapter?: ModelAdapter;
  /** 调用时解析当前模型配置与 API Key（复用 runtime chat 同款解析）。 */
  resolveModel?: () => { modelConfig: ModelConfig; apiKey?: string };
  /** 视觉/OCR 专用解析（缺省时回退 resolveModel）。 */
  resolveVisionModel?: () => { modelConfig: ModelConfig; apiKey?: string };
  /** 摄入任务状态变更回调（转发到 runtime 事件流）。 */
  onEvent?: (task: KbIngestTask) => void;
}

/** 项目级对象：按需惰性构造并缓存。 */
interface ProjectContext {
  name: string;
  root: string;
  store: KbStore;
  reviewQueue: ReviewQueue;
  cache: IngestCache;
  ingestQueue: IngestQueue;
  queryPipeline: KbQueryPipeline;
}

export class KbManager {
  private readonly kbRoot: string;
  private readonly projectsRoot: string;
  private readonly templateStore: GraphTemplateStore;
  private readonly contexts = new Map<string, ProjectContext>();

  constructor(private readonly options: KbManagerOptions) {
    this.kbRoot = options.kbRoot;
    this.projectsRoot = join(this.kbRoot, "projects");
    this.templateStore = new GraphTemplateStore(this.kbRoot);
  }

  // ---- 项目管理 ----

  /** 列出 projects/ 下的全部知识库项目（按名称排序）。 */
  listProjects(): KbProject[] {
    if (!existsSync(this.projectsRoot)) {
      return [];
    }
    return readdirSync(this.projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.toKbProject(entry.name))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** 新建项目（校验名称防穿越，初始化 kb_root 布局）；已存在时直接返回。 */
  createProject(name: string): KbProject {
    const safeName = validateProjectName(name);
    const root = join(this.projectsRoot, safeName);
    if (!existsSync(root)) {
      new KbStore(root); // 初始化 raw/ + wiki/ + .kbase/ 布局
    }
    return this.toKbProject(safeName);
  }

  // ---- 文档摄入 ----

  /** 上传文件到 raw/sources/ 并 enqueue 摄入；阻断可执行/脚本扩展名。 */
  async uploadDocuments(project: string, files: KbUploadInput[]): Promise<KbIngestTask[]> {
    const ctx = this.contextFor(project);
    if (!files.length) {
      return [];
    }
    const sourcesDir = join(ctx.root, "raw", "sources");
    const paths: string[] = [];
    for (const file of files) {
      const name = validateUploadFileName(file.name);
      if (!file.data?.byteLength) {
        throw new Error(`上传文件为空: ${name}`);
      }
      const path = join(sourcesDir, name);
      writeFileSync(path, file.data);
      paths.push(path);
    }
    return Promise.all(paths.map((path) => ctx.ingestQueue.enqueue(path)));
  }

  /** raw/sources 列表（按上传时间倒序）+ 关联的最新摄入任务状态。 */
  listDocuments(project: string): KbDocumentWithProgress[] {
    const ctx = this.contextFor(project);
    const sourcesDir = join(ctx.root, "raw", "sources");
    const names = existsSync(sourcesDir)
      ? readdirSync(sourcesDir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
          .sort()
      : [];
    const tasks = ctx.ingestQueue.list();
    const docs = names.map((name) => {
      const path = join(sourcesDir, name);
      const stat = statSync(path);
      const relPath = `raw/sources/${name}`;
      const task = latestTaskFor(tasks, name);
      return {
        id: relPath,
        projectId: ctx.name,
        fileName: name,
        relPath,
        format: extname(name).replace(/^\./, "").toLowerCase(),
        sizeBytes: stat.size,
        sha256: ctx.cache.findBySource(relPath)?.sha256,
        createdAt: (stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime).toISOString(),
        task,
      };
    });
    // 最新上传的排在前面，文件名作为同时间戳时的稳定次序。
    return docs.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.fileName.localeCompare(b.fileName));
  }

  /** 读 raw/markdown 产物。 */
  readMarkdown(project: string, docName: string): KbMarkdownDocument {
    const ctx = this.contextFor(project);
    const stem = validateDocStem(docName);
    const relPath = `raw/markdown/${stem}.md`;
    const path = join(ctx.root, relPath);
    if (!existsSync(path)) {
      throw new Error(`文档尚未转换出 Markdown: ${docName}`);
    }
    const stat = statSync(path);
    return {
      name: stem,
      relPath,
      markdown: readFileSync(path, "utf8"),
      sizeBytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  }

  /** 删除源文档：raw 源文件 + markdown 产物 + 受影响 wiki 页 + 缓存记录级联。 */
  deleteSource(project: string, docName: string): Promise<KbDeleteSourceResult> {
    const ctx = this.contextFor(project);
    return ctx.ingestQueue.deleteSource(validateDocStem(docName));
  }

  /** 全量重扫 raw/sources：sha 未变跳过、有变化增量摄入、已消失源级联删除。 */
  async rescan(project: string): Promise<KbRescanResult> {
    const ctx = this.contextFor(project);
    const sourcesDir = join(ctx.root, "raw", "sources");
    const names = existsSync(sourcesDir)
      ? readdirSync(sourcesDir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name)
      : [];

    const enqueued: string[] = [];
    const skipped: string[] = [];
    const runs: Promise<KbIngestTask>[] = [];
    for (const name of names) {
      const path = join(sourcesDir, name);
      const sha = await sha256Of(path);
      if (ctx.cache.shouldSkip(sha)) {
        skipped.push(name);
        continue;
      }
      enqueued.push(name);
      runs.push(ctx.ingestQueue.enqueue(path));
    }

    const deletedSources: string[] = [];
    const seen = new Set<string>();
    for (const record of ctx.cache.listAll()) {
      if (!record.sourcePath) {
        continue;
      }
      const absolute = join(ctx.root, record.sourcePath);
      if (existsSync(absolute)) {
        continue;
      }
      const stem = stemOf(basename(record.sourcePath));
      if (seen.has(stem)) {
        continue;
      }
      seen.add(stem);
      await ctx.ingestQueue.deleteSource(stem);
      deletedSources.push(stem);
    }

    await Promise.all(runs);
    return { enqueued, skipped, deletedSources };
  }

  // ---- 检索与问答 ----

  search(project: string, query: string): KbSearchResult[] {
    return this.contextFor(project).queryPipeline.search(query);
  }

  async chat(project: string, query: string, history: KbChatHistoryMessage[] = []): Promise<KbChatResponse> {
    this.requireLlm();
    return this.contextFor(project).queryPipeline.chat(query, history);
  }

  // ---- Wiki 页 ----

  listWikiPages(project: string): string[] {
    return this.contextFor(project).store.listPages();
  }

  readWikiPage(project: string, relPath: string): WikiPage {
    return this.contextFor(project).store.readPage(relPath);
  }

  /** 整库 Wiki 链接图谱（logseq 风格全局图谱的数据）。 */
  wikiGraph(project: string): KbWikiGraph {
    return buildWikiGraph(this.contextFor(project).store);
  }

  // ---- Review 队列与巡检 ----

  listReviews(project: string): KbReviewItem[] {
    return this.contextFor(project).reviewQueue.list();
  }

  resolveReview(project: string, id: number): boolean {
    return this.contextFor(project).reviewQueue.resolve(id);
  }

  /** 删除一条评审记录（用于清理已处理的历史记录）。 */
  removeReview(project: string, id: number): boolean {
    return this.contextFor(project).reviewQueue.remove(id);
  }

  /**
   * 删除死链评审项对应的 [[wikilink]]：从源页正文中移除指向不存在页的链接
   * （保留显示文本），并把评审项标记为已解决。源页或链接已不存在时仅解决评审项。
   */
  removeDeadLink(project: string, reviewId: number): boolean {
    const ctx = this.contextFor(project);
    const item = ctx.reviewQueue.list().find((entry) => entry.id === reviewId);
    if (!item || !item.reason.startsWith("lint:dead_link")) {
      return false;
    }
    const target = /\[\[([^\]]+)\]\]\s*$/.exec(item.reason)?.[1]?.trim();
    if (!target) {
      return false;
    }
    const rel = item.sourceFile.replace(/\\/g, "/").replace(/^wiki\//, "");
    try {
      const page = ctx.store.readPage(rel);
      const { body, removed } = removeWikilink(page.body, target);
      if (removed) {
        ctx.store.writePage(rel, page.meta, body);
      }
    } catch {
      // 源页已删除：死链随之消失，只需解决评审项。
    }
    return ctx.reviewQueue.resolve(reviewId);
  }

  lint(project: string): KbLintReport {
    const ctx = this.contextFor(project);
    return lintWiki(ctx.store, ctx.reviewQueue);
  }

  // ---- 图谱模版（kbRoot 级全局） ----

  listGraphTemplates(): GraphTemplate[] {
    return this.templateStore.list();
  }

  saveGraphTemplate(template: GraphTemplate): GraphTemplate {
    return this.templateStore.save(template);
  }

  deleteGraphTemplate(name: string): boolean {
    return this.templateStore.delete(name);
  }

  // ---- 图谱抽取 ----

  /** 按模版从文档 Markdown 抽取图谱并写入 graphs/ 页。 */
  async graphExtract(project: string, docName: string, templateName: string): Promise<GraphExtraction> {
    this.requireLlm();
    const ctx = this.contextFor(project);
    const markdown = this.readMarkdown(project, docName).markdown;
    return this.extractor(ctx).extract(validateDocStem(docName), templateName, markdown);
  }

  /** 文档 × 全部模版的抽取状态（幂等性检查用，不需要 LLM）。 */
  graphStatus(project: string, docName: string): KbGraphStatus[] {
    const ctx = this.contextFor(project);
    const stem = validateDocStem(docName);
    const extractor = this.extractor(ctx);
    return this.templateStore.list().map((template) => {
      const extracted = extractor.isExtracted(stem, template.name);
      return {
        templateName: template.name,
        extracted,
        page: extracted ? extractor.graphPageName(stem, template.name) : undefined,
      };
    });
  }

  /** 读回已抽取页的 nodes/edges（可视化用，不需要 LLM）。 */
  graphView(project: string, docName: string, templateName: string): GraphExtraction {
    const ctx = this.contextFor(project);
    return this.extractor(ctx).view(validateDocStem(docName), templateName);
  }

  // ---- 启动恢复 ----

  /** 对所有项目恢复中断的摄入任务（单项目失败不影响其它项目）。 */
  async resumeIncompleteAll(): Promise<void> {
    for (const project of this.listProjects()) {
      try {
        await this.contextFor(project.name).ingestQueue.resumeIncomplete();
      } catch {
        // 单项目恢复失败不阻断其它项目
      }
    }
  }

  // ---- 内部 ----

  private toKbProject(name: string): KbProject {
    const rootPath = join(this.projectsRoot, name);
    let createdAt = new Date().toISOString();
    let updatedAt = createdAt;
    try {
      const stat = statSync(rootPath);
      createdAt = (stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime).toISOString();
      updatedAt = stat.mtime.toISOString();
    } catch {
      // 目录刚创建或 stat 失败：用当前时间兜底
    }
    return { id: name, name, rootPath, createdAt, updatedAt };
  }

  /** 校验项目存在并惰性构造项目级对象（KbStore/ReviewQueue/IngestQueue/KbQueryPipeline）。 */
  private contextFor(project: string): ProjectContext {
    const name = validateProjectName(project);
    const cached = this.contexts.get(name);
    if (cached) {
      return cached;
    }
    const root = join(this.projectsRoot, name);
    if (!existsSync(root)) {
      throw new Error(`知识库项目不存在: ${name}`);
    }
    const store = new KbStore(root);
    const reviewQueue = new ReviewQueue(root);
    const cache = new IngestCache(root);
    const llm = this.llm();
    const ingestQueue = new IngestQueue({
      projectRoot: root,
      projectId: name,
      reviewQueue,
      onEvent: this.options.onEvent,
      handler: createConvertIngestHandler({
        store,
        twoStep: new TwoStepIngest(store, {
          adapter: llm?.adapter ?? unavailableAdapter(),
          resolveModel: llm?.resolveModel ?? unavailableResolveModel,
        }),
        cache,
        convertOptions: { vision: this.vision(), reviewQueue },
      }),
    });
    const queryPipeline = new KbQueryPipeline(store, {
      adapter: llm?.adapter,
      resolveModel: llm?.resolveModel,
    });
    const ctx: ProjectContext = { name, root, store, reviewQueue, cache, ingestQueue, queryPipeline };
    this.contexts.set(name, ctx);
    return ctx;
  }

  /**
   * 包装 adapter：每次调用重新解析当前模型配置与 API Key，未配置 Key 时抛
   * 中文错误。TwoStepIngest 捕获后走保底页；pipeline/vision 的调用方按既有
   * 降级语义处理（低置信度进 Review）。
   */
  private llm(): { adapter: ModelAdapter; resolveModel: () => { modelConfig: ModelConfig; apiKey?: string } } | null {
    const inner = this.options.adapter;
    const resolveModel = this.options.resolveModel;
    if (!inner || !resolveModel) {
      return null;
    }
    const wrap = (input: ModelTurnRequest): ModelTurnRequest => {
      const { modelConfig, apiKey } = resolveModel();
      if (!normalizeModelApiKey(apiKey)) {
        throw new Error(KB_MODEL_REQUIRED_MESSAGE);
      }
      return { ...input, modelConfig, apiKey };
    };
    return {
      adapter: {
        complete: (input) => inner.complete(wrap(input)),
        stream: (input) => inner.stream(wrap(input)),
      },
      resolveModel,
    };
  }

  /** 视觉 LLM（pdf-scan / image / 表格抢救）；无 LLM 依赖时为 null（走降级）。 */
  private vision(): VisionLlm | null {
    const inner = this.options.adapter;
    const resolveModel = this.options.resolveVisionModel ?? this.options.resolveModel;
    if (!inner || !resolveModel) {
      return null;
    }
    // modelConfig/apiKey 在包装 adapter 内按调用时重解析，这里仅需占位值。
    const wrap = (input: ModelTurnRequest): ModelTurnRequest => {
      const { modelConfig, apiKey } = resolveModel();
      if (!normalizeModelApiKey(apiKey)) {
        throw new Error(KB_MODEL_REQUIRED_MESSAGE);
      }
      return { ...input, modelConfig, apiKey };
    };
    return {
      adapter: {
        complete: (input) => inner.complete(wrap(input)),
        stream: (input) => inner.stream(wrap(input)),
      },
      modelConfig: resolveModel().modelConfig,
    };
  }

  private extractor(ctx: ProjectContext): GraphExtractor {
    const llm = this.llm();
    return new GraphExtractor(
      ctx.store,
      this.templateStore,
      llm
        ? { adapter: llm.adapter, modelConfig: llm.resolveModel().modelConfig }
        : { adapter: unavailableAdapter(), modelConfig: emptyModelConfig() },
    );
  }

  private requireLlm(): void {
    const resolveModel = this.options.resolveModel;
    if (!this.options.adapter || !resolveModel || !normalizeModelApiKey(resolveModel().apiKey)) {
      throw new Error(KB_MODEL_REQUIRED_MESSAGE);
    }
  }
}

function unavailableAdapter(): ModelAdapter {
  return {
    complete: () => Promise.reject(new Error(KB_MODEL_REQUIRED_MESSAGE)),
    stream: () => {
      throw new Error(KB_MODEL_REQUIRED_MESSAGE);
    },
  };
}

function unavailableResolveModel(): { modelConfig: ModelConfig; apiKey?: string } {
  throw new Error(KB_MODEL_REQUIRED_MESSAGE);
}

function emptyModelConfig(): ModelConfig {
  return { providerName: "", baseUrl: "", model: "", temperature: 0, maxTokens: 0, apiKeySaved: false };
}

/** 项目名 slug 校验（字母/数字/下划线/连字符/中文），拒绝路径穿越。 */
function validateProjectName(name: string): string {
  const trimmed = (name || "").trim();
  if (!trimmed || trimmed.length > MAX_PROJECT_NAME_LENGTH || !PROJECT_NAME_RE.test(trimmed)) {
    throw new Error(`非法知识库项目名: ${name}`);
  }
  return trimmed;
}

/** 上传文件名校验：纯文件名（无目录），且不在可执行/脚本阻断清单内。 */
function validateUploadFileName(name: string): string {
  const trimmed = (name || "").trim();
  if (!trimmed || trimmed !== basename(trimmed) || trimmed.includes("..")) {
    throw new Error(`非法文件名: ${name}`);
  }
  const ext = extname(trimmed).replace(/^\./, "").toLowerCase();
  if (KB_BLOCKED_EXTENSIONS.has(ext)) {
    throw new Error(`出于安全考虑，不允许上传可执行/脚本文件（.${ext}）: ${trimmed}`);
  }
  return trimmed;
}

/** 文档名（stem）校验：不含路径分隔符与穿越。 */
function validateDocStem(docName: string): string {
  const trimmed = (docName || "").trim();
  if (!trimmed || /[/\\]/.test(trimmed) || trimmed.includes("..")) {
    throw new Error(`非法文档名: ${docName}`);
  }
  return trimmed.replace(/\.[^.]*$/, "");
}

/** 取某源文件名最新的一条摄入任务。 */
function latestTaskFor(tasks: KbIngestTask[], fileName: string): KbIngestTask | undefined {
  let latest: KbIngestTask | undefined;
  for (const task of tasks) {
    if (task.documentId && basename(task.documentId) === fileName) {
      if (!latest || task.createdAt > latest.createdAt) {
        latest = task;
      }
    }
  }
  return latest;
}

function stemOf(name: string): string {
  return name.replace(/\.[^.]*$/, "");
}
