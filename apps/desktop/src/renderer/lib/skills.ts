import type { CapabilityDefinition } from "@supbot/shared";

export function enabledSkillCapabilities(capabilities: CapabilityDefinition[]): CapabilityDefinition[] {
  return capabilities
    .filter((capability) => capability.kind === "skill" && capability.enabled && capability.name.trim())
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function formatSkillPromptDirective(skill: Pick<CapabilityDefinition, "name">): string {
  return `使用SKILL: ${skill.name.trim()}`;
}
