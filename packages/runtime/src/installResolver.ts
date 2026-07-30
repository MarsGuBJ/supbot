import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityDefinition, ToolMarketLocalDeployment, ToolMarketMcpDeployment, ToolMarketPackageFile, ToolMarketProduct, ToolMarketProductType } from "@supbot/shared";
import { extractArchiveToTemp } from "./installArchive";
import { InstallSafetyError, resolveInstallLimits, sha256Buffer, validateAndAuditInstallFiles, type InstallSafetyLimits, type PackageFileSource } from "./installSafety";
import { fetchWithRetry, readResponseBytesLimited } from "./httpClient";
import { detectManifestKind, parseInstallSource, stripArchivePrefix, type ParsedInstallSource } from "./installSource";

export interface ResolveInstallOptions {
  kindHint?: ToolMarketProductType;
  productIdHint?: string;
  limits?: InstallSafetyLimits;
  fetchImpl?: typeof fetchWithRetry;
}

export interface InstallResolution {
  source: ParsedInstallSource;
  product: ToolMarketProduct;
  deployment: ToolMarketLocalDeployment;
  archiveSha256?: string;
  previewSummary: string;
}

const fetchTimeoutMs = 30_000;

export async function resolveInstallSource(rawSource: string, options: ResolveInstallOptions = {}): Promise<InstallResolution> {
  const source = parseInstallSource(rawSource);
  switch (source.kind) {
    case "github":
    case "http-zip":
      return resolveArchiveSource(source, options);
    case "local-zip":
    case "local-dir":
      return resolveLocalSource(source, options);
    case "local-file":
      return resolveSingleFileSource(source, options);
    case "markdown":
      return resolveMarkdownSource(source, options);
    default:
      throw new Error(`Unsupported install source kind: ${(source as ParsedInstallSource).kind}`);
  }
}

async function resolveArchiveSource(source: ParsedInstallSource, options: ResolveInstallOptions): Promise<InstallResolution> {
  const limits = options.limits ?? resolveInstallLimits();
  const url = source.github?.archiveUrl || source.url;
  if (!url) {
    throw new Error("Archive source is missing a download URL.");
  }
  const fetchImpl = options.fetchImpl ?? fetchWithRetry;
  const response = await fetchImpl(url, { method: "GET" }, { timeoutMs: fetchTimeoutMs, idleTimeoutMs: fetchTimeoutMs, maxRetries: 1 });
  if (!response.ok) {
    throw new InstallSafetyError(`Install archive request failed: ${response.status} ${response.statusText}`, "fetch-failed");
  }
  const archiveBuffer = Buffer.from(await readResponseBytesLimited(response, limits.maxArchiveBytes));
  const staging = await mkTempStaging();
  let extractedRoot: string | undefined;
  try {
    const archivePath = join(staging, source.github ? `${source.github.repo}.tar.gz` : "install.zip");
    await writeFile(archivePath, archiveBuffer);
    const archiveSha256 = sha256Buffer(archiveBuffer);
    const extracted = await extractArchiveToTemp({ archivePath, limits });
    extractedRoot = extracted.rootDir;
    const stripped = stripArchivePrefix(extracted.files);
    return buildFromExtractedFiles(source, stripped, limits, archiveSha256, options);
  } finally {
    await Promise.all([
      rm(staging, { recursive: true, force: true }).catch(() => undefined),
      extractedRoot ? rm(extractedRoot, { recursive: true, force: true }).catch(() => undefined) : Promise.resolve()
    ]);
  }
}

async function resolveLocalSource(source: ParsedInstallSource, options: ResolveInstallOptions): Promise<InstallResolution> {
  if (!source.localPath) {
    throw new Error("Local install source is missing a path.");
  }
  const limits = options.limits ?? resolveInstallLimits();
  const { stat } = await import("node:fs/promises");
  const stats = await stat(source.localPath);
  if (stats.isDirectory()) {
    const collected = await collectDirectoryFiles(source.localPath, limits);
    return buildFromExtractedFiles(source, collected, limits, undefined, options);
  }
  if (stats.isFile()) {
    if (/\.(zip|tar|tar\.gz|tgz)$/i.test(source.localPath)) {
      const extracted = await extractArchiveToTemp({ archivePath: source.localPath, limits });
      try {
        const stripped = stripArchivePrefix(extracted.files);
        return await buildFromExtractedFiles(source, stripped, limits, undefined, options);
      } finally {
        await rm(extracted.rootDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    return resolveSingleFileSource({ ...source, kind: "local-file" }, options);
  }
  throw new Error(`Local install source is neither a file nor directory: ${source.localPath}`);
}

async function resolveSingleFileSource(source: ParsedInstallSource, options: ResolveInstallOptions): Promise<InstallResolution> {
  if (!source.localPath) {
    throw new Error("Single-file source is missing a path.");
  }
  const limits = options.limits ?? resolveInstallLimits();
  const buffer = await readFile(source.localPath);
  if (buffer.byteLength > limits.maxFileBytes) {
    throw new InstallSafetyError(
      `Local file is ${buffer.byteLength} bytes which exceeds limit of ${limits.maxFileBytes}.`,
      "file-too-large"
    );
  }
  const fileName = source.localPath.split(/[\\/]/).pop() || "install.md";
  const file: PackageFileSource = { path: fileName, content: buffer };
  if (/\.(md|markdown)$/i.test(fileName)) {
    return resolveMarkdownSource({ ...source, kind: "markdown", markdown: { text: buffer.toString("utf8") } }, options);
  }
  const audit = validateAndAuditInstallFiles(".", [file], limits);
  const productId = options.productIdHint || sanitizeId(fileName.replace(/\.[^.]+$/, ""));
  const product = synthesizeSkillProduct({
    productId,
    name: humanizeName(fileName),
    description: `Locally provided ${fileName}.`,
    files: audit.files
  }, options);
  return { source, product, deployment: product.localDeployment!, archiveSha256: sha256Buffer(buffer), previewSummary: summarizeFiles(audit.files) };
}

async function resolveMarkdownSource(source: ParsedInstallSource, options: ResolveInstallOptions): Promise<InstallResolution> {
  if (!source.markdown) {
    throw new Error("Markdown source is missing body text.");
  }
  const limits = options.limits ?? resolveInstallLimits();
  const parsed = parseMarkdownInstall(source.markdown.text);
  const explicitManifestKind = parsed.manifestKind;
  const resolvedKind: ToolMarketProductType = explicitManifestKind || options.kindHint || parsed.kind;
  const productId = options.productIdHint || sanitizeId(parsed.name);
  const capability: CapabilityDefinition = {
    id: `market.${resolvedKind}.${productId}`,
    name: parsed.name,
    kind: resolvedKind,
    description: parsed.description,
    enabled: true
  };
  const files: ToolMarketPackageFile[] = parsed.files.map((file) => ({
    path: file.path,
    content: file.content,
    encoding: file.encoding
  }));
  const audit = validateAndAuditInstallFiles(".", files, limits);
  const product: ToolMarketProduct = {
    id: productId,
    name: parsed.name,
    type: resolvedKind,
    origin: "local",
    providerName: parsed.providerName || "Prompt install",
    description: parsed.description,
    tags: parsed.tags,
    free: true,
    capability,
    commandTemplates: parsed.commandTemplates,
    localDeployment: {
      kind: resolvedKind,
      files: audit.files,
      capability,
      commandTemplates: parsed.commandTemplates
    }
  };
  return {
    source,
    product,
    deployment: product.localDeployment!,
    archiveSha256: sha256Buffer(Buffer.from(source.markdown.text, "utf8")),
    previewSummary: summarizeFiles(audit.files)
  };
}

async function buildFromExtractedFiles(
  source: ParsedInstallSource,
  files: PackageFileSource[],
  limits: InstallSafetyLimits,
  archiveSha256: string | undefined,
  options: ResolveInstallOptions
): Promise<InstallResolution> {
  const manifest = detectManifestKind(files);
  const inferredKind: ToolMarketProductType = options.kindHint
    || (manifest.detectedType as ToolMarketProductType | undefined)
    || "skill";
  const productId = options.productIdHint
    || sanitizeId(source.github ? `${source.github.owner}-${source.github.repo}` : source.localPath?.split(/[\\/]/).pop() || source.url || "install");
  const capability: CapabilityDefinition = {
    id: `market.${inferredKind}.${productId}`,
    name: humanizeName(productId),
    kind: inferredKind,
    description: source.github ? `Installed from ${source.github.owner}/${source.github.repo}.` : `Installed from ${source.url || source.localPath || "prompt"}.`,
    enabled: true
  };
  const auditHydrated = validateAndAuditInstallFiles(".", files, limits);
  const mcpDeployment = inferredKind === "mcp" ? extractMcpDeployment(auditHydrated.files) : undefined;
  const product: ToolMarketProduct = {
    id: productId,
    name: humanizeName(productId),
    type: inferredKind,
    origin: "local",
    providerName: source.github ? `${source.github.owner}/${source.github.repo}` : "Prompt install",
    description: capability.description,
    tags: source.github ? ["github", inferredKind] : [inferredKind],
    free: true,
    capability,
    localDeployment: {
      kind: inferredKind,
      files: auditHydrated.files,
      capability,
      commandTemplates: [],
      mcpServer: mcpDeployment
    }
  };
  return {
    source,
    product,
    deployment: product.localDeployment!,
    archiveSha256,
    previewSummary: summarizeFiles(auditHydrated.files)
  };
}

async function collectDirectoryFiles(rootPath: string, limits: InstallSafetyLimits): Promise<PackageFileSource[]> {
  const collected: PackageFileSource[] = [];
  await walkDirectory(rootPath, rootPath, collected, limits);
  return collected;
}

async function walkDirectory(root: string, current: string, collected: PackageFileSource[], limits: InstallSafetyLimits): Promise<void> {
  const { readdir, readFile } = await import("node:fs/promises");
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(root, absolute, collected, limits);
      continue;
    }
    if (!entry.isFile()) continue;
    const relative = absolute.slice(root.length).split(/[\\/]/).filter(Boolean).join("/");
    const buffer = await readFile(absolute);
    if (buffer.byteLength > limits.maxFileBytes) {
      throw new InstallSafetyError(
        `Directory contains file ${relative} of ${buffer.byteLength} bytes (limit ${limits.maxFileBytes}).`,
        "file-too-large"
      );
    }
    collected.push({ path: relative, content: buffer });
  }
}

function synthesizeSkillProduct(
  input: { productId: string; name: string; description: string; files: ToolMarketPackageFile[] },
  options: ResolveInstallOptions
): ToolMarketProduct {
  const kind: ToolMarketProductType = options.kindHint || "skill";
  const capability: CapabilityDefinition = {
    id: `market.${kind}.${input.productId}`,
    name: input.name,
    kind,
    description: input.description,
    enabled: true
  };
  return {
    id: input.productId,
    name: input.name,
    type: kind,
    origin: "local",
    providerName: "Prompt install",
    description: input.description,
    tags: [kind],
    free: true,
    capability,
    localDeployment: {
      kind,
      files: input.files,
      capability,
      commandTemplates: []
    }
  };
}

interface ParsedMarkdownInstall {
  name: string;
  kind: ToolMarketProductType;
  manifestKind?: ToolMarketProductType;
  description: string;
  providerName?: string;
  tags: string[];
  files: ToolMarketPackageFile[];
  commandTemplates: string[];
}

function parseMarkdownInstall(text: string): ParsedMarkdownInstall {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed) as Record<string, unknown>;
      return parseJsonInstall(json);
    } catch (error) {
      throw new Error(`Install manifest JSON is invalid: ${(error as Error).message}`);
    }
  }
  const frontMatterMatch = trimmed.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (frontMatterMatch) {
    const frontMatterRaw = frontMatterMatch[1];
    const body = frontMatterMatch[2].trim();
    const parsed = parseYamlFrontMatter(frontMatterRaw);
    const nameValue = typeof parsed.name === "string" ? parsed.name : typeof parsed.id === "string" ? parsed.id : "Unnamed skill";
    const manifestKindValue = typeof parsed.kind === "string" ? parsed.kind as ToolMarketProductType : undefined;
    const kindValue = manifestKindValue || "skill";
    const descriptionValue = typeof parsed.description === "string"
      ? parsed.description
      : body.split("\n")[0]?.slice(0, 200) || "Installed via prompt.";
    const providerValue = typeof parsed.provider === "string"
      ? parsed.provider
      : typeof parsed.author === "string" ? parsed.author : undefined;
    const tagsValue = Array.isArray(parsed.tags) ? parsed.tags.map((tag) => String(tag)) : ["markdown"];
    const templatesValue = Array.isArray(parsed.templates) ? parsed.templates.map((template) => String(template)) : [];
    return {
      name: nameValue,
      kind: kindValue,
      manifestKind: manifestKindValue,
      description: descriptionValue,
      providerName: providerValue,
      tags: tagsValue,
      files: [{ path: "SKILL.md", content: trimmed }],
      commandTemplates: templatesValue
    };
  }
  return {
    name: "Pasted skill",
    kind: "skill",
    description: bodySummary(trimmed),
    tags: ["markdown"],
    files: [{ path: "SKILL.md", content: trimmed }],
    commandTemplates: []
  };
}

function parseJsonInstall(json: Record<string, unknown>): ParsedMarkdownInstall {
  const id = String(json.id || json.name || "install");
  const name = String(json.name || id);
  const kind = (json.kind as ToolMarketProductType) || "skill";
  const files = Array.isArray(json.files) ? json.files.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Install manifest file #${index} is invalid.`);
    }
    const record = entry as Record<string, unknown>;
    const path = String(record.path || `file-${index}.txt`);
    const content = String(record.content ?? "");
    return { path, content, encoding: record.encoding === "base64" ? "base64" : "utf8" } as ToolMarketPackageFile;
  }) : [{ path: "SKILL.md", content: JSON.stringify(json, null, 2) }];
  return {
    name,
    kind,
    description: String(json.description || `Installed via prompt: ${name}`),
    providerName: json.provider as string | undefined,
    tags: Array.isArray(json.tags) ? (json.tags as unknown[]).map(String) : [kind],
    files,
    commandTemplates: Array.isArray(json.commandTemplates) ? (json.commandTemplates as unknown[]).map(String) : []
  };
}

function parseYamlFrontMatter(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (!key) continue;
    if (value.startsWith("[") && value.endsWith("]")) {
      out[key] = value.slice(1, -1).split(",").map((part) => part.trim()).filter(Boolean);
    } else if (value === "true") {
      out[key] = true;
    } else if (value === "false") {
      out[key] = false;
    } else {
      out[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return out;
}

function extractMcpDeployment(files: ToolMarketPackageFile[]): ToolMarketMcpDeployment | undefined {
  const manifest = files.find((file) => /supbot-mcp\.json$/i.test(file.path));
  if (!manifest) return undefined;
  try {
    const parsed = JSON.parse(manifest.content) as Record<string, unknown>;
    const command = String(parsed.command || "").trim();
    if (!command) return undefined;
    return {
      id: typeof parsed.id === "string" ? parsed.id : undefined,
      name: typeof parsed.name === "string" ? parsed.name : command,
      command,
      args: Array.isArray(parsed.args) ? parsed.args.map(String) : [],
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : undefined,
      env: parsed.env && typeof parsed.env === "object" ? parsed.env as Record<string, string> : undefined,
      enabled: parsed.enabled !== false,
      autoConnect: parsed.autoConnect === true,
      requestTimeoutMs: typeof parsed.requestTimeoutMs === "number" ? parsed.requestTimeoutMs : undefined
    };
  } catch {
    return undefined;
  }
}

function summarizeFiles(files: ToolMarketPackageFile[]): string {
  const totalBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
  return `${files.length} file${files.length === 1 ? "" : "s"}, ${totalBytes} bytes`;
}

function sanitizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "install";
}

function humanizeName(value: string): string {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function bodySummary(text: string): string {
  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean);
  return firstLine ? firstLine.slice(0, 200) : "Installed via prompt.";
}

async function mkTempStaging(): Promise<string> {
  const dir = join(tmpdir(), `supbot-install-stage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
