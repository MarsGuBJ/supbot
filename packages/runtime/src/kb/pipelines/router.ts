/**
 * 格式识别与路由：L1 magic bytes → L2 扩展名/内容探测 → L3 内容嗅探。
 * 端口自 k-pipeline app/pipelines/router.py（magic bytes 表直接移植；
 * PyMuPDF 换成 pdfjs-dist，chardet 换成 jschardet）。
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import unzipper from "unzipper";
import type { Pipeline } from "./base";
import { detectEncoding } from "./encoding";
import { isScannedPdf } from "./pdfDoc";
import type { VisionLlm } from "./vision";

// 与 Python router 的公开 API 对齐（__all__ 含 is_scanned_pdf）
export { isScannedPdf, pagesWithoutText } from "./pdfDoc";

export enum FileFormat {
  Docx = "docx",
  DocLegacy = "doc-legacy",
  Xlsx = "xlsx",
  XlsLegacy = "xls-legacy",
  Csv = "csv",
  Txt = "txt",
  Md = "md",
  PdfText = "pdf-text",
  PdfScan = "pdf-scan",
  Image = "image",
  Html = "html",
  Unknown = "unknown",
}

const HEAD_LEN = 512;

const EXT_MAP: Record<string, FileFormat> = {
  ".csv": FileFormat.Csv,
  ".txt": FileFormat.Txt,
  ".text": FileFormat.Txt,
  ".log": FileFormat.Txt,
  ".md": FileFormat.Md,
  ".markdown": FileFormat.Md,
  ".htm": FileFormat.Html,
  ".html": FileFormat.Html,
};

/** 图片 magic bytes（与 Python 版 _IMAGE_SIGNATURES 一致）。 */
const IMAGE_SIGNATURES: Array<[number[], FileFormat]> = [
  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], FileFormat.Image], // PNG
  [[0xff, 0xd8, 0xff], FileFormat.Image], // JPEG
  [[...ascii("GIF87a")], FileFormat.Image],
  [[...ascii("GIF89a")], FileFormat.Image],
];

function ascii(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0));
}

function startsWith(head: Buffer, bytes: number[]): boolean {
  if (head.length < bytes.length) {
    return false;
  }
  return bytes.every((byte, index) => head[index] === byte);
}

function isWebp(head: Buffer): boolean {
  return head.length >= 12 && startsWith(head, ascii("RIFF")) && startsWith(head.subarray(8), ascii("WEBP"));
}

function readHead(path: string): Buffer {
  const buffer = readFileSync(path);
  return buffer.subarray(0, HEAD_LEN);
}

/** OOXML（docx/xlsx/pptx）本质是 zip，读 zip 目录区分。 */
async function classifyZip(path: string): Promise<FileFormat> {
  let names: Set<string>;
  try {
    const dir = await unzipper.Open.file(path);
    names = new Set(dir.files.map((file) => file.path));
  } catch {
    return FileFormat.Unknown;
  }
  if (names.has("word/document.xml")) {
    return FileFormat.Docx;
  }
  if (names.has("xl/workbook.xml")) {
    return FileFormat.Xlsx;
  }
  return FileFormat.Unknown; // pptx 等暂未支持
}

/** 旧 OLE 复合文档（doc/xls），靠扩展名区分；转换策略见 docLegacyPipeline。 */
function classifyOle(path: string): FileFormat {
  const suffix = extname(path).toLowerCase();
  if (suffix === ".doc") {
    return FileFormat.DocLegacy;
  }
  if (suffix === ".xls") {
    return FileFormat.XlsLegacy;
  }
  return FileFormat.Unknown;
}

export interface CsvDialect {
  encoding: string;
  delimiter: string;
}

/** CSV 方言嗅探：jschardet 测编码，首若干行分隔符计数测分隔符（替代 csv.Sniffer）。 */
export function sniffCsv(path: string, sampleBytes = 8192): CsvDialect {
  const raw = readFileSync(path).subarray(0, sampleBytes);
  const encoding = detectEncoding(raw) ?? "utf-8";
  const sample = new TextDecoder(encoding).decode(Buffer.from(raw));
  return { encoding, delimiter: sniffDelimiter(sample) };
}

const CSV_DELIMITER_CANDIDATES = [",", ";", "\t", "|"];

/** 引号感知的分隔符计数（对应 csv.Sniffer 对引号包裹字段的处理）。 */
function countDelimiter(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1; // "" 转义
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && ch === delimiter) {
      count += 1;
    }
  }
  return count;
}

function sniffDelimiter(sample: string): string {
  const lines = sample
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 10);
  let best = ",";
  let bestScore = 0;
  for (const delimiter of CSV_DELIMITER_CANDIDATES) {
    const counts = lines.map((line) => countDelimiter(line, delimiter));
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    // 每行都出现且各行数量一致（csv.Sniffer 的简化端口）；得分取最小出现次数
    const score = min > 0 && min === max ? min : 0;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return best;
}

/** 内容嗅探：BOM 优先；无 BOM 时要求无 NUL 字节且能嗅探出编码。 */
function looksLikeText(path: string): boolean {
  const raw = Buffer.from(readFileSync(path).subarray(0, 8192));
  if (!raw.length) {
    return false;
  }
  const encoding = detectEncoding(raw);
  if (!encoding) {
    return false;
  }
  // UTF-16 等编码天然含 NUL 字节，BOM 存在时直接判文本
  if (encoding.startsWith("utf-16")) {
    return true;
  }
  return !raw.includes(0);
}

/** 三级识别文件格式。 */
export async function identifyFormat(path: string): Promise<FileFormat> {
  const head = readHead(path);

  // L1: magic bytes
  if (startsWith(head, ascii("%PDF"))) {
    return (await isScannedPdf(path)) ? FileFormat.PdfScan : FileFormat.PdfText;
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    return classifyZip(path);
  }
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0])) {
    return classifyOle(path);
  }
  if (isWebp(head)) {
    return FileFormat.Image;
  }
  for (const [signature, format] of IMAGE_SIGNATURES) {
    if (startsWith(head, signature)) {
      return format;
    }
  }

  // L2/L3: 扩展名 + 内容探测兜底
  const suffix = extname(path).toLowerCase();
  if (suffix in EXT_MAP && looksLikeText(path)) {
    return EXT_MAP[suffix]!;
  }
  if (looksLikeText(path)) {
    return FileFormat.Txt;
  }
  return FileFormat.Unknown;
}

/** route() 的可注入依赖：视觉 LLM（pdf-scan / image pipeline 用）。 */
export interface RouteDeps {
  vision?: VisionLlm | null;
}

/** 按识别结果分发到对应 pipeline 实例；unknown 格式抛错。 */
export async function route(path: string, deps: RouteDeps = {}): Promise<Pipeline> {
  // 延迟引用避免模块加载期循环依赖（pipeline 的 detect/convert 运行时回调 router）
  const { DocxPipeline } = await import("./docxPipeline");
  const { TablePipeline } = await import("./tablePipeline");
  const { TextPipeline } = await import("./textPipeline");
  const { PdfTextPipeline, PdfScanPipeline } = await import("./pdfPipeline");
  const { ImagePipeline } = await import("./imagePipeline");
  const { DocLegacyPipeline } = await import("./docLegacyPipeline");

  const format = await identifyFormat(path);
  switch (format) {
    case FileFormat.Docx:
      return new DocxPipeline();
    case FileFormat.Xlsx:
    case FileFormat.Csv:
      return new TablePipeline();
    case FileFormat.Txt:
    case FileFormat.Md:
    case FileFormat.Html:
      return new TextPipeline();
    case FileFormat.PdfText:
      return new PdfTextPipeline();
    case FileFormat.PdfScan:
      return new PdfScanPipeline(deps.vision ?? null);
    case FileFormat.Image:
      return new ImagePipeline(deps.vision ?? null);
    case FileFormat.DocLegacy:
    case FileFormat.XlsLegacy:
      return new DocLegacyPipeline();
    default:
      throw new Error(`格式 ${format} 的 pipeline 尚未实现（留待 fallback-pipeline 阶段）`);
  }
}
