/**
 * 视觉 LLM 调用封装：注入 ModelAdapter + ModelConfig，不修改 modelAdapter 本身。
 * 对应 k-pipeline 的 LLMClient.vision_messages / parse_llm_confidence。
 */

import type { ModelConfig } from "@supbot/shared";
import type { ModelAdapter } from "../../modelAdapter";

/** 视觉模型能力：adapter 负责传输，modelConfig 提供模型参数。 */
export interface VisionLlm {
  adapter: ModelAdapter;
  modelConfig: ModelConfig;
  apiKey?: string;
}

export interface VisionImage {
  base64: string;
  /** 如 "image/png"、"image/jpeg"。 */
  mime: string;
}

/** OpenAI 兼容 vision 请求的消息 content（文本 + data URL 图片）。 */
type MultimodalContent = Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

/**
 * 视觉 LLM 单次调用：图片以 data URL 内联，返回模型原始文本。
 *
 * 注意：AdapterMessage.user.content 类型为 string，但 OpenAI chat/completions
 * 的多模态消息需要 content 数组；OpenAIChatCompletionsAdapter 直接
 * JSON.stringify messages 透传，因此这里以运行时类型断言传入数组，
 * 不改动 modelAdapter 本身。不支持多模态 content 的网关会在此处报错，
 * 由调用方捕获并按「模型不支持图像」降级（低置信度进 Review）。
 */
export async function visionComplete(llm: VisionLlm, image: VisionImage, prompt: string): Promise<string> {
  const content: MultimodalContent = [
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } },
  ];
  const result = await llm.adapter.complete({
    modelConfig: llm.modelConfig,
    apiKey: llm.apiKey,
    messages: [{ role: "user", content: content as unknown as string }],
  });
  return result.text;
}

const CONFIDENCE_RE = /<!--\s*confidence:\s*([01](?:\.\d+)?)\s*-->/;

/**
 * 剥离模型输出末尾的 <!-- confidence: 0.xx --> 自评标记。
 * 返回 [markdown, 置信度]；无标记时置信度为 null，由调用方决定默认值。
 */
export function parseLlmConfidence(text: string): [string, number | null] {
  const match = CONFIDENCE_RE.exec(text);
  if (!match) {
    return [text.trim(), null];
  }
  return [text.replace(CONFIDENCE_RE, "").trim(), Number.parseFloat(match[1]!)];
}
