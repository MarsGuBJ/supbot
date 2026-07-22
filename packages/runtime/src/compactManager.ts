import type { ChatMessage, CompactBoundary } from "@supbot/shared";
import { truncate } from "./localTools";

export interface CompactManagerOptions {
  thresholdChars?: number;
  keepRecentMessages?: number;
}

export class CompactManager {
  constructor(private readonly options: CompactManagerOptions = {}) {}

  shouldCompact(messages: ChatMessage[], boundaries: CompactBoundary[]): boolean {
    if (messages.length < 12) {
      return false;
    }
    const lastBoundary = boundaries
      .filter((boundary) => boundary.conversationId === messages[0]?.conversationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const activeMessages = lastBoundary?.messageId
      ? messages.slice(Math.max(0, messages.findIndex((message) => message.id === lastBoundary.messageId) + 1))
      : messages;
    return estimateChars(activeMessages) >= (this.options.thresholdChars ?? 48_000);
  }

  createBoundary(input: {
    conversationId: string;
    jobId?: string;
    messages: ChatMessage[];
    randomId(prefix: string): string;
    nowIso(): string;
  }): CompactBoundary | undefined {
    const keepRecentMessages = this.options.keepRecentMessages ?? 6;
    if (input.messages.length <= keepRecentMessages) {
      return undefined;
    }
    const summarized = input.messages.slice(0, -keepRecentMessages);
    const anchor = summarized.at(-1);
    if (!anchor) {
      return undefined;
    }
    return {
      id: input.randomId("compact"),
      conversationId: input.conversationId,
      jobId: input.jobId,
      messageId: anchor.id,
      summary: summarizeMessages(summarized),
      preservedMessageIds: input.messages.slice(-keepRecentMessages).map((message) => message.id),
      originalMessageCount: input.messages.length,
      createdAt: input.nowIso(),
    };
  }
}

function estimateChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => {
    const blockChars = (message.blocks || []).reduce((inner, block) => inner + JSON.stringify(block).length, 0);
    return sum + message.text.length + blockChars;
  }, 0);
}

function summarizeMessages(messages: ChatMessage[]): string {
  const lines = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-18)
    .map((message) => `${message.role}: ${firstLine(message.text)}`)
    .join("\n");
  return [
    `Conversation compacted after ${messages.length} earlier messages.`,
    "Recent pre-compact highlights:",
    truncate(lines, 12_000),
  ].join("\n");
}

function firstLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}
