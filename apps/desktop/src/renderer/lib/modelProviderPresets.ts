/**
 * Built-in presets for mainstream OpenAI-compatible model providers.
 * Selecting one in the model provider form autofills providerName/baseUrl,
 * so the user only has to enter an API key. Model lists are fetched live
 * from {baseUrl}/models (see listProviderModels in packages/runtime), so
 * presets intentionally carry no static model names that could go stale.
 * All base URLs must work with the versioned-root URL normalization in
 * packages/runtime (e.g. /v3 or /v4 append endpoints directly).
 */
export interface ModelProviderPreset {
  key: string;
  label: string;
  providerName: string;
  baseUrl: string;
}

export const modelProviderPresets: ModelProviderPreset[] = [
  {
    key: "openai",
    label: "OpenAI",
    providerName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    key: "deepseek",
    label: "DeepSeek",
    providerName: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
  },
  {
    key: "moonshot",
    label: "Moonshot (Kimi)",
    providerName: "Moonshot Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
  },
  {
    key: "zhipu",
    label: "智谱 GLM",
    providerName: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
  {
    key: "qwen",
    label: "阿里百炼 (Qwen)",
    providerName: "阿里百炼 Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  {
    key: "doubao",
    label: "火山引擎 (豆包)",
    providerName: "火山引擎 豆包",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  },
  {
    key: "openrouter",
    label: "OpenRouter",
    providerName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  {
    key: "siliconflow",
    label: "SiliconFlow",
    providerName: "SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
  },
  {
    key: "ollama",
    label: "Ollama (本地)",
    providerName: "Ollama 本地",
    baseUrl: "http://127.0.0.1:11434/v1",
  },
];

/** Find the preset whose baseUrl matches, tolerating trailing slashes. */
export function matchPresetByBaseUrl(baseUrl: string): ModelProviderPreset | undefined {
  const normalized = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return modelProviderPresets.find((preset) => preset.baseUrl.toLowerCase() === normalized);
}
