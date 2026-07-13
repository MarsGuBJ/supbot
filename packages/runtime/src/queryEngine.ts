import type {
  AgentLoopTrace,
  CapabilityDefinition,
  ChatMessage,
  CompactBoundary,
  GeneratedFile,
  ModelConfig,
  MemoryCandidate,
  MemorySnapshot,
  PendingToolPermission,
  PermissionMode,
  PermissionRule,
  PersonalityConfig,
  QuerySession,
  RuntimeEventRecord,
  SubagentConfig,
  ToolCallRecord
} from "@supbot/shared";
import { nowIso } from "@supbot/shared";
import { CompactManager } from "./compactManager";
import { ContextManager } from "./contextManager";
import { MemoryManager } from "./memoryManager";
import { OpenAIChatCompletionsAdapter, type ModelAdapter } from "./modelAdapter";
import { queryLoop, toRuntimeEvent, type QueryLoopEvent } from "./queryLoop";
import { TranscriptStore } from "./transcriptStore";
import type { ToolExecutionContext, ToolRegistry } from "./toolRegistry";

export interface QueryEngineInput {
  id: string;
  jobId: string;
  conversationId: string;
  dataDir: string;
  cwd?: string;
  modelConfig: ModelConfig;
  apiKey?: string;
  personality: PersonalityConfig;
  subagent?: SubagentConfig;
  capabilities: CapabilityDefinition[];
  messages: ChatMessage[];
  compactBoundaries: CompactBoundary[];
  memory: MemorySnapshot;
  registry: ToolRegistry;
  toolContext: ToolExecutionContext;
  permissionMode: PermissionMode;
  permissionRules: PermissionRule[];
  signal: AbortSignal;
  maxTurns?: number;
  model?: ModelAdapter;
  requestPermission(permission: PendingToolPermission): Promise<"approved" | "denied">;
  onSession(session: QuerySession): Promise<void> | void;
  onRuntimeEvent(event: RuntimeEventRecord): Promise<void> | void;
  onMessageDelta(delta: string): Promise<void> | void;
  onTrace(trace: AgentLoopTrace): Promise<void> | void;
  onToolProgress(record: ToolCallRecord): Promise<void> | void;
  onCompact(boundary: CompactBoundary): Promise<void> | void;
  onMemoryChanged(memory: MemorySnapshot): Promise<void> | void;
  onMemoryCandidate(candidate: MemoryCandidate): Promise<void> | void;
  onPermissionTimeout(permission: PendingToolPermission): Promise<void> | void;
}

export interface QueryEngineResult {
  text: string;
  trace: AgentLoopTrace;
  generatedFiles: GeneratedFile[];
  compactBoundary?: CompactBoundary;
}

export class QueryEngine {
  private readonly contextManager = new ContextManager();
  private readonly compactManager = new CompactManager();
  private readonly memoryManager: MemoryManager;
  private readonly transcriptStore: TranscriptStore;
  private readonly model: ModelAdapter;

  constructor(private readonly input: QueryEngineInput) {
    this.transcriptStore = new TranscriptStore(input.dataDir);
    this.model = input.model || new OpenAIChatCompletionsAdapter();
    this.memoryManager = new MemoryManager(input.toolContext.host);
  }

  async submitTurn(): Promise<QueryEngineResult> {
    const startedAt = nowIso();
    let memorySnapshot = this.input.memory;
    let session: QuerySession = {
      id: this.input.id,
      jobId: this.input.jobId,
      conversationId: this.input.conversationId,
      status: "running",
      turns: 0,
      startedAt,
      updatedAt: startedAt,
      subagentName: this.input.subagent?.name
    };
    await this.input.onSession(session);
    await this.recordRuntimeEvent({
      id: this.randomEventId(),
      jobId: this.input.jobId,
      conversationId: this.input.conversationId,
      kind: "query_start",
      message: this.input.subagent ? `@${this.input.subagent.name} started` : "Query started",
      createdAt: startedAt
    });

    let compactBoundary: CompactBoundary | undefined;
    if (this.compactManager.shouldCompact(this.input.messages, this.input.compactBoundaries)) {
      compactBoundary = this.compactManager.createBoundary({
        conversationId: this.input.conversationId,
        jobId: this.input.jobId,
        messages: this.input.messages,
        randomId: this.input.toolContext.host.randomId,
        nowIso: this.input.toolContext.host.nowIso
      });
      if (compactBoundary) {
        await this.input.onCompact(compactBoundary);
        await this.transcriptStore.append(this.input.conversationId, { type: "compact", boundary: compactBoundary });
        await this.recordRuntimeEvent({
          id: this.randomEventId(),
          jobId: this.input.jobId,
          conversationId: this.input.conversationId,
          kind: "compact",
          message: "Conversation compacted",
          createdAt: compactBoundary.createdAt,
          data: compactBoundary
        });
        memorySnapshot = await this.createMemoryCandidates(memorySnapshot, compactBoundary);
      }
    }

    const activeCompactBoundary = compactBoundary || latestBoundaryFor(this.input.conversationId, this.input.compactBoundaries);
    const recallQuery = latestUserPrompt(this.input.messages);
    const recall = this.memoryManager.recall(memorySnapshot, {
      query: recallQuery,
      scope: "all",
      conversationId: this.input.conversationId,
      subagentName: this.input.subagent?.name,
      excludeSources: activeCompactBoundary ? [`compact:${activeCompactBoundary.id}`] : [],
      limit: 6,
      budgetChars: 6000
    });
    memorySnapshot = this.memoryManager.recordRecall(recall.memory, {
      id: this.input.toolContext.host.randomId("mem_recall"),
      conversationId: this.input.conversationId,
      subagentName: this.input.subagent?.name,
      query: recallQuery,
      resultIds: recall.results.map((item) => item.id),
      resultCount: recall.results.length,
      injected: recall.injected,
      budgetChars: recall.budgetChars,
      usedChars: recall.usedChars,
      createdAt: nowIso(),
      results: recall.results.map((item) => ({
        id: item.id,
        title: item.title,
        score: item.score,
        matchedKeywords: item.matchedKeywords,
        reason: item.reason,
        sourceLabel: item.sourceLabel
      })),
      excludedResults: recall.excludedResults.map((item) => ({
        id: item.id,
        title: item.title,
        score: item.score,
        matchedKeywords: item.matchedKeywords,
        reason: item.reason,
        sourceLabel: item.sourceLabel
      })),
      blockPreview: recall.block
    });
    await this.input.onMemoryChanged(memorySnapshot);
    if (recall.results.length) {
      await this.recordRuntimeEvent({
        id: this.randomEventId(),
        jobId: this.input.jobId,
        conversationId: this.input.conversationId,
        kind: "memory_recall",
        message: `Recalled ${recall.results.length} memory item${recall.results.length === 1 ? "" : "s"} (${recall.usedChars}/${recall.budgetChars} chars)`,
        createdAt: nowIso(),
        data: {
          query: recallQuery,
          resultCount: recall.results.length,
          injected: recall.injected,
          budgetChars: recall.budgetChars,
          usedChars: recall.usedChars,
          results: recall.results.map((item) => ({
            id: item.id,
            title: item.title,
            score: item.score,
            matchedKeywords: item.matchedKeywords,
            reason: item.reason,
            sourceLabel: item.sourceLabel
          })),
          excludedResults: recall.excludedResults.map((item) => ({
            id: item.id,
            title: item.title,
            score: item.score,
            matchedKeywords: item.matchedKeywords,
            reason: item.reason,
            sourceLabel: item.sourceLabel
          }))
        }
      });
    }

    const context = await this.contextManager.build({
      dataDir: this.input.dataDir,
      cwd: this.input.cwd,
      personality: this.input.personality,
      subagent: this.input.subagent,
      capabilities: this.input.capabilities,
      messages: this.input.messages,
      compactBoundaries: compactBoundary ? [compactBoundary, ...this.input.compactBoundaries] : this.input.compactBoundaries,
      memoryBlock: recall.block,
      systemContext: {
        conversationId: this.input.conversationId,
        jobId: this.input.jobId
      }
    });

    try {
      const result = await queryLoop({
        jobId: this.input.jobId,
        conversationId: this.input.conversationId,
        messages: context.messages,
        model: this.model,
        modelRequest: {
          modelConfig: this.input.modelConfig,
          apiKey: this.input.apiKey,
          tools: this.input.registry.toOpenAiTools(),
          signal: this.input.signal
        },
        registry: this.input.registry,
        toolContext: this.input.toolContext,
        permissionMode: this.input.permissionMode,
        permissionRules: this.input.permissionRules,
        maxTurns: this.input.maxTurns,
        requestPermission: this.input.requestPermission,
        onPermissionTimeout: async (permission) => {
          await this.input.onPermissionTimeout(permission);
          await this.recordRuntimeEvent({
            id: this.randomEventId(),
            jobId: this.input.jobId,
            conversationId: this.input.conversationId,
            kind: "permission_timeout",
            message: `${permission.toolName} permission timed out`,
            createdAt: nowIso(),
            data: permission
          });
        },
        onEvent: (event) => this.handleLoopEvent(event)
      });
      const finishedAt = nowIso();
      session = {
        ...session,
        status: "completed",
        turns: result.trace.turns,
        updatedAt: finishedAt,
        finishedAt
      };
      await this.input.onSession(session);
      await this.transcriptStore.append(this.input.conversationId, {
        type: "message",
        message: {
          id: this.input.toolContext.host.randomId("msg"),
          conversationId: this.input.conversationId,
          role: "assistant",
          text: result.text,
          createdAt: finishedAt,
          jobId: this.input.jobId,
          status: "completed"
        }
      });
      return { ...result, compactBoundary };
    } catch (error) {
      session = {
        ...session,
        status: this.input.signal.aborted ? "canceled" : "failed",
        updatedAt: nowIso(),
        finishedAt: nowIso(),
        error: (error as Error).message
      };
      await this.input.onSession(session);
      throw error;
    }
  }

  private async handleLoopEvent(event: QueryLoopEvent): Promise<void> {
    if (event.type === "message_delta") {
      await this.input.onMessageDelta(event.delta);
    }
    if (event.type === "tool_progress") {
      await this.input.onToolProgress(event.record);
    }
    if (event.type === "turn_complete" || event.type === "turn_failed") {
      await this.input.onTrace(event.trace);
    }
    const runtimeEvent = toRuntimeEvent(this.input.jobId, this.input.conversationId, event);
    await this.recordRuntimeEvent(runtimeEvent);
  }

  private async recordRuntimeEvent(event: RuntimeEventRecord): Promise<void> {
    await this.input.onRuntimeEvent(event);
    await this.transcriptStore.append(this.input.conversationId, { type: "event", event });
  }

  private async createMemoryCandidates(memory: MemorySnapshot, boundary: CompactBoundary): Promise<MemorySnapshot> {
    const result = this.memoryManager.candidateFromCompact(memory, boundary, this.input.subagent?.name);
    if (!result.candidates.length) {
      return memory;
    }
    await this.input.onMemoryChanged(result.memory);
    for (const candidate of result.candidates) {
      await this.input.onMemoryCandidate(candidate);
      await this.recordRuntimeEvent({
        id: this.randomEventId(),
        jobId: this.input.jobId,
        conversationId: this.input.conversationId,
        kind: "memory_candidate",
        message: "Memory candidate created from compact summary",
        createdAt: candidate.createdAt,
        data: candidate
      });
    }
    return result.memory;
  }

  private randomEventId(): string {
    return this.input.toolContext.host.randomId("event");
  }
}

function latestUserPrompt(messages: ChatMessage[]): string {
  return [...messages].reverse().find((message) => message.role === "user")?.text || "";
}

function latestBoundaryFor(conversationId: string, boundaries: CompactBoundary[]): CompactBoundary | undefined {
  return boundaries
    .filter((boundary) => boundary.conversationId === conversationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
