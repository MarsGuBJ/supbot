/**
 * pdf-text / pdf-scan pipeline（pdfjs-dist）。
 * 端口自 k-pipeline app/pipelines/pdf_text_pipeline.py + pdf_scan_pipeline.py。
 *
 * 与 Python 版的差异（PyMuPDF/pdfplumber/MinerU/PaddleOCR 无对应 JS 依赖）：
 * - 文本层提取用 pdfjs-dist legacy build（Node 下 fake worker，无需配置）；
 * - pdfplumber 的表格检测无 JS 对应物：不做表格区域检测，无边框表格拍平页
 *   仍靠「行内 ≥2 个千分位金额 token」启发式记入 suspect_pages；
 * - MinerU / PaddleOCR 降级链不移植：扫描件唯一路径是视觉 LLM 逐页转写，
 *   模型不可用/不支持图像 → ocr_confidence=0 进 Review；
 * - 页面栅格化需要 canvas（桌面端不假设存在），改为从 pdfjs operator list
 *   抽取页面内嵌图像（扫描件通常整页一张大图）并自编码 PNG。
 */

import { deflateSync } from "node:zlib";
import { mkdirSync } from "node:fs";
import { ImageKind, OPS, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.js";
import { baseMeta, type MarkdownBundle, type Pipeline } from "./base";
import { openPdf, pageTextContent, PDF_MIN_CHARS_PER_PAGE } from "./pdfDoc";
import { checkBundle } from "./quality";
import { FileFormat, identifyFormat } from "./router";
import { parseLlmConfidence, visionComplete, type VisionLlm } from "./vision";

// 千分位金额/数字 token，如 1,232,916,474.06；一行内出现多个通常是拍平的表格行
const MONEY_TOKEN_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?/g;
const SUSPECT_MIN_TOKENS_PER_LINE = 2;

/** 扫描页视觉转写 prompt（端口 Python _PAGE_PROMPT；无 OCR 引擎，OCR 文本固定为「（无）」）。 */
export const SCAN_PAGE_PROMPT = `这是扫描件 PDF 一页的整页图像，下方为该页的 OCR 文本（可能含错漏）。
请重建该页的 Markdown：文本段落照录并校正明显 OCR 错字；表格重建为 GFM 表格。
只输出该页 Markdown，不要额外解释；末尾输出 <!-- confidence: 0.xx --> 表示还原质量自评。

OCR 文本：
（无）`;

// ------------------------------------------------------------------
// pdf-text-pipeline

interface TextItem {
  str: string;
  x: number;
  y: number;
  height: number;
  width: number;
}

export class PdfTextPipeline implements Pipeline {
  readonly name = "pdf-text-pipeline";

  async detect(file: string): Promise<boolean> {
    return (await identifyFormat(file)) === FileFormat.PdfText;
  }

  async convert(file: string, assetsDir: string): Promise<MarkdownBundle> {
    mkdirSync(assetsDir, { recursive: true });
    if (!(await this.detect(file))) {
      throw new Error(`pdf-text-pipeline 只处理有文本层的 PDF: ${file}`);
    }

    const blocks: string[] = [];
    const suspectPages: number[] = [];
    const noTextPages: number[] = [];
    const doc = await openPdf(file);
    try {
      for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
        const page = await doc.getPage(pageNo);
        const pageText = await pageTextContent(page);
        const paragraphs = extractPageParagraphs(page);
        // 每页必出锚点（含无内容页），供编排层按页替换/插入抢救结果
        blocks.push(`<!-- page:${pageNo} -->`);
        blocks.push(...(await paragraphs));
        if (pageText.length < PDF_MIN_CHARS_PER_PAGE) {
          // 无文本层页（混合文档中的扫描页）：交给视觉 agent 转写
          noTextPages.push(pageNo);
        } else if (looksLikeFlatTable(pageText)) {
          suspectPages.push(pageNo);
        }
      }
    } finally {
      await doc.destroy();
    }

    const meta = await baseMeta(file, "pdf-text", this.name);
    meta.pages = doc.numPages;
    const bundle = checkBundle({
      markdown: `${blocks.filter(Boolean).join("\n\n")}\n`,
      assets: [],
      meta,
    });
    // 无文本页与疑似拍平表格页都并入 suspect_pages，由编排层统一交 agent 抢救
    bundle.meta.quality.no_text_pages = noTextPages;
    bundle.meta.quality.suspect_pages = [...new Set([...noTextPages, ...suspectPages])].sort((a, b) => a - b);
    return bundle;
  }
}

/** 页内存在「行内 ≥2 个千分位金额 token」的文本行 → 疑似无边框表格被拍平。 */
function looksLikeFlatTable(text: string): boolean {
  return text.split("\n").some((line) => (line.match(MONEY_TOKEN_RE) ?? []).length >= SUSPECT_MIN_TOKENS_PER_LINE);
}

/**
 * 文本 items 按阅读顺序重组为段落：
 * 按 y 坐标（PDF 自下而上）降序分行，行内按 x 升序；行间垂直间距明显大于行高时另起段落。
 */
async function extractPageParagraphs(page: PDFPageProxy): Promise<string[]> {
  const content = await page.getTextContent();
  const items: TextItem[] = [];
  for (const item of content.items) {
    // 保留纯空格 item：PDF 常用独立空格片段或定位间隙表达词间空格
    if (!("str" in item) || !item.str) {
      continue;
    }
    const height = item.height || Math.abs(item.transform[3] ?? 0) || 10;
    items.push({
      str: item.str,
      x: item.transform[4] ?? 0,
      y: item.transform[5] ?? 0,
      height,
      width: item.width || item.str.length * height * 0.5,
    });
  }
  if (!items.length) {
    return [];
  }

  // 分行：y 差在容差内视为同一行
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: TextItem[][] = [];
  for (const item of items) {
    const line = lines[lines.length - 1];
    const lineY = line?.[0]?.y ?? Number.POSITIVE_INFINITY;
    const tolerance = Math.max(2, item.height * 0.5);
    if (line && Math.abs(item.y - lineY) <= tolerance) {
      line.push(item);
    } else {
      lines.push([item]);
    }
  }
  const lineTexts = lines.map((line) => {
    const sorted = line.sort((a, b) => a.x - b.x);
    let text = "";
    let prev: TextItem | undefined;
    for (const item of sorted) {
      // 相邻片段两侧都没有空格字符、且 x 间隙明显大于字偶距时补一个空格
      // （英文词间常靠间隙而非空格字符表达；中文/日文相邻字形间隙≈0 不受影响）
      if (prev && !/\s$/.test(prev.str) && !/^\s/.test(item.str)) {
        const gap = item.x - (prev.x + prev.width);
        if (gap > Math.max(1, item.height * 0.15)) {
          text += " ";
        }
      }
      text += item.str;
      prev = item;
    }
    return text.split(/\s+/).filter(Boolean).join(" ");
  });

  // 段落：行间垂直间距 > 1.6 倍中位行高则分段
  const heights = items.map((item) => item.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] ?? 10;
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) {
      const gap = Math.abs(lines[i]![0]!.y - lines[i - 1]![0]!.y);
      if (gap > medianHeight * 1.6 && current.length) {
        paragraphs.push(current.join(" "));
        current = [];
      }
    }
    current.push(lineTexts[i]!);
  }
  if (current.length) {
    paragraphs.push(current.join(" "));
  }
  return paragraphs.filter(Boolean);
}

// ------------------------------------------------------------------
// 页面内嵌图像抽取 + PNG 编码（扫描页栅格化的无 canvas 替代）

interface RawImage {
  data: Uint8Array;
  width: number;
  height: number;
  channels: 3 | 4;
}

/** 抽取页面上面积最大的内嵌位图（扫描件通常整页一张大图）；无位图返回 null。 */
export async function extractPageImage(page: PDFPageProxy): Promise<RawImage | null> {
  const ops = await page.getOperatorList();
  const names: string[] = [];
  const inlineImages: RawImage[] = [];
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i]!;
    if (fn === OPS.paintImageXObject) {
      names.push(ops.argsArray[i]![0] as string);
    } else if (fn === OPS.paintInlineImageXObject) {
      const img = toRawImage(ops.argsArray[i]![0]);
      if (img) {
        inlineImages.push(img);
      }
    }
  }
  const candidates: RawImage[] = [...inlineImages];
  for (const name of names) {
    const obj = await new Promise<unknown>((resolve) => page.objs.get(name, resolve));
    const img = toRawImage(obj);
    if (img) {
      candidates.push(img);
    }
  }
  if (!candidates.length) {
    return null;
  }
  return candidates.reduce((best, img) => (img.width * img.height > best.width * best.height ? img : best));
}

function toRawImage(obj: unknown): RawImage | null {
  if (!obj || typeof obj !== "object") {
    return null;
  }
  const img = obj as { data?: Uint8Array | Uint8ClampedArray; width?: number; height?: number; kind?: number };
  if (!img.data || !img.width || !img.height) {
    return null;
  }
  if (img.kind === ImageKind.RGB_24BPP) {
    // pdfjs 给的 data 可能是大 buffer 上的视图（含 stride 对齐），按像素数复制一份
    return {
      data: new Uint8Array(img.data.subarray(0, img.width * img.height * 3)),
      width: img.width,
      height: img.height,
      channels: 3,
    };
  }
  if (img.kind === ImageKind.RGBA_32BPP) {
    return {
      data: new Uint8Array(img.data.subarray(0, img.width * img.height * 4)),
      width: img.width,
      height: img.height,
      channels: 4,
    };
  }
  return null; // GRAYSCALE_1BPP（掩码）等暂不处理
}

/** 打开 PDF 并抽取指定页（1 起始）的内嵌图像，编码为 PNG；失败返回 null。 */
export async function renderPdfPagePng(path: string, pageNo: number): Promise<Buffer | null> {
  try {
    const doc = await openPdf(path);
    try {
      const page = await doc.getPage(pageNo);
      const image = await extractPageImage(page);
      return image ? encodePng(image) : null;
    } finally {
      await doc.destroy();
    }
  } catch {
    return null;
  }
}

// ---- 最小 PNG 编码器（filter 0 + zlib deflate，node 内置实现）----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** RGB/RGBA 原始像素 → PNG Buffer。 */
export function encodePng(image: RawImage): Buffer {
  const { width, height, data, channels } = image;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 3 ? 2 : 6; // color type: RGB / RGBA
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------
// pdf-scan-pipeline（视觉 LLM 逐页转写；模型不可用 → 低置信度进 Review）

export class PdfScanPipeline implements Pipeline {
  readonly name = "pdf-scan-pipeline";

  constructor(private readonly vision: VisionLlm | null = null) {}

  async detect(file: string): Promise<boolean> {
    return (await identifyFormat(file)) === FileFormat.PdfScan;
  }

  async convert(file: string, assetsDir: string): Promise<MarkdownBundle> {
    mkdirSync(assetsDir, { recursive: true });
    if (!(await this.detect(file))) {
      throw new Error(`pdf-scan-pipeline 只处理扫描件 PDF: ${file}`);
    }

    const meta = await baseMeta(file, "pdf-scan", this.name);
    const doc = await openPdf(file);
    meta.pages = doc.numPages;

    if (!this.vision) {
      // 偏离 Python 版（抛 RuntimeError）：按任务约定降级为低置信度进 Review
      await doc.destroy();
      meta.quality.ocr_confidence = 0;
      meta.quality.review_reason = "视觉模型未配置，扫描件 PDF 无法 OCR 转写";
      return checkBundle({ markdown: "", assets: [], meta });
    }

    const blocks: string[] = [];
    const confidences: number[] = [];
    const missingPages: number[] = [];
    try {
      for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
        const page = await doc.getPage(pageNo);
        const image = await extractPageImage(page);
        blocks.push(`<!-- page:${pageNo} -->`);
        if (!image) {
          missingPages.push(pageNo);
          continue;
        }
        const png = encodePng(image);
        try {
          const raw = await visionComplete(
            this.vision,
            { base64: png.toString("base64"), mime: "image/png" },
            SCAN_PAGE_PROMPT,
          );
          const [md, confidence] = parseLlmConfidence(raw);
          blocks.push(md);
          confidences.push(confidence ?? 0);
        } catch {
          // 模型不支持图像 / 调用失败：该页记缺失，整体置信度被拉低进 Review
          missingPages.push(pageNo);
        }
      }
    } finally {
      await doc.destroy();
    }

    meta.quality.ocr_confidence = confidences.length
      ? Math.round((confidences.reduce((sum, c) => sum + c, 0) / confidences.length) * 10000) / 10000
      : 0;
    if (missingPages.length) {
      meta.quality.no_text_pages = missingPages;
      meta.quality.review_reason = `扫描件 PDF 有 ${missingPages.length} 页未能视觉转写（页码: ${missingPages.join(", ")}）`;
    }
    return checkBundle({ markdown: `${blocks.filter(Boolean).join("\n\n")}\n`, assets: [], meta });
  }
}
