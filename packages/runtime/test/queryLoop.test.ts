import { describe, expect, test } from "vitest";
import type { AgentLoopTrace, ToolCallRecord } from "@supbot/shared";
import { artifactCompletionFromTrace } from "../src/queryLoop";

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
});
