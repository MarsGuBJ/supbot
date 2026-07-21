import { nowIso, type AutopilotEvent, type AutopilotRun } from "@supbot/shared";

/** Pure autopilot policy/report helpers kept out of the runtime orchestrator. */
export function formatAutopilotApprovalHistory(events: AutopilotEvent[]): string {
  const approvals = events
    .map((event) => {
      const outcome = autopilotApprovalOutcome(event.message);
      if (!outcome) return undefined;
      const data = recordValue(event.data);
      const decision = recordValue(data?.decision);
      const title = stringValue(decision?.title) || "Approval decision";
      const kind = stringValue(decision?.kind) || "unknown";
      const risk = stringValue(decision?.risk) || "unknown";
      const impact = stringArrayValue(decision?.impact);
      const comment = stringValue(data?.comment);
      return [
        `- ${event.createdAt} \u2014 ${outcome === "approved" ? "Approved" : "Denied"} \u2014 ${markdownInline(title)}`,
        `  - Type: ${markdownInline(kind)}`,
        `  - Risk: ${markdownInline(risk)}`,
        `  - Impact: ${impact.length ? impact.map(markdownInline).join(", ") : "No explicit impact scope."}`,
        `  - Comment: ${comment ? markdownInline(comment) : "No approval comment."}`
      ].join("\n");
    })
    .filter((item): item is string => Boolean(item));
  return approvals.length ? approvals.join("\n") : "- No approval decisions recorded.";
}

export function goalReviewPassed(text: string): boolean {
  const firstMeaningfulLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  if (/^PASS\b/i.test(firstMeaningfulLine)) return true;
  if (/^FAIL\b/i.test(firstMeaningfulLine)) return false;
  return /\bPASS\b/i.test(text) && !/\bFAIL\b/i.test(text);
}

export function extractReviewViolations(output: string): string[] {
  return output.split(/\r?\n/).slice(1).map((line) => line.replace(/^[-*]\s*/, "").trim()).filter(Boolean).slice(0, 12);
}

export function sumOptionalNumber(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left || 0) + (right || 0);
}

export function resetAutopilotBudgetWindow(budget: AutopilotRun["budget"]): AutopilotRun["budget"] {
  if (!budget) return undefined;
  const startedAt = nowIso();
  return {
    ...budget,
    usage: {
      ...budget.usage,
      iterations: 0,
      modelTurns: 0,
      toolCalls: 0,
      startedAt,
      deadlineAt: new Date(new Date(startedAt).getTime() + budget.limits.maxRuntimeMinutes * 60_000).toISOString()
    }
  };
}

function autopilotApprovalOutcome(message: string): "approved" | "denied" | undefined {
  if (message === "Autopilot approval granted" || message === "Autopilot tool approval approved") return "approved";
  if (message === "Autopilot approval denied" || message === "Autopilot tool approval denied") return "denied";
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function markdownInline(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[|`]/g, "\\$&").trim();
}
