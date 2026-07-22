import { describe, expect, test } from "vitest";
import type { PermissionMode, PermissionRule } from "@supbot/shared";
import { PermissionPolicy, type PermissionPolicyInput } from "../src/permissionPolicy";
import type { ToolDefinition } from "../src/toolRegistry";

const now = "2026-07-22T00:00:00.000Z";

function tool(name: string, risk: "read" | "dangerous"): ToolDefinition {
  return {
    name,
    description: name,
    risk,
    concurrency: "safe",
    interruptBehavior: "cancel",
    parameters: { type: "object", properties: {} },
    summarize: () => `summary:${name}`,
    execute: async () => ({ text: "unused" }),
  };
}

function input(
  mode: PermissionMode,
  selectedTool: ToolDefinition,
  rules: PermissionRule[] = [],
): PermissionPolicyInput {
  return {
    mode,
    rules,
    jobId: "job-1",
    conversationId: "conversation-1",
    toolCallId: "call-1",
    tool: selectedTool,
    input: { path: "file.txt" },
    nowIso: () => now,
  };
}

function rule(toolName: string, behavior: PermissionRule["behavior"]): PermissionRule {
  return { id: `${toolName}-${behavior}`, toolName, behavior, scope: "session", createdAt: now };
}

describe("PermissionPolicy", () => {
  const policy = new PermissionPolicy();

  test.each([
    ["default", "read", "allow"],
    ["default", "dangerous", "ask"],
    ["acceptEdits", "read", "allow"],
    ["acceptEdits", "dangerous", "ask"],
    ["plan", "read", "allow"],
    ["plan", "dangerous", "deny"],
    ["bypassPermissions", "read", "allow"],
    ["bypassPermissions", "dangerous", "allow"],
  ] as const)("applies the mode/risk matrix: %s/%s", (mode, risk, expected) => {
    const result = policy.decide(input(mode, tool(risk === "read" ? "ReadFile" : "Shell", risk)));
    expect(result.behavior).toBe(expected);
  });

  test.each([
    ["ReadFile", "allow"],
    ["ReadFile", "deny"],
    ["ReadFile", "ask"],
    ["Shell", "allow"],
    ["Shell", "deny"],
    ["Shell", "ask"],
  ] as const)("exact rules override defaults for %s/%s", (toolName, behavior) => {
    const result = policy.decide(
      input("plan", tool(toolName, toolName === "ReadFile" ? "read" : "dangerous"), [rule(toolName, behavior)]),
    );
    expect(result.behavior).toBe(behavior);
    if (behavior === "ask") {
      expect(result).toMatchObject({ permission: { id: "perm_call-1", toolName, createdAt: now } });
    }
  });

  test("matches mcp.* rules without matching a sibling server", () => {
    const matching = policy.decide(
      input("default", tool("mcp.files.write", "dangerous"), [rule("mcp.files.*", "allow")]),
    );
    const sibling = policy.decide(input("default", tool("mcp.mail.send", "dangerous"), [rule("mcp.files.*", "allow")]));
    expect(matching.behavior).toBe("allow");
    expect(sibling.behavior).toBe("ask");
  });

  test("the global wildcard applies to every risk and mode", () => {
    for (const mode of ["default", "acceptEdits", "plan", "bypassPermissions"] as const) {
      for (const risk of ["read", "dangerous"] as const) {
        expect(policy.decide(input(mode, tool(`tool-${risk}`, risk), [rule("*", "deny")])).behavior).toBe("deny");
      }
    }
  });
});
