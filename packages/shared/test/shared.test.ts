import { describe, expect, test } from "vitest";
import { clampNumber, defaultModelConfig, defaultToolMarketConfig, nowIso } from "../src/index";

describe("shared defaults and helpers", () => {
  test("clamps finite values and falls back for non-finite input", () => {
    expect(clampNumber(5, 0, 10)).toBe(5);
    expect(clampNumber(-1, 0, 10)).toBe(0);
    expect(clampNumber(11, 0, 10)).toBe(10);
    expect(clampNumber(Number.NaN, 2, 10)).toBe(2);
  });

  test("exposes usable defaults and ISO timestamps", () => {
    expect(defaultModelConfig).toMatchObject({ providerName: "OpenAI Compatible", apiKeySaved: false });
    expect(defaultToolMarketConfig.source).toBe("hybrid");
    expect(new Date(nowIso()).toISOString()).toBeTruthy();
  });
});
