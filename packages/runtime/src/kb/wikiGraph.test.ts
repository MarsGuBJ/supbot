import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { KbStore } from "./kbStore";
import { buildWikiGraph } from "./wikiGraph";

const tempDirs: string[] = [];

function createStore(): KbStore {
  const dir = mkdtempSync(join(tmpdir(), "supbot-wikigraph-test-"));
  tempDirs.push(dir);
  return new KbStore(dir);
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("buildWikiGraph", () => {
  test("正文 [[wikilink]] 互链成边并统计 degree", () => {
    const store = createStore();
    store.writePage("entities/甲.md", { type: "entity", title: "甲公司" }, "与 [[乙]] 合作。");
    store.writePage("entities/乙.md", { type: "entity", title: "乙" }, "参见 [[甲公司]]。");

    const graph = buildWikiGraph(store);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(["entities/乙.md", "entities/甲.md"].sort());
    expect(graph.links).toHaveLength(2);
    expect(graph.links).toEqual(
      expect.arrayContaining([
        { source: "entities/甲.md", target: "entities/乙.md" },
        { source: "entities/乙.md", target: "entities/甲.md" },
      ]),
    );
    expect(graph.nodes.find((node) => node.id === "entities/甲.md")?.degree).toBe(2);
    expect(graph.nodes.find((node) => node.id === "entities/乙.md")?.degree).toBe(2);
  });

  test("[[target|alias]] 解析、frontmatter links[] 合并、死链与自环跳过", () => {
    const store = createStore();
    store.writePage(
      "concepts/采购.md",
      { type: "concept", title: "采购", links: ["供应商"] },
      "由 [[供应商|vendor]] 执行，引用 [[不存在的页]] 与 [[采购]] 自身。",
    );
    store.writePage("entities/供应商.md", { type: "entity", title: "供应商" }, "无出链。");

    const graph = buildWikiGraph(store);
    // wikilink 与 frontmatter links[] 指向同一页，去重后仅一条边；死链/自环跳过。
    expect(graph.links).toEqual([{ source: "concepts/采购.md", target: "entities/供应商.md" }]);
    expect(graph.nodes.find((node) => node.id === "entities/供应商.md")?.degree).toBe(1);
  });

  test("孤儿页以 0 度节点保留；无 title 时回退文件 stem", () => {
    const store = createStore();
    store.writePage("sources/白皮书.md", { type: "source" }, "孤立源页。");

    const graph = buildWikiGraph(store);
    expect(graph.links).toEqual([]);
    expect(graph.nodes).toEqual([{ id: "sources/白皮书.md", title: "白皮书", type: "source", tags: [], degree: 0 }]);
  });
});
