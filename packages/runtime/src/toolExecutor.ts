import { isAbsolute, resolve } from "node:path";
import type {
  GeneratedFile,
  PendingToolPermission,
  PermissionMode,
  PermissionRule,
  ToolCallRecord,
} from "@supbot/shared";
import { nowIso } from "@supbot/shared";
import type { AdapterToolCall } from "./modelAdapter";
import { PermissionPolicy } from "./permissionPolicy";
import { pathIsInside, resolveProjectWriteTarget } from "./projectManager";
import { validateJsonSchemaValue } from "./jsonSchema";
import type { ToolDefinition, ToolExecutionContext, ToolRegistry } from "./toolRegistry";

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
      input: parsedInput.value,
      status: "running",
      createdAt: now,
      updatedAt: now,
    };
    const emit = async (patch: Partial<ToolCallRecord>) => {
      record = { ...record, ...patch, updatedAt: nowIso() };
      await input.onProgress(record);
    };

    if (!tool) {
      await emit({ status: "failed", error: `Unknown tool: ${requestedToolName}` });
      return { record, toolResultText: `Error: ${record.error}`, generatedFiles };
    }
    if (parsedInput.error) {
      const message = invalidToolArgumentsMessage(tool.name, parsedInput.error);
      await emit({ status: "failed", error: message });
      return { record, toolResultText: `Error: ${message}`, generatedFiles };
    }
    if (tool.validationError) {
      await emit({ status: "failed", error: tool.validationError });
      return { record, toolResultText: `Error: ${tool.validationError}`, generatedFiles };
    }
    const validationError = validateToolInput(parsedInput.value, tool.parameters);
    if (validationError) {
      await emit({ status: "failed", error: validationError });
      return { record, toolResultText: `Error: ${validationError}`, generatedFiles };
    }
    if (input.context.workspaceMode === "readOnly" && tool.risk === "dangerous") {
      const message = `Remote read-only workspace mode blocked ${tool.name}.`;
      await emit({ status: "denied", error: message });
      return { record, toolResultText: `Error: ${message}`, generatedFiles };
    }
    const projectBoundaryError = validateProjectBoundary(tool, parsedInput.value, input.context);
    if (projectBoundaryError) {
      await emit({ status: "denied", error: projectBoundaryError });
      return { record, toolResultText: `Error: ${projectBoundaryError}`, generatedFiles };
    }
    let executionContext = input.context;
    if (tool.risk === "dangerous" && (tool.usesWorkspace ?? true) && !input.context.projectRoot) {
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
      input: parsedInput.value,
      nowIso,
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
      const result = await withPermissionTimeout(
        input.requestPermission(decision.permission),
        input.permissionTimeoutMs ?? 30_000,
      );
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
      const result = await tool.execute(parsedInput.value, executionContext);
      generatedFiles.push(...(result.generatedFiles || []));
      await emit({
        status: "completed",
        output: result.text,
        outputParts: result.outputParts,
        outputTruncated: result.outputTruncated,
      });
      return { record, toolResultText: result.text, generatedFiles };
    } catch (error) {
      const message = (error as Error).message;
      await emit({ status: "failed", error: message });
      return { record, toolResultText: `Error: ${message}`, generatedFiles };
    }
  }
}

interface ParsedToolArguments {
  value: unknown;
  error?: string;
}

function parseToolArguments(raw: string): ParsedToolArguments {
  if (!raw.trim()) {
    return { value: {} };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch (error) {
    return {
      value: { raw: truncateRawToolArguments(raw) },
      error: (error as Error).message,
    };
  }
}

function invalidToolArgumentsMessage(toolName: string, parseError: string): string {
  const example =
    toolName === "WriteFile"
      ? ' Expected shape: {"path":"relative-file-name","content":"complete UTF-8 text"}.'
      : toolName === "Shell"
        ? ' Expected shape: {"command":"PowerShell or shell command","timeoutMs":120000}. timeoutMs is optional.'
        : "";
  return `Tool arguments for ${toolName} must be valid JSON. Send exactly one complete JSON object matching the tool schema; do not send raw text, markdown, placeholders, or partial JSON.${example} JSON parse error: ${parseError}`;
}

function truncateRawToolArguments(raw: string): string {
  const maxLength = 8_000;
  return raw.length <= maxLength ? raw : `${raw.slice(0, maxLength)}\n\n[truncated ${raw.length - maxLength} chars]`;
}

function validateToolInput(
  input: unknown,
  schema: { type: string; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean },
): string | undefined {
  const result = validateJsonSchemaValue(input, schema, "Tool input");
  return result.ok ? undefined : result.errors.join(" ");
}

function validateProjectBoundary(
  tool: ToolDefinition,
  input: unknown,
  context: ToolExecutionContext,
): string | undefined {
  const projectRoot = context.projectRoot || context.host.projectRoot;
  const allowedWriteRoots = context.allowedWriteRoots || context.host.allowedWriteRoots || [];
  if (!projectRoot) {
    return undefined;
  }
  try {
    if (tool.name === "ReadFile") {
      const parsed = objectInput(input);
      const target = typeof parsed.path === "string" ? parsed.path : "";
      if (!target) {
        return "Project ReadFile target path is required.";
      }
      const resolvedTarget = isAbsolute(target) ? resolve(target) : resolve(projectRoot, target);
      if (!pathIsInside(projectRoot, resolvedTarget)) {
        return `Project ReadFile target must stay inside ${projectRoot}.`;
      }
      return undefined;
    }
    if (!allowedWriteRoots.length || tool.risk !== "dangerous") {
      return undefined;
    }
    if (tool.name === "WriteFile") {
      const parsed = objectInput(input);
      const target = typeof parsed.path === "string" ? parsed.path : "";
      if (!target) {
        return "Project WriteFile target path is required.";
      }
      resolveProjectWriteTarget(projectRoot, target, allowedWriteRoots);
      return undefined;
    }
    if (tool.name === "Shell") {
      const command = String(objectInput(input).command || "");
      return validateProjectShellCommand(command, projectRoot, allowedWriteRoots);
    }
    if (tool.name.startsWith("mcp.")) {
      return validateMcpProjectPaths(input, projectRoot, allowedWriteRoots);
    }
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
}

// Defense-in-depth heuristics only: these string checks can be bypassed
// (environment variables, subshells, aliases) and are NOT a security boundary.
// The real boundary is the permission prompt/policy above; shell commands
// always execute with the full privileges of the desktop user.
function validateProjectShellCommand(
  command: string,
  projectRoot: string,
  allowedWriteRoots: string[],
): string | undefined {
  if (!command.trim()) {
    return undefined;
  }
  if (/(^|[\\/\s])\.\.([\\/\s]|$)/.test(command)) {
    return "Project shell commands cannot reference parent-directory paths.";
  }
  const absolutePath = command
    .match(/[A-Za-z]:[\\/][^\s"'`]+|\/[^\s"'`]+/g)
    ?.find((path) => !pathIsInside(projectRoot, path));
  if (absolutePath) {
    return `Project shell command path must stay inside ${projectRoot}: ${absolutePath}`;
  }
  const writes =
    />|Out-File|Set-Content|Add-Content|New-Item|Copy-Item|Move-Item|Remove-Item|\brm\b|\bdel\b|Invoke-WebRequest[\s\S]*-OutFile|curl[\s\S]*\s-o\s/i.test(
      command,
    );
  if (!writes) {
    return undefined;
  }
  if (allowedWriteRoots.some((root) => pathIsInside(projectRoot, root) && pathIsInside(root, projectRoot))) {
    return undefined;
  }
  const normalized = command.replace(/\\/g, "/").toLowerCase();
  const mentionsAllowedRoot = allowedWriteRoots.some((root) => {
    const relativeRoot = projectRelative(projectRoot, root).replace(/\\/g, "/").toLowerCase();
    return relativeRoot && normalized.includes(relativeRoot);
  });
  return mentionsAllowedRoot ? undefined : "Project shell writes must target an approved project output folder.";
}

function validateMcpProjectPaths(input: unknown, projectRoot: string, allowedWriteRoots: string[]): string | undefined {
  for (const item of collectPathLikeValues(input)) {
    if (!isPathLike(item.value)) {
      continue;
    }
    const key = item.key.toLowerCase();
    const writeLike = /output|dest|target|write|save|path/.test(key);
    if (!writeLike) {
      continue;
    }
    try {
      resolveProjectWriteTarget(projectRoot, item.value, allowedWriteRoots);
    } catch (error) {
      return `MCP project path rejected for ${item.key}: ${(error as Error).message}`;
    }
  }
  return undefined;
}

function collectPathLikeValues(input: unknown, key = "input"): Array<{ key: string; value: string }> {
  if (typeof input === "string") {
    return [{ key, value: input }];
  }
  if (Array.isArray(input)) {
    return input.flatMap((item, index) => collectPathLikeValues(item, `${key}[${index}]`));
  }
  if (!input || typeof input !== "object") {
    return [];
  }
  return Object.entries(input as Record<string, unknown>).flatMap(([entryKey, value]) =>
    collectPathLikeValues(value, entryKey),
  );
}

function isPathLike(value: string): boolean {
  return /[\\/]/.test(value) || /^[A-Za-z]:/.test(value);
}

function objectInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function projectRelative(projectRoot: string, path: string): string {
  return pathIsInside(projectRoot, path) ? path.slice(projectRoot.length).replace(/^[\\/]+/, "") : path;
}

function withPermissionTimeout(
  promise: Promise<"approved" | "denied">,
  timeoutMs: number,
): Promise<"approved" | "denied" | "timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve("denied");
      },
    );
  });
}
