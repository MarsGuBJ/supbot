/**
 * Wiki Lint 巡检（防 LLM 幻觉污染 wiki）。
 * 端口自 k-pipeline app/ingest/lint.py。
 *
 * lintWiki(store, reviewQueue) 执行三类检查：
 * 1. 死链（dead_link）：正文 [[wikilink]] 指向不存在的页（按 stem/title 解析）；
 * 2. 孤儿页（orphan）：无任何其它知识页入链，且 type 非 source/overview
 *    （source 页由文档保底产生、不参与互链，overview 是根级文件）；
 * 3. index 漂移（index_drift）：wiki/index.md 的 [[...]] 目录与实际页集合不一致。
 *
 * 发现的问题逐条写入 ReviewQueue（reason 带 lint 类型前缀），并返回 LintReport。
 * 注意：index.md 自身的目录链接不计入"入链"（KbStore.listPages 不含 index），
 * 否则 rebuildIndex 全量收录后无孤儿可言。
 */

import type { KbStore } from "../kbStore";
import { extractWikilinks } from "../kbStore";
import type { ReviewQueue } from "../review";

/** 孤儿页豁免的 type（source 页保底产生、overview 为根级文件）。 */
export const ORPHAN_EXEMPT_TYPES: ReadonlySet<string> = new Set(["source", "overview"]);

export interface DeadLink {
  page: string;
  target: string;
}

export interface IndexDrift {
  /** 有页未收录进 index。 */
  missing_in_index: string[];
  /** index 收录了不存在的页。 */
  stale_in_index: string[];
}

export interface LintReport {
  dead_links: DeadLink[];
  orphan_pages: string[];
  index_drift: IndexDrift;
}

const INDEX_LINK_RE = /\[\[([^[\]|]+)\]\]/g;

/** 执行巡检，问题写入 ReviewQueue，返回 LintReport。 */
export function lintWiki(store: KbStore, reviewQueue: ReviewQueue): LintReport {
  const pages = new Map(store.listPages().map((rel) => [rel, store.readPage(rel)] as const));
  const nameToRel = buildNameToRel(pages);
  const report: LintReport = {
    dead_links: [],
    orphan_pages: [],
    index_drift: { missing_in_index: [], stale_in_index: [] },
  };

  const inbound = new Map([...pages.keys()].map((rel) => [rel, 0]));
  for (const [rel, page] of pages) {
    for (const target of extractWikilinks(page.body)) {
      const tgt = nameToRel.get(target);
      if (tgt === undefined) {
        report.dead_links.push({ page: rel, target });
        reviewQueue.add(`wiki/${rel}`, "wiki", `lint:dead_link 指向不存在的页 [[${target}]]`, 1.0);
      } else if (tgt !== rel) {
        inbound.set(tgt, (inbound.get(tgt) ?? 0) + 1);
      }
    }
  }

  for (const [rel, page] of pages) {
    const ptype = typeof page.meta.type === "string" ? page.meta.type : "";
    if ((inbound.get(rel) ?? 0) === 0 && !ORPHAN_EXEMPT_TYPES.has(ptype)) {
      report.orphan_pages.push(rel);
      reviewQueue.add(`wiki/${rel}`, "wiki", `lint:orphan 页无任何入链（type=${ptype || "未标注"}）`, 1.0);
    }
  }

  const indexTargets = new Set([...store.readIndex().matchAll(INDEX_LINK_RE)].map((match) => match[1]!));
  const stems = new Set([...pages.keys()].map(stemOf));
  const titles = new Set(
    [...pages.values()]
      .map((page) => (typeof page.meta.title === "string" ? page.meta.title : ""))
      .filter((title) => title.length > 0),
  );
  const known = new Set([...stems, ...titles]);
  const missing = [...stems].filter((stem) => !indexTargets.has(stem)).sort();
  const stale = [...indexTargets].filter((target) => !known.has(target)).sort();
  if (missing.length || stale.length) {
    report.index_drift = { missing_in_index: missing, stale_in_index: stale };
    reviewQueue.add(
      "wiki/index.md",
      "wiki",
      `lint:index_drift 未收录 ${missing.length} 页、失效 ${stale.length} 条` +
        `（missing=${JSON.stringify(missing)} stale=${JSON.stringify(stale)}）`,
      1.0,
    );
  }
  return report;
}

/** 链接目标 → rel 路径：页 stem 与 frontmatter title 都可被 [[...]] 引用。 */
export function buildNameToRel(pages: ReadonlyMap<string, { meta: Record<string, unknown> }>): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const [rel, page] of pages) {
    if (!mapping.has(stemOf(rel))) {
      mapping.set(stemOf(rel), rel);
    }
    const title = typeof page.meta.title === "string" ? page.meta.title : "";
    if (title && !mapping.has(title)) {
      mapping.set(title, rel);
    }
  }
  return mapping;
}

export function stemOf(rel: string): string {
  const name = rel.split("/").pop() ?? rel;
  return name.replace(/\.[^.]*$/, "");
}
