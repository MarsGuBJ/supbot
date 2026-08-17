import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { GeneratedFile } from "@supbot/shared";
import { resolveProjectWriteTarget } from "./projectManager";

export interface LocalToolResult {
  text: string;
  generatedFiles?: GeneratedFile[];
}

export interface LocalToolHost {
  dataDir: string;
  workspacePath?: string;
  cwd?: string;
  worktreeId?: string;
  projectId?: string;
  projectRoot?: string;
  allowedWriteRoots?: string[];
  randomId(prefix: string): string;
  nowIso(): string;
  shellTimeoutMs?: number;
}

// Result-file types that count as downloadable chat artifacts. Intermediate
// scripts (.py/.js/.sh/...) are intentionally excluded.
export const generatedResultFilePattern = /\.(pptx|docx|xlsx|pdf|csv|tsv|txt|md|html?|json|png|jpe?g|webp)\b/i;

const shellCaptureIgnoreDirs = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
]);
const shellCaptureMaxDepth = 5;
const shellCaptureMaxEntries = 4000;
const shellCaptureMaxFiles = 20;

export async function readLocalFile(filePath: string): Promise<LocalToolResult> {
  const content = await readFile(filePath, "utf8");
  return {
    text: `Read ${filePath}\n\n${truncate(content, 24_000)}`,
  };
}

export async function writeLocalFile(target: string, content: string, host: LocalToolHost): Promise<LocalToolResult> {
  const outputRoot = host.projectRoot || host.workspacePath || join(host.dataDir, "generated-files");
  const outputPath =
    host.projectRoot && host.allowedWriteRoots?.length
      ? resolveProjectWriteTarget(host.projectRoot, target, host.allowedWriteRoots)
      : resolveLocalWritePath(outputRoot, target);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, "utf8");
  const info = await stat(outputPath);
  const generatedFile: GeneratedFile = {
    id: host.randomId("file"),
    name: basename(outputPath),
    path: outputPath,
    size: info.size,
    createdAt: host.nowIso(),
  };
  return {
    text: `Wrote ${generatedFile.name} (${generatedFile.size} bytes)\n${outputPath}`,
    generatedFiles: [generatedFile],
  };
}

function resolveLocalWritePath(outputRoot: string, target: string): string {
  const rootPath = resolve(outputRoot);
  const outputPath = isAbsolute(target) ? resolve(target) : resolve(rootPath, target);
  const relativePath = relative(rootPath, outputPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`WriteFile target must stay inside ${rootPath}.`);
  }
  return outputPath;
}

export async function runShellCommand(
  command: string,
  signal: AbortSignal,
  timeoutMs = 60_000,
  cwd?: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const child = spawn(
      isWindows ? "powershell.exe" : "/bin/sh",
      isWindows ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command] : ["-lc", command],
      { windowsHide: true, cwd },
    );
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Shell command timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    const onAbort = () => {
      child.kill();
      reject(new Error("Shell command canceled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

export async function shellLocalCommand(
  command: string,
  signal: AbortSignal,
  timeoutMs = 60_000,
  cwd?: string,
  host?: LocalToolHost,
): Promise<LocalToolResult> {
  const before = host && cwd ? await snapshotShellResultFiles(cwd) : new Map<string, number>();
  const result = await runShellCommand(command, signal, timeoutMs, cwd);
  const generatedFiles = host && cwd ? await diffShellResultFiles(cwd, before, host) : [];
  const stdout = truncateWithMarker(result.stdout, 16_000);
  const stderr = truncateWithMarker(result.stderr, 8_000);
  return {
    text: [
      `Command: ${command}`,
      cwd ? `Cwd: ${cwd}` : "",
      `Timeout: ${Math.round(timeoutMs / 1000)}s`,
      `Exit code: ${result.exitCode}`,
      stdout ? `\nstdout:\n${stdout}` : "",
      stderr ? `\nstderr:\n${stderr}` : "",
      generatedFiles.length ? `\nGenerated files:\n${generatedFiles.map((file) => `- ${file.path}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    generatedFiles: generatedFiles.length ? generatedFiles : undefined,
  };
}

async function snapshotShellResultFiles(root: string): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  await collectShellResultFiles(root, shellCaptureMaxDepth, { remaining: shellCaptureMaxEntries }, files);
  return files;
}

async function collectShellResultFiles(
  root: string,
  depth: number,
  budget: { remaining: number },
  out: Map<string, number>,
): Promise<void> {
  if (depth < 0 || budget.remaining <= 0) {
    return;
  }
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget.remaining <= 0) {
      return;
    }
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      const name = entry.name.toLowerCase();
      if (shellCaptureIgnoreDirs.has(name) || (entry.name.startsWith(".") && name !== ".supbot")) {
        continue;
      }
      await collectShellResultFiles(fullPath, depth - 1, budget, out);
    } else if (entry.isFile() && generatedResultFilePattern.test(entry.name)) {
      budget.remaining -= 1;
      try {
        const info = await stat(fullPath);
        out.set(fullPath, info.mtimeMs);
      } catch {
        // Ignore files that disappear mid-scan.
      }
    }
  }
}

async function diffShellResultFiles(
  root: string,
  before: Map<string, number>,
  host: LocalToolHost,
): Promise<GeneratedFile[]> {
  const after = await snapshotShellResultFiles(root);
  const files: GeneratedFile[] = [];
  for (const [filePath, mtimeMs] of after) {
    const previous = before.get(filePath);
    if (previous !== undefined && previous >= mtimeMs) {
      continue;
    }
    try {
      const info = await stat(filePath);
      files.push({
        id: host.randomId("file"),
        name: basename(filePath),
        path: filePath,
        size: info.size,
        createdAt: host.nowIso(),
      });
    } catch {
      // Ignore files that disappear mid-scan.
    }
    if (files.length >= shellCaptureMaxFiles) {
      break;
    }
  }
  return files;
}

export function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n\n[truncated ${value.length - maxLength} chars]`;
}

function truncateWithMarker(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n\n[output truncated ${value.length - maxLength} chars]`;
}
