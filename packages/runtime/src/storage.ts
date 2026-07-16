import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AgentJob,
  type AgentLoopTrace,
  type AutopilotCheckpoint,
  type AutopilotEvent,
  type AutopilotRun,
  type AutopilotTask,
  type CapabilityDefinition,
  type CompactBoundary,
  type Conversation,
  type DataArtifact,
  defaultModelProviderConfig,
  defaultPersonality,
  defaultToolMarketConfig,
  type ChatMessage,
  type IdentityContext,
  type McpServerConfig,
  type MemorySnapshot,
  type ModelConfig,
  type ModelProviderConfig,
  type PendingToolPermission,
  type PermissionMode,
  type PermissionRule,
  type Project,
  type RemoteBridgeAuditRecord,
  type RemoteBridgeConfig,
  type RemoteBridgeSession,
  type ServstationA2AConfig,
  type ServstationA2AOidcConfig,
  type PersonalityConfig,
  type QuerySession,
  type RuntimeEventRecord,
  type ScheduledJob,
  type SubagentConfig,
  type TaskWorktree,
  type ToolMarketConfig
} from "@supbot/shared";

export interface ModelProviderState extends ModelProviderConfig {
  apiKeySecret?: string;
}

export interface RuntimeState {
  agentName: string;
  identityContext?: IdentityContext;
  modelProviders: ModelProviderState[];
  activeModelProviderId?: string;
  toolMarketConfig: ToolMarketConfig;
  toolMarketSecret?: string;
  toolMarketPasswordSecret?: string;
  personality: PersonalityConfig;
  capabilities: CapabilityDefinition[];
  deletedCapabilityIds: string[];
  subagents: SubagentConfig[];
  conversations: Conversation[];
  jobs: AgentJob[];
  scheduledJobs: ScheduledJob[];
  projects: Project[];
  autopilotRuns: AutopilotRun[];
  autopilotTasks: AutopilotTask[];
  autopilotEvents: AutopilotEvent[];
  autopilotCheckpoints: AutopilotCheckpoint[];
  dataArtifacts: DataArtifact[];
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
  servstationA2AConfig: ServstationA2AConfig;
  servstationA2ASecret?: string;
  servstationA2AOidcSecret?: string;
  servstationA2AStaffAgentPasswordSecret?: string;
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
  },
  {
    id: "tool.autopilot-data",
    name: "Project data autopilot",
    kind: "storage",
    description: "Run supervised project-based data collection, processing, analysis, and reporting workflows.",
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
  },
  {
    id: "collector",
    name: "collector",
    description: "Collects source data for project-based data runs.",
    systemPrompt: "You are a local data collection staff-agent. Gather source data into approved project data folders, record sources, and keep outputs concise.",
    enabled: true
  },
  {
    id: "processor",
    name: "processor",
    description: "Cleans, deduplicates, and transforms collected data.",
    systemPrompt: "You are a local data processing staff-agent. Clean, deduplicate, transform, and summarize data artifacts inside approved project output folders.",
    enabled: true
  },
  {
    id: "analyst",
    name: "analyst",
    description: "Analyzes processed data and extracts evidence-backed findings.",
    systemPrompt: "You are a local data analysis staff-agent. Produce evidence-backed findings from project data artifacts and cite the files you used.",
    enabled: true
  },
  {
    id: "reviewer",
    name: "reviewer",
    description: "Reviews data-run outputs against the goal and evidence ledger.",
    systemPrompt: "You are a local data review staff-agent. Check whether the run output satisfies the goal, identify unsupported claims, and request fixes when evidence is missing.",
    enabled: true
  }
];

const legacyLocalBotstationA2A = {
  baseUrl: "http://localhost:8081",
  issuerUrl: "http://localhost:8092"
};

const defaultBotstationA2A = {
  baseUrl: "http://101.227.67.76",
  issuerUrl: "http://101.227.67.76:8092",
  clientId: "botstation-agent-client-web",
  scope: "openid profile email",
  redirectUri: "http://localhost:8800/oauth2/callback",
  userId: "dev-user"
};

export function createInitialState(): RuntimeState {
  const createdAt = new Date().toISOString();
  const defaultProvider: ModelProviderState = {
    ...defaultModelProviderConfig,
    createdAt,
    updatedAt: createdAt
  };
  return {
    agentName: "HBClient Local Agent",
    identityContext: undefined,
    modelProviders: [defaultProvider],
    activeModelProviderId: defaultProvider.id,
    toolMarketConfig: { ...defaultToolMarketConfig },
    personality: { ...defaultPersonality, traits: [...defaultPersonality.traits] },
    capabilities: defaultCapabilities.map((item) => ({ ...item })),
    deletedCapabilityIds: [],
    subagents: defaultSubagents.map((item) => ({ ...item })),
    conversations: [],
    jobs: [],
    scheduledJobs: [],
    projects: [],
    autopilotRuns: [],
    autopilotTasks: [],
    autopilotEvents: [],
    autopilotCheckpoints: [],
    dataArtifacts: [],
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
    remoteBridgeAudit: [],
    servstationA2AConfig: {
      enabled: true,
      baseUrl: defaultBotstationA2A.baseUrl,
      authMode: "oidc",
      bearerTokenSaved: false,
      staffAgentAccount: defaultBotstationA2A.userId,
      staffAgentPasswordSaved: false,
      oidc: {
        issuerUrl: defaultBotstationA2A.issuerUrl,
        clientId: defaultBotstationA2A.clientId,
        scope: defaultBotstationA2A.scope,
        redirectUri: defaultBotstationA2A.redirectUri,
        refreshTokenSaved: false
      },
      reverse: {
        enabled: false,
        status: "disconnected"
      }
    }
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
      const state = normalizeState(JSON.parse(raw) as Partial<RuntimeState>);
      await this.save(state);
      return state;
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

type LegacyRuntimeStateInput = Partial<RuntimeState> & {
  modelConfig?: Partial<ModelConfig>;
  modelSecret?: string;
};

function normalizeState(input: LegacyRuntimeStateInput): RuntimeState {
  const initial = createInitialState();
  const modelProviders = normalizeModelProviders(input, initial.modelProviders);
  const activeModelProviderId = normalizeActiveModelProviderId(input.activeModelProviderId, modelProviders);
  return {
    agentName: stringOr(input.agentName, initial.agentName),
    identityContext: normalizeIdentityContext(input.identityContext),
    modelProviders,
    activeModelProviderId,
    toolMarketConfig: normalizeToolMarketConfig(input, initial.toolMarketConfig),
    toolMarketSecret: typeof input.toolMarketSecret === "string" ? input.toolMarketSecret : undefined,
    toolMarketPasswordSecret: typeof input.toolMarketPasswordSecret === "string" ? input.toolMarketPasswordSecret : undefined,
    personality: {
      ...initial.personality,
      ...(input.personality || {}),
      traits: Array.isArray(input.personality?.traits) ? input.personality.traits.filter((item) => typeof item === "string") : initial.personality.traits
    },
    capabilities: mergeDefaultCapabilities(Array.isArray(input.capabilities) ? input.capabilities : [], initial.capabilities, normalizeDeletedCapabilityIds(input.deletedCapabilityIds)),
    deletedCapabilityIds: normalizeDeletedCapabilityIds(input.deletedCapabilityIds),
    subagents: Array.isArray(input.subagents) ? input.subagents : initial.subagents,
    conversations: Array.isArray(input.conversations) ? input.conversations.map(normalizeConversation) : [],
    jobs: Array.isArray(input.jobs) ? input.jobs.map(normalizeAgentJob) : [],
    scheduledJobs: Array.isArray(input.scheduledJobs) ? input.scheduledJobs.map(normalizeScheduledJob) : [],
    projects: Array.isArray(input.projects) ? input.projects.map(normalizeProject).filter(Boolean) as Project[] : [],
    autopilotRuns: Array.isArray(input.autopilotRuns) ? input.autopilotRuns.map(normalizeAutopilotRun).filter(Boolean) as AutopilotRun[] : [],
    autopilotTasks: Array.isArray(input.autopilotTasks) ? input.autopilotTasks.map(normalizeAutopilotTask).filter(Boolean) as AutopilotTask[] : [],
    autopilotEvents: Array.isArray(input.autopilotEvents) ? input.autopilotEvents.map(normalizeAutopilotEvent).filter(Boolean) as AutopilotEvent[] : [],
    autopilotCheckpoints: Array.isArray(input.autopilotCheckpoints) ? input.autopilotCheckpoints.map(normalizeAutopilotCheckpoint).filter(Boolean) as AutopilotCheckpoint[] : [],
    dataArtifacts: Array.isArray(input.dataArtifacts) ? input.dataArtifacts.map(normalizeDataArtifact).filter(Boolean) as DataArtifact[] : [],
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
    remoteBridgeAudit: Array.isArray(input.remoteBridgeAudit) ? input.remoteBridgeAudit.map(normalizeRemoteBridgeAudit).filter(Boolean) as RemoteBridgeAuditRecord[] : [],
    servstationA2AConfig: normalizeServstationA2AConfig(
      input.servstationA2AConfig,
      Boolean(input.servstationA2ASecret),
      Boolean(input.servstationA2AOidcSecret),
      Boolean(input.servstationA2AStaffAgentPasswordSecret)
    ),
    servstationA2ASecret: typeof input.servstationA2ASecret === "string" ? input.servstationA2ASecret : undefined,
    servstationA2AOidcSecret: typeof input.servstationA2AOidcSecret === "string" ? input.servstationA2AOidcSecret : undefined,
    servstationA2AStaffAgentPasswordSecret: typeof input.servstationA2AStaffAgentPasswordSecret === "string" ? input.servstationA2AStaffAgentPasswordSecret : undefined
  };
}

function normalizeModelProviders(input: LegacyRuntimeStateInput, initial: ModelProviderState[]): ModelProviderState[] {
  const fallback = initial[0] || { ...defaultModelProviderConfig };
  const seen = new Set<string>();
  const providers = Array.isArray(input.modelProviders)
    ? input.modelProviders
        .map((provider, index) => normalizeModelProvider(provider, fallback, index, seen))
        .filter(Boolean) as ModelProviderState[]
    : [];
  if (providers.length > 0) {
    return providers;
  }

  const legacy = input.modelConfig || {};
  const secret = typeof input.modelSecret === "string" ? input.modelSecret : undefined;
  const timestamp = new Date().toISOString();
  const apiKeyStorage = normalizeApiKeyStorage(legacy.apiKeyStorage);
  return [
    {
      ...fallback,
      id: fallback.id,
      providerName: stringOr(legacy.providerName, fallback.providerName),
      baseUrl: stringOr(legacy.baseUrl, fallback.baseUrl),
      model: stringOr(legacy.model, fallback.model),
      temperature: finiteNumberOr(legacy.temperature, fallback.temperature),
      maxTokens: normalizePositiveNumber(legacy.maxTokens, fallback.maxTokens),
      apiKeySecret: secret,
      apiKeySaved: Boolean(secret),
      apiKeyStorage: secret ? apiKeyStorage : undefined,
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ];
}

function normalizeModelProvider(value: unknown, fallback: ModelProviderState, index: number, seen: Set<string>): ModelProviderState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Partial<ModelProviderState>;
  const now = new Date().toISOString();
  const rawId = typeof input.id === "string" && input.id.trim()
    ? input.id.trim()
    : index === 0
      ? fallback.id
      : `model-provider-${index + 1}`;
  const id = uniqueModelProviderId(rawId, seen);
  const apiKeySecret = typeof input.apiKeySecret === "string" ? input.apiKeySecret : undefined;
  return {
    ...fallback,
    id,
    providerName: stringOr(input.providerName, fallback.providerName),
    baseUrl: stringOr(input.baseUrl, fallback.baseUrl),
    model: stringOr(input.model, fallback.model),
    temperature: finiteNumberOr(input.temperature, fallback.temperature),
    maxTokens: normalizePositiveNumber(input.maxTokens, fallback.maxTokens),
    apiKeySecret,
    apiKeySaved: Boolean(apiKeySecret),
    apiKeyStorage: apiKeySecret ? normalizeApiKeyStorage(input.apiKeyStorage) : undefined,
    createdAt: typeof input.createdAt === "string" && input.createdAt ? input.createdAt : now,
    updatedAt: typeof input.updatedAt === "string" && input.updatedAt ? input.updatedAt : now
  };
}

function normalizeActiveModelProviderId(value: unknown, providers: ModelProviderState[]): string | undefined {
  const preferred = typeof value === "string" && value.trim() ? value.trim() : undefined;
  if (preferred && providers.some((provider) => provider.id === preferred)) {
    return preferred;
  }
  return providers[0]?.id;
}

function uniqueModelProviderId(rawId: string, seen: Set<string>): string {
  const base = rawId || "model-provider";
  let candidate = base;
  let index = 2;
  while (seen.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  seen.add(candidate);
  return candidate;
}

function normalizeApiKeyStorage(value: unknown): ModelProviderConfig["apiKeyStorage"] {
  return value === "safeStorage" || value === "file" ? value : undefined;
}

function finiteNumberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
    projectId: typeof conversation.projectId === "string" && conversation.projectId ? conversation.projectId : undefined,
    messages: Array.isArray(conversation.messages) ? conversation.messages.map(normalizeMessage) : []
  };
}

function normalizeAgentJob(job: AgentJob): AgentJob {
  return {
    ...job,
    projectId: typeof job.projectId === "string" && job.projectId ? job.projectId : undefined
  };
}

function normalizeScheduledJob(job: ScheduledJob): ScheduledJob {
  return {
    ...job,
    projectId: typeof job.projectId === "string" && job.projectId ? job.projectId : undefined
  };
}

function normalizeProject(project: Project): Project | undefined {
  if (!project || typeof project !== "object" || typeof project.id !== "string" || typeof project.rootPath !== "string") {
    return undefined;
  }
  const now = new Date().toISOString();
  return {
    id: project.id,
    name: typeof project.name === "string" && project.name.trim() ? project.name : project.id,
    rootPath: project.rootPath,
    metadataPath: typeof project.metadataPath === "string" ? project.metadataPath : "",
    status: project.status === "archived" || project.status === "error" ? project.status : "active",
    createdAt: typeof project.createdAt === "string" ? project.createdAt : now,
    updatedAt: typeof project.updatedAt === "string" ? project.updatedAt : now,
    lastRunAt: typeof project.lastRunAt === "string" ? project.lastRunAt : undefined,
    error: typeof project.error === "string" ? project.error : undefined
  };
}

function normalizeAutopilotRun(run: AutopilotRun): AutopilotRun | undefined {
  if (!run || typeof run !== "object" || typeof run.id !== "string" || typeof run.projectId !== "string") {
    return undefined;
  }
  const now = new Date().toISOString();
  return {
    id: run.id,
    projectId: run.projectId,
    projectRoot: typeof run.projectRoot === "string" ? run.projectRoot : "",
    title: typeof run.title === "string" && run.title.trim() ? run.title : "Data run",
    goal: typeof run.goal === "string" ? run.goal : "",
    status: normalizeAutopilotRunStatus(run.status),
    currentStage: normalizeAutopilotStage(run.currentStage),
    writePolicy: {
      mode: "projectSandbox",
      allowedWriteRoots: Array.isArray(run.writePolicy?.allowedWriteRoots) ? run.writePolicy.allowedWriteRoots.filter((item): item is string => typeof item === "string") : [],
      allowNetwork: run.writePolicy?.allowNetwork !== false,
      allowMcp: run.writePolicy?.allowMcp !== false,
      maxRuntimeMinutes: normalizePositiveNumber(run.writePolicy?.maxRuntimeMinutes, 120),
      maxTasks: normalizePositiveNumber(run.writePolicy?.maxTasks, 16),
      maxRetries: normalizePositiveNumber(run.writePolicy?.maxRetries, 1)
    },
    dataSources: Array.isArray(run.dataSources) ? run.dataSources : [],
    taskIds: Array.isArray(run.taskIds) ? run.taskIds.filter((item): item is string => typeof item === "string") : [],
    artifactIds: Array.isArray(run.artifactIds) ? run.artifactIds.filter((item): item is string => typeof item === "string") : [],
    checkpointIds: Array.isArray(run.checkpointIds) ? run.checkpointIds.filter((item): item is string => typeof item === "string") : [],
    evidence: Array.isArray(run.evidence) ? run.evidence.filter((item): item is string => typeof item === "string") : [],
    reportPath: typeof run.reportPath === "string" ? run.reportPath : undefined,
    error: typeof run.error === "string" ? run.error : undefined,
    createdAt: typeof run.createdAt === "string" ? run.createdAt : now,
    updatedAt: typeof run.updatedAt === "string" ? run.updatedAt : now,
    startedAt: typeof run.startedAt === "string" ? run.startedAt : undefined,
    finishedAt: typeof run.finishedAt === "string" ? run.finishedAt : undefined
  };
}

function normalizeAutopilotTask(task: AutopilotTask): AutopilotTask | undefined {
  if (!task || typeof task !== "object" || typeof task.id !== "string" || typeof task.runId !== "string") {
    return undefined;
  }
  const now = new Date().toISOString();
  return {
    id: task.id,
    runId: task.runId,
    projectId: typeof task.projectId === "string" ? task.projectId : "",
    stage: normalizeAutopilotStage(task.stage) || "clarify",
    staffAgent: typeof task.staffAgent === "string" ? task.staffAgent : "collector",
    title: typeof task.title === "string" ? task.title : "Autopilot task",
    prompt: typeof task.prompt === "string" ? task.prompt : "",
    status: normalizeAutopilotTaskStatus(task.status),
    attempts: normalizeNonNegativeNumber(task.attempts, 0),
    maxAttempts: normalizePositiveNumber(task.maxAttempts, 2),
    artifactIds: Array.isArray(task.artifactIds) ? task.artifactIds.filter((item): item is string => typeof item === "string") : [],
    evidence: Array.isArray(task.evidence) ? task.evidence.filter((item): item is string => typeof item === "string") : [],
    output: typeof task.output === "string" ? task.output : undefined,
    error: typeof task.error === "string" ? task.error : undefined,
    startedAt: typeof task.startedAt === "string" ? task.startedAt : undefined,
    finishedAt: typeof task.finishedAt === "string" ? task.finishedAt : undefined,
    createdAt: typeof task.createdAt === "string" ? task.createdAt : now,
    updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : now
  };
}

function normalizeAutopilotEvent(event: AutopilotEvent): AutopilotEvent | undefined {
  if (!event || typeof event !== "object" || typeof event.id !== "string" || typeof event.runId !== "string") {
    return undefined;
  }
  return {
    id: event.id,
    runId: event.runId,
    projectId: typeof event.projectId === "string" ? event.projectId : "",
    taskId: typeof event.taskId === "string" ? event.taskId : undefined,
    level: event.level === "warning" || event.level === "error" ? event.level : "info",
    message: typeof event.message === "string" ? event.message : "",
    createdAt: typeof event.createdAt === "string" ? event.createdAt : new Date().toISOString(),
    data: event.data
  };
}

function normalizeAutopilotCheckpoint(checkpoint: AutopilotCheckpoint): AutopilotCheckpoint | undefined {
  if (!checkpoint || typeof checkpoint !== "object" || typeof checkpoint.id !== "string" || typeof checkpoint.runId !== "string") {
    return undefined;
  }
  return {
    id: checkpoint.id,
    runId: checkpoint.runId,
    projectId: typeof checkpoint.projectId === "string" ? checkpoint.projectId : "",
    stage: normalizeAutopilotStage(checkpoint.stage) || "clarify",
    status: normalizeAutopilotRunStatus(checkpoint.status),
    summary: typeof checkpoint.summary === "string" ? checkpoint.summary : "",
    taskIds: Array.isArray(checkpoint.taskIds) ? checkpoint.taskIds.filter((item): item is string => typeof item === "string") : [],
    artifactIds: Array.isArray(checkpoint.artifactIds) ? checkpoint.artifactIds.filter((item): item is string => typeof item === "string") : [],
    createdAt: typeof checkpoint.createdAt === "string" ? checkpoint.createdAt : new Date().toISOString()
  };
}

function normalizeDataArtifact(artifact: DataArtifact): DataArtifact | undefined {
  if (!artifact || typeof artifact !== "object" || typeof artifact.id !== "string" || typeof artifact.path !== "string") {
    return undefined;
  }
  return {
    id: artifact.id,
    projectId: typeof artifact.projectId === "string" ? artifact.projectId : "",
    runId: typeof artifact.runId === "string" ? artifact.runId : "",
    taskId: typeof artifact.taskId === "string" ? artifact.taskId : undefined,
    kind: artifact.kind === "raw" || artifact.kind === "processed" || artifact.kind === "analysis" || artifact.kind === "report" ? artifact.kind : "output",
    stage: normalizeAutopilotStage(artifact.stage) || "collect",
    name: typeof artifact.name === "string" ? artifact.name : artifact.id,
    path: artifact.path,
    source: typeof artifact.source === "string" ? artifact.source : "autopilot",
    size: typeof artifact.size === "number" && Number.isFinite(artifact.size) ? artifact.size : 0,
    sha256: typeof artifact.sha256 === "string" ? artifact.sha256 : undefined,
    lineCount: typeof artifact.lineCount === "number" && Number.isFinite(artifact.lineCount) ? artifact.lineCount : undefined,
    createdAt: typeof artifact.createdAt === "string" ? artifact.createdAt : new Date().toISOString()
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

function mergeDefaultCapabilities(current: CapabilityDefinition[], defaults: CapabilityDefinition[], deletedIds: string[] = []): CapabilityDefinition[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  const deleted = new Set(deletedIds);
  for (const item of defaults) {
    if (deleted.has(item.id)) {
      continue;
    }
    byId.set(item.id, { ...item, enabled: byId.get(item.id)?.enabled ?? item.enabled });
  }
  return [...byId.values()];
}

function normalizeDeletedCapabilityIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()))]
    : [];
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
    updatedAt: typeof server.updatedAt === "string" ? server.updatedAt : now,
    source: normalizeMcpServerSource(server.source)
  };
}

function normalizeMcpServerSource(source: McpServerConfig["source"]): McpServerConfig["source"] {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  if (source.kind !== "tool-market" && source.kind !== "local-package") {
    return undefined;
  }
  return {
    kind: source.kind,
    packageId: typeof source.packageId === "string" ? source.packageId : undefined,
    packageKind: source.packageKind === "skill" || source.packageKind === "plugin" || source.packageKind === "mcp" ? source.packageKind : undefined,
    packagePath: typeof source.packagePath === "string" ? source.packagePath : undefined,
    componentId: typeof source.componentId === "string" ? source.componentId : undefined
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

function normalizeAutopilotRunStatus(value: unknown): AutopilotRun["status"] {
  return value === "queued" || value === "planning" || value === "running" || value === "paused" || value === "blocked" || value === "reviewing" || value === "completed" || value === "failed" || value === "canceled"
    ? value
    : "queued";
}

function normalizeAutopilotTaskStatus(value: unknown): AutopilotTask["status"] {
  return value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "blocked" || value === "skipped"
    ? value
    : "queued";
}

function normalizeAutopilotStage(value: unknown): AutopilotTask["stage"] | undefined {
  return value === "clarify" || value === "inventory" || value === "collect" || value === "process" || value === "analyze" || value === "report" || value === "review"
    ? value
    : undefined;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function normalizeNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
}

function normalizeRemoteBridgeConfig(value: unknown, tokenSaved: boolean): RemoteBridgeConfig {
  const input = value as Partial<RemoteBridgeConfig> | undefined;
  const port = typeof input?.port === "number" && Number.isFinite(input.port) ? Math.round(input.port) : 47831;
  return {
    enabled: Boolean(input?.enabled),
    host: typeof input?.host === "string" && input.host.trim() ? input.host.trim() : "127.0.0.1",
    port: port === 0 ? 0 : Math.min(65535, Math.max(1024, port)),
    tokenSaved,
    allowRemoteBind: Boolean(input?.allowRemoteBind),
    pairingCode: typeof input?.pairingCode === "string" ? input.pairingCode : undefined,
    updatedAt: typeof input?.updatedAt === "string" ? input.updatedAt : undefined
  };
}

function normalizeServstationA2AConfig(value: unknown, bearerTokenSaved: boolean, oidcTokenSaved = false, staffAgentPasswordSaved = false): ServstationA2AConfig {
  const input = value as Partial<ServstationA2AConfig> | undefined;
  const rawBaseUrl = typeof input?.baseUrl === "string" ? input.baseUrl.trim() : "";
  const normalizedBaseUrl = rawBaseUrl ? normalizeHttpUrl(rawBaseUrl) : "";
  const baseUrl = shouldUseLocalBotstationDefault(rawBaseUrl, normalizedBaseUrl) ? defaultBotstationA2A.baseUrl : normalizedBaseUrl;
  const wasUnconfigured = !rawBaseUrl && !input?.staffAgentAccount && !input?.agentInstanceId && !input?.oidc?.issuerUrl && !input?.oidc?.clientId;
  const staffAgentAccount = typeof input?.staffAgentAccount === "string" && input.staffAgentAccount.trim() ? input.staffAgentAccount.trim() : defaultBotstationA2A.userId;
  const oidc = normalizeServstationA2AOidcConfig(input?.oidc, oidcTokenSaved);
  const forceLocalOidc = wasUnconfigured || (
    input?.authMode === "identityHeaders" &&
    baseUrl === defaultBotstationA2A.baseUrl &&
    staffAgentAccount === defaultBotstationA2A.userId &&
    oidc.issuerUrl === defaultBotstationA2A.issuerUrl &&
    oidc.clientId === defaultBotstationA2A.clientId
  );
  let authMode: ServstationA2AConfig["authMode"] = "oidc";
  if (!forceLocalOidc && (input?.authMode === "bearer" || input?.authMode === "identityHeaders" || input?.authMode === "oidc")) {
    authMode = input.authMode;
  }
  const reverse = normalizeServstationA2AReverseConfig(input?.reverse);
  const nextReverse = forceLocalOidc && !oidcTokenSaved
    ? { ...reverse, enabled: false, status: "disconnected" as const, connectedAt: undefined, lastHeartbeatAt: undefined, lastError: undefined }
    : reverse;
  return {
    enabled: forceLocalOidc ? true : input?.enabled ?? true,
    baseUrl,
    authMode,
    bearerTokenSaved,
    staffAgentAccount,
    staffAgentPasswordSaved,
    staffAgentPasswordStorage: staffAgentPasswordSaved ? input?.staffAgentPasswordStorage || "file" : undefined,
    oidc,
    reverse: nextReverse,
    agentInstanceId: typeof input?.agentInstanceId === "string" && input.agentInstanceId.trim() ? input.agentInstanceId.trim() : undefined,
    updatedAt: typeof input?.updatedAt === "string" ? input.updatedAt : undefined
  };
}

function normalizeServstationA2AReverseConfig(value: unknown): NonNullable<ServstationA2AConfig["reverse"]> {
  const input = value as Partial<NonNullable<ServstationA2AConfig["reverse"]>> | undefined;
  const status = input?.status === "connecting" || input?.status === "connected" || input?.status === "error"
    ? input.status
    : "disconnected";
  return {
    enabled: Boolean(input?.enabled),
    status: input?.enabled ? status : "disconnected",
    peerId: typeof input?.peerId === "string" && input.peerId.trim() ? input.peerId.trim() : undefined,
    clientInstanceId: typeof input?.clientInstanceId === "string" && input.clientInstanceId.trim() ? input.clientInstanceId.trim() : undefined,
    connectedAt: typeof input?.connectedAt === "string" ? input.connectedAt : undefined,
    lastHeartbeatAt: typeof input?.lastHeartbeatAt === "string" ? input.lastHeartbeatAt : undefined,
    lastError: typeof input?.lastError === "string" && input.lastError.trim() ? input.lastError.trim() : undefined,
    updatedAt: typeof input?.updatedAt === "string" ? input.updatedAt : undefined
  };
}

function normalizeServstationA2AOidcConfig(value: unknown, refreshTokenSaved: boolean): ServstationA2AOidcConfig {
  const input = value as Partial<ServstationA2AOidcConfig> | undefined;
  const rawIssuerUrl = typeof input?.issuerUrl === "string" ? input.issuerUrl.trim() : "";
  const issuerUrl = normalizeLocalBotstationOidcUrl(rawIssuerUrl, defaultBotstationA2A.issuerUrl);
  const rawRedirectUri = typeof input?.redirectUri === "string" ? input.redirectUri.trim() : "";
  const redirectUri = normalizeLocalBotstationOidcUrl(rawRedirectUri, defaultBotstationA2A.redirectUri);
  return {
    issuerUrl,
    clientId: typeof input?.clientId === "string" && input.clientId.trim() ? input.clientId.trim() : defaultBotstationA2A.clientId,
    scope: typeof input?.scope === "string" && input.scope.trim() ? input.scope.trim() : defaultBotstationA2A.scope,
    redirectUri,
    accessTokenExpiresAt: typeof input?.accessTokenExpiresAt === "string" ? input.accessTokenExpiresAt : undefined,
    refreshTokenSaved,
    userId: typeof input?.userId === "string" && input.userId.trim() ? input.userId.trim() : undefined
  };
}

function normalizeLocalBotstationOidcUrl(value: string, fallback: string): string {
  const normalized = value ? normalizeHttpUrl(value) : "";
  return shouldUseLocalBotstationDefault(value, normalized) ? fallback : normalized;
}

function shouldUseLocalBotstationDefault(rawValue: string, normalizedValue: string): boolean {
  if (!rawValue || !normalizedValue) {
    return true;
  }
  try {
    const url = new URL(rawValue);
    return (
      normalizedValue === legacyLocalBotstationA2A.baseUrl ||
      normalizedValue === legacyLocalBotstationA2A.issuerUrl ||
      url.hostname === "zstupu.com" ||
      url.hostname.endsWith(".zstupu.com")
    );
  } catch {
    return true;
  }
}

export function normalizeIdentityContext(value: unknown): IdentityContext | undefined {
  const input = value as Partial<IdentityContext> | undefined;
  if (
    !input ||
    typeof input.tenantId !== "string" ||
    typeof input.organizationId !== "string" ||
    typeof input.departmentId !== "string" ||
    typeof input.userId !== "string"
  ) {
    return undefined;
  }
  const tenantId = input.tenantId.trim();
  const organizationId = input.organizationId.trim();
  const departmentId = input.departmentId.trim();
  const userId = input.userId.trim();
  if (!tenantId || !organizationId || !departmentId || !userId) {
    return undefined;
  }
  const source = input.source === "servstation" ? "servstation" : input.source === "manual" ? "manual" : undefined;
  return {
    tenantId,
    organizationId,
    departmentId,
    userId,
    roleIds: Array.isArray(input.roleIds) ? input.roleIds.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [],
    source,
    agentInstanceId: typeof input.agentInstanceId === "string" && input.agentInstanceId.trim() ? input.agentInstanceId.trim() : undefined,
    servstationUrl: typeof input.servstationUrl === "string" && input.servstationUrl.trim() ? input.servstationUrl.trim() : undefined,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : undefined
  };
}

function normalizeHttpUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
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
    remoteAddress: typeof value.remoteAddress === "string" ? value.remoteAddress : undefined,
    requestId: typeof value.requestId === "string" ? value.requestId : undefined,
    agentInstanceId: typeof value.agentInstanceId === "string" ? value.agentInstanceId : undefined,
    peerId: typeof value.peerId === "string" ? value.peerId : undefined,
    caller: normalizeCallerMetadata(value.caller),
    identity: normalizeIdentityContext(value.identity)
  };
}

function normalizeCallerMetadata(value: unknown) {
  const input = value as RemoteBridgeAuditRecord["caller"] | undefined;
  if (!input || typeof input !== "object") {
    return undefined;
  }
  return {
    requestId: typeof input.requestId === "string" ? input.requestId : undefined,
    agentInstanceId: typeof input.agentInstanceId === "string" ? input.agentInstanceId : undefined,
    peerId: typeof input.peerId === "string" ? input.peerId : undefined,
    clientId: typeof input.clientId === "string" ? input.clientId : undefined,
    userContext: normalizeIdentityContext(input.userContext)
  };
}
