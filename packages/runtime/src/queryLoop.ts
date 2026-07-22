import type {
  AgentLoopTrace,
  GeneratedFile,
  PendingToolPermission,
  PermissionMode,
  PermissionRule,
  RuntimeEventRecord,
  ToolCallRecord,
} from "@supbot/shared";
import { nowIso } from "@supbot/shared";
import type { AdapterMessage, AdapterToolCall, ModelAdapter } from "./modelAdapter";
import { ToolExecutor } from "./toolExecutor";
import type { ToolExecutionContext, ToolRegistry } from "./toolRegistry";

export type QueryLoopEvent =
  | { type: "message_delta"; delta: string }
  | { type: "tool_use_start"; toolCall: AdapterToolCall }
  | { type: "tool_progress"; record: ToolCallRecord }
  | { type: "tool_result"; record: ToolCallRecord }
  | { type: "turn_complete"; text: string; trace: AgentLoopTrace; generatedFiles: GeneratedFile[] }
  | { type: "turn_failed"; error: string; trace: AgentLoopTrace };

export interface QueryLoopInput {
  jobId: string;
  conversationId: string;
  messages: AdapterMessage[];
  model: ModelAdapter;
  modelRequest: Omit<Parameters<ModelAdapter["complete"]>[0], "messages">;
  registry: ToolRegistry;
  toolContext: ToolExecutionContext;
  permissionMode: PermissionMode;
  permissionRules: PermissionRule[];
  maxTurns?: number;
  permissionTimeoutMs?: number;
  requestPermission(permission: PendingToolPermission): Promise<"approved" | "denied">;
  onPermissionTimeout?(permission: PendingToolPermission): Promise<void> | void;
  onEvent(event: QueryLoopEvent): Promise<void> | void;
}

export interface QueryLoopResult {
  text: string;
  trace: AgentLoopTrace;
  generatedFiles: GeneratedFile[];
  events: RuntimeEventRecord[];
}

export async function queryLoop(input: QueryLoopInput): Promise<QueryLoopResult> {
  const maxTurns = input.maxTurns ?? 32;
  const messages = [...input.messages];
  const trace: AgentLoopTrace = {
    jobId: input.jobId,
    conversationId: input.conversationId,
    turns: 0,
    toolCalls: [],
    startedAt: nowIso(),
    updatedAt: nowIso(),
  };
  const generatedFiles: GeneratedFile[] = [];
  const events: RuntimeEventRecord[] = [];
  const toolExecutor = new ToolExecutor();

  try {
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      trace.turns = turn;
      trace.updatedAt = nowIso();
      const modelRequest = {
        ...input.modelRequest,
        tools: input.registry.toOpenAiTools(),
      };
      const streamed = input.model.stream({
        ...modelRequest,
        messages,
      });
      let result: Awaited<ReturnType<ModelAdapter["complete"]>> | undefined;
      for await (const event of streamed) {
        if (event.type === "message_delta") {
          await emit(input, events, { type: "message_delta", delta: event.delta });
        }
        if (event.type === "tool_calls") {
          for (const toolCall of event.toolCalls) {
            await emit(input, events, { type: "tool_use_start", toolCall });
          }
        }
        if (event.type === "done") {
          result = event.result;
        }
      }
      if (!result) {
        result = await input.model.complete({ ...modelRequest, messages });
      }

      if (!result.toolCalls.length) {
        await emit(input, events, { type: "turn_complete", text: result.text, trace, generatedFiles });
        return { text: result.text, trace, generatedFiles, events };
      }

      messages.push({
        role: "assistant",
        content: result.text || null,
        tool_calls: result.toolCalls,
      });

      const envelopes = await executeToolBatch(result.toolCalls, input, toolExecutor, trace);
      for (const envelope of envelopes) {
        trace.toolCalls = upsertRecord(trace.toolCalls, envelope.record);
        generatedFiles.push(...envelope.generatedFiles);
        messages.push({
          role: "tool",
          tool_call_id: envelope.record.id,
          content: envelope.toolResultText,
        });
        await emit(input, events, { type: "tool_result", record: envelope.record });
      }
    }
    const artifactCompletionText = artifactCompletionFromTrace(trace);
    if (artifactCompletionText) {
      await emit(input, events, { type: "turn_complete", text: artifactCompletionText, trace, generatedFiles });
      return { text: artifactCompletionText, trace, generatedFiles, events };
    }
    throw new Error(`Agent loop reached maxTurns (${maxTurns}) before producing a final answer.`);
  } catch (error) {
    const message = (error as Error).message;
    await emit(input, events, { type: "turn_failed", error: message, trace });
    throw error;
  }
}

async function executeToolBatch(
  toolCalls: AdapterToolCall[],
  input: QueryLoopInput,
  executor: ToolExecutor,
  trace: AgentLoopTrace,
) {
  const envelopes = [];
  const safe: Array<{ index: number; toolCall: AdapterToolCall }> = [];
  for (let index = 0; index < toolCalls.length; index += 1) {
    const toolCall = toolCalls[index]!;
    const tool = input.registry.get(toolCall.function.name);
    if (tool?.concurrency === "safe") {
      safe.push({ index, toolCall });
      continue;
    }
    if (safe.length) {
      envelopes.push(...(await executeSafeGroup(safe.splice(0), input, executor, trace)));
    }
    envelopes.push(await executeOne(toolCall, input, executor, trace));
  }
  if (safe.length) {
    envelopes.push(...(await executeSafeGroup(safe, input, executor, trace)));
  }
  return envelopes;
}

async function executeSafeGroup(
  group: Array<{ index: number; toolCall: AdapterToolCall }>,
  input: QueryLoopInput,
  executor: ToolExecutor,
  trace: AgentLoopTrace,
) {
  const results = await Promise.all(
    group.map((item) => executeOne(item.toolCall, input, executor, trace).then((result) => ({ ...item, result }))),
  );
  return results.sort((a, b) => a.index - b.index).map((item) => item.result);
}

async function executeOne(
  toolCall: AdapterToolCall,
  input: QueryLoopInput,
  executor: ToolExecutor,
  trace: AgentLoopTrace,
) {
  return executor.execute({
    jobId: input.jobId,
    conversationId: input.conversationId,
    toolCall,
    registry: input.registry,
    context: input.toolContext,
    permissionMode: input.permissionMode,
    permissionRules: input.permissionRules,
    permissionTimeoutMs: input.permissionTimeoutMs,
    requestPermission: input.requestPermission,
    onPermissionTimeout: input.onPermissionTimeout,
    onProgress: async (record) => {
      trace.toolCalls = upsertRecord(trace.toolCalls, record);
      trace.updatedAt = nowIso();
      await emit(input, [], { type: "tool_progress", record });
    },
  });
}

function upsertRecord(records: ToolCallRecord[], record: ToolCallRecord): ToolCallRecord[] {
  return [...records.filter((item) => item.id !== record.id), record];
}

function artifactCompletionFromTrace(trace: AgentLoopTrace): string | undefined {
  const completedOutputs = [...trace.toolCalls]
    .reverse()
    .filter((record) => record.status === "completed" && record.output?.trim())
    .map((record) => record.output || "");
  for (const output of completedOutputs) {
    const summary = artifactSummaryLine(output);
    if (summary) {
      return `Completed. ${summary}`;
    }
  }
  return undefined;
}

function artifactSummaryLine(output: string): string | undefined {
  const artifactExtension = /\.(pptx|docx|xlsx|pdf|csv|tsv|txt|md|html|png|jpe?g|webp)\b/i;
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.find(
      (line) => /(saved to|wrote|created|copied|fullpath|path|name)/i.test(line) && artifactExtension.test(line),
    ) || lines.find((line) => artifactExtension.test(line) && /[\\/]/.test(line))
  );
}

async function emit(input: QueryLoopInput, events: RuntimeEventRecord[], event: QueryLoopEvent): Promise<void> {
  if (events) {
    events.push(toRuntimeEvent(input.jobId, input.conversationId, event));
  }
  await input.onEvent(event);
}

export function toRuntimeEvent(jobId: string, conversationId: string, event: QueryLoopEvent): RuntimeEventRecord {
  const createdAt = nowIso();
  const id = `event_${createdAt.replace(/[^0-9]/g, "")}_${Math.random().toString(36).slice(2, 8)}`;
  switch (event.type) {
    case "message_delta":
      return { id, jobId, conversationId, kind: "message_delta", message: event.delta, createdAt, data: event };
    case "tool_use_start":
      return {
        id,
        jobId,
        conversationId,
        kind: "tool_use_start",
        message: `${event.toolCall.function.name} started`,
        createdAt,
        data: event.toolCall,
      };
    case "tool_progress":
      return {
        id,
        jobId,
        conversationId,
        kind: "tool_progress",
        message: `${event.record.toolName}: ${event.record.status}`,
        createdAt,
        data: event.record,
      };
    case "tool_result":
      return {
        id,
        jobId,
        conversationId,
        kind: "tool_result",
        message: `${event.record.toolName}: ${event.record.status}`,
        createdAt,
        data: event.record,
      };
    case "turn_complete":
      return {
        id,
        jobId,
        conversationId,
        kind: "turn_complete",
        message: "Turn complete",
        createdAt,
        data: { text: event.text },
      };
    case "turn_failed":
      return { id, jobId, conversationId, kind: "turn_failed", message: event.error, createdAt, data: event.trace };
  }
}
