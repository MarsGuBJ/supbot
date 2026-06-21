import type { ChatMessage, ModelConfig, PersonalityConfig, SubagentConfig } from "@supbot/shared";
import { buildContext, type OpenAiMessage, type OpenAiToolCall } from "./contextBuilder";

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
  toolCalls?: OpenAiToolCall[];
}

export interface OpenAiToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
}

export interface GenerateAgentTurnInput {
  modelConfig: ModelConfig;
  apiKey?: string;
  messages: OpenAiMessage[];
  tools?: OpenAiToolDefinition[];
  signal?: AbortSignal;
}

export async function generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult> {
  const context = buildContext(input);
  return generateAgentTurn({
    modelConfig: input.modelConfig,
    apiKey: input.apiKey,
    messages: context.messages,
    tools: input.tools,
    signal: input.signal
  }).then((result) => {
    if (!result.text.trim() && !result.toolCalls?.length) {
      throw new Error("Model returned an empty response.");
    }
    return result;
  }).catch((error) => {
    if (!input.apiKey?.trim()) {
      return { text: localFallbackReply(input) };
    }
    throw error;
  });
}

export async function generateAgentTurn(input: GenerateAgentTurnInput): Promise<GenerateReplyResult> {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    return {
      text: localFallbackReply({
        modelConfig: input.modelConfig,
        personality: { summary: "", traits: [], instructions: "" },
        messages: input.messages.map((message, index) => ({
          id: `fallback-${index}`,
          conversationId: "fallback",
          role: message.role === "assistant" ? "assistant" : "user",
          text: typeof message.content === "string" ? message.content : "",
          createdAt: new Date().toISOString()
        }))
      })
    };
  }

  const url = normalizeChatCompletionsUrl(input.modelConfig.baseUrl);
  const body: Record<string, unknown> = {
    model: input.modelConfig.model,
    temperature: input.modelConfig.temperature,
    max_tokens: input.modelConfig.maxTokens,
    messages: input.messages
  };
  if (input.tools?.length) {
    body.tools = input.tools;
    body.tool_choice = "auto";
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
    signal: input.signal
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Model request failed (${response.status}): ${body.slice(0, 500) || response.statusText}`);
  }

  const json = await response.json() as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }>;
    output_text?: string;
  };
  const message = json.choices?.[0]?.message;
  const text = json.output_text || message?.content || "";
  const toolCalls = message?.tool_calls || [];
  if (!text.trim() && !toolCalls.length) {
    throw new Error("Model returned an empty response.");
  }
  return { text, toolCalls };
}

export function normalizeChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed;
  }
  if (trimmed.endsWith("/v1")) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
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
