/**
 * Graph extraction: a single LLM call extracts a node-edge structure from a
 * document's markdown according to a template, rendered into a wiki page.
 * Ported from k-pipeline's app/graph/extractor.py.
 *
 * - extract(): builds EXTRACT_PROMPT → adapter.complete → extractJson tolerant
 *   parse → structural validation; retries once on failure. match=false or
 *   empty nodes/edges yields a no-match result and no page is written.
 * - renderGraphPage(): renders the result as a wiki page (entity/relation
 *   tables + backlink to the source document + a trailing ```json block with
 *   the raw data for visualization).
 * - graphPageName(): deterministic page name graphs/<doc_stem>--<template>.md;
 *   "already extracted" is decided by page existence.
 * - parseGraphPage(): parses nodes/edges back out of a wiki page body
 *   (for visualization).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GraphEdge, GraphExtraction, GraphNode, GraphTemplate, ModelConfig, WikiPageMeta } from "@supbot/shared";
import type { ModelAdapter } from "../../modelAdapter";
import type { KbStore } from "../kbStore";
import { validateTemplateName, type GraphTemplateStore } from "./templates";

const NO_MATCH: GraphExtraction = { match: false, nodes: [], edges: [] };

const JSON_BLOCK_RE = /```json\s*([\s\S]*?)```/;

/** Stem of a document path (POSIX semantics: last segment minus its final suffix). */
function docStem(docName: string): string {
  const base = docName.replace(/\\/g, "/").split("/").pop() || docName;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Deterministic page name graphs/<doc_stem>--<template>.md (page exists ⇒ already extracted). */
export function graphPageName(docName: string, templateName: string): string {
  return `graphs/${docStem(docName)}--${validateTemplateName(templateName)}.md`;
}

/** Extraction prompt, ported verbatim from k-pipeline's EXTRACT_PROMPT. */
export function buildExtractPrompt(template: GraphTemplate, markdown: string): string {
  return `【知识图谱抽取】你是知识图谱抽取器。按给定模版从文档中抽取实体与关系。

## 模版
- 名称：${template.name}
- 描述：${template.description || "（无）"}
- 实体类型：${template.entityTypes.join("、") || "（不限）"}
- 关系类型：${template.relationTypes.join("、") || "（不限）"}
- 补充说明：${template.instructions || "（无）"}

## 文档 Markdown
${markdown}

请只输出一个严格 JSON 对象（不要输出任何其他文字）：
{
  "match": true 或 false,
  "nodes": [{"name": "实体名", "type": "实体类型", "description": "一句话描述"}],
  "edges": [{"source": "源实体名", "target": "目标实体名", "relation": "关系类型",
             "description": "一句话描述"}]
}

要求：
- 文档不含模版指定的知识时，返回 {"match": false, "nodes": [], "edges": []}；
- match=true 时 nodes/edges 均不能为空；
- type / relation 优先取模版给定类型，确实没有合适的可自拟；
- edges 的 source / target 必须是 nodes 中出现过的 name。`;
}

/**
 * Tolerantly parse JSON from LLM output: whole text → ```json code block →
 * first span wrapped by {} or []. Throws when nothing parses.
 * Ported from k-pipeline's app/ingest/two_step.py::_extract_json.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [];
  const block = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (block) {
    candidates.push(block[1]!.trim());
  }
  candidates.push(trimmed);
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = trimmed.indexOf(open);
    const end = trimmed.lastIndexOf(close);
    if (start >= 0 && start < end) {
      candidates.push(trimmed.slice(start, end + 1));
    }
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("无法从 LLM 输出解析 JSON");
}

/**
 * Validate and clean LLM output; returns null for match=false / empty results
 * / illegal structure. Edges referencing unknown nodes are dropped; if nodes
 * or edges are empty after cleaning the whole result is treated as no-match.
 */
export function validateExtraction(result: unknown): { nodes: GraphNode[]; edges: GraphEdge[] } | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  const record = result as Record<string, unknown>;
  if (!record.match) {
    return null;
  }
  const nodes: GraphNode[] = [];
  for (const node of Array.isArray(record.nodes) ? record.nodes : []) {
    if (node && typeof node === "object" && !Array.isArray(node)) {
      const name = (node as Record<string, unknown>).name;
      if (typeof name === "string" && name) {
        nodes.push({
          name,
          type: toText((node as Record<string, unknown>).type),
          description: toText((node as Record<string, unknown>).description),
        });
      }
    }
  }
  const names = new Set(nodes.map((node) => node.name));
  const edges: GraphEdge[] = [];
  for (const edge of Array.isArray(record.edges) ? record.edges : []) {
    if (!edge || typeof edge !== "object" || Array.isArray(edge)) {
      continue;
    }
    const source = (edge as Record<string, unknown>).source;
    const target = (edge as Record<string, unknown>).target;
    if (typeof source !== "string" || typeof target !== "string" || !names.has(source) || !names.has(target)) {
      continue;
    }
    edges.push({
      source,
      target,
      relation: toText((edge as Record<string, unknown>).relation),
      description: toText((edge as Record<string, unknown>).description),
    });
  }
  if (!nodes.length || !edges.length) {
    return null;
  }
  return { nodes, edges };
}

function toText(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/**
 * Render an extraction result as a wiki page: entity/relation markdown tables
 * + a [[wikilink]] back to the source document's sources page + a trailing
 * ```json block with the raw nodes/edges (parseGraphPage reads it back).
 */
export function renderGraphPage(
  template: GraphTemplate,
  docName: string,
  result: { nodes: GraphNode[]; edges: GraphEdge[] },
): { meta: WikiPageMeta; body: string } {
  const stem = docStem(docName);
  const meta: WikiPageMeta = {
    type: "graph",
    title: `${stem} · ${template.name} 图谱`,
    sources: [docName],
    created: new Date().toISOString().slice(0, 10),
  };
  const lines = [
    `# ${stem} × ${template.name} 知识图谱`,
    "",
    `> 模版：${template.name}（${template.description || "无描述"}）`,
    `> 来源文档：[[${stem}]]`,
    "",
    "## 实体",
    "",
    "| 名称 | 类型 | 描述 |",
    "|---|---|---|",
  ];
  for (const node of result.nodes) {
    lines.push(`| ${node.name} | ${node.type} | ${node.description ?? ""} |`);
  }
  lines.push("", "## 关系", "", "| 源 | 关系 | 目标 | 描述 |", "|---|---|---|---|");
  for (const edge of result.edges) {
    lines.push(`| ${edge.source} | ${edge.relation} | ${edge.target} | ${edge.description ?? ""} |`);
  }
  lines.push("", "## 原始数据", "", "```json", JSON.stringify(result, null, 2), "```", "");
  return { meta, body: lines.join("\n") };
}

/** Parse {"nodes": [...], "edges": [...]} back out of a wiki page's ```json block (for visualization). */
export function parseGraphPage(body: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const block = JSON_BLOCK_RE.exec(body);
  if (!block) {
    throw new Error("图谱页缺少 json 数据块");
  }
  const data = JSON.parse(block[1]!) as { nodes?: unknown; edges?: unknown };
  if (!data || typeof data !== "object" || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    throw new Error("图谱页 json 数据块结构非法");
  }
  return { nodes: data.nodes as GraphNode[], edges: data.edges as GraphEdge[] };
}

export interface GraphExtractorDeps {
  adapter: ModelAdapter;
  modelConfig: ModelConfig;
  apiKey?: string;
}

/**
 * Extracts knowledge graphs from documents into a project KbStore, using
 * global templates from a GraphTemplateStore. The LLM dependency is injected
 * (ModelAdapter + ModelConfig); no runtime state is touched here.
 */
export class GraphExtractor {
  constructor(
    private readonly kbStore: KbStore,
    private readonly templateStore: GraphTemplateStore,
    private readonly llm: GraphExtractorDeps,
  ) {}

  graphPageName(docName: string, templateName: string): string {
    return graphPageName(docName, templateName);
  }

  /** Whether the graph page already exists (idempotency check). */
  isExtracted(docName: string, templateName: string): boolean {
    return existsSync(join(this.kbStore.wikiDir, graphPageName(docName, templateName)));
  }

  /**
   * Extract a graph from `markdown` per the named template, render the graphs
   * wiki page, and return the structured nodes/edges. Retries the LLM call
   * once on unparseable/invalid output; a no-match result writes no page.
   */
  async extract(docName: string, templateName: string, markdown: string): Promise<GraphExtraction> {
    const template = this.templateStore.get(templateName);
    const prompt = buildExtractPrompt(template, markdown);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let parsed: unknown;
      try {
        const result = await this.llm.adapter.complete({
          modelConfig: this.llm.modelConfig,
          apiKey: this.llm.apiKey,
          messages: [{ role: "user", content: prompt }],
        });
        parsed = extractJson(result.text);
      } catch {
        continue; // LLM output is untrusted: any parse failure retries once.
      }
      const cleaned = validateExtraction(parsed);
      if (!cleaned) {
        continue;
      }
      const { meta, body } = renderGraphPage(template, docName, cleaned);
      this.kbStore.writePage(graphPageName(docName, template.name), meta, body);
      return { match: true, nodes: cleaned.nodes, edges: cleaned.edges };
    }
    return { ...NO_MATCH, nodes: [], edges: [] };
  }

  /** Read nodes/edges back from an already-extracted page's ```json block. */
  view(docName: string, templateName: string): GraphExtraction {
    const page = this.kbStore.readPage(graphPageName(docName, templateName));
    const data = parseGraphPage(page.body);
    return { match: true, nodes: data.nodes, edges: data.edges };
  }
}
