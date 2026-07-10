import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage, CompactBoundary, PersonalityConfig, SubagentConfig } from "@supbot/shared";
import type { AdapterMessage } from "./modelAdapter";
import { truncate } from "./localTools";

export interface ContextManagerInput {
  dataDir: string;
  cwd?: string;
  personality: PersonalityConfig;
  subagent?: SubagentConfig;
  messages: ChatMessage[];
  compactBoundaries: CompactBoundary[];
  memoryBlock?: string;
  systemContext?: Record<string, string>;
  maxConversationMessages?: number;
}

export interface ManagedContext {
  systemPrompt: string;
  messages: AdapterMessage[];
  activeMessages: ChatMessage[];
  compactBoundary?: CompactBoundary;
  projectInstructions?: string;
}

export class ContextManager {
  async build(input: ContextManagerInput): Promise<ManagedContext> {
    const compactBoundary = latestBoundary(input.messages[0]?.conversationId, input.compactBoundaries);
    const activeMessages = projectActiveMessages(input.messages, compactBoundary, input.maxConversationMessages ?? 48);
    const projectInstructions = await readProjectInstructions(input.cwd || process.cwd());
    const systemPrompt = buildSystemPrompt({ ...input, projectInstructions, compactBoundary });
    const messages = [
      { role: "system" as const, content: systemPrompt },
      ...activeMessages.filter((message) => message.role !== "system").map(toAdapterMessage)
    ];
    return { systemPrompt, messages, activeMessages, compactBoundary, projectInstructions };
  }
}

function latestBoundary(conversationId: string | undefined, boundaries: CompactBoundary[]): CompactBoundary | undefined {
  if (!conversationId) {
    return undefined;
  }
  return boundaries
    .filter((boundary) => boundary.conversationId === conversationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function projectActiveMessages(messages: ChatMessage[], boundary: CompactBoundary | undefined, maxConversationMessages: number): ChatMessage[] {
  const postBoundary = boundary?.messageId
    ? messages.slice(Math.max(0, messages.findIndex((message) => message.id === boundary.messageId) + 1))
    : messages;
  return postBoundary.slice(-maxConversationMessages);
}

function buildSystemPrompt(input: ContextManagerInput & { projectInstructions?: string; compactBoundary?: CompactBoundary }): string {
  const identity = input.subagent
    ? `You are subagent @${input.subagent.name}. ${input.subagent.systemPrompt}`
    : "You are HBClient, a local desktop agent.";
  const systemContext = Object.entries(input.systemContext || {})
    .filter(([, value]) => value.trim())
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return [
    identity,
    input.personality.summary,
    input.personality.traits.length ? `Traits: ${input.personality.traits.join(", ")}` : "",
    input.personality.instructions,
    "You may call tools when they help. Explain tool outcomes concisely after they complete. If a tool is denied or times out, adjust your answer without repeating the same request.",
    "Prefer reading available project instructions before making assumptions about local workflow.",
    input.compactBoundary ? `<conversation_summary>\n${input.compactBoundary.summary}\n</conversation_summary>` : "",
    input.memoryBlock ? `${input.memoryBlock}\nUse memory as user-approved long-term context. Current user instructions override memory when they conflict.` : "",
    input.projectInstructions ? `<project_instructions>\n${input.projectInstructions}\n</project_instructions>` : "",
    systemContext ? `<system_context>\n${systemContext}\n</system_context>` : ""
  ].filter(Boolean).join("\n");
}

function toAdapterMessage(message: ChatMessage): AdapterMessage {
  if (message.role === "assistant") {
    return { role: "assistant", content: message.text || null };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId || message.id,
      content: message.text
    };
  }
  return {
    role: "user",
    content: formatUserMessage(message)
  };
}

function formatUserMessage(message: ChatMessage): string {
  const attachmentText = (message.attachments || [])
    .map((attachment) => `\n[Attachment: ${attachment.name}${attachment.path ? ` at ${attachment.path}` : ""}]`)
    .join("");
  return `${message.text}${attachmentText}`;
}

async function readProjectInstructions(cwd: string): Promise<string | undefined> {
  const files = [join(cwd, "AGENTS.md"), join(cwd, "CLAUDE.md")];
  const chunks: string[] = [];
  for (const file of files) {
    try {
      const content = await readFile(file, "utf8");
      chunks.push(`# ${file}\n${truncate(content, 8_000)}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        chunks.push(`# ${file}\n[Could not read project instruction file: ${(error as Error).message}]`);
      }
    }
  }
  return chunks.length ? chunks.join("\n\n") : undefined;
}
