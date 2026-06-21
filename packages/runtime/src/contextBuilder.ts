import type { ChatMessage, PersonalityConfig, SubagentConfig } from "@supbot/shared";

/**
 * @deprecated Runtime v2.5 builds active conversation context through ContextManager.
 * This OpenAI-shaped builder remains for legacy agentLoop/modelClient callers.
 */
export type OpenAiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ContextBuilderInput {
  personality: PersonalityConfig;
  subagent?: SubagentConfig;
  messages: ChatMessage[];
  systemContext?: Record<string, string>;
  maxConversationMessages?: number;
}

export interface BuiltContext {
  systemPrompt: string;
  messages: OpenAiMessage[];
}

export function buildContext(input: ContextBuilderInput): BuiltContext {
  const systemPrompt = buildSystemPrompt(input);
  const maxConversationMessages = input.maxConversationMessages ?? 40;
  const conversationMessages = input.messages
    .filter((message) => message.role !== "system")
    .slice(-maxConversationMessages)
    .map(toOpenAiMessage);

  return {
    systemPrompt,
    messages: [{ role: "system", content: systemPrompt }, ...conversationMessages]
  };
}

function buildSystemPrompt(input: ContextBuilderInput): string {
  const identity = input.subagent
    ? `You are subagent @${input.subagent.name}. ${input.subagent.systemPrompt}`
    : "You are Supbot, a local desktop agent.";
  const systemContext = Object.entries(input.systemContext || {})
    .filter(([, value]) => value.trim())
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return [
    identity,
    input.personality.summary,
    input.personality.traits.length ? `Traits: ${input.personality.traits.join(", ")}` : "",
    input.personality.instructions,
    "You may call tools when they help. Explain tool outcomes concisely after they complete. If a tool is denied, adjust your answer without repeating the same request.",
    systemContext ? `<system_context>\n${systemContext}\n</system_context>` : ""
  ].filter(Boolean).join("\n");
}

function toOpenAiMessage(message: ChatMessage): OpenAiMessage {
  if (message.role === "assistant") {
    return { role: "assistant", content: message.text };
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
