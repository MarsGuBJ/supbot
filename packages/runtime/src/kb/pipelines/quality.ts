/**
 * 转换质量校验器与 GFM/HTML 表格工具。
 * 端口自 k-pipeline app/pipelines/quality.py。
 *
 * 保真规则：简单表格输出标准 GFM 表格；行列不一致等 GFM 无法表达的情况
 * 降级为 HTML <table>，禁止拍平成纯文本。
 */

import type { MarkdownBundle } from "./base";

/** GFM 单元格转义：竖线与换行。 */
export function escapeCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : stringifyCell(value);
  return text.replace(/\|/g, "\\|").replace(/\r\n/g, "<br>").replace(/\n/g, "<br>").trim();
}

function stringifyCell(value: unknown): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  }
  return String(value);
}

/** 二维表（首行为表头）转 GFM Markdown 表格。空表返回空串。 */
export function toGfmTable(rows: unknown[][]): string {
  if (!rows.length) {
    return "";
  }
  const width = Math.max(...rows.map((row) => row.length));
  const norm = rows.map((row) => [...row, ...Array<unknown>(width - row.length).fill("")]);
  const header = `| ${norm[0]!.map(escapeCell).join(" | ")} |`;
  const sep = `|${" --- |".repeat(width)}`;
  const body = norm.slice(1).map((row) => `| ${row.map(escapeCell).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

/** 降级输出 HTML <table>（首行视为表头）。 */
export function toHtmlTable(rows: unknown[][]): string {
  if (!rows.length) {
    return "";
  }
  const lines = ["<table>", "  <thead>", "    <tr>"];
  for (const cell of rows[0]!) {
    lines.push(`      <th>${escapeHtml(cell === null || cell === undefined ? "" : stringifyCell(cell))}</th>`);
  }
  lines.push("    </tr>", "  </thead>", "  <tbody>");
  for (const row of rows.slice(1)) {
    lines.push("    <tr>");
    for (const cell of row) {
      lines.push(`      <td>${escapeHtml(cell === null || cell === undefined ? "" : stringifyCell(cell))}</td>`);
    }
    lines.push("    </tr>");
  }
  lines.push("  </tbody>", "</table>");
  return lines.join("\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const TABLE_LINE = /^\s*\|.*\|\s*$/;
const SEP_LINE = /^\s*\|[\s:|-]+\|\s*$/;

/** 拆分 GFM 表格行（忽略转义的 \|）。 */
function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return body.split(/(?<!\\)\|/);
}

/** 找出连续的 GFM 表格块（header + 分隔行 + 数据行），返回 [start, end) 区间。 */
function findTableBlocks(lines: string[]): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  let i = 0;
  while (i < lines.length) {
    if (TABLE_LINE.test(lines[i]!) && i + 1 < lines.length && SEP_LINE.test(lines[i + 1]!)) {
      let j = i + 2;
      while (j < lines.length && TABLE_LINE.test(lines[j]!)) {
        j += 1;
      }
      blocks.push([i, j]);
      i = j;
    } else {
      i += 1;
    }
  }
  return blocks;
}

export interface ValidateResult {
  markdown: string;
  quality: { tables: number; tables_degraded_to_html: number; paragraphs: number };
}

/**
 * 校验并修复 Markdown：
 * - GFM 表格每行单元格数须与表头一致，不一致的表降级为 HTML <table>；
 * - 统计质量指标（表格数、段落数）。
 */
export function validateMarkdown(markdown: string): ValidateResult {
  const lines = markdown.split("\n");
  const blocks = findTableBlocks(lines);
  let degraded = 0;
  const out: string[] = [];
  let prev = 0;
  for (const [start, end] of blocks) {
    out.push(...lines.slice(prev, start));
    const block = lines.slice(start, end);
    const width = splitRow(block[0]!).length;
    if (block.slice(1).every((row) => splitRow(row).length === width)) {
      out.push(...block);
    } else {
      degraded += 1;
      const rows = block.filter((row) => !SEP_LINE.test(row)).map((row) => splitRow(row).map((cell) => cell.trim()));
      out.push(...toHtmlTable(rows).split("\n"));
    }
    prev = end;
  }
  out.push(...lines.slice(prev));

  const fixed = out.join("\n");
  const paragraphs = fixed.split(/\n\s*\n/).filter((part) => part.trim()).length;
  return { markdown: fixed, quality: { tables: blocks.length, tables_degraded_to_html: degraded, paragraphs } };
}

/** 对转换结果执行质量校验：修复表格并把指标写入 meta.quality。 */
export function checkBundle(bundle: MarkdownBundle): MarkdownBundle {
  const { markdown, quality } = validateMarkdown(bundle.markdown);
  bundle.markdown = markdown;
  Object.assign(bundle.meta.quality, quality);
  return bundle;
}
