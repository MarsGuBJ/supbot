const GENERIC_PASTE_NAMES = new Set(["image.png", "image.jpeg", "image.jpg", "image.gif", "image.webp", "image.bmp"]);

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "application/pdf": "pdf",
  "text/plain": "txt",
};

/** Files carried by a paste event, if the clipboard holds any. */
export function filesFromPasteEvent(event: Pick<ClipboardEvent, "clipboardData">): File[] {
  const files = event.clipboardData?.files;
  return files?.length ? Array.from(files) : [];
}

/**
 * Attachment display name for a pasted file. Screenshot tools hand us generic
 * names like "image.png", so those get a timestamped name with an extension
 * derived from the MIME type; real file names are kept as-is.
 */
export function pastedFileName(file: Pick<File, "name" | "type">, now: Date = new Date()): string {
  const name = file.name.trim();
  if (name && !GENERIC_PASTE_NAMES.has(name.toLowerCase())) {
    return name;
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
  const extension = MIME_EXTENSIONS[file.type] || "bin";
  return `pasted-${stamp}.${extension}`;
}

/** Rename pasted files for display while keeping their bytes and type. */
export function renamePastedFiles(files: File[], now: Date = new Date()): File[] {
  return files.map((file) => {
    const name = pastedFileName(file, now);
    return name === file.name ? file : new File([file], name, { type: file.type });
  });
}
