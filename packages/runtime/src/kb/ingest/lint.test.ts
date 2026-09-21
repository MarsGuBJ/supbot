import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { KbStore, removeWikilink } from "../kbStore";
import { ReviewQueue } from "../review";
import { lintWiki } from "./lint";

const tempDirs: string[] = [];

function createEnv(): { root: string; store: KbStore; reviewQueue: ReviewQueue } {
  const root = mkdtempSync(join(tmpdir(), "supbot-kblint-test-"));
  tempDirs.push(root);
  return { root, store: new KbStore(root), reviewQueue: new ReviewQueue(root) };
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("lintWiki", () => {
  test("死链 / 孤儿页 / index 漂移分别写 Review 条目", () => {
    const { store, reviewQueue } = createEnv();
    // 甲：type=source（孤儿豁免），正文含一条死链
    store.writePage("sources/甲.md", { type: "source", title: "甲" }, "参见 [[乙]] 与 [[不存在的页]]。");
    // 乙：有来自甲的入链 → 非孤儿
    store.writePage("concepts/乙.md", { type: "concept", title: "乙" }, "概念乙。");
    // 丙：无任何入链且 type=concept → 孤儿
    store.writePage("concepts/丙.md", { type: "concept", title: "丙" }, "概念丙。");
    // index：漏收丙、多收幽灵页
    writeFileSync(join(store.wikiDir, "index.md"), "# Wiki Index\n\n- [[甲]]\n- [[乙]]\n- [[幽灵]]\n", "utf8");

    const report = lintWiki(store, reviewQueue);

    expect(report.dead_links).toEqual([{ page: "sources/甲.md", target: "不存在的页" }]);
    expect(report.orphan_pages).toEqual(["concepts/丙.md"]);
    expect(report.index_drift).toEqual({ missing_in_index: ["丙"], stale_in_index: ["幽灵"] });

    const items = reviewQueue.list();
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.reason.split(" ")[0])).toEqual([
      "lint:dead_link",
      "lint:orphan",
      "lint:index_drift",
    ]);
    expect(items[0]!.sourceFile).toBe("wiki/sources/甲.md");
    expect(items[2]!.sourceFile).toBe("wiki/index.md");
  });

  test("rebuildIndex 后的健康 wiki 无任何 lint 问题", () => {
    const { store, reviewQueue } = createEnv();
    store.writePage("concepts/甲.md", { type: "concept", title: "甲" }, "参见 [[乙]]。");
    store.writePage("concepts/乙.md", { type: "concept", title: "乙" }, "参见 [[甲]]。");
    store.writePage("sources/文档.md", { type: "source", title: "文档" }, "源摘要（孤儿豁免）。");
    store.rebuildIndex();

    const report = lintWiki(store, reviewQueue);
    expect(report.dead_links).toEqual([]);
    expect(report.orphan_pages).toEqual([]);
    expect(report.index_drift).toEqual({ missing_in_index: [], stale_in_index: [] });
    expect(reviewQueue.list()).toEqual([]);
  });

  test("index 目录链接不计入入链：仅被 index 收录的页仍是孤儿", () => {
    const { store, reviewQueue } = createEnv();
    store.writePage("concepts/孤岛.md", { type: "concept", title: "孤岛" }, "没有入链。");
    store.rebuildIndex(); // index 收录 [[孤岛]]，但这不算入链

    const report = lintWiki(store, reviewQueue);
    expect(report.orphan_pages).toEqual(["concepts/孤岛.md"]);
    expect(report.index_drift).toEqual({ missing_in_index: [], stale_in_index: [] });
  });
});

describe("removeWikilink", () => {
  test("删除目标链接并保留显示文本", () => {
    const body = "参见 [[乙]] 与 [[不存在的页]]，以及 [[不存在的页|别名]]。";
    const { body: next, removed } = removeWikilink(body, "不存在的页");
    expect(removed).toBe(true);
    expect(next).toBe("参见 [[乙]] 与 不存在的页，以及 别名。");
  });

  test("目标不存在时不改动正文", () => {
    const body = "参见 [[乙]]。";
    const { body: next, removed } = removeWikilink(body, "丙");
    expect(removed).toBe(false);
    expect(next).toBe(body);
  });
});
