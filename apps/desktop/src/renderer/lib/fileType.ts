export type FileTypeIconKind =
  "word" | "excel" | "powerpoint" | "pdf" | "image" | "archive" | "json" | "text" | "unknown";

const WORD_EXTENSIONS = new Set(["doc", "docx", "dot", "dotx", "odt"]);
const EXCEL_EXTENSIONS = new Set(["xls", "xlsx", "xlsm", "xlt", "xltx", "ods", "csv", "tsv"]);
const POWERPOINT_EXTENSIONS = new Set(["ppt", "pptx", "pps", "ppsx", "odp"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico", "tif", "tiff"]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "7z", "rar", "tar", "gz", "bz2", "xz"]);
const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "log",
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

function extensionOf(name: string): string {
  const cleanName = name.split(/[?#]/, 1)[0] || name;
  const dot = cleanName.lastIndexOf(".");
  return dot >= 0 ? cleanName.slice(dot + 1).toLowerCase() : "";
}

export function fileTypeForName(name: string, mimeType?: string): FileTypeIconKind {
  const extension = extensionOf(name);
  const mime = mimeType?.toLowerCase() || "";
  if (WORD_EXTENSIONS.has(extension) || mime.includes("word") || mime.includes("opendocument.text")) {
    return "word";
  }
  if (EXCEL_EXTENSIONS.has(extension) || mime.includes("excel") || mime.includes("spreadsheet")) {
    return "excel";
  }
  if (POWERPOINT_EXTENSIONS.has(extension) || mime.includes("powerpoint") || mime.includes("presentation")) {
    return "powerpoint";
  }
  if (extension === "pdf" || mime === "application/pdf") {
    return "pdf";
  }
  if (IMAGE_EXTENSIONS.has(extension) || mime.startsWith("image/")) {
    return "image";
  }
  if (ARCHIVE_EXTENSIONS.has(extension) || mime.includes("zip") || mime.includes("compressed")) {
    return "archive";
  }
  if (extension === "json" || mime === "application/json" || mime.endsWith("+json")) {
    return "json";
  }
  if (TEXT_EXTENSIONS.has(extension) || mime.startsWith("text/")) {
    return "text";
  }
  return "unknown";
}
