/**
 * Two-Step CoT Ingest：把源文档的 Markdown 编译进 LLM-Wiki。
 * 端口自 k-pipeline app/ingest/two_step.py（Python → TypeScript）。
 *
 * 流程：
 * 1. Step1 分析：markdown + purpose.md + schema.md + 现有 index.md → 结构化分析 JSON；
 * 2. Step2 生成：分析结果 + 被点名的现有页内容 → 文件操作集 JSON，应用到 KbStore；
 * 3. 保底：Step1/Step2 解析失败或操作集为空时，都生成 wiki/sources/<文档名>.md 源摘要页；
 * 4. rebuild index.md、追加 log.md、LLM 重写 overview.md（失败保留旧版，不阻断）。
 *
 * 与 Python 版的差异：
 * - wiki agent 摄入路径与向量库维护不在本阶段端口范围内；
 * - sha256 增量缓存由 IngestQueue 侧的组合处理器负责，本类只做两步编译。
 */

import type { ModelConfig } from "@supbot/shared";
import type { ModelAdapter } from "../../modelAdapter";
import { WIKI_SECTIONS, type KbStore } from "../kbStore";

export const STEP1_PROMPT = `【Step1 分析】你是知识库摄入器。阅读下面这篇文档的 Markdown，
结合知识库现状做结构化分析。

## 知识库目标 purpose.md
{purpose}

## 结构规则 schema.md
{schema}

## 现有目录 index.md
{index}

## 文档 Markdown
{markdown}

请只输出一个严格 JSON 对象（不要输出任何其他文字）：
{
  "entities": ["关键实体页标题"],
  "concepts": ["关键概念页标题"],
  "links_to_existing": ["需要关联/更新的现有 wiki 页（标题或文件名）"],
  "contradictions": ["与现有知识的矛盾点，没有则为空列表"],
  "structure_advice": {"create": ["建议新建的页"], "update": ["建议更新的现有页"]},
  "summary": "200 字以内的文档摘要"
}`;

export const STEP2_PROMPT = `【Step2 生成】根据 Step1 的分析结果，生成 wiki 文件操作集。

## Step1 分析结果
{analysis}

## 被点名的现有页内容
{existing_pages}

## 文档 Markdown
{markdown}

请只输出一个严格 JSON 数组（不要输出任何其他文字），每个元素是一个文件操作：
[
  {
    "op": "create 或 update",
    "path": "entities/xxx.md（必须是 entities/concepts/sources/queries/synthesis 下的 .md）",
    "frontmatter": {"type": "...", "title": "...", "sources": ["{source}"], "created": "{today}"},
    "body": "Markdown 正文，用 [[wikilink]] 交叉引用其他页面"
  }
]`;

export const OVERVIEW_PROMPT = `【Overview】根据知识库最新目录重写全局摘要 overview.md
（Markdown，300 字以内）。

## 知识库目标 purpose.md
{purpose}

## 最新目录 index.md
{index}

只输出 overview.md 的 Markdown 正文。`;

const FALLBACK_SUMMARY_CHARS = 2000;
const JSON_PARSE_ATTEMPTS = 2;

export interface TwoStepDeps {
  /** LLM adapter（构造注入，不接 runtime 状态）。 */
  adapter: ModelAdapter;
  /** 调用时解析当前模型配置与 API key。 */
  resolveModel: () => { modelConfig: ModelConfig; apiKey?: string };
}

export type IngestStatus = "done" | "partial";

export interface IngestResult {
  /** done（LLM 全流程）/ partial（保底路径）。 */
  status: IngestStatus;
  /** 源文档引用（写入 frontmatter.sources[]）。 */
  source: string;
  /** 本次写入的 wiki 页 rel 路径。 */
  pages: string[];
  summary: string;
}

/** Step1 输出的结构化分析（字段全部可选，LLM 输出不可信）。 */
interface Step1Analysis {
  entities?: unknown;
  concepts?: unknown;
  links_to_existing?: unknown;
  contradictions?: unknown;
  structure_advice?: { create?: unknown; update?: unknown };
  summary?: unknown;
}

/** Step2 输出的单个文件操作。 */
interface FileOp {
  op?: unknown;
  path?: unknown;
  frontmatter?: unknown;
  body?: unknown;
}

export class TwoStepIngest {
  private readonly store: KbStore;
  private readonly adapter: ModelAdapter;
  private readonly resolveModel: () => { modelConfig: ModelConfig; apiKey?: string };

  constructor(store: KbStore, deps: TwoStepDeps) {
    this.store = store;
    this.adapter = deps.adapter;
    this.resolveModel = deps.resolveModel;
  }

  /**
   * 摄入单篇已转换为 Markdown 的文档。
   *
   * @param docName 文档名（stem），用于保底页 sources/<docName>.md
   * @param markdown 文档的 Markdown 正文
   * @param sourceRef frontmatter.sources[] 中的源引用，默认取 docName
   */
  async ingest(docName: string, markdown: string, sourceRef?: string): Promise<IngestResult> {
    const ref = sourceRef ?? docName;
    const analysis = await this.step1Analyze(markdown);
    if (!analysis) {
      // 保底：Step1 两次都解析失败，用 markdown 截断做摘要
      const summary = markdown.slice(0, FALLBACK_SUMMARY_CHARS);
      const pages = [this.ensureSourcePage(docName, ref, summary)];
      await this.finalize(pages, ref);
      return { status: "partial", source: ref, pages, summary };
    }

    const summary =
      typeof analysis.summary === "string" && analysis.summary
        ? analysis.summary
        : markdown.slice(0, FALLBACK_SUMMARY_CHARS);
    const pages = await this.step2Generate(markdown, analysis, ref);
    const sourcePage = `sources/${docName}.md`;
    if (!pages.includes(sourcePage)) {
      pages.push(this.ensureSourcePage(docName, ref, summary));
    }

    await this.finalize(pages, ref);
    return { status: "done", source: ref, pages, summary };
  }

  /** rebuild index、逐页 append log、LLM 重写 overview（失败不阻断）。 */
  private async finalize(pages: string[], ref: string): Promise<void> {
    this.store.rebuildIndex();
    for (const page of pages) {
      this.store.appendLog("ingest", page, ref);
    }
    await this.rewriteOverview();
  }

  // ---- Step1 / Step2 ----

  /** Step1：返回分析 JSON；解析失败重试一次，仍失败返回 null（调用方走保底）。 */
  private async step1Analyze(markdown: string): Promise<Step1Analysis | null> {
    const prompt = fillTemplate(STEP1_PROMPT, {
      purpose: this.store.readRootDoc("purpose.md"),
      schema: this.store.readRootDoc("schema.md"),
      index: this.store.readIndex() || "（空）",
      markdown,
    });
    for (let attempt = 0; attempt < JSON_PARSE_ATTEMPTS; attempt += 1) {
      try {
        const result = extractJson(await this.chat(prompt));
        if (isPlainObject(result)) {
          return result as Step1Analysis;
        }
      } catch {
        // LLM 输出不可信，任何解析异常都重试
      }
    }
    return null;
  }

  /** Step2：把文件操作集应用到 KbStore，返回写入的 wiki 页 rel 路径；完全不可信时返回空列表。 */
  private async step2Generate(markdown: string, analysis: Step1Analysis, ref: string): Promise<string[]> {
    const named = [...asStringList(analysis.links_to_existing), ...asStringList(analysis.structure_advice?.update)];
    const prompt = fillTemplate(STEP2_PROMPT, {
      analysis: JSON.stringify(analysis, null, 2),
      existing_pages: this.loadExistingPages(named),
      markdown,
      source: ref,
      today: todayIso(),
    });
    for (let attempt = 0; attempt < JSON_PARSE_ATTEMPTS; attempt += 1) {
      try {
        let ops: unknown = extractJson(await this.chat(prompt));
        if (isPlainObject(ops)) {
          // 容忍模型把数组包成 {"ops": [...]}
          ops = ops.ops ?? ops.operations ?? [];
        }
        if (Array.isArray(ops)) {
          return this.applyOps(ops, ref);
        }
      } catch {
        // 同上：解析失败重试
      }
    }
    return [];
  }

  /** 校验并应用文件操作；frontmatter 强制带 sources（含当前源）与 created。 */
  private applyOps(ops: unknown[], ref: string): string[] {
    const written: string[] = [];
    for (const raw of ops) {
      const op = raw as FileOp;
      if (!isPlainObject(op) || (op.op !== "create" && op.op !== "update")) {
        continue;
      }
      const rel = sanitizePagePath(op.path);
      if (!rel) {
        continue;
      }
      const frontmatter: Record<string, unknown> = isPlainObject(op.frontmatter) ? { ...op.frontmatter } : {};
      if (typeof frontmatter.type !== "string" || !frontmatter.type) {
        frontmatter.type = singularOf(rel.split("/")[0]!);
      }
      if (typeof frontmatter.title !== "string" || !frontmatter.title) {
        frontmatter.title = stemOf(rel);
      }
      const sources = asStringList(frontmatter.sources);
      if (!sources.includes(ref)) {
        sources.push(ref);
      }
      frontmatter.sources = sources;
      if (typeof frontmatter.created !== "string" || !frontmatter.created) {
        frontmatter.created = todayIso();
      }
      this.store.writePage(rel, frontmatter, typeof op.body === "string" ? op.body : "");
      written.push(rel);
    }
    return written;
  }

  /** 保底源摘要页 wiki/sources/<文档名>.md（type: source）。 */
  private ensureSourcePage(docName: string, ref: string, summary: string): string {
    const rel = `sources/${docName}.md`;
    this.store.writePage(
      rel,
      { type: "source", title: docName, sources: [ref], created: todayIso() },
      `# ${docName}\n\n## 摘要\n\n${summary}\n`,
    );
    return rel;
  }

  /** 把 Step1 点名的现有页内容拼进 Step2 prompt（按标题/文件名匹配）。 */
  private loadExistingPages(named: string[]): string {
    const chunks: string[] = [];
    for (const name of [...new Set(named)]) {
      for (const rel of this.store.listPages()) {
        const page = this.store.readPage(rel);
        const title = typeof page.meta.title === "string" ? page.meta.title : undefined;
        if (name === stemOf(rel) || name === title || name === rel) {
          chunks.push(`### ${rel}\n${page.body}`);
          break;
        }
      }
    }
    return chunks.join("\n\n") || "（无）";
  }

  /** LLM 重写 overview.md；任何失败都保留旧版。 */
  private async rewriteOverview(): Promise<void> {
    const prompt = fillTemplate(OVERVIEW_PROMPT, {
      purpose: this.store.readRootDoc("purpose.md"),
      index: this.store.readIndex() || "（空）",
    });
    try {
      const content = (await this.chat(prompt)).trim();
      if (content) {
        this.store.writeOverview(`${content}\n`);
      }
    } catch {
      // 保留旧版 overview
    }
  }

  private async chat(prompt: string): Promise<string> {
    const { modelConfig, apiKey } = this.resolveModel();
    const result = await this.adapter.complete({
      modelConfig,
      apiKey,
      messages: [{ role: "user", content: prompt }],
    });
    return result.text;
  }
}

/**
 * 只允许 entities/concepts/sources/queries/synthesis/graphs 下的 .md，拒绝越权路径。
 * 端口自 Python _sanitize_page_path。
 */
export function sanitizePagePath(path: unknown): string | null {
  if (typeof path !== "string") {
    return null;
  }
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) {
    return null;
  }
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (!parts.length || parts.includes("..")) {
    return null;
  }
  const rel = parts[0] === "wiki" ? parts.slice(1) : parts;
  if (rel.length !== 2 || !(WIKI_SECTIONS as readonly string[]).includes(rel[0]!) || !rel[1]!.endsWith(".md")) {
    return null;
  }
  return rel.join("/");
}

/**
 * 容错解析 LLM 输出的 JSON：整体 → ```json 代码块 → 首个花括号/方括号包裹段。
 * 端口自 Python _extract_json。
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed];
  const block = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (block) {
    candidates.unshift(block[1]!.trim());
  }
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
      continue;
    }
  }
  throw new Error("无法从 LLM 输出解析 JSON");
}

/** Python str.format 风格的命名占位符替换（{name}）。 */
function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? values[key]! : match));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stemOf(rel: string): string {
  const name = rel.split("/").pop() ?? rel;
  return name.replace(/\.[^.]*$/, "");
}

/** section 目录名 → 单数 type（entities → entity；synthesis/graphs 不规则，去尾 s 兜底）。 */
function singularOf(section: string): string {
  const map: Record<string, string> = {
    entities: "entity",
    concepts: "concept",
    sources: "source",
    queries: "query",
    synthesis: "synthesis",
    graphs: "graph",
  };
  return map[section] ?? section.replace(/s$/, "");
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
