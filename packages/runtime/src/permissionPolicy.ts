import type { PendingToolPermission, PermissionMode, PermissionRule } from "@supbot/shared";
import type { ToolDefinition } from "./toolRegistry";

export type PermissionDecision =
  | { behavior: "allow" }
  | { behavior: "deny"; message: string }
  | { behavior: "ask"; permission: PendingToolPermission };

export interface PermissionPolicyInput {
  mode: PermissionMode;
  rules: PermissionRule[];
  jobId: string;
  conversationId: string;
  toolCallId: string;
  tool: ToolDefinition;
  input: unknown;
  nowIso(): string;
}

export class PermissionPolicy {
  decide(input: PermissionPolicyInput): PermissionDecision {
    const rule = input.rules.find((item) => ruleMatchesTool(item.toolName, input.tool.name));
    if (rule?.behavior === "deny") {
      return { behavior: "deny", message: `Permission rule denied ${input.tool.name}.` };
    }
    if (rule?.behavior === "allow") {
      return { behavior: "allow" };
    }
    if (rule?.behavior === "ask") {
      return { behavior: "ask", permission: createPermission(input) };
    }
    if (input.tool.risk === "read") {
      return { behavior: "allow" };
    }
    if (input.mode === "bypassPermissions") {
      return { behavior: "allow" };
    }
    if (input.mode === "acceptEdits" && input.tool.name === "WriteFile") {
      return { behavior: "allow" };
    }
    if (input.mode === "plan") {
      return { behavior: "deny", message: `Permission denied in plan mode for ${input.tool.name}.` };
    }
    return {
      behavior: "ask",
      permission: createPermission(input)
    };
  }
}

function ruleMatchesTool(ruleToolName: string, toolName: string): boolean {
  if (ruleToolName === "*") {
    return true;
  }
  if (ruleToolName.endsWith(".*")) {
    return toolName.startsWith(ruleToolName.slice(0, -1));
  }
  return ruleToolName === toolName;
}

function createPermission(input: PermissionPolicyInput): PendingToolPermission {
  return {
    id: `perm_${input.toolCallId}`,
    jobId: input.jobId,
    conversationId: input.conversationId,
    toolCallId: input.toolCallId,
    toolName: input.tool.name,
    input: input.input,
    summary: input.tool.summarize(input.input),
    createdAt: input.nowIso()
  };
}
