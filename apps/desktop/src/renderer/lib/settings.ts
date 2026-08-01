import type { ModelConfig, RuntimeStatus } from "@supbot/shared";

export function formatModelSummary(modelConfig: Pick<ModelConfig, "providerName" | "model">): string {
  return `${modelConfig.providerName.trim() || "-"} / ${modelConfig.model.trim() || "-"}`;
}

export function runtimeStatusTranslationKey(status: RuntimeStatus): "Ready" | "Running" | "Error" {
  if (status === "running") {
    return "Running";
  }
  if (status === "error") {
    return "Error";
  }
  return "Ready";
}

export function runtimeStatusColor(status: RuntimeStatus): "green" | "gold" | "red" {
  if (status === "running") {
    return "gold";
  }
  if (status === "error") {
    return "red";
  }
  return "green";
}
