import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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

export async function readLocalFile(filePath: string): Promise<LocalToolResult> {
  const content = await readFile(filePath, "utf8");
  return {
    text: `Read ${filePath}\n\n${truncate(content, 24_000)}`
  };
}

export async function writeLocalFile(target: string, content: string, host: LocalToolHost): Promise<LocalToolResult> {
  const outputRoot = host.projectRoot || host.workspacePath || join(host.dataDir, "generated-files");
  const outputPath = host.projectRoot && host.allowedWriteRoots?.length
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
    createdAt: host.nowIso()
  };
  return {
    text: `Wrote ${generatedFile.name} (${generatedFile.size} bytes)\n${outputPath}`,
    generatedFiles: [generatedFile]
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

export async function runShellCommand(command: string, signal: AbortSignal, timeoutMs = 60_000, cwd?: string): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const child = spawn(
      isWindows ? "powershell.exe" : "/bin/sh",
      isWindows ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command] : ["-lc", command],
      { windowsHide: true, cwd }
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
