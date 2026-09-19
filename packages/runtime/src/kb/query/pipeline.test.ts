import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelConfig } from "@supbot/shared";
import { afterEach, describe, expect, test } from "vitest";
import type {
  AdapterMessage,
  ModelAdapter,
  ModelStreamEvent,
  ModelTurnRequest,
  ModelTurnResult,
} from "../../modelAdapter";
import { KbStore } from "../kbStore";
import { estimateTokens, HOP2_DECAY, KbQueryPipeline, QUOTA_HISTORY, QUOTA_WIKI, tokenize } from "./pipeline";

const tempDirs: string[] = [];

function createStore(): { root: string; store: KbStore } {
  const root = mkdtempSync(join(tmpdir(), "supbot-kbquery-test-"));
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
  maxTokens: 1024,
  apiKeySaved: false,
};

class FakeAdapter implements ModelAdapter {
  lastRequest?: ModelTurnRequest;

  constructor(private readonly reply: string) {}

  async complete(input: ModelTurnRequest): Promise<ModelTurnResult> {
    this.lastRequest = input;
    return { text: this.reply, toolCalls: [] };
  }

  async *stream(): AsyncGenerator<ModelStreamEvent, ModelTurnResult, unknown> {
    const result: ModelTurnResult = { text: this.reply, toolCalls: [] };
    yield { type: "done", result };
    return result;
  }
}

/** Graph: 管理系统 ↔ 评估模型 ↔ 风险管理（链式），管理系统与评估模型 sources 重叠。 */
function buildLinkedStore(): KbStore {
  const { store } = createStore();
  store.writePage(
    "concepts/供应商评估模型.md",
    { type: "concept", title: "供应商评估模型", sources: ["raw/sources/采购白皮书.pdf"] },
    "供应商评估模型用于评估供应商与风险管理。参见 [[供应商管理系统]] 与 [[风险管理]]。",
  );
  store.writePage(
    "entities/供应商管理系统.md",
    { type: "entity", title: "供应商管理系统", sources: ["raw/sources/采购白皮书.pdf"] },
    "供应商管理系统管理供应商档案。基于 [[供应商评估模型]] 评估供应商。",
  );
  store.writePage(
    "concepts/风险管理.md",
    { type: "concept", title: "风险管理", sources: ["raw/sources/风控报告.pdf"] },
    "风险管理识别供应商风险。",
  );
  store.writePage(
    "entities/员工通讯录.md",
    { type: "entity", title: "员工通讯录", sources: ["raw/sources/通讯录.csv"] },
    "员工联系方式汇总。",
  );
  return store;
}

/**
 * 权重测试图：种子页链接 阿尔法（仅 wikilink）与 贝塔（wikilink + sources 重叠 +
 * 同 type），贝塔再链接 伽马（第 2 跳）。
 */
function buildWeightStore(): KbStore {
  const { store } = createStore();
  store.writePage(
    "concepts/种子页.md",
    { type: "concept", title: "种子页", sources: ["raw/sources/s.txt"] },
    "独特词语组合 [[阿尔法]] [[贝塔]]。",
  );
  store.writePage(
    "entities/阿尔法.md",
    { type: "entity", title: "阿尔法", sources: ["raw/sources/a.txt"] },
    "阿尔法页面正文。",
  );
  store.writePage(
    "concepts/贝塔.md",
    { type: "concept", title: "贝塔", sources: ["raw/sources/s.txt"] },
    "贝塔页面正文，参见 [[伽马]]。",
  );
  store.writePage(
    "concepts/伽马.md",
    { type: "concept", title: "伽马", sources: ["raw/sources/g.txt"] },
    "伽马页面正文。",
  );
  return store;
}

describe("tokenize / estimateTokens", () => {
  test("splits CJK bigrams and filters English stopwords", () => {
    expect(tokenize("the 供应商管理系统 and AI")).toEqual(["供应", "应商", "商管", "管理", "理系", "系统", "ai"]);
  });

  test("keeps a lone CJK char as unigram", () => {
    expect(tokenize("好")).toEqual(["好"]);
  });

  test("estimates CJK per char and the rest per 4 chars", () => {
    expect(estimateTokens("abcd一")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("KbQueryPipeline.search", () => {
  test("P1 ranks the title-matching page first", () => {
    const pipeline = new KbQueryPipeline(buildLinkedStore());
    const results = pipeline.search("供应商评估模型");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.page).toBe("wiki/concepts/供应商评估模型.md");
    expect(results[0]!.title).toBe("供应商评估模型");
    expect(results[0]!.sources).toEqual(["raw/sources/采购白皮书.pdf"]);
    expect(results[0]!.snippet).toBeTruthy();
  });

  test("P2 expansion pulls 2-hop related pages into results", () => {
    const pipeline = new KbQueryPipeline(buildLinkedStore());
    const results = pipeline.search("供应商评估模型");
    const pages = results.map((result) => result.page);
    // 风险管理 is a hop-1 neighbor of 评估模型 and hop-2 from 管理系统.
    expect(pages).toContain("wiki/concepts/风险管理.md");
    // The unlinked, non-matching page never shows up.
    expect(pages).not.toContain("wiki/entities/员工通讯录.md");
  });

  test("4-signal weights rank wikilink+sources-overlap above plain wikilink", () => {
    const pipeline = new KbQueryPipeline(buildWeightStore());
    const results = pipeline.search("独特词语");
    const byPage = new Map(results.map((result) => [result.page, result]));
    const beta = byPage.get("wiki/concepts/贝塔.md");
    const alpha = byPage.get("wiki/entities/阿尔法.md");
    // 贝塔: link 3 + sources 4 + same type 1 = 8；阿尔法: link 3。
    expect(beta?.score).toBe(8);
    expect(alpha?.score).toBe(3);
    expect(results.findIndex((result) => result.page === beta!.page)).toBeLessThan(
      results.findIndex((result) => result.page === alpha!.page),
    );
  });

  test("hop-2 scores are multiplied by HOP2_DECAY", () => {
    const pipeline = new KbQueryPipeline(buildWeightStore());
    const results = pipeline.search("独特词语");
    const gamma = results.find((result) => result.page === "wiki/concepts/伽马.md");
    // signals(贝塔, 伽马) = link 3 + same type 1 = 4；第 2 跳衰减后 4 × HOP2_DECAY。
    expect(gamma?.score).toBe(4 * HOP2_DECAY);
  });

  test("returns [] when the query tokenizes to nothing", () => {
    const pipeline = new KbQueryPipeline(buildLinkedStore());
    expect(pipeline.search("the and or")).toEqual([]);
  });
});

describe("KbQueryPipeline.assemble", () => {
  test("truncates oversized pages to the wiki token budget", () => {
    const { root, store } = createStore();
    const body = "预算测试填充内容".repeat(30); // ~240 estimated tokens per page
    for (let i = 1; i <= 6; i += 1) {
      store.writePage(`concepts/页${i}.md`, { type: "concept", sources: [] }, body);
    }
    writeFileSync(join(root, "wiki", "index.md"), "目录填充内容".repeat(20), "utf8");

    const pipeline = new KbQueryPipeline(store);
    const budget = 300;
    const assembled = pipeline.assemble("预算测试", budget);
    const wikiBudget = Math.floor(budget * (QUOTA_WIKI + QUOTA_HISTORY));
    // Only the first page fits (truncated); the rest are dropped by the budget.
    expect(assembled.pages.length).toBe(1);
    expect(assembled.tokensUsed).toBeLessThanOrEqual(wikiBudget + 2);
    expect(assembled.context).toContain("…");
    expect(assembled.pages[0]!.ref).toBe(1);
    // index.md is truncated to its own 5% quota.
    const indexBudget = Math.floor(budget * 0.05);
    expect(estimateTokens(assembled.index)).toBeLessThanOrEqual(indexBudget + 2);
  });
});

describe("KbQueryPipeline.chat", () => {
  test("maps [n] references back to pages with title/anchor/sources", async () => {
    const adapter = new FakeAdapter("依据[1]与[2]作答，另有[9]与重复[1]。");
    const pipeline = new KbQueryPipeline(buildLinkedStore(), {
      adapter,
      resolveModel: () => ({ modelConfig: FAKE_MODEL_CONFIG, apiKey: "sk-test" }),
    });
    const response = await pipeline.chat("供应商评估模型", [
      { role: "user", content: "之前的问题" },
      { role: "assistant", content: "之前的回答" },
    ]);
    expect(response.answer).toContain("[1]");
    expect(response.citations.map((citation) => citation.ref)).toEqual([1, 2]);
    expect(response.citations[0]).toEqual({
      ref: 1,
      page: "wiki/concepts/供应商评估模型.md",
      title: "供应商评估模型",
      anchor: "供应商评估模型",
      sources: ["raw/sources/采购白皮书.pdf"],
    });
    expect(response.citations[1]!.page).toBe("wiki/entities/供应商管理系统.md");
    // [9] has no matching page and is dropped.

    const messages = adapter.lastRequest!.messages;
    expect(messages[0]!.role).toBe("system");
    const system = (messages[0] as AdapterMessage & { role: "system" }).content;
    expect(system).toContain("知识库目标");
    expect(system).toContain("[1] wiki/concepts/供应商评估模型.md");
    expect(messages[1]).toEqual({ role: "user", content: "之前的问题" });
    expect(messages[messages.length - 1]).toEqual({ role: "user", content: "供应商评估模型" });
  });

  test("throws when no LLM is configured", async () => {
    const pipeline = new KbQueryPipeline(buildLinkedStore());
    await expect(pipeline.chat("供应商")).rejects.toThrow("未配置 LLM");
  });
});
