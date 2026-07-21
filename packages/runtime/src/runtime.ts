import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  clampNumber,
  type AgentJob,
  type AgentLoopTrace,
  type Attachment,
  type AutopilotActionRecord,
  type AutopilotApprovalDecisionInput,
  type AutopilotCheckpoint,
  type AutopilotEvent,
  type AutopilotRun,
  type AutopilotRunReport,
  type AutopilotRunMetrics,
  type AutopilotQualitySummary,
  type AutopilotStartDataRunInput,
  type AutopilotStartInput,
  type AutopilotTask,
  type AutopilotValidationCheck,
  type AutopilotWritePolicy,
  type CapabilityDefinition,
  type ChatMessage,
  type ChatMessageBlock,
  type CompactBoundary,
  type Conversation,
  type DataArtifact,
  type DataArtifactKind,
  type DataSourceSpec,
  type GeneratedFile,
  type IdentityContext,
  type JobStatus,
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
  type ModelTestResult,
  type CapabilityUpdateInput,
  nowIso,
  type PendingToolPermission,
  type PermissionMode,
  type PermissionRule,
  type PersonalityConfig,
  type Project,
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
  type ServstationAutopilotRun,
  type ServstationAutopilotStartInput,
  type ServstationAutopilotStatusUpdate,
  type ServstationClientSnapshot,
  type ServstationClientSnapshotQuery,
  type ServstationConversation,
  type ServstationFlowEngineApprovalDecisionInput,
  type ServstationFlowEngineExecutionEvent,
  type ServstationFlowEngineInitiatedExecution,
  type ServstationFlowEngineLaunchInput,
  type ServstationFlowEnginePendingTask,
  type ServstationFlowEngineSnapshot,
  type ServstationMailAccount,
  type ServstationMailAccountDraft,
  type ServstationMailConnectionTestResult,
  type ServstationMessageAttachmentContent,
  type ServstationMessageDetail,
  type ServstationMessageEvent,
  type ServstationMessageFolder,
  type ServstationMessageListResponse,
  type ServstationMessageUnreadSummary,
  type ServstationScheduledJob,
  type ServstationScheduledJobInput,
  type ServstationSendAgentMessageInput,
  type ServstationSendDirectMessageInput,
  type ServstationSendPromptInput,
  type ServstationSendPromptResult,
  type ServstationSessionJob,
  type ServstationSkillSummary,
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
  type ToolMarketQuery
} from "@supbot/shared";
import { AutopilotOrchestrator } from "./autopilotOrchestrator";
import { calculateAutopilotMetrics, summarizeAutopilotQuality } from "./autopilotMetrics";
import {
  extractReviewViolations,
  formatAutopilotApprovalHistory,
  goalReviewPassed,
  resetAutopilotBudgetWindow,
  sumOptionalNumber
} from "./autopilotRuntime";
import {
  autopilotBudgetExceeded,
  canTransitionAutopilot,
  classifyAutopilotFailure,
  compactAutopilotContext,
  createAutopilotBudget,
  createAutopilotGoalSpec,
  progressFingerprint,
  resolveAutopilotProfile,
  validateAutopilotPlan
} from "./autopilotLoop";
import { AutopilotRunStore } from "./autopilotRunStore";
import { runShellCommand, stripQuotes, type LocalToolHost, type LocalToolResult } from "./localTools";
import { MemoryManager } from "./memoryManager";
import { McpManager } from "./mcpManager";
import { stableJson } from "./jsonUtils";
import { generateReply } from "./modelProbe";
import { pathIsInside } from "./pathUtils";
import { ProjectManager } from "./projectManager";
import { QueryEngine } from "./queryEngine";
import { RemoteBridgeManager } from "./remoteBridgeManager";
import { ServstationAgentClient } from "./servstationAgentClient";
import { ServstationA2AProvider } from "./servstationA2AProvider";
import { ServstationReverseBridgeClient, type ReversePromptResult } from "./servstationReverseBridgeClient";
import {
  identityContextFromAccessToken,
  oidcAccessTokenExpiringSoon,
  parseServstationOidcSecret,
  refreshServstationOidcTokenSet,
  serializeServstationOidcSecret
} from "./servstationOidc";
import { createInitialState, normalizeIdentityContext, type RuntimeState, type StorageAdapter } from "./storage";
import { SubagentRunner } from "./subagentRunner";
import { ToolExecutor } from "./toolExecutor";
import { ToolRegistry } from "./toolRegistry";
import { TranscriptStore } from "./transcriptStore";
import { fetchRemoteToolMarketProducts, findLocalToolMarketProduct, findMarketProduct, listToolMarketCatalog, localToolMarketProducts } from "./toolMarket";
import {
  defaultLocalDeployment,
  localToolDirName,
  marketInstallSlug,
  marketMcpServerId,
  materializeInstallPath,
  normalizeMarketMcpTimeout,
  resolveToolMarketPackagePath,
  uniqueMarketProducts
} from "./toolMarketRuntime";
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
  task?: AutopilotTask;
  workspacePath?: string;
  allowedWriteRoots?: string[];
  directWriteBackupRoot?: string;
}

interface PendingPermissionWaiter {
  resolve(decision: "approved" | "denied"): void;
}

export class SupbotRuntime extends EventEmitter {
  private state: RuntimeState = createInitialState();
  private readonly runningJobs = new Map<string, RunningJob>();
  private readonly runningAutopilotRuns = new Map<string, RunningAutopilotRun>();
  private readonly permissionWaiters = new Map<string, PendingPermissionWaiter>();
  private readonly importedAttachmentPaths = new Set<string>();
  private readonly toolRegistry = new ToolRegistry();
  private readonly mcpManager: McpManager;
  private readonly servstationA2AProvider: ServstationA2AProvider;
  private readonly servstationAgentClient: ServstationAgentClient;
  private readonly worktreeManager: WorktreeManager;
  private readonly remoteBridgeManager: RemoteBridgeManager;
  private readonly servstationReverseBridgeClient: ServstationReverseBridgeClient;
  private readonly memoryManager = new MemoryManager({ randomId, nowIso });
  private readonly projectManager = new ProjectManager({ randomId, nowIso });
  private readonly autopilotOrchestrator = new AutopilotOrchestrator({ randomId, nowIso });
  private readonly autopilotRunStore = new AutopilotRunStore();
  private readonly autopilotMetricsCache = new Map<string, { updatedAt: string; metrics: AutopilotRunMetrics }>();
  private remoteMarketCache: ToolMarketProduct[] = [];
  private loaded = false;
  private readonly secretStorageKind: ModelConfig["apiKeyStorage"];
  private readonly marketSecretStorageKind: ToolMarketConfig["tokenStorage"];
  private readonly rootDir: string;
  private schedulerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly storage: StorageAdapter, options: { secretStorageKind?: ModelConfig["apiKeyStorage"]; marketSecretStorageKind?: ToolMarketConfig["tokenStorage"]; rootDir?: string } = {}) {
    super();
    this.secretStorageKind = options.secretStorageKind || "file";
    this.marketSecretStorageKind = options.marketSecretStorageKind || this.secretStorageKind || "file";
    this.rootDir = options.rootDir || process.cwd();
    this.mcpManager = new McpManager({
      randomId,
      nowIso,
      onEvent: async (event) => {
        const record: RuntimeEventRecord = {
          id: randomId("event"),
          kind: event.kind,
          message: event.message,
          createdAt: nowIso(),
          data: event.data ? { serverId: event.serverId, ...objectData(event.data) } : { serverId: event.serverId }
        };
        this.addRuntimeEvent(record);
        if (this.loaded) {
          await this.persistAndBroadcast();
          this.emitTyped({ type: "query_event", event: record });
        }
      }
    });
    this.worktreeManager = new WorktreeManager({
      dataDir: this.storage.getDataDir(),
      rootDir: this.rootDir,
      randomId,
      nowIso,
      onEvent: async (event) => {
        this.upsertWorktreeState(event.worktree);
        const record = this.createRuntimeEvent("worktree_event", event.message, {
          worktreeId: event.worktree.id,
          status: event.worktree.status,
          path: event.worktree.path,
          data: event.data
        }, event.worktree.jobId, event.worktree.conversationId);
        this.addRuntimeEvent(record);
        if (this.loaded) {
          await this.persistAndBroadcast();
          this.emitTyped({ type: "worktree_event", worktree: event.worktree, event: record });
        }
      }
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
      }
    });
    this.servstationA2AProvider = new ServstationA2AProvider({
      getConfig: () => this.state.servstationA2AConfig,
      getAccessToken: (signal) => this.servstationA2AAccessToken(signal),
      getIdentityContext: () => this.state.identityContext,
      updateConfig: (input) => this.updateServstationA2AConfig(input),
      randomId
    });
    this.servstationReverseBridgeClient = new ServstationReverseBridgeClient({
      getConfig: () => this.state.servstationA2AConfig,
      getAccessToken: (signal) => this.servstationA2AAccessToken(signal),
      getIdentityContext: () => this.state.identityContext,
      getSnapshot: () => this.snapshot(),
      loadTranscript: (conversationId) => this.loadTranscript(conversationId),
      updateConfig: (input) => this.updateServstationA2AConfig(input),
      updateReverseState: (input) => this.updateServstationReverseState(input),
      sendReadOnlyPromptAndWait: (input) => this.sendRemotePromptAndWait(input),
      randomId,
      nowIso
    });
    this.servstationAgentClient = new ServstationAgentClient({
      getConfig: () => this.state.servstationA2AConfig,
      getAccessToken: (signal) => this.servstationA2AAccessToken(signal),
      getIdentityContext: () => this.state.identityContext,
      updateConfig: (input) => this.updateServstationA2AConfig(input),
      randomId,
      nowIso,
      isAllowedAttachmentPath: (filePath) => this.isAllowedAttachmentPath(filePath)
    });
    this.toolRegistry.addProvider(this.mcpManager);
    this.toolRegistry.addProvider(this.servstationA2AProvider);
  }

  async init(): Promise<RuntimeSnapshot> {
    await ensureRuntimeDirs(this.storage.getDataDir());
    this.state = await this.storage.load();
    this.resetServstationReverseStartupState();
    this.mcpManager.setServers(this.state.mcpServers);
    this.worktreeManager.setWorktrees(this.state.worktrees);
    this.loaded = true;
    await this.recoverTranscriptsOnStartup();
    await this.recoverAutopilotRunsOnStartup();
    await this.remoteBridgeManager.configure({
      config: this.state.remoteBridgeConfig,
      token: this.state.remoteBridgeSecret,
      sessions: this.state.remoteBridgeSessions,
      audit: this.state.remoteBridgeAudit
    });
    await this.mcpManager.autoConnectEnabled();
    if (this.state.servstationA2AConfig.reverse?.enabled) {
      this.servstationReverseBridgeClient.start();
    }
    return this.snapshot();
  }

  private resetServstationReverseStartupState(): void {
    const reverse = this.state.servstationA2AConfig.reverse;
    if (!reverse?.enabled || reverse.status === "disconnected") {
      return;
    }
    this.state.servstationA2AConfig = {
      ...this.state.servstationA2AConfig,
      reverse: {
        ...reverse,
        status: "disconnected",
        connectedAt: undefined,
        lastHeartbeatAt: undefined,
        lastError: undefined,
        updatedAt: nowIso()
      },
      updatedAt: nowIso()
    };
  }

  snapshot(): RuntimeSnapshot {
    this.assertLoaded();
    const autopilotMetrics = this.state.autopilotRuns.map((run) => this.calculateAutopilotRunMetrics(run.id));
    return {
      status: this.runningJobs.size || this.runningAutopilotRuns.size ? "running" : "ready",
      agentName: this.state.agentName,
      identityContext: this.state.identityContext,
      modelConfig: redactModelConfig(this.state.modelConfig, this.state.modelSecret),
      toolMarketConfig: redactToolMarketConfig(this.state.toolMarketConfig, this.state.toolMarketSecret, this.state.toolMarketPasswordSecret),
      personality: this.state.personality,
      capabilities: this.state.capabilities,
      subagents: this.state.subagents,
      conversations: this.state.conversations,
      jobs: this.state.jobs,
      scheduledJobs: this.state.scheduledJobs,
      projects: this.state.projects,
      autopilotRuns: this.state.autopilotRuns,
      autopilotTasks: this.state.autopilotTasks,
      autopilotEvents: this.state.autopilotEvents,
      autopilotCheckpoints: this.state.autopilotCheckpoints,
      autopilotActions: this.state.autopilotActions,
      autopilotMetrics,
      autopilotQuality: this.calculateAutopilotQuality(autopilotMetrics),
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
        config: this.redactServstationA2AConfig()
      }
    };
  }

  async createConversation(title = "New conversation"): Promise<Conversation> {
    this.assertLoaded();
    const now = nowIso();
    const conversation: Conversation = {
      id: randomId("conv"),
      title,
      createdAt: now,
      updatedAt: now,
      messages: []
    };
    this.state.conversations = [conversation, ...this.state.conversations];
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
    this.state.pendingToolPermissions = this.state.pendingToolPermissions.filter((item) => !belongsToDeletedConversation(item));
    this.state.agentLoopTraces = this.state.agentLoopTraces.filter((item) => !belongsToDeletedConversation(item));
    this.state.querySessions = this.state.querySessions.filter((item) => !belongsToDeletedConversation(item));
    this.state.runtimeEvents = this.state.runtimeEvents.filter((item) => !belongsToDeletedConversation(item));
    this.state.worktrees = this.state.worktrees.filter((item) => !belongsToDeletedConversation(item));
    this.state.compactBoundaries = this.state.compactBoundaries.filter((item) => item.conversationId !== id);
    this.worktreeManager.setWorktrees(this.state.worktrees);
    await this.persistAndBroadcast();
  }

  async createProjectFromFolder(input: ProjectCreateInput): Promise<Project> {
    this.assertLoaded();
    const project = await this.projectManager.createFromFolder(input, this.state.projects);
    this.state.projects = [
      project,
      ...this.state.projects.filter((item) => item.id !== project.id && resolve(item.rootPath) !== resolve(project.rootPath))
    ];
    await this.persistAndBroadcast();
    this.emitTyped({ type: "project_changed", project });
    return project;
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
    this.state.projects = this.state.projects.map((item) => item.id === id ? project : item);
    await this.persistAndBroadcast();
    this.emitTyped({ type: "project_changed", project });
    return project;
  }

  async startDataRun(input: AutopilotStartDataRunInput): Promise<AutopilotRun> {
    return this.startAutopilotRun({ ...input, profile: "data" });
  }

  async startAutopilotRun(input: AutopilotStartInput): Promise<AutopilotRun> {
    this.assertLoaded();
    const project = this.requireProject(requiredString(input.projectId, "Project id"));
    this.projectManager.validateProjectPath(project);
    await this.projectManager.ensureProjectFolders(project.rootPath);
    const now = nowIso();
    const policy = this.projectManager.defaultWritePolicy(input.writePolicy || {});
    const profile = input.profile || "auto";
    const resolvedProfile = resolveAutopilotProfile(profile, input.goal);
    const budget = createAutopilotBudget({
      ...input.budget,
      maxRuntimeMinutes: input.budget?.maxRuntimeMinutes || policy.maxRuntimeMinutes,
      maxTasks: input.budget?.maxTasks || policy.maxTasks
    }, now);
    const run: AutopilotRun = {
      schemaVersion: 2,
      id: randomId("aprun"),
      projectId: project.id,
      projectRoot: project.rootPath,
      title: input.title?.trim() || titleFromPrompt(input.goal),
      goal: requiredString(input.goal, "Autopilot goal"),
      goalSpec: createAutopilotGoalSpec(input.goal, input.deliverables, input.acceptanceCriteria),
      profile,
      resolvedProfile,
      status: "queued",
      currentStage: "clarify",
      writePolicy: policy,
      budget,
      loopIteration: 0,
      noProgressCount: 0,
      dataSources: normalizeDataSources(input.dataSources || []),
      taskIds: [],
      artifactIds: [],
      checkpointIds: [],
      evidence: [],
      createdAt: now,
      updatedAt: now
    };
    const tasks = this.autopilotOrchestrator.createTasks(run);
    const plan = this.autopilotOrchestrator.createPlan(run, tasks);
    const planValidation = validateAutopilotPlan(plan, tasks);
    if (!planValidation.ok) {
      throw new Error(`Autopilot planner produced an invalid plan: ${planValidation.errors.join(" ")}`);
    }
    const nextRun = { ...run, taskIds: tasks.map((task) => task.id), plan };
    this.state.autopilotRuns = [nextRun, ...this.state.autopilotRuns];
    this.state.autopilotTasks = [...tasks, ...this.state.autopilotTasks];
    this.state.projects = this.state.projects.map((item) => item.id === project.id ? { ...item, lastRunAt: now, updatedAt: now } : item);
    await this.addAutopilotCheckpoint(nextRun, "Autopilot project run queued");
    await this.addAutopilotEvent(nextRun, "info", "Autopilot project run queued", { taskCount: tasks.length, profile: resolvedProfile });
    await this.persistAndBroadcast();
    this.runInBackground(this.runAutopilot(nextRun.id), `Autopilot run ${nextRun.id}`);
    return this.requireAutopilotRun(nextRun.id);
  }

  async pauseAutopilotRun(id: string): Promise<AutopilotRun> {
    this.assertLoaded();
    const run = this.requireAutopilotRun(id);
    this.runningAutopilotRuns.get(id)?.controller.abort();
    this.resolveJobPermissions(id, "denied");
    const next = this.transitionAutopilotRun(id, "paused", { updatedAt: nowIso(), error: undefined, pendingDecision: undefined });
    await this.addAutopilotEvent(next, "info", "Autopilot data run paused");
    await this.addAutopilotCheckpoint(next, "Paused by user");
    await this.persistAndBroadcast();
    return next;
  }

  async resumeAutopilotRun(id: string): Promise<AutopilotRun> {
    this.assertLoaded();
    const run = this.requireAutopilotRun(id);
    if (run.status !== "paused" && run.status !== "blocked" && run.status !== "failed" && run.status !== "budget_exhausted" && run.status !== "partially_completed") {
      return run;
    }
    if (run.status !== "paused") {
      this.resetRetryableAutopilotTasks(id);
    }
    const next = this.transitionAutopilotRun(id, "queued", {
      updatedAt: nowIso(),
      error: undefined,
      finishedAt: undefined,
      budget: run.status === "budget_exhausted" ? resetAutopilotBudgetWindow(run.budget) : run.budget
    });
    await this.addAutopilotEvent(next, "info", "Autopilot data run resumed");
    await this.persistAndBroadcast();
    this.runInBackground(this.runAutopilot(id), `Autopilot run ${id}`);
    return this.requireAutopilotRun(id);
  }

  async cancelAutopilotRun(id: string): Promise<AutopilotRun> {
    this.assertLoaded();
    const run = this.requireAutopilotRun(id);
    this.runningAutopilotRuns.get(id)?.controller.abort();
    this.resolveJobPermissions(id, "denied");
    const now = nowIso();
    const next = this.transitionAutopilotRun(id, "canceled", { updatedAt: now, finishedAt: now, pendingDecision: undefined });
    this.state.autopilotTasks = this.state.autopilotTasks.map((task) => task.runId === id && (task.status === "queued" || task.status === "running")
      ? { ...task, status: "skipped", updatedAt: now, finishedAt: now, error: "Run canceled" }
      : task);
    if (run.worktreeId) {
      const abandoned = await this.worktreeManager.abandon(run.worktreeId, "Autopilot run canceled");
      this.upsertWorktreeState(abandoned);
    }
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
      actions: this.state.autopilotActions.filter((action) => action.runId === id),
      metrics: this.calculateAutopilotRunMetrics(id)
    };
  }

  getAutopilotRunMetrics(id: string): AutopilotRunMetrics {
    this.assertLoaded();
    return this.calculateAutopilotRunMetrics(id);
  }

  getAutopilotQualitySummary(): AutopilotQualitySummary {
    this.assertLoaded();
    return this.calculateAutopilotQuality();
  }

  async decideAutopilotApproval(input: AutopilotApprovalDecisionInput): Promise<AutopilotRun> {
    this.assertLoaded();
    const run = this.requireAutopilotRun(input.runId);
    const decision = run.pendingDecision;
    if (!decision || decision.id !== input.decisionId) {
      throw new Error("Autopilot approval request is no longer pending.");
    }
    if (decision.kind === "tool") {
      const settlement = this.settleAutopilotToolDecision(decision.id);
      const next = settlement?.run || this.patchAutopilotRun(run.id, { pendingDecision: undefined, updatedAt: nowIso() });
      if (input.decision === "approved") {
        await this.approveToolPermission(decision.id);
      } else {
        await this.denyToolPermission(decision.id);
      }
      await this.addAutopilotEvent(next, input.decision === "approved" ? "info" : "warning", `Autopilot tool approval ${input.decision}`, { decision, comment: input.comment });
      await this.persistAndBroadcast();
      if (settlement?.restart) {
        this.runInBackground(this.runAutopilot(run.id), `Autopilot run ${run.id}`);
      }
      return this.requireAutopilotRun(run.id);
    }
    if (input.decision === "denied") {
      const blocked = this.transitionAutopilotRun(run.id, "blocked", {
        pendingDecision: undefined,
        error: input.comment?.trim() || `User denied ${decision.title}.`,
        updatedAt: nowIso()
      });
      await this.addAutopilotEvent(blocked, "warning", "Autopilot approval denied", { decision, comment: input.comment });
      await this.addAutopilotCheckpoint(blocked, `Approval denied: ${decision.title}`);
      await this.persistAndBroadcast();
      return blocked;
    }
    const next = this.transitionAutopilotRun(run.id, "queued", {
      pendingDecision: undefined,
      directWriteApproved: decision.kind === "direct_write" ? true : run.directWriteApproved,
      planApproved: decision.kind === "plan" ? true : run.planApproved,
      error: undefined,
      updatedAt: nowIso()
    });
    await this.addAutopilotEvent(next, "info", "Autopilot approval granted", { decision, comment: input.comment });
    await this.persistAndBroadcast();
    this.runInBackground(this.runAutopilot(run.id), `Autopilot run ${run.id}`);
    return this.requireAutopilotRun(run.id);
  }

  async retryAutopilotFromCheckpoint(id: string): Promise<AutopilotRun> {
    const run = this.requireAutopilotRun(id);
    if (!["paused", "blocked", "failed", "budget_exhausted", "partially_completed"].includes(run.status)) {
      return run;
    }
    this.resetRetryableAutopilotTasks(id);
    const next = this.transitionAutopilotRun(id, "queued", {
      error: undefined,
      finishedAt: undefined,
      noProgressCount: 0,
      budget: run.status === "budget_exhausted" ? resetAutopilotBudgetWindow(run.budget) : run.budget,
      updatedAt: nowIso()
    });
    await this.addAutopilotEvent(next, "info", "Autopilot retry requested from latest checkpoint");
    await this.persistAndBroadcast();
    this.runInBackground(this.runAutopilot(id), `Autopilot run ${id}`);
    return this.requireAutopilotRun(id);
  }

  async applyAutopilotWorktree(id: string): Promise<AutopilotRun> {
    const run = this.requireAutopilotRun(id);
    if (!run.worktreeId) {
      throw new Error("Autopilot run has no worktree.");
    }
    if (run.status !== "completed") {
      throw new Error("Autopilot worktree can only be applied after the run completes successfully.");
    }
    const currentWorktree = this.worktreeManager.get(run.worktreeId);
    if (!currentWorktree) {
      throw new Error(`Worktree not found: ${run.worktreeId}`);
    }
    if (currentWorktree.status !== "completed") {
      throw new Error("Autopilot worktree can only be applied after its diff is completed.");
    }
    const worktree = await this.worktreeManager.apply(run.worktreeId);
    this.upsertWorktreeState(worktree);
    await this.addAutopilotEvent(run, "info", "Autopilot worktree applied", { worktreeId: worktree.id });
    await this.persistAndBroadcast();
    return this.requireAutopilotRun(id);
  }

  async discardAutopilotWorktree(id: string): Promise<AutopilotRun> {
    const run = this.requireAutopilotRun(id);
    if (!run.worktreeId) {
      throw new Error("Autopilot run has no worktree.");
    }
    const currentWorktree = this.worktreeManager.get(run.worktreeId);
    if (!currentWorktree) {
      throw new Error(`Worktree not found: ${run.worktreeId}`);
    }
    if (currentWorktree.status === "applied" || currentWorktree.status === "discarded") {
      throw new Error(`Autopilot worktree is already ${currentWorktree.status}.`);
    }
    if (["queued", "analyzing", "planning", "running", "verifying", "replanning", "reviewing", "waiting_approval"].includes(run.status)) {
      throw new Error("Pause or cancel the Autopilot run before discarding its worktree.");
    }
    const worktree = await this.worktreeManager.discard(run.worktreeId);
    this.upsertWorktreeState(worktree);
    await this.addAutopilotEvent(run, "warning", "Autopilot worktree discarded", { worktreeId: worktree.id });
    await this.persistAndBroadcast();
    return this.requireAutopilotRun(id);
  }

  async sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
    this.assertLoaded();
    const conversation = input.conversationId
      ? this.findConversation(input.conversationId) || await this.createConversation(titleFromPrompt(input.prompt))
      : await this.createConversation(titleFromPrompt(input.prompt));

    const now = nowIso();
    const userMessage: ChatMessage = {
      id: randomId("msg"),
      conversationId: conversation.id,
      role: "user",
      text: input.prompt,
      createdAt: now,
      attachments: input.attachments || []
    };
    const job: AgentJob = {
      id: randomId("job"),
      conversationId: conversation.id,
      prompt: input.prompt,
      status: "queued",
      workspaceMode: input.workspaceMode || "main",
      diffStatus: "unavailable",
      createdAt: now,
      updatedAt: now,
      progress: ["Queued locally"]
    };

    this.appendMessage(conversation.id, userMessage);
    this.state.jobs = [job, ...this.state.jobs];
    await this.persistAndBroadcast();
    await this.appendTranscript(conversation.id, { type: "message", message: userMessage });
    this.emitTyped({ type: "message", conversationId: conversation.id, message: userMessage });
    this.emitTyped({ type: "job", job });
    this.runInBackground(this.runJob(job.id), `Agent job ${job.id}`);
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

  async addPermissionRule(rule: Omit<PermissionRule, "id" | "createdAt" | "scope"> & { id?: string }): Promise<PermissionRule> {
    this.assertLoaded();
    const next: PermissionRule = {
      id: rule.id || randomId("rule"),
      toolName: rule.toolName.trim() || "*",
      behavior: rule.behavior,
      scope: "session",
      createdAt: nowIso()
    };
    this.state.permissionRules = [
      next,
      ...this.state.permissionRules.filter((item) => item.id !== next.id)
    ];
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
      messageId: conversation.messages.at(-6)?.id || conversation.messages[0]?.id,
      summary: summarizeConversationForManualCompact(conversation.messages),
      preservedMessageIds: conversation.messages.slice(-6).map((message) => message.id),
      originalMessageCount: conversation.messages.length,
      createdAt: nowIso()
    };
    this.upsertCompactBoundary(boundary);
    const summaryMessage: ChatMessage = {
      id: randomId("msg"),
      conversationId,
      role: "system",
      text: boundary.summary,
      createdAt: boundary.createdAt,
      blocks: [{ type: "compact_summary", boundaryId: boundary.id, summary: boundary.summary }]
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
      data: boundary
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
        data: candidate
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
    return this.state.identityContext ? { ...this.state.identityContext, roleIds: [...this.state.identityContext.roleIds] } : undefined;
  }

  async updateIdentityContext(input: IdentityContext): Promise<IdentityContext> {
    this.assertLoaded();
    const normalized = normalizeIdentityContext({
      ...input,
      updatedAt: input.updatedAt ?? nowIso()
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

  async updateServstationA2AConfig(input: ServstationA2AConfigUpdate): Promise<ServstationA2AConfig> {
    this.assertLoaded();
    const current = this.state.servstationA2AConfig;
    const baseUrl = input.baseUrl !== undefined ? normalizeHttpUrl(input.baseUrl) : current.baseUrl;
    const nextSecret = input.clearBearerToken ? undefined : input.bearerToken?.trim() || this.state.servstationA2ASecret;
    const authMode = input.authMode === "bearer" || input.authMode === "identityHeaders" || input.authMode === "oidc" ? input.authMode : current.authMode;
    const currentOidc = this.redactServstationA2AOidcConfig();
    const oidc = {
      ...currentOidc,
      issuerUrl: input.oidcIssuerUrl !== undefined ? normalizeHttpUrl(input.oidcIssuerUrl) : currentOidc.issuerUrl,
      clientId: input.oidcClientId !== undefined ? emptyToUndefined(input.oidcClientId) : currentOidc.clientId,
      scope: input.oidcScope !== undefined ? emptyToUndefined(input.oidcScope) : currentOidc.scope,
      redirectUri: input.oidcRedirectUri !== undefined ? normalizeHttpUrl(input.oidcRedirectUri) : currentOidc.redirectUri,
      refreshTokenSaved: currentOidc.refreshTokenSaved
    };
    const staffAgentAccount = input.staffAgentAccount !== undefined ? emptyToUndefined(input.staffAgentAccount) : current.staffAgentAccount;
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
      baseUrl !== current.baseUrl
      || oidc.issuerUrl !== currentOidc.issuerUrl
      || oidc.clientId !== currentOidc.clientId
      || staffAgentAccount !== current.staffAgentAccount
      || staffAgentPasswordChanged;
    const nextOidc = oidcContextChanged
      ? {
          ...oidc,
          accessTokenExpiresAt: undefined,
          refreshTokenSaved: false,
          userId: undefined
        }
      : oidc;
    const currentReverse = this.state.servstationA2AConfig.reverse || { enabled: false, status: "disconnected" as const };
    const reverse = {
      ...currentReverse,
      enabled: input.reverseEnabled ?? currentReverse.enabled,
      clientInstanceId: input.reverseClientInstanceId !== undefined ? emptyToUndefined(input.reverseClientInstanceId) : currentReverse.clientInstanceId,
      status: input.reverseEnabled === false ? "disconnected" as const : currentReverse.status,
      updatedAt: nowIso()
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
      agentInstanceId: input.agentInstanceId !== undefined ? emptyToUndefined(input.agentInstanceId) : current.agentInstanceId,
      updatedAt: nowIso()
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
      reverse
    });
    this.addRuntimeEvent(event);
    await this.persistAndBroadcast();
    const redacted = this.redactServstationA2AConfig();
    this.emitTyped({ type: "servstation_a2a", config: redacted, event });
    return redacted;
  }

  async connectServstationReverseBridge(): Promise<ServstationA2AConfig> {
    this.assertLoaded();
    if (this.state.servstationA2AConfig.authMode === "oidc" && !parseServstationOidcSecret(this.state.servstationA2AOidcSecret)) {
      throw new Error("Servstation OIDC session is not configured.");
    }
    await this.updateServstationReverseState({
      enabled: true,
      status: "connecting",
      lastError: undefined
    });
    this.servstationReverseBridgeClient.start();
    return this.waitForServstationReverseConnection();
  }

  async disconnectServstationReverseBridge(): Promise<ServstationA2AConfig> {
    this.assertLoaded();
    await this.servstationReverseBridgeClient.stop(false);
    return this.redactServstationA2AConfig();
  }

  async getServstationClientSnapshot(query: ServstationClientSnapshotQuery = {}): Promise<ServstationClientSnapshot> {
    this.assertLoaded();
    return this.servstationAgentClient.snapshot(query);
  }

  async listServstationSkills(): Promise<ServstationSkillSummary[]> {
    this.assertLoaded();
    return this.servstationAgentClient.listSkills();
  }

  async createServstationConversation(title?: string): Promise<ServstationConversation> {
    this.assertLoaded();
    return this.servstationAgentClient.createConversation(title);
  }

  async deleteServstationConversation(conversationId: string): Promise<void> {
    this.assertLoaded();
    await this.servstationAgentClient.deleteConversation(conversationId);
  }

  async sendServstationPrompt(input: ServstationSendPromptInput): Promise<ServstationSendPromptResult> {
    this.assertLoaded();
    return this.servstationAgentClient.sendPrompt(input);
  }

  async cancelServstationJob(jobId: string): Promise<ServstationSessionJob> {
    this.assertLoaded();
    return this.servstationAgentClient.cancelJob(jobId);
  }

  async createServstationScheduledJob(input: ServstationScheduledJobInput): Promise<ServstationScheduledJob> {
    this.assertLoaded();
    return this.servstationAgentClient.createScheduledJob(input);
  }

  async updateServstationScheduledJob(id: string, input: Partial<ServstationScheduledJobInput>): Promise<ServstationScheduledJob> {
    this.assertLoaded();
    return this.servstationAgentClient.updateScheduledJob(id, input);
  }

  async deleteServstationScheduledJob(id: string): Promise<void> {
    this.assertLoaded();
    await this.servstationAgentClient.deleteScheduledJob(id);
  }

  async startServstationAutopilotRun(input: ServstationAutopilotStartInput): Promise<ServstationAutopilotRun> {
    this.assertLoaded();
    return this.servstationAgentClient.startAutopilotRun(input);
  }

  async updateServstationAutopilotRun(input: ServstationAutopilotStatusUpdate): Promise<ServstationAutopilotRun> {
    this.assertLoaded();
    return this.servstationAgentClient.updateAutopilotRun(input);
  }

  async getServstationFlowEngineSnapshot(): Promise<ServstationFlowEngineSnapshot> {
    this.assertLoaded();
    return this.servstationAgentClient.flowEngineSnapshot();
  }

  async launchServstationFlowEngineWorkflow(input: ServstationFlowEngineLaunchInput): Promise<ServstationFlowEngineInitiatedExecution> {
    this.assertLoaded();
    return this.servstationAgentClient.launchFlowEngineWorkflow(input);
  }

  async getServstationFlowEngineExecution(executionId: string): Promise<ServstationFlowEngineInitiatedExecution> {
    this.assertLoaded();
    return this.servstationAgentClient.getFlowEngineExecution(executionId);
  }

  async getServstationFlowEngineExecutionEvents(executionId: string): Promise<ServstationFlowEngineExecutionEvent[]> {
    this.assertLoaded();
    return this.servstationAgentClient.getFlowEngineExecutionEvents(executionId);
  }

  async decideServstationFlowEngineApproval(input: ServstationFlowEngineApprovalDecisionInput): Promise<ServstationFlowEnginePendingTask> {
    this.assertLoaded();
    return this.servstationAgentClient.decideFlowEngineApproval(input);
  }

  async listServstationMessages(folder: ServstationMessageFolder, unreadOnly = false): Promise<ServstationMessageListResponse> {
    this.assertLoaded();
    return this.servstationAgentClient.listMessages(folder, unreadOnly);
  }

  async getServstationUnreadMessages(): Promise<ServstationMessageUnreadSummary> {
    this.assertLoaded();
    return this.servstationAgentClient.getUnreadMessages();
  }

  async getServstationMessage(messageId: string): Promise<ServstationMessageDetail> {
    this.assertLoaded();
    return this.servstationAgentClient.getMessage(messageId);
  }

  async markServstationMessageRead(messageId: string): Promise<ServstationMessageDetail> {
    this.assertLoaded();
    return this.servstationAgentClient.markMessageRead(messageId);
  }

  async setServstationMessageFavorite(messageId: string, favorited: boolean): Promise<ServstationMessageDetail> {
    this.assertLoaded();
    return this.servstationAgentClient.setMessageFavorite(messageId, favorited);
  }

  async trashServstationMessage(messageId: string): Promise<ServstationMessageDetail> {
    this.assertLoaded();
    return this.servstationAgentClient.trashMessage(messageId);
  }

  async restoreServstationMessage(messageId: string): Promise<ServstationMessageDetail> {
    this.assertLoaded();
    return this.servstationAgentClient.restoreMessage(messageId);
  }

  async deleteServstationMessage(messageId: string): Promise<void> {
    this.assertLoaded();
    await this.servstationAgentClient.deleteMessage(messageId);
  }

  async fetchServstationMessageAttachment(messageId: string, attachmentId: string): Promise<ServstationMessageAttachmentContent> {
    this.assertLoaded();
    return this.servstationAgentClient.fetchMessageAttachment(messageId, attachmentId);
  }

  async sendServstationAgentMessage(input: ServstationSendAgentMessageInput): Promise<ServstationSessionJob> {
    this.assertLoaded();
    return this.servstationAgentClient.sendAgentMessage(input);
  }

  async sendServstationDirectMessage(input: ServstationSendDirectMessageInput): Promise<ServstationMessageDetail> {
    this.assertLoaded();
    return this.servstationAgentClient.sendDirectMessage(input);
  }

  async listServstationMailAccounts(): Promise<ServstationMailAccount[]> {
    this.assertLoaded();
    return this.servstationAgentClient.listMailAccounts();
  }

  async createServstationMailAccount(input: ServstationMailAccountDraft): Promise<ServstationMailAccount> {
    this.assertLoaded();
    return this.servstationAgentClient.createMailAccount(input);
  }

  async updateServstationMailAccount(id: string, input: ServstationMailAccountDraft): Promise<ServstationMailAccount> {
    this.assertLoaded();
    return this.servstationAgentClient.updateMailAccount(id, input);
  }

  async deleteServstationMailAccount(id: string): Promise<void> {
    this.assertLoaded();
    await this.servstationAgentClient.deleteMailAccount(id);
  }

  async setDefaultServstationMailAccount(id: string): Promise<ServstationMailAccount> {
    this.assertLoaded();
    return this.servstationAgentClient.setDefaultMailAccount(id);
  }

  async testServstationMailAccountConnection(id: string): Promise<ServstationMailConnectionTestResult> {
    this.assertLoaded();
    return this.servstationAgentClient.testMailAccountConnection(id);
  }

  async syncServstationMailAccountNow(id: string): Promise<{ status: string }> {
    this.assertLoaded();
    return this.servstationAgentClient.syncMailAccountNow(id);
  }

  async streamServstationMessageEvents(onEvent: (event: ServstationMessageEvent) => void, signal?: AbortSignal): Promise<void> {
    this.assertLoaded();
    await this.servstationAgentClient.streamMessageEvents(onEvent, signal);
  }

  async updateServstationA2AOidcSession(input: ServstationA2AOidcSessionUpdate): Promise<ServstationA2AConfig> {
    this.assertLoaded();
    const current = this.state.servstationA2AConfig;
    const baseUrl = input.baseUrl !== undefined
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
      clientId
    };
    const derivedIdentity = input.identityContext
      ? normalizeIdentityContext({ ...input.identityContext, servstationUrl: baseUrl, updatedAt: nowIso() })
      : identityContextFromAccessToken(tokens.accessToken, {
        ...(this.state.identityContext || {}),
        issuerUrl,
        servstationUrl: baseUrl
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
        userId: derivedIdentity?.userId || current.oidc?.userId
      },
      agentInstanceId: derivedIdentity?.agentInstanceId || current.agentInstanceId,
      updatedAt: nowIso()
    };
    const event = this.createRuntimeEvent("servstation_a2a", "Servstation OIDC session updated", {
      baseUrl,
      issuerUrl,
      clientId,
      userId: derivedIdentity?.userId,
      refreshTokenSaved: Boolean(tokens.refreshToken)
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
      issuerUrl: refreshed.issuerUrl,
      agentInstanceId: current.agentInstanceId || this.state.identityContext?.agentInstanceId,
      servstationUrl: current.baseUrl || this.state.identityContext?.servstationUrl
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
        userId: derivedIdentity?.userId || current.oidc?.userId
      },
      agentInstanceId: derivedIdentity?.agentInstanceId || current.agentInstanceId,
      updatedAt: nowIso()
    };
    const event = this.createRuntimeEvent("servstation_a2a", "Servstation OIDC token refreshed", {
      issuerUrl: refreshed.issuerUrl,
      clientId: refreshed.clientId,
      userId: derivedIdentity?.userId,
      refreshTokenSaved: Boolean(refreshed.refreshToken)
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
        userId: undefined
      },
      updatedAt: nowIso()
    };
    const event = this.createRuntimeEvent("servstation_a2a", "Servstation OIDC session cleared", {
      issuerUrl: current.oidc?.issuerUrl,
      clientId: current.oidc?.clientId
    });
    this.addRuntimeEvent(event);
    await this.persistAndBroadcast();
    const redacted = this.redactServstationA2AConfig();
    this.emitTyped({ type: "servstation_a2a", config: redacted, event });
    return redacted;
  }

  async updateRemoteBridgeConfig(input: Partial<RemoteBridgeConfig> & { token?: string; clearToken?: boolean }): Promise<RemoteBridgeConfig> {
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
      limit: query.limit ?? 100
    });
  }

  async searchMemory(query: MemorySearchQuery = {}): Promise<MemorySearchResult[]> {
    this.assertLoaded();
    return this.memoryManager.search(this.state.memory, {
      ...query,
      scope: query.scope || "all",
      limit: query.limit ?? 20
    });
  }

  async addMemory(input: MemoryAddInput): Promise<MemoryPage | MemoryFact> {
    this.assertLoaded();
    const result = this.memoryManager.add(this.state.memory, {
      ...input,
      title: requiredString(input.title, "Memory title"),
      content: requiredString(input.content, "Memory content")
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
    await this.recordMemoryWrite("Memory candidate approved", { candidate: result.candidate, record: result.record }, result.record.conversationId);
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
      imported: result.imported
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
      createdAt
    };
    await this.recordMemoryWrite("Memory backup created", file);
    await this.persistAndBroadcast();
    return file;
  }

  async restoreMemory(filePath?: string): Promise<MemoryImportResult> {
    this.assertLoaded();
    const restorePath = filePath?.trim() || await this.latestMemoryBackupPath();
    if (!restorePath) {
      throw new Error("No memory backup found.");
    }
    const raw = await readFile(restorePath, "utf8");
    const parsed = JSON.parse(raw) as MemoryTransfer;
    const result = this.memoryManager.importSnapshot(this.state.memory, { data: parsed, mode: "replace" });
    this.state.memory = result.memory;
    await this.recordMemoryWrite("Memory restored", {
      path: restorePath,
      imported: result.imported
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
      subagentName: input.subagentName || undefined
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
    this.state.mcpServers = this.state.mcpServers.map((item) => item.id === id ? server : item);
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

  async importMcpConfig(input: McpConfigTransfer): Promise<McpImportResult> {
    this.assertLoaded();
    const result = this.mcpManager.importConfig(input);
    this.state.mcpServers = [
      ...result.servers,
      ...this.state.mcpServers
    ];
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
      durationMs: result.durationMs
    });
    await this.persistAndBroadcast();
    return result;
  }

  startScheduler(intervalMs = 30_000): void {
    this.assertLoaded();
    if (this.schedulerTimer) {
      return;
    }
    this.runInBackground(this.runDueScheduledJobs(), "Scheduled job scan");
    this.schedulerTimer = setInterval(() => {
      this.runInBackground(this.runDueScheduledJobs(), "Scheduled job scan");
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
      this.state.scheduledJobs = this.state.scheduledJobs.map((item) => item.id === job.id
        ? { ...item, ...nextSchedule, lastRunAt: ranAt, updatedAt: ranAt }
        : item);
      try {
        await this.sendPrompt({ prompt: `[Scheduled] ${job.title}\n\n${job.prompt}` });
      } catch (error) {
        const event: RuntimeEventRecord = {
          id: randomId("event"),
          kind: "turn_failed",
          message: `Scheduled job failed: ${job.title}`,
          createdAt: nowIso(),
          data: { scheduledJobId: job.id, error: error instanceof Error ? error.message : String(error) }
        };
        this.addRuntimeEvent(event);
        this.emitTyped({ type: "query_event", event });
      }
    }
    if (due.length) {
      await this.persistAndBroadcast();
    }
    return due.length;
  }

  async updateModelConfig(update: ModelConfigUpdate): Promise<ModelConfig> {
    this.assertLoaded();
    const next: ModelConfig = {
      providerName: requiredString(update.providerName, "Provider name"),
      baseUrl: requiredString(update.baseUrl, "Base URL"),
      model: requiredString(update.model, "Model"),
      temperature: clampNumber(Number(update.temperature), 0, 2),
      maxTokens: Math.round(clampNumber(Number(update.maxTokens), 64, 128000)),
      apiKeySaved: false
    };
    if (update.clearApiKey) {
      this.state.modelSecret = undefined;
    } else if (typeof update.apiKey === "string" && update.apiKey.trim()) {
      this.state.modelSecret = update.apiKey.trim();
    }
    next.apiKeySaved = Boolean(this.state.modelSecret);
    next.apiKeyStorage = next.apiKeySaved ? this.secretStorageKind : undefined;
    this.state.modelConfig = next;
    await this.persistAndBroadcast();
    return redactModelConfig(this.state.modelConfig, this.state.modelSecret);
  }

  async updateToolMarketConfig(update: ToolMarketConfigUpdate): Promise<ToolMarketConfig> {
    this.assertLoaded();
    const apiUrl = update.apiUrl.trim();
    const accountEmail = update.accountEmail?.trim() || "";
    const requestedSource = normalizeToolMarketSource(update.source);
    const next: ToolMarketConfig = {
      source: requestedSource === "local" && (apiUrl || accountEmail || update.password?.trim() || update.accessToken?.trim()) ? "hybrid" : requestedSource,
      apiUrl,
      accountEmail,
      accessTokenSaved: false,
      passwordSaved: false,
      lastSyncedAt: this.state.toolMarketConfig.lastSyncedAt
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
    return redactToolMarketConfig(this.state.toolMarketConfig, this.state.toolMarketSecret, this.state.toolMarketPasswordSecret);
  }

  async testModelConfig(update?: Partial<ModelConfigUpdate>): Promise<ModelTestResult> {
    this.assertLoaded();
    const modelConfig: ModelConfig = update
      ? {
          providerName: update.providerName || this.state.modelConfig.providerName,
          baseUrl: update.baseUrl || this.state.modelConfig.baseUrl,
          model: update.model || this.state.modelConfig.model,
          temperature: update.temperature ?? this.state.modelConfig.temperature,
          maxTokens: update.maxTokens ?? this.state.modelConfig.maxTokens,
          apiKeySaved: Boolean(update.apiKey || this.state.modelSecret),
          apiKeyStorage: this.state.modelConfig.apiKeyStorage
        }
      : this.state.modelConfig;
    const apiKey = update?.apiKey?.trim() || this.state.modelSecret;
    if (!apiKey) {
      return { ok: false, message: "No API key configured. Fallback mode is available, but real model calls need a key." };
    }
    try {
      const result = await generateReply({
        modelConfig,
        apiKey,
        personality: this.state.personality,
        messages: [{
          id: "model-test",
          conversationId: "model-test",
          role: "user",
          text: "Reply with exactly: Supbot model test ok",
          createdAt: nowIso()
        }]
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
      instructions: personality.instructions.trim()
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
      enabled: input.enabled !== undefined ? Boolean(input.enabled) : current.enabled
    };
    this.state.capabilities = this.state.capabilities.map((item) => item.id === id ? next : item);
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
      enabled: Boolean(subagent.enabled)
    };
    this.state.subagents = [
      ...this.state.subagents.filter((item) => item.id !== next.id),
      next
    ].sort((a, b) => a.name.localeCompare(b.name));
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
    return listToolMarketCatalog(uniqueMarketProducts([...local, ...remote, ...installed]), this.state.capabilities, query);
  }

  async installToolMarketProduct(productId: string, confirmMcpInstall = false): Promise<ToolMarketCatalogItem> {
    this.assertLoaded();
    const product = await this.resolveMarketProduct(productId);
    if (!product) {
      throw new Error(`Tool market product not found: ${productId}`);
    }
    if (!product.free && !product.purchased) {
      throw new Error(`Tool market product must be purchased before local installation: ${product.name}`);
    }
    const deployment = product.localDeployment || defaultLocalDeployment(product);
    if (deployment.mcpServer && !confirmMcpInstall) {
      throw new Error(`Installing MCP product ${product.name} requires explicit command confirmation.`);
    }
    const installPath = await this.installToolMarketPackage(product, deployment);
    const capability: CapabilityDefinition = {
      ...(deployment.capability || product.capability),
      enabled: true
    };
    this.state.capabilities = [
      ...this.state.capabilities.filter((item) => item.id !== capability.id),
      capability
    ];
    this.state.deletedCapabilityIds = this.state.deletedCapabilityIds.filter((id) => id !== capability.id);
    const mcpServer = this.upsertMarketMcpServer(product, deployment, installPath);
    if (mcpServer) {
      await this.recordMcpEvent("Tool market MCP installed locally", mcpServer.id, { productId: product.id, installPath });
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
    const now = nowIso();
    const job: ScheduledJob = {
      id: randomId("schedule"),
      title: input.title.trim() || titleFromPrompt(input.prompt),
      prompt: requiredString(input.prompt, "Prompt"),
      scheduleKind: input.scheduleKind,
      runAt: input.runAt,
      cronExpr: input.cronExpr,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      nextRunAt: input.runAt
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
    const next: ScheduledJob = {
      ...current,
      ...input,
      title: input.title !== undefined ? input.title.trim() : current.title,
      prompt: input.prompt !== undefined ? input.prompt.trim() : current.prompt,
      updatedAt: nowIso(),
      nextRunAt: input.runAt !== undefined ? input.runAt : current.nextRunAt
    };
    this.state.scheduledJobs = this.state.scheduledJobs.map((item) => item.id === id ? next : item);
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
    const canonicalPath = await realpath(filePath);
    const info = await stat(canonicalPath);
    if (!info.isFile() || info.size > 25 * 1024 * 1024) {
      throw new Error("Attachments must be files no larger than 25 MiB.");
    }
    this.importedAttachmentPaths.add(canonicalPath.toLowerCase());
    return {
      id: randomId("att"),
      name: basename(canonicalPath),
      path: canonicalPath,
      size: info.size
    };
  }

  private async isAllowedAttachmentPath(filePath: string): Promise<boolean> {
    try {
      const canonicalPath = await realpath(filePath);
      if (this.importedAttachmentPaths.has(canonicalPath.toLowerCase())) {
        return true;
      }
      const roots = [this.storage.getDataDir(), ...this.state.projects.map((project) => project.rootPath)];
      for (const root of roots) {
        const canonicalRoot = await realpath(root).catch(() => resolve(root));
        if (pathIsInside(canonicalRoot, canonicalPath)) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
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
      ...this.state.dataArtifacts.map((artifact) => artifact.path),
      ...this.state.autopilotRuns.map((run) => run.reportPath).filter((path): path is string => Boolean(path)),
      ...this.state.worktrees.map((worktree) => worktree.path),
      ...this.state.conversations.flatMap((conversation) => conversation.messages.flatMap((message) => [
        ...(message.attachments || []).map((attachment) => attachment.path).filter((path): path is string => Boolean(path)),
        ...(message.generatedFiles || []).map((file) => file.path)
      ]).flat())
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
    try {
      this.updateJob(jobId, "running", "Preparing model request");
      await this.persistAndBroadcast();
      const conversation = this.findConversation(job.conversationId);
      if (!conversation) {
        throw new Error("Conversation disappeared before the job could run.");
      }
      const subagent = resolveMentionedSubagent(job.prompt, this.state.subagents);
      const assistantSeed: ChatMessage = {
        id: randomId("msg"),
        conversationId: conversation.id,
        role: "assistant",
        text: subagent ? `@${subagent.name} is thinking...` : "Supbot is thinking...",
        createdAt: nowIso(),
        jobId,
        status: "running"
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
          blocks: [
            ...toolBlocksFromRecords(trace?.toolCalls || []),
            { type: "text", text: localTool.text }
          ],
          generatedFiles: localTool.generatedFiles,
          createdAt: nowIso()
        };
        this.replaceMessage(conversation.id, assistantSeed.id, finalMessage);
        this.updateJob(jobId, "completed", "Completed local tool command");
        await this.completeJobWorktreeSafely(jobId);
        await this.persistAndBroadcast();
        this.emitTyped({ type: "message", conversationId: conversation.id, message: finalMessage });
        return;
      }
      const engine = new QueryEngine({
        id: randomId("query"),
        jobId,
        conversationId: conversation.id,
        dataDir: this.storage.getDataDir(),
        cwd: this.defaultWorkspacePath(),
        modelConfig: this.state.modelConfig,
        apiKey: this.state.modelSecret,
        personality: this.state.personality,
        subagent,
        messages: this.findConversation(conversation.id)?.messages.filter((message) => message.id !== assistantSeed.id) || [],
        compactBoundaries: this.state.compactBoundaries,
        memory: this.state.memory,
        registry: this.toolRegistry,
        toolContext: this.createToolExecutionContext(controller.signal, jobId),
        permissionMode: this.state.permissionMode,
        permissionRules: this.state.permissionRules,
        signal: controller.signal,
        requestPermission: (permission) => this.requestToolPermission(permission),
        onSession: async (session) => {
          this.upsertQuerySession(session);
          await this.persistAndBroadcast();
        },
        onRuntimeEvent: async (event) => {
          this.addRuntimeEvent(event);
          await this.persistAndBroadcast();
          this.emitTyped({ type: "query_event", event });
        },
        onMessageDelta: async (delta) => {
          this.appendAssistantDelta(conversation.id, assistantSeed.id, delta);
          this.emitTyped({ type: "message_delta", conversationId: conversation.id, messageId: assistantSeed.id, delta });
        },
        onTrace: async (trace) => {
          this.upsertTrace(trace);
          await this.persistAndBroadcast();
        },
        onToolProgress: async (toolCall) => {
          this.upsertToolCall(jobId, toolCall);
          this.updateJob(jobId, this.findJob(jobId)?.status || "running", `${toolCall.toolName}: ${toolCall.status}`);
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
          await this.handlePermissionTimeout(permission);
        }
      });
      const response = await engine.submitTurn();
      const finalMessage: ChatMessage = {
        ...assistantSeed,
        text: response.text,
        status: "completed",
        blocks: [
          ...toolBlocksFromRecords(response.trace.toolCalls),
          ...(response.compactBoundary ? [{ type: "compact_summary" as const, boundaryId: response.compactBoundary.id, summary: response.compactBoundary.summary }] : []),
          { type: "text", text: response.text }
        ],
        generatedFiles: response.generatedFiles,
        createdAt: nowIso()
      };
      this.replaceMessage(conversation.id, assistantSeed.id, finalMessage);
      this.updateJob(jobId, "completed", "Completed");
      await this.completeJobWorktreeSafely(jobId);
      await this.persistAndBroadcast();
      this.emitTyped({ type: "message", conversationId: conversation.id, message: finalMessage });
    } catch (error) {
      const status: JobStatus = controller.signal.aborted ? "canceled" : "failed";
      const message = controller.signal.aborted ? "Canceled by user" : (error as Error).message;
      this.updateAssistantMessageForJob(job.conversationId, jobId, status, message);
      this.updateJob(jobId, status, message);
      try {
        await this.finishJobWorktree(jobId, status, message);
      } catch (cleanupError) {
        this.reportBackgroundError(`Agent job ${jobId} worktree cleanup`, cleanupError);
      }
      try {
        await this.persistAndBroadcast();
      } catch (persistError) {
        this.reportBackgroundError(`Agent job ${jobId} failure persistence`, persistError);
      }
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
    if (["completed", "canceled", "running", "verifying", "replanning", "analyzing", "planning", "waiting_approval"].includes(run.status)) {
      return;
    }
    const project = this.requireProject(run.projectId);
    const controller = new AbortController();
    this.runningAutopilotRuns.set(runId, { controller });
    try {
      const now = nowIso();
      run = this.transitionAutopilotRun(runId, "analyzing", {
        startedAt: run.startedAt || now,
        budget: run.budget ? {
          ...run.budget,
          usage: {
            ...run.budget.usage,
            startedAt: run.budget.usage.startedAt || now,
            deadlineAt: run.budget.usage.deadlineAt || new Date(new Date(now).getTime() + run.budget.limits.maxRuntimeMinutes * 60_000).toISOString()
          }
        } : undefined,
        updatedAt: now,
        error: undefined
      });
      await this.addAutopilotEvent(run, "info", "Autopilot supervisor analyzing run", { projectRoot: project.rootPath, profile: run.resolvedProfile });
      run = this.transitionAutopilotRun(runId, "planning", { updatedAt: nowIso() });
      if (this.autopilotPlanRequiresApproval(run)) {
        const decision = {
          id: randomId("apdecision"),
          kind: "plan" as const,
          title: "Approve Autopilot plan",
          summary: "The goal is ambiguous or the generated plan contains a high-risk task. Review the plan before execution.",
          risk: "high" as const,
          impact: this.state.autopilotTasks.filter((task) => task.runId === run.id).map((task) => `${task.title} [${task.risk || "low"}]`),
          rollbackPlan: "Denying the plan blocks the run without executing project tools.",
          createdAt: nowIso()
        };
        const waiting = this.transitionAutopilotRun(run.id, "waiting_approval", { pendingDecision: decision, updatedAt: nowIso() });
        await this.addAutopilotEvent(waiting, "warning", "Autopilot plan requires approval", { decision });
        await this.addAutopilotCheckpoint(waiting, "Waiting for plan approval");
        await this.persistAndBroadcast();
        return;
      }
      const workspaceReady = await this.prepareAutopilotWorkspace(project, run);
      if (!workspaceReady) {
        return;
      }
      run = this.transitionAutopilotRun(runId, "running", { updatedAt: nowIso() });
      await this.addAutopilotCheckpoint(run, "Supervisor started structured plan");
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
        const budgetError = autopilotBudgetExceeded(run, Boolean(nextTaskId));
        if (budgetError) {
          const exhausted = this.transitionAutopilotRun(runId, "budget_exhausted", {
            error: budgetError,
            updatedAt: nowIso(),
            finishedAt: nowIso()
          });
          await this.addAutopilotEvent(exhausted, "warning", "Autopilot budget exhausted", { reason: budgetError, budget: exhausted.budget });
          await this.addAutopilotCheckpoint(exhausted, `Budget exhausted: ${budgetError}`);
          await this.persistAndBroadcast();
          return;
        }
        if (!nextTaskId) {
          run = this.transitionAutopilotRun(runId, "verifying", { currentStage: "verify", updatedAt: nowIso() });
          const alignment = await this.ensureAutopilotGoalAligned(project, run, controller.signal);
          if (alignment === "aligned") {
            break;
          }
          if (alignment === "queued-fix") {
            this.transitionAutopilotRun(runId, "replanning", { currentStage: "replan", updatedAt: nowIso() });
            this.transitionAutopilotRun(runId, "running", { updatedAt: nowIso() });
            continue;
          }
          return;
        }
        const task = this.requireAutopilotTask(nextTaskId);
        if (task.status === "completed" || task.status === "skipped") {
          continue;
        }
        this.incrementAutopilotBudget(runId, { iterations: 1 });
        await this.runAutopilotTask(project, run, task, controller.signal);
      }

      run = this.requireAutopilotRun(runId);
      if (controller.signal.aborted || run.status === "paused" || run.status === "canceled" || run.status === "blocked") {
        return;
      }
      const completed = this.state.autopilotTasks.filter((task) => task.runId === runId).every((task) => task.status === "completed" || task.status === "skipped");
      if (completed) {
        const reportArtifact = await this.writeAutopilotRunReportArtifact(run);
        const finishedAt = nowIso();
        const next = this.transitionAutopilotRun(runId, "completed", {
          artifactIds: uniqueStrings([...run.artifactIds, reportArtifact.id]),
          reportPath: reportArtifact.path,
          updatedAt: finishedAt,
          finishedAt
        });
        this.state.dataArtifacts = [reportArtifact, ...this.state.dataArtifacts.filter((artifact) => artifact.id !== reportArtifact.id)];
        if (next.worktreeId) {
          const completedWorktree = await this.worktreeManager.complete(next.worktreeId);
          this.upsertWorktreeState(completedWorktree);
        }
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
      const failed = this.failAutopilotRun(runId, error, now);
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
      if (!task || task.status === "completed" || task.status === "skipped") {
        return false;
      }
      return (task.dependsOn || []).every((dependencyId) => {
        const dependency = this.state.autopilotTasks.find((item) => item.id === dependencyId);
        return dependency?.status === "completed" || dependency?.status === "skipped";
      });
    });
  }

  private async prepareAutopilotWorkspace(project: Project, run: AutopilotRun): Promise<boolean> {
    if (run.resolvedProfile !== "coding" || run.worktreeId || run.directWriteApproved) {
      return true;
    }
    try {
      const worktree = await this.worktreeManager.createForJob({
        jobId: run.id,
        conversationId: `autopilot_${run.id}`,
        rootDir: project.rootPath
      });
      this.upsertWorktreeState(worktree);
      const next = this.patchAutopilotRun(run.id, { worktreeId: worktree.id, updatedAt: nowIso() });
      await this.addAutopilotEvent(next, "info", "Coding worktree created", { worktreeId: worktree.id, path: worktree.path });
      await this.persistAndBroadcast();
      return true;
    } catch (error) {
      const message = (error as Error).message;
      const decision = {
        id: randomId("apdecision"),
        kind: "direct_write" as const,
        title: "Allow direct writes to a non-Git project",
        summary: "The coding profile could not create an isolated Git worktree. Continuing will modify the registered project directly.",
        risk: "high" as const,
        impact: [project.rootPath, message],
        rollbackPlan: `Original file contents will be copied under .supbot/runs/${run.id}/backups before WriteFile changes.`,
        createdAt: nowIso()
      };
      const waiting = this.transitionAutopilotRun(run.id, "waiting_approval", {
        pendingDecision: decision,
        error: message,
        updatedAt: nowIso()
      });
      await this.addAutopilotEvent(waiting, "warning", "Coding run requires direct-write approval", { decision });
      await this.addAutopilotCheckpoint(waiting, "Waiting for direct-write approval");
      await this.persistAndBroadcast();
      return false;
    }
  }

  private autopilotPlanRequiresApproval(run: AutopilotRun): boolean {
    if (run.planApproved) {
      return false;
    }
    const tasks = this.state.autopilotTasks.filter((task) => task.runId === run.id);
    const ambiguous = run.goal.trim().length < 12 || /\b(do it|whatever|something|improve it|handle this)\b|处理一下|优化一下|随便|看着办/i.test(run.goal);
    const unverifiableResearch = run.resolvedProfile === "research"
      && !run.goalSpec?.deliverables.length
      && run.goalSpec?.acceptanceCriteria.length === 1
      && run.goalSpec.acceptanceCriteria[0] === "The requested outcome is produced and supported by recorded evidence.";
    return ambiguous || unverifiableResearch || tasks.some((task) => task.risk === "high");
  }

  private async ensureAutopilotGoalAligned(project: Project, run: AutopilotRun, signal: AbortSignal): Promise<"aligned" | "queued-fix" | "blocked"> {
    if (signal.aborted) {
      return "blocked";
    }
    if (!this.canAppendAutopilotTask(run.id)) {
      const blocked = this.transitionAutopilotRun(run.id, "blocked", {
        error: "Autopilot task budget exhausted before goal-output review could run.",
        updatedAt: nowIso()
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
      prompt: this.buildGoalAlignmentReviewPrompt(run.id)
    });
    let activeRun = this.requireAutopilotRun(run.id);
    await this.addAutopilotEvent(activeRun, "info", "Supervisor queued goal-output alignment review", { taskId: reviewTask.id });
    await this.addAutopilotCheckpoint(activeRun, "Queued goal-output alignment review");
    await this.persistAndBroadcast();

    await this.runAutopilotTask(project, activeRun, reviewTask, signal);
    const completedReview = this.requireAutopilotTask(reviewTask.id);
    activeRun = this.requireAutopilotRun(run.id);
    if (signal.aborted || activeRun.status === "paused" || activeRun.status === "canceled" || activeRun.status === "blocked") {
      return "blocked";
    }
    if (completedReview.status !== "completed") {
      const blocked = this.transitionAutopilotRun(run.id, "blocked", {
        error: completedReview.error || "Goal-output review did not complete.",
        updatedAt: nowIso()
      });
      await this.addAutopilotEvent(blocked, "error", "Goal-output review did not complete", { taskId: completedReview.id, error: blocked.error });
      await this.addAutopilotCheckpoint(blocked, `Blocked: ${blocked.error}`);
      await this.persistAndBroadcast();
      return "blocked";
    }

    activeRun = this.transitionAutopilotRun(run.id, "verifying", { currentStage: "verify", updatedAt: nowIso() });
    const reviewPassed = goalReviewPassed(completedReview.output || "");
    const reviewCheck: AutopilotValidationCheck = {
      validatorId: "goal-alignment",
      label: "Goal and acceptance criteria alignment",
      passed: reviewPassed,
      deterministic: false,
      evidence: completedReview.output?.slice(0, 2_000)
    };
    const reviewViolations = reviewPassed ? [] : extractReviewViolations(completedReview.output || "Goal-output review failed.");
    const evaluationFingerprint = createHash("sha256").update(JSON.stringify({ passed: reviewPassed, violations: reviewViolations.map((item) => item.toLowerCase()).sort() })).digest("hex");
    const evaluation = {
      passed: reviewPassed,
      checks: [reviewCheck],
      violations: reviewViolations,
      evidence: uniqueStrings([...activeRun.evidence, ...(completedReview.evidence || [])]),
      fingerprint: evaluationFingerprint,
      evaluatedAt: nowIso()
    };
    const runTasks = this.state.autopilotTasks.filter((task) => task.runId === run.id);
    const artifactHashes = this.state.dataArtifacts.filter((artifact) => artifact.runId === run.id).map((artifact) => artifact.sha256 || artifact.path);
    const fingerprint = progressFingerprint(runTasks, artifactHashes, evaluationFingerprint);
    const noProgressCount = reviewPassed ? 0 : fingerprint === activeRun.lastProgressFingerprint ? (activeRun.noProgressCount || 1) + 1 : 1;
    activeRun = this.patchAutopilotRun(run.id, {
      lastEvaluation: evaluation,
      lastProgressFingerprint: fingerprint,
      noProgressCount,
      updatedAt: nowIso()
    });

    if (reviewPassed) {
      await this.addAutopilotEvent(activeRun, "info", "Goal-output review passed", { taskId: completedReview.id });
      await this.addAutopilotCheckpoint(activeRun, "Goal-output review passed");
      await this.persistAndBroadcast();
      return "aligned";
    }

    if (noProgressCount >= 3) {
      const blocked = this.transitionAutopilotRun(run.id, "blocked", {
        error: "Autopilot stopped after three verification cycles without measurable progress.",
        updatedAt: nowIso()
      });
      await this.addAutopilotEvent(blocked, "error", "Autopilot no-progress detector stopped the run", { fingerprint, noProgressCount });
      await this.addAutopilotCheckpoint(blocked, "Blocked: no measurable progress");
      await this.persistAndBroadcast();
      return "blocked";
    }

    if (!this.canAppendAutopilotTask(run.id)) {
      const blocked = this.transitionAutopilotRun(run.id, "blocked", {
        error: "Goal-output review failed and no task budget remains for another fix iteration.",
        updatedAt: nowIso()
      });
      await this.addAutopilotEvent(blocked, "error", "Goal-output review failed; task budget exhausted", { taskId: completedReview.id });
      await this.addAutopilotCheckpoint(blocked, "Blocked: goal-output review failed and task budget exhausted");
      await this.persistAndBroadcast();
      return "blocked";
    }

    const fixTask = this.appendAutopilotTask(run.id, {
      stage: "report",
      staffAgent: "analyst",
      title: `Revise outputs to match goal ${this.nextAutopilotIteration(run.id)}`,
      prompt: this.buildGoalAlignmentFixPrompt(run.id, completedReview.output || "Goal-output review failed.")
    });
    const currentPlan = this.requireAutopilotRun(run.id).plan;
    const queuedRun = this.patchAutopilotRun(run.id, {
      plan: currentPlan ? { ...currentPlan, version: currentPlan.version + 1, taskIds: [...currentPlan.taskIds, fixTask.id], updatedAt: nowIso() } : currentPlan,
      updatedAt: nowIso()
    });
    await this.addAutopilotEvent(queuedRun, "warning", "Goal-output review failed; queued fix iteration", { reviewTaskId: completedReview.id, fixTaskId: fixTask.id });
    await this.addAutopilotCheckpoint(queuedRun, "Goal-output review failed; queued fix iteration");
    await this.persistAndBroadcast();
    return "queued-fix";
  }

  private canAppendAutopilotTask(runId: string): boolean {
    const run = this.requireAutopilotRun(runId);
    return run.taskIds.length < (run.budget?.limits.maxTasks || run.writePolicy.maxTasks);
  }

  private nextAutopilotIteration(runId: string): number {
    return this.state.autopilotTasks.filter((task) => task.runId === runId && (task.title.startsWith("Goal-output alignment review") || task.title.startsWith("Revise outputs to match goal"))).length + 1;
  }

  private appendAutopilotTask(runId: string, input: Pick<AutopilotTask, "stage" | "staffAgent" | "title" | "prompt">): AutopilotTask {
    const run = this.requireAutopilotRun(runId);
    const now = nowIso();
    const task: AutopilotTask = {
      id: randomId("aptask"),
      runId: run.id,
      projectId: run.projectId,
      stage: input.stage,
      kind: input.stage === "review" ? "review" : "produce",
      dependsOn: [],
      risk: "low",
      allowedTools: input.stage === "review" ? ["ReadFile"] : ["ReadFile", "WriteFile", "Shell"],
      validators: [],
      staffAgent: input.staffAgent,
      title: input.title,
      prompt: input.prompt,
      status: "queued",
      attempts: 0,
      maxAttempts: Math.max(1, run.writePolicy.maxRetries + 1),
      artifactIds: [],
      evidence: [],
      actionFingerprints: [],
      createdAt: now,
      updatedAt: now
    };
    this.state.autopilotTasks = [...this.state.autopilotTasks, task];
    this.patchAutopilotRun(run.id, {
      taskIds: uniqueStrings([...run.taskIds, task.id]),
      updatedAt: now
    });
    return task;
  }

  private async runAutopilotTask(project: Project, run: AutopilotRun, task: AutopilotTask, signal: AbortSignal): Promise<void> {
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
        updatedAt: startedAt
      });
      const activeRun = this.transitionAutopilotRun(run.id, currentTask.stage === "review" ? "reviewing" : "running", {
        currentStage: currentTask.stage,
        updatedAt: startedAt
      });
      await this.addAutopilotEvent(activeRun, "info", `${currentTask.title} started`, { taskId: currentTask.id, attempt: currentTask.attempts });
      await this.addAutopilotCheckpoint(activeRun, `${currentTask.title} started`);
      await this.persistAndBroadcast();

      try {
        const result = await this.runAutopilotTaskEngine(project, activeRun, currentTask, signal);
        this.incrementAutopilotBudget(run.id, {
          modelTurns: result.trace.turns,
          inputTokens: result.trace.usage?.inputTokens,
          outputTokens: result.trace.usage?.outputTokens,
          totalTokens: result.trace.usage?.totalTokens
        });
        const artifactProject = this.autopilotWorkspaceProject(project, activeRun);
        const artifacts = await this.artifactsFromGeneratedFiles(artifactProject, activeRun, currentTask, result.generatedFiles);
        const artifactIds = artifacts.map((artifact) => artifact.id);
        this.state.dataArtifacts = [
          ...artifacts,
          ...this.state.dataArtifacts.filter((artifact) => !artifactIds.includes(artifact.id))
        ];
        for (const artifact of artifacts) {
          this.emitTyped({ type: "data_artifact", artifact });
        }
        const evaluation = await this.evaluateAutopilotTask(artifactProject, activeRun, currentTask, artifacts, result.text, signal);
        if (!evaluation.passed) {
          throw new Error(`Task validation failed: ${evaluation.violations.join("; ")}`);
        }
        const finishedAt = nowIso();
        currentTask = this.patchAutopilotTask(currentTask.id, {
          status: "completed",
          output: result.text,
          artifactIds: uniqueStrings([...currentTask.artifactIds, ...artifactIds]),
          evidence: uniqueStrings([...currentTask.evidence, ...artifacts.map((artifact) => artifact.path), ...extractEvidencePaths(result.text)]),
          lastEvaluation: evaluation,
          error: undefined,
          failureCategory: undefined,
          updatedAt: finishedAt,
          finishedAt
        });
        const completedRun = this.patchAutopilotRun(run.id, {
          artifactIds: uniqueStrings([...activeRun.artifactIds, ...artifactIds]),
          evidence: uniqueStrings([...activeRun.evidence, ...currentTask.evidence]),
          updatedAt: finishedAt
        });
        await this.addAutopilotEvent(completedRun, "info", `${currentTask.title} completed`, { taskId: currentTask.id, artifacts: artifactIds.length });
        await this.addAutopilotCheckpoint(completedRun, `${currentTask.title} completed`);
        await this.persistAndBroadcast();
        return;
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        const message = (error as Error).message;
        const failureCategory = classifyAutopilotFailure(message);
        const failedAt = nowIso();
        currentTask = this.patchAutopilotTask(currentTask.id, {
          status: currentTask.attempts >= currentTask.maxAttempts ? "blocked" : "failed",
          error: message,
          failureCategory,
          updatedAt: failedAt,
          finishedAt: currentTask.attempts >= currentTask.maxAttempts ? failedAt : undefined
        });
        const level = currentTask.status === "blocked" ? "error" : "warning";
        const currentRun = this.requireAutopilotRun(run.id);
        await this.addAutopilotEvent(currentRun, level, `${currentTask.title} ${currentTask.status}`, { taskId: currentTask.id, error: message, failureCategory });
        if (currentTask.status === "blocked") {
          const blocked = this.transitionAutopilotRun(run.id, "blocked", {
            error: message,
            updatedAt: failedAt
          });
          await this.addAutopilotCheckpoint(blocked, `${currentTask.title} blocked: ${message}`);
          await this.persistAndBroadcast();
          return;
        }
        if (failureCategory === "validation" || failureCategory === "invalid_input") {
          const latest = this.requireAutopilotRun(run.id);
          const replanning = this.transitionAutopilotRun(run.id, "replanning", {
            plan: latest.plan ? { ...latest.plan, version: latest.plan.version + 1, updatedAt: nowIso() } : latest.plan,
            currentStage: "replan",
            updatedAt: nowIso()
          });
          await this.addAutopilotEvent(replanning, "warning", "Autopilot locally replanned the failed task", { taskId: currentTask.id, failureCategory, error: message });
        }
        await this.addAutopilotCheckpoint(this.requireAutopilotRun(run.id), `${currentTask.title} will retry: ${message}`);
        await this.persistAndBroadcast();
        if (failureCategory === "transient") {
          await waitWithAbort(Math.min(8_000, 500 * 2 ** Math.max(0, currentTask.attempts - 1)), signal);
        }
      }
    }
  }

  private async runAutopilotTaskEngine(project: Project, run: AutopilotRun, task: AutopilotTask, signal: AbortSignal): Promise<{ text: string; generatedFiles: GeneratedFile[]; trace: AgentLoopTrace }> {
    const staff = this.resolveStaffSubagent(task.staffAgent);
    const workspaceProject = this.autopilotWorkspaceProject(project, run);
    const directWrite = run.resolvedProfile === "coding" && !run.worktreeId;
    const query = new QueryEngine({
      id: randomId("query"),
      jobId: `${run.id}:${task.id}`,
      conversationId: `autopilot_${run.id}`,
      dataDir: this.storage.getDataDir(),
      cwd: workspaceProject.rootPath,
      modelConfig: this.state.modelConfig,
      apiKey: this.state.modelSecret,
      personality: this.state.personality,
      subagent: staff,
      messages: [{
        id: randomId("msg"),
        conversationId: `autopilot_${run.id}`,
        role: "user",
        text: this.autopilotTaskPrompt(run, task),
        createdAt: nowIso()
      }],
      compactBoundaries: this.state.compactBoundaries,
      memory: this.state.memory,
      registry: this.toolRegistry,
      toolContext: this.createToolExecutionContext(signal, `${run.id}:${task.id}`, 0, {
        project: workspaceProject,
        policy: run.writePolicy,
        task,
        workspacePath: workspaceProject.rootPath,
        allowedWriteRoots: run.resolvedProfile === "coding" ? [workspaceProject.rootPath] : undefined,
        directWriteBackupRoot: directWrite ? join(project.rootPath, ".supbot", "runs", run.id, "backups") : undefined
      }),
      permissionMode: "default",
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
        await this.recordAutopilotToolProgress(run.id, task.id, toolCall);
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
        await this.handlePermissionTimeout(permission);
      }
    });
    const result = await query.submitTurn();
    return { text: result.text, generatedFiles: result.generatedFiles, trace: result.trace };
  }

  private autopilotWorkspaceProject(project: Project, run: AutopilotRun): Project {
    const worktree = run.worktreeId ? this.worktreeManager.get(run.worktreeId) : undefined;
    if (!worktree) {
      return project;
    }
    return {
      ...project,
      rootPath: worktree.path,
      metadataPath: join(worktree.path, ".supbot", "project.json")
    };
  }

  private async evaluateAutopilotTask(
    project: Project,
    run: AutopilotRun,
    task: AutopilotTask,
    newArtifacts: DataArtifact[],
    output: string,
    signal: AbortSignal
  ) {
    const checks: AutopilotValidationCheck[] = [];
    const artifacts = [...newArtifacts, ...this.state.dataArtifacts.filter((artifact) => artifact.runId === run.id)];
    for (const validator of task.validators || []) {
      if (validator.kind === "model_review") {
        checks.push({
          validatorId: validator.id,
          label: validator.label,
          passed: true,
          deterministic: false,
          evidence: "Deferred to the final goal-alignment review."
        });
        continue;
      }
      if (validator.kind === "artifact_exists") {
        const normalized = (validator.path || "").replace(/\\/g, "/").replace(/^\.\//, "");
        const artifact = artifacts.find((item) => item.path.replace(/\\/g, "/").includes(`/${normalized}/`) || item.path.replace(/\\/g, "/").endsWith(`/${normalized}`));
        checks.push({
          validatorId: validator.id,
          label: validator.label,
          passed: Boolean(artifact),
          deterministic: true,
          evidence: artifact?.path,
          error: artifact ? undefined : `No recorded artifact matched ${validator.path}.`
        });
        continue;
      }
      if (validator.kind === "json_parse" || validator.kind === "csv_parse") {
        const target = artifacts.find((item) => !validator.path || item.path.replace(/\\/g, "/").endsWith(validator.path.replace(/\\/g, "/")));
        let passed = false;
        let error: string | undefined;
        if (!target) {
          error = `Artifact not found: ${validator.path || validator.label}`;
        } else {
          try {
            const content = await readFile(target.path, "utf8");
            if (validator.kind === "json_parse") {
              JSON.parse(content);
            } else {
              const rows = content.trim().split(/\r?\n/);
              if (rows.length < 2 || !rows[0].includes(",")) {
                throw new Error("CSV must contain a header and at least one data row.");
              }
            }
            passed = true;
          } catch (parseError) {
            error = (parseError as Error).message;
          }
        }
        checks.push({ validatorId: validator.id, label: validator.label, passed, deterministic: true, evidence: target?.path, error });
        continue;
      }
      if (validator.kind === "command") {
        const command = validator.command === "auto" ? await this.detectVerificationCommand(project.rootPath) : validator.command;
        if (!command) {
          checks.push({ validatorId: validator.id, label: validator.label, passed: false, deterministic: true, error: "No repository verification command could be detected." });
          continue;
        }
        const result = await runShellCommand(command, signal, 120_000, project.rootPath);
        checks.push({
          validatorId: validator.id,
          label: validator.label,
          passed: result.exitCode === 0,
          deterministic: true,
          evidence: `Command: ${command}\nExit code: ${result.exitCode}\n${result.stdout.slice(-2_000)}`,
          error: result.exitCode === 0 ? undefined : result.stderr.slice(-2_000) || `Command exited with ${result.exitCode}.`
        });
      }
    }
    if (!checks.length) {
      checks.push({
        validatorId: "task-result",
        label: "Task returned a non-empty result",
        passed: Boolean(output.trim()),
        deterministic: true,
        evidence: output.slice(0, 1_000),
        error: output.trim() ? undefined : "Task returned no result."
      });
    }
    const failed = checks.filter((check) => !check.passed);
    const fingerprint = createHash("sha256").update(JSON.stringify(checks.map((check) => ({ id: check.validatorId, passed: check.passed, evidence: check.evidence, error: check.error })))).digest("hex");
    return {
      passed: failed.length === 0,
      checks,
      violations: failed.map((check) => check.error || `${check.label} failed.`),
      evidence: uniqueStrings(checks.flatMap((check) => check.evidence ? [check.evidence] : [])),
      fingerprint,
      evaluatedAt: nowIso()
    };
  }

  private async detectVerificationCommand(rootPath: string): Promise<string | undefined> {
    try {
      const pkg = JSON.parse(await readFile(join(rootPath, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.verify) return "npm run verify";
      if (pkg.scripts?.test) return "npm test";
      if (pkg.scripts?.build) return "npm run build";
    } catch {
      // Try other project types below.
    }
    for (const [file, command] of [["pyproject.toml", "pytest -q"], ["Cargo.toml", "cargo test"], ["go.mod", "go test ./..."]] as const) {
      try {
        await stat(join(rootPath, file));
        return command;
      } catch {
        // Continue probing.
      }
    }
    return undefined;
  }

  private async recordAutopilotToolProgress(runId: string, taskId: string, toolCall: ToolCallRecord): Promise<void> {
    const run = this.requireAutopilotRun(runId);
    const task = this.requireAutopilotTask(taskId);
    const fingerprint = createHash("sha256").update(`${toolCall.toolName}\n${stableJson(toolCall.input)}`).digest("hex");
    const existing = this.state.autopilotActions.find((action) => action.id === toolCall.id);
    const terminal = toolCall.status === "completed" || toolCall.status === "failed" || toolCall.status === "denied";
    const status: AutopilotActionRecord["status"] = toolCall.status === "completed" ? "completed" : toolCall.status === "failed" ? "failed" : toolCall.status === "denied" ? "denied" : "started";
    const retrySafety: AutopilotActionRecord["retrySafety"] = toolCall.toolName === "ReadFile" || toolCall.toolName === "WriteFile" || toolCall.toolName === "Agent"
      ? "safe"
      : toolCall.toolName === "Shell" ? "confirm" : "never";
    const action: AutopilotActionRecord = {
      id: toolCall.id,
      runId,
      taskId,
      fingerprint,
      toolName: toolCall.toolName,
      status,
      retrySafety,
      durationMs: Math.max(0, new Date(toolCall.updatedAt).getTime() - new Date(toolCall.createdAt).getTime()),
      inputSummary: JSON.stringify(toolCall.input).slice(0, 1_000),
      outputSummary: toolCall.output?.slice(0, 1_000),
      error: toolCall.error,
      createdAt: existing?.createdAt || toolCall.createdAt,
      updatedAt: toolCall.updatedAt
    };
    this.state.autopilotActions = [action, ...this.state.autopilotActions.filter((item) => item.id !== action.id)];
    this.autopilotMetricsCache.delete(runId);
    if (!existing) {
      this.incrementAutopilotBudget(runId, { toolCalls: 1 });
    }
    if (terminal) {
      this.patchAutopilotTask(taskId, { actionFingerprints: uniqueStrings([...(task.actionFingerprints || []), fingerprint]), updatedAt: nowIso() });
      await this.autopilotRunStore.appendAction(run, action);
    }
    if (toolCall.status === "pending_permission") {
      const permissionId = `perm_${toolCall.id}`;
      this.transitionAutopilotRun(runId, "waiting_approval", {
        pendingDecision: {
          id: permissionId,
          kind: "tool",
          title: `Approve ${toolCall.toolName}`,
          summary: `Autopilot requested ${toolCall.toolName} while executing ${task.title}.`,
          risk: toolCall.toolName.startsWith("mcp.") ? "high" : "medium",
          impact: [JSON.stringify(toolCall.input).slice(0, 500)],
          rollbackPlan: retrySafety === "safe" ? "The action can be retried from the latest checkpoint." : "The action will not be retried automatically after an uncertain result.",
          taskId,
          toolName: toolCall.toolName,
          input: toolCall.input,
          createdAt: nowIso()
        },
        updatedAt: nowIso()
      });
    }
  }

  private incrementAutopilotBudget(runId: string, usage: Partial<NonNullable<AutopilotRun["budget"]>["usage"]>): void {
    const run = this.requireAutopilotRun(runId);
    if (!run.budget) {
      return;
    }
    const current = run.budget.usage;
    this.patchAutopilotRun(runId, {
      budget: {
        ...run.budget,
        usage: {
          ...current,
          iterations: current.iterations + (usage.iterations || 0),
          modelTurns: current.modelTurns + (usage.modelTurns || 0),
          toolCalls: current.toolCalls + (usage.toolCalls || 0),
          inputTokens: sumOptionalNumber(current.inputTokens, usage.inputTokens),
          outputTokens: sumOptionalNumber(current.outputTokens, usage.outputTokens),
          totalTokens: sumOptionalNumber(current.totalTokens, usage.totalTokens)
        }
      },
      loopIteration: (run.loopIteration || 0) + (usage.iterations || 0),
      updatedAt: nowIso()
    });
  }

  private appendMessage(conversationId: string, message: ChatMessage): void {
    this.state.conversations = this.state.conversations.map((conversation) => {
      if (conversation.id !== conversationId) {
        return conversation;
      }
      const now = nowIso();
      return {
        ...conversation,
        title: conversation.title === "New conversation" && message.role === "user" ? titleFromPrompt(message.text) : conversation.title,
        updatedAt: now,
        lastMessageAt: now,
        messages: [...conversation.messages, message]
      };
    });
  }

  private replaceMessage(conversationId: string, messageId: string, message: ChatMessage): void {
    this.state.conversations = this.state.conversations.map((conversation) => conversation.id === conversationId
      ? {
          ...conversation,
          updatedAt: nowIso(),
          lastMessageAt: nowIso(),
          messages: conversation.messages.map((item) => item.id === messageId ? message : item)
        }
      : conversation);
  }

  private updateAssistantMessageForJob(conversationId: string, jobId: string, status: JobStatus, text: string): void {
    this.state.conversations = this.state.conversations.map((conversation) => conversation.id === conversationId
      ? {
          ...conversation,
          messages: conversation.messages.map((message) => message.jobId === jobId ? { ...message, text, status } : message)
        }
      : conversation);
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
        progress: [...job.progress, progress].slice(-100)
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

  private requireAutopilotRun(id: string): AutopilotRun {
    const run = this.state.autopilotRuns.find((item) => item.id === id);
    if (!run) {
      throw new Error(`Autopilot run not found: ${id}`);
    }
    return run;
  }

  private calculateAutopilotRunMetrics(id: string): AutopilotRunMetrics {
    const run = this.requireAutopilotRun(id);
    const cached = this.autopilotMetricsCache.get(id);
    if (cached?.updatedAt === run.updatedAt) {
      return cached.metrics;
    }
    const metrics = calculateAutopilotMetrics(
      run,
      this.state.autopilotTasks.filter((task) => task.runId === id),
      this.state.autopilotActions.filter((action) => action.runId === id),
      this.state.autopilotEvents.filter((event) => event.runId === id)
    );
    this.autopilotMetricsCache.set(id, { updatedAt: run.updatedAt, metrics });
    return metrics;
  }

  private calculateAutopilotQuality(metrics = this.state.autopilotRuns.map((run) => this.calculateAutopilotRunMetrics(run.id))): AutopilotQualitySummary {
    return summarizeAutopilotQuality(metrics, this.state.autopilotTasks);
  }

  private requireAutopilotTask(id: string): AutopilotTask {
    const task = this.state.autopilotTasks.find((item) => item.id === id);
    if (!task) {
      throw new Error(`Autopilot task not found: ${id}`);
    }
    return task;
  }

  private resetRetryableAutopilotTasks(runId: string): void {
    const now = nowIso();
    this.state.autopilotTasks = this.state.autopilotTasks.map((task) => task.runId === runId && (task.status === "blocked" || task.status === "failed")
      ? { ...task, status: "queued", attempts: 0, error: undefined, failureCategory: undefined, finishedAt: undefined, updatedAt: now }
      : task);
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

  private transitionAutopilotRun(id: string, status: AutopilotRun["status"], patch: Partial<AutopilotRun> = {}): AutopilotRun {
    const current = this.requireAutopilotRun(id);
    if (!canTransitionAutopilot(current.status, status)) {
      throw new Error(`Invalid Autopilot transition: ${current.status} -> ${status}`);
    }
    return this.patchAutopilotRun(id, { ...patch, status });
  }

  private failAutopilotRun(id: string, error: unknown, failedAt = nowIso()): AutopilotRun {
    const current = this.requireAutopilotRun(id);
    const patch: Partial<AutopilotRun> = {
      error: error instanceof Error ? error.message : String(error),
      updatedAt: failedAt,
      finishedAt: failedAt
    };
    return canTransitionAutopilot(current.status, "failed")
      ? this.transitionAutopilotRun(id, "failed", patch)
      : this.patchAutopilotRun(id, { ...patch, status: "failed" });
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
    if (next) {
      this.autopilotMetricsCache.delete(next.runId);
    }
    return next || this.requireAutopilotTask(id);
  }

  private async addAutopilotEvent(run: AutopilotRun, level: AutopilotEvent["level"], message: string, data?: unknown): Promise<AutopilotEvent> {
    const event: AutopilotEvent = {
      id: randomId("apevent"),
      runId: run.id,
      projectId: run.projectId,
      level,
      message,
      createdAt: nowIso(),
      data
    };
    this.state.autopilotEvents = [event, ...this.state.autopilotEvents].slice(0, 500);
    this.autopilotMetricsCache.delete(run.id);
    await this.autopilotRunStore.appendEvent(this.requireAutopilotRun(run.id), event);
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
      planVersion: run.plan?.version,
      budgetUsage: run.budget?.usage ? { ...run.budget.usage } : undefined,
      createdAt: nowIso()
    };
    this.state.autopilotCheckpoints = [checkpoint, ...this.state.autopilotCheckpoints];
    this.state.autopilotRuns = this.state.autopilotRuns.map((item) => item.id === run.id
      ? { ...item, checkpointIds: uniqueStrings([checkpoint.id, ...item.checkpointIds]), updatedAt: nowIso() }
      : item);
    await this.writeAutopilotCheckpointFile(run, checkpoint);
    const activeRun = this.requireAutopilotRun(run.id);
    await this.autopilotRunStore.writeSnapshot(
      activeRun,
      this.state.autopilotTasks.filter((task) => task.runId === run.id),
      this.state.dataArtifacts.filter((artifact) => artifact.runId === run.id)
    );
    return checkpoint;
  }

  private async writeAutopilotCheckpointFile(run: AutopilotRun, checkpoint: AutopilotCheckpoint): Promise<void> {
    const runDir = join(run.projectRoot, ".supbot", "runs", run.id);
    await mkdir(runDir, { recursive: true });
    const payload = {
      checkpoint,
      run: this.state.autopilotRuns.find((item) => item.id === run.id) || run,
      tasks: this.state.autopilotTasks.filter((task) => task.runId === run.id),
      artifacts: this.state.dataArtifacts.filter((artifact) => artifact.runId === run.id)
    };
    await writeFile(join(runDir, "checkpoint.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  private async artifactsFromGeneratedFiles(project: Project, run: AutopilotRun, task: AutopilotTask, files: GeneratedFile[]): Promise<DataArtifact[]> {
    const artifacts: DataArtifact[] = [];
    for (const file of files) {
      if (!pathIsInside(project.rootPath, file.path)) {
        continue;
      }
      artifacts.push(await this.dataArtifactFromPath(project, run, task, file.path, task.title));
    }
    return artifacts;
  }

  private async dataArtifactFromPath(project: Project, run: AutopilotRun, task: Pick<AutopilotTask, "id" | "stage">, filePath: string, source: string): Promise<DataArtifact> {
    const info = await stat(filePath);
    const { sha256, lineCount } = await inspectArtifactFile(filePath);
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
      sha256,
      lineCount,
      createdAt: nowIso()
    };
  }

  private async writeAutopilotRunReportArtifact(run: AutopilotRun): Promise<DataArtifact> {
    const project = this.requireProject(run.projectId);
    const reportPath = join(project.rootPath, "reports", `autopilot-${run.id}-summary.md`);
    const tasks = this.state.autopilotTasks.filter((task) => task.runId === run.id);
    const artifacts = this.state.dataArtifacts.filter((artifact) => artifact.runId === run.id);
    const approvalHistory = formatAutopilotApprovalHistory(this.state.autopilotEvents.filter((event) => event.runId === run.id));
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
      artifacts.length ? artifacts.map((artifact) => `- ${artifact.kind}: ${artifact.path}`).join("\n") : "- No artifacts recorded.",
      "",
      "## Approval History",
      approvalHistory,
      "",
      "## Stage Outputs",
      tasks.map((task) => [
        `### ${task.title}`,
        `Status: ${task.status}`,
        task.output || task.error || "No output."
      ].join("\n\n")).join("\n\n"),
      ""
    ].join("\n");
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, content, "utf8");
    return this.dataArtifactFromPath(project, run, { id: `${run.id}:summary`, stage: "review" }, reportPath, "autopilot summary");
  }

  private resolveStaffSubagent(name: string): SubagentConfig {
    const key = name.toLowerCase();
    const existing = this.state.subagents.find((item) => item.enabled && (item.id.toLowerCase() === key || item.name.toLowerCase() === key));
    if (existing) {
      return existing;
    }
    return {
      id: key || "collector",
      name: key || "collector",
      description: "Autopilot data staff-agent",
      systemPrompt: "You are a local data staff-agent. Work inside the approved project folders and return evidence-backed output.",
      enabled: true
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
      .map((task) => [
        `## ${task.stage}: ${task.title}`,
        task.output || "Completed without text output.",
        task.artifactIds.length ? `Artifacts: ${task.artifactIds.join(", ")}` : "Artifacts: none"
      ].join("\n"))
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
      "Then provide concise evidence and, for FAIL, concrete fixes needed."
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
      "Mention every file changed and evidence path in the final answer."
    ].join("\n");
  }

  private autopilotTaskPrompt(run: AutopilotRun, task: AutopilotTask): string {
    const tasks = this.state.autopilotTasks.filter((item) => item.runId === run.id);
    const artifactPaths = this.state.dataArtifacts.filter((artifact) => artifact.runId === run.id).map((artifact) => artifact.path);
    return [
      task.prompt,
      "",
      compactAutopilotContext(run, task, tasks, artifactPaths),
      task.error ? `\nPrevious attempt error:\n${task.error}` : ""
    ].join("\n");
  }

  private findConversation(id: string): Conversation | undefined {
    return this.state.conversations.find((item) => item.id === id);
  }

  private async recoverTranscriptsOnStartup(): Promise<void> {
    const store = new TranscriptStore(this.storage.getDataDir());
    let changed = false;
    for (const conversation of this.state.conversations) {
      const result = await store.loadRecoverable(conversation.id, conversation.messages, this.state.compactBoundaries);
      if (result.diagnostics.length || result.source === "state") {
        const event: RuntimeEventRecord = {
          id: randomId("event"),
          conversationId: conversation.id,
          kind: "transcript_recovery",
          message: result.source === "state"
            ? `Transcript fallback used for ${conversation.title}.`
            : `Transcript checked for ${conversation.title}.`,
          createdAt: nowIso(),
          data: {
            source: result.source,
            activeMessageCount: result.activeMessages.length,
            compactBoundaryId: result.compactBoundary?.id,
            diagnostics: result.diagnostics
          }
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
      if (!["queued", "analyzing", "planning", "running", "verifying", "replanning", "reviewing", "waiting_approval"].includes(run.status)) {
        continue;
      }
      if (run.status === "waiting_approval" && run.pendingDecision) {
        continue;
      }
      const uncertain = this.state.autopilotActions.find((action) => action.runId === run.id && action.status === "started" && action.retrySafety !== "safe");
      const next = uncertain ? this.patchAutopilotRun(run.id, {
        status: "waiting_approval",
        pendingDecision: {
          id: randomId("apdecision"),
          kind: "recovery",
          title: "Resolve an uncertain external action",
          summary: `${uncertain.toolName} was in progress when Supbot stopped. Its outcome cannot be safely inferred.`,
          risk: "high",
          impact: [uncertain.inputSummary],
          rollbackPlan: "Inspect the external system before approving a retry from the latest checkpoint.",
          taskId: uncertain.taskId,
          toolName: uncertain.toolName,
          createdAt: nowIso()
        },
        error: "Recovered with an uncertain external side effect.",
        updatedAt: nowIso()
      }) : this.patchAutopilotRun(run.id, {
        status: "paused",
        error: "Recovered after app restart. Resume the run to continue.",
        updatedAt: nowIso()
      });
      await this.addAutopilotEvent(next, "warning", uncertain ? "Autopilot recovery requires approval" : "Autopilot run recovered and paused after app restart");
      await this.addAutopilotCheckpoint(next, uncertain ? "Recovered with uncertain external action" : "Recovered and paused after app restart");
      changed = true;
    }
    if (changed) {
      await this.storage.save(this.state);
    }
  }

  private defaultWorkspacePath(): string {
    return join(this.storage.getDataDir(), "generated-files");
  }

  private createToolExecutionContext(signal: AbortSignal, jobId: string, depth = 0, options: ProjectToolContextOptions = {}) {
    const job = this.findRootJob(jobId);
    const worktree = job?.worktreeId ? this.worktreeManager.get(job.worktreeId) : undefined;
    const project = options.project;
    const workspacePath = options.workspacePath || project?.rootPath || worktree?.path || this.defaultWorkspacePath();
    const allowedWriteRoots = options.allowedWriteRoots || (project ? this.projectManager.absoluteAllowedWriteRoots(workspacePath, options.policy) : undefined);
    const runId = jobId.split(":", 1)[0];
    const completedActionFingerprints = this.state.autopilotActions
      .filter((action) => action.runId === runId && action.status === "completed")
      .map((action) => action.fingerprint);
    const host: LocalToolHost = {
      dataDir: this.storage.getDataDir(),
      workspacePath,
      cwd: workspacePath,
      worktreeId: worktree?.id,
      projectId: project?.id,
      projectRoot: project ? workspacePath : undefined,
      allowedWriteRoots,
      backupRoot: options.directWriteBackupRoot,
      randomId,
      nowIso
    };
    return {
      signal,
      workspaceMode: job?.workspaceMode || "main",
      projectId: project?.id,
      projectRoot: project ? workspacePath : undefined,
      allowedWriteRoots,
      autopilotPolicy: options.task ? {
        allowedTools: options.task.allowedTools?.length ? options.task.allowedTools : ["ReadFile"],
        allowNetwork: options.policy?.allowNetwork !== false,
        allowMcp: options.policy?.allowMcp !== false,
        autoApproveSandboxWrites: options.task.risk !== "high",
        autoApproveVerificationCommands: options.task.kind === "verify" || options.task.stage === "verify" || options.task.stage === "review"
      } : undefined,
      completedActionFingerprints: options.task ? completedActionFingerprints : undefined,
      host,
      ensureIsolatedWorkspace: async (toolName: string) => this.ensureJobWorktree(jobId, toolName),
      subagents: this.state.subagents,
      runSubagent: async (input: { subagentType?: string; prompt: string; signal: AbortSignal }): Promise<LocalToolResult> => {
        const runner = new SubagentRunner({
          dataDir: this.storage.getDataDir(),
          cwd: workspacePath,
          modelConfig: this.state.modelConfig,
          apiKey: this.state.modelSecret,
          personality: this.state.personality,
          subagents: this.state.subagents,
          compactBoundaries: this.state.compactBoundaries,
          memory: this.state.memory,
          registry: this.toolRegistry,
          permissionMode: this.state.permissionMode,
          permissionRules: this.state.permissionRules,
          randomId,
          createToolContext: (childSignal, parentJobId, childDepth) => this.createToolExecutionContext(childSignal, parentJobId, childDepth, options),
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
            await this.handlePermissionTimeout(permission);
          }
        });
        return runner.run({
          parentJobId: jobId,
          subagentType: input.subagentType,
          prompt: input.prompt,
          signal: input.signal,
          depth
        });
      }
    };
  }

  private async requestToolPermission(permission: PendingToolPermission): Promise<"approved" | "denied"> {
    if (this.runningJobs.get(permission.jobId)?.controller.signal.aborted) {
      return "denied";
    }
    this.state.pendingToolPermissions = [
      ...this.state.pendingToolPermissions.filter((item) => item.id !== permission.id),
      permission
    ];
    const decisionPromise = new Promise<"approved" | "denied">((resolve) => {
      this.permissionWaiters.set(permission.id, { resolve });
    });
    await this.persistAndBroadcast();
    this.emitTyped({ type: "tool_permission", permission });
    return decisionPromise;
  }

  private resolvePermission(permissionId: string, decision: "approved" | "denied"): PendingToolPermission | undefined {
    const permission = this.state.pendingToolPermissions.find((item) => item.id === permissionId);
    const waiter = this.permissionWaiters.get(permissionId);
    this.permissionWaiters.delete(permissionId);
    this.state.pendingToolPermissions = this.state.pendingToolPermissions.filter((item) => item.id !== permissionId);
    waiter?.resolve(decision);
    return permission;
  }

  private settleAutopilotToolDecision(permissionId: string): { run: AutopilotRun; restart: boolean } | undefined {
    const run = this.state.autopilotRuns.find((item) => item.pendingDecision?.kind === "tool" && item.pendingDecision.id === permissionId);
    if (!run) {
      return undefined;
    }
    const hasActiveSupervisor = this.runningAutopilotRuns.has(run.id);
    const task = run.pendingDecision?.taskId
      ? this.state.autopilotTasks.find((item) => item.id === run.pendingDecision?.taskId)
      : undefined;
    const nextStatus: AutopilotRun["status"] = hasActiveSupervisor
      ? task?.stage === "review" ? "reviewing" : "running"
      : "queued";
    return {
      run: this.transitionAutopilotRun(run.id, nextStatus, { pendingDecision: undefined, updatedAt: nowIso() }),
      restart: !hasActiveSupervisor
    };
  }

  private async handlePermissionTimeout(permission: PendingToolPermission): Promise<void> {
    const settlement = this.settleAutopilotToolDecision(permission.id);
    this.resolvePermission(permission.id, "denied");
    if (settlement) {
      await this.addAutopilotEvent(settlement.run, "warning", "Autopilot tool approval timed out", { permissionId: permission.id });
    }
    await this.persistAndBroadcast();
    this.emitTyped({ type: "permission_timeout", permission });
    if (settlement?.restart) {
      this.runInBackground(this.runAutopilot(settlement.run.id), `Autopilot run ${settlement.run.id}`);
    }
  }

  private resolveJobPermissions(jobId: string, decision: "approved" | "denied"): void {
    const permissions = this.state.pendingToolPermissions.filter((item) => item.jobId === jobId || item.jobId.startsWith(`${jobId}:`));
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
          nowIso
        };
      }
    }
    try {
      const worktree = await this.worktreeManager.createForJob({ jobId: job.id, conversationId: job.conversationId });
      this.state.worktrees = this.worktreeManager.list();
      this.markJobWorktree(worktree);
      await this.persistAndBroadcast();
      return {
        dataDir: this.storage.getDataDir(),
        workspacePath: worktree.path,
        cwd: worktree.path,
        worktreeId: worktree.id,
        randomId,
        nowIso
      };
    } catch (error) {
      const message = `Could not create isolated worktree for ${toolName}: ${(error as Error).message}`;
      const event = this.createRuntimeEvent("worktree_event", message, { toolName }, job.id, job.conversationId);
      this.addRuntimeEvent(event);
      await this.appendTranscript(job.conversationId, { type: "event", event });
      throw new Error(`${message}. Create a baseline Git commit before running writable tools.`);
    }
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

  private async completeJobWorktreeSafely(jobId: string): Promise<void> {
    try {
      await this.completeJobWorktree(jobId);
    } catch (error) {
      const job = this.findRootJob(jobId);
      const event: RuntimeEventRecord = {
        id: randomId("event"),
        jobId,
        conversationId: job?.conversationId,
        kind: "worktree_event",
        message: "Job completed, but worktree finalization failed.",
        createdAt: nowIso(),
        data: { error: error instanceof Error ? error.message : String(error) }
      };
      this.addRuntimeEvent(event);
      if (job?.conversationId) {
        await this.appendTranscript(job.conversationId, { type: "event", event })
          .catch((appendError) => this.reportBackgroundError(`Job ${jobId} worktree event transcript`, appendError));
      }
      this.emitTyped({ type: "query_event", event });
    }
  }

  private async finishJobWorktree(jobId: string, status: JobStatus, message: string): Promise<void> {
    const job = this.findRootJob(jobId);
    if (!job?.worktreeId) {
      return;
    }
    const worktree = status === "canceled"
      ? await this.worktreeManager.abandon(job.worktreeId, message)
      : await this.worktreeManager.fail(job.worktreeId, message);
    this.state.worktrees = this.worktreeManager.list();
    this.markJobWorktree(worktree);
  }

  private markJobWorktree(worktree: TaskWorktree): void {
    this.upsertWorktreeState(worktree);
    this.state.jobs = this.state.jobs.map((job) => job.id === worktree.jobId
      ? {
          ...job,
          workspaceMode: worktree.status === "discarded" || worktree.status === "applied" ? job.workspaceMode : "isolated",
          worktreeId: worktree.id,
          baseRef: worktree.baseRef,
          diffStatus: worktree.diffStatus,
          updatedAt: nowIso()
        }
      : job);
  }

  private upsertWorktreeState(worktree: TaskWorktree): void {
    this.state.worktrees = [
      worktree,
      ...this.state.worktrees.filter((item) => item.id !== worktree.id)
    ];
  }

  private upsertTrace(trace: RuntimeState["agentLoopTraces"][number]): void {
    this.state.agentLoopTraces = [
      trace,
      ...this.state.agentLoopTraces.filter((item) => !(item.jobId === trace.jobId && item.conversationId === trace.conversationId))
    ].slice(0, 100);
  }

  private upsertToolCall(jobId: string, toolCall: RuntimeState["agentLoopTraces"][number]["toolCalls"][number]): void {
    const trace = this.state.agentLoopTraces.find((item) => item.jobId === jobId) || {
      jobId,
      conversationId: toolCall.conversationId,
      turns: 0,
      toolCalls: [],
      startedAt: toolCall.createdAt,
      updatedAt: toolCall.updatedAt
    };
    const next = {
      ...trace,
      updatedAt: nowIso(),
      toolCalls: [
        ...trace.toolCalls.filter((item) => item.id !== toolCall.id),
        toolCall
      ]
    };
    this.upsertTrace(next);
  }

  private upsertQuerySession(session: QuerySession): void {
    this.state.querySessions = [
      session,
      ...this.state.querySessions.filter((item) => item.id !== session.id)
    ].slice(0, 100);
  }

  private addRuntimeEvent(event: RuntimeEventRecord): void {
    this.state.runtimeEvents = [
      event,
      ...this.state.runtimeEvents.filter((item) => item.id !== event.id)
    ].slice(0, 300);
  }

  private createRuntimeEvent(kind: RuntimeEventRecord["kind"], message: string, data?: unknown, jobId?: string, conversationId?: string): RuntimeEventRecord {
    return {
      id: randomId("event"),
      jobId,
      conversationId,
      kind,
      message,
      createdAt: nowIso(),
      data
    };
  }

  private async appendTranscript(conversationId: string, entry: Parameters<TranscriptStore["append"]>[1]): Promise<void> {
    try {
      await new TranscriptStore(this.storage.getDataDir()).append(conversationId, entry);
    } catch {
      // Transcript is recovery/debug data; failed writes must not break the active turn.
    }
  }

  private async recordPermissionDecision(permission: PendingToolPermission, decision: "approved" | "denied"): Promise<void> {
    const event: RuntimeEventRecord = {
      id: randomId("event"),
      jobId: permission.jobId,
      conversationId: permission.conversationId,
      kind: "permission_decision",
      message: `${permission.toolName} permission ${decision}`,
      createdAt: nowIso(),
      data: { permission, decision }
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
      data
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
      data: data ? { serverId, ...objectData(data) } : { serverId }
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
      enabled
    };
    this.state.capabilities = [
      ...this.state.capabilities.filter((item) => item.id !== capability.id),
      capability
    ];
  }

  private appendAssistantDelta(conversationId: string, messageId: string, delta: string): void {
    this.state.conversations = this.state.conversations.map((conversation) => {
      if (conversation.id !== conversationId) {
        return conversation;
      }
      return {
        ...conversation,
        updatedAt: nowIso(),
        lastMessageAt: nowIso(),
        messages: conversation.messages.map((message) => {
          if (message.id !== messageId) {
            return message;
          }
          const current = message.text.endsWith("is thinking...") ? "" : message.text;
          const text = `${current}${delta}`;
          return {
            ...message,
            text,
            blocks: [
              ...(message.blocks || []).filter((block) => block.type !== "message_delta"),
              { type: "message_delta", text }
            ]
          };
        })
      };
    });
  }

  private upsertCompactBoundary(boundary: CompactBoundary): void {
    this.state.compactBoundaries = [
      boundary,
      ...this.state.compactBoundaries.filter((item) => item.id !== boundary.id)
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
    const context = this.createToolExecutionContext(signal, job.id);
    const executor = new ToolExecutor();
    const executeSlash = async (toolName: string, input: unknown) => {
      const envelope = await executor.execute({
        jobId: job.id,
        conversationId: job.conversationId,
        toolCall: {
          id: randomId("tool"),
          type: "function",
          function: { name: toolName, arguments: JSON.stringify(input) }
        },
        registry: this.toolRegistry,
        context,
        permissionMode: toolName === "ReadFile" ? "bypassPermissions" : this.state.permissionMode,
        permissionRules: this.state.permissionRules,
        requestPermission: (permission) => this.requestToolPermission(permission),
        onPermissionTimeout: async (permission) => {
          await this.handlePermissionTimeout(permission);
        },
        onProgress: async (toolCall) => {
          this.upsertToolCall(job.id, toolCall);
          await this.persistAndBroadcast();
          this.emitTyped({ type: "tool_progress", toolCall });
        }
      });
      return {
        text: envelope.toolResultText,
        generatedFiles: envelope.generatedFiles
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
      workspaceMode: "readOnly"
    });
  }

  private async sendRemotePromptAndWait(input: SendPromptInput & { timeoutMs?: number; signal?: AbortSignal }): Promise<ReversePromptResult> {
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
            workspaceMode: job.workspaceMode
          },
          error: job.error
        };
      }
      await delay(250);
    }
    return {
      status: "failed",
      conversationId: sent.job.conversationId,
      jobId: sent.job.id,
      error: "Timed out waiting for Supbot prompt result."
    };
  }

  async servstationA2AAccessToken(signal?: AbortSignal, forceRefresh = false): Promise<string | undefined> { 
    if (this.state.servstationA2AConfig.authMode !== "oidc") { 
      return this.state.servstationA2ASecret; 
    } 
    let tokens = parseServstationOidcSecret(this.state.servstationA2AOidcSecret); 
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

  private async updateServstationReverseState(input: Partial<NonNullable<ServstationA2AConfig["reverse"]>>): Promise<void> {
    this.assertLoaded();
    const current = this.state.servstationA2AConfig.reverse || { enabled: false, status: "disconnected" as const };
    const next = {
      ...current,
      ...input,
      updatedAt: nowIso()
    };
    if (next.enabled === false) {
      next.status = "disconnected";
      next.connectedAt = undefined;
    }
    this.state.servstationA2AConfig = {
      ...this.state.servstationA2AConfig,
      reverse: next,
      updatedAt: nowIso()
    };
    const event = this.createRuntimeEvent("servstation_a2a", `Servstation reverse A2A ${next.status}`, {
      reverse: next
    });
    this.addRuntimeEvent(event);
    await this.persistAndBroadcast();
    this.emitTyped({ type: "servstation_a2a", config: this.redactServstationA2AConfig(), event });
  }

  private findAssistantMessageForJob(conversationId: string, jobId: string): ChatMessage | undefined {
    const conversation = this.findConversation(conversationId);
    return conversation?.messages
      .filter((message) => message.role === "assistant" && message.jobId === jobId)
      .at(-1);
  }

  private redactServstationA2AConfig(): ServstationA2AConfig {
    return {
      ...this.state.servstationA2AConfig,
      bearerTokenSaved: Boolean(this.state.servstationA2ASecret),
      staffAgentPasswordSaved: Boolean(this.state.servstationA2AStaffAgentPasswordSecret),
      staffAgentPasswordStorage: this.state.servstationA2AStaffAgentPasswordSecret
        ? this.state.servstationA2AConfig.staffAgentPasswordStorage || this.secretStorageKind || "file"
        : undefined,
      oidc: this.redactServstationA2AOidcConfig()
    };
  }

  private redactServstationA2AOidcConfig(): NonNullable<ServstationA2AConfig["oidc"]> {
    const tokens = parseServstationOidcSecret(this.state.servstationA2AOidcSecret);
    return {
      ...(this.state.servstationA2AConfig.oidc || { refreshTokenSaved: false }),
      accessTokenExpiresAt: tokens?.expiresAt || this.state.servstationA2AConfig.oidc?.accessTokenExpiresAt,
      refreshTokenSaved: Boolean(tokens?.refreshToken),
      userId: this.state.servstationA2AConfig.oidc?.userId || this.state.identityContext?.userId
    };
  }

  private async persistAndBroadcast(): Promise<void> {
    await this.storage.save(this.state);
    this.emitTyped({ type: "snapshot", snapshot: this.snapshot() });
  }

  private emitTyped(event: SupbotEvent): void {
    this.emit("event", event);
  }

  private runInBackground(task: Promise<unknown>, label: string): void {
    void task.catch((error) => this.reportBackgroundError(label, error));
  }

  private reportBackgroundError(label: string, error: unknown): void {
    const message = `${label} failed: ${error instanceof Error ? error.message : String(error)}`;
    try {
      console.error(message, error);
      this.emitTyped({ type: "error", message });
    } catch (reportError) {
      console.error("Failed to report Supbot background error", reportError);
    }
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error("SupbotRuntime.init() must be called before use.");
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

  private async installToolMarketPackage(product: ToolMarketProduct, deployment: ToolMarketLocalDeployment): Promise<string> {
    const installPath = this.localToolInstallDir(product, deployment);
    const receiptPath = this.toolMarketInstallDir(product);
    if (!pathIsInside(this.storage.getDataDir(), installPath) || !pathIsInside(this.storage.getDataDir(), receiptPath)) {
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
        free: product.free
      },
      deployment: {
        kind: deployment.kind,
        capability: deployment.capability || product.capability,
        commandTemplates: deployment.commandTemplates || product.commandTemplates || [],
        mcpServer: deployment.mcpServer,
        files: (deployment.files || []).map((file) => ({
          path: file.path,
          encoding: file.encoding || "utf8"
        }))
      }
    };
    await writeFile(join(installPath, "supbot-local-tool.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await mkdir(receiptPath, { recursive: true });
    await writeFile(join(receiptPath, "supbot-market-install.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return installPath;
  }

  private upsertMarketMcpServer(product: ToolMarketProduct, deployment: ToolMarketLocalDeployment, installPath: string): McpServerConfig | undefined {
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
      autoConnect: product.origin !== "remote" && Boolean(input.autoConnect),
      createdAt: current?.createdAt || now,
      updatedAt: now
    };
    this.state.mcpServers = [
      server,
      ...this.state.mcpServers.filter((item) => item.id !== server.id)
    ];
    this.mcpManager.setServers(this.state.mcpServers);
    this.upsertMcpCapability();
    return server;
  }

  private async removeMarketMcpServer(product: ToolMarketProduct, deployment: ToolMarketLocalDeployment): Promise<void> {
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
      password: this.state.toolMarketPasswordSecret
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

async function writeLocalToolScaffold(root: string, product: ToolMarketProduct, deployment: ToolMarketLocalDeployment): Promise<void> {
  const declaredFiles = new Set((deployment.files || []).map((file) => normalizePackagePath(file.path)));
  const templates = deployment.commandTemplates || product.commandTemplates || [];
  if (deployment.kind === "skill" && !declaredFiles.has("skill.md")) {
    await writeFile(join(root, "SKILL.md"), renderSkillFile(product, templates), "utf8");
  }
  if (deployment.kind === "plugin") {
    if (!declaredFiles.has(".codex-plugin/plugin.json")) {
      await mkdir(join(root, ".codex-plugin"), { recursive: true });
      await writeFile(join(root, ".codex-plugin", "plugin.json"), `${JSON.stringify({
        id: marketInstallSlug(product.id),
        name: product.name,
        version: "1.0.0",
        description: product.description
      }, null, 2)}\n`, "utf8");
    }
    if (!declaredFiles.has("readme.md")) {
      await writeFile(join(root, "README.md"), renderPluginReadme(product, templates), "utf8");
    }
  }
  if (deployment.kind === "tool" && !declaredFiles.has("supbot-tool.json")) {
    await writeFile(join(root, "supbot-tool.json"), `${JSON.stringify(localToolDescriptor(product, deployment), null, 2)}\n`, "utf8");
  }
  if (deployment.kind === "mcp" && !declaredFiles.has("supbot-mcp.json")) {
    await writeFile(join(root, "supbot-mcp.json"), `${JSON.stringify(localToolDescriptor(product, deployment), null, 2)}\n`, "utf8");
  }
}

function normalizePackagePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
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
    ...(templates.length ? [
      "## Templates",
      "",
      ...templates.map((template) => `- ${JSON.stringify(template)}`),
      ""
    ] : [])
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
    ...(templates.length ? [
      "## Templates",
      "",
      ...templates.map((template) => `- ${JSON.stringify(template)}`),
      ""
    ] : [])
  ].join("\n");
}

function localToolDescriptor(product: ToolMarketProduct, deployment: ToolMarketLocalDeployment): Record<string, unknown> {
  return {
    id: product.id,
    name: product.name,
    kind: deployment.kind,
    description: product.description,
    commandTemplates: deployment.commandTemplates || product.commandTemplates || [],
    mcpServer: deployment.mcpServer
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
    enabled: true
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
      ...(mcpServer ? { mcpServer } : {})
    }
  };
}

function normalizeMarketProductType(value: unknown): ToolMarketProduct["type"] {
  return value === "skill" || value === "plugin" || value === "mcp" || value === "tool" ? value : "tool";
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringRecordValue(value: Record<string, unknown>, key: string): string | undefined {
  const entry = value[key];
  return typeof entry === "string" && entry.trim() ? entry.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}

function manifestCapability(value: unknown, fallback: CapabilityDefinition): CapabilityDefinition {
  const input = objectRecord(value);
  return {
    id: stringRecordValue(input, "id") || fallback.id,
    name: stringRecordValue(input, "name") || fallback.name,
    kind: normalizeCapabilityKind(input.kind, fallback.kind),
    description: stringRecordValue(input, "description") || fallback.description,
    enabled: input.enabled !== false
  };
}

function normalizeCapabilityKind(value: unknown, fallback: CapabilityDefinition["kind"]): CapabilityDefinition["kind"] {
  return value === "skill" || value === "tool" || value === "plugin" || value === "mcp" || value === "subagent" || value === "scheduler" || value === "storage"
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
    autoConnect: Boolean(input.autoConnect)
  };
}

function manifestEnv(value: unknown): Record<string, string> | undefined {
  const input = objectRecord(value);
  const entries = Object.entries(input)
    .filter(([key, entry]) => key.trim() && typeof entry === "string")
    .map(([key, entry]) => [key.trim(), entry as string]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function redactModelConfig(config: ModelConfig, secret?: string): ModelConfig {
  return {
    ...config,
    apiKeySaved: Boolean(secret),
    apiKeyStorage: secret ? config.apiKeyStorage || "file" : undefined
  };
}

export function redactToolMarketConfig(config: ToolMarketConfig, secret?: string, passwordSecret?: string): ToolMarketConfig {
  return {
    ...config,
    accessTokenSaved: Boolean(secret),
    passwordSaved: Boolean(passwordSecret),
    tokenStorage: secret ? config.tokenStorage || "file" : undefined,
    passwordStorage: passwordSecret ? config.passwordStorage || "file" : undefined
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
    throw new Error("Servstation A2A URL is invalid.");
  }
}

function normalizeDataSources(sources: DataSourceSpec[]): DataSourceSpec[] {
  return sources.map((source) => ({
    id: source.id?.trim() || randomId("source"),
    kind: normalizeDataSourceKind(source.kind),
    label: source.label?.trim() || source.path || source.url || source.mcpToolName || source.shellCommand || "Data source",
    path: source.path?.trim() || undefined,
    paths: Array.isArray(source.paths) ? source.paths.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()) : undefined,
    url: source.url?.trim() || undefined,
    method: source.method === "POST" ? "POST" : source.method === "GET" ? "GET" : undefined,
    headers: source.headers && typeof source.headers === "object" ? source.headers : undefined,
    body: source.body,
    mcpToolName: source.mcpToolName?.trim() || undefined,
    shellCommand: source.shellCommand?.trim() || undefined
  }));
}

function normalizeDataSourceKind(kind: DataSourceSpec["kind"]): DataSourceSpec["kind"] {
  return kind === "localFiles" || kind === "folderScan" || kind === "httpApi" || kind === "webUrl" || kind === "mcpTool" || kind === "shellCommand" ? kind : "folderScan";
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

async function inspectArtifactFile(filePath: string): Promise<{ sha256: string; lineCount: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  let newlines = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.length;
    for (const byte of buffer) {
      if (byte === 0x0a) {
        newlines += 1;
      }
    }
  }
  return {
    sha256: hash.digest("hex"),
    lineCount: bytes ? newlines + 1 : 0
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || randomId("subagent");
}

function normalizeToolMarketSource(value: ToolMarketConfigUpdate["source"]): ToolMarketConfig["source"] {
  return value === "remote" || value === "hybrid" || value === "local" ? value : "local";
}

function normalizePermissionMode(value: PermissionMode): PermissionMode {
  return value === "acceptEdits" || value === "bypassPermissions" || value === "plan" || value === "default" ? value : "default";
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

function waitWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(finish, ms);
    const onAbort = () => finish(new Error("Autopilot retry canceled."));
    function finish(error?: Error) {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolvePromise();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
      status: status === "denied" || status === "failed" || status === "completed" || status === "running" ? status : "pending"
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
        outputTruncated: record.outputTruncated
      }
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
    "Continue from this summary and the preserved recent messages. Do not treat this as permanent memory."
  ].join("\n");
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
    [0, 6]
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
