import type { AgentJob, ScheduledJob } from "@supbot/shared";

export interface ScheduleRunGroup {
  scheduledJobId: string;
  title: string;
  latestRunAt: string;
  runs: AgentJob[];
}

export function scheduleRunTime(job: AgentJob): string {
  return job.finishedAt || job.createdAt;
}

/**
 * Groups agent jobs triggered by scheduled tasks into a two-level tree:
 * task title -> runs sorted by completion time (newest first). Jobs without a
 * scheduledJobId (manual prompts) are excluded. Runs whose scheduled task was
 * deleted fall back to `fallbackTitle`.
 */
export function groupScheduleRuns(
  jobs: AgentJob[],
  scheduledJobs: ScheduledJob[],
  fallbackTitle: string,
): ScheduleRunGroup[] {
  const titles = new Map(scheduledJobs.map((job) => [job.id, job.title]));
  const grouped = new Map<string, AgentJob[]>();
  for (const job of jobs) {
    if (!job.scheduledJobId) {
      continue;
    }
    const runs = grouped.get(job.scheduledJobId) ?? [];
    runs.push(job);
    grouped.set(job.scheduledJobId, runs);
  }
  return [...grouped.entries()]
    .map(([scheduledJobId, runs]) => {
      const sorted = [...runs].sort((a, b) => scheduleRunTime(b).localeCompare(scheduleRunTime(a)));
      return {
        scheduledJobId,
        title: titles.get(scheduledJobId) || fallbackTitle,
        latestRunAt: scheduleRunTime(sorted[0]),
        runs: sorted,
      };
    })
    .sort((a, b) => b.latestRunAt.localeCompare(a.latestRunAt));
}
