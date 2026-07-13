import { createHash } from "node:crypto";
import type {
  AutopilotBudget,
  AutopilotBudgetLimits,
  AutopilotFailureCategory,
  AutopilotGoalSpec,
  AutopilotPlan,
  AutopilotProfile,
  AutopilotRun,
  AutopilotRunStatus,
  AutopilotTask
} from "@supbot/shared";

export const defaultAutopilotBudgetLimits: AutopilotBudgetLimits = {
  maxRuntimeMinutes: 120,
  maxIterations: 12,
  maxTasks: 24,
  maxModelTurns: 160,
  maxToolCalls: 240
};

const terminalStatuses = new Set<AutopilotRunStatus>([
  "completed",
  "partially_completed",
  "blocked",
  "budget_exhausted",
  "failed",
  "canceled"
]);

const transitions: Record<AutopilotRunStatus, AutopilotRunStatus[]> = {
  queued: ["analyzing", "paused", "canceled", "failed"],
  analyzing: ["planning", "waiting_approval", "paused", "blocked", "failed", "canceled"],
  planning: ["waiting_approval", "running", "paused", "blocked", "failed", "canceled"],
  waiting_approval: ["queued", "planning", "running", "replanning", "paused", "blocked", "canceled"],
  running: ["reviewing", "verifying", "replanning", "waiting_approval", "paused", "blocked", "budget_exhausted", "failed", "canceled"],
  verifying: ["reviewing", "completed", "partially_completed", "replanning", "waiting_approval", "paused", "blocked", "budget_exhausted", "failed", "canceled"],
  replanning: ["running", "reviewing", "waiting_approval", "paused", "blocked", "budget_exhausted", "failed", "canceled"],
  paused: ["queued", "running", "replanning", "canceled"],
  blocked: ["queued", "replanning", "canceled"],
  reviewing: ["running", "verifying", "completed", "replanning", "waiting_approval", "paused", "blocked", "failed", "canceled"],
  completed: [],
  partially_completed: ["queued"],
  budget_exhausted: ["queued"],
  failed: ["queued"],
  canceled: []
};

export function canTransitionAutopilot(from: AutopilotRunStatus, to: AutopilotRunStatus): boolean {
  return from === to || transitions[from].includes(to);
}

export function isTerminalAutopilotStatus(status: AutopilotRunStatus): boolean {
  return terminalStatuses.has(status);
}

export function resolveAutopilotProfile(profile: AutopilotProfile | undefined, goal: string): Exclude<AutopilotProfile, "auto"> {
  if (profile && profile !== "auto") {
    return profile;
  }
  const normalized = goal.toLowerCase();
  if (/\b(code|bug|fix|test|tests|build|compile|typescript|javascript|refactor|implement|feature)\b|代码|编译|测试|重构|修复/.test(normalized)) {
    return "coding";
  }
  if (/\b(csv|dataset|data|metric|statistics|analysis)\b|数据|统计|分析/.test(normalized)) {
    return "data";
  }
  if (/\b(document|report|proposal|manual|specification)\b|文档|报告|方案|说明书/.test(normalized)) {
    return "document";
  }
  if (/\b(research|compare|investigate|survey|sources)\b|研究|调研|检索|比较/.test(normalized)) {
    return "research";
  }
  return "generic";
}

export function createAutopilotGoalSpec(goal: string, deliverables: string[] = [], acceptanceCriteria: string[] = []): AutopilotGoalSpec {
  return {
    objective: goal.trim(),
    deliverables: uniqueStrings(deliverables),
    acceptanceCriteria: uniqueStrings(acceptanceCriteria.length ? acceptanceCriteria : ["The requested outcome is produced and supported by recorded evidence."])
  };
}

export function createAutopilotBudget(input: Partial<AutopilotBudgetLimits> = {}, startedAt?: string): AutopilotBudget {
  const limits = {
    maxRuntimeMinutes: positive(input.maxRuntimeMinutes, defaultAutopilotBudgetLimits.maxRuntimeMinutes),
    maxIterations: positive(input.maxIterations, defaultAutopilotBudgetLimits.maxIterations),
    maxTasks: positive(input.maxTasks, defaultAutopilotBudgetLimits.maxTasks),
    maxModelTurns: positive(input.maxModelTurns, defaultAutopilotBudgetLimits.maxModelTurns),
    maxToolCalls: positive(input.maxToolCalls, defaultAutopilotBudgetLimits.maxToolCalls)
  };
  return {
    limits,
    usage: {
      iterations: 0,
      modelTurns: 0,
      toolCalls: 0,
      startedAt,
      deadlineAt: startedAt ? new Date(new Date(startedAt).getTime() + limits.maxRuntimeMinutes * 60_000).toISOString() : undefined
    }
  };
}

export function autopilotBudgetExceeded(run: AutopilotRun, includeIteration = true, now = Date.now()): string | undefined {
  const budget = run.budget;
  if (!budget) {
    return undefined;
  }
  if (budget.usage.deadlineAt && now >= new Date(budget.usage.deadlineAt).getTime()) {
    return "Runtime deadline reached";
  }
  if (includeIteration && budget.usage.iterations >= budget.limits.maxIterations) {
    return "Iteration budget exhausted";
  }
  if (run.taskIds.length > budget.limits.maxTasks) {
    return "Task budget exhausted";
  }
  if (budget.usage.modelTurns >= budget.limits.maxModelTurns) {
    return "Model-turn budget exhausted";
  }
  if (budget.usage.toolCalls >= budget.limits.maxToolCalls) {
    return "Tool-call budget exhausted";
  }
  return undefined;
}

export function classifyAutopilotFailure(message: string): AutopilotFailureCategory {
  const normalized = message.toLowerCase();
  if (/timeout|timed out|rate limit|429|temporar|network|econn|socket/.test(normalized)) {
    return "transient";
  }
  if (/permission|denied|unauthor|forbidden/.test(normalized)) {
    return "permission";
  }
  if (/schema|argument|parameter|invalid input|parse/.test(normalized)) {
    return "invalid_input";
  }
  if (/test|assert|validation|verify|lint|compile|build/.test(normalized)) {
    return "validation";
  }
  if (/budget|deadline|max turns|maxturns/.test(normalized)) {
    return "budget";
  }
  return "unrecoverable";
}

export function progressFingerprint(tasks: AutopilotTask[], artifactHashes: string[], evaluationFingerprint?: string): string {
  const state = tasks.filter((task) => !task.title.startsWith("Goal-output alignment review") && !task.title.startsWith("Revise outputs to match goal")).map((task) => ({
    id: task.id,
    status: task.status,
    attempts: task.attempts,
    actions: task.actionFingerprints || [],
    evaluation: task.lastEvaluation?.fingerprint
  }));
  return createHash("sha256")
    .update(JSON.stringify({ state, artifactHashes: [...artifactHashes].sort(), evaluationFingerprint }))
    .digest("hex");
}

export function compactAutopilotContext(run: AutopilotRun, task: AutopilotTask, tasks: AutopilotTask[], artifactPaths: string[]): string {
  const dependencies = new Set(task.dependsOn || []);
  const relevant = tasks
    .filter((item) => item.status === "completed" && (dependencies.has(item.id) || item.id === task.id))
    .slice(-4)
    .map((item) => `- ${item.title}: ${(item.output || "completed").slice(0, 600)}`);
  return [
    `Loop iteration: ${run.loopIteration || 0}`,
    `Plan version: ${run.plan?.version || 1}`,
    "Relevant completed work:",
    relevant.length ? relevant.join("\n") : "- None",
    "Relevant artifacts:",
    artifactPaths.slice(-12).map((path) => `- ${path}`).join("\n") || "- None"
  ].join("\n");
}

export function validateAutopilotPlan(plan: AutopilotPlan, tasks: AutopilotTask[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set(tasks.map((task) => task.id));
  if (!plan.summary.trim()) errors.push("Plan summary is required.");
  if (plan.taskIds.length !== tasks.length || new Set(plan.taskIds).size !== tasks.length) errors.push("Plan task ids must be unique and complete.");
  for (const task of tasks) {
    if (!task.title.trim() || !task.prompt.trim()) errors.push(`Task ${task.id} requires title and prompt.`);
    if (!task.allowedTools?.length) errors.push(`Task ${task.id} requires an explicit tool allowlist.`);
    for (const dependency of task.dependsOn || []) {
      if (!ids.has(dependency)) errors.push(`Task ${task.id} references missing dependency ${dependency}.`);
    }
  }
  if (hasDependencyCycle(tasks)) errors.push("Plan task dependencies contain a cycle.");
  return { ok: errors.length === 0, errors };
}

function hasDependencyCycle(tasks: AutopilotTask[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn || []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return tasks.some((task) => visit(task.id));
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
