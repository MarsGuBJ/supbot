import { describe, expect, test } from "vitest";
import type { ChatMessage, Conversation, ScheduledJob } from "@supbot/shared";
import {
  buildSlashCommands,
  conversationTitle,
  formatDateTime,
  formatSchedule,
  latestAssistantMessage,
  resolveSlashCommand,
  statusColor,
  statusLabel
} from "../src/index";

describe("UI presentation helpers", () => {
  test("resolves translated slash commands", () => {
    expect(buildSlashCommands((key) => `t:${key}`)[0].title).toBe("t:New conversation");
    expect(resolveSlashCommand("  /CONFIG now")?.action).toBe("config");
    expect(resolveSlashCommand("/shell echo ok")).toBeUndefined();
    expect(resolveSlashCommand("/new")).toMatchObject({ action: "new" });
    expect(resolveSlashCommand("/history")).toMatchObject({ action: "history" });
    expect(resolveSlashCommand("/copy")).toMatchObject({ action: "copy" });
  });

  test("derives conversation and assistant summaries", () => {
    const messages = [
      { id: "u", conversationId: "c", role: "user", text: "First prompt", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "a", conversationId: "c", role: "assistant", text: "Answer", createdAt: "2026-01-01T00:00:01.000Z" }
    ] as ChatMessage[];
    expect(conversationTitle({ id: "c", title: "", messages } as Conversation)).toBe("First prompt");
    expect(latestAssistantMessage(messages)?.text).toBe("Answer");
    expect(conversationTitle({ id: "c", title: "Saved title", messages: [] } as Conversation)).toBe("Saved title");
    expect(conversationTitle({ id: "c", title: "", messages: [] } as Conversation)).toBe("New conversation");
    expect(latestAssistantMessage([])).toBeUndefined();
  });

  test("maps statuses and schedules", () => {
    expect(statusLabel("completed", (key) => `t:${key}`)).toBe("t:Completed");
    expect(statusLabel("queued", (key) => `t:${key}`)).toBe("t:Queued");
    expect(statusLabel("running", (key) => `t:${key}`)).toBe("t:Running");
    expect(statusLabel("failed", (key) => `t:${key}`)).toBe("t:Failed");
    expect(statusLabel("canceled", (key) => `t:${key}`)).toBe("t:Canceled");
    expect(statusLabel(undefined, (key) => `t:${key}`)).toBe("t:Ready");
    expect(statusLabel("queued")).toBe("Queued");
    expect(statusColor("failed")).toBe("red");
    expect(statusColor("queued")).toBe("gold");
    expect(statusColor("running")).toBe("cyan");
    expect(statusColor("completed")).toBe("green");
    expect(statusColor("canceled")).toBe("default");
    expect(statusColor()).toBe("blue");
    const translate = (key: string, vars?: Record<string, string | number>) => vars ? `${key}:${Object.values(vars).join(",")}` : key;
    expect(formatSchedule({ scheduleKind: "cron", cronExpr: "0 9 * * *" } as ScheduledJob, translate)).toBe("Cron {expr}:0 9 * * *");
    expect(formatSchedule({ scheduleKind: "once", runAt: "2026-01-01T00:00:00.000Z" } as ScheduledJob, translate)).toContain("Once at {time}:");
    expect(formatSchedule({ scheduleKind: "daily", runAt: "2026-01-01T00:00:00.000Z" } as ScheduledJob, translate)).toContain("Daily around {time}:");
    expect(formatSchedule({ scheduleKind: "daily" } as ScheduledJob, translate)).toBe("Daily");
    expect(formatSchedule({ scheduleKind: "cron" } as ScheduledJob, translate)).toBe("Cron");
    expect(formatSchedule({ scheduleKind: "cron", cronExpr: "0 8 * * *" } as ScheduledJob)).toBe("Cron 0 8 * * *");
    expect(formatDateTime()).toBe("-");
    expect(formatDateTime("2026-01-01T00:00:00.000Z")).not.toBe("-");
  });
});
