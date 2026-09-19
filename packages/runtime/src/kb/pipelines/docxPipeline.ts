/**
 * docx-pipeline：mammoth 转 HTML 再转 GFM markdown（保留图片到 assets）。
 * 端口自 k-pipeline app/pipelines/docx_pipeline.py
 * （python-docx → mammoth；标题/加粗/斜体/表格/图片语义一致保留）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import mammoth from "mammoth";
import { baseMeta, type MarkdownBundle, type Pipeline } from "./base";
import { checkBundle, toGfmTable } from "./quality";
import { FileFormat, identifyFormat } from "./router";
import { decodeEntities } from "./textPipeline";

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
};

/** mammoth HTML → GFM Markdown：标题/段落/列表/表格/图片/加粗斜体。 */
export function docxHtmlToMarkdown(html: string): string {
  const out: string[] = [];
  let inTable = false;
  let tableRows: string[][] = [];
  let currentRow: string[] | null = null;
  let cellParts: string[] | null = null;

  const paragraphBreak = (): void => {
    if (out.length && !out.join("").endsWith("\n\n")) {
      out.push(out.join("").endsWith("\n") ? "\n" : "\n\n");
    }
  };

  const TOKEN_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/g;
  for (const match of html.matchAll(TOKEN_RE)) {
    const tag = match[1]?.toLowerCase();
    const attrs = match[2] ?? "";
    const data = match[3];
    if (data !== undefined) {
      const text = decodeEntities(data).replace(/\s+/g, " ");
      if (cellParts) {
        cellParts.push(text);
      } else {
        out.push(text);
      }
      continue;
    }
    if (!tag) {
      continue;
    }
    const isEnd = match[0].startsWith("</");
    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        if (!isEnd) {
          paragraphBreak();
          out.push(`${"#".repeat(Number(tag[1]))} `);
        } else {
          paragraphBreak();
        }
        break;
      case "p":
        paragraphBreak();
        break;
      case "br":
        out.push("\n");
        break;
      case "strong":
      case "b":
        out.push("**");
        break;
      case "em":
      case "i":
        out.push("*");
        break;
      case "li":
        out.push("\n- ");
        break;
      case "ul":
      case "ol":
        paragraphBreak();
        break;
      case "img": {
        const src = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/.exec(attrs);
        const url = src?.[2] ?? src?.[3] ?? src?.[4] ?? "";
        if (url) {
          out.push(`![](${url})`);
        }
        break;
      }
      case "table":
        if (!isEnd) {
          paragraphBreak();
          inTable = true;
          tableRows = [];
        } else {
          inTable = false;
          out.push(toGfmTable(tableRows), "\n\n");
        }
        break;
      case "tr":
        if (inTable) {
          if (isEnd && currentRow) {
            tableRows.push(currentRow);
            currentRow = null;
          } else if (!isEnd) {
            currentRow = [];
          }
        }
        break;
      case "td":
      case "th":
        if (inTable && currentRow) {
          if (!isEnd) {
            cellParts = [];
          } else if (cellParts) {
            currentRow.push(cellParts.join("").trim());
            cellParts = null;
          }
        }
        break;
      default:
        break;
    }
  }

  return out
    .join("")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export class DocxPipeline implements Pipeline {
  readonly name = "docx-pipeline";

  async detect(file: string): Promise<boolean> {
    return (await identifyFormat(file)) === FileFormat.Docx;
  }

  async convert(file: string, assetsDir: string): Promise<MarkdownBundle> {
    mkdirSync(assetsDir, { recursive: true });
    if (!(await this.detect(file))) {
      throw new Error(`docx-pipeline 只处理 .docx: ${file}`);
    }

    const assets: string[] = [];
    let imageIndex = 0;
    const result = await mammoth.convertToHtml(
      { path: file },
      {
        convertImage: mammoth.images.imgElement(async (image) => {
          imageIndex += 1;
          const extension = IMAGE_EXTENSIONS[image.contentType] ?? ".png";
          const name = `image${imageIndex}${extension}`;
          const target = join(assetsDir, name);
          writeFileSync(target, Buffer.from(await image.readAsBase64String(), "base64"));
          assets.push(target);
          return { src: `assets/${name}` };
        }),
      },
    );

    const markdown = `${docxHtmlToMarkdown(result.value)}\n`;
    const meta = await baseMeta(file, "docx", this.name);
    return checkBundle({ markdown, assets, meta });
  }
}
