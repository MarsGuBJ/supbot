import type { ChatMessage, ModelConfig, ModelUsage, PersonalityConfig, SubagentConfig } from "@supbot/shared";
import { buildContext, type OpenAiToolCall } from "./contextBuilder";
import { fetchWithRetry } from "./fetchWithRetry";

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
  usage?: ModelUsage;
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

const TOOL_REQUEST_MIN_MAX_TOKENS = 4096;

export class OpenAIChatCompletionsAdapter implements ModelAdapter {
  async complete(input: ModelTurnRequest): Promise<ModelTurnResult> {
    const apiKey = normalizeModelApiKey(input.apiKey);
    if (!apiKey) {
      return { text: localFallbackFromMessages(input.messages), toolCalls: [] };
    }

    const url = normalizeChatCompletionsUrl(input.modelConfig.baseUrl);
    const body = chatCompletionsBody(input);

    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
      { signal: input.signal },
    );
    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      throw new Error(
        `Model request failed (${response.status}): ${responseBody.slice(0, 500) || response.statusText}`,
      );
    }

    return parseChatCompletionJson(await response.json());
  }

  async *stream(input: ModelTurnRequest): AsyncGenerator<ModelStreamEvent, ModelTurnResult, unknown> {
    const apiKey = normalizeModelApiKey(input.apiKey);
    if (!apiKey) {
      return yield* completeAsStream(this, input);
    }

    const url = normalizeChatCompletionsUrl(input.modelConfig.baseUrl);
    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ ...chatCompletionsBody(input), stream: true, stream_options: { include_usage: true } }),
      },
      { signal: input.signal },
    );
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
    let usage: ModelUsage | undefined;
    let streamDone = false;

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
        const eventUsage = parseUsage(event?.usage);
        if (eventUsage) {
          usage = eventUsage;
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
    usage?: unknown;
  };
  const message = parsed.choices?.[0]?.message;
  const text = parsed.output_text || message?.content || "";
  const toolCalls = message?.tool_calls || [];
  if (!text.trim() && !toolCalls.length) {
    throw new Error("Model returned an empty response.");
  }
  return { text, toolCalls, usage: parseUsage(parsed.usage) };
}

function parseUsage(raw: unknown): ModelUsage | undefined {
  const usage = raw as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown } | undefined;
  if (!usage || typeof usage.prompt_tokens !== "number") {
    return undefined;
  }
  const promptTokens = usage.prompt_tokens;
  const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function chatCompletionsBody(input: ModelTurnRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.modelConfig.model,
    temperature: input.modelConfig.temperature,
    max_tokens: effectiveMaxTokens(input),
    messages: input.messages,
  };
  if (input.tools?.length) {
    body.tools = input.tools;
    body.tool_choice = "auto";
  }
  return body;
}

function effectiveMaxTokens(input: ModelTurnRequest): number {
  if (!input.tools?.length) {
    return input.modelConfig.maxTokens;
  }
  return Math.max(input.modelConfig.maxTokens, TOOL_REQUEST_MIN_MAX_TOKENS);
}

async function* completeAsStream(
  adapter: OpenAIChatCompletionsAdapter,
  input: ModelTurnRequest,
): AsyncGenerator<ModelStreamEvent, ModelTurnResult, unknown> {
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

function parseStreamPayload(
  payload: string,
):
  | { choices?: Array<{ delta?: { content?: string; tool_calls?: StreamToolCallDelta[] } }>; usage?: unknown }
  | undefined {
  try {
    return JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: string; tool_calls?: StreamToolCallDelta[] } }>;
      usage?: unknown;
    };
  } catch {
    return undefined;
  }
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

function mergeToolCallDeltas(parts: Map<number, ToolCallAccumulator>, deltas: StreamToolCallDelta[]): void {
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
        arguments: part.function.arguments,
      },
    }))
    .filter((toolCall) => toolCall.function.name);
}

function localFallbackFromMessages(messages: AdapterMessage[]): string {
  const last =
    messages.filter((message): message is { role: "user"; content: string } => message.role === "user").at(-1)
      ?.content || "";
  return [
    "本地回退模式：尚未配置 API 密钥。",
    "",
    "你的消息已经保存，本地运行时工作正常。请在“配置 > 模型”中添加 OpenAI-compatible Base URL、API 密钥和模型名，以启用真实模型调用。",
    "",
    "Local fallback: no API key is configured yet. Add an OpenAI-compatible base URL, API key, and model in Config > Model to enable real model calls.",
    last ? `\n最近提示词 / Last prompt: ${last}` : "",
  ].join("\n");
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

export async function generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult> {
  const context = buildContext(input);
  const adapter = new OpenAIChatCompletionsAdapter();
  try {
    const result = await adapter.complete({
      modelConfig: input.modelConfig,
      apiKey: input.apiKey,
      messages: context.messages,
      tools: input.tools,
      signal: input.signal,
    });
    return { text: result.text, toolCalls: result.toolCalls };
  } catch (error) {
    if (!input.apiKey?.trim()) {
      return { text: localFallbackReply(input) };
    }
    throw error;
  }
}

function versionedApiUrl(baseUrl: string, endpoint: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith(endpoint)) {
    return trimmed;
  }
  // Versioned API roots (/v1, /v3, /v4, ...) append the endpoint directly;
  // bare origins get the OpenAI default /v1 prefix.
  if (/\/v\d+[a-z]*$/i.test(trimmed)) {
    return `${trimmed}${endpoint}`;
  }
  return `${trimmed}/v1${endpoint}`;
}

export function normalizeChatCompletionsUrl(baseUrl: string): string {
  return versionedApiUrl(baseUrl, "/chat/completions");
}

export function normalizeModelsUrl(baseUrl: string): string {
  return versionedApiUrl(baseUrl, "/models");
}

/** GET {baseUrl}/models on an OpenAI-compatible endpoint and return the model ids. */
export async function listProviderModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const headers: Record<string, string> = {};
  const key = normalizeModelApiKey(apiKey);
  if (key) {
    headers.authorization = `Bearer ${key}`;
  }
  const response = await fetchWithRetry(normalizeModelsUrl(baseUrl), { headers });
  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    throw new Error(
      `Model list request failed (${response.status}): ${responseBody.slice(0, 500) || response.statusText}`,
    );
  }
  const payload = (await response.json()) as { data?: Array<{ id?: unknown }> };
  if (!Array.isArray(payload.data)) {
    throw new Error("Model list response is not OpenAI-compatible (missing data array).");
  }
  return payload.data.map((item) => (typeof item?.id === "string" ? item.id : "")).filter((id) => id.length > 0);
}

export function normalizeModelApiKey(value?: string): string {
  const trimmed = value?.trim() || "";
  if (!trimmed) {
    return "";
  }
  const embeddedKey = trimmed.match(/sk-[A-Za-z0-9._-]+/)?.[0];
  const apiKey = embeddedKey || trimmed;
  if (!/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new Error(
      "Model API key contains invalid characters. Paste only the provider API key, such as sk-..., without labels or Chinese text.",
    );
  }
  return apiKey;
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
    last ? `\n最近提示词 / Last prompt: ${last}` : "",
  ].join("\n");
}
