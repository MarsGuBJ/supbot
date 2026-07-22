import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { TaskWorktree, WorktreeDiffSummary } from "@supbot/shared";

interface WorktreeManagerHost {
  dataDir: string;
  rootDir: string;
  randomId(prefix: string): string;
  nowIso(): string;
  onEvent?(event: { message: string; worktree: TaskWorktree; data?: unknown }): void | Promise<void>;
}

export class WorktreeManager {
  private worktrees: TaskWorktree[] = [];

  constructor(private readonly host: WorktreeManagerHost) {}

  setWorktrees(worktrees: TaskWorktree[]): void {
    this.worktrees = [...worktrees];
  }

  list(): TaskWorktree[] {
    return this.worktrees.map(cloneWorktree);
  }

  get(id: string): TaskWorktree | undefined {
    return this.worktrees.find((item) => item.id === id);
  }

  async createForJob(input: { jobId: string; conversationId: string }, rootDir?: string): Promise<TaskWorktree> {
    const baseDir = rootDir || this.host.rootDir;
    const now = this.host.nowIso();
    const id = this.host.randomId("wt");
    const safeJobId = slug(input.jobId);
    const gitStatus = await probeGitWorktreeReady(baseDir);
    if (!gitStatus.ready) {
      const scratchPath = join(this.host.dataDir, "scratch", `${safeJobId}-${id}`);
      await mkdir(scratchPath, { recursive: true });
      const worktree: TaskWorktree = {
        id,
        taskId: input.jobId,
        jobId: input.jobId,
        conversationId: input.conversationId,
        baseRef: "",
        branchName: "",
        path: scratchPath,
        mode: "scratch",
        rootDir: baseDir,
        status: "active",
        diffStatus: "unavailable",
        createdAt: now,
        updatedAt: now
      };
      this.upsert(worktree);
      await this.emit("Worktree active", worktree, { scratch: true, reason: gitStatus.reason });
      return worktree;
    }
    const branchName = `supbot/${safeJobId}-${id}`;
    const path = join(this.host.dataDir, "worktrees", `${safeJobId}-${id}`);
    await mkdir(dirname(path), { recursive: true });
    const baseRef = (await runGit(baseDir, ["rev-parse", "--short", "HEAD"])).stdout.trim() || "HEAD";
    let worktree: TaskWorktree = {
      id,
      taskId: input.jobId,
      jobId: input.jobId,
      conversationId: input.conversationId,
      baseRef,
      branchName,
      path,
      mode: "git",
      rootDir: baseDir,
      status: "creating",
      diffStatus: "unavailable",
      createdAt: now,
      updatedAt: now
    };
    this.upsert(worktree);
    await this.emit("Worktree creating", worktree);
    try {
      await runGit(baseDir, ["worktree", "add", "-b", branchName, path, "HEAD"]);
      worktree = { ...worktree, status: "active", updatedAt: this.host.nowIso() };
      this.upsert(worktree);
      await this.emit("Worktree active", worktree);
      return worktree;
    } catch (error) {
      const wrapped = new WorktreeSetupError(`Could not prepare isolated worktree at ${baseDir}: ${(error as Error).message}`, baseDir);
      worktree = { ...worktree, status: "failed", diffStatus: "unavailable", error: wrapped.message, updatedAt: this.host.nowIso() };
      this.upsert(worktree);
      await this.emit("Worktree failed", worktree, { error: worktree.error });
      throw wrapped;
    }
  }

  async complete(id: string): Promise<TaskWorktree> {
    const current = this.require(id);
    const diffSummary = await this.getDiff(id, false);
    const next: TaskWorktree = {
      ...current,
      status: current.status === "abandoned" ? "abandoned" : "completed",
      diffStatus: diffSummary.changedFiles.length ? "dirty" : "none",
      diffSummary,
      completedAt: this.host.nowIso(),
      updatedAt: this.host.nowIso()
    };
    this.upsert(next);
    await this.emit("Worktree completed", next, { changedFiles: diffSummary.changedFiles.length });
    return next;
  }

  async abandon(id: string, message = "Job canceled"): Promise<TaskWorktree> {
    const current = this.require(id);
    const next: TaskWorktree = {
      ...current,
      status: "abandoned",
      error: message,
      updatedAt: this.host.nowIso()
    };
    this.upsert(next);
    await this.emit("Worktree abandoned", next);
    return next;
  }

  async fail(id: string, error: string): Promise<TaskWorktree> {
    const current = this.require(id);
    const next: TaskWorktree = {
      ...current,
      status: "failed",
      error,
      updatedAt: this.host.nowIso()
    };
    this.upsert(next);
    await this.emit("Worktree failed", next, { error });
    return next;
  }

  async getDiff(id: string, includePatch = true): Promise<WorktreeDiffSummary> {
    const worktree = this.require(id);
    if (worktree.mode === "scratch") {
      const entries = await listScratchFiles(worktree.path);
      return {
        worktreeId: id,
        changedFiles: entries.map((entry) => entry.relative),
        insertions: undefined,
        deletions: undefined,
        summary: entries.length ? `${entries.length} file(s) in scratch workspace` : "No changes",
        patch: undefined
      };
    }
    await runGit(worktree.path, ["add", "-N", "."]).catch(() => undefined);
    const nameStatus = await runGit(worktree.path, ["diff", "--name-only", "HEAD"]);
    const changedFiles = nameStatus.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const shortstat = await runGit(worktree.path, ["diff", "--shortstat", "HEAD"]);
    const patch = includePatch ? (await runGit(worktree.path, ["diff", "HEAD"])).stdout : undefined;
    const counts = parseShortstat(shortstat.stdout);
    return {
      worktreeId: id,
      changedFiles,
      insertions: counts.insertions,
      deletions: counts.deletions,
      summary: shortstat.stdout.trim() || (changedFiles.length ? `${changedFiles.length} changed file(s)` : "No changes"),
      patch
    };
  }

  async apply(id: string): Promise<TaskWorktree> {
    const current = this.require(id);
    if (current.mode === "scratch") {
      const next: TaskWorktree = {
        ...current,
        status: "applied",
        diffStatus: "applied",
        diffSummary: await this.getDiff(id, false),
        appliedAt: this.host.nowIso(),
        updatedAt: this.host.nowIso()
      };
      this.upsert(next);
      await this.emit("Worktree applied", next, { scratch: true });
      await this.cleanupScratchWorkspace(next);
      return next;
    }
    const diff = await this.getDiff(id, true);
    const baseDir = current.rootDir || this.host.rootDir;
    if (diff.patch?.trim()) {
      await runGit(baseDir, ["apply", "-"], diff.patch);
    }
    const next: TaskWorktree = {
      ...current,
      status: "applied",
      diffStatus: "applied",
      diffSummary: { ...diff, patch: undefined },
      appliedAt: this.host.nowIso(),
      updatedAt: this.host.nowIso()
    };
    this.upsert(next);
    await this.emit("Worktree applied", next);
    await this.cleanupGitWorktree(next);
    return next;
  }

  async discard(id: string): Promise<TaskWorktree> {
    const current = this.require(id);
    const next: TaskWorktree = {
      ...current,
      status: "discarded",
      diffStatus: "discarded",
      discardedAt: this.host.nowIso(),
      updatedAt: this.host.nowIso()
    };
    this.upsert(next);
    await this.emit("Worktree discarded", next);
    await this.cleanupGitWorktree(next);
    return next;
  }

  private async cleanupGitWorktree(worktree: TaskWorktree): Promise<void> {
    if (worktree.mode === "scratch") {
      await this.cleanupScratchWorkspace(worktree);
      return;
    }
    const root = resolve(join(this.host.dataDir, "worktrees"));
    const target = resolve(worktree.path);
    if (!target.startsWith(root)) {
      throw new Error(`Refusing to remove worktree outside runtime data dir: ${target}`);
    }
    const baseDir = worktree.rootDir || this.host.rootDir;
    await runGit(baseDir, ["worktree", "remove", "--force", worktree.path]).catch(async () => {
      await rm(worktree.path, { recursive: true, force: true });
      await runGit(baseDir, ["worktree", "prune"]).catch(() => undefined);
    });
    await runGit(baseDir, ["branch", "-D", worktree.branchName]).catch(() => undefined);
  }

  private async cleanupScratchWorkspace(worktree: TaskWorktree): Promise<void> {
    const root = resolve(join(this.host.dataDir, "scratch"));
    const target = resolve(worktree.path);
    if (!target.startsWith(root)) {
      throw new Error(`Refusing to remove scratch workspace outside runtime data dir: ${target}`);
    }
    await rm(worktree.path, { recursive: true, force: true }).catch(() => undefined);
  }

  private require(id: string): TaskWorktree {
    const worktree = this.get(id);
    if (!worktree) {
      throw new Error(`Worktree not found: ${id}`);
    }
    return worktree;
  }

  private upsert(worktree: TaskWorktree): void {
    this.worktrees = [
      cloneWorktree(worktree),
      ...this.worktrees.filter((item) => item.id !== worktree.id)
    ];
  }

  private async emit(message: string, worktree: TaskWorktree, data?: unknown): Promise<void> {
    await this.host.onEvent?.({ message, worktree: cloneWorktree(worktree), data });
  }
}

export async function ensureGitWorktreeReady(rootDir: string): Promise<void> {
  const status = await probeGitWorktreeReady(rootDir);
  if (!status.ready) {
    throw new Error(status.reason || "Git worktree is not ready");
  }
}

export interface GitWorktreeProbe {
  ready: boolean;
  reason?: string;
}

export async function probeGitWorktreeReady(rootDir: string): Promise<GitWorktreeProbe> {
  try {
    await runGit(rootDir, ["rev-parse", "--is-inside-work-tree"]);
  } catch (error) {
    return { ready: false, reason: `Not a Git repository: ${(error as Error).message}` };
  }
  try {
    await runGit(rootDir, ["rev-parse", "--verify", "HEAD"]);
  } catch (error) {
    return { ready: false, reason: `Repository has no commits yet: ${(error as Error).message}` };
  }
  return { ready: true };
}

export class WorktreeSetupError extends Error {
  constructor(message: string, public readonly rootDir: string) {
    super(message);
    this.name = "WorktreeSetupError";
  }
}

async function runGit(cwd: string, args: string[], stdin?: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        reject(new Error((stderr || stdout || `git ${args.join(" ")} failed with exit code ${code}`).trim()));
      }
    });
    if (stdin) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

function parseShortstat(value: string): { insertions?: number; deletions?: number } {
  const insertions = value.match(/(\d+)\s+insertion/)?.[1];
  const deletions = value.match(/(\d+)\s+deletion/)?.[1];
  return {
    insertions: insertions ? Number(insertions) : undefined,
    deletions: deletions ? Number(deletions) : undefined
  };
}

function cloneWorktree(worktree: TaskWorktree): TaskWorktree {
  return {
    ...worktree,
    diffSummary: worktree.diffSummary ? { ...worktree.diffSummary, changedFiles: [...worktree.diffSummary.changedFiles] } : undefined
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "job";
}

async function listScratchFiles(root: string): Promise<Array<{ absolute: string; relative: string }>> {
  const results: Array<{ absolute: string; relative: string }> = [];
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(dir, entry);
      let info;
      try {
        info = await stat(absolute);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        await walk(absolute);
        continue;
      }
      results.push({ absolute, relative: relative(root, absolute).replace(/\\/g, "/") });
    }
  }
  await walk(root);
  return results;
}
