import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AgentJob,
  type AgentLoopTrace,
  type CapabilityDefinition,
  type CompactBoundary,
  type Conversation,
  defaultModelConfig,
  defaultPersonality,
  defaultToolMarketConfig,
  type ChatMessage,
  type McpServerConfig,
  type MemorySnapshot,
  type ModelConfig,
  type PendingToolPermission,
  type PermissionMode,
  type PermissionRule,
  type RemoteBridgeAuditRecord,
  type RemoteBridgeConfig,
  type RemoteBridgeSession,
  type PersonalityConfig,
  type QuerySession,
  type RuntimeEventRecord,
  type ScheduledJob,
  type SubagentConfig,
  type TaskWorktree,
  type ToolMarketConfig
} from "@supbot/shared";

export interface RuntimeState {
  agentName: string;
  modelConfig: ModelConfig;
  modelSecret?: string;
  toolMarketConfig: ToolMarketConfig;
  toolMarketSecret?: string;
  toolMarketPasswordSecret?: string;
  personality: PersonalityConfig;
  capabilities: CapabilityDefinition[];
  subagents: SubagentConfig[];
  conversations: Conversation[];
  jobs: AgentJob[];
  scheduledJobs: ScheduledJob[];
  pendingToolPermissions: PendingToolPermission[];
  agentLoopTraces: AgentLoopTrace[];
  querySessions: QuerySession[];
  runtimeEvents: RuntimeEventRecord[];
  compactBoundaries: CompactBoundary[];
  memory: MemorySnapshot;
  permissionMode: PermissionMode;
  permissionRules: PermissionRule[];
  mcpServers: McpServerConfig[];
  worktrees: TaskWorktree[];
  remoteBridgeConfig: RemoteBridgeConfig;
  remoteBridgeSecret?: string;
  remoteBridgeSessions: RemoteBridgeSession[];
  remoteBridgeAudit: RemoteBridgeAuditRecord[];
}

export interface StorageAdapter {
  load(): Promise<RuntimeState>;
  save(state: RuntimeState): Promise<void>;
  getDataDir(): string;
}

const defaultCapabilities: CapabilityDefinition[] = [
  {
    id: "tool.file",
    name: "Local files",
    kind: "tool",
    description: "Attach files, read local files with /read, and create generated files with /write.",
    enabled: true
  },
  {
    id: "tool.shell",
    name: "Shell commands",
    kind: "tool",
    description: "Run local commands with /shell when the user asks the agent to automate work.",
    enabled: true
  },
  {
    id: "tool.scheduler",
    name: "Scheduled tasks",
    kind: "scheduler",
    description: "Create and manage local reminders or recurring prompts.",
    enabled: true
  },
  {
    id: "tool.generated-files",
    name: "Generated files",
    kind: "storage",
    description: "Track artifacts created by local agent jobs.",
    enabled: true
  }
];

const defaultSubagents: SubagentConfig[] = [
  {
    id: "research",
    name: "research",
    description: "Collects context and summarizes options before implementation.",
    systemPrompt: "You are a local research subagent. Be concise, cite local evidence when available, and hand back actionable findings.",
    enabled: true
  },
  {
    id: "builder",
    name: "builder",
    description: "Focuses on implementation plans, code edits, and verification steps.",
    systemPrompt: "You are a local builder subagent. Turn the task into concrete implementation steps and call out risks.",
    enabled: true
  }
];

export function createInitialState(): RuntimeState {
  return {
    agentName: "Supbot Local Agent",
    modelConfig: { ...defaultModelConfig },
    toolMarketConfig: { ...defaultToolMarketConfig },
    personality: { ...defaultPersonality, traits: [...defaultPersonality.traits] },
    capabilities: defaultCapabilities.map((item) => ({ ...item })),
    subagents: defaultSubagents.map((item) => ({ ...item })),
    conversations: [],
    jobs: [],
    scheduledJobs: [],
    pendingToolPermissions: [],
    agentLoopTraces: [],
    querySessions: [],
    runtimeEvents: [],
    compactBoundaries: [],
    memory: { pages: [], facts: [], chunks: [], links: [], candidates: [], recallHistory: [], recallFeedback: [] },
    permissionMode: "default",
    permissionRules: [],
    mcpServers: [],
    worktrees: [],
    remoteBridgeConfig: {
      enabled: false,
      host: "127.0.0.1",
      port: 47831,
      tokenSaved: false
    },
    remoteBridgeSessions: [],
    remoteBridgeAudit: []
  };
}

export function defaultCapabilityDefinitions(): CapabilityDefinition[] {
  return defaultCapabilities.map((item) => ({ ...item }));
}

export class JsonFileStorage implements StorageAdapter {
  private readonly statePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {
    this.statePath = join(dataDir, "state.json");
  }

  getDataDir(): string {
    return this.dataDir;
  }

  async load(): Promise<RuntimeState> {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await readFile(this.statePath, "utf8");
      return normalizeState(JSON.parse(raw) as Partial<RuntimeState>);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const state = createInitialState();
      await this.save(state);
      return state;
    }
  }

  async save(state: RuntimeState): Promise<void> {
    const snapshot = JSON.stringify(state, null, 2);
    this.writeQueue = this.writeQueue.then(() => this.writeSnapshot(snapshot));
    await this.writeQueue;
  }

  private async writeSnapshot(snapshot: string): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${snapshot}\n`, "utf8");
    await rename(tempPath, this.statePath);
  }
}

function normalizeState(input: Partial<RuntimeState>): RuntimeState {
  const initial = createInitialState();
  return {
    agentName: stringOr(input.agentName, initial.agentName),
    modelConfig: {
      ...initial.modelConfig,
      ...(input.modelConfig || {}),
      apiKeySaved: Boolean(input.modelSecret)
    },
    modelSecret: typeof input.modelSecret === "string" ? input.modelSecret : undefined,
    toolMarketConfig: normalizeToolMarketConfig(input, initial.toolMarketConfig),
    toolMarketSecret: typeof input.toolMarketSecret === "string" ? input.toolMarketSecret : undefined,
    toolMarketPasswordSecret: typeof input.toolMarketPasswordSecret === "string" ? input.toolMarketPasswordSecret : undefined,
    personality: {
      ...initial.personality,
      ...(input.personality || {}),
      traits: Array.isArray(input.personality?.traits) ? input.personality.traits.filter((item) => typeof item === "string") : initial.personality.traits
    },
    capabilities: mergeDefaultCapabilities(Array.isArray(input.capabilities) ? input.capabilities : [], initial.capabilities),
    subagents: Array.isArray(input.subagents) ? input.subagents : initial.subagents,
    conversations: Array.isArray(input.conversations) ? input.conversations.map(normalizeConversation) : [],
    jobs: Array.isArray(input.jobs) ? input.jobs : [],
    scheduledJobs: Array.isArray(input.scheduledJobs) ? input.scheduledJobs : [],
    pendingToolPermissions: Array.isArray(input.pendingToolPermissions) ? input.pendingToolPermissions : [],
    agentLoopTraces: Array.isArray(input.agentLoopTraces) ? input.agentLoopTraces : [],
    querySessions: Array.isArray(input.querySessions) ? input.querySessions : [],
    runtimeEvents: Array.isArray(input.runtimeEvents) ? input.runtimeEvents : [],
    compactBoundaries: Array.isArray(input.compactBoundaries) ? input.compactBoundaries : [],
    memory: normalizeMemory(input.memory),
    permissionMode: normalizePermissionMode(input.permissionMode),
    permissionRules: Array.isArray(input.permissionRules) ? input.permissionRules : [],
    mcpServers: Array.isArray(input.mcpServers) ? input.mcpServers.map(normalizeMcpServer).filter(Boolean) as McpServerConfig[] : [],
    worktrees: Array.isArray(input.worktrees) ? input.worktrees.map(normalizeWorktree).filter(Boolean) as TaskWorktree[] : [],
    remoteBridgeConfig: normalizeRemoteBridgeConfig(input.remoteBridgeConfig, Boolean(input.remoteBridgeSecret)),
    remoteBridgeSecret: typeof input.remoteBridgeSecret === "string" ? input.remoteBridgeSecret : undefined,
    remoteBridgeSessions: Array.isArray(input.remoteBridgeSessions) ? input.remoteBridgeSessions.map(normalizeRemoteBridgeSession).filter(Boolean) as RemoteBridgeSession[] : [],
    remoteBridgeAudit: Array.isArray(input.remoteBridgeAudit) ? input.remoteBridgeAudit.map(normalizeRemoteBridgeAudit).filter(Boolean) as RemoteBridgeAuditRecord[] : []
  };
}

function normalizeMemory(value: unknown): MemorySnapshot {
  const memory = value as Partial<MemorySnapshot> | undefined;
  return {
    pages: Array.isArray(memory?.pages) ? memory.pages : [],
    facts: Array.isArray(memory?.facts) ? memory.facts : [],
    chunks: Array.isArray(memory?.chunks) ? memory.chunks : [],
    links: Array.isArray(memory?.links) ? memory.links : [],
    candidates: Array.isArray(memory?.candidates) ? memory.candidates : [],
    recallHistory: Array.isArray(memory?.recallHistory) ? memory.recallHistory : [],
    recallFeedback: Array.isArray(memory?.recallFeedback) ? memory.recallFeedback : []
  };
}

function normalizePermissionMode(value: unknown): PermissionMode {
  return value === "acceptEdits" || value === "bypassPermissions" || value === "plan" || value === "default" ? value : "default";
}

function normalizeToolMarketSource(value: unknown): ToolMarketConfig["source"] {
  return value === "remote" || value === "hybrid" || value === "local" ? value : "local";
}

function normalizeToolMarketConfig(input: Partial<RuntimeState>, initial: ToolMarketConfig): ToolMarketConfig {
  const current: Partial<ToolMarketConfig> = input.toolMarketConfig || {};
  const apiUrl = stringOr(current.apiUrl, initial.apiUrl);
  const accountEmail = typeof current.accountEmail === "string" ? current.accountEmail : initial.accountEmail;
  const hasRemoteConfig = Boolean(apiUrl.trim()) || Boolean(accountEmail.trim()) || Boolean(input.toolMarketSecret) || Boolean(input.toolMarketPasswordSecret);
  const source = normalizeToolMarketSource(current.source);
  return {
    ...initial,
    ...current,
    apiUrl,
    accountEmail,
    source: source === "local" && hasRemoteConfig ? "hybrid" : source,
    accessTokenSaved: Boolean(input.toolMarketSecret),
    passwordSaved: Boolean(input.toolMarketPasswordSecret),
    tokenStorage: input.toolMarketSecret ? current.tokenStorage || "file" : undefined,
    passwordStorage: input.toolMarketPasswordSecret ? current.passwordStorage || "file" : undefined
  };
}

function normalizeConversation(conversation: Conversation): Conversation {
  return {
    ...conversation,
    messages: Array.isArray(conversation.messages) ? conversation.messages.map(normalizeMessage) : []
  };
}

function normalizeMessage(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant" || !message.text.startsWith("Local fallback")) {
    return message;
  }
  const lastPrompt = message.text.match(/Last prompt:\s*([\s\S]*)$/)?.[1]?.trim();
  const subagent = message.text.match(/^Local fallback( via @[A-Za-z0-9_-]+)?:/)?.[1]?.trim();
  return {
    ...message,
    text: [
      `本地回退模式${subagent ? `（${subagent.replace("via ", "")}）` : ""}：尚未配置 API 密钥。`,
      "",
      "你的消息已经保存，本地运行时工作正常。请在“配置 > 模型”中添加 OpenAI-compatible Base URL、API 密钥和模型名，以启用真实模型调用。",
      "",
      `${message.text.split("\n", 1)[0]} Add an OpenAI-compatible base URL, API key, and model in Config > Model to enable real model calls.`,
      lastPrompt ? `\n最近提示词 / Last prompt: ${lastPrompt}` : ""
    ].join("\n")
  };
}

function mergeDefaultCapabilities(current: CapabilityDefinition[], defaults: CapabilityDefinition[]): CapabilityDefinition[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of defaults) {
    byId.set(item.id, { ...item, enabled: byId.get(item.id)?.enabled ?? item.enabled });
  }
  return [...byId.values()];
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function normalizeMcpServer(server: McpServerConfig): McpServerConfig | undefined {
  if (!server || typeof server !== "object") {
    return undefined;
  }
  const now = new Date().toISOString();
  const id = typeof server.id === "string" && server.id.trim() ? server.id : undefined;
  const name = typeof server.name === "string" && server.name.trim() ? server.name.trim() : id;
  const command = typeof server.command === "string" && server.command.trim() ? server.command.trim() : "";
  if (!id || !name || !command) {
    return undefined;
  }
  const env = server.env && typeof server.env === "object" && !Array.isArray(server.env)
    ? Object.fromEntries(Object.entries(server.env).filter(([key, value]) => key.trim() && typeof value === "string"))
    : undefined;
  return {
    id,
    name,
    command,
    args: Array.isArray(server.args) ? server.args.filter((item: unknown): item is string => typeof item === "string") : [],
    cwd: typeof server.cwd === "string" && server.cwd.trim() ? server.cwd.trim() : undefined,
    env,
    requestTimeoutMs: normalizeRequestTimeout(server.requestTimeoutMs),
    enabled: server.enabled !== false,
    autoConnect: Boolean(server.autoConnect),
    createdAt: typeof server.createdAt === "string" ? server.createdAt : now,
    updatedAt: typeof server.updatedAt === "string" ? server.updatedAt : now
  };
}

function normalizeRequestTimeout(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(120_000, Math.max(1_000, Math.round(value)));
}

function normalizeWorktree(value: TaskWorktree): TaskWorktree | undefined {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || typeof value.path !== "string") {
    return undefined;
  }
  const now = new Date().toISOString();
  return {
    ...value,
    taskId: typeof value.taskId === "string" ? value.taskId : value.jobId || value.id,
    jobId: typeof value.jobId === "string" ? value.jobId : value.id,
    conversationId: typeof value.conversationId === "string" ? value.conversationId : "",
    baseRef: typeof value.baseRef === "string" ? value.baseRef : "HEAD",
    branchName: typeof value.branchName === "string" ? value.branchName : `supbot/${value.id}`,
    status: normalizeWorktreeStatus(value.status),
    diffStatus: normalizeDiffStatus(value.diffStatus),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now
  };
}

function normalizeWorktreeStatus(value: unknown): TaskWorktree["status"] {
  return value === "creating" || value === "active" || value === "completed" || value === "applied" || value === "discarded" || value === "failed" || value === "abandoned"
    ? value
    : "active";
}

function normalizeDiffStatus(value: unknown): TaskWorktree["diffStatus"] {
  return value === "none" || value === "dirty" || value === "applied" || value === "discarded" || value === "unavailable" ? value : "unavailable";
}

function normalizeRemoteBridgeConfig(value: unknown, tokenSaved: boolean): RemoteBridgeConfig {
  const input = value as Partial<RemoteBridgeConfig> | undefined;
  const port = typeof input?.port === "number" && Number.isFinite(input.port) ? Math.round(input.port) : 47831;
  return {
    enabled: Boolean(input?.enabled),
    host: typeof input?.host === "string" && input.host.trim() ? input.host.trim() : "127.0.0.1",
    port: port === 0 ? 0 : Math.min(65535, Math.max(1024, port)),
    tokenSaved,
    pairingCode: typeof input?.pairingCode === "string" ? input.pairingCode : undefined,
    updatedAt: typeof input?.updatedAt === "string" ? input.updatedAt : undefined
  };
}

function normalizeRemoteBridgeSession(value: RemoteBridgeSession): RemoteBridgeSession | undefined {
  if (!value || typeof value !== "object" || typeof value.id !== "string") {
    return undefined;
  }
  return {
    id: value.id,
    name: typeof value.name === "string" ? value.name : "Remote session",
    tokenPrefix: typeof value.tokenPrefix === "string" ? value.tokenPrefix : "",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    lastSeenAt: typeof value.lastSeenAt === "string" ? value.lastSeenAt : undefined,
    revokedAt: typeof value.revokedAt === "string" ? value.revokedAt : undefined
  };
}

function normalizeRemoteBridgeAudit(value: RemoteBridgeAuditRecord): RemoteBridgeAuditRecord | undefined {
  if (!value || typeof value !== "object" || typeof value.id !== "string") {
    return undefined;
  }
  return {
    id: value.id,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
    method: typeof value.method === "string" ? value.method : "GET",
    path: typeof value.path === "string" ? value.path : "/",
    ok: Boolean(value.ok),
    statusCode: typeof value.statusCode === "number" ? value.statusCode : 0,
    message: typeof value.message === "string" ? value.message : "",
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
    remoteAddress: typeof value.remoteAddress === "string" ? value.remoteAddress : undefined
  };
}
