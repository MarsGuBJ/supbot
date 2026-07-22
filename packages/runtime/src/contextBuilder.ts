import type { ChatMessage, PersonalityConfig, SubagentConfig } from "@supbot/shared";

/**
 * Builds OpenAI-shaped messages for one-off model calls (generateReply).
 * Conversation turns build active context through ContextManager instead.
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
    messages: [{ role: "system", content: systemPrompt }, ...conversationMessages],
  };
}

function buildSystemPrompt(input: ContextBuilderInput): string {
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
    toolUseGuidance(),
    "You may call tools when they help. Explain tool outcomes concisely after they complete. If a tool is denied, adjust your answer without repeating the same request.",
    systemContext ? `<system_context>\n${systemContext}\n</system_context>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function toolUseGuidance(): string {
  return [
    "Tool calling rules:",
    "- Tool arguments must be exactly one complete JSON object matching the tool schema. Do not send raw text, markdown fences, comments, placeholders, or partial JSON.",
    "- WriteFile paths must be relative workspace paths unless the user explicitly provided an allowed project path. Never use placeholder paths such as /path/to/file.",
    "- WriteFile cannot save directly outside the workspace. To place a final artifact on the Desktop or another external location, create scripts/assets in the workspace, then use Shell to generate or copy the final file to the requested location.",
    "- For large artifacts, prefer a short script plus Shell execution over embedding a large generated file in WriteFile content.",
    "- On Windows, Shell runs PowerShell.",
  ].join("\n");
}

function toOpenAiMessage(message: ChatMessage): OpenAiMessage {
  if (message.role === "assistant") {
    return { role: "assistant", content: message.text };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId || message.id,
      content: message.text,
    };
  }
  return {
    role: "user",
    content: formatUserMessage(message),
  };
}

function formatUserMessage(message: ChatMessage): string {
  const attachmentText = (message.attachments || [])
    .map((attachment) => `\n[Attachment: ${attachment.name}${attachment.path ? ` at ${attachment.path}` : ""}]`)
    .join("");
  return `${message.text}${attachmentText}`;
}
