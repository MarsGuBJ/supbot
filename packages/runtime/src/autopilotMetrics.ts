import type { AutopilotActionRecord, AutopilotEvent, AutopilotQualitySummary, AutopilotQualityThresholds, AutopilotRun, AutopilotRunMetrics, AutopilotTask } from "@supbot/shared";

export const DEFAULT_AUTOPILOT_QUALITY_THRESHOLDS: AutopilotQualityThresholds = {
  minTaskCompletionRate: 0.8,
  minVerificationPassRate: 0.8,
  maxToolFailureRate: 0.25,
  maxRepeatedActionRate: 0.1,
  maxRegressionDelta: 0.15
};

export function calculateAutopilotMetrics(
  run: AutopilotRun,
  tasks: AutopilotTask[],
  actions: AutopilotActionRecord[],
  events: AutopilotEvent[],
  nowMs = Date.now()
): AutopilotRunMetrics {
  const completedTaskCount = tasks.filter((task) => task.status === "completed").length;
  const failedTaskCount = tasks.filter((task) => task.status === "failed").length;
  const blockedTaskCount = tasks.filter((task) => task.status === "blocked").length;
  const terminalActions = actions.filter((action) => action.status !== "started");
  const failedActions = terminalActions.filter((action) => action.status === "failed" || action.status === "denied").length;
  const fingerprints = new Map<string, number>();
  for (const action of terminalActions) {
    fingerprints.set(action.fingerprint, (fingerprints.get(action.fingerprint) || 0) + 1);
  }
  const repeatedActions = [...fingerprints.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  const evaluatedTasks = tasks.filter((task) => task.lastEvaluation);
  const passedEvaluations = evaluatedTasks.filter((task) => task.lastEvaluation?.passed).length;
  const approvals = events.reduce((result, event) => {
    const message = event.message.toLowerCase();
    if (!message.includes("approval")) return result;
    if (message.includes("granted") || message.includes("approved")) result.granted += 1;
    else if (message.includes("denied")) result.denied += 1;
    else if (message.includes("requires") || message.includes("requested")) result.requested += 1;
    return result;
  }, { requested: 0, granted: 0, denied: 0 });
  const durationStart = run.startedAt ? new Date(run.startedAt).getTime() : new Date(run.createdAt).getTime();
  const durationEnd = run.finishedAt ? new Date(run.finishedAt).getTime() : (run.status === "completed" || run.status === "failed" || run.status === "canceled" ? new Date(run.updatedAt).getTime() : nowMs);
  const usage = run.budget?.usage;
  return {
    runId: run.id,
    outcome: run.status,
    profile: run.resolvedProfile || (run.profile && run.profile !== "auto" ? run.profile : undefined),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: Math.max(0, durationEnd - durationStart),
    taskCount: tasks.length,
    completedTaskCount,
    failedTaskCount,
    blockedTaskCount,
    taskCompletionRate: ratio(completedTaskCount, tasks.length),
    firstPass: tasks.length > 0 && tasks.every((task) => task.status === "completed" && task.attempts <= 1 && (task.lastEvaluation ? task.lastEvaluation.passed : true)),
    iterations: usage?.iterations ?? run.loopIteration ?? 0,
    planRevisions: Math.max(0, (run.plan?.version || 1) - 1),
    modelTurns: usage?.modelTurns ?? 0,
    toolCalls: usage?.toolCalls ?? actions.length,
    toolFailureRate: ratio(failedActions, terminalActions.length),
    repeatedActionRate: ratio(repeatedActions, terminalActions.length),
    verificationPassRate: ratio(passedEvaluations, evaluatedTasks.length),
    approvalsRequested: approvals.requested,
    approvalsGranted: approvals.granted,
    approvalsDenied: approvals.denied,
    recoveryCount: events.filter((event) => /recovered|recovery/i.test(event.message)).length,
    noProgressStops: events.filter((event) => /no-progress|no progress/i.test(event.message)).length,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? Math.round((numerator / denominator) * 10_000) / 10_000 : 0;
}

export function summarizeAutopilotQuality(
  metrics: AutopilotRunMetrics[],
  tasks: AutopilotTask[],
  thresholds: Partial<AutopilotQualityThresholds> = {}
): AutopilotQualitySummary {
  const limits = { ...DEFAULT_AUTOPILOT_QUALITY_THRESHOLDS, ...thresholds };
  const ordered = [...metrics].sort((a, b) => metricTime(a) - metricTime(b) || a.runId.localeCompare(b.runId));
  const terminal = ordered.filter((item) => ["completed", "partially_completed", "budget_exhausted", "failed", "canceled", "blocked"].includes(item.outcome));
  const completed = terminal.filter((item) => item.outcome === "completed").length;
  const latest = ordered.at(-1);
  const baseline = latest ? ordered.slice(0, -1).reverse().find((item) => item.profile === latest.profile) : undefined;
  const regressions = latest ? qualityRegressions(latest, baseline, limits) : [];
  const failureCategories: AutopilotQualitySummary["failureCategories"] = {};
  for (const task of tasks) {
    if (task.failureCategory && ["failed", "blocked"].includes(task.status)) {
      failureCategories[task.failureCategory] = (failureCategories[task.failureCategory] || 0) + 1;
    }
  }
  return {
    runCount: ordered.length,
    terminalRunCount: terminal.length,
    completedRunCount: completed,
    successRate: ratio(completed, terminal.length),
    averageTaskCompletionRate: average(ordered.map((item) => item.taskCompletionRate)),
    averageVerificationPassRate: average(ordered.map((item) => item.verificationPassRate)),
    averageToolFailureRate: average(ordered.map((item) => item.toolFailureRate)),
    averageDurationMs: Math.round(average(ordered.map((item) => item.durationMs))),
    latestRunId: latest?.runId,
    baselineRunId: baseline?.runId,
    regressions,
    failureCategories
  };
}

function qualityRegressions(latest: AutopilotRunMetrics, baseline: AutopilotRunMetrics | undefined, limits: AutopilotQualityThresholds) {
  const result: AutopilotQualitySummary["regressions"] = [];
  if (latest.taskCompletionRate < limits.minTaskCompletionRate) result.push({ metric: "taskCompletionRate", actual: latest.taskCompletionRate, threshold: limits.minTaskCompletionRate, source: "threshold", message: "Task completion rate is below the configured threshold." });
  if (latest.verificationPassRate < limits.minVerificationPassRate) result.push({ metric: "verificationPassRate", actual: latest.verificationPassRate, threshold: limits.minVerificationPassRate, source: "threshold", message: "Verification pass rate is below the configured threshold." });
  if (latest.toolFailureRate > limits.maxToolFailureRate) result.push({ metric: "toolFailureRate", actual: latest.toolFailureRate, threshold: limits.maxToolFailureRate, source: "threshold", message: "Tool failure rate is above the configured threshold." });
  if (latest.repeatedActionRate > limits.maxRepeatedActionRate) result.push({ metric: "repeatedActionRate", actual: latest.repeatedActionRate, threshold: limits.maxRepeatedActionRate, source: "threshold", message: "Repeated action rate is above the configured threshold." });
  if (limits.maxDurationMs !== undefined && latest.durationMs > limits.maxDurationMs) result.push({ metric: "durationMs", actual: latest.durationMs, threshold: limits.maxDurationMs, source: "threshold", message: "Run duration is above the configured threshold." });
  if (baseline) {
    const comparisons: Array<["taskCompletionRate" | "verificationPassRate", number, number]> = [["taskCompletionRate", latest.taskCompletionRate, baseline.taskCompletionRate], ["verificationPassRate", latest.verificationPassRate, baseline.verificationPassRate]];
    for (const [metric, actual, previous] of comparisons) if (actual < previous - limits.maxRegressionDelta) result.push({ metric, actual, baseline: previous, source: "baseline", message: `${metric} regressed by more than the allowed delta.` });
    const increases: Array<["toolFailureRate" | "repeatedActionRate" | "durationMs", number, number]> = [["toolFailureRate", latest.toolFailureRate, baseline.toolFailureRate], ["repeatedActionRate", latest.repeatedActionRate, baseline.repeatedActionRate], ["durationMs", latest.durationMs, baseline.durationMs]];
    for (const [metric, actual, previous] of increases) if (actual > previous + (metric === "durationMs" ? previous * limits.maxRegressionDelta : limits.maxRegressionDelta)) result.push({ metric, actual, baseline: previous, source: "baseline", message: `${metric} regressed by more than the allowed delta.` });
  }
  return result;
}

function average(values: number[]): number {
  return values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10_000) / 10_000 : 0;
}

function metricTime(metrics: AutopilotRunMetrics): number {
  const value = metrics.finishedAt || metrics.startedAt;
  return value ? new Date(value).getTime() : 0;
}
