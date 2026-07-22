import type {
  AgentLoopTrace,
  CapabilityDefinition,
  ChatMessage,
  CompactBoundary,
  GeneratedFile,
  MemoryCandidate,
  MemorySnapshot,
  ModelConfig,
  PendingToolPermission,
  PermissionMode,
  PermissionRule,
  PersonalityConfig,
  QuerySession,
  RuntimeEventRecord,
  SubagentConfig,
  ToolCallRecord,
} from "@supbot/shared";
import { nowIso } from "@supbot/shared";
import type { LocalToolResult } from "./localTools";
import { QueryEngine } from "./queryEngine";
import type { ToolExecutionContext, ToolRegistry } from "./toolRegistry";

export interface SubagentRunnerHost {
  dataDir: string;
  cwd: string;
  modelConfig: ModelConfig;
  apiKey?: string;
  personality: PersonalityConfig;
  capabilities: CapabilityDefinition[];
  subagents: SubagentConfig[];
  compactBoundaries: CompactBoundary[];
  memory: MemorySnapshot;
  registry: ToolRegistry;
  permissionMode: PermissionMode;
  permissionRules: PermissionRule[];
  randomId(prefix: string): string;
  createToolContext(signal: AbortSignal, jobId: string, depth: number): ToolExecutionContext;
  requestPermission(permission: PendingToolPermission): Promise<"approved" | "denied">;
  onSession(session: QuerySession): Promise<void> | void;
  onRuntimeEvent(event: RuntimeEventRecord): Promise<void> | void;
  onTrace(trace: AgentLoopTrace): Promise<void> | void;
  onToolProgress(record: ToolCallRecord): Promise<void> | void;
  onCompact(boundary: CompactBoundary): Promise<void> | void;
  onMemoryChanged(memory: MemorySnapshot): Promise<void> | void;
  onMemoryCandidate(candidate: MemoryCandidate): Promise<void> | void;
  onPermissionTimeout(permission: PendingToolPermission): Promise<void> | void;
}

export interface RunSubagentInput {
  parentJobId: string;
  subagentType?: string;
  prompt: string;
  signal: AbortSignal;
  depth: number;
}

export class SubagentRunner {
  constructor(private readonly host: SubagentRunnerHost) {}

  async run(input: RunSubagentInput): Promise<LocalToolResult> {
    if (input.depth >= 1) {
      return { text: "Subagent nesting is limited to one level in this runtime." };
    }
    const subagent = resolveSubagent(input.subagentType, this.host.subagents);
    if (!subagent) {
      return { text: `Subagent not found or disabled: ${input.subagentType || "default"}` };
    }
    const subagentJobId = `${input.parentJobId}:${subagent.id}`;
    const subagentConversationId = `subagent_${input.parentJobId}`;
    await this.emitSubagentEvent({
      jobId: subagentJobId,
      conversationId: subagentConversationId,
      kind: "subagent_start",
      message: `@${subagent.name} started`,
      data: { subagentName: subagent.name, prompt: input.prompt },
    });

    const subMessages: ChatMessage[] = [
      {
        id: this.host.randomId("msg"),
        conversationId: subagentConversationId,
        role: "user",
        text: input.prompt,
        createdAt: nowIso(),
      },
    ];

    try {
      const engine = new QueryEngine({
        id: this.host.randomId("query"),
        jobId: subagentJobId,
        conversationId: subagentConversationId,
        dataDir: this.host.dataDir,
        cwd: this.host.cwd,
        modelConfig: this.host.modelConfig,
        apiKey: this.host.apiKey,
        personality: this.host.personality,
        subagent,
        capabilities: this.host.capabilities,
        messages: subMessages,
        compactBoundaries: this.host.compactBoundaries,
        memory: this.host.memory,
        registry: this.host.registry,
        toolContext: this.host.createToolContext(input.signal, input.parentJobId, input.depth + 1),
        permissionMode: this.host.permissionMode,
        permissionRules: this.host.permissionRules,
        signal: input.signal,
        maxTurns: 6,
        requestPermission: (permission) => this.host.requestPermission(permission),
        onSession: (session) => this.host.onSession(session),
        onRuntimeEvent: (event) => this.host.onRuntimeEvent(event),
        onMessageDelta: () => undefined,
        onTrace: (trace) => this.host.onTrace(trace),
        onToolProgress: (record) => this.host.onToolProgress(record),
        onCompact: (boundary) => this.host.onCompact(boundary),
        onMemoryChanged: (memory) => this.host.onMemoryChanged(memory),
        onMemoryCandidate: (candidate) => this.host.onMemoryCandidate(candidate),
        onPermissionTimeout: (permission) => this.host.onPermissionTimeout(permission),
      });
      const result = await engine.submitTurn();
      await this.emitSubagentEvent({
        jobId: subagentJobId,
        conversationId: subagentConversationId,
        kind: "subagent_done",
        message: `@${subagent.name} completed`,
        data: { subagentName: subagent.name, output: result.text },
      });
      return {
        text: `@${subagent.name} result:\n\n${result.text}`,
        generatedFiles: result.generatedFiles as GeneratedFile[],
      };
    } catch (error) {
      await this.emitSubagentEvent({
        jobId: subagentJobId,
        conversationId: subagentConversationId,
        kind: "subagent_done",
        message: `@${subagent.name} failed`,
        data: { subagentName: subagent.name, error: (error as Error).message },
      });
      return { text: `Error: @${subagent.name} failed: ${(error as Error).message}` };
    }
  }

  private async emitSubagentEvent(
    input: Pick<RuntimeEventRecord, "jobId" | "conversationId" | "kind" | "message" | "data">,
  ): Promise<void> {
    await this.host.onRuntimeEvent({
      id: this.host.randomId("event"),
      createdAt: nowIso(),
      ...input,
    });
  }
}

function resolveSubagent(name: string | undefined, subagents: SubagentConfig[]): SubagentConfig | undefined {
  const enabled = subagents.filter((item) => item.enabled);
  if (!name?.trim()) {
    return enabled.find((item) => item.id === "research") || enabled[0];
  }
  const key = name.toLowerCase();
  return enabled.find((item) => item.id.toLowerCase() === key || item.name.toLowerCase() === key);
}
