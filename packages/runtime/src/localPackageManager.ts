import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type {
  CapabilityDefinition,
  LocalPackageDependencyPlan,
  LocalPackageDependencyResult,
  LocalPackageInspection,
  LocalPackageInstallResult,
  LocalPackageKind,
  LocalPackageMcpComponent,
  LocalPackageSkillComponent,
  McpServerConfig,
} from "@supbot/shared";
import unzipper from "unzipper";
import { truncate } from "./localTools";
import { pathIsInside } from "./projectManager";

const receiptFileName = "supbot-local-package.json";
const maxZipBytes = 200 * 1024 * 1024;
const maxUncompressedBytes = 1024 * 1024 * 1024;
const maxZipEntries = 20_000;
const dependencyTimeoutMs = 10 * 60 * 1000;

interface LocalPackageManagerHost {
  dataDir: string;
  randomId(prefix: string): string;
  nowIso(): string;
}

interface ExtractedArchive {
  rootPath: string;
  rootPrefix?: string;
}

interface ParsedLocalPackage extends LocalPackageInspection {
  rootPath: string;
  mcpServerConfigs: McpServerConfig[];
  capabilityIds: string[];
}

interface ScanResult {
  packages: LocalPackageInspection[];
  capabilities: CapabilityDefinition[];
  mcpServers: McpServerConfig[];
}

type JsonObject = Record<string, unknown>;

export class LocalPackageManager {
  private readonly pendingBackups = new Map<string, string>();

  constructor(private readonly host: LocalPackageManagerHost) {}

  async inspectArchive(archivePath: string): Promise<LocalPackageInspection> {
    const resolvedArchive = resolve(archivePath);
    const sha256 = await hashFile(resolvedArchive);
    const stagePath = this.stagePath("inspect");
    try {
      const extracted = await this.extractArchive(resolvedArchive, stagePath);
      const parsed = await this.parsePackage(extracted.rootPath, {
        archivePath: resolvedArchive,
        sha256,
        rootPrefix: extracted.rootPrefix,
      });
      return publicInspection(parsed);
    } finally {
      await rm(stagePath, { recursive: true, force: true });
    }
  }

  async installArchive(
    archivePath: string,
    expectedSha256: string,
    signal: AbortSignal,
  ): Promise<LocalPackageInstallResult> {
    const resolvedArchive = resolve(archivePath);
    const sha256 = await hashFile(resolvedArchive);
    if (sha256 !== expectedSha256.trim().toLowerCase()) {
      throw new Error(`Package hash mismatch. Expected ${expectedSha256}, got ${sha256}.`);
    }

    const stagePath = this.stagePath("install");
    let stagingPackagePath: string | undefined;
    let backupPath: string | undefined;
    let finalPath: string | undefined;
    let movedIntoPlace = false;
    try {
      const extracted = await this.extractArchive(resolvedArchive, stagePath);
      const parsed = await this.parsePackage(extracted.rootPath, {
        archivePath: resolvedArchive,
        sha256,
        rootPrefix: extracted.rootPrefix,
      });
      finalPath = parsed.installPath;
      if (!pathIsInside(this.host.dataDir, finalPath)) {
        throw new Error(`Package install path resolved outside app data directory: ${finalPath}`);
      }
      await mkdir(dirname(finalPath), { recursive: true });
      stagingPackagePath = join(
        dirname(finalPath),
        `.installing-${basename(finalPath)}-${this.host.randomId("pkg").replace(/[^a-z0-9_-]/gi, "")}`,
      );
      await rm(stagingPackagePath, { recursive: true, force: true });
      await rename(extracted.rootPath, stagingPackagePath);

      const replaced = await pathExists(finalPath);
      if (replaced) {
        backupPath = join(dirname(finalPath), `.backup-${basename(finalPath)}-${Date.now().toString(36)}`);
        await rename(finalPath, backupPath);
      }
      await rename(stagingPackagePath, finalPath);
      movedIntoPlace = true;

      const installedBeforeDependencies = await this.parsePackage(finalPath, {
        archivePath: resolvedArchive,
        sha256,
        rootPrefix: extracted.rootPrefix,
      });
      const dependencyResults = await runDependencyPlan(installedBeforeDependencies.dependencyPlan, signal);
      const installed = await this.parsePackage(finalPath, {
        archivePath: resolvedArchive,
        sha256,
        rootPrefix: extracted.rootPrefix,
      });
      const installedAt = this.host.nowIso();
      const result: LocalPackageInstallResult = {
        ...publicInspection(installed),
        installedAt,
        replaced,
        dependencyResults,
        capabilityIds: installed.capabilityIds,
        activatedMcpServerIds: installed.mcpServerConfigs.map((server) => server.id),
        skillContext: await buildSkillContext(installed.skills),
      };
      await writeFile(join(finalPath, receiptFileName), `${JSON.stringify(result, null, 2)}\n`, "utf8");
      if (backupPath) {
        this.pendingBackups.set(finalPath, backupPath);
      }
      return result;
    } catch (error) {
      if (movedIntoPlace && finalPath) {
        await rm(finalPath, { recursive: true, force: true });
      }
      if (backupPath && finalPath && (await pathExists(backupPath))) {
        await rename(backupPath, finalPath);
      }
      if (stagingPackagePath) {
        await rm(stagingPackagePath, { recursive: true, force: true });
      }
      throw error;
    } finally {
      await rm(stagePath, { recursive: true, force: true });
    }
  }

  async finalizeInstall(result: Pick<LocalPackageInstallResult, "installPath">): Promise<void> {
    const backupPath = this.pendingBackups.get(result.installPath);
    if (backupPath) {
      await rm(backupPath, { recursive: true, force: true });
      this.pendingBackups.delete(result.installPath);
    }
  }

  async rollbackInstall(result: Pick<LocalPackageInstallResult, "installPath" | "replaced">): Promise<void> {
    const backupPath = this.pendingBackups.get(result.installPath);
    await rm(result.installPath, { recursive: true, force: true });
    if (backupPath && (await pathExists(backupPath))) {
      await rename(backupPath, result.installPath);
    }
    this.pendingBackups.delete(result.installPath);
  }

  async scanInstalledPackages(): Promise<ScanResult> {
    const packages: LocalPackageInspection[] = [];
    const capabilities: CapabilityDefinition[] = [];
    const mcpServers: McpServerConfig[] = [];
    for (const kind of ["skill", "plugin", "mcp"] as const) {
      const root = this.installRoot(kind);
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const packageRoot = join(root, entry.name);
        const receipt = await readReceipt(packageRoot);
        if (!receipt) {
          continue;
        }
        try {
          const parsed = await this.parsePackage(packageRoot, {
            archivePath: receipt.archivePath || packageRoot,
            sha256: receipt.sha256 || "",
            rootPrefix: receipt.rootPrefix,
          });
          packages.push(publicInspection(parsed));
          capabilities.push(...capabilitiesForPackage(parsed));
          mcpServers.push(...parsed.mcpServerConfigs);
        } catch {
          continue;
        }
      }
    }
    return {
      packages,
      capabilities: uniqueCapabilities(capabilities),
      mcpServers,
    };
  }

  private async extractArchive(archivePath: string, stagePath: string): Promise<ExtractedArchive> {
    const info = await stat(archivePath);
    if (!info.isFile()) {
      throw new Error(`Package archive is not a file: ${archivePath}`);
    }
    if (info.size > maxZipBytes) {
      throw new Error(`Package archive exceeds ${formatBytes(maxZipBytes)}.`);
    }
    if (extname(archivePath).toLowerCase() !== ".zip") {
      throw new Error("Package archive must be a .zip file.");
    }
    await mkdir(stagePath, { recursive: true });
    const directory = await unzipper.Open.file(archivePath);
    if (directory.files.length > maxZipEntries) {
      throw new Error(`Package archive has too many entries (${directory.files.length}; max ${maxZipEntries}).`);
    }
    const seen = new Set<string>();
    let declaredUncompressed = 0;
    let actualUncompressed = 0;
    for (const entry of directory.files) {
      const entryPath = normalizeZipEntryPath(entry.path);
      const lowerPath = entryPath.toLowerCase();
      if (seen.has(lowerPath)) {
        throw new Error(`Package archive contains a duplicate path: ${entry.path}`);
      }
      seen.add(lowerPath);
      if (isEncryptedEntry(entry)) {
        throw new Error(`Package archive contains an encrypted entry: ${entry.path}`);
      }
      if (isSymlinkEntry(entry)) {
        throw new Error(`Package archive contains a symbolic link: ${entry.path}`);
      }
      const declaredSize = typeof entry.vars?.uncompressedSize === "number" ? entry.vars.uncompressedSize : 0;
      declaredUncompressed += declaredSize;
      if (declaredUncompressed > maxUncompressedBytes) {
        throw new Error(`Package archive expands beyond ${formatBytes(maxUncompressedBytes)}.`);
      }
      if (entry.type === "Directory") {
        await mkdir(resolveSafe(stagePath, entryPath), { recursive: true });
        continue;
      }
      const targetPath = resolveSafe(stagePath, entryPath);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeZipEntry(entry, targetPath, (byteCount) => {
        actualUncompressed += byteCount;
        if (actualUncompressed > maxUncompressedBytes) {
          throw new Error(`Package archive expands beyond ${formatBytes(maxUncompressedBytes)}.`);
        }
      });
    }
    return findPackageRoot(stagePath);
  }

  private async parsePackage(
    rootPath: string,
    input: { archivePath: string; sha256: string; rootPrefix?: string },
  ): Promise<ParsedLocalPackage> {
    if (await pathExists(join(rootPath, ".codex-plugin", "plugin.json"))) {
      return this.parsePlugin(rootPath, input);
    }
    if (await pathExists(join(rootPath, "SKILL.md"))) {
      return this.parseSkill(rootPath, input);
    }
    if ((await pathExists(join(rootPath, ".mcp.json"))) || (await pathExists(join(rootPath, "supbot-mcp.json")))) {
      return this.parseMcp(rootPath, input);
    }
    throw new Error(
      "Package archive is missing a supported manifest (SKILL.md, .codex-plugin/plugin.json, .mcp.json, or supbot-mcp.json).",
    );
  }

  private async parseSkill(
    rootPath: string,
    input: { archivePath: string; sha256: string; rootPrefix?: string },
  ): Promise<ParsedLocalPackage> {
    const content = await readFile(join(rootPath, "SKILL.md"), "utf8");
    const metadata = parseSkillMetadataStrict(content, "SKILL.md");
    const id = slug(metadata.name);
    const installPath = this.packageInstallPath("skill", id);
    const skill: LocalPackageSkillComponent = {
      id,
      name: metadata.name,
      description: metadata.description,
      path: rootPath,
      capabilityId: `local.skill.${id}`,
    };
    return {
      kind: "skill",
      id,
      name: metadata.name,
      version: metadata.version,
      description: metadata.description,
      sha256: input.sha256,
      archivePath: input.archivePath,
      installPath,
      rootPrefix: input.rootPrefix,
      rootPath,
      skills: [skill],
      mcpServers: [],
      mcpServerConfigs: [],
      dependencyPlan: await dependencyPlan(rootPath),
      warnings: [],
      capabilityIds: [skill.capabilityId],
    };
  }

  private async parsePlugin(
    rootPath: string,
    input: { archivePath: string; sha256: string; rootPrefix?: string },
  ): Promise<ParsedLocalPackage> {
    const manifest = await readJsonObject(join(rootPath, ".codex-plugin", "plugin.json"));
    const name = requiredJsonString(manifest.name, "plugin.json name");
    const id = slug(typeof manifest.id === "string" && manifest.id.trim() ? manifest.id : name);
    const description = requiredJsonString(manifest.description, "plugin.json description");
    const version =
      typeof manifest.version === "string" && manifest.version.trim() ? manifest.version.trim() : undefined;
    const installPath = this.packageInstallPath("plugin", id);
    const warnings: string[] = [];
    const skills = await readPluginSkills(rootPath, id, manifest, warnings);
    const {
      components: mcpServers,
      configs: mcpServerConfigs,
      warnings: mcpWarnings,
    } = await readPackageMcpServers({
      rootPath,
      packageId: id,
      packageKind: "plugin",
      packageName: name,
      packagePath: installPath,
      manifest,
    });
    warnings.push(...mcpWarnings);
    if ((await pathExists(join(rootPath, ".app.json"))) || typeof manifest.apps !== "undefined") {
      warnings.push("Plugin apps are retained on disk but are not activated by this installer.");
    }
    if ((await pathExists(join(rootPath, "hooks"))) || typeof manifest.hooks !== "undefined") {
      warnings.push("Plugin hooks are retained on disk but are not activated by this installer.");
    }
    if (await pathExists(join(rootPath, "scripts"))) {
      warnings.push("Plugin scripts are retained on disk; only skills and local stdio MCP servers are activated.");
    }
    const capabilityIds = [`local.plugin.${id}`, ...skills.map((skill) => skill.capabilityId)];
    return {
      kind: "plugin",
      id,
      name,
      version,
      description,
      sha256: input.sha256,
      archivePath: input.archivePath,
      installPath,
      rootPrefix: input.rootPrefix,
      rootPath,
      skills,
      mcpServers,
      mcpServerConfigs,
      dependencyPlan: await dependencyPlan(rootPath),
      warnings,
      capabilityIds,
    };
  }

  private async parseMcp(
    rootPath: string,
    input: { archivePath: string; sha256: string; rootPrefix?: string },
  ): Promise<ParsedLocalPackage> {
    const id = slug(basename(input.archivePath, extname(input.archivePath)) || basename(rootPath) || "mcp");
    const installPath = this.packageInstallPath("mcp", id);
    const {
      components: mcpServers,
      configs: mcpServerConfigs,
      warnings,
    } = await readPackageMcpServers({
      rootPath,
      packageId: id,
      packageKind: "mcp",
      packageName: basename(rootPath) || id,
      packagePath: installPath,
    });
    if (!mcpServers.length) {
      throw new Error("MCP package does not contain any supported local stdio MCP server configuration.");
    }
    const name = mcpServers[0]?.name || id;
    return {
      kind: "mcp",
      id,
      name,
      description: `Local MCP package ${name}`,
      sha256: input.sha256,
      archivePath: input.archivePath,
      installPath,
      rootPrefix: input.rootPrefix,
      rootPath,
      skills: [],
      mcpServers,
      mcpServerConfigs,
      dependencyPlan: await dependencyPlan(rootPath),
      warnings,
      capabilityIds: [`local.mcp.${id}`],
    };
  }

  private packageInstallPath(kind: LocalPackageKind, id: string): string {
    return join(this.installRoot(kind), id);
  }

  private installRoot(kind: LocalPackageKind): string {
    return join(this.host.dataDir, kind === "skill" ? "skills" : kind === "plugin" ? "plugins" : "mcp");
  }

  private stagePath(label: string): string {
    return join(
      this.host.dataDir,
      "local-package-staging",
      `${label}-${Date.now().toString(36)}-${this.host.randomId("pkg").replace(/[^a-z0-9_-]/gi, "")}`,
    );
  }
}

function publicInspection(parsed: ParsedLocalPackage): LocalPackageInspection {
  return {
    kind: parsed.kind,
    id: parsed.id,
    name: parsed.name,
    version: parsed.version,
    description: parsed.description,
    sha256: parsed.sha256,
    archivePath: parsed.archivePath,
    installPath: parsed.installPath,
    rootPrefix: parsed.rootPrefix,
    skills: parsed.skills.map((skill) => ({ ...skill, path: toInstallPath(parsed, skill.path) })),
    mcpServers: parsed.mcpServers.map((server) => ({
      ...server,
      path: toInstallPath(parsed, server.path),
      command: server.command ? toInstallPath(parsed, server.command) : undefined,
      args: server.args?.map((arg) => toInstallPath(parsed, arg)),
      cwd: server.cwd ? toInstallPath(parsed, server.cwd) : undefined,
    })),
    dependencyPlan: parsed.dependencyPlan.map((step) => ({
      ...step,
      cwd: toInstallPath(parsed, step.cwd),
      command: toInstallPath(parsed, step.command),
    })),
    warnings: parsed.warnings,
  };
}

function toInstallPath(parsed: ParsedLocalPackage, value: string): string {
  if (!isAbsolute(value) || !pathIsInside(parsed.rootPath, value)) {
    return value;
  }
  return resolve(parsed.installPath, relative(parsed.rootPath, value));
}

function capabilitiesForPackage(parsed: ParsedLocalPackage): CapabilityDefinition[] {
  const capabilities: CapabilityDefinition[] = parsed.skills.map((skill) => ({
    id: skill.capabilityId,
    name: skill.name,
    kind: "skill",
    description: skill.description,
    enabled: true,
  }));
  if (parsed.kind === "plugin") {
    capabilities.push({
      id: `local.plugin.${parsed.id}`,
      name: parsed.name,
      kind: "plugin",
      description: parsed.description,
      enabled: true,
    });
  }
  if (parsed.kind === "mcp") {
    capabilities.push({
      id: `local.mcp.${parsed.id}`,
      name: parsed.name,
      kind: "mcp",
      description: parsed.description,
      enabled: true,
    });
  }
  return capabilities;
}

function uniqueCapabilities(capabilities: CapabilityDefinition[]): CapabilityDefinition[] {
  const byId = new Map<string, CapabilityDefinition>();
  for (const capability of capabilities) {
    byId.set(capability.id, capability);
  }
  return [...byId.values()];
}

async function readPluginSkills(
  rootPath: string,
  packageId: string,
  manifest: JsonObject,
  warnings: string[],
): Promise<LocalPackageSkillComponent[]> {
  const roots = new Set<string>();
  roots.add(join(rootPath, "skills"));
  if (typeof manifest.skills === "string" && manifest.skills.trim()) {
    roots.add(resolveManifestPath(rootPath, manifest.skills));
  }
  const skills: LocalPackageSkillComponent[] = [];
  for (const skillsRoot of roots) {
    const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
    if (!entries.length && (await pathExists(join(skillsRoot, "SKILL.md")))) {
      const skill = await readSkillComponent(skillsRoot, packageId, basename(skillsRoot));
      if (skill) {
        skills.push(skill);
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const skillRoot = join(skillsRoot, entry.name);
      const skill = await readSkillComponent(skillRoot, packageId, entry.name);
      if (skill) {
        skills.push(skill);
      }
    }
  }
  if (typeof manifest.skills !== "undefined" && !skills.length) {
    warnings.push("Plugin declared skills, but no valid SKILL.md files were found.");
  }
  return uniqueSkills(skills);
}

async function readSkillComponent(
  rootPath: string,
  packageId: string,
  fallbackId: string,
): Promise<LocalPackageSkillComponent | undefined> {
  try {
    const content = await readFile(join(rootPath, "SKILL.md"), "utf8");
    const metadata = parseSkillMetadataStrict(content, relative(dirname(rootPath), join(rootPath, "SKILL.md")));
    const id = slug(`${packageId}-${metadata.name || fallbackId}`);
    return {
      id,
      name: metadata.name,
      description: metadata.description,
      path: rootPath,
      capabilityId: `local.skill.${id}`,
    };
  } catch {
    return undefined;
  }
}

function uniqueSkills(skills: LocalPackageSkillComponent[]): LocalPackageSkillComponent[] {
  const byPath = new Map<string, LocalPackageSkillComponent>();
  for (const skill of skills) {
    byPath.set(resolve(skill.path).toLowerCase(), skill);
  }
  return [...byPath.values()];
}

async function readPackageMcpServers(input: {
  rootPath: string;
  packageId: string;
  packageKind: LocalPackageKind;
  packageName: string;
  packagePath: string;
  manifest?: JsonObject;
}): Promise<{ components: LocalPackageMcpComponent[]; configs: McpServerConfig[]; warnings: string[] }> {
  const warnings: string[] = [];
  const sources: Array<{ label: string; payload: JsonObject; path: string }> = [];
  const defaultMcpPath = join(input.rootPath, ".mcp.json");
  if (await pathExists(defaultMcpPath)) {
    sources.push({ label: ".mcp.json", payload: await readJsonObject(defaultMcpPath), path: defaultMcpPath });
  }
  const supbotMcpPath = join(input.rootPath, "supbot-mcp.json");
  if (await pathExists(supbotMcpPath)) {
    sources.push({ label: "supbot-mcp.json", payload: await readJsonObject(supbotMcpPath), path: supbotMcpPath });
  }
  if (input.manifest && typeof input.manifest.mcpServers === "string" && input.manifest.mcpServers.trim()) {
    const manifestMcpPath = resolveManifestPath(input.rootPath, input.manifest.mcpServers);
    if (await pathExists(manifestMcpPath)) {
      sources.push({
        label: "plugin.json mcpServers",
        payload: await readJsonObject(manifestMcpPath),
        path: manifestMcpPath,
      });
    } else {
      warnings.push(`Plugin MCP manifest was not found: ${input.manifest.mcpServers}`);
    }
  } else if (input.manifest && isJsonObject(input.manifest.mcpServers)) {
    sources.push({
      label: "plugin.json mcpServers",
      payload: { mcpServers: input.manifest.mcpServers },
      path: join(input.rootPath, ".codex-plugin", "plugin.json"),
    });
  }

  const components: LocalPackageMcpComponent[] = [];
  const configs: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const entries = mcpServerEntries(source.payload);
    if (!entries.length) {
      warnings.push(`${source.label} did not contain mcpServer or mcpServers entries.`);
      continue;
    }
    for (const [key, value] of entries) {
      const componentId = slug(`${input.packageId}-${key}`);
      if (seen.has(componentId)) {
        continue;
      }
      seen.add(componentId);
      const materialized = await materializeMcpServer(value, {
        rootPath: input.rootPath,
        packagePath: input.packagePath,
        packageId: input.packageId,
        packageKind: input.packageKind,
        packageName: input.packageName,
        serverKey: key,
        componentId,
        sourcePath: source.path,
      });
      components.push(materialized.component);
      if (materialized.warning) {
        warnings.push(materialized.warning);
      }
      if (materialized.config) {
        configs.push(materialized.config);
      }
    }
  }
  return { components, configs, warnings };
}

function mcpServerEntries(payload: JsonObject): Array<[string, JsonObject]> {
  if (isJsonObject(payload.mcpServers)) {
    return Object.entries(payload.mcpServers).filter((entry): entry is [string, JsonObject] => isJsonObject(entry[1]));
  }
  if (isJsonObject(payload.mcpServer)) {
    const server = payload.mcpServer;
    const name = typeof server.name === "string" ? server.name : "default";
    return [[name, server]];
  }
  if (isMcpServerLike(payload)) {
    const name = typeof payload.name === "string" ? payload.name : "default";
    return [[name, payload]];
  }
  return [];
}

async function materializeMcpServer(
  server: JsonObject,
  input: {
    rootPath: string;
    packagePath: string;
    packageId: string;
    packageKind: LocalPackageKind;
    packageName: string;
    serverKey: string;
    componentId: string;
    sourcePath: string;
  },
): Promise<{ component: LocalPackageMcpComponent; config?: McpServerConfig; warning?: string }> {
  const name = typeof server.name === "string" && server.name.trim() ? server.name.trim() : input.serverKey;
  const remoteType = String(server.type || server.transport || "").toLowerCase();
  const remoteUrl = typeof server.url === "string" || typeof server.endpoint === "string";
  const componentBase: LocalPackageMcpComponent = {
    id: input.componentId,
    name,
    path: input.sourcePath,
  };
  if (remoteType === "http" || remoteType === "sse" || remoteUrl) {
    const reason = "Only local stdio MCP servers are supported; HTTP/SSE server skipped.";
    return { component: { ...componentBase, skipped: true, reason }, warning: `${name}: ${reason}` };
  }
  if (typeof server.command !== "string" || !server.command.trim()) {
    const reason = "MCP server is missing a local command.";
    return { component: { ...componentBase, skipped: true, reason }, warning: `${name}: ${reason}` };
  }
  const rootPath = resolve(input.rootPath);
  const cwd = resolveInsideRoot(
    rootPath,
    typeof server.cwd === "string" && server.cwd.trim() ? replaceRootPlaceholders(server.cwd, rootPath) : ".",
  );
  const command = await materializeMcpCommand(server.command, rootPath);
  const args = Array.isArray(server.args)
    ? await Promise.all(
        server.args
          .filter((arg): arg is string => typeof arg === "string")
          .map((arg) => materializeMcpArg(arg, rootPath)),
      )
    : [];
  const now = new Date().toISOString();
  const serverId = slug(`localpkg-${input.packageId}-${name}`);
  const config: McpServerConfig = {
    id: serverId,
    name: `${input.packageName}: ${name}`,
    command,
    args,
    cwd,
    env: isJsonObject(server.env) ? stringRecord(server.env) : undefined,
    requestTimeoutMs: normalizeMcpTimeout(server.requestTimeoutMs),
    enabled: server.enabled !== false,
    autoConnect: server.autoConnect !== false,
    createdAt: now,
    updatedAt: now,
    source: {
      kind: "local-package",
      packageId: input.packageId,
      packageKind: input.packageKind,
      packagePath: input.packagePath,
      componentId: input.componentId,
    },
  };
  return {
    component: {
      ...componentBase,
      serverId,
      command,
      args,
      cwd,
    },
    config,
  };
}

async function materializeMcpCommand(command: string, rootPath: string): Promise<string> {
  const trimmed = replaceRootPlaceholders(command.trim(), rootPath);
  if (/^(python|python3|py)$/i.test(trimmed)) {
    const venvPython =
      process.platform === "win32"
        ? join(rootPath, ".venv", "Scripts", "python.exe")
        : join(rootPath, ".venv", "bin", "python");
    if (await pathExists(venvPython)) {
      return venvPython;
    }
  }
  if (isRelativePath(trimmed) || isAbsolute(trimmed)) {
    return resolveInsideRoot(rootPath, trimmed);
  }
  return trimmed;
}

async function materializeMcpArg(arg: string, rootPath: string): Promise<string> {
  const value = replaceRootPlaceholders(arg, rootPath);
  if (isRelativePath(value) || isAbsolute(value)) {
    return resolveInsideRoot(rootPath, value);
  }
  const possibleLocalFile = resolve(rootPath, value);
  if (await pathExists(possibleLocalFile)) {
    return possibleLocalFile;
  }
  return value;
}

function replaceRootPlaceholders(value: string, rootPath: string): string {
  return value
    .replace(/\$\{(?:PLUGIN_ROOT|PACKAGE_ROOT|CODEX_PLUGIN_ROOT|SUPBOT_PACKAGE_ROOT)\}/g, rootPath)
    .replace(/\{(?:installDir|packageRoot|pluginRoot|rootPath)\}/g, rootPath);
}

function resolveManifestPath(rootPath: string, value: string): string {
  return resolveInsideRoot(rootPath, replaceRootPlaceholders(value, rootPath));
}

function resolveInsideRoot(rootPath: string, value: string): string {
  const resolved = isAbsolute(value) ? resolve(value) : resolve(rootPath, value);
  if (!pathIsInside(rootPath, resolved)) {
    throw new Error(`Package path must stay inside ${rootPath}: ${value}`);
  }
  return resolved;
}

function isRelativePath(value: string): boolean {
  return value.startsWith("./") || value.startsWith("../") || value.startsWith(".\\") || value.startsWith("..\\");
}

async function dependencyPlan(rootPath: string): Promise<LocalPackageDependencyPlan[]> {
  const plan: LocalPackageDependencyPlan[] = [];
  if (await pathExists(join(rootPath, "pnpm-lock.yaml"))) {
    plan.push({
      kind: "node",
      manager: "pnpm",
      command: "pnpm",
      args: ["install", "--frozen-lockfile"],
      cwd: rootPath,
      reason: "pnpm-lock.yaml",
    });
  } else if (await pathExists(join(rootPath, "yarn.lock"))) {
    plan.push({
      kind: "node",
      manager: "yarn",
      command: "yarn",
      args: ["install", "--frozen-lockfile"],
      cwd: rootPath,
      reason: "yarn.lock",
    });
  } else if (await pathExists(join(rootPath, "package-lock.json"))) {
    plan.push({
      kind: "node",
      manager: "npm",
      command: "npm",
      args: ["ci"],
      cwd: rootPath,
      reason: "package-lock.json",
    });
  } else if (await pathExists(join(rootPath, "package.json"))) {
    plan.push({
      kind: "node",
      manager: "npm",
      command: "npm",
      args: ["install"],
      cwd: rootPath,
      reason: "package.json",
    });
  }
  if (
    (await pathExists(join(rootPath, "requirements.txt"))) ||
    (await pathExists(join(rootPath, "pyproject.toml"))) ||
    (await pathExists(join(rootPath, "setup.py")))
  ) {
    const python = process.env.PYTHON?.trim() || (process.platform === "win32" ? "python" : "python3");
    const venvPython =
      process.platform === "win32"
        ? join(rootPath, ".venv", "Scripts", "python.exe")
        : join(rootPath, ".venv", "bin", "python");
    plan.push({
      kind: "python",
      manager: "pip",
      command: python,
      args: ["-m", "venv", ".venv"],
      cwd: rootPath,
      reason: "python virtual environment",
    });
    if (await pathExists(join(rootPath, "requirements.txt"))) {
      plan.push({
        kind: "python",
        manager: "pip",
        command: venvPython,
        args: ["-m", "pip", "install", "-r", "requirements.txt"],
        cwd: rootPath,
        reason: "requirements.txt",
      });
    } else {
      plan.push({
        kind: "python",
        manager: "pip",
        command: venvPython,
        args: ["-m", "pip", "install", "."],
        cwd: rootPath,
        reason: (await pathExists(join(rootPath, "pyproject.toml"))) ? "pyproject.toml" : "setup.py",
      });
    }
  }
  return plan;
}

async function runDependencyPlan(
  plan: LocalPackageDependencyPlan[],
  signal: AbortSignal,
): Promise<LocalPackageDependencyResult[]> {
  const results: LocalPackageDependencyResult[] = [];
  for (const step of plan) {
    const result = await runDependencyCommand(step, signal);
    results.push(result);
    if (result.exitCode !== 0) {
      throw new Error(
        `Dependency install failed for ${step.manager}: ${result.stderr || result.stdout || `exit code ${result.exitCode}`}`,
      );
    }
  }
  return results;
}

function runDependencyCommand(
  step: LocalPackageDependencyPlan,
  signal: AbortSignal,
): Promise<LocalPackageDependencyResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(step.command, step.args, {
      cwd: step.cwd,
      env: process.env,
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `Dependency command timed out after ${Math.round(dependencyTimeoutMs / 1000)} seconds: ${step.command} ${step.args.join(" ")}`,
        ),
      );
    }, dependencyTimeoutMs);
    const abort = () => {
      child.kill();
      reject(new Error("Package dependency install canceled."));
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk.toString(), 16_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk.toString(), 16_000);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolvePromise({
        ...step,
        exitCode,
        stdout: stdout.trim() || undefined,
        stderr: stderr.trim() || undefined,
      });
    });
  });
}

async function findPackageRoot(stagePath: string): Promise<ExtractedArchive> {
  if (await hasPackageMarkers(stagePath)) {
    return { rootPath: stagePath };
  }
  const entries = await readdir(stagePath, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  const files = entries.filter((entry) => entry.isFile());
  if (directories.length === 1 && files.length === 0) {
    const candidate = join(stagePath, directories[0]!.name);
    if (await hasPackageMarkers(candidate)) {
      return { rootPath: candidate, rootPrefix: directories[0]!.name };
    }
  }
  throw new Error("Package archive is missing a supported manifest at the root or one wrapping directory below it.");
}

async function hasPackageMarkers(rootPath: string): Promise<boolean> {
  return (
    (await pathExists(join(rootPath, "SKILL.md"))) ||
    (await pathExists(join(rootPath, ".codex-plugin", "plugin.json"))) ||
    (await pathExists(join(rootPath, ".mcp.json"))) ||
    (await pathExists(join(rootPath, "supbot-mcp.json")))
  );
}

function normalizeZipEntryPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || normalized.includes("\0")) {
    throw new Error("Package archive contains an invalid path.");
  }
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error(`Package archive contains an absolute path: ${value}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) {
    throw new Error(`Package archive contains a parent-directory path: ${value}`);
  }
  return normalized;
}

function resolveSafe(rootPath: string, entryPath: string): string {
  const target = resolve(rootPath, entryPath);
  if (!pathIsInside(rootPath, target)) {
    throw new Error(`Package archive path escapes extraction root: ${entryPath}`);
  }
  return target;
}

async function writeZipEntry(
  entry: UnzipperEntry,
  targetPath: string,
  onBytes: (byteCount: number) => void,
): Promise<number> {
  let bytes = 0;
  let limitError: Error | undefined;
  const source = entry.stream();
  source.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    try {
      onBytes(chunk.length);
    } catch (error) {
      limitError = error as Error;
      (source as NodeJS.ReadableStream & { destroy(error?: Error): void }).destroy(limitError);
    }
  });
  await pipeline(source, createWriteStream(targetPath, { flags: "wx" }));
  if (limitError) {
    throw limitError;
  }
  return bytes;
}

function isEncryptedEntry(entry: UnzipperEntry): boolean {
  const flags =
    typeof entry.vars?.flags === "number" ? entry.vars.flags : typeof entry.flags === "number" ? entry.flags : 0;
  return Boolean(flags & 0x1);
}

function isSymlinkEntry(entry: UnzipperEntry): boolean {
  const attrs = typeof entry.externalFileAttributes === "number" ? entry.externalFileAttributes : 0;
  const mode = (attrs >>> 16) & 0o170000;
  return mode === 0o120000;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(filePath: string): Promise<JsonObject> {
  const parsed = JSON.parse(await readFile(filePath, "utf8"));
  if (!isJsonObject(parsed)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  return parsed;
}

async function readReceipt(rootPath: string): Promise<Partial<LocalPackageInstallResult> | undefined> {
  try {
    return JSON.parse(await readFile(join(rootPath, receiptFileName), "utf8")) as Partial<LocalPackageInstallResult>;
  } catch {
    return undefined;
  }
}

function parseSkillMetadataStrict(
  content: string,
  label: string,
): { name: string; description: string; version?: string } {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) {
    throw new Error(`${label} must contain YAML front matter.`);
  }
  const metadata: { name?: string; description?: string; version?: string } = {};
  for (const line of frontmatter[1]!.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const value = stripYamlString(match[2] || "");
    if (match[1]!.toLowerCase() === "name") {
      metadata.name = value;
    }
    if (match[1]!.toLowerCase() === "description") {
      metadata.description = value;
    }
    if (match[1]!.toLowerCase() === "version") {
      metadata.version = value;
    }
  }
  if (!metadata.name || !metadata.description) {
    throw new Error(`${label} must declare non-empty name and description metadata.`);
  }
  return { name: metadata.name, description: metadata.description, version: metadata.version };
}

async function buildSkillContext(skills: LocalPackageSkillComponent[]): Promise<string | undefined> {
  const chunks: string[] = [];
  for (const skill of skills) {
    try {
      const content = await readFile(join(skill.path, "SKILL.md"), "utf8");
      chunks.push(
        [
          `<skill name="${escapeAttribute(skill.name)}" id="${escapeAttribute(skill.capabilityId)}" path="${escapeAttribute(skill.path)}">`,
          skill.description ? `Description: ${skill.description}` : "",
          `Instructions:\n${truncate(content, 8_000)}`,
          "</skill>",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } catch {
      continue;
    }
  }
  return chunks.length ? chunks.join("\n\n") : undefined;
}

function requiredJsonString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function stringRecord(value: JsonObject): Record<string, string> | undefined {
  const entries = Object.entries(value)
    .filter(([key, item]) => key.trim() && typeof item === "string")
    .map(([key, item]) => [key, item as string]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function isMcpServerLike(value: JsonObject): boolean {
  return (
    typeof value.command === "string" ||
    typeof value.url === "string" ||
    typeof value.transport === "string" ||
    typeof value.type === "string"
  );
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeMcpTimeout(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(120_000, Math.max(1_000, Math.round(value)));
}

function stripYamlString(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "package"
  );
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MiB`;
}

function appendLimited(current: string, next: string, maxLength: number): string {
  const value = `${current}${next}`;
  return value.length > maxLength ? value.slice(value.length - maxLength) : value;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

type UnzipperEntry = {
  path: string;
  type: "File" | "Directory" | string;
  externalFileAttributes?: number;
  flags?: number;
  vars?: {
    flags?: number;
    uncompressedSize?: number;
  };
  stream(): NodeJS.ReadableStream;
};
