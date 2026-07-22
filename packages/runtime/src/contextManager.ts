import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, join, resolve } from "node:path";
import type {
  CapabilityDefinition,
  ChatMessage,
  CompactBoundary,
  PersonalityConfig,
  SubagentConfig,
} from "@supbot/shared";
import type { AdapterMessage } from "./modelAdapter";
import { truncate } from "./localTools";

export interface ContextManagerInput {
  dataDir: string;
  cwd?: string;
  personality: PersonalityConfig;
  subagent?: SubagentConfig;
  capabilities?: CapabilityDefinition[];
  messages: ChatMessage[];
  compactBoundaries: CompactBoundary[];
  memoryBlock?: string;
  systemContext?: Record<string, string>;
  maxConversationMessages?: number;
}

export interface ManagedContext {
  systemPrompt: string;
  messages: AdapterMessage[];
  activeMessages: ChatMessage[];
  compactBoundary?: CompactBoundary;
  projectInstructions?: string;
}

export class ContextManager {
  async build(input: ContextManagerInput): Promise<ManagedContext> {
    const compactBoundary = latestBoundary(input.messages[0]?.conversationId, input.compactBoundaries);
    const activeMessages = projectActiveMessages(input.messages, compactBoundary, input.maxConversationMessages ?? 48);
    const projectInstructions = await readProjectInstructions(input.cwd || process.cwd());
    const installedSkillContext = await readInstalledSkillContext({
      dataDir: input.dataDir,
      capabilities: input.capabilities || [],
      query: latestUserText(activeMessages),
    });
    const systemPrompt = buildSystemPrompt({ ...input, projectInstructions, compactBoundary, installedSkillContext });
    const messages = [
      { role: "system" as const, content: systemPrompt },
      ...activeMessages.filter((message) => message.role !== "system").map(toAdapterMessage),
    ];
    return { systemPrompt, messages, activeMessages, compactBoundary, projectInstructions };
  }
}

function latestBoundary(
  conversationId: string | undefined,
  boundaries: CompactBoundary[],
): CompactBoundary | undefined {
  if (!conversationId) {
    return undefined;
  }
  return boundaries
    .filter((boundary) => boundary.conversationId === conversationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function projectActiveMessages(
  messages: ChatMessage[],
  boundary: CompactBoundary | undefined,
  maxConversationMessages: number,
): ChatMessage[] {
  const postBoundary = boundary?.messageId
    ? messages.slice(Math.max(0, messages.findIndex((message) => message.id === boundary.messageId) + 1))
    : messages;
  return postBoundary.slice(-maxConversationMessages);
}

function buildSystemPrompt(
  input: ContextManagerInput & {
    projectInstructions?: string;
    compactBoundary?: CompactBoundary;
    installedSkillContext?: string;
  },
): string {
  const identity = input.subagent
    ? `You are subagent @${input.subagent.name}. ${input.subagent.systemPrompt}`
    : "You are HBClient, a local desktop agent.";
  const systemContext = Object.entries(input.systemContext || {})
    .filter(([, value]) => value.trim())
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return [
    identity,
    input.personality.summary,
    input.personality.traits.length ? `Traits: ${input.personality.traits.join(", ")}` : "",
    input.personality.instructions,
    toolUseGuidance(),
    "You may call tools when they help. Explain tool outcomes concisely after they complete. If a tool is denied or times out, adjust your answer without repeating the same request.",
    "Prefer reading available project instructions before making assumptions about local workflow.",
    input.compactBoundary ? `<conversation_summary>\n${input.compactBoundary.summary}\n</conversation_summary>` : "",
    input.memoryBlock
      ? `${input.memoryBlock}\nUse memory as user-approved long-term context. Current user instructions override memory when they conflict.`
      : "",
    input.projectInstructions ? `<project_instructions>\n${input.projectInstructions}\n</project_instructions>` : "",
    input.installedSkillContext
      ? `Installed skills below are enabled by the user. When one matches the task, follow the most specific matching SKILL.md. Do not read other skills unless the user asks for that capability or the selected skill explicitly references them. If SKILL.md references another file, use ReadFile on the skill path before relying on that reference. If a referenced package is unavailable, use an equivalent installed library or create a short setup/check step before proceeding.\n<installed_skills>\n${input.installedSkillContext}\n</installed_skills>`
      : "",
    systemContext ? `<system_context>\n${systemContext}\n</system_context>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function toAdapterMessage(message: ChatMessage): AdapterMessage {
  if (message.role === "assistant") {
    return { role: "assistant", content: message.text || null };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId || message.id,
      content: message.text,
    };
  }
  return {
    role: "user",
    content: formatUserMessage(message),
  };
}

function formatUserMessage(message: ChatMessage): string {
  const attachmentText = (message.attachments || [])
    .map((attachment) => `\n[Attachment: ${attachment.name}${attachment.path ? ` at ${attachment.path}` : ""}]`)
    .join("");
  return `${message.text}${attachmentText}`;
}

async function readProjectInstructions(cwd: string): Promise<string | undefined> {
  const files = [join(cwd, "AGENTS.md"), join(cwd, "CLAUDE.md")];
  const chunks: string[] = [];
  for (const file of files) {
    try {
      const content = await readFile(file, "utf8");
      chunks.push(`# ${file}\n${truncate(content, 8_000)}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        chunks.push(`# ${file}\n[Could not read project instruction file: ${(error as Error).message}]`);
      }
    }
  }
  return chunks.length ? chunks.join("\n\n") : undefined;
}

function toolUseGuidance(): string {
  return [
    "Tool calling rules:",
    "- Tool arguments must be exactly one complete JSON object matching the tool schema. Do not send raw text, markdown fences, comments, placeholders, or partial JSON.",
    "- WriteFile paths must be relative workspace paths unless the user explicitly provided an allowed project path. Never use placeholder paths such as /path/to/file.",
    "- WriteFile cannot save directly outside the workspace. To place a final artifact on the Desktop or another external location, create scripts/assets in the workspace, then use Shell to generate or copy the final file to the requested location.",
    "- For large artifacts, prefer a short script plus Shell execution over embedding a large generated file in WriteFile content.",
    "- On Windows, Shell runs PowerShell.",
  ].join("\n");
}

interface SkillContextInput {
  dataDir: string;
  capabilities: CapabilityDefinition[];
  query: string;
  maxSkills?: number;
  maxChars?: number;
}

interface InstalledSkill {
  dirName: string;
  rootPath: string;
  capability?: CapabilityDefinition;
  name: string;
  description: string;
  content: string;
  score: number;
}

async function readInstalledSkillContext(input: SkillContextInput): Promise<string | undefined> {
  const enabledSkills = input.capabilities.filter((capability) => capability.kind === "skill" && capability.enabled);
  if (!enabledSkills.length) {
    return undefined;
  }
  const skillsRoot = join(input.dataDir, "skills");
  let entries: Dirent[];
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const enabledIds = new Set(enabledSkills.map((capability) => capability.id));
  const candidates: InstalledSkill[] = [];
  const skillEntries = await collectInstalledSkillEntries(input.dataDir, entries);
  for (const entry of skillEntries) {
    const rootPath = entry.rootPath;
    const manifestCapabilityId = entry.capabilityId;
    const capability = manifestCapabilityId
      ? enabledSkills.find((item) => item.id === manifestCapabilityId)
      : enabledSkills.find((item) => skillCapabilityMatchesDir(item, entry.dirName));
    if ((manifestCapabilityId && !enabledIds.has(manifestCapabilityId)) || !capability) {
      continue;
    }
    const content = await readSkillFile(rootPath);
    if (!content) {
      continue;
    }
    const metadata = parseSkillMetadata(content);
    const skill: InstalledSkill = {
      dirName: entry.dirName,
      rootPath,
      capability,
      name: metadata.name || capability.name || entry.dirName,
      description: metadata.description || capability.description || "",
      content,
      score: 0,
    };
    skill.score = scoreSkill(skill, input.query);
    candidates.push(skill);
  }
  const pool = candidates.some((skill) => matchesSpecificSkillSignal(skill, input.query))
    ? candidates.filter((skill) => matchesSpecificSkillSignal(skill, input.query))
    : candidates;
  const ranked = pool
    .filter((skill) => skill.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
  const topScore = ranked[0]?.score || 0;
  const selected = ranked
    .filter((skill) => skill.score >= Math.max(4, Math.ceil(topScore / 2)))
    .slice(0, input.maxSkills ?? 2);
  if (!selected.length) {
    return undefined;
  }
  const maxChars = input.maxChars ?? 18_000;
  const perSkillChars = Math.max(1_500, Math.floor(maxChars / selected.length));
  return truncate(selected.map((skill) => formatSkillContext(skill, perSkillChars)).join("\n\n"), maxChars);
}

interface InstalledSkillEntry {
  dirName: string;
  rootPath: string;
  capabilityId?: string;
}

async function collectInstalledSkillEntries(
  dataDir: string,
  skillRootEntries: Dirent[],
): Promise<InstalledSkillEntry[]> {
  const entries: InstalledSkillEntry[] = [];
  const skillsRoot = join(dataDir, "skills");
  for (const entry of skillRootEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const rootPath = join(skillsRoot, entry.name);
    const manifest = await readSkillManifest(rootPath);
    entries.push({ dirName: entry.name, rootPath, capabilityId: manifest.capabilityId });
  }
  const pluginRoot = join(dataDir, "plugins");
  const pluginEntries = await readdir(pluginRoot, { withFileTypes: true }).catch(() => []);
  for (const pluginEntry of pluginEntries) {
    if (!pluginEntry.isDirectory()) {
      continue;
    }
    const receipt = await readPackageReceipt(join(pluginRoot, pluginEntry.name));
    for (const skill of receipt?.skills || []) {
      if (!skill.path || !skill.capabilityId) {
        continue;
      }
      entries.push({
        dirName: basename(skill.path),
        rootPath: resolve(skill.path),
        capabilityId: skill.capabilityId,
      });
    }
  }
  return entries;
}

async function readSkillFile(rootPath: string): Promise<string | undefined> {
  try {
    return await readFile(join(rootPath, "SKILL.md"), "utf8");
  } catch {
    return undefined;
  }
}

async function readSkillManifest(rootPath: string): Promise<{ capabilityId?: string }> {
  try {
    const parsed = JSON.parse(await readFile(join(rootPath, "supbot-local-tool.json"), "utf8")) as {
      deployment?: { capability?: { id?: unknown } };
    };
    const capabilityId = parsed.deployment?.capability?.id;
    return typeof capabilityId === "string" && capabilityId.trim() ? { capabilityId: capabilityId.trim() } : {};
  } catch {
    const receipt = await readPackageReceipt(rootPath);
    const capabilityId = receipt?.skills?.length === 1 ? receipt.skills[0]?.capabilityId : undefined;
    return typeof capabilityId === "string" && capabilityId.trim() ? { capabilityId: capabilityId.trim() } : {};
  }
}

async function readPackageReceipt(
  rootPath: string,
): Promise<{ skills?: Array<{ path?: string; capabilityId?: string }> } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(rootPath, "supbot-local-package.json"), "utf8")) as {
      skills?: Array<{ path?: string; capabilityId?: string }>;
    };
    return parsed && Array.isArray(parsed.skills) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseSkillMetadata(content: string): { name?: string; description?: string } {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) {
    return {};
  }
  const metadata: { name?: string; description?: string } = {};
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1].toLowerCase();
    const value = stripYamlString(match[2]);
    if (key === "name") {
      metadata.name = value;
    }
    if (key === "description") {
      metadata.description = value;
    }
  }
  return metadata;
}

function stripYamlString(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function formatSkillContext(skill: InstalledSkill, maxContentChars: number): string {
  return [
    `<skill name="${escapeAttribute(skill.name)}" id="${escapeAttribute(skill.capability?.id || skill.dirName)}" path="${escapeAttribute(skill.rootPath)}">`,
    skill.description ? `Description: ${skill.description}` : "",
    `Instructions:\n${truncate(skill.content, maxContentChars)}`,
    "</skill>",
  ]
    .filter(Boolean)
    .join("\n");
}

function scoreSkill(skill: InstalledSkill, query: string): number {
  const summaryHaystack = [skill.dirName, skill.name, skill.description].join(" ").toLowerCase();
  const contentHaystack = skill.content.slice(0, 6_000).toLowerCase();
  const haystack = `${summaryHaystack} ${contentHaystack}`;
  const queryText = query.toLowerCase();
  const terms = queryTerms(queryText);
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += term.length >= 4 ? 2 : 1;
    }
  }
  for (const signal of skillSignals()) {
    if (!signal.pattern.test(query)) {
      continue;
    }
    if (signal.keywords.some((keyword) => summaryHaystack.includes(keyword))) {
      score += signal.weight;
    } else if (signal.keywords.some((keyword) => contentHaystack.includes(keyword))) {
      score += Math.max(1, Math.floor(signal.weight / 4));
    }
  }
  return score;
}

function queryTerms(query: string): string[] {
  const terms = query.match(/[a-z0-9][a-z0-9.+#-]{1,}|[\u4e00-\u9fff]{2,}/g) || [];
  return [...new Set(terms.map((term) => term.toLowerCase()))];
}

function skillSignals(): Array<{ pattern: RegExp; keywords: string[]; weight: number }> {
  return [
    {
      pattern: /pptx?|powerpoint|slides?|deck|presentation|幻灯|演示|PPT/i,
      keywords: ["pptx", "powerpoint", "presentation", "slides", "deck"],
      weight: 12,
    },
    { pattern: /docx?|word|文档/i, keywords: ["docx", "word", "document"], weight: 10 },
    { pattern: /xlsx?|excel|spreadsheet|表格/i, keywords: ["xlsx", "excel", "spreadsheet"], weight: 10 },
    { pattern: /pdf|便携式文档/i, keywords: ["pdf"], weight: 10 },
    { pattern: /canvas|画布|海报|poster/i, keywords: ["canvas", "design", "poster"], weight: 8 },
    { pattern: /frontend|react|web|网页|网站|前端/i, keywords: ["frontend", "react", "web"], weight: 8 },
  ];
}

function matchesSpecificSkillSignal(skill: InstalledSkill, query: string): boolean {
  const summary = [skill.dirName, skill.name, skill.description].join(" ").toLowerCase();
  if (/pptx?|powerpoint|slides?|deck|presentation|幻灯|演示|PPT/i.test(query)) {
    return /\bpptx\b|powerpoint/.test(summary);
  }
  if (/docx?|word|文档/i.test(query)) {
    return /\bdocx\b|\bword\b/.test(summary);
  }
  if (/xlsx?|excel|spreadsheet|表格/i.test(query)) {
    return /\bxlsx\b|\bexcel\b|spreadsheet/.test(summary);
  }
  if (/pdf|便携式文档/i.test(query)) {
    return /\bpdf\b/.test(summary);
  }
  return false;
}

function latestUserText(messages: ChatMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.text || "";
}

function skillCapabilityMatchesDir(capability: CapabilityDefinition, dirName: string): boolean {
  const dirSlug = slug(dirName);
  const capabilitySlug = slug(`${capability.id} ${capability.name}`);
  return capabilitySlug.includes(dirSlug) || dirSlug.includes(capabilitySlug);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
