import type { ModelConfig } from "@supbot/shared";
import { normalizeChatCompletionsUrl, type OpenAiToolDefinition } from "./modelClient";

export type AdapterMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: AdapterToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface AdapterToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ModelTurnRequest {
  modelConfig: ModelConfig;
  apiKey?: string;
  messages: AdapterMessage[];
  tools?: OpenAiToolDefinition[];
  signal?: AbortSignal;
}

export interface ModelTurnResult {
  text: string;
  toolCalls: AdapterToolCall[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export type ModelStreamEvent =
  | { type: "message_delta"; delta: string }
  | { type: "tool_calls"; toolCalls: AdapterToolCall[] }
  | { type: "done"; result: ModelTurnResult };

export interface ModelAdapter {
  complete(input: ModelTurnRequest): Promise<ModelTurnResult>;
  stream(input: ModelTurnRequest): AsyncGenerator<ModelStreamEvent, ModelTurnResult, unknown>;
}

type ToolCallAccumulator = {
  id?: string;
  type: "function";
  function: {
    name?: string;
    arguments: string;
  };
};

export class OpenAIChatCompletionsAdapter implements ModelAdapter {
  async complete(input: ModelTurnRequest): Promise<ModelTurnResult> {
    const apiKey = input.apiKey?.trim();
    if (!apiKey) {
      return { text: localFallbackFromMessages(input.messages), toolCalls: [] };
    }

    const url = normalizeChatCompletionsUrl(input.modelConfig.baseUrl);
    const body = chatCompletionsBody(input);

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
      const responseBody = await response.text().catch(() => "");
      throw new Error(`Model request failed (${response.status}): ${responseBody.slice(0, 500) || response.statusText}`);
    }

    return parseChatCompletionJson(await response.json());
  }

  async *stream(input: ModelTurnRequest): AsyncGenerator<ModelStreamEvent, ModelTurnResult, unknown> {
    const apiKey = input.apiKey?.trim();
    if (!apiKey) {
      return yield* completeAsStream(this, input);
    }

    const url = normalizeChatCompletionsUrl(input.modelConfig.baseUrl);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ ...chatCompletionsBody(input), stream: true, stream_options: { include_usage: true } }),
      signal: input.signal
    });
    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new Error(`Model stream failed (${response.status}): ${responseBody.slice(0, 500) || response.statusText}`);
    }
    if (!response.body) {
      return yield* completeAsStream(this, input);
    }
    if (!(response.headers.get("content-type") || "").includes("text/event-stream")) {
      const result = parseChatCompletionJson(await response.json());
      if (result.text) {
        yield { type: "message_delta", delta: result.text };
      }
      if (result.toolCalls.length) {
        yield { type: "tool_calls", toolCalls: result.toolCalls };
      }
      yield { type: "done", result };
      return result;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolCallParts = new Map<number, ToolCallAccumulator>();
    let buffer = "";
    let text = "";
    let streamDone = false;
    let usage: ModelTurnResult["usage"];

    while (!streamDone) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (done) {
        streamDone = true;
      }
      const lines = buffer.split(/\r?\n/);
      buffer = streamDone ? "" : lines.pop() || "";
      for (const line of lines) {
        const payload = line.startsWith("data:") ? line.slice("data:".length).trim() : "";
        if (!payload) {
          continue;
        }
        if (payload === "[DONE]") {
          streamDone = true;
          break;
        }
        const event = parseStreamPayload(payload);
        if (event?.usage) {
          usage = normalizeUsage(event.usage);
        }
        const delta = event?.choices?.[0]?.delta;
        if (!delta) {
          continue;
        }
        if (delta.content) {
          text += delta.content;
          yield { type: "message_delta", delta: delta.content };
        }
        if (delta.tool_calls?.length) {
          mergeToolCallDeltas(toolCallParts, delta.tool_calls);
        }
      }
    }

    const toolCalls = materializeToolCalls(toolCallParts);
    if (toolCalls.length) {
      yield { type: "tool_calls", toolCalls };
    }
    if (!text.trim() && !toolCalls.length) {
      throw new Error("Model returned an empty stream.");
    }
    const result = { text, toolCalls, usage };
    yield { type: "done", result };
    return result;
  }
}

function parseChatCompletionJson(json: unknown): ModelTurnResult {
  const parsed = json as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: AdapterToolCall[] } }>;
    output_text?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; input_tokens?: number; output_tokens?: number };
  };
  const message = parsed.choices?.[0]?.message;
  const text = parsed.output_text || message?.content || "";
  const toolCalls = message?.tool_calls || [];
  if (!text.trim() && !toolCalls.length) {
    throw new Error("Model returned an empty response.");
  }
  return { text, toolCalls, usage: normalizeUsage(parsed.usage) };
}

function chatCompletionsBody(input: ModelTurnRequest): Record<string, unknown> {
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
  return body;
}

async function* completeAsStream(adapter: OpenAIChatCompletionsAdapter, input: ModelTurnRequest): AsyncGenerator<ModelStreamEvent, ModelTurnResult, unknown> {
  const result = await adapter.complete(input);
  if (result.text) {
    yield { type: "message_delta", delta: result.text };
  }
  if (result.toolCalls.length) {
    yield { type: "tool_calls", toolCalls: result.toolCalls };
  }
  yield { type: "done", result };
  return result;
}

function parseStreamPayload(payload: string): { choices?: Array<{ delta?: { content?: string; tool_calls?: StreamToolCallDelta[] } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; input_tokens?: number; output_tokens?: number } } | undefined {
  try {
    return JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string; tool_calls?: StreamToolCallDelta[] } }> };
  } catch {
    return undefined;
  }
}

function normalizeUsage(value: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; input_tokens?: number; output_tokens?: number } | undefined): ModelTurnResult["usage"] {
  if (!value) {
    return undefined;
  }
  return {
    inputTokens: value.input_tokens ?? value.prompt_tokens,
    outputTokens: value.output_tokens ?? value.completion_tokens,
    totalTokens: value.total_tokens
  };
}

interface StreamToolCallDelta {
  index?: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

function mergeToolCallDeltas(
  parts: Map<number, ToolCallAccumulator>,
  deltas: StreamToolCallDelta[]
): void {
  for (const delta of deltas) {
    const index = delta.index ?? parts.size;
    const current = parts.get(index) || { type: "function" as const, function: { arguments: "" } };
    if (delta.id) {
      current.id = delta.id;
    }
    if (delta.type) {
      current.type = delta.type;
    }
    if (delta.function?.name) {
      current.function.name = `${current.function.name || ""}${delta.function.name}`;
    }
    if (delta.function?.arguments) {
      current.function.arguments += delta.function.arguments;
    }
    parts.set(index, current);
  }
}

function materializeToolCalls(parts: Map<number, ToolCallAccumulator>): AdapterToolCall[] {
  return [...parts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, part]) => ({
      id: part.id || `tool_${index}`,
      type: "function" as const,
      function: {
        name: part.function.name || "",
        arguments: part.function.arguments
      }
    }))
    .filter((toolCall) => toolCall.function.name);
}

function localFallbackFromMessages(messages: AdapterMessage[]): string {
  const last = messages.filter((message): message is { role: "user"; content: string } => message.role === "user").at(-1)?.content || "";
  return [
    "本地回退模式：尚未配置 API 密钥。",
    "",
    "你的消息已经保存，本地运行时工作正常。请在“配置 > 模型”中添加 OpenAI-compatible Base URL、API 密钥和模型名，以启用真实模型调用。",
    "",
    "Local fallback: no API key is configured yet. Add an OpenAI-compatible base URL, API key, and model in Config > Model to enable real model calls.",
    last ? `\n最近提示词 / Last prompt: ${last}` : ""
  ].join("\n");
}
