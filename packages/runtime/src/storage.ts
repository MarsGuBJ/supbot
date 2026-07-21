import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AgentJob,
  type AgentLoopTrace,
  type AutopilotActionRecord,
  type AutopilotCheckpoint,
  type AutopilotEvent,
  type AutopilotRun,
  type AutopilotTask,
  type CapabilityDefinition,
  type CompactBoundary,
  type Conversation,
  type DataArtifact,
  defaultModelConfig,
  defaultPersonality,
  defaultToolMarketConfig,
  type ChatMessage,
  type IdentityContext,
  type McpServerConfig,
  type MemorySnapshot,
  type ModelConfig,
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

export interface RuntimeState {
  agentName: string;
  identityContext?: IdentityContext;
  modelConfig: ModelConfig;
  modelSecret?: string;
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
  autopilotActions: AutopilotActionRecord[];
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

export function createInitialState(): RuntimeState {
  return {
    agentName: "Supbot Local Agent",
    identityContext: undefined,
    modelConfig: { ...defaultModelConfig },
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
    autopilotActions: [],
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
      enabled: false,
      authMode: "identityHeaders",
      bearerTokenSaved: false,
      staffAgentPasswordSaved: false,
      oidc: {
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
  private pendingSnapshot?: string;
  private pendingWaiters: Array<{ resolve(): void; reject(error: unknown): void }> = [];
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly dataDir: string,
    private readonly options: { coalesceMs?: number } = {}
  ) {
    this.statePath = join(dataDir, "state.json");
  }

  getDataDir(): string {
    return this.dataDir;
  }

  async load(): Promise<RuntimeState> {
    await mkdir(this.dataDir, { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const state = createInitialState();
      await this.writeSnapshot(JSON.stringify(state, null, 2));
      return state;
    }
    try {
      return normalizeState(JSON.parse(raw) as Partial<RuntimeState>);
    } catch {
      const backupPath = `${this.statePath}.corrupt-${new Date().toISOString().replace(/[^0-9]/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
      await rename(this.statePath, backupPath);
      const state = createInitialState();
      await this.writeSnapshot(JSON.stringify(state, null, 2));
      return state;
    }
  }

  save(state: RuntimeState): Promise<void> {
    const snapshot = JSON.stringify(state, null, 2);
    const coalesceMs = this.options.coalesceMs ?? 250;
    if (coalesceMs <= 0) {
      return this.enqueueSnapshot(snapshot);
    }
    this.pendingSnapshot = snapshot;
    const pending = new Promise<void>((resolve, reject) => {
      this.pendingWaiters.push({ resolve, reject });
    });
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.flushPendingSnapshot();
      }, coalesceMs);
    }
    return pending;
  }

  private async flushPendingSnapshot(): Promise<void> {
    const snapshot = this.pendingSnapshot;
    const waiters = this.pendingWaiters.splice(0);
    this.pendingSnapshot = undefined;
    if (snapshot === undefined) {
      for (const waiter of waiters) {
        waiter.resolve();
      }
      return;
    }
    try {
      await this.enqueueSnapshot(snapshot);
      for (const waiter of waiters) {
        waiter.resolve();
      }
    } catch (error) {
      for (const waiter of waiters) {
        waiter.reject(error);
      }
    }
  }

  private enqueueSnapshot(snapshot: string): Promise<void> {
    const write = this.writeQueue
      .catch(() => undefined)
      .then(() => this.writeSnapshot(snapshot));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private async writeSnapshot(snapshot: string): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      await writeFile(tempPath, `${snapshot}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, this.statePath);
      await chmod(this.statePath, 0o600);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }
}

function normalizeState(input: Partial<RuntimeState>): RuntimeState {
  const initial = createInitialState();
  return {
    agentName: stringOr(input.agentName, initial.agentName),
    identityContext: normalizeIdentityContext(input.identityContext),
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
    capabilities: mergeDefaultCapabilities(Array.isArray(input.capabilities) ? input.capabilities : [], initial.capabilities, normalizeDeletedCapabilityIds(input.deletedCapabilityIds)),
    deletedCapabilityIds: normalizeDeletedCapabilityIds(input.deletedCapabilityIds),
    subagents: Array.isArray(input.subagents) ? input.subagents : initial.subagents,
    conversations: Array.isArray(input.conversations) ? input.conversations.map(normalizeConversation) : [],
    jobs: Array.isArray(input.jobs) ? input.jobs : [],
    scheduledJobs: Array.isArray(input.scheduledJobs) ? input.scheduledJobs : [],
    projects: Array.isArray(input.projects) ? input.projects.map(normalizeProject).filter(Boolean) as Project[] : [],
    autopilotRuns: Array.isArray(input.autopilotRuns) ? input.autopilotRuns.map(normalizeAutopilotRun).filter(Boolean) as AutopilotRun[] : [],
    autopilotTasks: Array.isArray(input.autopilotTasks) ? input.autopilotTasks.map(normalizeAutopilotTask).filter(Boolean) as AutopilotTask[] : [],
    autopilotEvents: Array.isArray(input.autopilotEvents) ? input.autopilotEvents.map(normalizeAutopilotEvent).filter(Boolean) as AutopilotEvent[] : [],
    autopilotCheckpoints: Array.isArray(input.autopilotCheckpoints) ? input.autopilotCheckpoints.map(normalizeAutopilotCheckpoint).filter(Boolean) as AutopilotCheckpoint[] : [],
    autopilotActions: Array.isArray(input.autopilotActions) ? input.autopilotActions.map(normalizeAutopilotAction).filter(Boolean) as AutopilotActionRecord[] : [],
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
    schemaVersion: 2,
    id: run.id,
    projectId: run.projectId,
    projectRoot: typeof run.projectRoot === "string" ? run.projectRoot : "",
    title: typeof run.title === "string" && run.title.trim() ? run.title : "Data run",
    goal: typeof run.goal === "string" ? run.goal : "",
    goalSpec: run.goalSpec && typeof run.goalSpec === "object" ? {
      objective: typeof run.goalSpec.objective === "string" ? run.goalSpec.objective : run.goal,
      deliverables: stringArray(run.goalSpec.deliverables),
      acceptanceCriteria: stringArray(run.goalSpec.acceptanceCriteria)
    } : {
      objective: typeof run.goal === "string" ? run.goal : "",
      deliverables: [],
      acceptanceCriteria: ["The requested outcome is produced and supported by recorded evidence."]
    },
    profile: normalizeAutopilotProfile(run.profile) || "data",
    resolvedProfile: normalizeResolvedAutopilotProfile(run.resolvedProfile) || "data",
    plan: run.plan && typeof run.plan === "object" ? {
      version: normalizePositiveNumber(run.plan.version, 1),
      profile: normalizeResolvedAutopilotProfile(run.plan.profile) || "data",
      summary: typeof run.plan.summary === "string" ? run.plan.summary : "Migrated Autopilot plan",
      taskIds: stringArray(run.plan.taskIds),
      createdAt: typeof run.plan.createdAt === "string" ? run.plan.createdAt : now,
      updatedAt: typeof run.plan.updatedAt === "string" ? run.plan.updatedAt : now
    } : {
      version: 1,
      profile: "data",
      summary: "Migrated legacy data Autopilot plan",
      taskIds: stringArray(run.taskIds),
      createdAt: typeof run.createdAt === "string" ? run.createdAt : now,
      updatedAt: typeof run.updatedAt === "string" ? run.updatedAt : now
    },
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
    budget: normalizeAutopilotBudget(run),
    loopIteration: normalizeNonNegativeNumber(run.loopIteration, 0),
    noProgressCount: normalizeNonNegativeNumber(run.noProgressCount, 0),
    lastProgressFingerprint: typeof run.lastProgressFingerprint === "string" ? run.lastProgressFingerprint : undefined,
    lastEvaluation: normalizeAutopilotEvaluation(run.lastEvaluation),
    pendingDecision: normalizeAutopilotPendingDecision(run.pendingDecision),
    worktreeId: typeof run.worktreeId === "string" ? run.worktreeId : undefined,
    directWriteApproved: Boolean(run.directWriteApproved),
    planApproved: Boolean(run.planApproved),
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
    kind: normalizeAutopilotTaskKind(task.kind),
    dependsOn: stringArray(task.dependsOn),
    risk: task.risk === "medium" || task.risk === "high" ? task.risk : "low",
    allowedTools: stringArray(task.allowedTools),
    validators: Array.isArray(task.validators) ? task.validators.filter((item) => item && typeof item.id === "string" && typeof item.kind === "string") : [],
    staffAgent: typeof task.staffAgent === "string" ? task.staffAgent : "collector",
    title: typeof task.title === "string" ? task.title : "Autopilot task",
    prompt: typeof task.prompt === "string" ? task.prompt : "",
    status: normalizeAutopilotTaskStatus(task.status),
    attempts: normalizeNonNegativeNumber(task.attempts, 0),
    maxAttempts: normalizePositiveNumber(task.maxAttempts, 2),
    artifactIds: Array.isArray(task.artifactIds) ? task.artifactIds.filter((item): item is string => typeof item === "string") : [],
    evidence: Array.isArray(task.evidence) ? task.evidence.filter((item): item is string => typeof item === "string") : [],
    actionFingerprints: stringArray(task.actionFingerprints),
    failureCategory: normalizeAutopilotFailureCategory(task.failureCategory),
    lastEvaluation: normalizeAutopilotEvaluation(task.lastEvaluation),
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
    planVersion: typeof checkpoint.planVersion === "number" ? checkpoint.planVersion : undefined,
    budgetUsage: checkpoint.budgetUsage,
    createdAt: typeof checkpoint.createdAt === "string" ? checkpoint.createdAt : new Date().toISOString()
  };
}

function normalizeAutopilotAction(action: AutopilotActionRecord): AutopilotActionRecord | undefined {
  if (!action || typeof action !== "object" || typeof action.id !== "string" || typeof action.runId !== "string" || typeof action.taskId !== "string") {
    return undefined;
  }
  const now = new Date().toISOString();
  return {
    id: action.id,
    runId: action.runId,
    taskId: action.taskId,
    fingerprint: typeof action.fingerprint === "string" ? action.fingerprint : action.id,
    toolName: typeof action.toolName === "string" ? action.toolName : "unknown",
    status: action.status === "completed" || action.status === "failed" || action.status === "denied" ? action.status : "started",
    retrySafety: action.retrySafety === "confirm" || action.retrySafety === "never" ? action.retrySafety : "safe",
    durationMs: typeof action.durationMs === "number" ? action.durationMs : undefined,
    inputSummary: typeof action.inputSummary === "string" ? action.inputSummary : "",
    outputSummary: typeof action.outputSummary === "string" ? action.outputSummary : undefined,
    error: typeof action.error === "string" ? action.error : undefined,
    createdAt: typeof action.createdAt === "string" ? action.createdAt : now,
    updatedAt: typeof action.updatedAt === "string" ? action.updatedAt : now
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
    rootPath: typeof value.rootPath === "string" ? value.rootPath : undefined,
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
  return value === "queued" || value === "analyzing" || value === "planning" || value === "waiting_approval" || value === "running" || value === "verifying" || value === "replanning" || value === "paused" || value === "blocked" || value === "reviewing" || value === "completed" || value === "partially_completed" || value === "budget_exhausted" || value === "failed" || value === "canceled"
    ? value
    : "queued";
}

function normalizeAutopilotTaskStatus(value: unknown): AutopilotTask["status"] {
  return value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "blocked" || value === "skipped"
    ? value
    : "queued";
}

function normalizeAutopilotStage(value: unknown): AutopilotTask["stage"] | undefined {
  return value === "clarify" || value === "inventory" || value === "collect" || value === "process" || value === "analyze" || value === "report" || value === "review" || value === "plan" || value === "execute" || value === "verify" || value === "replan"
    ? value
    : undefined;
}

function normalizeAutopilotProfile(value: unknown): AutopilotRun["profile"] | undefined {
  return value === "auto" || value === "coding" || value === "research" || value === "data" || value === "document" || value === "generic" ? value : undefined;
}

function normalizeResolvedAutopilotProfile(value: unknown): NonNullable<AutopilotRun["resolvedProfile"]> | undefined {
  return value === "coding" || value === "research" || value === "data" || value === "document" || value === "generic" ? value : undefined;
}

function normalizeAutopilotTaskKind(value: unknown): AutopilotTask["kind"] {
  return value === "inspect" || value === "collect" || value === "modify" || value === "analyze" || value === "produce" || value === "verify" || value === "review" ? value : "produce";
}

function normalizeAutopilotFailureCategory(value: unknown): AutopilotTask["failureCategory"] {
  return value === "transient" || value === "invalid_input" || value === "validation" || value === "permission" || value === "budget" || value === "no_progress" || value === "external_side_effect" || value === "unrecoverable" ? value : undefined;
}

function normalizeAutopilotBudget(run: AutopilotRun): NonNullable<AutopilotRun["budget"]> {
  const maxRuntimeMinutes = normalizePositiveNumber(run.budget?.limits.maxRuntimeMinutes ?? run.writePolicy?.maxRuntimeMinutes, 120);
  const startedAt = typeof run.budget?.usage.startedAt === "string" ? run.budget.usage.startedAt : run.startedAt;
  return {
    limits: {
      maxRuntimeMinutes,
      maxIterations: normalizePositiveNumber(run.budget?.limits.maxIterations, 12),
      maxTasks: normalizePositiveNumber(run.budget?.limits.maxTasks ?? run.writePolicy?.maxTasks, 24),
      maxModelTurns: normalizePositiveNumber(run.budget?.limits.maxModelTurns, 160),
      maxToolCalls: normalizePositiveNumber(run.budget?.limits.maxToolCalls, 240)
    },
    usage: {
      iterations: normalizeNonNegativeNumber(run.budget?.usage.iterations, 0),
      modelTurns: normalizeNonNegativeNumber(run.budget?.usage.modelTurns, 0),
      toolCalls: normalizeNonNegativeNumber(run.budget?.usage.toolCalls, 0),
      inputTokens: optionalNonNegativeNumber(run.budget?.usage.inputTokens),
      outputTokens: optionalNonNegativeNumber(run.budget?.usage.outputTokens),
      totalTokens: optionalNonNegativeNumber(run.budget?.usage.totalTokens),
      startedAt,
      deadlineAt: typeof run.budget?.usage.deadlineAt === "string" ? run.budget.usage.deadlineAt : startedAt ? new Date(new Date(startedAt).getTime() + maxRuntimeMinutes * 60_000).toISOString() : undefined
    }
  };
}

function normalizeAutopilotEvaluation(value: AutopilotRun["lastEvaluation"]): AutopilotRun["lastEvaluation"] {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return {
    passed: Boolean(value.passed),
    checks: Array.isArray(value.checks) ? value.checks.filter((item) => item && typeof item.validatorId === "string") : [],
    violations: stringArray(value.violations),
    evidence: stringArray(value.evidence),
    fingerprint: typeof value.fingerprint === "string" ? value.fingerprint : "",
    evaluatedAt: typeof value.evaluatedAt === "string" ? value.evaluatedAt : new Date().toISOString()
  };
}

function normalizeAutopilotPendingDecision(value: AutopilotRun["pendingDecision"]): AutopilotRun["pendingDecision"] {
  if (!value || typeof value !== "object" || typeof value.id !== "string") {
    return undefined;
  }
  return {
    id: value.id,
    kind: value.kind === "tool" || value.kind === "direct_write" || value.kind === "external_side_effect" || value.kind === "recovery" ? value.kind : "plan",
    title: typeof value.title === "string" ? value.title : "Autopilot approval",
    summary: typeof value.summary === "string" ? value.summary : "",
    risk: value.risk === "low" || value.risk === "medium" ? value.risk : "high",
    impact: stringArray(value.impact),
    rollbackPlan: typeof value.rollbackPlan === "string" ? value.rollbackPlan : undefined,
    taskId: typeof value.taskId === "string" ? value.taskId : undefined,
    toolName: typeof value.toolName === "string" ? value.toolName : undefined,
    input: value.input,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString()
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
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
  const baseUrl = typeof input?.baseUrl === "string" && input.baseUrl.trim() ? normalizeHttpUrl(input.baseUrl) : undefined;
  return {
    enabled: Boolean(input?.enabled),
    baseUrl: baseUrl || undefined,
    authMode: input?.authMode === "bearer" || input?.authMode === "oidc" ? input.authMode : "identityHeaders",
    bearerTokenSaved,
    staffAgentAccount: typeof input?.staffAgentAccount === "string" && input.staffAgentAccount.trim() ? input.staffAgentAccount.trim() : undefined,
    staffAgentPasswordSaved,
    staffAgentPasswordStorage: staffAgentPasswordSaved ? input?.staffAgentPasswordStorage || "file" : undefined,
    oidc: normalizeServstationA2AOidcConfig(input?.oidc, oidcTokenSaved),
    reverse: normalizeServstationA2AReverseConfig(input?.reverse),
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
  return {
    issuerUrl: typeof input?.issuerUrl === "string" && input.issuerUrl.trim() ? normalizeHttpUrl(input.issuerUrl) : undefined,
    clientId: typeof input?.clientId === "string" && input.clientId.trim() ? input.clientId.trim() : undefined,
    scope: typeof input?.scope === "string" && input.scope.trim() ? input.scope.trim() : undefined,
    redirectUri: typeof input?.redirectUri === "string" && input.redirectUri.trim() ? normalizeHttpUrl(input.redirectUri) : undefined,
    accessTokenExpiresAt: typeof input?.accessTokenExpiresAt === "string" ? input.accessTokenExpiresAt : undefined,
    refreshTokenSaved,
    userId: typeof input?.userId === "string" && input.userId.trim() ? input.userId.trim() : undefined
  };
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
