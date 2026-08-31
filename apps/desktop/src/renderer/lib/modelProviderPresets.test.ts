import { describe, expect, test } from "vitest";
import { matchPresetByBaseUrl, modelProviderPresets } from "./modelProviderPresets";

describe("modelProviderPresets", () => {
  test("every preset is complete", () => {
    expect(modelProviderPresets.length).toBeGreaterThanOrEqual(9);
    for (const preset of modelProviderPresets) {
      expect(preset.key).toBeTruthy();
      expect(preset.label).toBeTruthy();
      expect(preset.providerName).toBeTruthy();
      expect(preset.baseUrl).toBeTruthy();
    }
  });

  test("all remote presets use https", () => {
    for (const preset of modelProviderPresets.filter((item) => item.key !== "ollama")) {
      expect(preset.baseUrl.startsWith("https://")).toBe(true);
    }
  });

  test("preset keys are unique", () => {
    const keys = modelProviderPresets.map((preset) => preset.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("matchPresetByBaseUrl", () => {
  test("matches exactly and tolerates trailing slashes", () => {
    expect(matchPresetByBaseUrl("https://api.deepseek.com/v1")?.key).toBe("deepseek");
    expect(matchPresetByBaseUrl("https://api.deepseek.com/v1/")?.key).toBe("deepseek");
  });

  test("matches case-insensitively", () => {
    expect(matchPresetByBaseUrl("HTTPS://API.OPENAI.COM/V1")?.key).toBe("openai");
  });

  test("returns undefined for unknown or empty URLs", () => {
    expect(matchPresetByBaseUrl("https://example.com/v1")).toBeUndefined();
    expect(matchPresetByBaseUrl("")).toBeUndefined();
    expect(matchPresetByBaseUrl("   ")).toBeUndefined();
  });
});
