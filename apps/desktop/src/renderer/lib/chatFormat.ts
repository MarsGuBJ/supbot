import { message } from "antd";
import type { AgentJob, RuntimeEventRecord, RuntimeSnapshot, ToolCallRecord } from "@supbot/shared";

export const hiddenChatGeneratedFileExtensions = new Set([
  ".bat",
  ".cmd",
  ".cjs",
  ".fish",
  ".js",
  ".jsx",
  ".mjs",
  ".pl",
  ".ps1",
  ".psd1",
  ".psm1",
  ".py",
  ".rb",
  ".sh",
  ".ts",
  ".tsx",
  ".vbs",
  ".wsf",
  ".zsh"
]);

export function generatedFileExtension(file: { name: string; path: string }): string {
  const source = file.name || file.path;
  const filename = source.split(/[\\/]/).pop() || source;
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
}

export function shouldShowGeneratedFileInChat(file: { name: string; path: string }): boolean {
  return !hiddenChatGeneratedFileExtensions.has(generatedFileExtension(file));
}

export function formatToolPayload(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2).slice(0, 1200);
  } catch {
    return String(value).slice(0, 1200);
  }
}

export function formatToolOutput(toolCall: ToolCallRecord): string {
  const parts = toolCall.outputParts?.map((part) => [
    `${part.type}${part.mimeType ? ` (${part.mimeType})` : ""}`,
    part.text
  ].join("\n")).join("\n\n");
  return truncateText(parts || toolCall.output || "", 1200);
}

export function jobRuntimeEventLabel(event: RuntimeEventRecord, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (event.kind === "tool_use_start") {
    return t("Tool call started");
  }
  return t(event.message || event.kind);
}

export function jobRuntimeEventColor(kind: RuntimeEventRecord["kind"]): string {
  if (kind === "turn_failed" || kind === "permission_timeout") {
    return "red";
  }
  if (kind === "turn_complete" || kind === "memory_write") {
    return "green";
  }
  if (kind === "compact" || kind === "worktree_event") {
    return "blue";
  }
  if (kind === "memory_recall" || kind === "memory_candidate") {
    return "purple";
  }
  return "cyan";
}

export function toolStatusColor(status: ToolCallRecord["status"]): string {
  switch (status) {
    case "pending_permission":
      return "gold";
    case "running":
      return "cyan";
    case "completed":
      return "green";
    case "failed":
    case "denied":
      return "red";
    default:
      return "default";
  }
}

export function assistantPreviewForJob(snapshot: RuntimeSnapshot, job: AgentJob): string {
  const conversation = snapshot.conversations.find((item) => item.id === job.conversationId);
  const messages = (conversation?.messages || []).filter((message) => message.jobId === job.id && message.role === "assistant");
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messages[index]?.text.trim() || "";
    if (text && !isAssistantWaitingText(text)) {
      return text;
    }
  }
  return "";
}

export function isAssistantWaitingText(text: string): boolean {
  return text === "HBClient is thinking..." || /^@.+ is thinking\.\.\.$/.test(text);
}

export function formatJsonSnippet(value: unknown, limit = 2400): string {
  const text = JSON.stringify(value, null, 2) || "";
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}

export function truncateText(value: string, maxLength: number): string {
  const chars = Array.from(value);
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join("")}...` : value;
}
