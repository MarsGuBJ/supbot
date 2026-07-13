import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

  async createForJob(input: { jobId: string; conversationId: string; rootDir?: string }): Promise<TaskWorktree> {
    const rootDir = resolve(input.rootDir || this.host.rootDir);
    await ensureGitWorktreeReady(rootDir);
    const now = this.host.nowIso();
    const id = this.host.randomId("wt");
    const safeJobId = slug(input.jobId);
    const branchName = `supbot/${safeJobId}-${id}`;
    const path = join(this.host.dataDir, "worktrees", `${safeJobId}-${id}`);
    await mkdir(dirname(path), { recursive: true });
    const baseRef = (await runGit(rootDir, ["rev-parse", "--short", "HEAD"])).stdout.trim() || "HEAD";
    let worktree: TaskWorktree = {
      id,
      taskId: input.jobId,
      jobId: input.jobId,
      conversationId: input.conversationId,
      baseRef,
      branchName,
      rootPath: rootDir,
      path,
      status: "creating",
      diffStatus: "unavailable",
      createdAt: now,
      updatedAt: now
    };
    this.upsert(worktree);
    await this.emit("Worktree creating", worktree);
    try {
      await runGit(rootDir, ["worktree", "add", "-b", branchName, path, "HEAD"]);
      worktree = { ...worktree, status: "active", updatedAt: this.host.nowIso() };
      this.upsert(worktree);
      await this.emit("Worktree active", worktree);
      return worktree;
    } catch (error) {
      worktree = { ...worktree, status: "failed", diffStatus: "unavailable", error: (error as Error).message, updatedAt: this.host.nowIso() };
      this.upsert(worktree);
      await this.emit("Worktree failed", worktree, { error: worktree.error });
      throw error;
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
    const diff = await this.getDiff(id, true);
    if (diff.patch?.trim()) {
      await runGit(current.rootPath || this.host.rootDir, ["apply", "-"], diff.patch);
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
    const root = resolve(join(this.host.dataDir, "worktrees"));
    const target = resolve(worktree.path);
    if (!target.startsWith(root)) {
      throw new Error(`Refusing to remove worktree outside runtime data dir: ${target}`);
    }
    const rootPath = worktree.rootPath || this.host.rootDir;
    await runGit(rootPath, ["worktree", "remove", "--force", worktree.path]).catch(async () => {
      await rm(worktree.path, { recursive: true, force: true });
      await runGit(rootPath, ["worktree", "prune"]).catch(() => undefined);
    });
    await runGit(rootPath, ["branch", "-D", worktree.branchName]).catch(() => undefined);
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
  await runGit(rootDir, ["rev-parse", "--is-inside-work-tree"]);
  await runGit(rootDir, ["rev-parse", "--verify", "HEAD"]);
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
