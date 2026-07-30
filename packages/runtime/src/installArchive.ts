import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { InstallSafetyError, normalizeInstallRelativePath, resolveInstallLimits, validateAndAuditInstallFiles, type InstallSafetyLimits, type PackageFileSource } from "./installSafety";

export interface ExtractedArchive {
  rootDir: string;
  files: PackageFileSource[];
  archiveBytes: number;
}

export interface ExtractArchiveOptions {
  archivePath: string;
  maxBytes?: number;
  limits?: InstallSafetyLimits;
}

export async function extractArchiveToTemp(options: ExtractArchiveOptions): Promise<ExtractedArchive> {
  const limits = options.limits ?? resolveInstallLimits();
  const stats = await stat(options.archivePath);
  const maxBytes = options.maxBytes ?? limits.maxArchiveBytes;
  if (stats.size > maxBytes) {
    throw new InstallSafetyError(
      `Archive is ${stats.size} bytes which exceeds limit of ${maxBytes}.`,
      "archive-too-large"
    );
  }
  const root = await mkdtemp(join(tmpdir(), "supbot-install-"));
  try {
    await runTarExtract(options.archivePath, root);
    const collected = await collectFiles(root, root, limits);
    const audit = validateAndAuditInstallFiles(root, collected, limits);
    if (audit.files.length === 0) {
      throw new InstallSafetyError("Archive did not contain any installable files.", "archive-empty");
    }
    return { rootDir: root, files: collected, archiveBytes: stats.size };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function runTarExtract(archivePath: string, destDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xf", archivePath, "-C", destDir], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => reject(new InstallSafetyError(`Failed to spawn tar: ${error.message}`, "tar-missing")));
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new InstallSafetyError(`tar exited with code ${code}: ${stderr || "(no stderr)"}`, "tar-failed"));
      }
    });
  });
}

async function collectFiles(rootDir: string, current: string, limits: InstallSafetyLimits): Promise<PackageFileSource[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(current, { withFileTypes: true });
  const collected: PackageFileSource[] = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFiles(rootDir, absolute, limits);
      collected.push(...nested);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const relative = absolute.slice(rootDir.length).split(sep).join("/").replace(/^\/+/, "");
    const normalized = normalizeInstallRelativePath(relative);
    const buffer = await readFile(absolute);
    if (buffer.byteLength > limits.maxFileBytes) {
      throw new InstallSafetyError(
        `Extracted file ${normalized} is ${buffer.byteLength} bytes (limit ${limits.maxFileBytes}).`,
        "file-too-large"
      );
    }
    collected.push({ path: normalized, content: buffer });
  }
  return collected;
}