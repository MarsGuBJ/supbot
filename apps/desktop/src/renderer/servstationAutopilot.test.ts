import { describe, expect, test } from "vitest";
import type { ServstationAutopilotRun, ServstationAutopilotStep } from "@supbot/shared";
import {
  mergeServstationAutopilotEvent,
  servstationAutopilotControls,
  servstationAutopilotDecisionReason,
  servstationAutopilotEvidenceCount,
  servstationAutopilotIsActive,
  servstationAutopilotLatestStep
} from "./servstationAutopilot";

function run(status: string, overrides: Partial<ServstationAutopilotRun> = {}): ServstationAutopilotRun {
  return {
    id: "run-1",
    agentInstanceId: "agent-1",
    conversationId: "conversation-1",
    goal: "Complete the remote task",
    status,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:01.000Z",
    ...overrides
  };
}

function step(sequence: number, overrides: Partial<ServstationAutopilotStep> = {}): ServstationAutopilotStep {
  return {
    id: `step-${sequence}`,
    runId: "run-1",
    sequence,
    kind: "continuation",
    status: "completed",
    agentInstanceId: "agent-1",
    attempt: 1,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:01.000Z",
    ...overrides
  };
}

describe("Servstation Autopilot panel state", () => {
  test("allows a prompt while waiting for the first run", () => {
    expect(servstationAutopilotControls(null)).toEqual({
      terminal: false,
      promptLocked: false,
      canPause: false,
      canResume: false,
      canStop: false
    });
  });

  test("locks prompts and exposes pause/stop while a run is active", () => {
    expect(servstationAutopilotControls(run("driving"))).toMatchObject({
      terminal: false,
      promptLocked: true,
      canPause: true,
      canResume: false,
      canStop: true
    });
    expect(servstationAutopilotIsActive(run("watching", { lifecycleStatus: "active" }))).toBe(true);
  });

  test("allows user input and resume when the run needs the user", () => {
    expect(servstationAutopilotControls(run("needs_user"))).toMatchObject({
      promptLocked: false,
      canPause: false,
      canResume: true,
      canStop: true
    });
  });

  test.each(["completed", "failed", "stopped"])("unlocks a new prompt for terminal status %s", (status) => {
    expect(servstationAutopilotControls(run(status))).toMatchObject({
      terminal: true,
      promptLocked: false,
      canPause: false,
      canResume: false,
      canStop: false
    });
    expect(servstationAutopilotIsActive(run(status))).toBe(false);
  });

  test("derives latest step, evidence progress, and decision detail", () => {
    const latest = step(3, { decision: { action: "continue", reason: "More evidence is required", nextPrompt: "Check again" } });
    expect(servstationAutopilotLatestStep([latest, step(1), step(2)])?.id).toBe("step-3");
    expect(servstationAutopilotDecisionReason(latest)).toBe("More evidence is required");
    expect(servstationAutopilotEvidenceCount(run("watching", {
      latestEvidence: [
        { id: "one", type: "job", status: "met", label: "Job complete", source: "job" },
        { id: "two", type: "output", status: "unmet", label: "Output verified", source: "runtime" }
      ]
    }))).toEqual({ met: 1, total: 2 });
  });

  test("deduplicates streamed events and keeps the newest event first", () => {
    const first = { id: "event-1", runId: "run-1", agentInstanceId: "agent-1", eventType: "step", level: "info", message: "first", createdAt: "2026-07-14T00:00:00.000Z" };
    const updated = { ...first, message: "updated" };
    expect(mergeServstationAutopilotEvent([first], updated)).toEqual([updated]);
  });
});
