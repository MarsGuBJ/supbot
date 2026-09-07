import { describe, expect, test } from "vitest";
import type { AgentJob, ScheduledJob } from "@supbot/shared";
import { groupScheduleRuns, scheduleRunTime } from "./scheduleRecords";

const run = (id: string, overrides: Partial<AgentJob> = {}): AgentJob => ({
  id,
  conversationId: `conv-${id}`,
  prompt: "prompt",
  status: "completed",
  createdAt: "2026-09-06T08:00:00.000Z",
  updatedAt: "2026-09-06T08:00:00.000Z",
  progress: [],
  ...overrides,
});

const task = (id: string, title: string): ScheduledJob => ({
  id,
  title,
  prompt: "prompt",
  scheduleKind: "daily",
  enabled: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});

describe("groupScheduleRuns", () => {
  test("groups runs by scheduled task and sorts each group by completion time desc", () => {
    const groups = groupScheduleRuns(
      [
        run("a1", { scheduledJobId: "sched-a", finishedAt: "2026-09-05T09:00:00.000Z" }),
        run("b1", { scheduledJobId: "sched-b", finishedAt: "2026-09-06T09:00:00.000Z" }),
        run("a2", { scheduledJobId: "sched-a", finishedAt: "2026-09-06T10:00:00.000Z" }),
      ],
      [task("sched-a", "Task A"), task("sched-b", "Task B")],
      "Deleted task",
    );

    expect(groups.map((group) => group.title)).toEqual(["Task A", "Task B"]);
    expect(groups[0].runs.map((job) => job.id)).toEqual(["a2", "a1"]);
  });

  test("orders groups by their latest run", () => {
    const groups = groupScheduleRuns(
      [
        run("a1", { scheduledJobId: "sched-a", finishedAt: "2026-09-06T09:00:00.000Z" }),
        run("b1", { scheduledJobId: "sched-b", finishedAt: "2026-09-06T11:00:00.000Z" }),
      ],
      [task("sched-a", "Task A"), task("sched-b", "Task B")],
      "Deleted task",
    );

    expect(groups.map((group) => group.scheduledJobId)).toEqual(["sched-b", "sched-a"]);
  });

  test("ignores manual jobs without scheduledJobId", () => {
    const groups = groupScheduleRuns([run("manual")], [task("sched-a", "Task A")], "Deleted task");
    expect(groups).toEqual([]);
  });

  test("uses the fallback title when the scheduled task was deleted", () => {
    const groups = groupScheduleRuns(
      [run("a1", { scheduledJobId: "sched-gone", finishedAt: "2026-09-06T09:00:00.000Z" })],
      [],
      "Deleted task",
    );
    expect(groups[0].title).toBe("Deleted task");
  });

  test("falls back to createdAt for runs without finishedAt", () => {
    const running = run("a1", {
      scheduledJobId: "sched-a",
      status: "running",
      createdAt: "2026-09-06T12:00:00.000Z",
    });
    const done = run("a2", { scheduledJobId: "sched-a", finishedAt: "2026-09-06T09:00:00.000Z" });
    const groups = groupScheduleRuns([done, running], [task("sched-a", "Task A")], "Deleted task");
    expect(groups[0].runs.map((job) => job.id)).toEqual(["a1", "a2"]);
    expect(scheduleRunTime(running)).toBe(running.createdAt);
    expect(scheduleRunTime(done)).toBe(done.finishedAt);
  });
});
