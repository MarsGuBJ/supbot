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
 * task title -> runs sorted by completion time (newest first). Runs whose
 * scheduled task was deleted fall back to `fallbackTitle`. Jobs without a
 * scheduledJobId (legacy runs recorded before the link existed) are excluded
 * unless `unlinkedTitle` is given, in which case they are grouped under it.
 */
export function groupScheduleRuns(
  jobs: AgentJob[],
  scheduledJobs: ScheduledJob[],
  fallbackTitle: string,
  unlinkedTitle?: string,
): ScheduleRunGroup[] {
  const titles = new Map(scheduledJobs.map((job) => [job.id, job.title]));
  const grouped = new Map<string, AgentJob[]>();
  for (const job of jobs) {
    const key = job.scheduledJobId || (unlinkedTitle ? "" : undefined);
    if (key === undefined) {
      continue;
    }
    const runs = grouped.get(key) ?? [];
    runs.push(job);
    grouped.set(key, runs);
  }
  return [...grouped.entries()]
    .map(([scheduledJobId, runs]) => {
      const sorted = [...runs].sort((a, b) => scheduleRunTime(b).localeCompare(scheduleRunTime(a)));
      return {
        scheduledJobId,
        title: scheduledJobId ? titles.get(scheduledJobId) || fallbackTitle : unlinkedTitle || fallbackTitle,
        latestRunAt: scheduleRunTime(sorted[0]),
        runs: sorted,
      };
    })
    .sort((a, b) => b.latestRunAt.localeCompare(a.latestRunAt));
}
