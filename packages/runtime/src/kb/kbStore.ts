/**
 * LLM-Wiki storage layer: kb_root directory layout + wiki page read/write +
 * index/log/overview maintenance. Ported from k-pipeline's
 * app/storage/wiki_store.py (Python/PyYAML) to dependency-free TypeScript.
 *
 * Layout:
 *   kb_root/
 *   ├── purpose.md / schema.md        # human-curated rule files (default templates when missing)
 *   ├── raw/{sources,markdown,assets}/
 *   ├── wiki/
 *   │   ├── index.md / log.md / overview.md
 *   │   └── entities/ concepts/ sources/ queries/ synthesis/ graphs/
 *   └── .kbase/                       # metadata (ingest cache, review queue, ...)
 *
 * A wiki page is YAML frontmatter (type/title/sources[]/created) + Markdown
 * body; the body cross-references other pages with [[wikilink]].
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { WikiPage, WikiPageMeta } from "@supbot/shared";

export const WIKI_SECTIONS = ["entities", "concepts", "sources", "queries", "synthesis", "graphs"] as const;

const DEFAULT_PURPOSE = `# 知识库目标（purpose）

> 由人策展，LLM 每次 ingest/query 都会读取。请补充本知识库的范围与关键问题。

- 范围：（待填写）
- 关键问题：（待填写）
`;

const DEFAULT_SCHEMA = `# 结构规则（schema）

> 由人策展，LLM ingest 时遵守。

## 页面类型

- entity：具体的人/组织/系统/事物
- concept：抽象概念、方法、模型
- source：源文档摘要页（每篇摄入文档保底一页）
- query：查询场景页
- synthesis：综合页（跨源综合）

## 页面规范

每页 = YAML frontmatter + Markdown 正文：

\`\`\`markdown
---
type: entity
title: 页面标题
sources: ["raw/sources/来源文档"]
created: 2026-01-01
---

# 页面标题

正文，使用 [[其他页面]] 交叉引用。
\`\`\`

- frontmatter 必须带 sources[]（溯源到 raw 源文件）；
- 页面文件名为标题的 slug，放在对应类型目录下。
`;

const LOG_HEADER = "# Ingest Log\n\n| 时间 | 操作 | 页面 | 来源 |\n|---|---|---|---|\n";

const WIKILINK_RE = /\[\[([^[\]|]+)(?:\|[^[\]]*)?\]\]/g;

/** Extract [[wikilink]] targets from a body (supports [[target|alias]], deduped in order of appearance). */
export function extractWikilinks(body: string): string[] {
  const seen: string[] = [];
  for (const match of body.matchAll(WIKILINK_RE)) {
    const target = (match[1] || "").trim();
    if (target && !seen.includes(target)) {
      seen.push(target);
    }
  }
  return seen;
}

// ---- Minimal YAML subset (flat key: value, string arrays, no dependencies) ----

type YamlValue = string | number | boolean | string[];

/** Serialize a flat record to the supported YAML subset (block lists for arrays). */
export function serializeYaml(meta: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      if (!value.length) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${formatYamlScalar(item)}`);
        }
      }
    } else {
      lines.push(`${key}: ${formatYamlScalar(value as string | number | boolean)}`);
    }
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Parse the supported YAML subset back into a flat record. */
export function parseYaml(text: string): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(/^([\w-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1]!;
    const raw = match[2]!.trim();
    if (raw) {
      out[key] = parseYamlValue(raw);
      continue;
    }
    // Empty value: either an empty string or a `- item` block list follows.
    const items: string[] = [];
    while (index + 1 < lines.length) {
      const item = lines[index + 1]!.match(/^\s+-\s+(.*)$/);
      if (!item) {
        break;
      }
      items.push(String(parseYamlScalar(item[1]!.trim())));
      index += 1;
    }
    out[key] = items.length ? items : "";
  }
  return out;
}

function parseYamlValue(raw: string): YamlValue {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return inner.split(",").map((part) => String(parseYamlScalar(part.trim())));
  }
  return parseYamlScalar(raw);
}

function parseYamlScalar(raw: string): string | number | boolean {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (/^-?\d+$/.test(raw)) {
    return Number.parseInt(raw, 10);
  }
  if (/^-?\d*\.\d+$/.test(raw)) {
    return Number.parseFloat(raw);
  }
  if (raw === "true" || raw === "false") {
    return raw === "true";
  }
  return raw;
}

function formatYamlScalar(value: string | number | boolean): string {
  if (typeof value !== "string") {
    return String(value);
  }
  if (yamlScalarNeedsQuotes(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function yamlScalarNeedsQuotes(value: string): boolean {
  return (
    value === "" ||
    value !== value.trim() ||
    /[:#[\]{},&*!|>'"@`]/.test(value) ||
    /^-?\d+(\.\d+)?$/.test(value) ||
    value === "true" ||
    value === "false" ||
    value === "null" ||
    value === "~"
  );
}

// ---- WikiStore ----

export class KbStore {
  readonly kbRoot: string;
  readonly wikiDir: string;

  constructor(projectRoot: string) {
    this.kbRoot = projectRoot;
    this.wikiDir = join(this.kbRoot, "wiki");
    this.initLayout();
  }

  /** Initialize the kb_root layout; existing files are never overwritten. */
  private initLayout(): void {
    for (const rel of ["raw/sources", "raw/markdown", "raw/assets", ".kbase"]) {
      mkdirSync(join(this.kbRoot, rel), { recursive: true });
    }
    for (const section of WIKI_SECTIONS) {
      mkdirSync(join(this.wikiDir, section), { recursive: true });
    }
    for (const [name, template] of [
      ["purpose.md", DEFAULT_PURPOSE],
      ["schema.md", DEFAULT_SCHEMA],
    ] as const) {
      const path = join(this.kbRoot, name);
      if (!existsSync(path)) {
        writeFileSync(path, template, "utf8");
      }
    }
    for (const name of ["index.md", "overview.md"]) {
      const path = join(this.wikiDir, name);
      if (!existsSync(path)) {
        writeFileSync(path, "", "utf8");
      }
    }
    const log = join(this.wikiDir, "log.md");
    if (!existsSync(log)) {
      writeFileSync(log, LOG_HEADER, "utf8");
    }
  }

  // ---- Wiki page read/write ----

  /** Resolve a wiki-relative page path; rejects absolute paths and ".." traversal. */
  private pagePath(relPath: string): string {
    const normalized = relPath.replace(/\\/g, "/");
    if (isAbsolute(relPath) || normalized.split("/").includes("..")) {
      throw new Error(`非法 wiki 页路径: ${relPath}`);
    }
    const rel = normalized.startsWith("wiki/") ? normalized.slice("wiki/".length) : normalized;
    return join(this.wikiDir, rel);
  }

  /** Write a wiki page (frontmatter + body), creating parent directories. Returns the absolute path. */
  writePage(relPath: string, meta: WikiPageMeta, body: string): string {
    const path = this.pagePath(relPath);
    mkdirSync(dirname(path), { recursive: true });
    const fm = serializeYaml(meta as Record<string, unknown>);
    writeFileSync(path, `---\n${fm}---\n\n${body}`, "utf8");
    return path;
  }

  /** Read a wiki page; throws if the file does not exist. */
  readPage(relPath: string): WikiPage {
    const text = readFileSync(this.pagePath(relPath), "utf8");
    if (text.startsWith("---\n")) {
      const end = text.indexOf("\n---\n", 4);
      if (end !== -1) {
        const meta = parseYaml(text.slice(4, end)) as WikiPageMeta;
        let body = text.slice(end + 5);
        if (body.startsWith("\n")) {
          body = body.slice(1);
        }
        return { meta, body };
      }
    }
    return { meta: {}, body: text };
  }

  /** Delete a wiki page; returns whether a file was actually removed. */
  deletePage(relPath: string): boolean {
    const path = this.pagePath(relPath);
    if (existsSync(path)) {
      unlinkSync(path);
      return true;
    }
    return false;
  }

  /** List all knowledge pages under wiki/ (excluding index/log/overview), sorted by path. */
  listPages(): string[] {
    const out: string[] = [];
    for (const section of WIKI_SECTIONS) {
      const sectionDir = join(this.wikiDir, section);
      const names = existsSync(sectionDir)
        ? readdirSync(sectionDir)
            .filter((name) => name.endsWith(".md"))
            .sort()
        : [];
      out.push(...names.map((name) => `${section}/${name}`));
    }
    return out.sort();
  }

  pageWikilinks(relPath: string): string[] {
    return extractWikilinks(this.readPage(relPath).body);
  }

  // ---- Root-level rule files ----

  /** Read a rule file under kb_root (purpose.md / schema.md); returns "" when missing. */
  readRootDoc(name: string): string {
    const path = join(this.kbRoot, name);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  /** Write a rule file under kb_root (purpose.md / schema.md). */
  writeRootDoc(name: string, content: string): void {
    writeFileSync(join(this.kbRoot, name), content, "utf8");
  }

  // ---- index.md ----

  /** Deterministically rebuild wiki/index.md section by section; same page set yields identical output. */
  rebuildIndex(): string {
    const lines = ["# Wiki Index", "", "> 由 KbStore.rebuildIndex() 自动生成，请勿手改。", ""];
    for (const section of WIKI_SECTIONS) {
      const pages = this.listPages().filter((page) => page.startsWith(`${section}/`));
      if (!pages.length) {
        continue;
      }
      lines.push(`## ${section}`);
      lines.push("");
      for (const rel of pages) {
        const page = this.readPage(rel);
        const stem = basename(rel, ".md");
        const ptype = typeof page.meta.type === "string" && page.meta.type ? page.meta.type : singularSection(section);
        const title = typeof page.meta.title === "string" && page.meta.title ? page.meta.title : stem;
        lines.push(`- [[${stem}]] — ${ptype} · ${title}`);
      }
      lines.push("");
    }
    const content = `${lines.join("\n").replace(/\n+$/, "")}\n`;
    writeFileSync(join(this.wikiDir, "index.md"), content, "utf8");
    return content;
  }

  readIndex(): string {
    const path = join(this.wikiDir, "index.md");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  // ---- log.md ----

  /** Append one parseable log row: `| 时间 | 操作 | 页面 | 来源 |`. */
  appendLog(action: string, page = "-", source = "-"): void {
    const log = join(this.wikiDir, "log.md");
    if (!existsSync(log)) {
      writeFileSync(log, LOG_HEADER, "utf8");
    }
    const clean = (value: string): string => String(value).replace(/\|/g, "/").replace(/\n/g, " ").trim() || "-";
    const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
    appendFileSync(log, `| ${ts} | ${clean(action)} | ${clean(page)} | ${clean(source)} |\n`, "utf8");
  }

  // ---- overview.md ----

  /** Overwrite wiki/overview.md (content generated by the caller). */
  writeOverview(content: string): void {
    writeFileSync(join(this.wikiDir, "overview.md"), content, "utf8");
  }

  readOverview(): string {
    const path = join(this.wikiDir, "overview.md");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }
}

/** Singular page type for a section directory, used as fallback when frontmatter has no type. */
function singularSection(section: string): string {
  const map: Record<string, string> = {
    entities: "entity",
    concepts: "concept",
    sources: "source",
    queries: "query",
    synthesis: "synthesis",
    graphs: "graph",
  };
  return map[section] ?? section;
}
