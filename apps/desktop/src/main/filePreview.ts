import { basename, extname } from "node:path";
import type { FilePreviewKind, FilePreviewResult } from "@supbot/shared";

export const MAX_FILE_PREVIEW_BYTES = 20 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  odp: "application/vnd.oasis.opendocument.presentation",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odt: "application/vnd.oasis.opendocument.text",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
};

const OFFICE_EXTENSIONS = new Set([
  "doc",
  "docx",
  "dot",
  "dotx",
  "xls",
  "xlsx",
  "xlsm",
  "xlt",
  "xltx",
  "ppt",
  "pptx",
  "pps",
  "ppsx",
  "odp",
  "ods",
  "odt",
]);

const PREVIEWABLE_OFFICE_EXTENSIONS = new Set(["docx", "xlsx", "pptx"]);

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "log",
  "csv",
  "tsv",
  "xml",
  "yaml",
  "yml",
  "ini",
  "conf",
  "env",
  "js",
  "jsx",
  "ts",
  "tsx",
  "jsonl",
  "css",
  "scss",
  "less",
  "sql",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "hpp",
  "sh",
  "bat",
  "ps1",
  "toml",
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico", "tif", "tiff"]);

export function mimeTypeForPath(filePath: string): string {
  const extension = extname(filePath).slice(1).toLowerCase();
  return MIME_BY_EXTENSION[extension] || "application/octet-stream";
}

export function classifyFilePath(filePath: string, mimeType = mimeTypeForPath(filePath)): FilePreviewKind {
  const extension = extname(filePath).slice(1).toLowerCase();
  const mime = mimeType.toLowerCase();
  if (extension === "json" || mime === "application/json" || mime.endsWith("+json")) {
    return "json";
  }
  if (extension === "html" || extension === "htm" || mime === "text/html") {
    return "html";
  }
  if (extension === "pdf" || mime === "application/pdf") {
    return "pdf";
  }
  if (IMAGE_EXTENSIONS.has(extension) || mime.startsWith("image/")) {
    return "image";
  }
  if (OFFICE_EXTENSIONS.has(extension)) {
    return "office";
  }
  if (TEXT_EXTENSIONS.has(extension) || mime.startsWith("text/")) {
    return "text";
  }
  return "binary";
}

export function buildFilePreviewResult(
  filePath: string,
  size: number,
  data?: Uint8Array,
  mimeType = mimeTypeForPath(filePath),
): FilePreviewResult {
  const kind = classifyFilePath(filePath, mimeType);
  const extension = extname(filePath).slice(1).toLowerCase();
  const previewable =
    Boolean(data) &&
    kind !== "binary" &&
    (kind !== "office" || PREVIEWABLE_OFFICE_EXTENSIONS.has(extension)) &&
    size <= MAX_FILE_PREVIEW_BYTES;
  return {
    path: filePath,
    name: basename(filePath),
    size,
    mimeType,
    kind,
    previewable,
    tooLarge: size > MAX_FILE_PREVIEW_BYTES,
    contentBase64: previewable && data ? Buffer.from(data).toString("base64") : undefined,
  };
}
