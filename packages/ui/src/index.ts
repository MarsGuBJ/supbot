import type { ChatMessage, Conversation, JobStatus, ScheduledJob } from "@supbot/shared";

export type SlashAction = "new" | "history" | "config" | "model" | "clear" | "copy" | "tool";

export interface SlashCommand {
  command: string;
  action: SlashAction;
  title: string;
  description: string;
  template?: string;
}

export const slashCommandTemplates: SlashCommand[] = [
  { command: "/new", action: "new", title: "New conversation", description: "Start a fresh local thread." },
  { command: "/history", action: "history", title: "History", description: "Open conversation history." },
  { command: "/config", action: "config", title: "Config", description: "Open agent configuration." },
  { command: "/model", action: "model", title: "Model", description: "Jump to model settings." },
  { command: "/clear", action: "clear", title: "Clear", description: "Create a clean chat." },
  { command: "/copy", action: "copy", title: "Copy latest", description: "Copy the newest assistant response." },
  { command: "/read", action: "tool", title: "Read file", description: "Read a local UTF-8 text file.", template: "/read " },
  { command: "/write", action: "tool", title: "Write file", description: "Create a generated local text file.", template: "/write note.txt\n" },
  { command: "/shell", action: "tool", title: "Shell", description: "Run a local shell command.", template: "/shell " }
];

export const slashCommands = slashCommandTemplates;

export function buildSlashCommands(t: (key: string) => string): SlashCommand[] {
  return slashCommandTemplates.map((item) => ({
    ...item,
    title: t(item.title),
    description: t(item.description)
  }));
}

export function resolveSlashCommand(input: string): SlashCommand | undefined {
  const head = input.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return slashCommandTemplates.find((item) => item.action !== "tool" && item.command === head);
}

export function conversationTitle(conversation: Conversation, fallback = "New conversation"): string {
  return conversation.title || conversation.messages.find((message) => message.role === "user")?.text.slice(0, 60) || fallback;
}

export function latestAssistantMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return [...messages].reverse().find((message) => message.role === "assistant");
}

export function statusLabel(status?: JobStatus, t: (key: string) => string = (key) => key): string {
  switch (status) {
    case "queued":
      return t("Queued");
    case "running":
      return t("Running");
    case "completed":
      return t("Completed");
    case "failed":
      return t("Failed");
    case "canceled":
      return t("Canceled");
    default:
      return t("Ready");
  }
}

export function statusColor(status?: JobStatus): string {
  switch (status) {
    case "queued":
      return "gold";
    case "running":
      return "cyan";
    case "completed":
      return "green";
    case "failed":
      return "red";
    case "canceled":
      return "default";
    default:
      return "blue";
  }
}

export function formatDateTime(value?: string): string {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function formatSchedule(job: ScheduledJob, t: (key: string, vars?: Record<string, string | number>) => string = (key, vars) => {
  if (!vars) return key;
  return Object.entries(vars).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), key);
}): string {
  if (job.scheduleKind === "once") {
    return job.runAt ? t("Once at {time}", { time: formatDateTime(job.runAt) }) : t("One-time task");
  }
  if (job.scheduleKind === "daily") {
    return job.runAt ? t("Daily around {time}", { time: new Date(job.runAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }) : t("Daily");
  }
  return job.cronExpr ? t("Cron {expr}", { expr: job.cronExpr }) : t("Cron");
}
