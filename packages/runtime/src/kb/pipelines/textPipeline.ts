/**
 * text-pipeline：txt/md/html 归一化为 UTF-8 Markdown（jschardet 检测编码）。
 * 端口自 k-pipeline app/pipelines/text_pipeline.py。
 *
 * html 用轻量标签扫描抽取可读文本：标题转 # 层级、列表转 - 项、
 * 段落/换行保留，script/style 内容丢弃。
 */

import { mkdirSync, readFileSync } from "node:fs";
import { baseMeta, type MarkdownBundle, type Pipeline } from "./base";
import { decodeText, detectEncoding } from "./encoding";
import { checkBundle } from "./quality";
import { FileFormat, identifyFormat } from "./router";

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "br",
  "hr",
  "tr",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "ul",
  "ol",
  "dl",
  "blockquote",
  "pre",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "nav",
  "aside",
  "figure",
  "figcaption",
  "form",
]);
const HEADING_TAGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
const SKIP_TAGS = new Set(["script", "style", "head", "title", "noscript", "template"]);

const TAG_RE = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>|([^<]+)/g;

/** 把 HTML 标签结构转成带层级的纯文本 Markdown（端口 _HtmlTextExtractor）。 */
export function htmlToMarkdown(htmlText: string): string {
  const parts: string[] = [];
  let skipDepth = 0;

  const newline = (): void => {
    parts.push("\n");
  };

  for (const match of htmlText.matchAll(TAG_RE)) {
    const tag = match[1]?.toLowerCase();
    const data = match[2];
    if (tag) {
      const isEnd = match[0].startsWith("</");
      if (SKIP_TAGS.has(tag)) {
        skipDepth = Math.max(0, skipDepth + (isEnd ? -1 : 1));
        continue;
      }
      if (skipDepth) {
        continue;
      }
      if (!isEnd) {
        if (tag in HEADING_TAGS) {
          newline();
          parts.push(`${"#".repeat(HEADING_TAGS[tag]!)} `);
        } else if (tag === "li") {
          newline();
          parts.push("- ");
        } else if (tag === "td" || tag === "th") {
          parts.push(" | ");
        } else if (BLOCK_TAGS.has(tag)) {
          newline();
        }
      } else if (tag in HEADING_TAGS || BLOCK_TAGS.has(tag) || tag === "li") {
        newline();
      }
      continue;
    }
    // 文本节点（match[0] 以 <!-- 开头时 tag/data 均为 undefined，注释被跳过）
    if (data === undefined || skipDepth) {
      continue;
    }
    const text = decodeEntities(data).split(/\s+/).filter(Boolean).join(" ");
    if (text) {
      parts.push(`${text} `);
    }
  }

  // 折叠连续空行
  const out: string[] = [];
  for (const line of parts
    .join("")
    .split("\n")
    .map((line) => line.trim())) {
    if (line || (out.length && out[out.length - 1])) {
      out.push(line);
    }
  }
  return out.join("\n").replace(/^\n+|\n+$/g, "");
}

/** 解码常见 HTML 实体（HTMLParser(convert_charrefs=True) 的对应物）。 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(x?[0-9a-fA-F]+);/g, (_, code: string) => {
      const codePoint = code.toLowerCase().startsWith("x")
        ? Number.parseInt(code.slice(1), 16)
        : Number.parseInt(code, 10);
      return Number.isNaN(codePoint) ? "" : String.fromCodePoint(codePoint);
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => {
      const map: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
      return map[name] ?? "";
    });
}

export class TextPipeline implements Pipeline {
  readonly name = "text-pipeline";

  async detect(file: string): Promise<boolean> {
    const format = await identifyFormat(file);
    return format === FileFormat.Txt || format === FileFormat.Md || format === FileFormat.Html;
  }

  async convert(file: string, assetsDir: string): Promise<MarkdownBundle> {
    mkdirSync(assetsDir, { recursive: true });
    const format = await identifyFormat(file);
    if (format !== FileFormat.Txt && format !== FileFormat.Md && format !== FileFormat.Html) {
      throw new Error(`text-pipeline 不支持格式: ${format}`);
    }

    const raw = readFileSync(file);
    const encoding = detectEncoding(raw) ?? "utf-8";
    // 归一化换行为 LF
    const text = decodeText(raw, encoding).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const markdown = format === FileFormat.Html ? htmlToMarkdown(text) : text;

    const meta = await baseMeta(file, format, this.name);
    meta.encoding = encoding;
    return checkBundle({ markdown, assets: [], meta });
  }
}
