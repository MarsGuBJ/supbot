import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  clampNumber,
  type AgentJob,
  type Attachment,
  type AutopilotCheckpoint,
  type AutopilotEvent,
  type AutopilotRun,
  type AutopilotRunReport,
  type AutopilotStartDataRunInput,
  type AutopilotTask,
  type AutopilotWritePolicy,
  type CapabilityDefinition,
  type ChatMessage,
  type ChatMessageBlock,
  type CompactBoundary,
  type Conversation,
  type CreateConversationInput,
  type DataArtifact,
  type DataArtifactKind,
  type DataSourceSpec,
  type GeneratedFile,
  type IdentityContext,
  type JobStatus,
  type LocalPackageInspection,
  type LocalPackageInstallResult,
  type McpConfigTransfer,
  type McpDiagnosticResult,
  type McpImportResult,
  type McpLogRecord,
  type McpServerConfig,
  type McpServerInput,
  type McpServerPreset,
  type McpServerSnapshot,
  type McpServerStatus,
  type McpServerUpdate,
  type McpToolInfo,
  type MemoryAddInput,
  type MemoryCandidate,
  type MemoryFact,
  type MemoryImportInput,
  type MemoryImportResult,
  type MemoryPage,
  type MemoryRecallFeedback,
  type MemoryRecallFeedbackInput,
  type MemoryReplayRecallInput,
  type MemoryReplayRecallResult,
  type MemorySearchQuery,
  type MemorySearchResult,
  type MemoryTransfer,
  type MemoryUpdateInput,
  type ModelConfig,
  type ModelConfigUpdate,
  type ModelProviderConfig,
  type ModelProviderUpdate,
  type ModelTestResult,
  type CapabilityUpdateInput,
  nowIso,
  type PendingToolPermission,
  type PermissionMode,
  type PermissionRule,
  type PersonalityConfig,
  type Project,
  type ProjectCreateFromNameInput,
  type ProjectCreateInput,
  type ProjectUpdateInput,
  type QuerySession,
  type RemoteBridgeAuditRecord,
  type RemoteBridgeConfig,
  type RemoteBridgeSession,
  type RuntimeEventRecord,
  type RuntimeSnapshot,
  type ScheduledJob,
  type ScheduledJobInput,
  type SendPromptInput,
  type SendPromptResult,
  type ServstationA2AConfig,
  type ServstationA2AConfigUpdate,
  type ServstationA2AOidcSessionUpdate,
  type SubagentConfig,
  type SupbotEvent,
  type TaskWorktree,
  type ToolCallRecord,
  type WorktreeDiffSummary,
  type ToolMarketCatalogItem,
  type ToolMarketConfig,
  type ToolMarketConfigUpdate,
  type ToolMarketLocalDeployment,
  type ToolMarketMcpDeployment,
  type ToolMarketPackageFile,
  type ToolMarketProduct,
  type ToolMarketQuery,
} from "@supbot/shared";
import { AutopilotOrchestrator } from "./autopilotOrchestrator";
import { stripQuotes, type LocalToolHost, type LocalToolResult } from "./localTools";
import { LocalPackageManager } from "./localPackageManager";
import { MemoryManager } from "./memoryManager";
import { McpManager } from "./mcpManager";
import { generateReply, normalizeModelApiKey } from "./modelAdapter";
import { ProjectManager } from "./projectManager";
import { QueryEngine } from "./queryEngine";
import { RemoteBridgeManager } from "./remoteBridgeManager";
import { ServstationAgentClient } from "./servstationAgentClient";
import { ServstationA2AProvider } from "./servstationA2AProvider";
import { ServstationReverseBridgeClient, type ReversePromptResult } from "./servstationReverseBridgeClient";
import { ServstationRuntimeFacade } from "./servstationFacade";
import {
  identityContextFromAccessToken,
  oidcAccessTokenExpiringSoon,
  parseServstationOidcSecret,
  refreshServstationOidcTokenSet,
  serializeServstationOidcSecret,
} from "./servstationOidc";
import {
  createInitialState,
  normalizeIdentityContext,
  type ModelProviderState,
  type RuntimeState,
  type StorageAdapter,
} from "./storage";
import { SubagentRunner } from "./subagentRunner";
import { ToolExecutor } from "./toolExecutor";
import { ToolRegistry } from "./toolRegistry";
import { messagesFromEntries, TranscriptStore } from "./transcriptStore";
import {
  fetchRemoteToolMarketProducts,
  findLocalToolMarketProduct,
  findMarketProduct,
  listToolMarketCatalog,
  localToolMarketProducts,
} from "./toolMarket";
import { WorktreeManager } from "./worktreeManager";

interface RunningJob {
  controller: AbortController;
}

interface RunningAutopilotRun {
  controller: AbortController;
}

interface ProjectToolContextOptions {
  project?: Project;
  policy?: AutopilotWritePolicy;
  allowProjectRootWrites?: boolean;
}

interface PendingPermissionWaiter {
  resolve(decision: "approved" | "denied"): void;
}

const MAX_CONVERSATION_MESSAGES = 200;
const SNAPSHOT_RECENT_MESSAGES = 50;
const MAX_JOBS = 200;
const MAX_JOB_PROGRESS_ENTRIES = 50;
const PERSIST_DEBOUNCE_MS = 150;

export class SupbotRuntime extends ServstationRuntimeFacade {
  private state: RuntimeState = createInitialState();
  private readonly runningJobs = new Map<string, RunningJob>();
  private readonly runningAutopilotRuns = new Map<string, RunningAutopilotRun>();
  private readonly permissionWaiters = new Map<string, PendingPermissionWaiter>();
  private readonly toolRegistry = new ToolRegistry();
  private readonly mcpManager: McpManager;
  private readonly servstationA2AProvider: ServstationA2AProvider;
  protected readonly servstationAgentClient: ServstationAgentClient;
  private readonly worktreeManager: WorktreeManager;
  private readonly localPackageManager: LocalPackageManager;
  private readonly remoteBridgeManager: RemoteBridgeManager;
  private readonly servstationReverseBridgeClient: ServstationReverseBridgeClient;
  private readonly memoryManager = new MemoryManager({ randomId, nowIso });
  private readonly projectManager = new ProjectManager({ randomId, nowIso });
  private readonly autopilotOrchestrator = new AutopilotOrchestrator({ randomId, nowIso });
  private remoteMarketCache: ToolMarketProduct[] = [];
  private loaded = false;
  private readonly secretStorageKind: ModelConfig["apiKeyStorage"];
  private readonly marketSecretStorageKind: ToolMarketConfig["tokenStorage"];
  private readonly rootDir: string;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private activeConversationId?: string;

  constructor(
    private readonly storage: StorageAdapter,
    options: {
      secretStorageKind?: ModelConfig["apiKeyStorage"];
      marketSecretStorageKind?: ToolMarketConfig["tokenStorage"];
      rootDir?: string;
    } = {},
  ) {
    super();
    this.secretStorageKind = options.secretStorageKind || "file";
    this.marketSecretStorageKind = options.marketSecretStorageKind || this.secretStorageKind || "file";
    this.rootDir = options.rootDir || process.cwd();
    this.localPackageManager = new LocalPackageManager({
      dataDir: this.storage.getDataDir(),
      randomId,
      nowIso,
    });
    this.mcpManager = new McpManager({
      randomId,
      nowIso,
      onEvent: async (event) => {
        const record: RuntimeEventRecord = {
          id: randomId("event"),
          kind: event.kind,
          message: event.message,
          createdAt: nowIso(),
          data: event.data ? { serverId: event.serverId, ...objectData(event.data) } : { serverId: event.serverId },
        };
        this.addRuntimeEvent(record);
        if (this.loaded) {
          await this.persistAndBroadcast();
          this.emitTyped({ type: "query_event", event: record });
        }
      },
    });
    this.worktreeManager = new WorktreeManager({
      dataDir: this.storage.getDataDir(),
      rootDir: this.rootDir,
      randomId,
      nowIso,
      onEvent: async (event) => {
        this.upsertWorktreeState(event.worktree);
        const record = this.createRuntimeEvent(
          "worktree_event",
          event.message,
          {
            worktreeId: event.worktree.id,
            status: event.worktree.status,
            path: event.worktree.path,
            data: event.data,
          },
          event.worktree.jobId,
          event.worktree.conversationId,
        );
        this.addRuntimeEvent(record);
        if (this.loaded) {
          await this.persistAndBroadcast();
          this.emitTyped({ type: "worktree_event", worktree: event.worktree, event: record });
        }
      },
    });
    this.remoteBridgeManager = new RemoteBridgeManager({
      randomId,
      nowIso,
      getSnapshot: () => this.snapshot(),
      loadTranscript: (conversationId) => this.loadTranscript(conversationId),
      getWorktreeDiff: (id) => this.getWorktreeDiff(id),
      sendRemotePrompt: (input) => this.sendRemotePrompt(input),
      getIdentityContext: () => this.state.identityContext,
      updateIdentityContext: (input) => this.updateIdentityContext(input),
      onAudit: async (record) => {
        this.state.remoteBridgeSessions = this.remoteBridgeManager.listSessions();
        this.state.remoteBridgeAudit = this.remoteBridgeManager.listAudit();
        const event = this.createRuntimeEvent("remote_bridge", `Remote bridge ${record.method} ${record.path}`, record);
        this.addRuntimeEvent(event);
        if (this.loaded) {
          await this.persistAndBroadcast();
          this.emitTyped({ type: "remote_bridge", config: this.remoteBridgeManager.snapshot().config, event });
        }
      },
      onEvent: async (message, data) => {
        this.state.remoteBridgeConfig = this.remoteBridgeManager.snapshot().config;
        const event = this.createRuntimeEvent("remote_bridge", message, data);
        this.addRuntimeEvent(event);
        if (this.loaded) {
          await this.persistAndBroadcast();
          this.emitTyped({ type: "remote_bridge", config: this.state.remoteBridgeConfig, event });
        }
      },
    });
    this.servstationA2AProvider = new ServstationA2AProvider({
      getConfig: () => this.state.servstationA2AConfig,
      getAccessToken: (signal) => this.servstationA2AAccessToken(signal),
      getIdentityContext: () => this.state.identityContext,
      updateConfig: (input) => this.updateServstationA2AConfig(input),
      randomId,
    });
    this.servstationReverseBridgeClient = new ServstationReverseBridgeClient({
      getConfig: () => this.state.servstationA2AConfig,
      getAccessToken: (signal) => this.servstationA2AAccessToken(signal),
      getIdentityContext: () => this.state.identityContext,
      updateConfig: (input) => this.updateServstationA2AConfig(input),
      updateReverseState: (input) => this.updateServstationReverseState(input),
      sendReadOnlyPromptAndWait: (input) => this.sendRemotePromptAndWait(input),
      getSnapshot: () => this.snapshot(),
      loadTranscript: (conversationId) => this.loadTranscript(conversationId),
      createScheduledJob: (input) => this.createScheduledJob(input),
      updateScheduledJob: (id, input) => this.updateScheduledJob(id, input),
      deleteScheduledJob: (id) => this.deleteScheduledJob(id),
      startAutopilotDataRun: (input) => this.startDataRun(input),
      pauseAutopilotRun: (id) => this.pauseAutopilotRun(id),
      resumeAutopilotRun: (id) => this.resumeAutopilotRun(id),
      cancelAutopilotRun: (id) => this.cancelAutopilotRun(id),
      randomId,
      nowIso,
    });
    this.servstationAgentClient = new ServstationAgentClient({
      getConfig: () => this.state.servstationA2AConfig,
      getAccessToken: (signal) => this.servstationA2AAccessToken(signal),
      refreshAccessToken: (signal) => this.servstationA2AAccessToken(signal, true),
      getIdentityContext: () => this.state.identityContext,
      updateConfig: (input) => this.updateServstationA2AConfig(input),
      randomId,
      nowIso,
    });
    this.toolRegistry.addProvider(this.mcpManager);
    this.toolRegistry.addProvider(this.servstationA2AProvider);
  }

  async init(): Promise<RuntimeSnapshot> {
    this.state = await this.storage.load();
    await this.reconcileLocalPackages();
    await this.reconcileToolMarketCapabilities();
    await this.storage.save(this.state);
    this.mcpManager.setServers(this.state.mcpServers);
    this.worktreeManager.setWorktrees(this.state.worktrees);
    this.loaded = true;
    await this.recoverTranscriptsOnStartup();
    await this.recoverAutopilotRunsOnStartup();
    await this.remoteBridgeManager.configure({
      config: this.state.remoteBridgeConfig,
      token: this.state.remoteBridgeSecret,
      sessions: this.state.remoteBridgeSessions,
      audit: this.state.remoteBridgeAudit,
    });
    await this.mcpManager.autoConnectEnabled();
    if (this.state.servstationA2AConfig.reverse?.enabled) {
      this.servstationReverseBridgeClient.start();
    }
    return this.snapshot();
  }

  snapshot(activeConversationId?: string): RuntimeSnapshot {
    this.assertLoaded();
    if (activeConversationId && this.findConversation(activeConversationId)) {
      this.activeConversationId = activeConversationId;
    }
    if (!this.activeConversationId || !this.findConversation(this.activeConversationId)) {
      this.activeConversationId = this.state.conversations[0]?.id;
    }
    const activeProvider = this.ensureActiveModelProvider();
    return {
      status: this.runningJobs.size || this.runningAutopilotRuns.size ? "running" : "ready",
      agentName: this.state.agentName,
      identityContext: this.state.identityContext,
      modelConfig: this.modelConfigFromProvider(activeProvider),
      modelProviders: this.state.modelProviders.map((provider) => this.redactModelProvider(provider)),
      activeModelProviderId: activeProvider.id,
      toolMarketConfig: redactToolMarketConfig(
        this.state.toolMarketConfig,
        this.state.toolMarketSecret,
        this.state.toolMarketPasswordSecret,
      ),
      personality: this.state.personality,
      capabilities: this.state.capabilities,
      subagents: this.state.subagents,
      activeConversationId: this.activeConversationId,
      conversations: this.state.conversations.map((conversation) => ({
        ...conversation,
        messageCount: conversation.messageCount ?? conversation.messages.length,
        lastMessagePreview: conversation.lastMessagePreview || messagePreview(conversation.messages.at(-1)),
        messages:
          conversation.id === this.activeConversationId ? conversation.messages.slice(-SNAPSHOT_RECENT_MESSAGES) : [],
      })),
      jobs: this.state.jobs,
      scheduledJobs: this.state.scheduledJobs,
      projects: this.state.projects,
      autopilotRuns: this.state.autopilotRuns,
      autopilotTasks: this.state.autopilotTasks,
      autopilotEvents: this.state.autopilotEvents,
      autopilotCheckpoints: this.state.autopilotCheckpoints,
      dataArtifacts: this.state.dataArtifacts,
      pendingToolPermissions: this.state.pendingToolPermissions,
      agentLoopTraces: this.state.agentLoopTraces,
      querySessions: this.state.querySessions,
      runtimeEvents: this.state.runtimeEvents,
      compactBoundaries: this.state.compactBoundaries,
      memory: this.state.memory,
      permissionMode: this.state.permissionMode,
      permissionRules: this.state.permissionRules,
      ...this.mcpManager.snapshot(),
      worktrees: this.worktreeManager.list(),
      remoteBridge: this.remoteBridgeManager.snapshot(),
      servstationA2A: {
        config: this.redactServstationA2AConfig(),
      },
    };
  }

  async createConversation(input: string | CreateConversationInput = "New conversation"): Promise<Conversation> {
    this.assertLoaded();
    const title = typeof input === "string" ? input : input.title || "New conversation";
    const projectId = typeof input === "string" ? undefined : input.projectId;
    if (projectId) {
      this.requireConversationProject(projectId);
    }
    const now = nowIso();
    const conversation: Conversation = {
      id: randomId("conv"),
      projectId,
      title,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      messages: [],
    };
    this.state.conversations = [conversation, ...this.state.conversations];
    this.activeConversationId = conversation.id;
    await this.persistAndBroadcast();
    return conversation;
  }

  async deleteConversation(id: string): Promise<void> {
    this.assertLoaded();
    const jobsToDelete = this.state.jobs.filter((item) => item.conversationId === id);
    const jobIds = new Set(jobsToDelete.map((item) => item.id));
    const belongsToDeletedJob = (jobId?: string): boolean => {
      if (!jobId) {
        return false;
      }
      if (jobIds.has(jobId)) {
        return true;
      }
      return [...jobIds].some((rootJobId) => jobId.startsWith(`${rootJobId}:`));
    };
    const belongsToDeletedConversation = (item: { conversationId?: string; jobId?: string }): boolean =>
      item.conversationId === id || belongsToDeletedJob(item.jobId);

    for (const job of jobsToDelete) {
      this.runningJobs.get(job.id)?.controller.abort();
      this.resolveJobPermissions(job.id, "denied");
    }

    this.state.conversations = this.state.conversations.filter((item) => item.id !== id);
    this.state.jobs = this.state.jobs.filter((item) => !belongsToDeletedConversation(item));
    this.state.pendingToolPermissions = this.state.pendingToolPermissions.filter(
      (item) => !belongsToDeletedConversation(item),
    );
    this.state.agentLoopTraces = this.state.agentLoopTraces.filter((item) => !belongsToDeletedConversation(item));
    this.state.querySessions = this.state.querySessions.filter((item) => !belongsToDeletedConversation(item));
    this.state.runtimeEvents = this.state.runtimeEvents.filter((item) => !belongsToDeletedConversation(item));
    this.state.worktrees = this.state.worktrees.filter((item) => !belongsToDeletedConversation(item));
    this.state.compactBoundaries = this.state.compactBoundaries.filter((item) => item.conversationId !== id);
    if (this.activeConversationId === id) {
      this.activeConversationId = this.state.conversations[0]?.id;
    }
    await new TranscriptStore(this.storage.getDataDir()).delete(id).catch(() => undefined);
    this.worktreeManager.setWorktrees(this.state.worktrees);
    await this.persistAndBroadcast();
  }

  async createProjectFromFolder(input: ProjectCreateInput): Promise<Project> {
    this.assertLoaded();
    const project = await this.projectManager.createFromFolder(input, this.state.projects);
    this.state.projects = [
      project,
      ...this.state.projects.filter(
        (item) => item.id !== project.id && resolve(item.rootPath) !== resolve(project.rootPath),
      ),
    ];
    await this.persistAndBroadcast();
    this.emitTyped({ type: "project_changed", project });
    return project;
  }

  async createProjectFromName(input: ProjectCreateFromNameInput): Promise<Project> {
    this.assertLoaded();
    const name = requiredString(input.name, "Project name");
    if (name.length > 80) {
      throw new Error("Project name must be 80 characters or fewer.");
    }

    const projectsRoot = join(this.storage.getDataDir(), "projects");
    await mkdir(projectsRoot, { recursive: true });
    const slug = safeProjectSlug(name);
    for (let suffix = 1; ; suffix += 1) {
      const folderName = suffix === 1 ? slug : `${slug}-${suffix}`;
      const rootPath = join(projectsRoot, folderName);
      const resolvedRoot = resolve(rootPath).toLowerCase();
      const existing = this.state.projects.find((project) => resolve(project.rootPath).toLowerCase() === resolvedRoot);
      if (existing && existing.status !== "archived" && existing.name.trim() === name) {
        return this.createProjectFromFolder({ rootPath, name });
      }
      if (!(await pathExists(rootPath))) {
        return this.createProjectFromFolder({ rootPath, name });
      }
    }
  }

  listProjects(): Project[] {
    this.assertLoaded();
    return [...this.state.projects];
  }

  openProject(id: string): Project {
    this.assertLoaded();
    return this.requireProject(id);
  }

  async updateProject(id: string, input: ProjectUpdateInput): Promise<Project> {
    this.assertLoaded();
    const current = this.requireProject(id);
    const project = await this.projectManager.update(current, input);
    this.state.projects = this.state.projects.map((item) => (item.id === id ? project : item));
    await this.persistAndBroadcast();
    this.emitTyped({ type: "project_changed", project });
    return project;
  }

  async startDataRun(input: AutopilotStartDataRunInput): Promise<AutopilotRun> {
    this.assertLoaded();
    const project = this.requireProject(requiredString(input.projectId, "Project id"));
    this.projectManager.validateProjectPath(project);
    await this.projectManager.ensureProjectFolders(project.rootPath);
    const now = nowIso();
    const policy = this.projectManager.defaultWritePolicy(input.writePolicy || {});
    const run: AutopilotRun = {
      id: randomId("aprun"),
      projectId: project.id,
      projectRoot: project.rootPath,
      title: input.title?.trim() || titleFromPrompt(input.goal),
      goal: requiredString(input.goal, "Autopilot goal"),
      status: "queued",
      currentStage: "clarify",
      writePolicy: policy,
      dataSources: normalizeDataSources(input.dataSources || []),
      taskIds: [],
      artifactIds: [],
      checkpointIds: [],
      evidence: [],
      createdAt: now,
      updatedAt: now,
    };
    const tasks = this.autopilotOrchestrator.createTasks(run);
    const nextRun = { ...run, taskIds: tasks.map((task) => task.id) };
    this.state.autopilotRuns = [nextRun, ...this.state.autopilotRuns];
    this.state.autopilotTasks = [...tasks, ...this.state.autopilotTasks];
    this.state.projects = this.state.projects.map((item) =>
      item.id === project.id ? { ...item, lastRunAt: now, updatedAt: now } : item,
    );
    await this.addAutopilotCheckpoint(nextRun, "Autopilot data run queued");
    await this.addAutopilotEvent(nextRun, "info", "Autopilot data run queued", { taskCount: tasks.length });
    await this.persistAndBroadcast();
    void this.runAutopilot(nextRun.id);
    return this.requireAutopilotRun(nextRun.id);
  }

  async pauseAutopilotRun(id: string): Promise<AutopilotRun> {
    this.assertLoaded();
    this.requireAutopilotRun(id);
    this.runningAutopilotRuns.get(id)?.controller.abort();
    const next = this.patchAutopilotRun(id, { status: "paused", updatedAt: nowIso(), error: undefined });
    await this.addAutopilotEvent(next, "info", "Autopilot data run paused");
    await this.addAutopilotCheckpoint(next, "Paused by user");
    await this.persistAndBroadcast();
    return next;
  }

  async resumeAutopilotRun(id: string): Promise<AutopilotRun> {
    this.assertLoaded();
    const run = this.requireAutopilotRun(id);
    if (run.status !== "paused" && run.status !== "blocked" && run.status !== "failed") {
      return run;
    }
    const next = this.patchAutopilotRun(id, { status: "queued", updatedAt: nowIso(), error: undefined });
    await this.addAutopilotEvent(next, "info", "Autopilot data run resumed");
    await this.persistAndBroadcast();
    void this.runAutopilot(id);
    return this.requireAutopilotRun(id);
  }

  async cancelAutopilotRun(id: string): Promise<AutopilotRun> {
    this.assertLoaded();
    this.requireAutopilotRun(id);
    this.runningAutopilotRuns.get(id)?.controller.abort();
    const now = nowIso();
    const next = this.patchAutopilotRun(id, { status: "canceled", updatedAt: now, finishedAt: now });
    this.state.autopilotTasks = this.state.autopilotTasks.map((task) =>
      task.runId === id && (task.status === "queued" || task.status === "running")
        ? { ...task, status: "skipped", updatedAt: now, finishedAt: now, error: "Run canceled" }
        : task,
    );
    await this.addAutopilotEvent(next, "warning", "Autopilot data run canceled");
    await this.addAutopilotCheckpoint(next, "Canceled by user");
    await this.persistAndBroadcast();
    return this.requireAutopilotRun(id);
  }

  getAutopilotRunReport(id: string): AutopilotRunReport {
    this.assertLoaded();
    const run = this.requireAutopilotRun(id);
    return {
      run,
      project: this.state.projects.find((project) => project.id === run.projectId),
      tasks: this.state.autopilotTasks.filter((task) => task.runId === id),
      artifacts: this.state.dataArtifacts.filter((artifact) => artifact.runId === id),
      checkpoints: this.state.autopilotCheckpoints.filter((checkpoint) => checkpoint.runId === id),
      events: this.state.autopilotEvents.filter((event) => event.runId === id),
    };
  }

  async sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
    this.assertLoaded();
    const existingConversation = input.conversationId ? this.findConversation(input.conversationId) : undefined;
    const conversation =
      existingConversation ||
      (await this.createConversation({
        title: titleFromPrompt(input.prompt),
        projectId: input.projectId,
      }));
    this.activeConversationId = conversation.id;

    const now = nowIso();
    const userMessage: ChatMessage = {
      id: randomId("msg"),
      conversationId: conversation.id,
      role: "user",
      text: input.prompt,
      createdAt: now,
      attachments: input.attachments || [],
    };
    const job: AgentJob = {
      id: randomId("job"),
      conversationId: conversation.id,
      projectId: conversation.projectId,
      prompt: input.prompt,
      status: "queued",
      workspaceMode: input.workspaceMode || "main",
      diffStatus: "unavailable",
      createdAt: now,
      updatedAt: now,
      progress: ["Queued locally"],
    };

    this.appendMessage(conversation.id, userMessage);
    this.state.jobs = [job, ...this.state.jobs].slice(0, MAX_JOBS);
    await this.persistAndBroadcast();
    await this.appendTranscript(conversation.id, { type: "message", message: userMessage });
    this.emitTyped({ type: "message", conversationId: conversation.id, message: userMessage });
    this.emitTyped({ type: "job", job });
    void this.runJob(job.id);
    return { conversation: this.findConversation(conversation.id)!, userMessage, job };
  }

  async cancelJob(jobId: string): Promise<AgentJob> {
    this.assertLoaded();
    const job = this.findJob(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }
    this.runningJobs.get(jobId)?.controller.abort();
    this.resolveJobPermissions(jobId, "denied");
    this.updateJob(jobId, "canceled", "Canceled by user");
    await this.persistAndBroadcast();
    return this.findJob(jobId)!;
  }

  async approveToolPermission(permissionId: string): Promise<void> {
    this.assertLoaded();
    const permission = this.resolvePermission(permissionId, "approved");
    if (permission) {
      await this.recordPermissionDecision(permission, "approved");
    }
    await this.persistAndBroadcast();
  }

  async denyToolPermission(permissionId: string): Promise<void> {
    this.assertLoaded();
    const permission = this.resolvePermission(permissionId, "denied");
    if (permission) {
      await this.recordPermissionDecision(permission, "denied");
    }
    await this.persistAndBroadcast();
  }

  async setPermissionMode(mode: PermissionMode): Promise<PermissionMode> {
    this.assertLoaded();
    this.state.permissionMode = normalizePermissionMode(mode);
    await this.persistAndBroadcast();
    return this.state.permissionMode;
  }

  async addPermissionRule(
    rule: Omit<PermissionRule, "id" | "createdAt" | "scope"> & { id?: string },
  ): Promise<PermissionRule> {
    this.assertLoaded();
    const next: PermissionRule = {
      id: rule.id || randomId("rule"),
      toolName: rule.toolName.trim() || "*",
      behavior: rule.behavior,
      scope: "session",
      createdAt: nowIso(),
    };
    this.state.permissionRules = [next, ...this.state.permissionRules.filter((item) => item.id !== next.id)];
    await this.persistAndBroadcast();
    return next;
  }

  async removePermissionRule(ruleId: string): Promise<void> {
    this.assertLoaded();
    this.state.permissionRules = this.state.permissionRules.filter((item) => item.id !== ruleId);
    await this.persistAndBroadcast();
  }

  async compactConversation(conversationId: string): Promise<CompactBoundary> {
    this.assertLoaded();
    const conversation = this.findConversation(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    const boundary: CompactBoundary = {
      id: randomId("compact"),
      conversationId,
      messageId: conversation.messages.at(-1)?.id || conversation.messages[0]?.id,
      summary: summarizeConversationForManualCompact(conversation.messages),
      preservedMessageIds: conversation.messages.slice(-6).map((message) => message.id),
      originalMessageCount: conversation.messages.length,
      createdAt: nowIso(),
    };
    this.upsertCompactBoundary(boundary);
    const summaryMessage: ChatMessage = {
      id: randomId("msg"),
      conversationId,
      role: "system",
      text: boundary.summary,
      createdAt: boundary.createdAt,
      blocks: [{ type: "compact_summary", boundaryId: boundary.id, summary: boundary.summary }],
    };
    this.appendMessage(conversationId, summaryMessage);
    await this.appendTranscript(conversationId, { type: "compact", boundary });
    await this.appendTranscript(conversationId, { type: "message", message: summaryMessage });
    const event: RuntimeEventRecord = {
      id: randomId("event"),
      conversationId,
      kind: "compact",
      message: "Conversation manually compacted",
      createdAt: boundary.createdAt,
      data: boundary,
    };
    this.addRuntimeEvent(event);
    await this.appendTranscript(conversationId, { type: "event", event });
    const memoryResult = this.memoryManager.candidateFromCompact(this.state.memory, boundary);
    this.state.memory = memoryResult.memory;
    for (const candidate of memoryResult.candidates) {
      const candidateEvent: RuntimeEventRecord = {
        id: randomId("event"),
        conversationId,
        kind: "memory_candidate",
        message: "Memory candidate created from compact summary",
        createdAt: candidate.createdAt,
        data: candidate,
      };
      this.addRuntimeEvent(candidateEvent);
      await this.appendTranscript(conversationId, { type: "event", event: candidateEvent });
    }
    await this.persistAndBroadcast();
    this.emitTyped({ type: "compact", boundary });
    if (memoryResult.candidates.length) {
      this.emitTyped({ type: "memory_changed", memory: this.state.memory });
      for (const candidate of memoryResult.candidates) {
        this.emitTyped({ type: "memory_candidate", candidate });
      }
    }
    return boundary;
  }

  async loadTranscript(conversationId: string) {
    this.assertLoaded();
    const conversation = this.findConversation(conversationId);
    if (!conversation) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    const store = new TranscriptStore(this.storage.getDataDir());
    return store.loadRecoverable(conversationId, conversation.messages, this.state.compactBoundaries);
  }

  async loadConversationHistory(conversationId: string, beforeMessageId?: string, limit?: number) {
    this.assertLoaded();
    if (!this.findConversation(conversationId)) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    return new TranscriptStore(this.storage.getDataDir()).loadPage(conversationId, { beforeMessageId, limit });
  }

  async listWorktrees(): Promise<TaskWorktree[]> {
    this.assertLoaded();
    return this.worktreeManager.list();
  }

  async getWorktreeDiff(id: string): Promise<WorktreeDiffSummary> {
    this.assertLoaded();
    return this.worktreeManager.getDiff(id);
  }

  async applyWorktree(id: string): Promise<TaskWorktree> {
    this.assertLoaded();
    const worktree = await this.worktreeManager.apply(id);
    this.state.worktrees = this.worktreeManager.list();
    this.markJobWorktree(worktree);
    await this.persistAndBroadcast();
    return worktree;
  }

  async discardWorktree(id: string): Promise<TaskWorktree> {
    this.assertLoaded();
    const worktree = await this.worktreeManager.discard(id);
    this.state.worktrees = this.worktreeManager.list();
    this.markJobWorktree(worktree);
    await this.persistAndBroadcast();
    return worktree;
  }

  async remoteBridgeConfig(): Promise<RemoteBridgeConfig> {
    this.assertLoaded();
    return this.remoteBridgeManager.snapshot().config;
  }

  async identityContext(): Promise<IdentityContext | undefined> {
    this.assertLoaded();
    return this.state.identityContext
      ? { ...this.state.identityContext, roleIds: [...this.state.identityContext.roleIds] }
      : undefined;
  }

  async updateIdentityContext(input: IdentityContext): Promise<IdentityContext> {
    this.assertLoaded();
    const normalized = normalizeIdentityContext({
      ...input,
      updatedAt: input.updatedAt ?? nowIso(),
    });
    if (!normalized) {
      throw new Error("Invalid identity context");
    }
    this.state.identityContext = normalized;
    await this.persistAndBroadcast();
    return { ...normalized, roleIds: [...normalized.roleIds] };
  }

  async servstationA2AConfig(): Promise<ServstationA2AConfig> {
    this.assertLoaded();
    return this.redactServstationA2AConfig();
  }

  async servstationA2AStaffAgentPassword(): Promise<string | undefined> {
    this.assertLoaded();
    return this.state.servstationA2AStaffAgentPasswordSecret;
  }

  async updateServstationA2AConfig(input: ServstationA2AConfigUpdate): Promise<ServstationA2AConfig> {
    this.assertLoaded();
    const current = this.state.servstationA2AConfig;
    const baseUrl = input.baseUrl !== undefined ? normalizeHttpUrl(input.baseUrl) : current.baseUrl;
    const nextSecret = input.clearBearerToken
      ? undefined
      : input.bearerToken?.trim() || this.state.servstationA2ASecret;
    const authMode =
      input.authMode === "bearer" || input.authMode === "identityHeaders" || input.authMode === "oidc"
        ? input.authMode
        : current.authMode;
    const currentOidc = this.redactServstationA2AOidcConfig();
    const oidc = {
      ...currentOidc,
      issuerUrl: input.oidcIssuerUrl !== undefined ? normalizeHttpUrl(input.oidcIssuerUrl) : currentOidc.issuerUrl,
      clientId: input.oidcClientId !== undefined ? emptyToUndefined(input.oidcClientId) : currentOidc.clientId,
      scope: input.oidcScope !== undefined ? emptyToUndefined(input.oidcScope) : currentOidc.scope,
      redirectUri:
        input.oidcRedirectUri !== undefined ? normalizeHttpUrl(input.oidcRedirectUri) : currentOidc.redirectUri,
      refreshTokenSaved: currentOidc.refreshTokenSaved,
    };
    const staffAgentAccount =
      input.staffAgentAccount !== undefined ? emptyToUndefined(input.staffAgentAccount) : current.staffAgentAccount;
    const previousStaffAgentPassword = this.state.servstationA2AStaffAgentPasswordSecret;
    let nextStaffAgentPassword = previousStaffAgentPassword;
    let staffAgentPasswordChanged = false;
    if (input.clearStaffAgentPassword) {
      staffAgentPasswordChanged = Boolean(previousStaffAgentPassword);
      nextStaffAgentPassword = undefined;
    } else if (typeof input.staffAgentPassword === "string" && input.staffAgentPassword.trim()) {
      nextStaffAgentPassword = input.staffAgentPassword.trim();
      staffAgentPasswordChanged = nextStaffAgentPassword !== previousStaffAgentPassword;
    }
    const oidcContextChanged =
      baseUrl !== current.baseUrl ||
      oidc.issuerUrl !== currentOidc.issuerUrl ||
      oidc.clientId !== currentOidc.clientId ||
      staffAgentAccount !== current.staffAgentAccount ||
      staffAgentPasswordChanged;
    const nextOidc = oidcContextChanged
      ? {
          ...oidc,
          accessTokenExpiresAt: undefined,
          refreshTokenSaved: false,
          userId: undefined,
        }
      : oidc;
    const currentReverse = this.state.servstationA2AConfig.reverse || {
      enabled: false,
      status: "disconnected" as const,
    };
    const reverse = {
      ...currentReverse,
      enabled: input.reverseEnabled ?? currentReverse.enabled,
      clientInstanceId:
        input.reverseClientInstanceId !== undefined
          ? emptyToUndefined(input.reverseClientInstanceId)
          : currentReverse.clientInstanceId,
      status: input.reverseEnabled === false ? ("disconnected" as const) : currentReverse.status,
      updatedAt: nowIso(),
    };
    this.state.servstationA2AConfig = {
      ...current,
      enabled: input.enabled ?? current.enabled,
      baseUrl,
      authMode,
      bearerTokenSaved: Boolean(nextSecret),
      staffAgentAccount,
      staffAgentPasswordSaved: Boolean(nextStaffAgentPassword),
      staffAgentPasswordStorage: nextStaffAgentPassword ? this.secretStorageKind : undefined,
      oidc: nextOidc,
      reverse,
      agentInstanceId:
        input.agentInstanceId !== undefined ? emptyToUndefined(input.agentInstanceId) : current.agentInstanceId,
      updatedAt: nowIso(),
    };
    this.state.servstationA2ASecret = nextSecret;
    this.state.servstationA2AStaffAgentPasswordSecret = nextStaffAgentPassword;
    if (oidcContextChanged) {
      this.state.servstationA2AOidcSecret = undefined;
    }
    const event = this.createRuntimeEvent("servstation_a2a", "Servstation A2A config updated", {
      enabled: this.state.servstationA2AConfig.enabled,
      baseUrl: this.state.servstationA2AConfig.baseUrl,
      authMode: this.state.servstationA2AConfig.authMode,
      agentInstanceId: this.state.servstationA2AConfig.agentInstanceId,
      bearerTokenSaved: Boolean(nextSecret),
      staffAgentAccount,
      staffAgentPasswordSaved: Boolean(nextStaffAgentPassword),
      oidc: nextOidc,
      reverse,
    });
    this.addRuntimeEvent(event);
    await this.persistAndBroadcast();
    const redacted = this.redactServstationA2AConfig();
    this.emitTyped({ type: "servstation_a2a", config: redacted, event });
    return redacted;
  }

  async connectServstationReverseBridge(): Promise<ServstationA2AConfig> {
    this.assertLoaded();
    if (
      this.state.servstationA2AConfig.authMode === "oidc" &&
      !parseServstationOidcSecret(this.state.servstationA2AOidcSecret)
    ) {
      throw new Error("Servstation OIDC session is not configured.");
    }
    await this.updateServstationReverseState({
      enabled: true,
      status: "connecting",
      lastError: undefined,
    });
    this.servstationReverseBridgeClient.start();
    return this.waitForServstationReverseConnection();
  }

  async disconnectServstationReverseBridge(): Promise<ServstationA2AConfig> {
    this.assertLoaded();
    await this.servstationReverseBridgeClient.stop(false);
    return this.redactServstationA2AConfig();
  }

  async updateServstationA2AOidcSession(input: ServstationA2AOidcSessionUpdate): Promise<ServstationA2AConfig> {
    this.assertLoaded();
    const current = this.state.servstationA2AConfig;
    const baseUrl =
      input.baseUrl !== undefined
        ? normalizeHttpUrl(input.baseUrl)
        : current.baseUrl || this.state.identityContext?.servstationUrl || input.identityContext?.servstationUrl;
    const issuerUrl = normalizeHttpUrl(input.issuerUrl);
    if (!issuerUrl) {
      throw new Error("Servstation OIDC issuer URL is required.");
    }
    const clientId = requiredString(input.clientId, "Servstation OIDC client id");
    const tokens = {
      ...input.tokens,
      issuerUrl,
      clientId,
    };
    const derivedIdentity = input.identityContext
      ? normalizeIdentityContext({ ...input.identityContext, servstationUrl: baseUrl, updatedAt: nowIso() })
      : identityContextFromAccessToken(tokens.accessToken, {
          ...(this.state.identityContext || {}),
          servstationUrl: baseUrl,
        });
    if (derivedIdentity) {
      this.state.identityContext = derivedIdentity;
    }
    this.state.servstationA2AOidcSecret = serializeServstationOidcSecret(tokens);
    this.state.servstationA2AConfig = {
      ...current,
      enabled: true,
      baseUrl,
      authMode: "oidc",
      bearerTokenSaved: Boolean(this.state.servstationA2ASecret),
      oidc: {
        issuerUrl,
        clientId,
        scope: input.scope || tokens.scope || current.oidc?.scope,
        redirectUri: input.redirectUri !== undefined ? normalizeHttpUrl(input.redirectUri) : current.oidc?.redirectUri,
        accessTokenExpiresAt: tokens.expiresAt,
        refreshTokenSaved: Boolean(tokens.refreshToken),
        userId: derivedIdentity?.userId || current.oidc?.userId,
      },
      agentInstanceId: derivedIdentity?.agentInstanceId || current.agentInstanceId,
      updatedAt: nowIso(),
    };
    const event = this.createRuntimeEvent("servstation_a2a", "Servstation OIDC session updated", {
      baseUrl,
      issuerUrl,
      clientId,
      userId: derivedIdentity?.userId,
      refreshTokenSaved: Boolean(tokens.refreshToken),
    });
    this.addRuntimeEvent(event);
    await this.persistAndBroadcast();
    const redacted = this.redactServstationA2AConfig();
    this.emitTyped({ type: "servstation_a2a", config: redacted, event });
    return redacted;
  }

  async refreshServstationA2AOidcSession(signal?: AbortSignal): Promise<ServstationA2AConfig> {
    this.assertLoaded();
    const current = this.state.servstationA2AConfig;
    const tokens = parseServstationOidcSecret(this.state.servstationA2AOidcSecret);
    if (!tokens) {
      throw new Error("Servstation OIDC session is not configured.");
    }
    const refreshed = await refreshServstationOidcTokenSet(tokens, signal);
    const derivedIdentity = identityContextFromAccessToken(refreshed.accessToken, {
      ...(this.state.identityContext || {}),
      agentInstanceId: current.agentInstanceId || this.state.identityContext?.agentInstanceId,
      servstationUrl: current.baseUrl || this.state.identityContext?.servstationUrl,
    });
    if (derivedIdentity) {
      this.state.identityContext = normalizeIdentityContext(derivedIdentity);
    }
    this.state.servstationA2AOidcSecret = serializeServstationOidcSecret(refreshed);
    this.state.servstationA2AConfig = {
      ...current,
      bearerTokenSaved: Boolean(this.state.servstationA2ASecret),
      oidc: {
        ...this.redactServstationA2AOidcConfig(),
        issuerUrl: refreshed.issuerUrl,
        clientId: refreshed.clientId,
        scope: refreshed.scope || current.oidc?.scope,
        accessTokenExpiresAt: refreshed.expiresAt,
        refreshTokenSaved: Boolean(refreshed.refreshToken),
        userId: derivedIdentity?.userId || current.oidc?.userId,
      },
      agentInstanceId: derivedIdentity?.agentInstanceId || current.agentInstanceId,
      updatedAt: nowIso(),
    };
    const event = this.createRuntimeEvent("servstation_a2a", "Servstation OIDC token refreshed", {
      issuerUrl: refreshed.issuerUrl,
      clientId: refreshed.clientId,
      userId: derivedIdentity?.userId,
      refreshTokenSaved: Boolean(refreshed.refreshToken),
    });
    this.addRuntimeEvent(event);
    await this.persistAndBroadcast();
    const redacted = this.redactServstationA2AConfig();
    this.emitTyped({ type: "servstation_a2a", config: redacted, event });
    return redacted;
  }

  async clearServstationA2AOidcSession(): Promise<ServstationA2AConfig> {
    this.assertLoaded();
    const current = this.state.servstationA2AConfig;
    this.state.servstationA2AOidcSecret = undefined;
    this.state.servstationA2AConfig = {
      ...current,
      bearerTokenSaved: Boolean(this.state.servstationA2ASecret),
      oidc: {
        ...this.redactServstationA2AOidcConfig(),
        accessTokenExpiresAt: undefined,
        refreshTokenSaved: false,
        userId: undefined,
      },
      updatedAt: nowIso(),
    };
    const event = this.createRuntimeEvent("servstation_a2a", "Servstation OIDC session cleared", {
      issuerUrl: current.oidc?.issuerUrl,
      clientId: current.oidc?.clientId,
    });
    this.addRuntimeEvent(event);
    await this.persistAndBroadcast();
    const redacted = this.redactServstationA2AConfig();
    this.emitTyped({ type: "servstation_a2a", config: redacted, event });
    return redacted;
  }

  async updateRemoteBridgeConfig(
    input: Partial<RemoteBridgeConfig> & { token?: string; clearToken?: boolean },
  ): Promise<RemoteBridgeConfig> {
    this.assertLoaded();
    const result = await this.remoteBridgeManager.update(input);
    this.state.remoteBridgeConfig = result.config;
    this.state.remoteBridgeSecret = result.token;
    this.state.remoteBridgeSessions = this.remoteBridgeManager.listSessions();
    this.state.remoteBridgeAudit = this.remoteBridgeManager.listAudit();
    await this.persistAndBroadcast();
    return result.config;
  }

  async listRemoteBridgeSessions(): Promise<RemoteBridgeSession[]> {
    this.assertLoaded();
    return this.remoteBridgeManager.listSessions();
  }

  async revokeRemoteBridgeSession(id: string): Promise<RemoteBridgeSession> {
    this.assertLoaded();
    const session = this.remoteBridgeManager.revokeSession(id);
    this.state.remoteBridgeSessions = this.remoteBridgeManager.listSessions();
    await this.persistAndBroadcast();
    return session;
  }

  async listRemoteBridgeAudit(): Promise<RemoteBridgeAuditRecord[]> {
    this.assertLoaded();
    return this.remoteBridgeManager.listAudit();
  }

  async listMemory(query: MemorySearchQuery = {}): Promise<MemorySearchResult[]> {
    this.assertLoaded();
    return this.memoryManager.search(this.state.memory, {
      ...query,
      scope: query.scope || "all",
      includeDisabled: query.includeDisabled ?? true,
      limit: query.limit ?? 100,
    });
  }

  async searchMemory(query: MemorySearchQuery = {}): Promise<MemorySearchResult[]> {
    this.assertLoaded();
    return this.memoryManager.search(this.state.memory, {
      ...query,
      scope: query.scope || "all",
      limit: query.limit ?? 20,
    });
  }

  async addMemory(input: MemoryAddInput): Promise<MemoryPage | MemoryFact> {
    this.assertLoaded();
    const result = this.memoryManager.add(this.state.memory, {
      ...input,
      title: requiredString(input.title, "Memory title"),
      content: requiredString(input.content, "Memory content"),
    });
    this.state.memory = result.memory;
    await this.recordMemoryWrite("Memory added", result.record, result.record.conversationId);
    await this.persistAndBroadcast();
    this.emitTyped({ type: "memory_changed", memory: this.state.memory });
    return result.record;
  }

  async updateMemory(id: string, input: MemoryUpdateInput): Promise<MemoryPage | MemoryFact> {
    this.assertLoaded();
    const result = this.memoryManager.update(this.state.memory, id, input);
    if (!result.record) {
      throw new Error(`Memory not found: ${id}`);
    }
    this.state.memory = result.memory;
    await this.recordMemoryWrite("Memory updated", result.record, result.record.conversationId);
    await this.persistAndBroadcast();
    this.emitTyped({ type: "memory_changed", memory: this.state.memory });
    return result.record;
  }

  async deleteMemory(id: string): Promise<void> {
    this.assertLoaded();
    const before = this.findMemoryRecord(id);
    this.state.memory = this.memoryManager.delete(this.state.memory, id);
    await this.recordMemoryWrite("Memory deleted", { id, record: before }, before?.conversationId);
    await this.persistAndBroadcast();
    this.emitTyped({ type: "memory_changed", memory: this.state.memory });
  }

  async approveMemoryCandidate(id: string): Promise<MemoryPage | MemoryFact> {
    this.assertLoaded();
    const result = this.memoryManager.approveCandidate(this.state.memory, id);
    if (!result.record || !result.candidate) {
      throw new Error(`Pending memory candidate not found: ${id}`);
    }
    this.state.memory = result.memory;
    await this.recordMemoryWrite(
      "Memory candidate approved",
      { candidate: result.candidate, record: result.record },
      result.record.conversationId,
    );
    await this.persistAndBroadcast();
    this.emitTyped({ type: "memory_candidate", candidate: result.candidate });
    this.emitTyped({ type: "memory_changed", memory: this.state.memory });
    return result.record;
  }

  async denyMemoryCandidate(id: string): Promise<MemoryCandidate> {
    this.assertLoaded();
    const result = this.memoryManager.denyCandidate(this.state.memory, id);
    if (!result.candidate) {
      throw new Error(`Memory candidate not found: ${id}`);
    }
    this.state.memory = result.memory;
    await this.recordMemoryWrite("Memory candidate denied", result.candidate, result.candidate.conversationId);
    await this.persistAndBroadcast();
    this.emitTyped({ type: "memory_candidate", candidate: result.candidate });
    this.emitTyped({ type: "memory_changed", memory: this.state.memory });
    return result.candidate;
  }

  async exportMemory(): Promise<MemoryTransfer> {
    this.assertLoaded();
    return this.memoryManager.exportSnapshot(this.state.memory);
  }

  async importMemory(input: MemoryImportInput): Promise<MemoryImportResult> {
    this.assertLoaded();
    const result = this.memoryManager.importSnapshot(this.state.memory, input);
    this.state.memory = result.memory;
    await this.recordMemoryWrite("Memory imported", {
      mode: result.mode,
      imported: result.imported,
    });
    await this.persistAndBroadcast();
    this.emitTyped({ type: "memory_changed", memory: this.state.memory });
    return result;
  }

  async backupMemory(): Promise<GeneratedFile> {
    this.assertLoaded();
    const backupDir = join(this.storage.getDataDir(), "memory-backups");
    await mkdir(backupDir, { recursive: true });
    const createdAt = nowIso();
    const safeStamp = createdAt.replace(/[:.]/g, "-");
    const filePath = join(backupDir, `memory-${safeStamp}.json`);
    const transfer = this.memoryManager.exportSnapshot(this.state.memory, createdAt);
    await writeFile(filePath, `${JSON.stringify(transfer, null, 2)}\n`, "utf8");
    const info = await stat(filePath);
    const file: GeneratedFile = {
      id: randomId("mem_backup"),
      name: basename(filePath),
      path: filePath,
      size: info.size,
      createdAt,
    };
    await this.recordMemoryWrite("Memory backup created", file);
    await this.persistAndBroadcast();
    return file;
  }

  async restoreMemory(filePath?: string): Promise<MemoryImportResult> {
    this.assertLoaded();
    const restorePath = filePath?.trim() || (await this.latestMemoryBackupPath());
    if (!restorePath) {
      throw new Error("No memory backup found.");
    }
    const raw = await readFile(restorePath, "utf8");
    const parsed = JSON.parse(raw) as MemoryTransfer;
    const result = this.memoryManager.importSnapshot(this.state.memory, { data: parsed, mode: "replace" });
    this.state.memory = result.memory;
    await this.recordMemoryWrite("Memory restored", {
      path: restorePath,
      imported: result.imported,
    });
    await this.persistAndBroadcast();
    this.emitTyped({ type: "memory_changed", memory: this.state.memory });
    return result;
  }

  async replayMemoryRecall(input: MemoryReplayRecallInput): Promise<MemoryReplayRecallResult> {
    this.assertLoaded();
    return this.memoryManager.replayRecall(this.state.memory, {
      ...input,
      scope: input.scope || "all",
      conversationId: input.conversationId || undefined,
      subagentName: input.subagentName || undefined,
    });
  }

  async addMemoryRecallFeedback(input: MemoryRecallFeedbackInput): Promise<MemoryRecallFeedback> {
    this.assertLoaded();
    const result = this.memoryManager.recordFeedback(this.state.memory, input);
    this.state.memory = result.memory;
    await this.recordMemoryWrite("Memory recall feedback recorded", result.feedback);
    await this.persistAndBroadcast();
    this.emitTyped({ type: "memory_changed", memory: this.state.memory });
    return result.feedback;
  }

  async listMcpServers(): Promise<McpServerSnapshot[]> {
    this.assertLoaded();
    return this.mcpManager.snapshot().mcpServers;
  }

  async addMcpServer(input: McpServerInput): Promise<McpServerConfig> {
    this.assertLoaded();
    const server = this.mcpManager.add(input);
    this.state.mcpServers = [server, ...this.state.mcpServers.filter((item) => item.id !== server.id)];
    this.upsertMcpCapability();
    await this.recordMcpEvent("MCP server added", server.id, { name: server.name });
    await this.persistAndBroadcast();
    if (server.enabled && server.autoConnect) {
      await this.connectMcpServer(server.id);
    }
    return server;
  }

  async updateMcpServer(id: string, input: McpServerUpdate): Promise<McpServerConfig> {
    this.assertLoaded();
    const server = this.mcpManager.update(id, input);
    this.state.mcpServers = this.state.mcpServers.map((item) => (item.id === id ? server : item));
    this.upsertMcpCapability();
    await this.recordMcpEvent("MCP server updated", server.id, { name: server.name });
    await this.persistAndBroadcast();
    if (server.enabled && server.autoConnect) {
      await this.connectMcpServer(server.id);
    }
    return server;
  }

  async removeMcpServer(id: string): Promise<void> {
    this.assertLoaded();
    await this.mcpManager.remove(id);
    this.state.mcpServers = this.state.mcpServers.filter((item) => item.id !== id);
    this.upsertMcpCapability();
    await this.recordMcpEvent("MCP server removed", id);
    await this.persistAndBroadcast();
  }

  async connectMcpServer(id: string): Promise<McpServerStatus> {
    this.assertLoaded();
    try {
      const status = await this.mcpManager.connect(id);
      await this.persistAndBroadcast();
      return status;
    } catch (error) {
      await this.persistAndBroadcast();
      throw error;
    }
  }

  async disconnectMcpServer(id: string): Promise<McpServerStatus> {
    this.assertLoaded();
    const status = await this.mcpManager.disconnect(id);
    await this.persistAndBroadcast();
    return status;
  }

  async refreshMcpTools(id: string): Promise<McpToolInfo[]> {
    this.assertLoaded();
    const tools = await this.mcpManager.refreshTools(id);
    await this.persistAndBroadcast();
    return tools;
  }

  async getMcpLogs(id: string): Promise<McpLogRecord[]> {
    this.assertLoaded();
    return this.mcpManager.getLogs(id);
  }

  async listMcpPresets(): Promise<McpServerPreset[]> {
    this.assertLoaded();
    return this.mcpManager.listPresets();
  }

  async exportMcpConfig(): Promise<McpConfigTransfer> {
    this.assertLoaded();
    return this.mcpManager.exportConfig(this.state.permissionRules);
  }

  async importMcpConfig(input: unknown): Promise<McpImportResult> {
    this.assertLoaded();
    const result = this.mcpManager.importConfig(input);
    this.state.mcpServers = [...result.servers, ...this.state.mcpServers];
    this.upsertMcpCapability();
    await this.recordMcpEvent("MCP config imported", undefined, { imported: result.imported, skipped: result.skipped });
    await this.persistAndBroadcast();
    return result;
  }

  async diagnoseMcpServer(input: McpServerInput): Promise<McpDiagnosticResult> {
    this.assertLoaded();
    const result = await this.mcpManager.diagnose(input);
    await this.recordMcpEvent(result.ok ? "MCP diagnostic succeeded" : "MCP diagnostic failed", undefined, {
      serverName: result.serverName,
      toolCount: result.toolCount,
      error: result.error,
      durationMs: result.durationMs,
    });
    await this.persistAndBroadcast();
    return result;
  }

  startScheduler(intervalMs = 30_000): void {
    this.assertLoaded();
    if (this.schedulerTimer) {
      return;
    }
    void this.runDueScheduledJobs();
    this.schedulerTimer = setInterval(() => {
      void this.runDueScheduledJobs();
    }, intervalMs);
  }

  stopScheduler(): void {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  async shutdown(): Promise<void> {
    this.stopScheduler();
    this.resolveAllPermissions("denied");
    for (const running of this.runningJobs.values()) {
      running.controller.abort();
    }
    for (const running of this.runningAutopilotRuns.values()) {
      running.controller.abort();
    }
    await this.mcpManager.disconnectAll();
    if (this.loaded) {
      await this.servstationReverseBridgeClient.stop(false);
    }
    await this.remoteBridgeManager.stop();
    if (this.loaded) {
      await this.persistAndBroadcast();
    }
  }

  async runDueScheduledJobs(at = new Date()): Promise<number> {
    this.assertLoaded();
    const due = this.state.scheduledJobs.filter((job) => isScheduleDue(job, at));
    for (const job of due) {
      const ranAt = at.toISOString();
      const nextSchedule = nextScheduleState(job, at);
      this.state.scheduledJobs = this.state.scheduledJobs.map((item) =>
        item.id === job.id ? { ...item, ...nextSchedule, lastRunAt: ranAt, updatedAt: ranAt } : item,
      );
      await this.sendPrompt({ projectId: job.projectId, prompt: `[Scheduled] ${job.title}\n\n${job.prompt}` });
    }
    if (due.length) {
      await this.persistAndBroadcast();
    }
    return due.length;
  }

  async updateModelConfig(update: ModelConfigUpdate): Promise<ModelConfig> {
    this.assertLoaded();
    const activeProvider = this.ensureActiveModelProvider();
    await this.updateModelProvider(activeProvider.id, update);
    return this.modelConfigFromProvider(this.ensureActiveModelProvider());
  }

  async createModelProvider(update: ModelProviderUpdate): Promise<ModelProviderConfig> {
    this.assertLoaded();
    this.ensureActiveModelProvider();
    const createdAt = nowIso();
    const provider = this.applyModelProviderUpdate(
      {
        id: randomId("model_provider"),
        providerName: "",
        baseUrl: "",
        model: "",
        temperature: 0.7,
        maxTokens: 4096,
        apiKeySaved: false,
        createdAt,
        updatedAt: createdAt,
      },
      update,
    );
    this.state.modelProviders = [...this.state.modelProviders, provider];
    await this.persistAndBroadcast();
    return this.redactModelProvider(provider);
  }

  async updateModelProvider(id: string, update: ModelProviderUpdate): Promise<ModelProviderConfig> {
    this.assertLoaded();
    const provider = this.requireModelProvider(id);
    const next = this.applyModelProviderUpdate(provider, update);
    this.state.modelProviders = this.state.modelProviders.map((item) => (item.id === provider.id ? next : item));
    await this.persistAndBroadcast();
    return this.redactModelProvider(next);
  }

  async deleteModelProvider(id: string): Promise<void> {
    this.assertLoaded();
    const provider = this.requireModelProvider(id);
    if (this.state.modelProviders.length <= 1) {
      throw new Error("At least one model provider is required.");
    }
    const currentIndex = this.state.modelProviders.findIndex((item) => item.id === provider.id);
    const remaining = this.state.modelProviders.filter((item) => item.id !== provider.id);
    if (this.state.activeModelProviderId === provider.id) {
      this.state.activeModelProviderId = remaining[Math.min(currentIndex, remaining.length - 1)]?.id;
    }
    this.state.modelProviders = remaining;
    await this.persistAndBroadcast();
  }

  async setActiveModelProvider(id: string): Promise<ModelProviderConfig> {
    this.assertLoaded();
    const provider = this.requireModelProvider(id);
    this.state.activeModelProviderId = provider.id;
    await this.persistAndBroadcast();
    return this.redactModelProvider(provider);
  }

  async updateToolMarketConfig(update: ToolMarketConfigUpdate): Promise<ToolMarketConfig> {
    this.assertLoaded();
    const apiUrl = update.apiUrl.trim();
    const accountEmail = update.accountEmail?.trim() || "";
    const requestedSource = normalizeToolMarketSource(update.source);
    const next: ToolMarketConfig = {
      source:
        requestedSource === "local" && (apiUrl || accountEmail || update.password?.trim() || update.accessToken?.trim())
          ? "hybrid"
          : requestedSource,
      apiUrl,
      accountEmail,
      accessTokenSaved: false,
      passwordSaved: false,
      lastSyncedAt: this.state.toolMarketConfig.lastSyncedAt,
    };
    if (update.clearAccessToken) {
      this.state.toolMarketSecret = undefined;
    } else if (typeof update.accessToken === "string" && update.accessToken.trim()) {
      this.state.toolMarketSecret = update.accessToken.trim();
    }
    if (update.clearPassword) {
      this.state.toolMarketPasswordSecret = undefined;
    } else if (typeof update.password === "string" && update.password.trim()) {
      this.state.toolMarketPasswordSecret = update.password;
    }
    next.accessTokenSaved = Boolean(this.state.toolMarketSecret);
    next.tokenStorage = next.accessTokenSaved ? this.marketSecretStorageKind : undefined;
    next.passwordSaved = Boolean(this.state.toolMarketPasswordSecret);
    next.passwordStorage = next.passwordSaved ? this.marketSecretStorageKind : undefined;
    this.state.toolMarketConfig = next;
    await this.persistAndBroadcast();
    return redactToolMarketConfig(
      this.state.toolMarketConfig,
      this.state.toolMarketSecret,
      this.state.toolMarketPasswordSecret,
    );
  }

  async testModelConfig(update?: Partial<ModelConfigUpdate>): Promise<ModelTestResult> {
    this.assertLoaded();
    return this.testModelProvider(this.ensureActiveModelProvider().id, update);
  }

  async testModelProvider(id?: string, update?: Partial<ModelProviderUpdate>): Promise<ModelTestResult> {
    this.assertLoaded();
    const baseProvider = id
      ? this.requireModelProvider(id)
      : update
        ? { ...createInitialState().modelProviders[0], apiKeySecret: undefined }
        : this.ensureActiveModelProvider();
    const providerName = update?.providerName || baseProvider.providerName;
    const model = update?.model || baseProvider.model;
    const baseUrl = inferModelBaseUrl(providerName, model, update?.baseUrl || baseProvider.baseUrl);
    const modelConfig: ModelConfig = {
      providerName,
      baseUrl,
      model,
      temperature: update?.temperature ?? baseProvider.temperature,
      maxTokens: update?.maxTokens ?? baseProvider.maxTokens,
      apiKeySaved: Boolean(update?.apiKey || (!update?.clearApiKey && baseProvider.apiKeySecret)),
      apiKeyStorage: baseProvider.apiKeySecret ? this.secretStorageKind : undefined,
    };
    let apiKey: string;
    try {
      apiKey = normalizeModelApiKey(update?.apiKey || (update?.clearApiKey ? undefined : baseProvider.apiKeySecret));
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    if (!apiKey) {
      return {
        ok: false,
        message: "No API key configured. Fallback mode is available, but real model calls need a key.",
      };
    }
    try {
      const result = await generateReply({
        modelConfig,
        apiKey,
        personality: this.state.personality,
        messages: [
          {
            id: "model-test",
            conversationId: "model-test",
            role: "user",
            text: "Reply with exactly: HBClient model test ok",
            createdAt: nowIso(),
          },
        ],
      });
      return { ok: true, message: result.text.slice(0, 500) };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  async updatePersonality(personality: PersonalityConfig): Promise<PersonalityConfig> {
    this.assertLoaded();
    this.state.personality = {
      summary: personality.summary.trim(),
      traits: personality.traits.map((item) => item.trim()).filter(Boolean),
      instructions: personality.instructions.trim(),
    };
    await this.persistAndBroadcast();
    return this.state.personality;
  }

  async updateCapability(id: string, input: CapabilityUpdateInput): Promise<CapabilityDefinition> {
    this.assertLoaded();
    const current = this.state.capabilities.find((item) => item.id === id);
    if (!current) {
      throw new Error(`Capability not found: ${id}`);
    }
    const next: CapabilityDefinition = {
      ...current,
      name: input.name !== undefined ? requiredString(input.name, "Capability name") : current.name,
      description: input.description !== undefined ? input.description.trim() : current.description,
      enabled: input.enabled !== undefined ? Boolean(input.enabled) : current.enabled,
    };
    this.state.capabilities = this.state.capabilities.map((item) => (item.id === id ? next : item));
    await this.persistAndBroadcast();
    return next;
  }

  async deleteCapability(id: string): Promise<void> {
    this.assertLoaded();
    if (!this.state.capabilities.some((item) => item.id === id)) {
      throw new Error(`Capability not found: ${id}`);
    }
    this.state.capabilities = this.state.capabilities.filter((item) => item.id !== id);
    this.state.deletedCapabilityIds = [...new Set([...this.state.deletedCapabilityIds, id])];
    await this.persistAndBroadcast();
  }

  async saveSubagent(subagent: SubagentConfig): Promise<SubagentConfig> {
    this.assertLoaded();
    const next: SubagentConfig = {
      id: subagent.id.trim() || slug(subagent.name),
      name: requiredString(subagent.name, "Subagent name"),
      description: subagent.description.trim(),
      systemPrompt: subagent.systemPrompt.trim(),
      enabled: Boolean(subagent.enabled),
    };
    this.state.subagents = [...this.state.subagents.filter((item) => item.id !== next.id), next].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    await this.persistAndBroadcast();
    return next;
  }

  async deleteSubagent(id: string): Promise<void> {
    this.assertLoaded();
    this.state.subagents = this.state.subagents.filter((item) => item.id !== id);
    await this.persistAndBroadcast();
  }

  async listToolMarket(query: ToolMarketQuery = {}): Promise<ToolMarketCatalogItem[]> {
    this.assertLoaded();
    const local = this.state.toolMarketConfig.source === "remote" ? [] : localToolMarketProducts;
    const installed = await this.listInstalledToolMarketProducts();
    let remote: ToolMarketProduct[] = [];
    if (this.state.toolMarketConfig.source !== "local" && this.state.toolMarketConfig.apiUrl.trim()) {
      try {
        remote = await fetchRemoteToolMarketProducts(this.state.toolMarketConfig, query, this.toolMarketAuth());
        this.remoteMarketCache = remote;
        this.state.toolMarketConfig = { ...this.state.toolMarketConfig, lastSyncedAt: nowIso() };
        await this.persistAndBroadcast();
      } catch (error) {
        if (this.state.toolMarketConfig.source === "remote") {
          throw error;
        }
      }
    }
    return listToolMarketCatalog(
      uniqueMarketProducts([...local, ...remote, ...installed]),
      this.state.capabilities,
      query,
    );
  }

  async installToolMarketProduct(productId: string): Promise<ToolMarketCatalogItem> {
    this.assertLoaded();
    const product = await this.resolveMarketProduct(productId);
    if (!product) {
      throw new Error(`Tool market product not found: ${productId}`);
    }
    if (!product.free && !product.purchased) {
      throw new Error(`Tool market product must be purchased before local installation: ${product.name}`);
    }
    const deployment = product.localDeployment || defaultLocalDeployment(product);
    const installPath = await this.installToolMarketPackage(product, deployment);
    const capability: CapabilityDefinition = {
      ...(deployment.capability || product.capability),
      enabled: true,
    };
    this.state.capabilities = [...this.state.capabilities.filter((item) => item.id !== capability.id), capability];
    this.state.deletedCapabilityIds = this.state.deletedCapabilityIds.filter((id) => id !== capability.id);
    const mcpServer = this.upsertMarketMcpServer(product, deployment, installPath);
    if (mcpServer) {
      await this.recordMcpEvent("Tool market MCP installed locally", mcpServer.id, {
        productId: product.id,
        installPath,
      });
    }
    await this.persistAndBroadcast();
    if (mcpServer?.enabled && mcpServer.autoConnect) {
      await this.connectMcpServer(mcpServer.id);
    }
    return listToolMarketCatalog([product], this.state.capabilities, {}).find((item) => item.id === product.id)!;
  }

  async uninstallToolMarketProduct(productId: string): Promise<ToolMarketCatalogItem> {
    this.assertLoaded();
    const product = await this.resolveMarketProduct(productId);
    if (!product) {
      throw new Error(`Tool market product not found: ${productId}`);
    }
    const deployment = product.localDeployment || defaultLocalDeployment(product);
    const capabilityId = (deployment.capability || product.capability).id;
    await this.removeMarketMcpServer(product, deployment);
    await rm(this.localToolInstallDir(product, deployment), { recursive: true, force: true });
    await rm(this.toolMarketInstallDir(product), { recursive: true, force: true });
    this.state.capabilities = this.state.capabilities.filter((item) => item.id !== capabilityId);
    await this.persistAndBroadcast();
    return listToolMarketCatalog([product], this.state.capabilities, {}).find((item) => item.id === product.id)!;
  }

  async createScheduledJob(input: ScheduledJobInput): Promise<ScheduledJob> {
    this.assertLoaded();
    if (input.projectId) {
      this.requireConversationProject(input.projectId);
    }
    const now = nowIso();
    const job: ScheduledJob = {
      id: randomId("schedule"),
      projectId: input.projectId,
      title: input.title.trim() || titleFromPrompt(input.prompt),
      prompt: requiredString(input.prompt, "Prompt"),
      scheduleKind: input.scheduleKind,
      runAt: input.runAt,
      cronExpr: input.cronExpr,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      nextRunAt: input.runAt,
    };
    this.state.scheduledJobs = [job, ...this.state.scheduledJobs];
    await this.persistAndBroadcast();
    return job;
  }

  async updateScheduledJob(id: string, input: Partial<ScheduledJobInput>): Promise<ScheduledJob> {
    this.assertLoaded();
    const current = this.state.scheduledJobs.find((item) => item.id === id);
    if (!current) {
      throw new Error(`Scheduled job not found: ${id}`);
    }
    if (input.projectId) {
      this.requireConversationProject(input.projectId);
    }
    const next: ScheduledJob = {
      ...current,
      ...input,
      title: input.title !== undefined ? input.title.trim() : current.title,
      prompt: input.prompt !== undefined ? input.prompt.trim() : current.prompt,
      updatedAt: nowIso(),
      nextRunAt: input.runAt !== undefined ? input.runAt : current.nextRunAt,
    };
    this.state.scheduledJobs = this.state.scheduledJobs.map((item) => (item.id === id ? next : item));
    await this.persistAndBroadcast();
    return next;
  }

  async deleteScheduledJob(id: string): Promise<void> {
    this.assertLoaded();
    this.state.scheduledJobs = this.state.scheduledJobs.filter((item) => item.id !== id);
    await this.persistAndBroadcast();
  }

  async importAttachment(filePath: string): Promise<Attachment> {
    this.assertLoaded();
    const info = await stat(filePath);
    return {
      id: randomId("att"),
      name: basename(filePath),
      path: filePath,
      size: info.size,
    };
  }

  async generatedFilePath(file: GeneratedFile): Promise<string> {
    this.assertLoaded();
    return file.path;
  }

  isKnownSafePath(filePath: string): boolean {
    this.assertLoaded();
    if (!isAbsolute(filePath)) {
      return false;
    }
    const normalized = resolve(filePath);
    if (pathIsInside(this.storage.getDataDir(), normalized)) {
      return true;
    }
    const knownPaths = [
      ...this.state.worktrees.map((worktree) => worktree.path),
      ...this.state.conversations.flatMap((conversation) =>
        conversation.messages
          .flatMap((message) => [
            ...(message.attachments || [])
              .map((attachment) => attachment.path)
              .filter((path): path is string => Boolean(path)),
            ...(message.generatedFiles || []).map((file) => file.path),
          ])
          .flat(),
      ),
    ];
    return knownPaths.some((knownPath) => pathIsInside(knownPath, normalized) || resolve(knownPath) === normalized);
  }

  onEvent(listener: (event: SupbotEvent) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }

  private async runJob(jobId: string): Promise<void> {
    const job = this.findJob(jobId);
    if (!job) {
      return;
    }
    const controller = new AbortController();
    this.runningJobs.set(jobId, { controller });
    this.updateJob(jobId, "running", "Preparing model request");
    await this.persistAndBroadcast();

    try {
      const conversation = this.findConversation(job.conversationId);
      if (!conversation) {
        throw new Error("Conversation disappeared before the job could run.");
      }
      const project =
        job.projectId || conversation.projectId
          ? this.requireConversationProject(job.projectId || conversation.projectId!)
          : undefined;
      const toolContextOptions: ProjectToolContextOptions = project ? { project, allowProjectRootWrites: true } : {};
      const cwd = project?.rootPath || process.cwd();
      const subagent = resolveMentionedSubagent(job.prompt, this.state.subagents);
      const assistantSeed: ChatMessage = {
        id: randomId("msg"),
        conversationId: conversation.id,
        role: "assistant",
        text: subagent ? `@${subagent.name} is thinking...` : "HBClient is thinking...",
        createdAt: nowIso(),
        jobId,
        status: "running",
      };
      this.appendMessage(conversation.id, assistantSeed);
      this.emitTyped({ type: "message", conversationId: conversation.id, message: assistantSeed });
      const localTool = await this.executeLocalTool(job, controller.signal);
      if (localTool) {
        const trace = this.state.agentLoopTraces.find((item) => item.jobId === jobId);
        const finalMessage: ChatMessage = {
          ...assistantSeed,
          text: localTool.text,
          status: "completed",
          blocks: [...toolBlocksFromRecords(trace?.toolCalls || []), { type: "text", text: localTool.text }],
          generatedFiles: localTool.generatedFiles,
          createdAt: nowIso(),
        };
        this.replaceMessage(conversation.id, assistantSeed.id, finalMessage);
        await this.appendTranscript(conversation.id, { type: "message", message: finalMessage });
        this.updateJob(jobId, "completed", "Completed local tool command");
        await this.completeJobWorktree(jobId);
        await this.persistAndBroadcast();
        this.emitTyped({ type: "message", conversationId: conversation.id, message: finalMessage });
        return;
      }
      const modelProvider = this.ensureActiveModelProvider();
      const engine = new QueryEngine({
        id: randomId("query"),
        jobId,
        conversationId: conversation.id,
        dataDir: this.storage.getDataDir(),
        cwd,
        modelConfig: this.modelConfigFromProvider(modelProvider),
        apiKey: modelProvider.apiKeySecret,
        personality: this.state.personality,
        subagent,
        capabilities: this.state.capabilities,
        messages:
          this.findConversation(conversation.id)?.messages.filter((message) => message.id !== assistantSeed.id) || [],
        compactBoundaries: this.state.compactBoundaries,
        memory: this.state.memory,
        registry: this.toolRegistry,
        toolContext: this.createToolExecutionContext(controller.signal, jobId, 0, toolContextOptions),
        permissionMode: this.state.permissionMode,
        permissionRules: this.state.permissionRules,
        signal: controller.signal,
        requestPermission: (permission) => this.requestToolPermission(permission),
        onSession: (session) => {
          this.upsertQuerySession(session);
          this.schedulePersistAndBroadcast();
        },
        onRuntimeEvent: (event) => {
          this.addRuntimeEvent(event);
          this.schedulePersistAndBroadcast();
          this.emitTyped({ type: "query_event", event });
        },
        onMessageDelta: (delta) => {
          this.appendAssistantDelta(conversation.id, assistantSeed.id, delta);
          this.emitTyped({
            type: "message_delta",
            conversationId: conversation.id,
            messageId: assistantSeed.id,
            delta,
          });
        },
        onTrace: (trace) => {
          this.upsertTrace(trace);
          this.schedulePersistAndBroadcast();
        },
        onToolProgress: (toolCall) => {
          this.upsertToolCall(jobId, toolCall);
          this.updateJob(jobId, this.findJob(jobId)?.status || "running", `${toolCall.toolName}: ${toolCall.status}`);
          this.schedulePersistAndBroadcast();
          this.emitTyped({ type: "tool_progress", toolCall });
        },
        onCompact: (boundary) => {
          this.upsertCompactBoundary(boundary);
          this.schedulePersistAndBroadcast();
          this.emitTyped({ type: "compact", boundary });
        },
        onMemoryChanged: (memory) => {
          this.state.memory = memory;
          this.schedulePersistAndBroadcast();
          this.emitTyped({ type: "memory_changed", memory });
        },
        onMemoryCandidate: async (candidate) => {
          this.emitTyped({ type: "memory_candidate", candidate });
        },
        onPermissionTimeout: async (permission) => {
          this.resolvePermission(permission.id, "denied");
          await this.persistAndBroadcast();
          this.emitTyped({ type: "permission_timeout", permission });
        },
      });
      const response = await engine.submitTurn();
      const finalMessage: ChatMessage = {
        ...assistantSeed,
        text: response.text,
        status: "completed",
        blocks: [
          ...toolBlocksFromRecords(response.trace.toolCalls),
          ...(response.compactBoundary
            ? [
                {
                  type: "compact_summary" as const,
                  boundaryId: response.compactBoundary.id,
                  summary: response.compactBoundary.summary,
                },
              ]
            : []),
          { type: "text", text: response.text },
        ],
        generatedFiles: response.generatedFiles,
        createdAt: nowIso(),
      };
      this.replaceMessage(conversation.id, assistantSeed.id, finalMessage);
      await this.appendTranscript(conversation.id, { type: "message", message: finalMessage });
      this.updateJob(jobId, "completed", "Completed");
      await this.completeJobWorktree(jobId);
      await this.persistAndBroadcast();
      this.emitTyped({ type: "message", conversationId: conversation.id, message: finalMessage });
    } catch (error) {
      const status: JobStatus = controller.signal.aborted ? "canceled" : "failed";
      const message = controller.signal.aborted ? "Canceled by user" : (error as Error).message;
      this.updateAssistantMessageForJob(job.conversationId, jobId, status, message);
      const failedMessage = this.findConversation(job.conversationId)?.messages.find((item) => item.jobId === jobId);
      if (failedMessage) {
        await this.appendTranscript(job.conversationId, { type: "message", message: failedMessage });
      }
      this.updateJob(jobId, status, message);
      await this.finishJobWorktree(jobId, status, message);
      await this.persistAndBroadcast();
      this.emitTyped({ type: "error", message });
    } finally {
      this.runningJobs.delete(jobId);
      this.emitTyped({ type: "snapshot", snapshot: this.snapshot() });
    }
  }

  private async runAutopilot(runId: string): Promise<void> {
    if (this.runningAutopilotRuns.has(runId)) {
      return;
    }
    let run = this.requireAutopilotRun(runId);
    if (["completed", "canceled", "running"].includes(run.status)) {
      return;
    }
    const project = this.requireProject(run.projectId);
    const controller = new AbortController();
    this.runningAutopilotRuns.set(runId, { controller });
    try {
      const now = nowIso();
      run = this.patchAutopilotRun(runId, {
        status: "running",
        startedAt: run.startedAt || now,
        updatedAt: now,
        error: undefined,
      });
      await this.addAutopilotEvent(run, "info", "Autopilot supervisor started", { projectRoot: project.rootPath });
      await this.addAutopilotCheckpoint(run, "Supervisor started");
      await this.persistAndBroadcast();

      while (!controller.signal.aborted) {
        if (controller.signal.aborted) {
          break;
        }
        run = this.requireAutopilotRun(runId);
        if (run.status === "paused" || run.status === "canceled") {
          break;
        }
        if (run.status === "blocked") {
          return;
        }
        const nextTaskId = this.nextPendingAutopilotTaskId(run);
        if (!nextTaskId) {
          const alignment = await this.ensureAutopilotGoalAligned(project, run, controller.signal);
          if (alignment === "aligned") {
            break;
          }
          if (alignment === "queued-fix") {
            continue;
          }
          return;
        }
        const task = this.requireAutopilotTask(nextTaskId);
        if (task.status === "completed" || task.status === "skipped") {
          continue;
        }
        await this.runAutopilotTask(project, run, task, controller.signal);
      }

      run = this.requireAutopilotRun(runId);
      if (
        controller.signal.aborted ||
        run.status === "paused" ||
        run.status === "canceled" ||
        run.status === "blocked"
      ) {
        return;
      }
      const completed = this.state.autopilotTasks
        .filter((task) => task.runId === runId)
        .every((task) => task.status === "completed" || task.status === "skipped");
      if (completed) {
        const reportArtifact = await this.writeAutopilotRunReportArtifact(run);
        const finishedAt = nowIso();
        const next = this.patchAutopilotRun(runId, {
          status: "completed",
          artifactIds: uniqueStrings([...run.artifactIds, reportArtifact.id]),
          reportPath: reportArtifact.path,
          updatedAt: finishedAt,
          finishedAt,
        });
        this.state.dataArtifacts = [
          reportArtifact,
          ...this.state.dataArtifacts.filter((artifact) => artifact.id !== reportArtifact.id),
        ];
        await this.addAutopilotEvent(next, "info", "Autopilot data run completed", { reportPath: reportArtifact.path });
        await this.addAutopilotCheckpoint(next, "Completed all data-run stages");
        await this.persistAndBroadcast();
      }
    } catch (error) {
      const current = this.requireAutopilotRun(runId);
      if (controller.signal.aborted && (current.status === "paused" || current.status === "canceled")) {
        return;
      }
      const now = nowIso();
      const failed = this.patchAutopilotRun(runId, {
        status: "failed",
        error: (error as Error).message,
        updatedAt: now,
        finishedAt: now,
      });
      await this.addAutopilotEvent(failed, "error", "Autopilot data run failed", { error: failed.error });
      await this.addAutopilotCheckpoint(failed, `Failed: ${failed.error}`);
      await this.persistAndBroadcast();
    } finally {
      this.runningAutopilotRuns.delete(runId);
      this.emitTyped({ type: "snapshot", snapshot: this.snapshot() });
    }
  }

  private nextPendingAutopilotTaskId(run: AutopilotRun): string | undefined {
    return run.taskIds.find((taskId) => {
      const task = this.state.autopilotTasks.find((item) => item.id === taskId);
      return task && task.status !== "completed" && task.status !== "skipped";
    });
  }

  private async ensureAutopilotGoalAligned(
    project: Project,
    run: AutopilotRun,
    signal: AbortSignal,
  ): Promise<"aligned" | "queued-fix" | "blocked"> {
    if (signal.aborted) {
      return "blocked";
    }
    if (!this.canAppendAutopilotTask(run.id)) {
      const blocked = this.patchAutopilotRun(run.id, {
        status: "blocked",
        error: "Autopilot task budget exhausted before goal-output review could run.",
        updatedAt: nowIso(),
      });
      await this.addAutopilotEvent(blocked, "error", "Autopilot task budget exhausted before goal-output review");
      await this.addAutopilotCheckpoint(blocked, "Blocked: task budget exhausted before goal-output review");
      await this.persistAndBroadcast();
      return "blocked";
    }

    const reviewTask = this.appendAutopilotTask(run.id, {
      stage: "review",
      staffAgent: "reviewer",
      title: `Goal-output alignment review ${this.nextAutopilotIteration(run.id)}`,
      prompt: this.buildGoalAlignmentReviewPrompt(run.id),
    });
    let activeRun = this.requireAutopilotRun(run.id);
    await this.addAutopilotEvent(activeRun, "info", "Supervisor queued goal-output alignment review", {
      taskId: reviewTask.id,
    });
    await this.addAutopilotCheckpoint(activeRun, "Queued goal-output alignment review");
    await this.persistAndBroadcast();

    await this.runAutopilotTask(project, activeRun, reviewTask, signal);
    const completedReview = this.requireAutopilotTask(reviewTask.id);
    activeRun = this.requireAutopilotRun(run.id);
    if (
      signal.aborted ||
      activeRun.status === "paused" ||
      activeRun.status === "canceled" ||
      activeRun.status === "blocked"
    ) {
      return "blocked";
    }
    if (completedReview.status !== "completed") {
      const blocked = this.patchAutopilotRun(run.id, {
        status: "blocked",
        error: completedReview.error || "Goal-output review did not complete.",
        updatedAt: nowIso(),
      });
      await this.addAutopilotEvent(blocked, "error", "Goal-output review did not complete", {
        taskId: completedReview.id,
        error: blocked.error,
      });
      await this.addAutopilotCheckpoint(blocked, `Blocked: ${blocked.error}`);
      await this.persistAndBroadcast();
      return "blocked";
    }

    if (goalReviewPassed(completedReview.output || "")) {
      await this.addAutopilotEvent(activeRun, "info", "Goal-output review passed", { taskId: completedReview.id });
      await this.addAutopilotCheckpoint(activeRun, "Goal-output review passed");
      await this.persistAndBroadcast();
      return "aligned";
    }

    if (!this.canAppendAutopilotTask(run.id)) {
      const blocked = this.patchAutopilotRun(run.id, {
        status: "blocked",
        error: "Goal-output review failed and no task budget remains for another fix iteration.",
        updatedAt: nowIso(),
      });
      await this.addAutopilotEvent(blocked, "error", "Goal-output review failed; task budget exhausted", {
        taskId: completedReview.id,
      });
      await this.addAutopilotCheckpoint(blocked, "Blocked: goal-output review failed and task budget exhausted");
      await this.persistAndBroadcast();
      return "blocked";
    }

    const fixTask = this.appendAutopilotTask(run.id, {
      stage: "report",
      staffAgent: "analyst",
      title: `Revise outputs to match goal ${this.nextAutopilotIteration(run.id)}`,
      prompt: this.buildGoalAlignmentFixPrompt(run.id, completedReview.output || "Goal-output review failed."),
    });
    const queuedRun = this.requireAutopilotRun(run.id);
    await this.addAutopilotEvent(queuedRun, "warning", "Goal-output review failed; queued fix iteration", {
      reviewTaskId: completedReview.id,
      fixTaskId: fixTask.id,
    });
    await this.addAutopilotCheckpoint(queuedRun, "Goal-output review failed; queued fix iteration");
    await this.persistAndBroadcast();
    return "queued-fix";
  }

  private canAppendAutopilotTask(runId: string): boolean {
    const run = this.requireAutopilotRun(runId);
    return run.taskIds.length < run.writePolicy.maxTasks;
  }

  private nextAutopilotIteration(runId: string): number {
    return (
      this.state.autopilotTasks.filter(
        (task) =>
          task.runId === runId &&
          (task.title.startsWith("Goal-output alignment review") ||
            task.title.startsWith("Revise outputs to match goal")),
      ).length + 1
    );
  }

  private appendAutopilotTask(
    runId: string,
    input: Pick<AutopilotTask, "stage" | "staffAgent" | "title" | "prompt">,
  ): AutopilotTask {
    const run = this.requireAutopilotRun(runId);
    const now = nowIso();
    const task: AutopilotTask = {
      id: randomId("aptask"),
      runId: run.id,
      projectId: run.projectId,
      stage: input.stage,
      staffAgent: input.staffAgent,
      title: input.title,
      prompt: input.prompt,
      status: "queued",
      attempts: 0,
      maxAttempts: Math.max(1, run.writePolicy.maxRetries + 1),
      artifactIds: [],
      evidence: [],
      createdAt: now,
      updatedAt: now,
    };
    this.state.autopilotTasks = [...this.state.autopilotTasks, task];
    this.patchAutopilotRun(run.id, {
      taskIds: uniqueStrings([...run.taskIds, task.id]),
      updatedAt: now,
    });
    return task;
  }

  private async runAutopilotTask(
    project: Project,
    run: AutopilotRun,
    task: AutopilotTask,
    signal: AbortSignal,
  ): Promise<void> {
    let currentTask = task;
    while (currentTask.attempts < currentTask.maxAttempts) {
      if (signal.aborted) {
        return;
      }
      const startedAt = nowIso();
      currentTask = this.patchAutopilotTask(task.id, {
        status: "running",
        attempts: currentTask.attempts + 1,
        startedAt: currentTask.startedAt || startedAt,
        updatedAt: startedAt,
        error: undefined,
      });
      const activeRun = this.patchAutopilotRun(run.id, {
        status: currentTask.stage === "review" ? "reviewing" : "running",
        currentStage: currentTask.stage,
        updatedAt: startedAt,
      });
      await this.addAutopilotEvent(activeRun, "info", `${currentTask.title} started`, {
        taskId: currentTask.id,
        attempt: currentTask.attempts,
      });
      await this.addAutopilotCheckpoint(activeRun, `${currentTask.title} started`);
      await this.persistAndBroadcast();

      try {
        const result = await this.runAutopilotTaskEngine(project, activeRun, currentTask, signal);
        const artifacts = await this.artifactsFromGeneratedFiles(
          project,
          activeRun,
          currentTask,
          result.generatedFiles,
        );
        const artifactIds = artifacts.map((artifact) => artifact.id);
        this.state.dataArtifacts = [
          ...artifacts,
          ...this.state.dataArtifacts.filter((artifact) => !artifactIds.includes(artifact.id)),
        ];
        for (const artifact of artifacts) {
          this.emitTyped({ type: "data_artifact", artifact });
        }
        const finishedAt = nowIso();
        currentTask = this.patchAutopilotTask(currentTask.id, {
          status: "completed",
          output: result.text,
          artifactIds: uniqueStrings([...currentTask.artifactIds, ...artifactIds]),
          evidence: uniqueStrings([
            ...currentTask.evidence,
            ...artifacts.map((artifact) => artifact.path),
            ...extractEvidencePaths(result.text),
          ]),
          updatedAt: finishedAt,
          finishedAt,
        });
        const completedRun = this.patchAutopilotRun(run.id, {
          artifactIds: uniqueStrings([...activeRun.artifactIds, ...artifactIds]),
          evidence: uniqueStrings([...activeRun.evidence, ...currentTask.evidence]),
          updatedAt: finishedAt,
        });
        await this.addAutopilotEvent(completedRun, "info", `${currentTask.title} completed`, {
          taskId: currentTask.id,
          artifacts: artifactIds.length,
        });
        await this.addAutopilotCheckpoint(completedRun, `${currentTask.title} completed`);
        await this.persistAndBroadcast();
        return;
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        const message = (error as Error).message;
        const failedAt = nowIso();
        currentTask = this.patchAutopilotTask(currentTask.id, {
          status: currentTask.attempts >= currentTask.maxAttempts ? "blocked" : "failed",
          error: message,
          updatedAt: failedAt,
          finishedAt: currentTask.attempts >= currentTask.maxAttempts ? failedAt : undefined,
        });
        const level = currentTask.status === "blocked" ? "error" : "warning";
        const currentRun = this.requireAutopilotRun(run.id);
        await this.addAutopilotEvent(currentRun, level, `${currentTask.title} ${currentTask.status}`, {
          taskId: currentTask.id,
          error: message,
        });
        if (currentTask.status === "blocked") {
          const blocked = this.patchAutopilotRun(run.id, {
            status: "blocked",
            error: message,
            updatedAt: failedAt,
          });
          await this.addAutopilotCheckpoint(blocked, `${currentTask.title} blocked: ${message}`);
          await this.persistAndBroadcast();
          return;
        }
        await this.addAutopilotCheckpoint(currentRun, `${currentTask.title} will retry: ${message}`);
        await this.persistAndBroadcast();
      }
    }
  }

  private async runAutopilotTaskEngine(
    project: Project,
    run: AutopilotRun,
    task: AutopilotTask,
    signal: AbortSignal,
  ): Promise<{ text: string; generatedFiles: GeneratedFile[] }> {
    const staff = this.resolveStaffSubagent(task.staffAgent);
    const modelProvider = this.ensureActiveModelProvider();
    const query = new QueryEngine({
      id: randomId("query"),
      jobId: `${run.id}:${task.id}`,
      conversationId: `autopilot_${run.id}`,
      dataDir: this.storage.getDataDir(),
      cwd: project.rootPath,
      modelConfig: this.modelConfigFromProvider(modelProvider),
      apiKey: modelProvider.apiKeySecret,
      personality: this.state.personality,
      subagent: staff,
      capabilities: this.state.capabilities,
      messages: [
        {
          id: randomId("msg"),
          conversationId: `autopilot_${run.id}`,
          role: "user",
          text: this.autopilotTaskPrompt(run, task),
          createdAt: nowIso(),
        },
      ],
      compactBoundaries: this.state.compactBoundaries,
      memory: this.state.memory,
      registry: this.toolRegistry,
      toolContext: this.createToolExecutionContext(signal, `${run.id}:${task.id}`, 0, {
        project,
        policy: run.writePolicy,
      }),
      permissionMode: "bypassPermissions",
      permissionRules: this.state.permissionRules,
      signal,
      maxTurns: 8,
      requestPermission: (permission) => this.requestToolPermission(permission),
      onSession: async (session) => {
        this.upsertQuerySession(session);
        await this.persistAndBroadcast();
      },
      onRuntimeEvent: async (event) => {
        this.addRuntimeEvent(event);
        await this.addAutopilotEvent(run, "info", event.message, { taskId: task.id, runtimeEvent: event });
        await this.persistAndBroadcast();
        this.emitTyped({ type: "query_event", event });
      },
      onMessageDelta: () => undefined,
      onTrace: async (trace) => {
        this.upsertTrace(trace);
        await this.persistAndBroadcast();
      },
      onToolProgress: async (toolCall) => {
        this.upsertToolCall(toolCall.jobId, toolCall);
        await this.persistAndBroadcast();
        this.emitTyped({ type: "tool_progress", toolCall });
      },
      onCompact: async (boundary) => {
        this.upsertCompactBoundary(boundary);
        await this.persistAndBroadcast();
        this.emitTyped({ type: "compact", boundary });
      },
      onMemoryChanged: async (memory) => {
        this.state.memory = memory;
        await this.persistAndBroadcast();
        this.emitTyped({ type: "memory_changed", memory });
      },
      onMemoryCandidate: async (candidate) => {
        this.emitTyped({ type: "memory_candidate", candidate });
      },
      onPermissionTimeout: async (permission) => {
        this.resolvePermission(permission.id, "denied");
        await this.persistAndBroadcast();
        this.emitTyped({ type: "permission_timeout", permission });
      },
    });
    const result = await query.submitTurn();
    return { text: result.text, generatedFiles: result.generatedFiles };
  }

  private appendMessage(conversationId: string, message: ChatMessage): void {
    this.state.conversations = this.state.conversations.map((conversation) => {
      if (conversation.id !== conversationId) {
        return conversation;
      }
      const now = nowIso();
      return {
        ...conversation,
        title:
          conversation.title === "New conversation" && message.role === "user"
            ? titleFromPrompt(message.text)
            : conversation.title,
        updatedAt: now,
        lastMessageAt: now,
        messageCount: (conversation.messageCount ?? conversation.messages.length) + 1,
        lastMessagePreview: messagePreview(message),
        messages: [...conversation.messages, message].slice(-MAX_CONVERSATION_MESSAGES),
      };
    });
  }

  private replaceMessage(conversationId: string, messageId: string, message: ChatMessage): void {
    this.state.conversations = this.state.conversations.map((conversation) =>
      conversation.id === conversationId
        ? {
            ...conversation,
            updatedAt: nowIso(),
            lastMessageAt: nowIso(),
            lastMessagePreview: messagePreview(message),
            messages: conversation.messages.map((item) => (item.id === messageId ? message : item)),
          }
        : conversation,
    );
  }

  private updateAssistantMessageForJob(conversationId: string, jobId: string, status: JobStatus, text: string): void {
    this.state.conversations = this.state.conversations.map((conversation) => {
      if (conversation.id !== conversationId) {
        return conversation;
      }
      const messages = conversation.messages.map((message) =>
        message.jobId === jobId ? { ...message, text, status } : message,
      );
      return {
        ...conversation,
        lastMessagePreview: messagePreview(messages.at(-1)),
        messages,
      };
    });
  }

  private updateJob(jobId: string, status: JobStatus, progress: string): void {
    const now = nowIso();
    this.state.jobs = this.state.jobs.map((job) => {
      if (job.id !== jobId) {
        return job;
      }
      return {
        ...job,
        status,
        updatedAt: now,
        startedAt: status === "running" ? job.startedAt || now : job.startedAt,
        finishedAt: ["completed", "failed", "canceled"].includes(status) ? now : job.finishedAt,
        error: status === "failed" ? progress : job.error,
        progress: [...job.progress, progress].slice(-MAX_JOB_PROGRESS_ENTRIES),
      };
    });
    const updated = this.findJob(jobId);
    if (updated) {
      this.emitTyped({ type: "job", job: updated });
    }
  }

  private requireProject(id: string): Project {
    const project = this.state.projects.find((item) => item.id === id);
    if (!project) {
      throw new Error(`Project not found: ${id}`);
    }
    return project;
  }

  private requireConversationProject(id: string): Project {
    const project = this.requireProject(id);
    if (project.status === "archived") {
      throw new Error(`Project is archived: ${id}`);
    }
    return project;
  }

  private requireAutopilotRun(id: string): AutopilotRun {
    const run = this.state.autopilotRuns.find((item) => item.id === id);
    if (!run) {
      throw new Error(`Autopilot run not found: ${id}`);
    }
    return run;
  }

  private requireAutopilotTask(id: string): AutopilotTask {
    const task = this.state.autopilotTasks.find((item) => item.id === id);
    if (!task) {
      throw new Error(`Autopilot task not found: ${id}`);
    }
    return task;
  }

  private patchAutopilotRun(id: string, patch: Partial<AutopilotRun>): AutopilotRun {
    let next: AutopilotRun | undefined;
    this.state.autopilotRuns = this.state.autopilotRuns.map((run) => {
      if (run.id !== id) {
        return run;
      }
      next = { ...run, ...patch, updatedAt: patch.updatedAt || nowIso() };
      return next;
    });
    return next || this.requireAutopilotRun(id);
  }

  private patchAutopilotTask(id: string, patch: Partial<AutopilotTask>): AutopilotTask {
    let next: AutopilotTask | undefined;
    this.state.autopilotTasks = this.state.autopilotTasks.map((task) => {
      if (task.id !== id) {
        return task;
      }
      next = { ...task, ...patch, updatedAt: patch.updatedAt || nowIso() };
      return next;
    });
    return next || this.requireAutopilotTask(id);
  }

  private async addAutopilotEvent(
    run: AutopilotRun,
    level: AutopilotEvent["level"],
    message: string,
    data?: unknown,
  ): Promise<AutopilotEvent> {
    const event: AutopilotEvent = {
      id: randomId("apevent"),
      runId: run.id,
      projectId: run.projectId,
      level,
      message,
      createdAt: nowIso(),
      data,
    };
    this.state.autopilotEvents = [event, ...this.state.autopilotEvents].slice(0, 500);
    this.emitTyped({ type: "autopilot_event", event });
    return event;
  }

  private async addAutopilotCheckpoint(run: AutopilotRun, summary: string): Promise<AutopilotCheckpoint> {
    const checkpoint: AutopilotCheckpoint = {
      id: randomId("apcheck"),
      runId: run.id,
      projectId: run.projectId,
      stage: run.currentStage || "clarify",
      status: run.status,
      summary,
      taskIds: [...run.taskIds],
      artifactIds: [...run.artifactIds],
      createdAt: nowIso(),
    };
    this.state.autopilotCheckpoints = [checkpoint, ...this.state.autopilotCheckpoints];
    this.state.autopilotRuns = this.state.autopilotRuns.map((item) =>
      item.id === run.id
        ? { ...item, checkpointIds: uniqueStrings([checkpoint.id, ...item.checkpointIds]), updatedAt: nowIso() }
        : item,
    );
    await this.writeAutopilotCheckpointFile(run, checkpoint);
    return checkpoint;
  }

  private async writeAutopilotCheckpointFile(run: AutopilotRun, checkpoint: AutopilotCheckpoint): Promise<void> {
    const runDir = join(run.projectRoot, ".supbot", "runs", run.id);
    await mkdir(runDir, { recursive: true });
    const payload = {
      checkpoint,
      run: this.state.autopilotRuns.find((item) => item.id === run.id) || run,
      tasks: this.state.autopilotTasks.filter((task) => task.runId === run.id),
      artifacts: this.state.dataArtifacts.filter((artifact) => artifact.runId === run.id),
    };
    await writeFile(join(runDir, "checkpoint.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  private async artifactsFromGeneratedFiles(
    project: Project,
    run: AutopilotRun,
    task: AutopilotTask,
    files: GeneratedFile[],
  ): Promise<DataArtifact[]> {
    const artifacts: DataArtifact[] = [];
    for (const file of files) {
      if (!pathIsInside(project.rootPath, file.path)) {
        continue;
      }
      artifacts.push(await this.dataArtifactFromPath(project, run, task, file.path, task.title));
    }
    return artifacts;
  }

  private async dataArtifactFromPath(
    project: Project,
    run: AutopilotRun,
    task: Pick<AutopilotTask, "id" | "stage">,
    filePath: string,
    source: string,
  ): Promise<DataArtifact> {
    const info = await stat(filePath);
    const content = await readFile(filePath);
    const text = content.toString("utf8");
    return {
      id: randomId("artifact"),
      projectId: project.id,
      runId: run.id,
      taskId: task.id,
      kind: artifactKindForPath(project.rootPath, filePath),
      stage: task.stage,
      name: basename(filePath),
      path: filePath,
      source,
      size: info.size,
      sha256: createHash("sha256").update(content).digest("hex"),
      lineCount: text.length ? text.split(/\r?\n/).length : 0,
      createdAt: nowIso(),
    };
  }

  private async writeAutopilotRunReportArtifact(run: AutopilotRun): Promise<DataArtifact> {
    const project = this.requireProject(run.projectId);
    const reportPath = join(project.rootPath, "reports", `autopilot-${run.id}-summary.md`);
    const tasks = this.state.autopilotTasks.filter((task) => task.runId === run.id);
    const artifacts = this.state.dataArtifacts.filter((artifact) => artifact.runId === run.id);
    const content = [
      `# ${run.title}`,
      "",
      "## Goal",
      run.goal,
      "",
      "## Status",
      run.status,
      "",
      "## Artifacts",
      artifacts.length
        ? artifacts.map((artifact) => `- ${artifact.kind}: ${artifact.path}`).join("\n")
        : "- No artifacts recorded.",
      "",
      "## Stage Outputs",
      tasks
        .map((task) =>
          [`### ${task.title}`, `Status: ${task.status}`, task.output || task.error || "No output."].join("\n\n"),
        )
        .join("\n\n"),
      "",
    ].join("\n");
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, content, "utf8");
    return this.dataArtifactFromPath(
      project,
      run,
      { id: `${run.id}:summary`, stage: "review" },
      reportPath,
      "autopilot summary",
    );
  }

  private resolveStaffSubagent(name: string): SubagentConfig {
    const key = name.toLowerCase();
    const existing = this.state.subagents.find(
      (item) => item.enabled && (item.id.toLowerCase() === key || item.name.toLowerCase() === key),
    );
    if (existing) {
      return existing;
    }
    return {
      id: key || "collector",
      name: key || "collector",
      description: "Autopilot data staff-agent",
      systemPrompt:
        "You are a local data staff-agent. Work inside the approved project folders and return evidence-backed output.",
      enabled: true,
    };
  }

  private buildGoalAlignmentReviewPrompt(runId: string): string {
    const run = this.requireAutopilotRun(runId);
    const artifacts = this.state.dataArtifacts
      .filter((artifact) => artifact.runId === run.id)
      .map((artifact) => `- ${artifact.kind} ${artifact.stage}: ${artifact.path}`)
      .join("\n");
    const outputs = this.state.autopilotTasks
      .filter((task) => task.runId === run.id && task.status === "completed")
      .map((task) =>
        [
          `## ${task.stage}: ${task.title}`,
          task.output || "Completed without text output.",
          task.artifactIds.length ? `Artifacts: ${task.artifactIds.join(", ")}` : "Artifacts: none",
        ].join("\n"),
      )
      .join("\n\n");
    return [
      `Autopilot data run: ${run.title}`,
      `Project root: ${run.projectRoot}`,
      "Stage: review - Goal-output alignment review",
      "",
      "Goal:",
      run.goal,
      "",
      "Existing artifacts:",
      artifacts || "- None.",
      "",
      "Completed task outputs:",
      outputs || "- None.",
      "",
      "Review instruction:",
      "Compare the Goal against the produced artifacts, reports, analysis outputs, and task outputs.",
      "Return PASS only if the current output fully satisfies the Goal.",
      "Return FAIL if anything material is missing, stale, unsupported, or inconsistent with the Goal.",
      "",
      "Required response format:",
      "First line must be exactly one of:",
      "PASS",
      "FAIL",
      "Then provide concise evidence and, for FAIL, concrete fixes needed.",
    ].join("\n");
  }

  private buildGoalAlignmentFixPrompt(runId: string, reviewOutput: string): string {
    const run = this.requireAutopilotRun(runId);
    const artifacts = this.state.dataArtifacts
      .filter((artifact) => artifact.runId === run.id)
      .map((artifact) => `- ${artifact.kind} ${artifact.stage}: ${artifact.path}`)
      .join("\n");
    return [
      `Autopilot data run: ${run.title}`,
      `Project root: ${run.projectRoot}`,
      "Stage: report - Revise outputs to match goal",
      "",
      "Goal:",
      run.goal,
      "",
      "Latest goal-output review:",
      reviewOutput,
      "",
      "Existing artifacts:",
      artifacts || "- None.",
      "",
      "Fix instruction:",
      "Address every review failure and update project artifacts so the final output matches the Goal.",
      "Prefer updating reports and outputs in reports/ and outputs/ unless raw or processed data is genuinely incomplete.",
      "Write any revised report or analysis file inside approved project write folders.",
      "Mention every file changed and evidence path in the final answer.",
    ].join("\n");
  }

  private autopilotTaskPrompt(run: AutopilotRun, task: AutopilotTask): string {
    const artifacts = this.state.dataArtifacts
      .filter((artifact) => artifact.runId === run.id)
      .map((artifact) => `- ${artifact.kind} ${artifact.stage}: ${artifact.path}`)
      .join("\n");
    const completed = this.state.autopilotTasks
      .filter((item) => item.runId === run.id && item.status === "completed")
      .map((item) => `- ${item.stage}: ${item.output?.slice(0, 800) || "completed"}`)
      .join("\n");
    return [
      task.prompt,
      "",
      "Existing run artifacts:",
      artifacts || "- None yet.",
      "",
      "Completed stage notes:",
      completed || "- None yet.",
    ].join("\n");
  }

  private findConversation(id: string): Conversation | undefined {
    return this.state.conversations.find((item) => item.id === id);
  }

  private async recoverTranscriptsOnStartup(): Promise<void> {
    const store = new TranscriptStore(this.storage.getDataDir());
    let changed = false;
    for (const conversation of [...this.state.conversations]) {
      let result = await store.loadRecoverable(conversation.id, conversation.messages, this.state.compactBoundaries);
      const transcriptMessages = messagesFromEntries(result.entries, conversation.id);
      const missingStateMessages = messagesMissingFromTranscript(transcriptMessages, conversation.messages);
      if (missingStateMessages.length) {
        for (const message of missingStateMessages) {
          await store.append(conversation.id, { type: "message", message });
        }
        changed = true;
      }
      if (!result.entries.length && conversation.messages.length) {
        for (const boundary of this.state.compactBoundaries.filter((item) => item.conversationId === conversation.id)) {
          await store.append(conversation.id, { type: "compact", boundary });
        }
        changed = true;
      }
      if (missingStateMessages.length || (!result.entries.length && conversation.messages.length)) {
        result = await store.loadRecoverable(conversation.id, [], this.state.compactBoundaries);
      }
      const allMessages = messagesFromEntries(result.entries, conversation.id);
      const recoveredMessages = result.activeMessages.slice(-MAX_CONVERSATION_MESSAGES);
      const lastMessage = allMessages.at(-1) || recoveredMessages.at(-1);
      this.state.conversations = this.state.conversations.map((item) =>
        item.id === conversation.id
          ? {
              ...item,
              messages: recoveredMessages,
              messageCount: allMessages.length || recoveredMessages.length,
              lastMessageAt: lastMessage?.createdAt || item.lastMessageAt,
              lastMessagePreview: messagePreview(lastMessage),
            }
          : item,
      );
      if (result.diagnostics.length || result.source === "state") {
        const event: RuntimeEventRecord = {
          id: randomId("event"),
          conversationId: conversation.id,
          kind: "transcript_recovery",
          message:
            result.source === "state"
              ? `Transcript fallback used for ${conversation.title}.`
              : `Transcript checked for ${conversation.title}.`,
          createdAt: nowIso(),
          data: {
            source: result.source,
            activeMessageCount: recoveredMessages.length,
            compactBoundaryId: result.compactBoundary?.id,
            diagnostics: result.diagnostics,
          },
        };
        this.addRuntimeEvent(event);
        changed = true;
      }
    }
    if (changed) {
      await this.storage.save(this.state);
    }
  }

  private async recoverAutopilotRunsOnStartup(): Promise<void> {
    let changed = false;
    for (const run of this.state.autopilotRuns) {
      if (
        run.status !== "queued" &&
        run.status !== "planning" &&
        run.status !== "running" &&
        run.status !== "reviewing"
      ) {
        continue;
      }
      const next = this.patchAutopilotRun(run.id, {
        status: "paused",
        error: "Recovered after app restart. Resume the run to continue.",
        updatedAt: nowIso(),
      });
      await this.addAutopilotEvent(next, "warning", "Autopilot run recovered and paused after app restart");
      await this.addAutopilotCheckpoint(next, "Recovered and paused after app restart");
      changed = true;
    }
    if (changed) {
      await this.storage.save(this.state);
    }
  }

  private createToolExecutionContext(
    signal: AbortSignal,
    jobId: string,
    depth = 0,
    options: ProjectToolContextOptions = {},
  ) {
    const job = this.findRootJob(jobId);
    const worktree = job?.worktreeId ? this.worktreeManager.get(job.worktreeId) : undefined;
    const project = options.project;
    const allowedWriteRoots = project
      ? options.allowProjectRootWrites
        ? [resolve(project.rootPath)]
        : this.projectManager.absoluteAllowedWriteRoots(project.rootPath, options.policy)
      : undefined;
    const workspacePath = project?.rootPath || worktree?.path || this.rootDir;
    const allowedAttachmentPaths = this.attachmentPathsForConversation(job?.conversationId);
    const host: LocalToolHost = {
      dataDir: this.storage.getDataDir(),
      workspacePath,
      cwd: workspacePath,
      worktreeId: worktree?.id,
      projectId: project?.id,
      projectRoot: project?.rootPath,
      allowedWriteRoots,
      randomId,
      nowIso,
    };
    return {
      signal,
      workspaceMode: job?.workspaceMode || "main",
      projectId: project?.id,
      projectRoot: project?.rootPath,
      allowedWriteRoots,
      allowedAttachmentPaths,
      host,
      ensureIsolatedWorkspace: async (toolName: string) => this.ensureJobWorktree(jobId, toolName),
      inspectPackageArchive: async (input: { path: string }): Promise<LocalPackageInspection> =>
        this.inspectPackageArchive(input.path, allowedAttachmentPaths),
      installPackageArchive: async (input: {
        path: string;
        expectedSha256: string;
      }): Promise<LocalPackageInstallResult> =>
        this.installPackageArchive(input.path, input.expectedSha256, allowedAttachmentPaths, signal),
      subagents: this.state.subagents,
      runSubagent: async (input: {
        subagentType?: string;
        prompt: string;
        signal: AbortSignal;
      }): Promise<LocalToolResult> => {
        const modelProvider = this.ensureActiveModelProvider();
        const runner = new SubagentRunner({
          dataDir: this.storage.getDataDir(),
          cwd: workspacePath,
          modelConfig: this.modelConfigFromProvider(modelProvider),
          apiKey: modelProvider.apiKeySecret,
          personality: this.state.personality,
          capabilities: this.state.capabilities,
          subagents: this.state.subagents,
          compactBoundaries: this.state.compactBoundaries,
          memory: this.state.memory,
          registry: this.toolRegistry,
          permissionMode: this.state.permissionMode,
          permissionRules: this.state.permissionRules,
          randomId,
          createToolContext: (childSignal, parentJobId, childDepth) =>
            this.createToolExecutionContext(childSignal, parentJobId, childDepth, options),
          requestPermission: (permission) => this.requestToolPermission(permission),
          onSession: async (session) => {
            this.upsertQuerySession(session);
            await this.persistAndBroadcast();
          },
          onRuntimeEvent: async (event) => {
            this.addRuntimeEvent(event);
            await this.persistAndBroadcast();
            this.emitTyped({ type: "subagent_event", event });
          },
          onTrace: async (trace) => {
            this.upsertTrace(trace);
            await this.persistAndBroadcast();
          },
          onToolProgress: async (toolCall) => {
            this.upsertToolCall(toolCall.jobId, toolCall);
            await this.persistAndBroadcast();
            this.emitTyped({ type: "tool_progress", toolCall });
          },
          onCompact: async (boundary) => {
            this.upsertCompactBoundary(boundary);
            await this.persistAndBroadcast();
            this.emitTyped({ type: "compact", boundary });
          },
          onMemoryChanged: async (memory) => {
            this.state.memory = memory;
            await this.persistAndBroadcast();
            this.emitTyped({ type: "memory_changed", memory });
          },
          onMemoryCandidate: async (candidate) => {
            this.emitTyped({ type: "memory_candidate", candidate });
          },
          onPermissionTimeout: async (permission) => {
            this.resolvePermission(permission.id, "denied");
            await this.persistAndBroadcast();
            this.emitTyped({ type: "permission_timeout", permission });
          },
        });
        return runner.run({
          parentJobId: jobId,
          subagentType: input.subagentType,
          prompt: input.prompt,
          signal: input.signal,
          depth,
        });
      },
    };
  }

  private attachmentPathsForConversation(conversationId?: string): string[] {
    if (!conversationId) {
      return [];
    }
    const conversation = this.findConversation(conversationId);
    return (
      conversation?.messages.flatMap((message) =>
        (message.attachments || [])
          .map((attachment) => attachment.path)
          .filter((path): path is string => Boolean(path)),
      ) || []
    );
  }

  private assertPackageAttachmentPath(filePath: string, allowedAttachmentPaths: string[]): string {
    const resolvedPath = resolve(filePath);
    if (!allowedAttachmentPaths.some((allowedPath) => resolve(allowedPath) === resolvedPath)) {
      throw new Error("Installable package archives must be ZIP files uploaded in the current conversation.");
    }
    return resolvedPath;
  }

  private async inspectPackageArchive(
    filePath: string,
    allowedAttachmentPaths: string[],
  ): Promise<LocalPackageInspection> {
    const resolvedPath = this.assertPackageAttachmentPath(filePath, allowedAttachmentPaths);
    return this.localPackageManager.inspectArchive(resolvedPath);
  }

  private async installPackageArchive(
    filePath: string,
    expectedSha256: string,
    allowedAttachmentPaths: string[],
    signal: AbortSignal,
  ): Promise<LocalPackageInstallResult> {
    const resolvedPath = this.assertPackageAttachmentPath(filePath, allowedAttachmentPaths);
    const inspection = await this.localPackageManager.inspectArchive(resolvedPath);
    const oldManagedServerIds = this.state.mcpServers
      .filter((server) => server.source?.kind === "local-package" && server.source.packageId === inspection.id)
      .map((server) => server.id);
    await Promise.all(
      oldManagedServerIds.map((serverId) => this.mcpManager.disconnect(serverId).catch(() => undefined)),
    );
    let result: LocalPackageInstallResult;
    try {
      result = await this.localPackageManager.installArchive(resolvedPath, expectedSha256, signal);
    } catch (error) {
      await Promise.all(
        oldManagedServerIds.map((serverId) => {
          const server = this.state.mcpServers.find((item) => item.id === serverId);
          return server?.enabled && server.autoConnect
            ? this.mcpManager.connect(serverId).catch(() => undefined)
            : Promise.resolve(undefined);
        }),
      );
      throw error;
    }

    await this.reconcileLocalPackages();
    const activationWarnings: string[] = [];
    for (const serverId of result.activatedMcpServerIds) {
      const server = this.state.mcpServers.find((item) => item.id === serverId);
      if (!server?.enabled || !server.autoConnect) {
        continue;
      }
      try {
        await this.mcpManager.connect(serverId);
      } catch (error) {
        activationWarnings.push(`MCP ${server.name} failed to connect: ${(error as Error).message}`);
      }
    }
    if (activationWarnings.length) {
      await this.localPackageManager.rollbackInstall(result);
      await this.reconcileLocalPackages();
      await Promise.all(
        oldManagedServerIds.map((serverId) => {
          const server = this.state.mcpServers.find((item) => item.id === serverId);
          return server?.enabled && server.autoConnect
            ? this.mcpManager.connect(serverId).catch(() => undefined)
            : Promise.resolve(undefined);
        }),
      );
      await this.recordMcpEvent("Local package installation rolled back", undefined, {
        packageId: result.id,
        kind: result.kind,
        errors: activationWarnings,
      });
      await this.persistAndBroadcast();
      throw new Error(`Local package activation failed and was rolled back: ${activationWarnings.join("; ")}`);
    }
    await this.localPackageManager.finalizeInstall(result);
    const finalResult = activationWarnings.length
      ? { ...result, warnings: [...result.warnings, ...activationWarnings] }
      : result;
    await this.recordMcpEvent("Local package installed", undefined, {
      packageId: finalResult.id,
      kind: finalResult.kind,
      installPath: finalResult.installPath,
      mcpServers: finalResult.activatedMcpServerIds,
    });
    await this.persistAndBroadcast();
    return finalResult;
  }

  private async reconcileLocalPackages(): Promise<void> {
    const scan = await this.localPackageManager.scanInstalledPackages();
    const existingCapabilities = new Map(this.state.capabilities.map((capability) => [capability.id, capability]));
    const localCapabilityIds = new Set(scan.capabilities.map((capability) => capability.id));
    const nextLocalCapabilities = scan.capabilities.map((capability) => ({
      ...capability,
      enabled: existingCapabilities.get(capability.id)?.enabled ?? capability.enabled,
    }));
    this.state.capabilities = [
      ...this.state.capabilities.filter(
        (capability) => !isLocalPackageCapabilityId(capability.id) || localCapabilityIds.has(capability.id),
      ),
      ...nextLocalCapabilities.filter(
        (capability) => !this.state.capabilities.some((current) => current.id === capability.id),
      ),
    ].map((capability) => nextLocalCapabilities.find((item) => item.id === capability.id) || capability);

    const existingServers = new Map(this.state.mcpServers.map((server) => [server.id, server]));
    const nonLocalServers = this.state.mcpServers.filter((server) => server.source?.kind !== "local-package");
    const localServers = scan.mcpServers.map((server) => {
      const existing = existingServers.get(server.id);
      return {
        ...server,
        enabled: existing?.enabled ?? server.enabled,
        autoConnect: existing?.autoConnect ?? server.autoConnect,
        createdAt: existing?.createdAt || server.createdAt,
        updatedAt: nowIso(),
      };
    });
    this.state.mcpServers = [...nonLocalServers, ...localServers];
    this.mcpManager.setServers(this.state.mcpServers);
    this.upsertMcpCapability();
  }

  private async reconcileToolMarketCapabilities(): Promise<void> {
    const installed = await this.listInstalledToolMarketProducts();
    if (!installed.length) {
      return;
    }
    const existingCapabilities = new Map(this.state.capabilities.map((capability) => [capability.id, capability]));
    const deletedCapabilityIds = new Set(this.state.deletedCapabilityIds);
    const installedCapabilities = new Map<string, CapabilityDefinition>();
    for (const product of installed) {
      const capability = product.localDeployment?.capability || product.capability;
      if (!capability || deletedCapabilityIds.has(capability.id)) {
        continue;
      }
      installedCapabilities.set(capability.id, {
        ...capability,
        enabled: existingCapabilities.get(capability.id)?.enabled ?? capability.enabled ?? true,
      });
    }
    if (!installedCapabilities.size) {
      return;
    }
    this.state.capabilities = [
      ...this.state.capabilities.filter((capability) => !installedCapabilities.has(capability.id)),
      ...installedCapabilities.values(),
    ];
  }

  private async requestToolPermission(permission: PendingToolPermission): Promise<"approved" | "denied"> {
    if (this.runningJobs.get(permission.jobId)?.controller.signal.aborted) {
      return "denied";
    }
    this.state.pendingToolPermissions = [
      ...this.state.pendingToolPermissions.filter((item) => item.id !== permission.id),
      permission,
    ];
    await this.persistAndBroadcast();
    this.emitTyped({ type: "tool_permission", permission });
    return new Promise((resolve) => {
      this.permissionWaiters.set(permission.id, { resolve });
    });
  }

  private resolvePermission(permissionId: string, decision: "approved" | "denied"): PendingToolPermission | undefined {
    const permission = this.state.pendingToolPermissions.find((item) => item.id === permissionId);
    const waiter = this.permissionWaiters.get(permissionId);
    this.permissionWaiters.delete(permissionId);
    this.state.pendingToolPermissions = this.state.pendingToolPermissions.filter((item) => item.id !== permissionId);
    waiter?.resolve(decision);
    return permission;
  }

  private resolveJobPermissions(jobId: string, decision: "approved" | "denied"): void {
    const permissions = this.state.pendingToolPermissions.filter(
      (item) => item.jobId === jobId || item.jobId.startsWith(`${jobId}:`),
    );
    for (const permission of permissions) {
      this.resolvePermission(permission.id, decision);
    }
  }

  private resolveAllPermissions(decision: "approved" | "denied"): void {
    for (const permission of [...this.state.pendingToolPermissions]) {
      this.resolvePermission(permission.id, decision);
    }
  }

  private async ensureJobWorktree(jobId: string, toolName: string): Promise<LocalToolHost | undefined> {
    const job = this.findRootJob(jobId);
    if (!job) {
      return undefined;
    }
    if (job.workspaceMode === "readOnly") {
      throw new Error(`Read-only workspace mode blocked ${toolName}.`);
    }
    if (job.worktreeId) {
      const existing = this.worktreeManager.get(job.worktreeId);
      if (existing && existing.status !== "failed" && existing.status !== "discarded") {
        return {
          dataDir: this.storage.getDataDir(),
          workspacePath: existing.path,
          cwd: existing.path,
          worktreeId: existing.id,
          randomId,
          nowIso,
        };
      }
    }
    try {
      const rootDir = this.resolveJobWorktreeRoot(job);
      const worktree = await this.worktreeManager.createForJob(
        { jobId: job.id, conversationId: job.conversationId },
        rootDir,
      );
      this.state.worktrees = this.worktreeManager.list();
      this.markJobWorktree(worktree);
      await this.persistAndBroadcast();
      return {
        dataDir: this.storage.getDataDir(),
        workspacePath: worktree.path,
        cwd: worktree.path,
        worktreeId: worktree.id,
        randomId,
        nowIso,
      };
    } catch (error) {
      const detail = (error as Error).message;
      const checked = (error as { rootDir?: string }).rootDir || this.rootDir;
      const message = `Could not prepare an isolated workspace for ${toolName} (checked ${checked}): ${detail}. Without an isolated workspace, the writable tool cannot run safely. Initialize a Git repository at ${checked} (run \`git init && git commit --allow-empty -m "init"\`), or open the conversation in a project that is already a Git repository.`;
      const event = this.createRuntimeEvent("worktree_event", message, { toolName }, job.id, job.conversationId);
      this.addRuntimeEvent(event);
      await this.appendTranscript(job.conversationId, { type: "event", event });
      throw new Error(message, { cause: error });
    }
  }

  private resolveJobWorktreeRoot(job: AgentJob): string | undefined {
    const conversation = this.findConversation(job.conversationId);
    const projectId = job.projectId || conversation?.projectId;
    if (!projectId) {
      return undefined;
    }
    const project = this.state.projects.find((item) => item.id === projectId);
    return project?.rootPath;
  }

  private async completeJobWorktree(jobId: string): Promise<void> {
    const job = this.findRootJob(jobId);
    if (!job?.worktreeId) {
      return;
    }
    const worktree = await this.worktreeManager.complete(job.worktreeId);
    this.state.worktrees = this.worktreeManager.list();
    this.markJobWorktree(worktree);
  }

  private async finishJobWorktree(jobId: string, status: JobStatus, message: string): Promise<void> {
    const job = this.findRootJob(jobId);
    if (!job?.worktreeId) {
      return;
    }
    const worktree =
      status === "canceled"
        ? await this.worktreeManager.abandon(job.worktreeId, message)
        : await this.worktreeManager.fail(job.worktreeId, message);
    this.state.worktrees = this.worktreeManager.list();
    this.markJobWorktree(worktree);
  }

  private markJobWorktree(worktree: TaskWorktree): void {
    this.upsertWorktreeState(worktree);
    this.state.jobs = this.state.jobs.map((job) =>
      job.id === worktree.jobId
        ? {
            ...job,
            workspaceMode:
              worktree.status === "discarded" || worktree.status === "applied" ? job.workspaceMode : "isolated",
            worktreeId: worktree.id,
            baseRef: worktree.baseRef,
            diffStatus: worktree.diffStatus,
            updatedAt: nowIso(),
          }
        : job,
    );
  }

  private upsertWorktreeState(worktree: TaskWorktree): void {
    this.state.worktrees = [worktree, ...this.state.worktrees.filter((item) => item.id !== worktree.id)];
  }

  private upsertTrace(trace: RuntimeState["agentLoopTraces"][number]): void {
    this.state.agentLoopTraces = [
      trace,
      ...this.state.agentLoopTraces.filter(
        (item) => !(item.jobId === trace.jobId && item.conversationId === trace.conversationId),
      ),
    ].slice(0, 100);
  }

  private upsertToolCall(jobId: string, toolCall: RuntimeState["agentLoopTraces"][number]["toolCalls"][number]): void {
    const trace = this.state.agentLoopTraces.find((item) => item.jobId === jobId) || {
      jobId,
      conversationId: toolCall.conversationId,
      turns: 0,
      toolCalls: [],
      startedAt: toolCall.createdAt,
      updatedAt: toolCall.updatedAt,
    };
    const next = {
      ...trace,
      updatedAt: nowIso(),
      toolCalls: [...trace.toolCalls.filter((item) => item.id !== toolCall.id), toolCall],
    };
    this.upsertTrace(next);
  }

  private upsertQuerySession(session: QuerySession): void {
    this.state.querySessions = [session, ...this.state.querySessions.filter((item) => item.id !== session.id)].slice(
      0,
      100,
    );
  }

  private addRuntimeEvent(event: RuntimeEventRecord): void {
    this.state.runtimeEvents = [event, ...this.state.runtimeEvents.filter((item) => item.id !== event.id)].slice(
      0,
      300,
    );
  }

  private createRuntimeEvent(
    kind: RuntimeEventRecord["kind"],
    message: string,
    data?: unknown,
    jobId?: string,
    conversationId?: string,
  ): RuntimeEventRecord {
    return {
      id: randomId("event"),
      jobId,
      conversationId,
      kind,
      message,
      createdAt: nowIso(),
      data,
    };
  }

  private async appendTranscript(
    conversationId: string,
    entry: Parameters<TranscriptStore["append"]>[1],
  ): Promise<void> {
    try {
      await new TranscriptStore(this.storage.getDataDir()).append(conversationId, entry);
    } catch {
      // Transcript is recovery/debug data; failed writes must not break the active turn.
    }
  }

  private async recordPermissionDecision(
    permission: PendingToolPermission,
    decision: "approved" | "denied",
  ): Promise<void> {
    const event: RuntimeEventRecord = {
      id: randomId("event"),
      jobId: permission.jobId,
      conversationId: permission.conversationId,
      kind: "permission_decision",
      message: `${permission.toolName} permission ${decision}`,
      createdAt: nowIso(),
      data: { permission, decision },
    };
    this.addRuntimeEvent(event);
    await this.appendTranscript(permission.conversationId, { type: "event", event });
  }

  private async recordMemoryWrite(message: string, data: unknown, conversationId?: string): Promise<void> {
    const event: RuntimeEventRecord = {
      id: randomId("event"),
      conversationId,
      kind: "memory_write",
      message,
      createdAt: nowIso(),
      data,
    };
    this.addRuntimeEvent(event);
    if (conversationId) {
      await this.appendTranscript(conversationId, { type: "event", event });
    }
  }

  private async recordMcpEvent(message: string, serverId?: string, data?: unknown): Promise<void> {
    const event: RuntimeEventRecord = {
      id: randomId("event"),
      kind: "mcp_server",
      message,
      createdAt: nowIso(),
      data: data ? { serverId, ...objectData(data) } : { serverId },
    };
    this.addRuntimeEvent(event);
  }

  private upsertMcpCapability(): void {
    const enabled = this.state.mcpServers.some((server) => server.enabled);
    const capability: CapabilityDefinition = {
      id: "tool.mcp",
      name: "Local MCP",
      kind: "tool",
      description: "Connect local stdio MCP servers and expose their tools through the runtime permission system.",
      enabled,
    };
    this.state.capabilities = [...this.state.capabilities.filter((item) => item.id !== capability.id), capability];
  }

  private appendAssistantDelta(conversationId: string, messageId: string, delta: string): void {
    this.state.conversations = this.state.conversations.map((conversation) => {
      if (conversation.id !== conversationId) {
        return conversation;
      }
      const messages = conversation.messages.map((message) => {
        if (message.id !== messageId) {
          return message;
        }
        const current = message.text.endsWith("is thinking...") ? "" : message.text;
        const text = `${current}${delta}`;
        return {
          ...message,
          text,
          blocks: [{ type: "message_delta" as const, text }],
        };
      });
      return {
        ...conversation,
        updatedAt: nowIso(),
        lastMessageAt: nowIso(),
        lastMessagePreview: messagePreview(messages.at(-1)),
        messages,
      };
    });
  }

  private upsertCompactBoundary(boundary: CompactBoundary): void {
    this.state.compactBoundaries = [
      boundary,
      ...this.state.compactBoundaries.filter((item) => item.id !== boundary.id),
    ].slice(0, 100);
  }

  private findMemoryRecord(id: string): MemoryPage | MemoryFact | undefined {
    return [...this.state.memory.pages, ...this.state.memory.facts].find((item) => item.id === id);
  }

  private async latestMemoryBackupPath(): Promise<string | undefined> {
    const backupDir = join(this.storage.getDataDir(), "memory-backups");
    try {
      const entries = await readdir(backupDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => join(backupDir, entry.name))
        .sort()
        .at(-1);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private async executeLocalTool(job: AgentJob, signal: AbortSignal): Promise<LocalToolResult | null> {
    const trimmed = job.prompt.trim();
    const conversation = this.findConversation(job.conversationId);
    const projectId = job.projectId || conversation?.projectId;
    const project = projectId ? this.requireConversationProject(projectId) : undefined;
    const context = this.createToolExecutionContext(
      signal,
      job.id,
      0,
      project ? { project, allowProjectRootWrites: true } : {},
    );
    const executor = new ToolExecutor();
    const executeSlash = async (toolName: string, input: unknown) => {
      const envelope = await executor.execute({
        jobId: job.id,
        conversationId: job.conversationId,
        toolCall: {
          id: randomId("tool"),
          type: "function",
          function: { name: toolName, arguments: JSON.stringify(input) },
        },
        registry: this.toolRegistry,
        context,
        permissionMode: toolName === "ReadFile" ? "bypassPermissions" : this.state.permissionMode,
        permissionRules: this.state.permissionRules,
        requestPermission: (permission) => this.requestToolPermission(permission),
        onPermissionTimeout: async (permission) => {
          this.resolvePermission(permission.id, "denied");
          await this.persistAndBroadcast();
          this.emitTyped({ type: "permission_timeout", permission });
        },
        onProgress: async (toolCall) => {
          this.upsertToolCall(job.id, toolCall);
          await this.persistAndBroadcast();
          this.emitTyped({ type: "tool_progress", toolCall });
        },
      });
      return {
        text: envelope.toolResultText,
        generatedFiles: envelope.generatedFiles,
      };
    };
    if (trimmed.startsWith("/read ")) {
      const filePath = stripQuotes(trimmed.slice("/read ".length).trim());
      return executeSlash("ReadFile", { path: filePath });
    }
    if (trimmed.startsWith("/write ")) {
      const body = trimmed.slice("/write ".length);
      const newline = body.indexOf("\n");
      if (newline < 0) {
        return { text: "Usage: /write <file-name-or-path>\\n<content>" };
      }
      const target = stripQuotes(body.slice(0, newline).trim());
      const content = body.slice(newline + 1);
      return executeSlash("WriteFile", { path: target, content });
    }
    if (trimmed.startsWith("/shell ")) {
      const command = trimmed.slice("/shell ".length).trim();
      return executeSlash("Shell", { command });
    }
    return null;
  }

  private findJob(id: string): AgentJob | undefined {
    return this.state.jobs.find((item) => item.id === id);
  }

  private findRootJob(id: string): AgentJob | undefined {
    return this.findJob(id) || this.findJob(id.split(":", 1)[0]);
  }

  private async sendRemotePrompt(input: SendPromptInput): Promise<SendPromptResult> {
    return this.sendPrompt({
      ...input,
      workspaceMode: "readOnly",
    });
  }

  private async sendRemotePromptAndWait(
    input: SendPromptInput & { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<ReversePromptResult> {
    const sent = await this.sendRemotePrompt(input);
    const timeoutMs = Math.max(1_000, Math.min(300_000, Math.trunc(input.timeoutMs || 120_000)));
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      if (input.signal?.aborted) {
        throw new Error("Servstation reverse prompt was aborted.");
      }
      const job = this.findJob(sent.job.id);
      if (job && (job.status === "completed" || job.status === "failed" || job.status === "canceled")) {
        const assistant = this.findAssistantMessageForJob(job.conversationId, job.id);
        return {
          status: job.status,
          conversationId: job.conversationId,
          jobId: job.id,
          assistantText: assistant?.text,
          result: {
            assistantText: assistant?.text,
            generatedFiles: assistant?.generatedFiles || [],
            progress: job.progress,
            workspaceMode: job.workspaceMode,
          },
          error: job.error,
        };
      }
      await delay(250);
    }
    return {
      status: "failed",
      conversationId: sent.job.conversationId,
      jobId: sent.job.id,
      error: "Timed out waiting for HBClient prompt result.",
    };
  }

  async servstationA2AAccessToken(signal?: AbortSignal, forceRefresh = false): Promise<string | undefined> {
    if (this.state.servstationA2AConfig.authMode !== "oidc") {
      return this.state.servstationA2ASecret;
    }
    const tokens = parseServstationOidcSecret(this.state.servstationA2AOidcSecret);
    if (!tokens) {
      throw new Error("Servstation OIDC session is not configured.");
    }
    if (forceRefresh || oidcAccessTokenExpiringSoon(tokens)) {
      await this.refreshServstationA2AOidcSession(signal);
      return parseServstationOidcSecret(this.state.servstationA2AOidcSecret)?.accessToken;
    }
    return tokens.accessToken;
  }

  private async waitForServstationReverseConnection(timeoutMs = 45_000): Promise<ServstationA2AConfig> {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      const reverse = this.state.servstationA2AConfig.reverse;
      if (reverse?.status === "connected") {
        return this.redactServstationA2AConfig();
      }
      if (reverse?.status === "error" && reverse.lastError) {
        throw new Error(reverse.lastError);
      }
      await delay(250);
    }
    throw new Error("Timed out waiting for Servstation reverse A2A connection.");
  }

  private async updateServstationReverseState(
    input: Partial<NonNullable<ServstationA2AConfig["reverse"]>>,
  ): Promise<void> {
    this.assertLoaded();
    const current = this.state.servstationA2AConfig.reverse || { enabled: false, status: "disconnected" as const };
    const next = {
      ...current,
      ...input,
      updatedAt: nowIso(),
    };
    if (next.enabled === false) {
      next.status = "disconnected";
      next.connectedAt = undefined;
    }
    this.state.servstationA2AConfig = {
      ...this.state.servstationA2AConfig,
      reverse: next,
      updatedAt: nowIso(),
    };
    const event = this.createRuntimeEvent("servstation_a2a", `Servstation reverse A2A ${next.status}`, {
      reverse: next,
    });
    this.addRuntimeEvent(event);
    await this.persistAndBroadcast();
    this.emitTyped({ type: "servstation_a2a", config: this.redactServstationA2AConfig(), event });
  }

  private findAssistantMessageForJob(conversationId: string, jobId: string): ChatMessage | undefined {
    const conversation = this.findConversation(conversationId);
    return conversation?.messages.filter((message) => message.role === "assistant" && message.jobId === jobId).at(-1);
  }

  private redactServstationA2AConfig(): ServstationA2AConfig {
    return {
      ...this.state.servstationA2AConfig,
      bearerTokenSaved: Boolean(this.state.servstationA2ASecret),
      staffAgentPasswordSaved: Boolean(this.state.servstationA2AStaffAgentPasswordSecret),
      staffAgentPasswordStorage: this.state.servstationA2AStaffAgentPasswordSecret
        ? this.state.servstationA2AConfig.staffAgentPasswordStorage || this.secretStorageKind || "file"
        : undefined,
      oidc: this.redactServstationA2AOidcConfig(),
    };
  }

  private redactServstationA2AOidcConfig(): NonNullable<ServstationA2AConfig["oidc"]> {
    const tokens = parseServstationOidcSecret(this.state.servstationA2AOidcSecret);
    return {
      ...(this.state.servstationA2AConfig.oidc || { refreshTokenSaved: false }),
      accessTokenExpiresAt: tokens?.expiresAt || this.state.servstationA2AConfig.oidc?.accessTokenExpiresAt,
      refreshTokenSaved: Boolean(tokens?.refreshToken),
      userId: this.state.servstationA2AConfig.oidc?.userId || this.state.identityContext?.userId,
    };
  }

  private ensureActiveModelProvider(): ModelProviderState {
    if (!this.state.modelProviders.length) {
      const fallback = createInitialState().modelProviders[0];
      this.state.modelProviders = [fallback];
      this.state.activeModelProviderId = fallback.id;
      return fallback;
    }
    const active = this.state.modelProviders.find((provider) => provider.id === this.state.activeModelProviderId);
    if (active) {
      return active;
    }
    const fallback = this.state.modelProviders[0];
    this.state.activeModelProviderId = fallback.id;
    return fallback;
  }

  private requireModelProvider(id: string): ModelProviderState {
    const providerId = requiredString(id, "Model provider ID");
    const provider = this.state.modelProviders.find((item) => item.id === providerId);
    if (!provider) {
      throw new Error(`Model provider not found: ${providerId}`);
    }
    return provider;
  }

  private applyModelProviderUpdate(current: ModelProviderState, update: ModelProviderUpdate): ModelProviderState {
    const providerName = requiredString(update.providerName, "Provider name");
    const model = requiredString(update.model, "Model");
    const baseUrl = inferModelBaseUrl(providerName, model, requiredString(update.baseUrl, "Base URL"));
    const apiKey = normalizeModelApiKey(update.apiKey);
    let apiKeySecret = current.apiKeySecret;
    if (apiKey) {
      apiKeySecret = apiKey;
    } else if (update.clearApiKey) {
      apiKeySecret = undefined;
    }
    return {
      ...current,
      providerName,
      baseUrl,
      model,
      temperature: clampNumber(Number(update.temperature), 0, 2),
      maxTokens: Math.round(clampNumber(Number(update.maxTokens), 64, 128000)),
      apiKeySecret,
      apiKeySaved: Boolean(apiKeySecret),
      apiKeyStorage: apiKeySecret ? this.secretStorageKind : undefined,
      updatedAt: nowIso(),
    };
  }

  private modelConfigFromProvider(provider: ModelProviderState): ModelConfig {
    return {
      providerName: provider.providerName,
      baseUrl: provider.baseUrl,
      model: provider.model,
      temperature: provider.temperature,
      maxTokens: provider.maxTokens,
      apiKeySaved: Boolean(provider.apiKeySecret),
      apiKeyStorage: provider.apiKeySecret ? provider.apiKeyStorage || this.secretStorageKind : undefined,
    };
  }

  private redactModelProvider(provider: ModelProviderState): ModelProviderConfig {
    return {
      id: provider.id,
      providerName: provider.providerName,
      baseUrl: provider.baseUrl,
      model: provider.model,
      temperature: provider.temperature,
      maxTokens: provider.maxTokens,
      apiKeySaved: Boolean(provider.apiKeySecret),
      apiKeyStorage: provider.apiKeySecret ? provider.apiKeyStorage || this.secretStorageKind : undefined,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
    };
  }

  private async persistAndBroadcast(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.storage.save(this.state);
    this.emitTyped({ type: "snapshot", snapshot: this.snapshot() });
  }

  private schedulePersistAndBroadcast(): void {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistAndBroadcast().catch(() => undefined);
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  private emitTyped(event: SupbotEvent): void {
    this.emit("event", event);
  }

  protected assertLoaded(): void {
    if (!this.loaded) {
      throw new Error("HBClient runtime init() must be called before use.");
    }
  }

  private async listInstalledToolMarketProducts(): Promise<ToolMarketProduct[]> {
    const root = join(this.storage.getDataDir(), "tool-market");
    let originDirs: Array<{ name: string; isDirectory(): boolean }>;
    try {
      originDirs = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const products: ToolMarketProduct[] = [];
    for (const originDir of originDirs.filter((entry) => entry.isDirectory())) {
      const originPath = join(root, originDir.name);
      const productDirs = await readdir(originPath, { withFileTypes: true }).catch(() => []);
      for (const productDir of productDirs.filter((entry) => entry.isDirectory())) {
        const product = await readInstalledToolMarketProduct(join(originPath, productDir.name));
        if (product) {
          products.push(product);
        }
      }
    }
    return products;
  }

  private async installToolMarketPackage(
    product: ToolMarketProduct,
    deployment: ToolMarketLocalDeployment,
  ): Promise<string> {
    const installPath = this.localToolInstallDir(product, deployment);
    const receiptPath = this.toolMarketInstallDir(product);
    if (
      !pathIsInside(this.storage.getDataDir(), installPath) ||
      !pathIsInside(this.storage.getDataDir(), receiptPath)
    ) {
      throw new Error(`Tool market product resolved outside local data directory: ${product.name}`);
    }
    await rm(installPath, { recursive: true, force: true });
    await mkdir(installPath, { recursive: true });
    for (const file of deployment.files || []) {
      await writeToolMarketPackageFile(installPath, file);
    }
    await writeLocalToolScaffold(installPath, product, deployment);
    const manifest = {
      version: 1,
      installedAt: nowIso(),
      localKind: deployment.kind,
      localPath: installPath,
      product: {
        id: product.id,
        name: product.name,
        type: product.type,
        origin: product.origin || "local",
        providerName: product.providerName,
        description: product.description,
        tags: product.tags,
        priceLabel: product.priceLabel,
        sourceHealth: product.sourceHealth,
        purchased: product.purchased === true,
        free: product.free,
      },
      deployment: {
        kind: deployment.kind,
        capability: deployment.capability || product.capability,
        commandTemplates: deployment.commandTemplates || product.commandTemplates || [],
        mcpServer: deployment.mcpServer,
        files: (deployment.files || []).map((file) => ({
          path: file.path,
          encoding: file.encoding || "utf8",
        })),
      },
    };
    await writeFile(join(installPath, "supbot-local-tool.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await mkdir(receiptPath, { recursive: true });
    await writeFile(join(receiptPath, "supbot-market-install.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return installPath;
  }

  private upsertMarketMcpServer(
    product: ToolMarketProduct,
    deployment: ToolMarketLocalDeployment,
    installPath: string,
  ): McpServerConfig | undefined {
    const input = deployment.mcpServer;
    if (!input) {
      return undefined;
    }
    const now = nowIso();
    const id = marketMcpServerId(product, input);
    const current = this.state.mcpServers.find((server) => server.id === id);
    const command = materializeInstallPath(input.command, installPath).trim();
    if (!command) {
      throw new Error(`Tool market MCP product has no local command: ${product.name}`);
    }
    const server: McpServerConfig = {
      id,
      name: input.name.trim() || product.name,
      command,
      args: (input.args || []).map((arg) => materializeInstallPath(arg, installPath)),
      cwd: input.cwd ? materializeInstallPath(input.cwd, installPath) : installPath,
      env: input.env ? { ...input.env } : undefined,
      requestTimeoutMs: normalizeMarketMcpTimeout(input.requestTimeoutMs),
      enabled: input.enabled !== false,
      autoConnect: Boolean(input.autoConnect),
      createdAt: current?.createdAt || now,
      updatedAt: now,
      source: {
        kind: "tool-market",
        packageId: product.id,
        packageKind:
          product.type === "skill" || product.type === "plugin" || product.type === "mcp" ? product.type : undefined,
        packagePath: installPath,
        componentId: input.id || id,
      },
    };
    this.state.mcpServers = [server, ...this.state.mcpServers.filter((item) => item.id !== server.id)];
    this.mcpManager.setServers(this.state.mcpServers);
    this.upsertMcpCapability();
    return server;
  }

  private async removeMarketMcpServer(
    product: ToolMarketProduct,
    deployment: ToolMarketLocalDeployment,
  ): Promise<void> {
    if (!deployment.mcpServer) {
      return;
    }
    const serverId = marketMcpServerId(product, deployment.mcpServer);
    if (!this.state.mcpServers.some((server) => server.id === serverId)) {
      return;
    }
    await this.mcpManager.remove(serverId);
    this.state.mcpServers = this.state.mcpServers.filter((server) => server.id !== serverId);
    this.upsertMcpCapability();
    await this.recordMcpEvent("Tool market MCP uninstalled locally", serverId, { productId: product.id });
  }

  private toolMarketInstallDir(product: ToolMarketProduct): string {
    return join(this.storage.getDataDir(), "tool-market", product.origin || "local", marketInstallSlug(product.id));
  }

  private localToolInstallDir(product: ToolMarketProduct, deployment: ToolMarketLocalDeployment): string {
    return join(this.storage.getDataDir(), localToolDirName(deployment.kind), marketInstallSlug(product.id));
  }

  private async resolveMarketProduct(productId: string) {
    const local = findLocalToolMarketProduct(productId);
    if (local) {
      return local;
    }
    const cached = findMarketProduct(this.remoteMarketCache, productId);
    if (cached) {
      return cached;
    }
    const installed = findMarketProduct(await this.listInstalledToolMarketProducts(), productId);
    if (installed) {
      return installed;
    }
    if (this.state.toolMarketConfig.source === "local" || !this.state.toolMarketConfig.apiUrl.trim()) {
      return undefined;
    }
    const remote = await fetchRemoteToolMarketProducts(this.state.toolMarketConfig, {}, this.toolMarketAuth());
    return findMarketProduct(remote, productId);
  }

  private toolMarketAuth() {
    return {
      accessToken: this.state.toolMarketSecret,
      email: this.state.toolMarketConfig.accountEmail,
      password: this.state.toolMarketPasswordSecret,
    };
  }
}

export async function ensureRuntimeDirs(dataDir: string): Promise<void> {
  await mkdir(join(dataDir, "generated-files"), { recursive: true });
  await mkdir(join(dataDir, "memory-backups"), { recursive: true });
  await mkdir(join(dataDir, "tool-market"), { recursive: true });
  await mkdir(join(dataDir, "tools"), { recursive: true });
  await mkdir(join(dataDir, "skills"), { recursive: true });
  await mkdir(join(dataDir, "plugins"), { recursive: true });
  await mkdir(join(dataDir, "mcp"), { recursive: true });
}

async function writeToolMarketPackageFile(root: string, file: ToolMarketPackageFile): Promise<void> {
  const target = resolveToolMarketPackagePath(root, file.path);
  await mkdir(dirname(target), { recursive: true });
  const content = file.encoding === "base64" ? Buffer.from(file.content, "base64") : file.content;
  await writeFile(target, content);
}

async function writeLocalToolScaffold(
  root: string,
  product: ToolMarketProduct,
  deployment: ToolMarketLocalDeployment,
): Promise<void> {
  const declaredFiles = new Set((deployment.files || []).map((file) => normalizePackagePath(file.path)));
  const templates = deployment.commandTemplates || product.commandTemplates || [];
  if (deployment.kind === "skill" && !declaredFiles.has("skill.md")) {
    await writeFile(join(root, "SKILL.md"), renderSkillFile(product, templates), "utf8");
  }
  if (deployment.kind === "plugin") {
    if (!declaredFiles.has(".codex-plugin/plugin.json")) {
      await mkdir(join(root, ".codex-plugin"), { recursive: true });
      await writeFile(
        join(root, ".codex-plugin", "plugin.json"),
        `${JSON.stringify(
          {
            id: marketInstallSlug(product.id),
            name: product.name,
            version: "1.0.0",
            description: product.description,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    }
    if (!declaredFiles.has("readme.md")) {
      await writeFile(join(root, "README.md"), renderPluginReadme(product, templates), "utf8");
    }
  }
  if (deployment.kind === "tool" && !declaredFiles.has("supbot-tool.json")) {
    await writeFile(
      join(root, "supbot-tool.json"),
      `${JSON.stringify(localToolDescriptor(product, deployment), null, 2)}\n`,
      "utf8",
    );
  }
  if (deployment.kind === "mcp" && !declaredFiles.has("supbot-mcp.json")) {
    await writeFile(
      join(root, "supbot-mcp.json"),
      `${JSON.stringify(localToolDescriptor(product, deployment), null, 2)}\n`,
      "utf8",
    );
  }
}

function resolveToolMarketPackagePath(root: string, filePath: string): string {
  if (isAbsolute(filePath)) {
    throw new Error(`Tool market package file must be relative: ${filePath}`);
  }
  const target = resolve(root, filePath);
  if (!pathIsInside(root, target)) {
    throw new Error(`Tool market package file escapes install directory: ${filePath}`);
  }
  return target;
}

function defaultLocalDeployment(product: ToolMarketProduct): ToolMarketLocalDeployment {
  return {
    kind: product.type,
    capability: product.capability,
    commandTemplates: product.commandTemplates || [],
  };
}

function localToolDirName(kind: ToolMarketProduct["type"]): string {
  switch (kind) {
    case "skill":
      return "skills";
    case "plugin":
      return "plugins";
    case "mcp":
      return "mcp";
    default:
      return "tools";
  }
}

function normalizePackagePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .toLowerCase();
}

function renderSkillFile(product: ToolMarketProduct, templates: string[]): string {
  return [
    `# ${product.name}`,
    "",
    product.description,
    "",
    "## Source",
    "",
    `Installed locally from ${product.origin === "remote" ? "Tool Market" : "the built-in catalog"}.`,
    "",
    ...(templates.length
      ? ["## Templates", "", ...templates.map((template) => `- ${JSON.stringify(template)}`), ""]
      : []),
  ].join("\n");
}

function renderPluginReadme(product: ToolMarketProduct, templates: string[]): string {
  return [
    `# ${product.name}`,
    "",
    product.description,
    "",
    "Installed as a local plugin package.",
    "",
    ...(templates.length
      ? ["## Templates", "", ...templates.map((template) => `- ${JSON.stringify(template)}`), ""]
      : []),
  ].join("\n");
}

function localToolDescriptor(
  product: ToolMarketProduct,
  deployment: ToolMarketLocalDeployment,
): Record<string, unknown> {
  return {
    id: product.id,
    name: product.name,
    kind: deployment.kind,
    description: product.description,
    commandTemplates: deployment.commandTemplates || product.commandTemplates || [],
    mcpServer: deployment.mcpServer,
  };
}

async function readInstalledToolMarketProduct(installPath: string): Promise<ToolMarketProduct | undefined> {
  try {
    const raw = await readFile(join(installPath, "supbot-market-install.json"), "utf8");
    return installedManifestToProduct(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

function installedManifestToProduct(manifest: Record<string, unknown>): ToolMarketProduct | undefined {
  const product = objectRecord(manifest.product);
  const deployment = objectRecord(manifest.deployment);
  const id = stringRecordValue(product, "id");
  const name = stringRecordValue(product, "name") || id;
  if (!id || !name) {
    return undefined;
  }
  const type = normalizeMarketProductType(stringRecordValue(product, "type"));
  const description = stringRecordValue(product, "description") || "Installed local tool market product.";
  const capability = manifestCapability(deployment.capability, {
    id: `market.installed.${marketInstallSlug(id)}`,
    name,
    kind: type === "plugin" || type === "mcp" ? type : type === "skill" ? "skill" : "tool",
    description,
    enabled: true,
  });
  const commandTemplates = stringArrayValue(deployment.commandTemplates);
  const mcpServer = manifestMcpServer(deployment.mcpServer);
  const tags = stringArrayValue(product.tags);
  return {
    id,
    name,
    type,
    origin: stringRecordValue(product, "origin") === "remote" ? "remote" : "local",
    providerName: stringRecordValue(product, "providerName") || "Tool Market",
    description,
    tags: tags.length ? tags : ["installed", type],
    free: product.free === false ? false : true,
    priceLabel: stringRecordValue(product, "priceLabel"),
    purchased: product.purchased === true,
    sourceHealth: stringRecordValue(product, "sourceHealth"),
    capability,
    commandTemplates,
    localDeployment: {
      kind: normalizeMarketProductType(stringRecordValue(deployment, "kind") || type),
      capability,
      ...(commandTemplates.length ? { commandTemplates } : {}),
      ...(mcpServer ? { mcpServer } : {}),
    },
  };
}

function uniqueMarketProducts(products: ToolMarketProduct[]): ToolMarketProduct[] {
  const byId = new Map<string, ToolMarketProduct>();
  for (const product of products) {
    byId.set(product.id, product);
  }
  return [...byId.values()];
}

function normalizeMarketProductType(value: unknown): ToolMarketProduct["type"] {
  return value === "skill" || value === "plugin" || value === "mcp" || value === "tool" ? value : "tool";
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringRecordValue(value: Record<string, unknown>, key: string): string | undefined {
  const entry = value[key];
  return typeof entry === "string" && entry.trim() ? entry.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function manifestCapability(value: unknown, fallback: CapabilityDefinition): CapabilityDefinition {
  const input = objectRecord(value);
  return {
    id: stringRecordValue(input, "id") || fallback.id,
    name: stringRecordValue(input, "name") || fallback.name,
    kind: normalizeCapabilityKind(input.kind, fallback.kind),
    description: stringRecordValue(input, "description") || fallback.description,
    enabled: input.enabled !== false,
  };
}

function normalizeCapabilityKind(value: unknown, fallback: CapabilityDefinition["kind"]): CapabilityDefinition["kind"] {
  return value === "skill" ||
    value === "tool" ||
    value === "plugin" ||
    value === "mcp" ||
    value === "subagent" ||
    value === "scheduler" ||
    value === "storage"
    ? value
    : fallback;
}

function manifestMcpServer(value: unknown): ToolMarketMcpDeployment | undefined {
  const input = objectRecord(value);
  const name = stringRecordValue(input, "name");
  const command = stringRecordValue(input, "command");
  if (!name || !command) {
    return undefined;
  }
  return {
    id: stringRecordValue(input, "id"),
    name,
    command,
    args: stringArrayValue(input.args),
    cwd: stringRecordValue(input, "cwd"),
    env: manifestEnv(input.env),
    requestTimeoutMs: normalizeMarketMcpTimeout(input.requestTimeoutMs),
    enabled: input.enabled !== false,
    autoConnect: Boolean(input.autoConnect),
  };
}

function manifestEnv(value: unknown): Record<string, string> | undefined {
  const input = objectRecord(value);
  const entries = Object.entries(input)
    .filter(([key, entry]) => key.trim() && typeof entry === "string")
    .map(([key, entry]) => [key.trim(), entry as string]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function marketMcpServerId(product: ToolMarketProduct, input: ToolMarketMcpDeployment): string {
  return sanitizeMarketId(input.id || `market-${product.id}`);
}

function sanitizeMarketId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "market-tool"
  );
}

function marketInstallSlug(value: string): string {
  return sanitizeMarketId(value);
}

function materializeInstallPath(value: string, installPath: string): string {
  return value.replace(/\{(?:installDir|productDir)\}/g, installPath);
}

function normalizeMarketMcpTimeout(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(120_000, Math.max(1_000, Math.round(value)));
}

export function redactModelConfig(config: ModelConfig, secret?: string): ModelConfig {
  return {
    ...config,
    apiKeySaved: Boolean(secret),
    apiKeyStorage: secret ? config.apiKeyStorage || "file" : undefined,
  };
}

export function redactToolMarketConfig(
  config: ToolMarketConfig,
  secret?: string,
  passwordSecret?: string,
): ToolMarketConfig {
  return {
    ...config,
    accessTokenSaved: Boolean(secret),
    passwordSaved: Boolean(passwordSecret),
    tokenStorage: secret ? config.tokenStorage || "file" : undefined,
    passwordStorage: passwordSecret ? config.passwordStorage || "file" : undefined,
  };
}

export function resolveMentionedSubagent(prompt: string, subagents: SubagentConfig[]): SubagentConfig | undefined {
  const match = prompt.match(/@([\w-]+)/);
  if (!match) {
    return undefined;
  }
  const key = match[1].toLowerCase();
  return subagents.find((item) => item.enabled && (item.id.toLowerCase() === key || item.name.toLowerCase() === key));
}

function titleFromPrompt(prompt: string): string {
  const clean = prompt.trim().replace(/\s+/g, " ");
  return clean ? clean.slice(0, 60) : "New conversation";
}

function safeProjectSlug(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .slice(0, 60)
    .replace(/[.\s-]+$/g, "");
  const slug = normalized || "project";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(slug) ? `${slug}-project` : slug;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function requiredString(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}

function emptyToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function inferModelBaseUrl(providerName: string, model: string, baseUrl: string): string {
  const lowerName = `${providerName} ${model}`.toLowerCase();
  if (lowerName.includes("deepseek") && /^https:\/\/api\.openai\.com\/v1\/?$/i.test(baseUrl)) {
    return "https://api.deepseek.com/v1";
  }
  return baseUrl;
}

function normalizeHttpUrl(value: string): string | undefined {
  if (!value.trim()) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Servstation A2A URL must use http or https.");
    }
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/+$/, "");
  } catch (error) {
    if (error instanceof Error && error.message.includes("http or https")) {
      throw error;
    }
    throw new Error("Servstation A2A URL is invalid.", { cause: error });
  }
}

function normalizeDataSources(sources: DataSourceSpec[]): DataSourceSpec[] {
  return sources.map((source) => ({
    id: source.id?.trim() || randomId("source"),
    kind: normalizeDataSourceKind(source.kind),
    label:
      source.label?.trim() || source.path || source.url || source.mcpToolName || source.shellCommand || "Data source",
    path: source.path?.trim() || undefined,
    paths: Array.isArray(source.paths)
      ? source.paths.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
      : undefined,
    url: source.url?.trim() || undefined,
    method: source.method === "POST" ? "POST" : source.method === "GET" ? "GET" : undefined,
    headers: source.headers && typeof source.headers === "object" ? source.headers : undefined,
    body: source.body,
    mcpToolName: source.mcpToolName?.trim() || undefined,
    shellCommand: source.shellCommand?.trim() || undefined,
  }));
}

function normalizeDataSourceKind(kind: DataSourceSpec["kind"]): DataSourceSpec["kind"] {
  return kind === "localFiles" ||
    kind === "folderScan" ||
    kind === "httpApi" ||
    kind === "webUrl" ||
    kind === "mcpTool" ||
    kind === "shellCommand"
    ? kind
    : "folderScan";
}

function artifactKindForPath(projectRoot: string, filePath: string): DataArtifactKind {
  const rel = relative(projectRoot, filePath).replace(/\\/g, "/").toLowerCase();
  if (rel.startsWith("datasets/raw/")) {
    return "raw";
  }
  if (rel.startsWith("datasets/processed/")) {
    return "processed";
  }
  if (rel.startsWith("reports/")) {
    return "report";
  }
  if (rel.startsWith("outputs/")) {
    return "analysis";
  }
  return "output";
}

function extractEvidencePaths(text: string): string[] {
  const matches = text.match(/[A-Za-z]:[\\/][^\s`'")]+|(?:datasets|outputs|reports|\.supbot)[\\/][^\s`'")]+/g) || [];
  return uniqueStrings(matches.map((item) => item.replace(/[.,;:]+$/, "")));
}

function goalReviewPassed(text: string): boolean {
  const firstMeaningfulLine =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || "";
  if (/^PASS\b/i.test(firstMeaningfulLine)) {
    return true;
  }
  if (/^FAIL\b/i.test(firstMeaningfulLine)) {
    return false;
  }
  return /\bPASS\b/i.test(text) && !/\bFAIL\b/i.test(text);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || randomId("subagent")
  );
}

function normalizeToolMarketSource(value: ToolMarketConfigUpdate["source"]): ToolMarketConfig["source"] {
  return value === "remote" || value === "hybrid" || value === "local" ? value : "local";
}

function normalizePermissionMode(value: PermissionMode): PermissionMode {
  return value === "acceptEdits" || value === "bypassPermissions" || value === "plan" || value === "default"
    ? value
    : "default";
}

function pathIsInside(parent: string, child: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  const relativePath = relative(resolvedParent, resolvedChild);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function objectData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value };
  }
  return value as Record<string, unknown>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toolBlocksFromRecords(records: ToolCallRecord[]): ChatMessageBlock[] {
  return records.flatMap((record) => {
    const status = record.status === "pending_permission" ? "pending" : record.status;
    const useBlock: ChatMessageBlock = {
      type: "tool_use",
      toolCallId: record.id,
      toolName: record.toolName,
      input: record.input,
      status:
        status === "denied" || status === "failed" || status === "completed" || status === "running"
          ? status
          : "pending",
    };
    const resultText = record.output || record.error;
    if (!resultText) {
      return [useBlock];
    }
    return [
      useBlock,
      {
        type: "tool_result",
        toolCallId: record.id,
        toolName: record.toolName,
        output: resultText,
        isError: Boolean(record.error),
        outputParts: record.outputParts,
        outputTruncated: record.outputTruncated,
      },
    ];
  });
}

function summarizeConversationForManualCompact(messages: ChatMessage[]): string {
  const recent = messages
    .filter((message) => message.role !== "system")
    .slice(-12)
    .map((message) => `${message.role}: ${message.text.replace(/\s+/g, " ").slice(0, 280)}`)
    .join("\n");
  return [
    "Manual compact summary:",
    recent || "No prior messages.",
    "",
    "Continue from this summary and the preserved recent messages. Do not treat this as permanent memory.",
  ].join("\n");
}

function messagePreview(message?: ChatMessage): string | undefined {
  const preview = message?.text.replace(/\s+/g, " ").trim();
  return preview ? preview.slice(0, 180) : undefined;
}

function messagesMissingFromTranscript(transcriptMessages: ChatMessage[], stateMessages: ChatMessage[]): ChatMessage[] {
  const transcriptIds = new Set(transcriptMessages.map((message) => message.id));
  const transcriptSignatures = new Set(transcriptMessages.map(messageRecoverySignature));
  return stateMessages.filter(
    (message) => !transcriptIds.has(message.id) && !transcriptSignatures.has(messageRecoverySignature(message)),
  );
}

function messageRecoverySignature(message: ChatMessage): string {
  return [message.role, message.jobId || "", message.text].join("\u0000");
}

function isScheduleDue(job: ScheduledJob, at: Date): boolean {
  if (!job.enabled) {
    return false;
  }
  if (job.scheduleKind === "cron") {
    if (!job.cronExpr || job.lastRunAt?.slice(0, 16) === at.toISOString().slice(0, 16)) {
      return false;
    }
    return cronMatches(job.cronExpr, at);
  }
  const next = job.nextRunAt || job.runAt;
  return Boolean(next && new Date(next).getTime() <= at.getTime());
}

function isLocalPackageCapabilityId(id: string): boolean {
  return id.startsWith("local.skill.") || id.startsWith("local.plugin.") || id.startsWith("local.mcp.");
}

function nextScheduleState(job: ScheduledJob, at: Date): Pick<ScheduledJob, "enabled" | "nextRunAt"> {
  if (job.scheduleKind === "once") {
    return { enabled: false, nextRunAt: undefined };
  }
  if (job.scheduleKind === "daily") {
    const base = job.runAt ? new Date(job.runAt) : at;
    const next = new Date(at);
    next.setHours(base.getHours(), base.getMinutes(), 0, 0);
    if (next.getTime() <= at.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return { enabled: true, nextRunAt: next.toISOString() };
  }
  return { enabled: true, nextRunAt: undefined };
}

function cronMatches(expr: string, at: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return false;
  }
  const values = [at.getMinutes(), at.getHours(), at.getDate(), at.getMonth() + 1, at.getDay()];
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ] as const;
  return parts.every((part, index) => cronPartMatches(part, values[index], ranges[index][0], ranges[index][1]));
}

function cronPartMatches(part: string, value: number, min: number, max: number): boolean {
  return part.split(",").some((token) => {
    if (token === "*") {
      return true;
    }
    if (token.startsWith("*/")) {
      const step = Number(token.slice(2));
      return Number.isInteger(step) && step > 0 && value % step === 0;
    }
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      return start >= min && end <= max && value >= start && value <= end;
    }
    const exact = Number(token);
    return Number.isInteger(exact) && exact >= min && exact <= max && value === exact;
  });
}
