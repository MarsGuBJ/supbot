import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { AutopilotWritePolicy, Project, ProjectCreateInput, ProjectUpdateInput } from "@supbot/shared";

interface ProjectManagerHost {
  randomId(prefix: string): string;
  nowIso(): string;
}

export const projectSandboxRoots = [
  "datasets/raw",
  "datasets/processed",
  "outputs",
  "reports",
  ".supbot/runs"
];

export class ProjectManager {
  constructor(private readonly host: ProjectManagerHost) {}

  async createFromFolder(input: ProjectCreateInput, existing: Project[] = []): Promise<Project> {
    const rootPath = resolve(requiredString(input.rootPath, "Project folder"));
    await mkdir(rootPath, { recursive: true });
    const info = await stat(rootPath);
    if (!info.isDirectory()) {
      throw new Error(`Project path must be a folder: ${rootPath}`);
    }

    const metadataPath = join(rootPath, ".supbot", "project.json");
    const fromDisk = await this.readProjectMetadata(metadataPath);
    const current = existing.find((project) => samePath(project.rootPath, rootPath)) || fromDisk;
    const now = this.host.nowIso();
    const project: Project = {
      id: current?.id || this.host.randomId("project"),
      name: input.name?.trim() || current?.name || basename(rootPath) || "Supbot project",
      rootPath,
      metadataPath,
      status: current?.status || "active",
      createdAt: current?.createdAt || now,
      updatedAt: now,
      lastRunAt: current?.lastRunAt,
      error: current?.error
    };

    await this.ensureProjectFolders(project.rootPath);
    await this.writeProjectMetadata(project);
    return project;
  }

  async update(project: Project, input: ProjectUpdateInput): Promise<Project> {
    const next: Project = {
      ...project,
      name: input.name?.trim() || project.name,
      status: input.status || project.status,
      updatedAt: this.host.nowIso()
    };
    await this.writeProjectMetadata(next);
    return next;
  }

  async ensureProjectFolders(projectRoot: string): Promise<void> {
    await mkdir(join(projectRoot, ".supbot", "runs"), { recursive: true });
    await Promise.all(projectSandboxRoots.map((root) => mkdir(join(projectRoot, root), { recursive: true })));
  }

  defaultWritePolicy(overrides: Partial<AutopilotWritePolicy> = {}): AutopilotWritePolicy {
    return {
      ...overrides,
      mode: "projectSandbox",
      allowNetwork: true,
      allowMcp: true,
      maxRuntimeMinutes: 120,
      maxTasks: 16,
      maxRetries: 1,
      allowedWriteRoots: normalizeAllowedWriteRoots(overrides.allowedWriteRoots || projectSandboxRoots)
    };
  }

  absoluteAllowedWriteRoots(projectRoot: string, policy?: Pick<AutopilotWritePolicy, "allowedWriteRoots">): string[] {
    return normalizeAllowedWriteRoots(policy?.allowedWriteRoots || projectSandboxRoots)
      .map((root) => resolve(projectRoot, root));
  }

  validateProjectPath(project: Project): void {
    const rootPath = resolve(project.rootPath);
    if (!project.metadataPath || !samePath(project.metadataPath, join(rootPath, ".supbot", "project.json"))) {
      throw new Error(`Project metadata path is invalid for ${project.name}.`);
    }
  }

  private async readProjectMetadata(metadataPath: string): Promise<Project | undefined> {
    try {
      const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as Project;
      return parsed && typeof parsed.id === "string" && typeof parsed.rootPath === "string" ? parsed : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private async writeProjectMetadata(project: Project): Promise<void> {
    await mkdir(join(project.rootPath, ".supbot"), { recursive: true });
    await writeFile(project.metadataPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  }
}

export function resolveProjectWriteTarget(projectRoot: string, target: string, allowedWriteRoots: string[]): string {
  const rootPath = resolve(projectRoot);
  const outputPath = isAbsolute(target) ? resolve(target) : resolve(rootPath, target);
  if (!pathIsInside(rootPath, outputPath)) {
    throw new Error(`Project write target must stay inside ${rootPath}.`);
  }
  const allowed = allowedWriteRoots.map((root) => resolve(root));
  if (!allowed.some((allowedRoot) => pathIsInside(allowedRoot, outputPath))) {
    const labels = allowedWriteRoots.map((root) => relative(rootPath, root) || ".").join(", ");
    throw new Error(`Project write target must stay inside an approved project output folder: ${labels}.`);
  }
  return outputPath;
}

export function pathIsInside(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function normalizeAllowedWriteRoots(roots: string[]): string[] {
  const cleaned = roots
    .filter((root) => typeof root === "string" && root.trim())
    .map((root) => root.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, ""));
  return [...new Set(cleaned.length ? cleaned : projectSandboxRoots)];
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value;
}
