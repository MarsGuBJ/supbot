import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KbIngestTask, ModelConfig } from "@supbot/shared";
import { afterEach, describe, expect, test } from "vitest";
import type { ModelAdapter, ModelStreamEvent, ModelTurnRequest, ModelTurnResult } from "../../modelAdapter";
import { KbStore } from "../kbStore";
import { IngestCache } from "./cache";
import { createConvertIngestHandler, IngestQueue, sourceRefFor } from "./queue";
import { TwoStepIngest } from "./twoStep";

const tempDirs: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "supbot-ingestqueue-test-"));
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** 记录调用顺序的 fake 处理器；可选失败。 */
function recordingHandler(calls: string[], options: { fail?: boolean } = {}) {
  return async (taskId: string, filePath: string, queue: IngestQueue): Promise<void> => {
    queue.setStatus(taskId, "parsing");
    queue.setStatus(taskId, "ingesting");
    calls.push(filePath);
    if (options.fail) {
      throw new Error("处理器炸了");
    }
  };
}

/** 直接落盘两条非终态任务，模拟进程中断后的残留状态。 */
function seedInterruptedTasks(root: string): void {
  mkdirSync(join(root, ".kbase"), { recursive: true });
  const now = new Date().toISOString();
  const tasks = [
    {
      id: "seeded-task",
      projectId: "seed",
      filePath: join(root, "seeded.txt"),
      status: "ingesting",
      progress: 0.6,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "gone-task",
      projectId: "seed",
      filePath: join(root, "已删除.txt"),
      status: "parsing",
      progress: 0.3,
      attempts: 1,
      createdAt: now,
      updatedAt: now,
    },
  ];
  writeFileSync(join(root, ".kbase", "ingest-tasks.json"), `${JSON.stringify(tasks, null, 2)}\n`, "utf8");
}

describe("IngestQueue 执行与持久化", () => {
  test("enqueue → 状态流转 pending/parsing/ingesting/done → 持久化 → onEvent 通知", async () => {
    const root = createRoot();
    const source = join(root, "文档.txt");
    writeFileSync(source, "内容", "utf8");
    const events: KbIngestTask[] = [];
    const calls: string[] = [];
    const queue = new IngestQueue({
      projectRoot: root,
      handler: recordingHandler(calls),
      onEvent: (task) => events.push(task),
    });

    const task = await queue.enqueue(source);
    expect(task.status).toBe("done");
    expect(task.progress).toBe(1);
    expect(task.attempts).toBe(1);
    expect(calls).toEqual([source]);

    // 状态每次变更即持久化：新实例读取一致
    const reopened = new IngestQueue({ projectRoot: root, handler: recordingHandler([]) });
    expect(reopened.get(task.id)?.status).toBe("done");
    expect(reopened.list()).toHaveLength(1);

    const statuses = events.map((event) => event.status);
    expect(statuses).toEqual(["pending", "parsing", "ingesting", "done"]);
  });

  test("串行执行：一个任务跑完再下一个", async () => {
    const root = createRoot();
    const calls: string[] = [];
    const slow = async (taskId: string, filePath: string, q: IngestQueue): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await recordingHandler(calls)(taskId, filePath, q);
    };
    const serial = new IngestQueue({ projectRoot: root, handler: slow });
    const [first, second] = await Promise.all([serial.enqueue("a.txt"), serial.enqueue("b.txt")]);
    expect(calls).toEqual(["a.txt", "b.txt"]);
    expect(first.status).toBe("done");
    expect(second.status).toBe("done");
  });

  test("处理器失败：重试 ≤ maxRetries 次后落 failed + 错误信息", async () => {
    const root = createRoot();
    const calls: string[] = [];
    const queue = new IngestQueue({ projectRoot: root, handler: recordingHandler(calls, { fail: true }) });
    const task = await queue.enqueue("坏文档.txt");

    expect(task.status).toBe("failed");
    expect(task.error).toContain("处理器炸了");
    expect(task.attempts).toBe(2); // 默认 maxRetries=2，共 2 次尝试
    expect(calls).toHaveLength(2);
  });

  test("resumeIncomplete：非终态任务重置重跑，源文件消失的标记 failed", async () => {
    const root = createRoot();
    writeFileSync(join(root, "seeded.txt"), "内容", "utf8");
    seedInterruptedTasks(root);

    const calls: string[] = [];
    const queue = new IngestQueue({ projectRoot: root, handler: recordingHandler(calls) });
    const resumed = await queue.resumeIncomplete();

    expect(resumed).toEqual(["seeded-task"]);
    expect(queue.get("seeded-task")?.status).toBe("done");
    expect(calls).toEqual([join(root, "seeded.txt")]);
    const gone = queue.get("gone-task");
    expect(gone?.status).toBe("failed");
    expect(gone?.error).toContain("源文件已不存在");
  });
});

const FAKE_MODEL_CONFIG: ModelConfig = {
  providerName: "fake",
  baseUrl: "http://localhost",
  model: "fake-model",
  temperature: 0,
  maxTokens: 4096,
  apiKeySaved: false,
};

/** 始终返回垃圾的 adapter：强制 TwoStepIngest 走保底 sources 页路径。 */
class GarbageAdapter implements ModelAdapter {
  requests = 0;

  async complete(): Promise<ModelTurnResult> {
    this.requests += 1;
    return { text: "这不是 JSON", toolCalls: [] };
  }

  async *stream(): AsyncGenerator<ModelStreamEvent, ModelTurnResult, unknown> {
    const result = await this.complete({} as ModelTurnRequest);
    yield { type: "done", result };
    return result;
  }
}

describe("IngestQueue.deleteSource 级联", () => {
  test("真实 convertFile(txt) 摄入后删除级联：raw/markdown/wiki 页/缓存全清理", async () => {
    const root = createRoot();
    const store = new KbStore(root);
    const source = join(root, "raw", "sources", "报告.txt");
    writeFileSync(source, "供应商管理报告正文。", "utf8");

    const adapter = new GarbageAdapter();
    const twoStep = new TwoStepIngest(store, {
      adapter,
      resolveModel: () => ({ modelConfig: FAKE_MODEL_CONFIG, apiKey: "sk-test" }),
    });
    const cache = new IngestCache(root);
    const queue = new IngestQueue({
      projectRoot: root,
      handler: createConvertIngestHandler({ store, twoStep, cache }),
    });

    const task = await queue.enqueue(source);
    expect(task.status).toBe("done");
    expect(existsSync(join(root, "raw", "markdown", "报告.md"))).toBe(true);
    expect(store.listPages()).toEqual(["sources/报告.md"]);
    expect(store.readIndex()).toContain("- [[报告]]");
    const ref = sourceRefFor(root, source);
    expect(ref).toBe("raw/sources/报告.txt");
    expect(cache.listAll()).toHaveLength(1);
    const llmCallsAfterIngest = adapter.requests;
    expect(llmCallsAfterIngest).toBeGreaterThan(0);

    // sha 未变：重复 enqueue 直接跳过，不再调用 LLM
    const again = await queue.enqueue(source);
    expect(again.status).toBe("done");
    expect(adapter.requests).toBe(llmCallsAfterIngest);

    // 删除级联
    const result = await queue.deleteSource("报告");
    expect(result.deletedPages).toEqual(["sources/报告.md"]);
    expect(result.deletedFiles).toContain(source);
    expect(result.deletedFiles).toContain(join(root, "raw", "markdown", "报告.md"));
    expect(existsSync(source)).toBe(false);
    expect(existsSync(join(root, "raw", "markdown", "报告.md"))).toBe(false);
    expect(store.listPages()).toEqual([]);
    expect(new IngestCache(root).listAll()).toEqual([]);
    expect(store.readIndex()).not.toContain("[[报告]]");
    expect(readFileSync(join(root, "wiki", "log.md"), "utf8")).toContain("| delete | sources/报告.md | 报告 |");
  });

  test("deleteSource 对未知文档是空操作", async () => {
    const root = createRoot();
    new KbStore(root);
    const queue = new IngestQueue({ projectRoot: root, handler: recordingHandler([]) });
    const result = await queue.deleteSource("不存在");
    expect(result).toEqual({ deletedPages: [], deletedFiles: [] });
  });

  test("deleteSource 清理摄入失败的文档：无缓存记录也删 raw 源文件与任务记录", async () => {
    const root = createRoot();
    new KbStore(root);
    const source = join(root, "raw", "sources", "坏文档.pdf");
    writeFileSync(source, "broken", "utf8");
    const queue = new IngestQueue({
      projectRoot: root,
      maxRetries: 1,
      handler: async () => {
        throw new Error("模拟解析失败");
      },
    });

    const task = await queue.enqueue(source);
    expect(task.status).toBe("failed");
    expect(new IngestCache(root).listAll()).toEqual([]);

    const result = await queue.deleteSource("坏文档");
    expect(result.deletedFiles).toContain(source);
    expect(existsSync(source)).toBe(false);
    expect(queue.list()).toEqual([]);
  });
});
