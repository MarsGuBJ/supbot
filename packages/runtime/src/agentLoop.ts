import type {
  AgentLoopTrace,
  ChatMessage,
  GeneratedFile,
  ModelConfig,
  PendingToolPermission,
  PersonalityConfig,
  SubagentConfig,
  ToolCallRecord
} from "@supbot/shared";
import { nowIso } from "@supbot/shared";
import { buildContext, type OpenAiMessage, type OpenAiToolCall } from "./contextBuilder";
import { generateAgentTurn } from "./modelClient";
import { ToolRegistry, type ToolExecutionContext } from "./toolRegistry";

/**
 * @deprecated Runtime v2.5 routes conversation turns through QueryEngine/queryLoop.
 * This module is kept as a compatibility entry for older direct imports.
 */
export interface AgentLoopInput {
  jobId: string;
  conversationId: string;
  modelConfig: ModelConfig;
  apiKey?: string;
  personality: PersonalityConfig;
  subagent?: SubagentConfig;
  messages: ChatMessage[];
  signal: AbortSignal;
  registry: ToolRegistry;
  toolContext: ToolExecutionContext;
  maxTurns?: number;
  requestPermission(permission: PendingToolPermission): Promise<"approved" | "denied">;
  onTrace(trace: AgentLoopTrace): Promise<void> | void;
  onToolProgress(record: ToolCallRecord): Promise<void> | void;
}

export interface AgentLoopResult {
  text: string;
  trace: AgentLoopTrace;
  generatedFiles: GeneratedFile[];
}

export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const maxTurns = input.maxTurns ?? 12;
  const context = buildContext({
    personality: input.personality,
    subagent: input.subagent,
    messages: input.messages,
    systemContext: {
      conversationId: input.conversationId,
      jobId: input.jobId
    }
  });
  const messages: OpenAiMessage[] = [...context.messages];
  const trace: AgentLoopTrace = {
    jobId: input.jobId,
    conversationId: input.conversationId,
    turns: 0,
    toolCalls: [],
    startedAt: nowIso(),
    updatedAt: nowIso()
  };
  const generatedFiles: GeneratedFile[] = [];

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    trace.turns = turn;
    trace.updatedAt = nowIso();
    await input.onTrace({ ...trace, toolCalls: [...trace.toolCalls] });

    const response = await generateAgentTurn({
      modelConfig: input.modelConfig,
      apiKey: input.apiKey,
      messages,
      tools: input.registry.toOpenAiTools(),
      signal: input.signal
    });

    if (!response.toolCalls?.length) {
      return {
        text: response.text,
        trace,
        generatedFiles
      };
    }

    messages.push({
      role: "assistant",
      content: response.text || null,
      tool_calls: response.toolCalls
    });

    for (const toolCall of response.toolCalls) {
      const record = await executeToolCall(toolCall, input, trace, generatedFiles);
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: record.error ? `Error: ${record.error}` : record.output || ""
      });
    }
  }

  throw new Error(`Agent loop reached maxTurns (${maxTurns}) before producing a final answer.`);
}

async function executeToolCall(
  toolCall: OpenAiToolCall,
  input: AgentLoopInput,
  trace: AgentLoopTrace,
  generatedFiles: GeneratedFile[]
): Promise<ToolCallRecord> {
  const toolName = toolCall.function.name;
  const tool = input.registry.get(toolName);
  const parsedInput = parseToolArguments(toolCall.function.arguments);
  const now = nowIso();
  let record: ToolCallRecord = {
    id: toolCall.id,
    jobId: input.jobId,
    conversationId: input.conversationId,
    toolName,
    input: parsedInput,
    status: "running",
    createdAt: now,
    updatedAt: now
  };
  trace.toolCalls.push(record);

  if (!tool) {
    record = updateRecord(trace, record.id, {
      status: "failed",
      error: `Unknown tool: ${toolName}`
    });
    await input.onToolProgress(record);
    return record;
  }

  if (tool.risk === "dangerous") {
    record = updateRecord(trace, record.id, { status: "pending_permission" });
    await input.onToolProgress(record);
    const permission: PendingToolPermission = {
      id: `perm_${record.id}`,
      jobId: input.jobId,
      conversationId: input.conversationId,
      toolCallId: record.id,
      toolName,
      input: parsedInput,
      summary: tool.summarize(parsedInput),
      createdAt: nowIso()
    };
    const decision = await input.requestPermission(permission);
    if (decision === "denied") {
      record = updateRecord(trace, record.id, {
        status: "denied",
        error: `User denied ${toolName}.`
      });
      await input.onToolProgress(record);
      return record;
    }
    record = updateRecord(trace, record.id, { status: "running" });
    await input.onToolProgress(record);
  } else {
    await input.onToolProgress(record);
  }

  try {
    const result = await tool.execute(parsedInput, input.toolContext);
    generatedFiles.push(...(result.generatedFiles || []));
    record = updateRecord(trace, record.id, {
      status: "completed",
      output: result.text
    });
    await input.onToolProgress(record);
    return record;
  } catch (error) {
    record = updateRecord(trace, record.id, {
      status: "failed",
      error: (error as Error).message
    });
    await input.onToolProgress(record);
    return record;
  }
}

function updateRecord(trace: AgentLoopTrace, id: string, patch: Partial<ToolCallRecord>): ToolCallRecord {
  let updated: ToolCallRecord | undefined;
  trace.toolCalls = trace.toolCalls.map((item) => {
    if (item.id !== id) {
      return item;
    }
    updated = {
      ...item,
      ...patch,
      updatedAt: nowIso()
    };
    return updated;
  });
  trace.updatedAt = nowIso();
  return updated!;
}

function parseToolArguments(raw: string): unknown {
  if (!raw.trim()) {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}
