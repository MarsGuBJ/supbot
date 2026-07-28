import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolCallRecord } from "@supbot/shared";
import { ToolExecutor } from "../src/toolExecutor";
import { ToolRegistry, type ToolDefinition, type ToolExecutionContext } from "../src/toolRegistry";

const tempDirs: string[] = [];

function definition(name: string, risk: "read" | "dangerous"): ToolDefinition {
  return {
    name,
    description: name,
    risk,
    concurrency: "safe",
    interruptBehavior: "cancel",
    parameters: {
      type: "object",
      properties: name.startsWith("mcp.")
        ? { path: { type: "string" } }
        : name === "Shell"
          ? { command: { type: "string" } }
          : { path: { type: "string" }, content: { type: "string" } },
      required: [name === "Shell" ? "command" : "path"],
    },
    summarize: () => name,
    execute: async () => ({ text: "executed" }),
  };
}

async function setup(): Promise<{ root: string; output: string; context: ToolExecutionContext }> {
  const root = await mkdtemp(join(tmpdir(), "tool-boundary-"));
  const output = join(root, "outputs");
  tempDirs.push(root);
  const controller = new AbortController();
  const context: ToolExecutionContext = {
    signal: controller.signal,
    workspaceMode: "main",
    projectRoot: root,
    allowedWriteRoots: [output],
    host: {
      dataDir: root,
      workspacePath: root,
      cwd: root,
      projectRoot: root,
      allowedWriteRoots: [output],
      randomId: (prefix) => `${prefix}-test`,
      nowIso: () => "2026-07-22T00:00:00.000Z",
    },
    subagents: [],
    runSubagent: async () => ({ text: "unused" }),
  };
  return { root, output, context };
}

async function execute(
  tool: ToolDefinition,
  context: ToolExecutionContext,
  value: Record<string, unknown>,
  options: Partial<Parameters<ToolExecutor["execute"]>[0]> = {},
) {
  const records: ToolCallRecord[] = [];
  const executor = new ToolExecutor();
  const result = await executor.execute({
    jobId: "job-1",
    conversationId: "conversation-1",
    toolCall: { id: "call-1", type: "function", function: { name: tool.name, arguments: JSON.stringify(value) } },
    registry: new ToolRegistry([tool]),
    context,
    permissionMode: "bypassPermissions",
    permissionRules: [],
    requestPermission: async () => "approved",
    onProgress: async (record) => records.push(record),
    ...options,
  });
  return { result, records };
}

describe("ToolExecutor project boundaries", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  test.each([
    ["ReadFile", "read", { path: "../outside.txt" }],
    ["ReadFile", "read", { path: "C:/outside.txt" }],
    ["WriteFile", "dangerous", { path: "../outside.txt", content: "bad" }],
    ["WriteFile", "dangerous", { path: "README.md", content: "bad" }],
  ] as const)("rejects project boundary violation for %s", async (name, risk, value) => {
    const { context } = await setup();
    const { result } = await execute(definition(name, risk), context, value);
    expect(result.record.status).toBe("denied");
    expect(result.toolResultText).toMatch(/must stay inside|approved project output/);
  });

  test.each([["echo ../escape"], ["Get-Content C:/outside.txt"], ["echo data > README.md"]])(
    "rejects unsafe shell heuristic: %s",
    async (command) => {
      const { context } = await setup();
      const { result } = await execute(definition("Shell", "dangerous"), context, { command });
      expect(result.record.status).toBe("denied");
    },
  );

  test("scans MCP path-like arguments against approved write roots", async () => {
    const { context } = await setup();
    const { result } = await execute(definition("mcp.files.write", "dangerous"), context, { path: "../escape.txt" });
    expect(result.record.status).toBe("denied");
    expect(result.toolResultText).toContain("MCP project path rejected");
  });

  test("auto-allows project file and shell tools without a permission prompt", async () => {
    const { context } = await setup();
    let requested = false;
    const { result, records } = await execute(
      definition("WriteFile", "dangerous"),
      context,
      {
        path: "outputs/file.txt",
        content: "project content",
      },
      {
        permissionMode: "default",
        requestPermission: async () => {
          requested = true;
          return "denied";
        },
      },
    );
    expect(result.record.status).toBe("completed");
    expect(records.some((record) => record.status === "pending_permission")).toBe(false);
    expect(requested).toBe(false);

    const shell = await execute(
      definition("Shell", "dangerous"),
      context,
      { command: "Write-Output project" },
      {
        permissionMode: "default",
        requestPermission: async () => {
          requested = true;
          return "denied";
        },
      },
    );
    expect(shell.result.record.status).toBe("completed");
    expect(requested).toBe(false);

    const mcp = await execute(
      definition("mcp.files.write", "dangerous"),
      context,
      { path: "outputs/file.txt" },
      {
        permissionMode: "default",
        requestPermission: async () => {
          requested = true;
          return "denied";
        },
      },
    );
    expect(mcp.result.record.status).toBe("completed");
    expect(requested).toBe(false);
  });

  test("project auto-approval does not override plan mode", async () => {
    const { context } = await setup();
    const { result } = await execute(
      definition("WriteFile", "dangerous"),
      context,
      { path: "outputs/file.txt", content: "blocked" },
      { permissionMode: "plan" },
    );
    expect(result.record.status).toBe("denied");
    expect(result.record.error).toContain("plan mode");
  });

  test("keeps external MCP operations on the normal permission path", async () => {
    const { context } = await setup();
    const externalMcp = {
      ...definition("mcp.mail.send", "dangerous"),
      parameters: {
        type: "object",
        properties: { recipient: { type: "string" } },
        required: ["recipient"],
      },
    } satisfies ToolDefinition;
    const { result, records } = await execute(
      externalMcp,
      context,
      { recipient: "user@example.com" },
      {
        permissionMode: "default",
        requestPermission: async () => "denied",
      },
    );
    expect(records.some((record) => record.status === "pending_permission")).toBe(true);
    expect(result.record.status).toBe("denied");
  });

  test("explicit project permission rules still take precedence", async () => {
    const { context } = await setup();
    const { records } = await execute(
      definition("WriteFile", "dangerous"),
      context,
      {
        path: "outputs/file.txt",
        content: "project content",
      },
      {
        permissionMode: "default",
        permissionRules: [
          {
            id: "ask-project-writes",
            toolName: "WriteFile",
            behavior: "ask",
            scope: "session",
            createdAt: "2026-07-22T00:00:00.000Z",
          },
        ],
      },
    );
    expect(records.some((record) => record.status === "pending_permission")).toBe(true);
  });

  test("read-only workspace blocks dangerous tools before execution", async () => {
    const { context } = await setup();
    const readOnly = { ...context, workspaceMode: "readOnly" as const };
    const { result } = await execute(definition("WriteFile", "dangerous"), readOnly, {
      path: "outputs/file.txt",
      content: "blocked",
    });
    expect(result.record.status).toBe("denied");
    expect(result.toolResultText).toContain("read-only");
  });

  test("permission timeout records a denial and invokes the timeout hook", async () => {
    const { context } = await setup();
    const nonProjectContext = {
      ...context,
      projectRoot: undefined,
      allowedWriteRoots: [],
      host: { ...context.host, projectRoot: undefined, allowedWriteRoots: [] },
    };
    let timeoutPermission = false;
    const { result } = await execute(
      definition("WriteFile", "dangerous"),
      nonProjectContext,
      { path: "file.txt", content: "blocked" },
      {
        permissionMode: "default",
        permissionTimeoutMs: 5,
        requestPermission: () => new Promise<"approved" | "denied">(() => undefined),
        onPermissionTimeout: () => {
          timeoutPermission = true;
        },
      },
    );
    expect(timeoutPermission).toBe(true);
    expect(result.record.status).toBe("denied");
    expect(result.record.error).toContain("Permission timed out");
  });
});
