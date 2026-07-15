import type {
  ServstationAutopilotEvent,
  ServstationAutopilotRun,
  ServstationAutopilotStep
} from "@supbot/shared";

const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped"]);
const RESUMABLE_STATUSES = new Set(["paused", "needs_user"]);

export interface ServstationAutopilotControls {
  terminal: boolean;
  promptLocked: boolean;
  canPause: boolean;
  canResume: boolean;
  canStop: boolean;
}

export function servstationAutopilotControls(run: ServstationAutopilotRun | null): ServstationAutopilotControls {
  if (!run) {
    return { terminal: false, promptLocked: false, canPause: false, canResume: false, canStop: false };
  }
  const terminal = TERMINAL_STATUSES.has(run.status) || TERMINAL_STATUSES.has(run.lifecycleStatus || "");
  const canResume = !terminal && RESUMABLE_STATUSES.has(run.status);
  const canControl = !terminal && run.status !== "idle";
  return {
    terminal,
    promptLocked: !terminal && run.status !== "needs_user",
    canPause: canControl && !canResume,
    canResume,
    canStop: canControl
  };
}

export function servstationAutopilotIsActive(run: ServstationAutopilotRun | null | undefined): boolean {
  return Boolean(run && !TERMINAL_STATUSES.has(run.status) && !TERMINAL_STATUSES.has(run.lifecycleStatus || ""));
}

export function servstationAutopilotLatestStep(steps: ServstationAutopilotStep[]): ServstationAutopilotStep | undefined {
  let latest: ServstationAutopilotStep | undefined;
  for (const step of steps) {
    if (!latest || step.sequence > latest.sequence) {
      latest = step;
    }
  }
  return latest;
}

export function servstationAutopilotEvidenceCount(run: ServstationAutopilotRun | null): { met: number; total: number } {
  const evidence = run?.latestEvidence || [];
  return {
    met: evidence.reduce((count, item) => count + (item.status === "met" ? 1 : 0), 0),
    total: evidence.length
  };
}

export function servstationAutopilotDecisionReason(step: ServstationAutopilotStep): string | undefined {
  const decision = step.decision;
  return decision && "reason" in decision && typeof decision.reason === "string" ? decision.reason : undefined;
}

export function mergeServstationAutopilotEvent(
  events: ServstationAutopilotEvent[],
  event: ServstationAutopilotEvent,
  limit = 50
): ServstationAutopilotEvent[] {
  return [event, ...events.filter((item) => item.id !== event.id)].slice(0, limit);
}
