import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelConfig } from "@supbot/shared";
import { afterEach, describe, expect, test } from "vitest";
import type { ModelAdapter, ModelStreamEvent, ModelTurnRequest, ModelTurnResult } from "../../modelAdapter";
import { KbStore } from "../kbStore";
import { extractJson, sanitizePagePath, TwoStepIngest } from "./twoStep";

const tempDirs: string[] = [];

function createStore(): { root: string; store: KbStore } {
  const root = mkdtempSync(join(tmpdir(), "supbot-twostep-test-"));
  tempDirs.push(root);
  return { root, store: new KbStore(root) };
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const FAKE_MODEL_CONFIG: ModelConfig = {
  providerName: "fake",
  baseUrl: "http://localhost",
  model: "fake-model",
  temperature: 0,
  maxTokens: 4096,
  apiKeySaved: false,
};

/** 按队列依次返回固定回复的 fake adapter；Error 条目表示该次调用抛异常。 */
class FakeAdapter implements ModelAdapter {
  readonly requests: ModelTurnRequest[] = [];

  constructor(private readonly replies: Array<string | Error>) {}

  async complete(input: ModelTurnRequest): Promise<ModelTurnResult> {
    this.requests.push(input);
    const reply = this.replies.length > 1 ? this.replies.shift()! : this.replies[0];
    if (reply instanceof Error) {
      throw reply;
    }
    if (reply === undefined) {
      throw new Error("FakeAdapter: 没有剩余回复");
    }
    return { text: reply, toolCalls: [] };
  }

  async *stream(): AsyncGenerator<ModelStreamEvent, ModelTurnResult, unknown> {
    const result = await this.complete(this.requests[this.requests.length - 1]!);
    yield { type: "done", result };
    return result;
  }
}

function makeIngest(store: KbStore, adapter: ModelAdapter): TwoStepIngest {
  return new TwoStepIngest(store, {
    adapter,
    resolveModel: () => ({ modelConfig: FAKE_MODEL_CONFIG, apiKey: "sk-test" }),
  });
}

const STEP1_REPLY = JSON.stringify({
  entities: ["供应商管理系统"],
  concepts: ["供应商评估模型"],
  links_to_existing: ["现有页"],
  contradictions: [],
  structure_advice: { create: ["entities/供应商管理系统.md"], update: ["现有页"] },
  summary: "本文介绍供应商管理系统。",
});

const STEP2_REPLY = JSON.stringify([
  {
    op: "create",
    path: "entities/供应商管理系统.md",
    frontmatter: { type: "entity", title: "供应商管理系统" },
    body: "# 供应商管理系统\n\n参见 [[供应商评估模型]]。",
  },
]);

describe("TwoStepIngest 正常路径", () => {
  test("Step1 prompt 包含 purpose/schema/index，操作集应用到 store 并收尾", async () => {
    const { root, store } = createStore();
    writeFileSync(join(root, "purpose.md"), "自定义目标XYZ", "utf8");
    writeFileSync(join(root, "schema.md"), "自定义规则ABC", "utf8");
    store.writePage("concepts/现有页.md", { type: "concept", title: "现有页" }, "已有内容。");
    store.rebuildIndex();

    const adapter = new FakeAdapter([STEP1_REPLY, STEP2_REPLY, "重写后的概览"]);
    const ingest = makeIngest(store, adapter);
    const result = await ingest.ingest("采购白皮书", "# 采购白皮书\n\n正文内容。", "raw/sources/采购白皮书.pdf");

    expect(result.status).toBe("done");
    expect(result.source).toBe("raw/sources/采购白皮书.pdf");

    // Step1 prompt 组合了 purpose / schema / index / markdown
    const step1Prompt = String(adapter.requests[0]!.messages[0]!.content);
    expect(step1Prompt).toContain("自定义目标XYZ");
    expect(step1Prompt).toContain("自定义规则ABC");
    expect(step1Prompt).toContain("- [[现有页]]");
    expect(step1Prompt).toContain("# 采购白皮书");

    // Step2 prompt 带被点名的现有页内容
    const step2Prompt = String(adapter.requests[1]!.messages[0].content);
    expect(step2Prompt).toContain("### concepts/现有页.md");
    expect(step2Prompt).toContain("已有内容。");

    // 操作集应用：强制 sources（含当前源）与 created
    const page = store.readPage("entities/供应商管理系统.md");
    expect(page.meta.sources).toEqual(["raw/sources/采购白皮书.pdf"]);
    expect(typeof page.meta.created).toBe("string");
    expect(page.body).toContain("[[供应商评估模型]]");

    // 保底 sources 页（Step2 未含时补）
    expect(result.pages).toContain("entities/供应商管理系统.md");
    expect(result.pages).toContain("sources/采购白皮书.md");
    const sourcePage = store.readPage("sources/采购白皮书.md");
    expect(sourcePage.meta.type).toBe("source");
    expect(sourcePage.body).toContain("本文介绍供应商管理系统。");

    // index 重建 + log 追加 + overview 重写
    expect(store.readIndex()).toContain("- [[供应商管理系统]]");
    const log = readFileSync(join(root, "wiki", "log.md"), "utf8");
    expect(log).toContain("| ingest | entities/供应商管理系统.md | raw/sources/采购白皮书.pdf |");
    expect(store.readOverview()).toBe("重写后的概览\n");
  });

  test("Step2 操作集已含 sources 页时不重复补保底页", async () => {
    const { store } = createStore();
    const step2 = JSON.stringify([
      { op: "create", path: "sources/文档.md", frontmatter: { type: "source", title: "文档" }, body: "源摘要。" },
    ]);
    const adapter = new FakeAdapter([STEP1_REPLY, step2, "概览"]);
    const ingest = makeIngest(store, adapter);
    const result = await ingest.ingest("文档", "内容");

    expect(result.pages).toEqual(["sources/文档.md"]);
    const page = store.readPage("sources/文档.md");
    expect(page.body).toBe("源摘要。");
  });

  test("容错解析：```json 代码块与 {ops: [...]} 包装都被接受", async () => {
    const { store } = createStore();
    const step1 = `先说一句废话。\n\`\`\`json\n${STEP1_REPLY}\n\`\`\``;
    const step2 = JSON.stringify({ ops: [{ op: "create", path: "concepts/评估模型.md", body: "概念内容。" }] });
    const adapter = new FakeAdapter([step1, step2, "概览"]);
    const result = await makeIngest(store, adapter).ingest("文档", "内容");

    expect(result.status).toBe("done");
    expect(result.pages).toContain("concepts/评估模型.md");
    const page = store.readPage("concepts/评估模型.md");
    expect(page.meta.type).toBe("concept"); // frontmatter 缺省时按目录推断
    expect(page.meta.title).toBe("评估模型");
  });

  test("越权路径的操作被跳过", async () => {
    const { root, store } = createStore();
    const step2 = JSON.stringify([
      { op: "create", path: "../evil.md", body: "x" },
      { op: "create", path: "notes/外面.md", body: "x" },
      { op: "delete", path: "concepts/不支持的操作.md", body: "x" },
      { op: "create", path: "wiki/entities/允许.md", body: "wiki/ 前缀被剥离" },
    ]);
    const adapter = new FakeAdapter([STEP1_REPLY, step2, "概览"]);
    const result = await makeIngest(store, adapter).ingest("文档", "内容");

    expect(result.pages).not.toContain("../evil.md");
    expect(store.listPages()).toEqual(["entities/允许.md", "sources/文档.md"]);
    expect(readFileSync(join(root, "wiki", "entities", "允许.md"), "utf8")).toContain("wiki/ 前缀被剥离");
  });
});

describe("TwoStepIngest 保底路径", () => {
  test("Step1 两次都返回垃圾 → partial + 保底 sources 页 + index/log/overview 照常", async () => {
    const { root, store } = createStore();
    const markdown = `# 标题\n\n${"很长的正文。".repeat(500)}`;
    const adapter = new FakeAdapter(["这不是 JSON", "也不是 JSON", "保底后的概览"]);
    const result = await makeIngest(store, adapter).ingest("报告", markdown, "raw/sources/报告.txt");

    expect(result.status).toBe("partial");
    expect(result.pages).toEqual(["sources/报告.md"]);
    expect(result.summary).toBe(markdown.slice(0, 2000));

    const page = store.readPage("sources/报告.md");
    expect(page.meta.type).toBe("source");
    expect(page.meta.sources).toEqual(["raw/sources/报告.txt"]);
    expect(page.body).toContain(markdown.slice(0, 2000));

    expect(store.readIndex()).toContain("- [[报告]]");
    expect(readFileSync(join(root, "wiki", "log.md"), "utf8")).toContain("| ingest | sources/报告.md |");
    expect(store.readOverview()).toBe("保底后的概览\n");
  });

  test("Step2 两次都返回垃圾 → 仍保底 sources 页", async () => {
    const { store } = createStore();
    const adapter = new FakeAdapter([STEP1_REPLY, "垃圾", "还是垃圾", "概览"]);
    const result = await makeIngest(store, adapter).ingest("文档", "内容");

    expect(result.status).toBe("done");
    expect(result.pages).toEqual(["sources/文档.md"]);
  });

  test("overview 重写失败不阻断摄入且保留旧版", async () => {
    const { store } = createStore();
    store.writeOverview("旧概览\n");
    const adapter = new FakeAdapter([STEP1_REPLY, STEP2_REPLY, new Error("LLM 超时")]);
    const result = await makeIngest(store, adapter).ingest("采购白皮书", "内容");

    expect(result.status).toBe("done");
    expect(store.readOverview()).toBe("旧概览\n");
  });
});

describe("extractJson / sanitizePagePath", () => {
  test("extractJson 依次尝试 整体 → 代码块 → 括号包裹段", () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
    expect(extractJson('前言 ```json\n{"a": 2}\n``` 后记')).toEqual({ a: 2 });
    // 与 Python 一致：先尝试 {} 包裹段，再尝试 [] 包裹段
    expect(extractJson("说明 [1, 2] 完")).toEqual([1, 2]);
    expect(() => extractJson("完全没有 JSON")).toThrow("无法从 LLM 输出解析 JSON");
  });

  test("sanitizePagePath 只放行 wiki section 下的 .md", () => {
    expect(sanitizePagePath("entities/a.md")).toBe("entities/a.md");
    expect(sanitizePagePath("wiki/concepts/b.md")).toBe("concepts/b.md");
    expect(sanitizePagePath("../a.md")).toBeNull();
    expect(sanitizePagePath("/abs/a.md")).toBeNull();
    expect(sanitizePagePath("C:/abs/a.md")).toBeNull();
    expect(sanitizePagePath("entities/nested/a.md")).toBeNull();
    expect(sanitizePagePath("entities/a.txt")).toBeNull();
    expect(sanitizePagePath("unknown/a.md")).toBeNull();
    expect(sanitizePagePath(42)).toBeNull();
  });
});
