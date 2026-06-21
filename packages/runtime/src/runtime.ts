import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  clampNumber,
  type AgentJob,
  type Attachment,
  type CapabilityDefinition,
  type ChatMessage,
  type ChatMessageBlock,
  type CompactBoundary,
  type Conversation,
  type GeneratedFile,
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
  type MemorySnapshot,
  type MemoryTransfer,
  type MemoryUpdateInput,
  type ModelConfig,
  type ModelConfigUpdate,
  type ModelTestResult,
  nowIso,
  type PendingToolPermission,
  type PermissionMode,
  type PermissionRule,
  type PersonalityConfig,
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
  type SubagentConfig,
  type SupbotEvent,
  type TaskWorktree,
  type ToolCallRecord,
  type WorktreeDiffSummary,
  type ToolMarketCatalogItem,
  type ToolMarketConfig,
  type ToolMarketConfigUpdate,
  type ToolMarketQuery
} from "@supbot/shared";
import { stripQuotes, type LocalToolHost, type LocalToolResult } from "./localTools";
import { MemoryManager } from "./memoryManager";
import { McpManager } from "./mcpManager";
import { generateReply } from "./modelClient";
import { QueryEngine } from "./queryEngine";
import { RemoteBridgeManager } from "./remoteBridgeManager";
import { createInitialState, type RuntimeState, type StorageAdapter } from "./storage";
import { SubagentRunner } from "./subagentRunner";
import { ToolExecutor } from "./toolExecutor";
import { ToolRegistry } from "./toolRegistry";
import { TranscriptStore } from "./transcriptStore";
import { fetchRemoteToolMarketProducts, findLocalToolMarketProduct, findMarketProduct, listToolMarketCatalog, localToolMarketProducts } from "./toolMarket";
import { WorktreeManager } from "./worktreeManager";

interface RunningJob {
  controller: AbortController;
}

interface PendingPermissionWaiter {
  resolve(decision: "approved" | "denied"): void;
}

export class SupbotRuntime extends EventEmitter {
  private state: RuntimeState = createInitialState();
  private readonly runningJobs = new Map<string, RunningJob>();
  private readonly permissionWaiters = new Map<string, PendingPermissionWaiter>();
  private readonly toolRegistry = new ToolRegistry();
  private readonly mcpManager: McpManager;
  private readonly worktreeManager: WorktreeManager;
  private readonly remoteBridgeManager: RemoteBridgeManager;
  private readonly memoryManager = new MemoryManager({ randomId, nowIso });
  private remoteMarketCache = [] as typeof localToolMarketProducts;
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
    this.toolRegistry.addProvider(this.mcpManager);
  }

  async init(): Promise<RuntimeSnapshot> {
    this.state = await this.storage.load();
    this.mcpManager.setServers(this.state.mcpServers);
    this.worktreeManager.setWorktrees(this.state.worktrees);
    this.loaded = true;
    await this.recoverTranscriptsOnStartup();
    await this.remoteBridgeManager.configure({
      config: this.state.remoteBridgeConfig,
      token: this.state.remoteBridgeSecret,
      sessions: this.state.remoteBridgeSessions,
      audit: this.state.remoteBridgeAudit
    });
    await this.mcpManager.autoConnectEnabled();
    return this.snapshot();
  }

  snapshot(): RuntimeSnapshot {
    this.assertLoaded();
    return {
      status: this.runningJobs.size ? "running" : "ready",
      agentName: this.state.agentName,
      modelConfig: redactModelConfig(this.state.modelConfig, this.state.modelSecret),
      toolMarketConfig: redactToolMarketConfig(this.state.toolMarketConfig, this.state.toolMarketSecret, this.state.toolMarketPasswordSecret),
      personality: this.state.personality,
      capabilities: this.state.capabilities,
      subagents: this.state.subagents,
      conversations: this.state.conversations,
      jobs: this.state.jobs,
      scheduledJobs: this.state.scheduledJobs,
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
      remoteBridge: this.remoteBridgeManager.snapshot()
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
    this.state.conversations = this.state.conversations.filter((item) => item.id !== id);
    this.state.jobs = this.state.jobs.filter((item) => item.conversationId !== id);
    await this.persistAndBroadcast();
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
      messageId: conversation.messages.at(-1)?.id || conversation.messages[0]?.id,
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
    await this.mcpManager.disconnectAll();
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
      await this.sendPrompt({ prompt: `[Scheduled] ${job.title}\n\n${job.prompt}` });
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
    let remote = [] as typeof localToolMarketProducts;
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
        this.emitTyped({ type: "error", message: (error as Error).message });
      }
    }
    return listToolMarketCatalog([...local, ...remote], this.state.capabilities, query);
  }

  async installToolMarketProduct(productId: string): Promise<ToolMarketCatalogItem> {
    this.assertLoaded();
    const product = await this.resolveMarketProduct(productId);
    if (!product) {
      throw new Error(`Tool market product not found: ${productId}`);
    }
    const capability: CapabilityDefinition = {
      ...product.capability,
      enabled: true
    };
    this.state.capabilities = [
      ...this.state.capabilities.filter((item) => item.id !== capability.id),
      capability
    ];
    await this.persistAndBroadcast();
    return listToolMarketCatalog([product], this.state.capabilities, {}).find((item) => item.id === product.id)!;
  }

  async uninstallToolMarketProduct(productId: string): Promise<ToolMarketCatalogItem> {
    this.assertLoaded();
    const product = await this.resolveMarketProduct(productId);
    if (!product) {
      throw new Error(`Tool market product not found: ${productId}`);
    }
    this.state.capabilities = this.state.capabilities.filter((item) => item.id !== product.capability.id);
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
    const info = await stat(filePath);
    return {
      id: randomId("att"),
      name: basename(filePath),
      path: filePath,
      size: info.size
    };
  }

  async generatedFilePath(file: GeneratedFile): Promise<string> {
    this.assertLoaded();
    return file.path;
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
        await this.completeJobWorktree(jobId);
        await this.persistAndBroadcast();
        this.emitTyped({ type: "message", conversationId: conversation.id, message: finalMessage });
        return;
      }
      const engine = new QueryEngine({
        id: randomId("query"),
        jobId,
        conversationId: conversation.id,
        dataDir: this.storage.getDataDir(),
        cwd: process.cwd(),
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
          await this.persistAndBroadcast();
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
          this.resolvePermission(permission.id, "denied");
          await this.persistAndBroadcast();
          this.emitTyped({ type: "permission_timeout", permission });
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
      await this.completeJobWorktree(jobId);
      await this.persistAndBroadcast();
      this.emitTyped({ type: "message", conversationId: conversation.id, message: finalMessage });
    } catch (error) {
      const status: JobStatus = controller.signal.aborted ? "canceled" : "failed";
      const message = controller.signal.aborted ? "Canceled by user" : (error as Error).message;
      this.updateAssistantMessageForJob(job.conversationId, jobId, status, message);
      this.updateJob(jobId, status, message);
      await this.finishJobWorktree(jobId, status, message);
      await this.persistAndBroadcast();
      this.emitTyped({ type: "error", message });
    } finally {
      this.runningJobs.delete(jobId);
      this.emitTyped({ type: "snapshot", snapshot: this.snapshot() });
    }
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
        progress: [...job.progress, progress]
      };
    });
    const updated = this.findJob(jobId);
    if (updated) {
      this.emitTyped({ type: "job", job: updated });
    }
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

  private createToolExecutionContext(signal: AbortSignal, jobId: string, depth = 0) {
    const job = this.findRootJob(jobId);
    const worktree = job?.worktreeId ? this.worktreeManager.get(job.worktreeId) : undefined;
    const workspacePath = worktree?.path || this.rootDir;
    const host: LocalToolHost = {
      dataDir: this.storage.getDataDir(),
      workspacePath,
      cwd: workspacePath,
      worktreeId: worktree?.id,
      randomId,
      nowIso
    };
    return {
      signal,
      workspaceMode: job?.workspaceMode || "main",
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
          createToolContext: (childSignal, parentJobId, childDepth) => this.createToolExecutionContext(childSignal, parentJobId, childDepth),
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
            blocks: [{ type: "message_delta", text }]
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
        permissionMode: "bypassPermissions",
        permissionRules: this.state.permissionRules,
        requestPermission: (permission) => this.requestToolPermission(permission),
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

  private async persistAndBroadcast(): Promise<void> {
    await this.storage.save(this.state);
    this.emitTyped({ type: "snapshot", snapshot: this.snapshot() });
  }

  private emitTyped(event: SupbotEvent): void {
    this.emit("event", event);
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error("SupbotRuntime.init() must be called before use.");
    }
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
