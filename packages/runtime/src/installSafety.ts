import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ToolMarketPackageFile } from "@supbot/shared";

export interface InstallSafetyLimits {
  maxArchiveBytes: number;
  maxExtractedBytes: number;
  maxFileCount: number;
  maxFileBytes: number;
}

export const defaultInstallSafetyLimits: InstallSafetyLimits = {
  maxArchiveBytes: 25 * 1024 * 1024,
  maxExtractedBytes: 10 * 1024 * 1024,
  maxFileCount: 200,
  maxFileBytes: 512 * 1024
};

export interface InstallFileEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface InstallSafetyReport {
  archiveBytes?: number;
  archiveSha256?: string;
  fileCount: number;
  totalBytes: number;
  files: InstallFileEntry[];
}

export class InstallSafetyError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "InstallSafetyError";
  }
}

export function resolveInstallLimits(overrides: Partial<InstallSafetyLimits> = {}): InstallSafetyLimits {
  const env = (key: string): number | undefined => {
    const value = Number(process.env[key]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  return {
    maxArchiveBytes: env("SUPBOT_INSTALL_MAX_ARCHIVE_BYTES") ?? overrides.maxArchiveBytes ?? defaultInstallSafetyLimits.maxArchiveBytes,
    maxExtractedBytes: env("SUPBOT_INSTALL_MAX_EXTRACTED_BYTES") ?? overrides.maxExtractedBytes ?? defaultInstallSafetyLimits.maxExtractedBytes,
    maxFileCount: env("SUPBOT_INSTALL_MAX_FILE_COUNT") ?? overrides.maxFileCount ?? defaultInstallSafetyLimits.maxFileCount,
    maxFileBytes: env("SUPBOT_INSTALL_MAX_FILE_BYTES") ?? overrides.maxFileBytes ?? defaultInstallSafetyLimits.maxFileBytes
  };
}

export function sha256Buffer(buffer: Buffer | Uint8Array | string): string {
  const hash = createHash("sha256");
  hash.update(buffer);
  return hash.digest("hex");
}

export function normalizeInstallRelativePath(raw: string): string {
  if (typeof raw !== "string") {
    throw new InstallSafetyError(`Refusing install path: ${JSON.stringify(raw)}`, "invalid-path");
  }
  if (raw.includes("\0")) {
    throw new InstallSafetyError(`Refusing install path with NUL byte: ${JSON.stringify(raw)}`, "invalid-path");
  }
  const rawForward = raw.replace(/\\/g, "/");
  if (rawForward.startsWith("/") || /^[a-zA-Z]:/.test(rawForward)) {
    throw new InstallSafetyError(`Refusing absolute install path: ${raw}`, "path-traversal");
  }
  const forward = rawForward.replace(/^\.\/+/, "");
  if (!forward) {
    throw new InstallSafetyError(`Refusing empty install path.`, "invalid-path");
  }
  const segments = forward.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "..")) {
    throw new InstallSafetyError(`Refusing install path with '..': ${raw}`, "path-traversal");
  }
  return segments.join("/");
}

export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export interface PackageFileSource {
  path: string;
  content: string | Buffer;
  encoding?: "utf8" | "base64";
}

export function validateAndAuditInstallFiles(
  rootDir: string,
  sources: PackageFileSource[],
  limits: InstallSafetyLimits = resolveInstallLimits()
): { files: ToolMarketPackageFile[]; report: InstallSafetyReport } {
  if (sources.length > limits.maxFileCount) {
    throw new InstallSafetyError(
      `Install has ${sources.length} files which exceeds limit of ${limits.maxFileCount}.`,
      "too-many-files"
    );
  }
  const files: ToolMarketPackageFile[] = [];
  const entries: InstallFileEntry[] = [];
  let totalBytes = 0;
  const seen = new Set<string>();
  for (const source of sources) {
    const normalized = normalizeInstallRelativePath(source.path);
    if (seen.has(normalized.toLowerCase())) {
      throw new InstallSafetyError(`Duplicate install path: ${normalized}`, "duplicate-path");
    }
    seen.add(normalized.toLowerCase());
    const target = resolve(rootDir, normalized);
    if (!isPathInside(rootDir, target)) {
      throw new InstallSafetyError(`Install path escapes root: ${source.path}`, "path-traversal");
    }
    const buffer = source.encoding === "base64"
      ? Buffer.from(source.content as string, "base64")
      : Buffer.isBuffer(source.content) ? source.content : Buffer.from(source.content, "utf8");
    const bytes = buffer.byteLength;
    if (bytes > limits.maxFileBytes) {
      throw new InstallSafetyError(
        `Install file ${normalized} is ${bytes} bytes (limit ${limits.maxFileBytes}).`,
        "file-too-large"
      );
    }
    totalBytes += bytes;
    if (totalBytes > limits.maxExtractedBytes) {
      throw new InstallSafetyError(
        `Install contents exceed ${limits.maxExtractedBytes} bytes total.`,
        "contents-too-large"
      );
    }
    entries.push({ path: normalized, bytes, sha256: sha256Buffer(buffer) });
    const utf8 = buffer.toString("utf8");
    const useBase64 = source.encoding === "base64" || (Buffer.isBuffer(source.content) && !Buffer.from(utf8, "utf8").equals(buffer));
    files.push({
      path: normalized,
      content: useBase64 ? buffer.toString("base64") : utf8,
      encoding: useBase64 ? "base64" : undefined
    });
  }
  return {
    files,
    report: {
      fileCount: files.length,
      totalBytes,
      files: entries
    }
  };
}

export function summarizeSafetyReport(report: InstallSafetyReport): string {
  return `${report.fileCount} file${report.fileCount === 1 ? "" : "s"}, ${report.totalBytes} bytes`;
}

export function shortDigest(value: string, length = 12): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}
