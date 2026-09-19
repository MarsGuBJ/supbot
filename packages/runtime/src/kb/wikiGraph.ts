/**
 * 整库 Wiki 链接图谱（logseq 风格全局图谱的数据层）。
 *
 * buildWikiGraph(store) 把一个 kb_root 的全部 wiki 页（KbStore.listPages，
 * 不含 index/log/overview）转成力导向图所需的 nodes/links：
 * - 节点 = 页，id 为 wiki 相对路径；
 * - 边 = 页间 [[wikilink]]（正文 extractWikilinks + frontmatter links[] 合并），
 *   目标按 lint 同款规则（文件 stem 或 frontmatter title）解析为页路径；
 * - 死链跳过、去重、去自环；degree = 入链 + 出链总数，驱动节点大小。
 */

import type { KbWikiGraph, KbWikiGraphLink, KbWikiGraphNode } from "@supbot/shared";
import type { KbStore } from "./kbStore";
import { extractWikilinks } from "./kbStore";
import { buildNameToRel, stemOf } from "./ingest/lint";

/** Outgoing link targets of a page: body [[wikilinks]] merged with frontmatter links[]. */
function pageLinkTargets(rel: string, body: string, metaLinks: unknown): string[] {
  const seen = new Set<string>();
  for (const target of extractWikilinks(body)) {
    seen.add(target);
  }
  if (Array.isArray(metaLinks)) {
    for (const item of metaLinks) {
      const target = typeof item === "string" ? item.trim() : "";
      if (target) {
        seen.add(target);
      }
    }
  }
  seen.delete(rel);
  return [...seen];
}

/** Build the whole-wiki link graph for a kb_root store. */
export function buildWikiGraph(store: KbStore): KbWikiGraph {
  const pages = new Map(store.listPages().map((rel) => [rel, store.readPage(rel)] as const));
  const nameToRel = buildNameToRel(pages);

  const links: KbWikiGraphLink[] = [];
  const degree = new Map([...pages.keys()].map((rel) => [rel, 0]));
  for (const [rel, page] of pages) {
    for (const target of pageLinkTargets(rel, page.body, page.meta.links)) {
      const resolved = nameToRel.get(target);
      if (resolved === undefined || resolved === rel) {
        continue;
      }
      links.push({ source: rel, target: resolved });
      degree.set(rel, (degree.get(rel) ?? 0) + 1);
      degree.set(resolved, (degree.get(resolved) ?? 0) + 1);
    }
  }

  const nodes: KbWikiGraphNode[] = [...pages.entries()].map(([rel, page]) => {
    const meta = page.meta;
    const title = typeof meta.title === "string" && meta.title ? meta.title : stemOf(rel);
    const type = typeof meta.type === "string" ? meta.type : "";
    const tags = Array.isArray(meta.tags) ? meta.tags.filter((tag): tag is string => typeof tag === "string") : [];
    return { id: rel, title, type, tags, degree: degree.get(rel) ?? 0 };
  });

  return { nodes, links };
}
