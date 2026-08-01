import { describe, expect, it } from "vitest";
import { formatModelSummary, runtimeStatusColor, runtimeStatusTranslationKey } from "./settings";

describe("settings menu helpers", () => {
  it("formats the active model summary", () => {
    expect(formatModelSummary({ providerName: " DeepSeek ", model: " deepseek-v4-flash " })).toBe(
      "DeepSeek / deepseek-v4-flash",
    );
  });

  it.each([
    ["ready", "Ready", "green"],
    ["running", "Running", "gold"],
    ["error", "Error", "red"],
  ] as const)("maps %s runtime state", (status, label, color) => {
    expect(runtimeStatusTranslationKey(status)).toBe(label);
    expect(runtimeStatusColor(status)).toBe(color);
  });
});
