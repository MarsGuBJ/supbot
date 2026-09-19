import { describe, expect, test } from "vitest";
import type { AgentLoopTrace, ModelConfig, ToolCallRecord } from "@supbot/shared";
import { artifactCompletionFromTrace, queryLoop, type QueryLoopEvent } from "../src/queryLoop";
import { ToolRegistry } from "../src/toolRegistry";
import type { ModelTurnRequest, ModelTurnResult } from "../src/modelAdapter";

const record = (output: string, toolName = "Shell"): ToolCallRecord => ({
  id: `call_${Math.random().toString(36).slice(2, 8)}`,
  jobId: "job-1",
  conversationId: "conv-1",
  toolName,
  input: {},
  status: "completed",
  createdAt: "2026-09-07T01:47:05.033Z",
  updatedAt: "2026-09-07T01:47:05.255Z",
  output,
});

const trace = (toolCalls: ToolCallRecord[]): AgentLoopTrace => ({
  jobId: "job-1",
  conversationId: "conv-1",
  turns: 30,
  toolCalls,
  startedAt: "2026-09-07T01:43:17.880Z",
  updatedAt: "2026-09-07T01:47:05.255Z",
});

describe("artifactCompletionFromTrace", () => {
  test("does not mistake a cleanup command echo for an artifact summary", () => {
    // Real output captured from a job whose agent loop hit maxTurns: every
    // attempt failed, and the last tool call only removed scratch files.
    const cleanupOutput = [
      'Command: Remove-Item today_almanac.py, today_almanac2.py, today_almanac3.py, today_shichen.py -ErrorAction SilentlyContinue; Remove-Item "$env:TEMP\\wnl.html","$env:TEMP\\lhl.html","$env:TEMP\\chongsha.html","$env:TEMP\\caishen.html" -ErrorAction SilentlyContinue; "cleaned"',
      "Cwd: C:\\Users\\g_qin\\AppData\\Roaming\\HyBot\\data\\worktrees\\job_mtqktqbc-wt_mtqktrse",
      "Timeout: 30s",
      "Exit code: 0",
      "",
      "stdout:",
      "cleaned",
    ].join("\n");
    expect(artifactCompletionFromTrace(trace([record(cleanupOutput)]))).toBeUndefined();
  });

  test("does not summarize a failing command that mentions a result file", () => {
    const failingOutput = [
      "Command: python render.py --out C:\\Users\\test\\report.html",
      "Cwd: C:\\Users\\test",
      "Timeout: 60s",
      "Exit code: 1",
      "",
      "Traceback (most recent call last):",
      '  File "render.py", line 3, in <module>',
      "RuntimeError: could not render C:\\Users\\test\\report.html",
    ].join("\n");
    expect(artifactCompletionFromTrace(trace([record(failingOutput)]))).toBeUndefined();
  });

  test("still surfaces a real generated-file summary", () => {
    const writeOutput = "Wrote report.md (123 bytes)\nC:\\Users\\test\\generated-files\\report.md";
    expect(artifactCompletionFromTrace(trace([record(writeOutput, "WriteFile")]))).toBe(
      "Completed. Wrote report.md (123 bytes)",
    );
  });

  test("uses the Generated files trailer of shell outputs", () => {
    const shellOutput = [
      "Command: python build_report.py",
      "Cwd: C:\\Users\\test\\worktrees\\job-wt",
      "Timeout: 60s",
      "Exit code: 0",
      "",
      "stdout:",
      "report ready",
      "",
      "Generated files:",
      "- C:\\Users\\test\\worktrees\\job-wt\\report.md",
    ].join("\n");
    expect(artifactCompletionFromTrace(trace([record(shellOutput)]))).toBe(
      "Completed. - C:\\Users\\test\\worktrees\\job-wt\\report.md",
    );
  });

  test("ignores scraped page content echoed to stdout", () => {
    const shellOutput = [
      "Command: python scrape.py",
      "Cwd: C:\\Users\\test",
      "Timeout: 60s",
      "Exit code: 0",
      "",
      "stdout:",
      '<h3><a href="/news/295497.html" title="almanac">almanac</a></h3>',
    ].join("\n");
    expect(artifactCompletionFromTrace(trace([record(shellOutput)]))).toBeUndefined();
  });

  test("prefers the newest qualifying output", () => {
    const older = record("Wrote old.md (1 bytes)\nC:\\Users\\test\\old.md", "WriteFile");
    const newer = record("Wrote new.md (2 bytes)\nC:\\Users\\test\\new.md", "WriteFile");
    expect(artifactCompletionFromTrace(trace([older, newer]))).toBe("Completed. Wrote new.md (2 bytes)");
  });

  test("does not treat a ReadFile result as a produced artifact", () => {
    // Regression: a research job hit maxTurns right after reading a config
    // file; ReadFile's "Read <path>" header matched the artifact pattern and
    // became the job's bogus "Completed. Read ..." final answer.
    const readOutput = [
      "Read C:\\Users\\test\\scratch\\job-1\\enterprise-info-mcp\\supbot-package.json",
      "",
      '{ "name": "enterprise-info-mcp", "version": "1.0.0" }',
    ].join("\n");
    expect(artifactCompletionFromTrace(trace([record(readOutput, "ReadFile")]))).toBeUndefined();
  });

  test("does not treat subagent or other read-only outputs as produced artifacts", () => {
    const agentOutput = "Research done. Saved to C:\\Users\\test\\report.md";
    expect(artifactCompletionFromTrace(trace([record(agentOutput, "Agent")]))).toBeUndefined();
  });
});

const wrapUpModelConfig: ModelConfig = {
  providerName: "Mock",
  baseUrl: "http://127.0.0.1:1/v1",
  model: "mock-model",
  temperature: 0,
  maxTokens: 1000,
  apiKeySaved: true,
};

const shellToolCall = {
  id: "call_shell",
  type: "function" as const,
  function: { name: "Shell", arguments: JSON.stringify({ command: "gather data" }) },
};

function wrapUpHarness(model: { complete(input: ModelTurnRequest): Promise<ModelTurnResult> }) {
  const events: QueryLoopEvent[] = [];
  const controller = new AbortController();
  const input = {
    jobId: "job_wrapup",
    conversationId: "conv_wrapup",
    messages: [{ role: "user" as const, content: "research 26 companies and summarize" }],
    model: {
      complete: model.complete,
      stream: async function* (request: ModelTurnRequest) {
        const result = await model.complete(request);
        yield { type: "done" as const, result };
        return result;
      },
    },
    modelRequest: { modelConfig: wrapUpModelConfig, tools: [], signal: controller.signal },
    registry: new ToolRegistry([
      {
        name: "Shell",
        description: "fake shell",
        risk: "read" as const,
        concurrency: "exclusive" as const,
        interruptBehavior: "cancel" as const,
        parameters: {
          type: "object" as const,
          properties: { command: { type: "string" as const } },
          required: ["command"],
          additionalProperties: false,
        },
        summarize: () => "fake shell",
        // No path-like lines: nothing here may qualify as an artifact.
        execute: async () => ({ text: "gathered 15 risk categories for 26 companies" }),
      },
    ]),
    toolContext: {
      signal: controller.signal,
      host: {
        dataDir: ".",
        workspacePath: ".",
        randomId: (prefix: string) => `${prefix}_test`,
        nowIso: () => new Date().toISOString(),
      },
      subagents: [],
      runSubagent: async () => ({ text: "unused" }),
    },
    getPermissionMode: () => "bypassPermissions" as const,
    getPermissionRules: () => [],
    maxTurns: 1,
    requestPermission: async () => "approved" as const,
    onEvent: (event: QueryLoopEvent) => {
      events.push(event);
    },
  };
  return { input, events };
}

describe("queryLoop turn-budget exhaustion", () => {
  test("asks the model for a tool-free final answer when the turn budget is exhausted", async () => {
    // Regression for the scheduled 26-company research job: the loop hit
    // maxTurns right after the data was gathered, and the job "completed"
    // without the model ever writing its summary.
    const { input, events } = wrapUpHarness({
      complete: async (request) => {
        if (request.tools && request.tools.length > 0) {
          return { text: "", toolCalls: [shellToolCall] };
        }
        return { text: "26家企业舆情汇总：万科、三羊马……", toolCalls: [] };
      },
    });
    const result = await queryLoop(input);
    expect(result.text).toBe("26家企业舆情汇总：万科、三羊马……");
    const completion = events.find((event) => event.type === "turn_complete");
    expect(completion && completion.type === "turn_complete" ? completion.text : undefined).toBe(
      "26家企业舆情汇总：万科、三羊马……",
    );
  });

  test("still fails with maxTurns when the model keeps requesting tools after the budget", async () => {
    const { input } = wrapUpHarness({
      complete: async () => ({ text: "", toolCalls: [shellToolCall] }),
    });
    await expect(queryLoop(input)).rejects.toThrow(/maxTurns/);
  });
});
