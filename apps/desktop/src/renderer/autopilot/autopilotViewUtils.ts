import type { AutopilotPendingDecision, AutopilotRun } from "@supbot/shared";

export function autopilotRiskColor(risk: AutopilotPendingDecision["risk"]): string {
  if (risk === "high") return "red";
  if (risk === "medium") return "gold";
  return "green";
}

export function autopilotStatusColor(status: AutopilotRun["status"]): string {
  if (status === "completed") return "green";
  if (["failed", "blocked", "canceled", "budget_exhausted"].includes(status)) return "red";
  if (["paused", "waiting_approval", "partially_completed"].includes(status)) return "gold";
  return "cyan";
}
