import { describe, expect, test } from "vitest";
import type { AutopilotActionRecord, AutopilotEvent, AutopilotRun, AutopilotTask } from "@supbot/shared";
import { calculateAutopilotMetrics, summarizeAutopilotQuality } from "../src";

const run = (overrides: Partial<AutopilotRun> = {}): AutopilotRun => ({
  id: "run-1",
  projectId: "project-1",
  projectRoot: "/tmp/project",
  title: "Metrics",
  goal: "verify",
  status: "completed",
  writePolicy: { mode: "projectSandbox", allowedWriteRoots: [], allowNetwork: false, allowMcp: false, maxRuntimeMinutes: 5, maxTasks: 10, maxRetries: 2 },
  dataSources: [],
  taskIds: ["task-1"],
  artifactIds: [],
  checkpointIds: [],
  evidence: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:03.000Z",
  startedAt: "2026-01-01T00:00:01.000Z",
  finishedAt: "2026-01-01T00:00:03.000Z",
  budget: { limits: { maxRuntimeMinutes: 5, maxIterations: 10, maxTasks: 10, maxModelTurns: 10, maxToolCalls: 10 }, usage: { iterations: 1, modelTurns: 2, toolCalls: 2 } },
  plan: { version: 1, profile: "coding", summary: "verify", taskIds: ["task-1"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  ...overrides
});

const task = (overrides: Partial<AutopilotTask> = {}): AutopilotTask => ({
  id: "task-1",
  runId: "run-1",
  projectId: "project-1",
  stage: "execute",
  kind: "verify",
  staffAgent: "supbot",
  title: "Verify",
  prompt: "verify",
  status: "completed",
  attempts: 1,
  maxAttempts: 2,
  artifactIds: [],
  evidence: [],
  lastEvaluation: { passed: true, checks: [], violations: [], evidence: [], fingerprint: "ok", evaluatedAt: "2026-01-01T00:00:02.000Z" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:02.000Z",
  ...overrides
});

const action = (id: string, fingerprint: string, status: AutopilotActionRecord["status"]): AutopilotActionRecord => ({
  id,
  runId: "run-1",
  taskId: "task-1",
  fingerprint,
  toolName: "shell",
  status,
  retrySafety: "safe",
  inputSummary: "{}",
  createdAt: "2026-01-01T00:00:01.000Z",
  updatedAt: "2026-01-01T00:00:02.000Z"
});

const event = (message: string): AutopilotEvent => ({ id: message, runId: "run-1", projectId: "project-1", level: "info", message, createdAt: "2026-01-01T00:00:02.000Z" });

describe("calculateAutopilotMetrics", () => {
  test("reports first-pass completion and verification", () => {
    const metrics = calculateAutopilotMetrics(run(), [task()], [action("a1", "read:x", "completed")], [], Date.parse("2026-01-01T00:00:04.000Z"));
    expect(metrics).toMatchObject({ durationMs: 2000, taskCompletionRate: 1, firstPass: true, verificationPassRate: 1, toolFailureRate: 0, repeatedActionRate: 0, planRevisions: 0 });
  });

  test("captures retries, approvals, recovery and no-progress stops", () => {
    const metrics = calculateAutopilotMetrics(
      run({ status: "blocked", plan: { ...run().plan!, version: 3 }, budget: { ...run().budget!, usage: { iterations: 3, modelTurns: 4, toolCalls: 4 } } }),
      [task({ attempts: 2 })],
      [action("a1", "write:x", "failed"), action("a2", "write:x", "completed"), action("a3", "read:x", "completed")],
      [event("approval requested"), event("approval granted"), event("recovery completed"), event("no-progress stop")]
    );
    expect(metrics).toMatchObject({ outcome: "blocked", firstPass: false, planRevisions: 2, toolFailureRate: 0.3333, repeatedActionRate: 0.3333, approvalsRequested: 1, approvalsGranted: 1, recoveryCount: 1, noProgressStops: 1 });
  });

  test("returns zero ratios when there are no tasks or actions", () => {
    const metrics = calculateAutopilotMetrics(run({ taskIds: [] }), [], [], []);
    expect(metrics.taskCompletionRate).toBe(0);
    expect(metrics.verificationPassRate).toBe(0);
    expect(metrics.toolFailureRate).toBe(0);
    expect(metrics.repeatedActionRate).toBe(0);
  });
});

describe("summarizeAutopilotQuality", () => {
  test("compares the latest run with history and aggregates failure categories", () => {
    const baseline = calculateAutopilotMetrics(run({ id: "baseline", finishedAt: "2026-01-01T00:00:03.000Z" }), [task()], [], []);
    const current = calculateAutopilotMetrics(
      run({ id: "current", status: "failed", startedAt: "2026-01-02T00:00:00.000Z", finishedAt: "2026-01-02T00:00:10.000Z", taskIds: ["failed-task"] }),
      [task({ id: "failed-task", runId: "current", status: "failed", attempts: 2, failureCategory: "validation", lastEvaluation: { passed: false, checks: [], violations: ["failed"], evidence: [], fingerprint: "failed", evaluatedAt: "2026-01-02T00:00:09.000Z" } })],
      [action("failed-action", "verify:x", "failed")],
      []
    );
    const summary = summarizeAutopilotQuality([current, baseline], [task({ id: "failed-task", runId: "current", status: "failed", failureCategory: "validation" })]);
    expect(summary).toMatchObject({ runCount: 2, terminalRunCount: 2, completedRunCount: 1, successRate: 0.5, latestRunId: "current", baselineRunId: "baseline", failureCategories: { validation: 1 } });
    expect(summary.regressions.some((item) => item.metric === "taskCompletionRate" && item.source === "baseline")).toBe(true);
    expect(summary.regressions.some((item) => item.metric === "toolFailureRate" && item.source === "threshold")).toBe(true);
  });
});
