import type { ChatMessage, ModelConfig, PersonalityConfig, SubagentConfig } from "@supbot/shared";
import { buildContext } from "./contextBuilder";
import { OpenAIChatCompletionsAdapter, type AdapterToolCall, type OpenAiToolDefinition } from "./modelAdapter";

export interface GenerateReplyInput {
  modelConfig: ModelConfig;
  apiKey?: string;
  personality: PersonalityConfig;
  subagent?: SubagentConfig;
  messages: ChatMessage[];
  tools?: OpenAiToolDefinition[];
  signal?: AbortSignal;
}

export interface GenerateReplyResult {
  text: string;
  toolCalls?: AdapterToolCall[];
}

export async function generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult> {
  if (!input.apiKey?.trim()) {
    return { text: localFallbackReply(input) };
  }
  const context = buildContext(input);
  const result = await new OpenAIChatCompletionsAdapter().complete({
    modelConfig: input.modelConfig,
    apiKey: input.apiKey,
    messages: context.messages,
    tools: input.tools,
    signal: input.signal
  });
  return { text: result.text, toolCalls: result.toolCalls };
}

function localFallbackReply(input: GenerateReplyInput): string {
  const last = input.messages.filter((message) => message.role === "user").at(-1)?.text || "";
  const zhSubagent = input.subagent ? `（@${input.subagent.name}）` : "";
  const enSubagent = input.subagent ? ` via @${input.subagent.name}` : "";
  return [
    `本地回退模式${zhSubagent}：尚未配置 API 密钥。`,
    "",
    "你的消息已经保存，本地运行时工作正常。请在“配置 > 模型”中添加 OpenAI-compatible Base URL、API 密钥和模型名，以启用真实模型调用。",
    "",
    `Local fallback${enSubagent}: no API key is configured yet. Add an OpenAI-compatible base URL, API key, and model in Config > Model to enable real model calls.`,
    last ? `\n最近提示词 / Last prompt: ${last}` : ""
  ].join("\n");
}
