import type { AgentJob, ScheduledJob } from "@supbot/shared";

export interface ScheduleRunGroup {
  scheduledJobId: string;
  title: string;
  latestRunAt: string;
  runs: AgentJob[];
}

// runDueScheduledJobs sends prompts as `[Scheduled] {title}\n\n{prompt}`.
const SCHEDULED_PROMPT_PATTERN = /^\[Scheduled\]\s+([^\n]+)/;

export function scheduleRunTime(job: AgentJob): string {
  return job.finishedAt || job.createdAt;
}

export function scheduledTitleFromPrompt(prompt: string): string | undefined {
  const match = SCHEDULED_PROMPT_PATTERN.exec(prompt);
  return match?.[1]?.trim() || undefined;
}

/**
 * Groups agent jobs triggered by scheduled tasks into a two-level tree:
 * task title -> runs sorted by completion time (newest first). Jobs carry
 * scheduledJobId since the link was introduced; older runs are attributed by
 * matching the `[Scheduled] {title}` prompt prefix against known tasks, then
 * by the parsed title alone (task may be deleted). Manual prompts that never
 * went through the scheduler are excluded.
 */
export function groupScheduleRuns(
  jobs: AgentJob[],
  scheduledJobs: ScheduledJob[],
  fallbackTitle: string,
): ScheduleRunGroup[] {
  const byId = new Map(scheduledJobs.map((job) => [job.id, job]));
  const byTitle = new Map(scheduledJobs.map((job) => [job.title, job]));
  const grouped = new Map<string, { title: string; runs: AgentJob[] }>();
  for (const job of jobs) {
    let key: string | undefined;
    let title: string | undefined;
    if (job.scheduledJobId) {
      const scheduled = byId.get(job.scheduledJobId);
      key = scheduled?.id ?? job.scheduledJobId;
      title = scheduled?.title ?? scheduledTitleFromPrompt(job.prompt) ?? fallbackTitle;
    } else {
      const parsedTitle = scheduledTitleFromPrompt(job.prompt);
      if (!parsedTitle) {
        continue;
      }
      const scheduled = byTitle.get(parsedTitle);
      key = scheduled?.id ?? `prompt:${parsedTitle}`;
      title = scheduled?.title ?? parsedTitle;
    }
    const group = grouped.get(key) ?? { title: title ?? fallbackTitle, runs: [] };
    group.runs.push(job);
    grouped.set(key, group);
  }
  return [...grouped.entries()]
    .map(([scheduledJobId, group]) => {
      const sorted = [...group.runs].sort((a, b) => scheduleRunTime(b).localeCompare(scheduleRunTime(a)));
      return {
        scheduledJobId,
        title: group.title,
        latestRunAt: scheduleRunTime(sorted[0]),
        runs: sorted,
      };
    })
    .sort((a, b) => b.latestRunAt.localeCompare(a.latestRunAt));
}
