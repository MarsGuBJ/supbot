import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { GraphTemplate, ModelConfig } from "@supbot/shared";
import type { AdapterMessage, ModelAdapter, ModelTurnRequest, ModelTurnResult } from "../../modelAdapter";
import { KbStore } from "../kbStore";
import {
  buildExtractPrompt,
  extractJson,
  GraphExtractor,
  graphPageName,
  parseGraphPage,
  renderGraphPage,
  validateExtraction,
} from "./extractor";
import { GraphTemplateStore } from "./templates";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "supbot-graph-extractor-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const MODEL_CONFIG: ModelConfig = {
  providerName: "fake",
  baseUrl: "https://example.invalid",
  model: "fake-model",
  temperature: 0,
  maxTokens: 1024,
  apiKeySaved: false,
};

/** Fake ModelAdapter replaying a queue of texts; records the messages it received. */
class FakeAdapter implements ModelAdapter {
  calls: AdapterMessage[][] = [];

  constructor(private readonly responses: string[]) {}

  async complete(input: ModelTurnRequest): Promise<ModelTurnResult> {
    this.calls.push(input.messages);
    const text = this.responses.length > 1 ? this.responses.shift()! : (this.responses[0] ?? "");
    return { text, toolCalls: [] };
  }

  async *stream(): AsyncGenerator<never, ModelTurnResult, unknown> {
    yield* [];
    throw new Error("stream not supported in tests");
  }
}

const TEMPLATE: GraphTemplate = {
  name: "供应商关系",
  description: "抽取供应商之间的合作关系",
  entityTypes: ["供应商", "产品"],
  relationTypes: ["供应", "竞争"],
  instructions: "关注长期合作协议。",
};

const VALID_RESULT = {
  match: true,
  nodes: [
    { name: "华星光电", type: "供应商", description: "面板厂商" },
    { name: "OLED 面板", type: "产品", description: "核心物料" },
  ],
  edges: [{ source: "华星光电", target: "OLED 面板", relation: "供应", description: "长期供货" }],
};

function setup(responses: string[]): { extractor: GraphExtractor; kb: KbStore; adapter: FakeAdapter } {
  const kb = new KbStore(createTempDir());
  const templates = new GraphTemplateStore(createTempDir());
  templates.save(TEMPLATE);
  const adapter = new FakeAdapter(responses);
  return { extractor: new GraphExtractor(kb, templates, { adapter, modelConfig: MODEL_CONFIG }), kb, adapter };
}

describe("graphPageName", () => {
  test("is deterministic and uses the document stem", () => {
    expect(graphPageName("raw/sources/采购白皮书.pdf", "供应商关系")).toBe("graphs/采购白皮书--供应商关系.md");
    expect(graphPageName("采购白皮书", "供应商关系")).toBe("graphs/采购白皮书--供应商关系.md");
  });
});

describe("GraphExtractor.extract", () => {
  test("extracts nodes/edges, renders the graphs page and returns the structure", async () => {
    const { extractor, kb, adapter } = setup([JSON.stringify(VALID_RESULT)]);
    const result = await extractor.extract(
      "raw/sources/采购白皮书.pdf",
      "供应商关系",
      "# 正文\n华星光电长期供应 OLED 面板。",
    );
    expect(result).toEqual({ match: true, nodes: VALID_RESULT.nodes, edges: VALID_RESULT.edges });

    // The prompt is the single user message and mentions template + markdown.
    expect(adapter.calls).toHaveLength(1);
    const prompt = adapter.calls[0]![0]!;
    expect(prompt.role).toBe("user");
    expect(prompt.content).toContain("名称：供应商关系");
    expect(prompt.content).toContain("实体类型：供应商、产品");
    expect(prompt.content).toContain("补充说明：关注长期合作协议。");
    expect(prompt.content).toContain("华星光电长期供应 OLED 面板。");

    const page = kb.readPage("graphs/采购白皮书--供应商关系.md");
    expect(page.meta.type).toBe("graph");
    expect(page.meta.title).toBe("采购白皮书 · 供应商关系 图谱");
    expect(page.meta.sources).toEqual(["raw/sources/采购白皮书.pdf"]);
    expect(typeof page.meta.created).toBe("string");
    expect(page.body).toContain("# 采购白皮书 × 供应商关系 知识图谱");
    expect(page.body).toContain("> 来源文档：[[采购白皮书]]");
    expect(page.body).toContain("| 华星光电 | 供应商 | 面板厂商 |");
    expect(page.body).toContain("| 华星光电 | 供应 | OLED 面板 | 长期供货 |");
    expect(page.body).toContain("```json");
    expect(parseGraphPage(page.body)).toEqual({ nodes: VALID_RESULT.nodes, edges: VALID_RESULT.edges });
  });

  test("tolerates JSON wrapped in prose and a code fence", async () => {
    const { extractor, kb } = setup([`好的，结果如下：\n\`\`\`json\n${JSON.stringify(VALID_RESULT)}\n\`\`\`\n以上。`]);
    const result = await extractor.extract("采购白皮书", "供应商关系", "markdown");
    expect(result.match).toBe(true);
    expect(kb.readPage("graphs/采购白皮书--供应商关系.md").body).toContain("```json");
  });

  test("retries once on unparseable output, then degrades to no-match without writing a page", async () => {
    const { extractor, adapter } = setup(["不是 JSON", "依然不是 JSON"]);
    const result = await extractor.extract("采购白皮书", "供应商关系", "markdown");
    expect(result).toEqual({ match: false, nodes: [], edges: [] });
    expect(adapter.calls).toHaveLength(2);
    expect(extractor.isExtracted("采购白皮书", "供应商关系")).toBe(false);
  });

  test("retries once and succeeds when the second response parses", async () => {
    const { extractor, adapter } = setup(["垃圾输出", JSON.stringify(VALID_RESULT)]);
    const result = await extractor.extract("采购白皮书", "供应商关系", "markdown");
    expect(result.match).toBe(true);
    expect(adapter.calls).toHaveLength(2);
  });

  test("match=false yields a no-match result and writes no page", async () => {
    const { extractor } = setup([JSON.stringify({ match: false, nodes: [], edges: [] })]);
    const result = await extractor.extract("采购白皮书", "供应商关系", "markdown");
    expect(result).toEqual({ match: false, nodes: [], edges: [] });
    expect(extractor.isExtracted("采购白皮书", "供应商关系")).toBe(false);
  });

  test("drops dangling edges and nodes with invalid names", async () => {
    const messy = {
      match: true,
      nodes: [{ name: "华星光电", type: "供应商" }, { name: "", type: "无效" }, "not-an-object"],
      edges: [
        { source: "华星光电", target: "OLED 面板", relation: "供应" },
        { source: "华星光电", target: "幽灵节点", relation: "供应" },
      ],
    };
    // Add the missing node so one edge survives.
    messy.nodes.push({ name: "OLED 面板", type: "产品" } as never);
    const { extractor } = setup([JSON.stringify(messy)]);
    const result = await extractor.extract("采购白皮书", "供应商关系", "markdown");
    expect(result.match).toBe(true);
    expect(result.nodes.map((n) => n.name)).toEqual(["华星光电", "OLED 面板"]);
    expect(result.edges).toEqual([{ source: "华星光电", target: "OLED 面板", relation: "供应", description: "" }]);
  });

  test("empty nodes or edges after cleaning count as no-match", async () => {
    const { extractor } = setup([JSON.stringify({ match: true, nodes: [{ name: "A" }], edges: [] })]);
    const result = await extractor.extract("采购白皮书", "供应商关系", "markdown");
    expect(result.match).toBe(false);
  });

  test("throws when the template does not exist", async () => {
    const { extractor } = setup([JSON.stringify(VALID_RESULT)]);
    await expect(extractor.extract("采购白皮书", "缺失模版", "markdown")).rejects.toThrow(/模版不存在/);
  });
});

describe("GraphExtractor.isExtracted / view", () => {
  test("isExtracted flips to true after a successful extract", async () => {
    const { extractor } = setup([JSON.stringify(VALID_RESULT)]);
    expect(extractor.isExtracted("raw/sources/采购白皮书.pdf", "供应商关系")).toBe(false);
    await extractor.extract("raw/sources/采购白皮书.pdf", "供应商关系", "markdown");
    expect(extractor.isExtracted("raw/sources/采购白皮书.pdf", "供应商关系")).toBe(true);
  });

  test("view reads nodes/edges back from the json block", async () => {
    const { extractor } = setup([JSON.stringify(VALID_RESULT)]);
    await extractor.extract("raw/sources/采购白皮书.pdf", "供应商关系", "markdown");
    expect(extractor.view("采购白皮书", "供应商关系")).toEqual({
      match: true,
      nodes: VALID_RESULT.nodes,
      edges: VALID_RESULT.edges,
    });
  });

  test("view throws when the page is missing or has no json block", async () => {
    const { extractor, kb } = setup([JSON.stringify(VALID_RESULT)]);
    expect(() => extractor.view("采购白皮书", "供应商关系")).toThrow();
    kb.writePage("graphs/采购白皮书--供应商关系.md", { type: "graph" }, "没有数据块");
    expect(() => extractor.view("采购白皮书", "供应商关系")).toThrow(/缺少 json 数据块/);
  });
});

describe("prompt/parse helpers", () => {
  test("buildExtractPrompt falls back to placeholders for empty fields", () => {
    const prompt = buildExtractPrompt({ name: "t", entityTypes: [], relationTypes: [] }, "md");
    expect(prompt).toContain("描述：（无）");
    expect(prompt).toContain("实体类型：（不限）");
    expect(prompt).toContain("关系类型：（不限）");
    expect(prompt).toContain("补充说明：（无）");
  });

  test("extractJson parses bare objects, arrays and fenced blocks", () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
    expect(extractJson("前缀 [1, 2] 后缀")).toEqual([1, 2]);
    expect(extractJson('```\n{"a": 2}\n```')).toEqual({ a: 2 });
    expect(() => extractJson("没有任何 JSON")).toThrow(/无法从 LLM 输出解析 JSON/);
  });

  test("validateExtraction rejects non-objects and match=false", () => {
    expect(validateExtraction(null)).toBeNull();
    expect(validateExtraction([1, 2])).toBeNull();
    expect(validateExtraction({ match: false, nodes: [{}], edges: [{}] })).toBeNull();
  });

  test("renderGraphPage renders empty descriptions as empty cells", () => {
    const { meta, body } = renderGraphPage({ name: "t", entityTypes: [], relationTypes: [] }, "d.md", {
      nodes: [{ name: "A", type: "x" }],
      edges: [{ source: "A", target: "A", relation: "r" }],
    });
    expect(meta.type).toBe("graph");
    expect(body).toContain("| A | x |  |");
    expect(body).toContain("| A | r | A |  |");
  });
});
