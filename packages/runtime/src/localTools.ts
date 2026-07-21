import { spawn } from "node:child_process";
import { access, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { GeneratedFile } from "@supbot/shared";
import { terminateProcessTree } from "./processTree";
import { resolveProjectWriteTargetReal } from "./projectManager";

const maxReadFileBytes = 1 * 1024 * 1024;
const maxShellStdoutBytes = 64 * 1024;
const maxShellStderrBytes = 32 * 1024;

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
  backupRoot?: string;
  randomId(prefix: string): string;
  nowIso(): string;
  shellTimeoutMs?: number;
}

export async function readLocalFile(filePath: string): Promise<LocalToolResult> {
  const info = await stat(filePath);
  if (info.size > maxReadFileBytes) {
    throw new Error(`ReadFile refused ${filePath}: ${info.size} bytes exceeds the ${maxReadFileBytes} byte limit.`);
  }
  const content = await readFile(filePath, "utf8");
  return {
    text: `Read ${filePath}\n\n${truncate(content, 24_000)}`
  };
}

export async function writeLocalFile(target: string, content: string, host: LocalToolHost): Promise<LocalToolResult> {
  const outputRoot = host.projectRoot || host.workspacePath || join(host.dataDir, "generated-files");
  const outputPath = host.projectRoot && host.allowedWriteRoots?.length
    ? await resolveProjectWriteTargetReal(host.projectRoot, target, host.allowedWriteRoots)
    : resolveLocalWritePath(outputRoot, target);
  if (host.backupRoot && host.projectRoot) {
    await backupExistingFile(host.projectRoot, outputPath, host.backupRoot);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, "utf8");
  const info = await stat(outputPath);
  const generatedFile: GeneratedFile = {
    id: host.randomId("file"),
    name: basename(outputPath),
    path: outputPath,
    size: info.size,
    createdAt: host.nowIso()
  };
  return {
    text: `Wrote ${generatedFile.name} (${generatedFile.size} bytes)\n${outputPath}`,
    generatedFiles: [generatedFile]
  };
}

async function backupExistingFile(projectRoot: string, outputPath: string, backupRoot: string): Promise<void> {
  try {
    await access(outputPath);
  } catch {
    return;
  }
  const relativePath = relative(resolve(projectRoot), resolve(outputPath));
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Backup target must stay inside ${projectRoot}.`);
  }
  const backupPath = resolve(backupRoot, relativePath);
  try {
    await access(backupPath);
    return;
  } catch {
    await mkdir(dirname(backupPath), { recursive: true });
    await copyFile(outputPath, backupPath);
  }
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

export async function runShellCommand(command: string, signal: AbortSignal, timeoutMs = 60_000, cwd?: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const child = spawn(
      isWindows ? "powershell.exe" : "/bin/sh",
      isWindows ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command] : ["-lc", command],
      { windowsHide: true, cwd }
    );
    const stdout = createBoundedOutput(maxShellStdoutBytes);
    const stderr = createBoundedOutput(maxShellStderrBytes);
    let settled = false;
    let terminating = false;
    const settle = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const terminate = (error: Error) => {
      if (terminating || settled) {
        return;
      }
      terminating = true;
      void terminateProcessTree(child).finally(() => settle(() => reject(error)));
    };
    const timeout = setTimeout(() => {
      terminate(new Error(`Shell command timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    timeout.unref?.();
    const onAbort = () => {
      terminate(new Error("Shell command canceled."));
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (chunk) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr.append(chunk);
    });
    child.on("error", (error) => {
      settle(() => reject(error));
    });
    child.on("close", (exitCode) => {
      if (terminating) {
        return;
      }
      settle(() => resolve({ exitCode, stdout: stdout.text(), stderr: stderr.text() }));
    });
  });
}

export async function shellLocalCommand(command: string, signal: AbortSignal, timeoutMs = 60_000, cwd?: string): Promise<LocalToolResult> {
  const result = await runShellCommand(command, signal, timeoutMs, cwd);
  const stdout = truncateWithMarker(result.stdout, 16_000);
  const stderr = truncateWithMarker(result.stderr, 8_000);
  return {
    text: [
      `Command: ${command}`,
      cwd ? `Cwd: ${cwd}` : "",
      `Timeout: ${Math.round(timeoutMs / 1000)}s`,
      `Exit code: ${result.exitCode}`,
      stdout ? `\nstdout:\n${stdout}` : "",
      stderr ? `\nstderr:\n${stderr}` : ""
    ].filter(Boolean).join("\n")
  };
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

function createBoundedOutput(maxBytes: number): { append(chunk: Buffer): void; text(): string } {
  const chunks: Buffer[] = [];
  let keptBytes = 0;
  let droppedBytes = 0;
  return {
    append(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxBytes - keptBytes;
      if (remaining > 0) {
        const kept = buffer.subarray(0, remaining);
        chunks.push(kept);
        keptBytes += kept.length;
      }
      droppedBytes += Math.max(0, buffer.length - Math.max(0, remaining));
    },
    text() {
      const value = Buffer.concat(chunks, keptBytes).toString("utf8");
      return droppedBytes ? `${value}\n\n[output truncated ${droppedBytes} bytes]` : value;
    }
  };
}
