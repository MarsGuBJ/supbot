import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ChatMessage,
  CompactBoundary,
  TranscriptDiagnostic,
  TranscriptLoadResult,
  TranscriptPage,
  TranscriptRecord,
  RuntimeEventRecord,
} from "@supbot/shared";

export type TranscriptEntry =
  | { type: "message"; message: ChatMessage }
  | { type: "event"; event: RuntimeEventRecord }
  | { type: "compact"; boundary: CompactBoundary };

export type { TranscriptLoadResult, TranscriptPage, TranscriptRecord } from "@supbot/shared";

export class TranscriptStore {
  constructor(private readonly dataDir: string) {}

  async append(conversationId: string, entry: TranscriptEntry): Promise<void> {
    const filePath = this.pathFor(conversationId);
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify({ ...entry, recordedAt: new Date().toISOString() })}\n`, "utf8");
  }

  async load(conversationId: string): Promise<TranscriptRecord[]> {
    return (await this.readEntries(conversationId)).entries;
  }

  async loadPage(
    conversationId: string,
    options: { beforeMessageId?: string; limit?: number } = {},
  ): Promise<TranscriptPage> {
    const messages = messagesFromEntries((await this.readEntries(conversationId)).entries, conversationId);
    const beforeIndex = options.beforeMessageId
      ? messages.findIndex((message) => message.id === options.beforeMessageId)
      : messages.length;
    const end = beforeIndex >= 0 ? beforeIndex : messages.length;
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit || 50)));
    const start = Math.max(0, end - limit);
    return {
      conversationId,
      messages: messages.slice(start, end),
      hasMore: start > 0,
      total: messages.length,
    };
  }

  async loadRecoverable(
    conversationId: string,
    stateMessages: ChatMessage[],
    stateBoundaries: CompactBoundary[],
  ): Promise<TranscriptLoadResult> {
    const read = await this.readEntries(conversationId);
    if (!read.entries.length) {
      const compactBoundary = latestBoundary(conversationId, stateBoundaries);
      return {
        conversationId,
        entries: [],
        activeMessages: activeMessagesAfterBoundary(stateMessages, compactBoundary),
        compactBoundary,
        source: "state",
        diagnostics: read.diagnostics.length
          ? read.diagnostics
          : [
              {
                level: "warning",
                message: "Transcript file was not found. Falling back to conversation state.",
                createdAt: new Date().toISOString(),
              },
            ],
      };
    }
    const compactBoundary =
      latestEntryBoundary(read.entries, conversationId) || latestBoundary(conversationId, stateBoundaries);
    const transcriptMessages = messagesFromEntries(read.entries, conversationId);
    const activeMessages = activeMessagesAfterBoundary(transcriptMessages, compactBoundary);
    return {
      conversationId,
      entries: read.entries,
      activeMessages: activeMessages.length
        ? activeMessages
        : activeMessagesAfterBoundary(stateMessages, compactBoundary),
      compactBoundary,
      source: "transcript",
      diagnostics: read.diagnostics,
    };
  }

  private async readEntries(
    conversationId: string,
  ): Promise<{ entries: TranscriptRecord[]; diagnostics: TranscriptDiagnostic[] }> {
    try {
      const raw = await readFile(this.pathFor(conversationId), "utf8");
      const entries: TranscriptRecord[] = [];
      const diagnostics: TranscriptDiagnostic[] = [];
      raw.split(/\r?\n/).forEach((line, index) => {
        if (!line.trim()) {
          return;
        }
        try {
          const parsed = JSON.parse(line) as TranscriptRecord;
          if (parsed.type === "message" || parsed.type === "event" || parsed.type === "compact") {
            entries.push(parsed);
            return;
          }
          diagnostics.push({
            level: "warning",
            message: `Ignored unknown transcript entry type at line ${index + 1}.`,
            line: index + 1,
            createdAt: new Date().toISOString(),
          });
        } catch (error) {
          diagnostics.push({
            level: "error",
            message: `Could not parse transcript line ${index + 1}: ${(error as Error).message}`,
            line: index + 1,
            createdAt: new Date().toISOString(),
          });
        }
      });
      return { entries, diagnostics };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { entries: [], diagnostics: [] };
      }
      throw error;
    }
  }

  async delete(conversationId: string): Promise<void> {
    await rm(this.pathFor(conversationId), { force: true });
  }

  pathFor(conversationId: string): string {
    return join(this.dataDir, "transcripts", `${safeFilePart(conversationId)}.jsonl`);
  }
}

export function messagesFromEntries(entries: TranscriptRecord[], conversationId: string): ChatMessage[] {
  const order: string[] = [];
  const messages = new Map<string, ChatMessage>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.conversationId !== conversationId) {
      continue;
    }
    if (!messages.has(entry.message.id)) {
      order.push(entry.message.id);
    }
    messages.set(entry.message.id, entry.message);
  }
  return order.map((id) => messages.get(id)!).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function latestEntryBoundary(entries: TranscriptRecord[], conversationId: string): CompactBoundary | undefined {
  return entries
    .filter((entry): entry is TranscriptRecord & { type: "compact" } => entry.type === "compact")
    .map((entry) => entry.boundary)
    .filter((boundary) => boundary.conversationId === conversationId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function latestBoundary(conversationId: string, boundaries: CompactBoundary[]): CompactBoundary | undefined {
  return boundaries
    .filter((boundary) => boundary.conversationId === conversationId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function activeMessagesAfterBoundary(messages: ChatMessage[], boundary: CompactBoundary | undefined): ChatMessage[] {
  const activeMessages = messages.filter(
    (message) => !message.blocks?.some((block) => block.type === "compact_summary"),
  );
  if (!boundary?.messageId) {
    return activeMessages;
  }
  const index = activeMessages.findIndex((message) => message.id === boundary.messageId);
  if (index >= 0) {
    return activeMessages.slice(index + 1);
  }
  return activeMessages.filter((message) => message.createdAt > boundary.createdAt);
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
