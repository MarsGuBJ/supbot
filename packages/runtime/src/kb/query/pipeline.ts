/**
 * Query pipeline (tech design 6.1), ported from k-pipeline's
 * app/query/pipeline.py: P1 keyword search → P2 graph expansion →
 * P3 token-budget assembly → P4 answer with [n] citations.
 *
 * - P1 search: English word segmentation with stopword filtering, CJK bigram
 *   splitting; scores all wiki/ pages and raw/markdown/ files (body hit count
 *   weighted + title hit +10);
 * - P2 expand: undirected graph from wiki page [[wikilink]]s, 4-signal
 *   relevance model (direct link ×3.0 / frontmatter sources overlap ×4.0 /
 *   Adamic-Adar common neighbors ×1.5 / same type ×1.0), 2-hop expansion from
 *   seed pages, hop-2 scores multiplied by a decay factor;
 * - P3 assemble: coarse token estimate (1 token per CJK char, ~4 chars per
 *   token otherwise — same heuristic as the Python version, no tiktoken),
 *   quotas wiki 60% / history 20% (ceded to wiki when there is no session
 *   history) / index 5% / system 15%, numbered context assembly;
 * - P4 chat: system prompt carries purpose.md and the numbered-citation
 *   requirement; [n] references in the answer are mapped back to page paths
 *   and frontmatter sources.
 *
 * All LLM calls go through the injected ModelAdapter; the pipeline never
 * touches runtime state (assembly happens in stage 6). Vector retrieval
 * (P1.5) is intentionally not ported — it is disabled by default upstream.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { KbChatCitation, KbChatResponse, KbSearchResult, ModelConfig, WikiPage } from "@supbot/shared";
import type { AdapterMessage, ModelAdapter } from "../../modelAdapter";
import { extractWikilinks, type KbStore } from "../kbStore";

// ---- 4-signal weights (tech design 6.1 Phase 2) ----
export const W_LINK = 3.0; // direct wikilink
export const W_SOURCES = 4.0; // frontmatter sources overlap
export const W_ADAMIC_ADAR = 1.5; // Adamic-Adar common neighbors
export const W_SAME_TYPE = 1.0; // same type
export const HOP2_DECAY = 0.5; // hop-2 decay factor

// ---- Context quotas (tech design 6.1 Phase 3) ----
export const QUOTA_WIKI = 0.6;
export const QUOTA_HISTORY = 0.2;
export const QUOTA_INDEX = 0.05;
export const QUOTA_SYSTEM = 0.15;

/** Default context budget in estimated tokens (k-pipeline settings.context_budget). */
export const DEFAULT_CONTEXT_BUDGET = 32000;

// Built-in English stopwords (good enough, not aiming for completeness).
export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "a an the and or but if then else when of in on at for with without to from by " +
    "is are was were be been being it its this that these those as not no do does did " +
    "done have has had having will would shall should can could may might must i you " +
    "he she we they me him her us them my your his their our what which who whom how " +
    "why where there here than too very just about into over under again further once"
  ).split(" "),
);

// CJK unified ideographs + Japanese kana.
const CJK_RANGE = "぀-ヿ㐀-䶿一-鿿豈-﫿";
const CJK_CHAR_RE = new RegExp(`[${CJK_RANGE}]`);
const SEGMENT_RE = new RegExp(`[${CJK_RANGE}]+|[A-Za-z0-9]+`, "g");
const REF_RE = /\[(\d+)\]/g;

function isCjk(ch: string): boolean {
  return CJK_CHAR_RE.test(ch);
}

/**
 * Tokenize: English splits on words with stopword filtering; CJK runs are cut
 * into bigrams (a lone char stays a unigram).
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(SEGMENT_RE)) {
    const seg = match[0];
    if (isCjk(seg[0]!)) {
      if (seg.length === 1) {
        tokens.push(seg);
      } else {
        for (let i = 0; i < seg.length - 1; i += 1) {
          tokens.push(seg.slice(i, i + 2));
        }
      }
    } else {
      const word = seg.toLowerCase();
      if (!STOPWORDS.has(word)) {
        tokens.push(word);
      }
    }
  }
  return tokens;
}

/** Coarse token estimate: CJK chars count 1 token each, others ~4 chars per token. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    if (isCjk(ch)) {
      cjk += 1;
    }
  }
  return cjk + Math.ceil((text.length - cjk) / 4);
}

/** Truncate by token weight (CJK=1, others=0.25), appending an ellipsis. */
function truncateToTokens(text: string, tokenBudget: number): string {
  let weight = 0;
  let cut = text.length;
  let i = 0;
  for (const ch of text) {
    weight += isCjk(ch) ? 1.0 : 0.25;
    if (weight > tokenBudget) {
      cut = i;
      break;
    }
    i += ch.length;
  }
  return text.slice(0, cut).trimEnd() + "…";
}

/** Snippet around the first token hit. */
function snippet(body: string, tokens: string[], width = 80): string {
  const lowered = body.toLowerCase();
  let pos = -1;
  for (const tok of tokens) {
    pos = lowered.indexOf(tok);
    if (pos >= 0) {
      break;
    }
  }
  if (pos < 0) {
    return "";
  }
  const start = Math.max(0, pos - Math.floor(width / 2));
  const fragment = body.slice(start, pos + Math.floor(width / 2) + tokens[0]!.length);
  return fragment.replace(/\s+/g, " ").trim();
}

/** Count non-overlapping literal occurrences (Python str.count equivalent). */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  return haystack.split(needle).length - 1;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function stemOf(rel: string): string {
  return basename(rel, ".md");
}

function pageSources(page: WikiPage): string[] {
  const sources = page.meta.sources;
  return Array.isArray(sources) ? sources.map(String) : [];
}

/** Undirected wiki page graph: adjacency sets + page metadata. */
interface WikiGraph {
  pages: Map<string, WikiPage>;
  links: Map<string, Set<string>>;
}

export interface SignalBreakdown {
  link: number;
  sources: number;
  adamicAdar: number;
  sameType: number;
  weight: number;
}

/** 4-signal components and total weight for the page pair (a, b). */
function graphSignals(graph: WikiGraph, a: string, b: string): SignalBreakdown {
  const fa = graph.pages.get(a)!.meta;
  const fb = graph.pages.get(b)!.meta;
  const link = graph.links.get(a)!.has(b) ? 1.0 : 0.0;
  const sourcesA = new Set(pageSources(graph.pages.get(a)!));
  const sourcesB = new Set(pageSources(graph.pages.get(b)!));
  const sources = [...sourcesA].some((s) => sourcesB.has(s)) ? 1.0 : 0.0;
  // Adamic-Adar: common neighbor z contributes 1/log(deg(z)); neighbors with
  // degree <= 1 carry no discriminating power and are skipped.
  let aa = 0;
  for (const z of graph.links.get(a)!) {
    if (!graph.links.get(b)!.has(z)) {
      continue;
    }
    const degree = graph.links.get(z)!.size;
    if (degree > 1) {
      aa += 1.0 / Math.log(degree);
    }
  }
  const sameType = fa.type === fb.type ? 1.0 : 0.0;
  const weight = W_LINK * link + W_SOURCES * sources + W_ADAMIC_ADAR * aa + W_SAME_TYPE * sameType;
  return { link, sources, adamicAdar: round6(aa), sameType, weight: round6(weight) };
}

interface RawHit {
  path: string;
  score: number;
  snippet: string;
}

export interface AssembledPage {
  ref: number;
  path: string;
  score: number;
}

export interface AssembledContext {
  context: string;
  pages: AssembledPage[];
  index: string;
  tokensUsed: number;
  budget: number;
}

export interface KbQueryDeps {
  /** LLM adapter; chat throws when omitted (search/expand/assemble still work). */
  adapter?: ModelAdapter;
  /** Resolves the current model config + API key at chat time. */
  resolveModel?: () => { modelConfig: ModelConfig; apiKey?: string };
  /** Context budget in estimated tokens (defaults to DEFAULT_CONTEXT_BUDGET). */
  contextBudget?: number;
}

export interface KbSearchOptions {
  limit?: number;
}

export interface KbChatOptions {
  contextBudget?: number;
}

export type KbChatHistoryMessage = { role: "user" | "assistant"; content: string };

export class KbQueryPipeline {
  private readonly store: KbStore;
  private readonly adapter?: ModelAdapter;
  private readonly resolveModel?: () => { modelConfig: ModelConfig; apiKey?: string };
  private readonly contextBudget: number;

  constructor(store: KbStore, deps: KbQueryDeps = {}) {
    this.store = store;
    this.adapter = deps.adapter;
    this.resolveModel = deps.resolveModel;
    this.contextBudget = deps.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
  }

  // ---- P1 keyword search ----

  /** P1 only: score wiki/ pages and raw/markdown/ files, sorted by score. */
  private tokenSearch(query: string, limit = 10): RawHit[] {
    const tokens = tokenize(query);
    if (!tokens.length) {
      return [];
    }
    const hits: RawHit[] = [];
    for (const rel of this.store.listPages()) {
      const page = this.store.readPage(rel);
      const title = typeof page.meta.title === "string" && page.meta.title ? page.meta.title : stemOf(rel);
      const score = scoreTokens(tokens, page.body, title);
      if (score > 0) {
        hits.push({ path: `wiki/${rel}`, score, snippet: snippet(page.body, tokens) });
      }
    }
    const mdDir = join(this.store.kbRoot, "raw", "markdown");
    const mdNames = existsSync(mdDir)
      ? readdirSync(mdDir)
          .filter((name) => name.endsWith(".md"))
          .sort()
      : [];
    for (const name of mdNames) {
      const body = readFileSync(join(mdDir, name), "utf8");
      const score = scoreTokens(tokens, body, basename(name, ".md"));
      if (score > 0) {
        hits.push({ path: `raw/markdown/${name}`, score, snippet: snippet(body, tokens) });
      }
    }
    hits.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return hits.slice(0, limit);
  }

  /**
   * P1 + P2 combined retrieval (no LLM): keyword hits merged with 2-hop graph
   * expansion scores, sorted by combined score.
   */
  search(query: string, opts: KbSearchOptions = {}): KbSearchResult[] {
    const limit = opts.limit ?? 10;
    const hits = this.tokenSearch(query, limit);
    if (!hits.length) {
      return [];
    }
    const combined = new Map<string, { score: number; snippet: string }>();
    for (const hit of hits) {
      const entry = combined.get(hit.path) || { score: 0, snippet: "" };
      entry.score += hit.score;
      entry.snippet = entry.snippet || hit.snippet;
      combined.set(hit.path, entry);
    }
    const seeds = hits.filter((hit) => hit.path.startsWith("wiki/")).map((hit) => hit.path);
    for (const ext of this.expand(seeds)) {
      const entry = combined.get(ext.path) || { score: 0, snippet: "" };
      entry.score += ext.score;
      combined.set(ext.path, entry);
    }
    const ranked = [...combined.entries()].sort(
      (a, b) => b[1].score - a[1].score || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    const tokens = tokenize(query);
    return ranked
      .slice(0, limit)
      .map(([path, entry]) => this.toSearchResult(path, round6(entry.score), entry.snippet, tokens));
  }

  // ---- P2 graph expansion ----

  /** Build the undirected graph from wiki pages and [[wikilink]]s (targets resolved by stem/title). */
  private buildGraph(): WikiGraph {
    const pages = new Map<string, WikiPage>();
    for (const rel of this.store.listPages()) {
      pages.set(rel, this.store.readPage(rel));
    }
    const nameToRel = new Map<string, string>();
    for (const [rel, page] of pages) {
      if (!nameToRel.has(stemOf(rel))) {
        nameToRel.set(stemOf(rel), rel);
      }
      const title = page.meta.title;
      if (typeof title === "string" && title && !nameToRel.has(title)) {
        nameToRel.set(title, rel);
      }
    }
    const links = new Map<string, Set<string>>();
    for (const rel of pages.keys()) {
      links.set(rel, new Set());
    }
    for (const [rel, page] of pages) {
      for (const target of extractWikilinks(page.body)) {
        const tgt = nameToRel.get(target);
        if (tgt && tgt !== rel) {
          links.get(rel)!.add(tgt);
          links.get(tgt)!.add(rel);
        }
      }
    }
    return { pages, links };
  }

  /**
   * 2-hop expansion from seed pages, relevance-sorted (seeds excluded).
   * Hop-1 score = pair weight; hop-2 score = pair weight × HOP2_DECAY;
   * scores of multiple paths to the same page accumulate.
   */
  private expand(seedPaths: string[], limit = 20): Array<{ path: string; score: number }> {
    const graph = this.buildGraph();
    const seeds = seedPaths.map((p) => toRel(p)).filter((rel) => graph.pages.has(rel));
    const scores = new Map<string, number>();
    for (const seed of seeds) {
      for (const hop1 of graph.links.get(seed)!) {
        scores.set(hop1, (scores.get(hop1) || 0) + graphSignals(graph, seed, hop1).weight);
        for (const hop2 of graph.links.get(hop1)!) {
          if (hop2 === seed) {
            continue;
          }
          scores.set(hop2, (scores.get(hop2) || 0) + graphSignals(graph, hop1, hop2).weight * HOP2_DECAY);
        }
      }
    }
    for (const seed of seeds) {
      scores.delete(seed);
    }
    const out = [...scores.entries()].map(([rel, score]) => ({ path: `wiki/${rel}`, score: round6(score) }));
    out.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out.slice(0, limit);
  }

  // ---- P3 budget control + assembly ----

  /**
   * Merge P1 hits and P2 expansion (deduped, sorted by combined score) and
   * assemble the numbered context within the budget. Without session history
   * the history quota (20%) is ceded to wiki pages (80% total).
   */
  assemble(query: string, contextBudget?: number): AssembledContext {
    const budget = contextBudget ?? this.contextBudget;
    const wikiBudget = Math.floor(budget * (QUOTA_WIKI + QUOTA_HISTORY));
    const indexBudget = Math.floor(budget * QUOTA_INDEX);

    const combined = new Map<string, number>();
    const hits = this.tokenSearch(query, 10);
    for (const hit of hits) {
      combined.set(hit.path, (combined.get(hit.path) || 0) + hit.score);
    }
    const seeds = hits.filter((hit) => hit.path.startsWith("wiki/")).map((hit) => hit.path);
    for (const ext of this.expand(seeds)) {
      combined.set(ext.path, (combined.get(ext.path) || 0) + ext.score);
    }
    const ranked = [...combined.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    const pages: AssembledPage[] = [];
    const chunks: string[] = [];
    let used = 0;
    for (const [path, score] of ranked) {
      let content = this.readContent(path);
      if (content === null) {
        continue;
      }
      const ref = pages.length + 1;
      const header = `[${ref}] ${path}`;
      const remaining = wikiBudget - used - estimateTokens(header);
      if (remaining <= 0) {
        break;
      }
      if (estimateTokens(content) > remaining) {
        if (remaining < 32) {
          // Too little left — truncation would be meaningless, drop the page.
          continue;
        }
        content = truncateToTokens(content, remaining);
      }
      const chunk = `${header}\n${content}`;
      used += estimateTokens(chunk);
      pages.push({ ref, path, score: round6(score) });
      chunks.push(chunk);
    }

    let indexText = this.store.readIndex().trim();
    if (indexText && estimateTokens(indexText) > indexBudget) {
      indexText = truncateToTokens(indexText, indexBudget);
    }
    return { context: chunks.join("\n\n"), pages, index: indexText, tokensUsed: used, budget };
  }

  /** Read full content by path: wiki/ prefix reads the page body, raw/markdown/ reads the file. */
  private readContent(path: string): string | null {
    if (path.startsWith("wiki/")) {
      try {
        return this.store.readPage(toRel(path)).body;
      } catch {
        return null;
      }
    }
    const filePath = join(this.store.kbRoot, ...path.split("/"));
    return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
  }

  // ---- P4 chat ----

  static readonly CHAT_PROMPT = `你是知识库问答助手。仅依据下面给出的编号参考资料回答用户问题。

## 知识库目标 purpose.md
{purpose}

## 目录 index.md
{index}

## 参考资料（[n] 编号 + 页路径 + 全文）
{context}

回答要求：
- 资料不足以回答时明说，不要编造；
- 引用来源时必须按 [1][2] 编号标注，编号与上面参考资料一一对应。`;

  /** P4 chat: returns the answer with [n] citations mapped back to pages. */
  async chat(query: string, history: KbChatHistoryMessage[] = [], opts: KbChatOptions = {}): Promise<KbChatResponse> {
    if (!this.adapter || !this.resolveModel) {
      throw new Error("KbQueryPipeline 未配置 LLM，无法执行 chat（search/assemble 仍可用）");
    }
    const assembled = this.assemble(query, opts.contextBudget);
    const system = KbQueryPipeline.CHAT_PROMPT.replace("{purpose}", this.store.readRootDoc("purpose.md"))
      .replace("{index}", assembled.index || "（空）")
      .replace("{context}", assembled.context || "（无命中资料）");
    const messages: AdapterMessage[] = [
      { role: "system", content: system },
      ...history.map((message) => ({ role: message.role, content: message.content }) as AdapterMessage),
      { role: "user", content: query },
    ];
    const { modelConfig, apiKey } = this.resolveModel();
    const result = await this.adapter.complete({ modelConfig, apiKey, messages });
    const answer = result.text;

    const byRef = new Map(assembled.pages.map((page) => [page.ref, page]));
    const citations: KbChatCitation[] = [];
    const seen = new Set<number>();
    for (const match of answer.matchAll(REF_RE)) {
      const ref = Number.parseInt(match[1]!, 10);
      if (seen.has(ref)) {
        continue;
      }
      seen.add(ref);
      const page = byRef.get(ref);
      if (!page) {
        continue;
      }
      citations.push({
        ref,
        page: page.path,
        title: this.titleOf(page.path),
        anchor: page.path.startsWith("wiki/") ? stemOf(toRel(page.path)) : undefined,
        sources: this.sourcesOf(page.path),
      });
    }
    return { answer, citations };
  }

  // ---- internal ----

  private toSearchResult(path: string, score: number, snippetText: string, tokens: string[]): KbSearchResult {
    let finalSnippet = snippetText;
    if (!finalSnippet) {
      const content = this.readContent(path);
      if (content) {
        finalSnippet = snippet(content, tokens) || content.slice(0, 80).replace(/\s+/g, " ").trim();
      }
    }
    return {
      page: path,
      title: this.titleOf(path),
      score,
      snippet: finalSnippet || undefined,
      sources: this.sourcesOf(path),
    };
  }

  private titleOf(path: string): string | undefined {
    if (!path.startsWith("wiki/")) {
      return basename(path, ".md");
    }
    try {
      const page = this.store.readPage(toRel(path));
      const title = page.meta.title;
      return typeof title === "string" && title ? title : stemOf(toRel(path));
    } catch {
      return undefined;
    }
  }

  /** Wiki pages take frontmatter sources; raw files are their own source. */
  private sourcesOf(path: string): string[] {
    if (path.startsWith("wiki/")) {
      try {
        return pageSources(this.store.readPage(toRel(path)));
      } catch {
        return [];
      }
    }
    return [path];
  }
}

/** wiki/xxx.md → xxx.md; anything else returned as-is. */
function toRel(path: string): string {
  return path.startsWith("wiki/") ? path.slice("wiki/".length) : path;
}

/** Body hit count weighted + title hit +10. */
function scoreTokens(tokens: string[], body: string, title: string): number {
  const lowered = body.toLowerCase();
  const titleLowered = title.toLowerCase();
  let score = 0;
  for (const tok of tokens) {
    score += countOccurrences(lowered, tok);
    if (titleLowered.includes(tok)) {
      score += 10.0;
    }
  }
  return score;
}
