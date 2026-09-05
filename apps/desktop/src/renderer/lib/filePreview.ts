import type { FilePreviewKind, LocalFileReference } from "@supbot/shared";

export const MAX_FILE_PREVIEW_BYTES = 20 * 1024 * 1024;

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

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico", "tif", "tiff"]);

const MIME_BY_EXTENSION: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  csv: "text/csv",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  tiff: "image/tiff",
  tif: "image/tiff",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  webp: "image/webp",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
};

function extensionOf(name: string): string {
  const cleanName = name.split(/[?#]/, 1)[0] || name;
  const dot = cleanName.lastIndexOf(".");
  return dot >= 0 ? cleanName.slice(dot + 1).toLowerCase() : "";
}

export function mimeTypeForFile(name: string, provided?: string): string {
  if (provided?.trim()) {
    return provided;
  }
  const extension = extensionOf(name);
  return MIME_BY_EXTENSION[extension] || "application/octet-stream";
}

export function classifyFile(name: string, mimeType?: string): FilePreviewKind {
  const extension = extensionOf(name);
  const mime = mimeTypeForFile(name, mimeType).toLowerCase();
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

export function formatJsonPreview(text: string): { text: string; valid: boolean } {
  try {
    return { text: JSON.stringify(JSON.parse(text), null, 2), valid: true };
  } catch {
    return { text, valid: false };
  }
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function basename(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

function isAbsoluteLocalPath(value: string): boolean {
  return /^\/{1,2}[^/]/.test(value) || /^[a-zA-Z]:/.test(value) || /^\\\\/.test(value);
}

function decodeFileHref(href: string): string | undefined {
  try {
    const url = new URL(href);
    if (url.protocol !== "file:") {
      return undefined;
    }
    const path = decodeURIComponent(url.pathname);
    if (url.hostname) {
      return `//${url.hostname}${path}`;
    }
    return /^[a-zA-Z]:/.test(path.slice(1)) ? path.slice(1) : path;
  } catch {
    return undefined;
  }
}

export function resolveLocalFileHref(
  href: string | undefined,
  knownFiles: LocalFileReference[],
): LocalFileReference | null {
  if (!href?.trim()) {
    return null;
  }
  const rawHref = href.trim();
  if (
    /^[a-z][a-z\d+.-]*:/i.test(rawHref) &&
    !/^[a-zA-Z]:[\\/]/.test(rawHref) &&
    !rawHref.startsWith("file:") &&
    !rawHref.startsWith("sandbox:")
  ) {
    return null;
  }
  const decodedHref =
    decodeFileHref(rawHref) || (rawHref.startsWith("sandbox:") ? rawHref.slice("sandbox:".length) : rawHref);
  let candidate = decodedHref;
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    // Keep the original value when a malformed escape sequence is supplied.
  }
  const normalizedCandidate = normalizePath(candidate);
  const exact = knownFiles.find((file) => normalizePath(file.path) === normalizedCandidate);
  if (exact) {
    return exact;
  }
  const relativeCandidate = candidate.replace(/^\.\//, "");
  const matchingName = knownFiles.find((file) => basename(file.path) === basename(relativeCandidate));
  if (matchingName && !isAbsoluteLocalPath(candidate) && !relativeCandidate.includes("..")) {
    return matchingName;
  }
  if (!isAbsoluteLocalPath(candidate)) {
    return null;
  }
  return {
    path: candidate,
    name: basename(candidate),
  };
}

export function decodeBase64Utf8(value: string): string {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
