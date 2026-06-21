import type { GeneratedFile, PendingToolPermission, PermissionMode, PermissionRule, ToolCallRecord } from "@supbot/shared";
import { nowIso } from "@supbot/shared";
import type { AdapterToolCall } from "./modelAdapter";
import { PermissionPolicy } from "./permissionPolicy";
import { validateJsonSchemaValue } from "./jsonSchema";
import type { ToolExecutionContext, ToolRegistry } from "./toolRegistry";

export interface ToolExecutorInput {
  jobId: string;
  conversationId: string;
  toolCall: AdapterToolCall;
  registry: ToolRegistry;
  context: ToolExecutionContext;
  permissionMode: PermissionMode;
  permissionRules: PermissionRule[];
  permissionTimeoutMs?: number;
  requestPermission(permission: PendingToolPermission): Promise<"approved" | "denied">;
  onPermissionTimeout?(permission: PendingToolPermission): Promise<void> | void;
  onProgress(record: ToolCallRecord): Promise<void> | void;
}

export interface ToolExecutionEnvelope {
  record: ToolCallRecord;
  toolResultText: string;
  generatedFiles: GeneratedFile[];
}

export class ToolExecutor {
  private readonly policy = new PermissionPolicy();

  async execute(input: ToolExecutorInput): Promise<ToolExecutionEnvelope> {
    const requestedToolName = input.toolCall.function.name;
    const tool = input.registry.get(requestedToolName);
    const toolName = tool?.name || requestedToolName;
    const parsedInput = parseToolArguments(input.toolCall.function.arguments);
    const now = nowIso();
    const generatedFiles: GeneratedFile[] = [];
    let record: ToolCallRecord = {
      id: input.toolCall.id,
      jobId: input.jobId,
      conversationId: input.conversationId,
      toolName,
      input: parsedInput,
      status: "running",
      createdAt: now,
      updatedAt: now
    };
    const emit = async (patch: Partial<ToolCallRecord>) => {
      record = { ...record, ...patch, updatedAt: nowIso() };
      await input.onProgress(record);
    };

    if (!tool) {
      await emit({ status: "failed", error: `Unknown tool: ${requestedToolName}` });
      return { record, toolResultText: `Error: ${record.error}`, generatedFiles };
    }
    if (tool.validationError) {
      await emit({ status: "failed", error: tool.validationError });
      return { record, toolResultText: `Error: ${tool.validationError}`, generatedFiles };
    }
    const validationError = validateToolInput(parsedInput, tool.parameters);
    if (validationError) {
      await emit({ status: "failed", error: validationError });
      return { record, toolResultText: `Error: ${validationError}`, generatedFiles };
    }
    if (input.context.workspaceMode === "readOnly" && tool.risk === "dangerous") {
      const message = `Remote read-only workspace mode blocked ${tool.name}.`;
      await emit({ status: "denied", error: message });
      return { record, toolResultText: `Error: ${message}`, generatedFiles };
    }
    let executionContext = input.context;
    if (tool.risk === "dangerous") {
      try {
        const isolatedHost = await input.context.ensureIsolatedWorkspace?.(tool.name);
        if (isolatedHost) {
          executionContext = { ...input.context, host: isolatedHost, workspaceMode: "isolated" };
        }
      } catch (error) {
        const message = (error as Error).message;
        await emit({ status: "failed", error: message });
        return { record, toolResultText: `Error: ${message}`, generatedFiles };
      }
    }

    const decision = this.policy.decide({
      mode: input.permissionMode,
      rules: input.permissionRules,
      jobId: input.jobId,
      conversationId: input.conversationId,
      toolCallId: record.id,
      tool,
      input: parsedInput,
      nowIso
    });
    if (decision.behavior === "deny") {
      await emit({ status: "denied", error: decision.message });
      return { record, toolResultText: `Error: ${decision.message}`, generatedFiles };
    }
    if (decision.behavior === "ask") {
      if (decision.permission) {
        decision.permission.executionPath = executionContext.host.cwd || executionContext.host.workspacePath;
      }
      await emit({ status: "pending_permission" });
      const result = await withPermissionTimeout(input.requestPermission(decision.permission), input.permissionTimeoutMs ?? 30_000);
      if (result === "timeout") {
        await input.onPermissionTimeout?.(decision.permission);
        const message = `Permission timed out for ${tool.name}.`;
        await emit({ status: "denied", error: message });
        return { record, toolResultText: `Error: ${message}`, generatedFiles };
      }
      if (result === "denied") {
        const message = `User denied ${tool.name}.`;
        await emit({ status: "denied", error: message });
        return { record, toolResultText: `Error: ${message}`, generatedFiles };
      }
      await emit({ status: "running" });
    } else {
      await input.onProgress(record);
    }

    try {
      const result = await tool.execute(parsedInput, executionContext);
      generatedFiles.push(...(result.generatedFiles || []));
      await emit({
        status: "completed",
        output: result.text,
        outputParts: result.outputParts,
        outputTruncated: result.outputTruncated
      });
      return { record, toolResultText: result.text, generatedFiles };
    } catch (error) {
      const message = (error as Error).message;
      await emit({ status: "failed", error: message });
      return { record, toolResultText: `Error: ${message}`, generatedFiles };
    }
  }
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

function validateToolInput(input: unknown, schema: { type: string; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }): string | undefined {
  const result = validateJsonSchemaValue(input, schema, "Tool input");
  return result.ok ? undefined : result.errors.join(" ");
}

function withPermissionTimeout(promise: Promise<"approved" | "denied">, timeoutMs: number): Promise<"approved" | "denied" | "timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, () => {
      clearTimeout(timer);
      resolve("denied");
    });
  });
}
