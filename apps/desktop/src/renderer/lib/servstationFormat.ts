import type { ServstationConversation, ServstationScheduledJob, ServstationSessionJob } from "@supbot/shared";
import { formatDateTime } from "@supbot/shared";
import { formatJsonSnippet } from "./chatFormat";
import type { Translator } from "./types";

export function formatMessageTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export interface ServstationChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  status?: string;
  jobId?: string;
  attachments?: Array<{ name: string; mimeType?: string; size: number }>;
  createdAt: number;
}

export function servstationMessagesFromJobs(jobs: ServstationSessionJob[]): ServstationChatMessage[] {
  return [...jobs].sort(compareServstationJobs).flatMap((job) => {
    const createdAt = servstationJobCreatedAtMs(job);
    return [
      {
        id: `${job.id}-user`,
        role: "user" as const,
        text: servstationJobPrompt(job) || job.requestId || job.id,
        attachments: extractServstationMessageAttachments(job),
        createdAt,
      },
      {
        id: `${job.id}-agent`,
        role: "agent" as const,
        text: servstationJobAssistantText(job) || servstationJobProgressText(job) || job.status,
        status: job.status,
        jobId: job.id,
        createdAt: servstationJobResponseAtMs(job) || createdAt,
      },
    ];
  });
}

export function servstationJobIsTerminal(job: Pick<ServstationSessionJob, "status">): boolean {
  return ["completed", "failed", "canceled", "cancelled"].includes(job.status);
}

export function servstationConversationTitle(conversation: ServstationConversation, fallback: string): string {
  return conversation.title?.trim() || formatDateTime(conversation.createdAt) || fallback;
}

export function servstationJobTitle(job: ServstationSessionJob): string {
  const prompt = servstationJobPrompt(job);
  if (prompt) {
    return prompt.length > 72 ? `${prompt.slice(0, 72)}...` : prompt;
  }
  return job.requestId || job.id;
}

export function servstationJobPrompt(job: ServstationSessionJob): string {
  const payload = toRecord(job.payload);
  const prompt = stringField(payload, "prompt") || stringField(payload, "message") || stringField(payload, "input");
  return prompt?.trim() || "";
}

export function servstationJobAssistantText(job: ServstationSessionJob): string {
  if (job.status === "completed") {
    const result = servstationResultText(job.result);
    if (result) {
      return result;
    }
  }
  if (job.terminalMessage?.trim()) {
    return job.terminalMessage.trim();
  }
  if (job.status === "failed" && job.terminalCode?.trim()) {
    return job.terminalCode.trim();
  }
  return "";
}

export function servstationResultText(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  const record = toRecord(value);
  if (!record) {
    return String(value);
  }
  for (const key of ["assistantText", "text", "message", "output"]) {
    const text = stringField(record, key);
    if (text?.trim()) {
      return text.trim();
    }
  }
  const assistantMessages = record.assistantMessages;
  if (Array.isArray(assistantMessages)) {
    const text = assistantMessages
      .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      .join("\n");
    if (text) {
      return text;
    }
  }
  const messages = record.messages;
  if (Array.isArray(messages)) {
    const text = messages
      .map((item) => {
        const message = toRecord(item);
        if (!message || message.role !== "assistant") {
          return "";
        }
        return stringField(message, "content") || stringField(message, "text") || "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) {
      return text;
    }
  }
  return formatJsonSnippet(record, 900);
}

export function servstationJobProgressText(job: ServstationSessionJob): string {
  const progress = toRecord(job.progress);
  return (
    stringField(progress, "message") ||
    stringField(progress, "assistantPreview") ||
    stringField(progress, "phase") ||
    ""
  );
}

export function extractServstationMessageAttachments(
  job: ServstationSessionJob,
): ServstationChatMessage["attachments"] {
  const payload = toRecord(job.payload);
  const raw = payload?.attachments;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const attachments = raw
    .map((item) => {
      const record = toRecord(item);
      const name = stringField(record, "name");
      if (!name) {
        return null;
      }
      const mimeType = stringField(record, "mimeType");
      const size = numberField(record, "size") || 0;
      return mimeType ? { name, mimeType, size } : { name, size };
    })
    .filter((item): item is { name: string; mimeType?: string; size: number } => Boolean(item));
  return attachments.length ? attachments : undefined;
}

export function servstationScheduleLabel(job: ServstationScheduledJob, t: Translator): string {
  if (job.scheduleKind === "once") {
    return `${t("Once")} / ${formatDateTime(job.runAt || job.nextRunAt || job.createdAt)}`;
  }
  if (job.scheduleKind === "cron") {
    return `${t("Cron")} / ${job.cronExpr || t("No cron expression")}`;
  }
  return job.scheduleKind || t("Schedule");
}

export function servstationStatusColor(status: string): string {
  if (["completed", "connected", "enabled", "watching"].includes(status)) {
    return "green";
  }
  if (["failed", "error", "needs_user"].includes(status)) {
    return "red";
  }
  if (["queued", "pending", "idle"].includes(status)) {
    return "gold";
  }
  if (["running", "processing", "driving"].includes(status)) {
    return "blue";
  }
  if (["paused", "canceled", "cancelled", "stopped"].includes(status)) {
    return "default";
  }
  return "cyan";
}

export function compareServstationJobs(left: ServstationSessionJob, right: ServstationSessionJob): number {
  const byCreatedAt = servstationJobCreatedAtMs(left) - servstationJobCreatedAtMs(right);
  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }
  const byQueue = left.queuePosition - right.queuePosition;
  if (byQueue !== 0) {
    return byQueue;
  }
  return left.id.localeCompare(right.id);
}

export function servstationJobCreatedAtMs(job: ServstationSessionJob): number {
  return Date.parse(job.createdAt) || 0;
}

export function servstationJobResponseAtMs(job: ServstationSessionJob): number {
  return Date.parse(job.finishedAt || job.startedAt || job.createdAt) || servstationJobCreatedAtMs(job);
}

export function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

export function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function servstationMessagesFromTranscript(
  transcript: NonNullable<ServstationConversation["messages"]>,
  jobs: ServstationSessionJob[],
): ServstationChatMessage[] {
  if (!transcript.length) {
    return servstationMessagesFromJobs(jobs);
  }
  const representedJobIds = new Set(transcript.map((message) => message.jobId).filter(Boolean));
  const runningJobs = jobs.filter((job) => !servstationJobIsTerminal(job) && !representedJobIds.has(job.id));
  return [
    ...transcript.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      status: message.status,
      jobId: message.jobId,
      createdAt: servstationMessageCreatedAtMs(message.createdAt),
    })),
    ...servstationMessagesFromJobs(runningJobs),
  ].sort((left, right) => left.createdAt - right.createdAt);
}

export function servstationMessageCreatedAtMs(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
