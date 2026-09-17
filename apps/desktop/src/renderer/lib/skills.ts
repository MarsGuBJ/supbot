import type { CapabilityDefinition } from "@supbot/shared";

export function enabledSkillCapabilities(capabilities: CapabilityDefinition[]): CapabilityDefinition[] {
  return capabilities
    .filter((capability) => capability.kind === "skill" && capability.enabled && capability.name.trim())
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function formatSkillPromptDirective(skill: Pick<CapabilityDefinition, "name">): string {
  return `使用SKILL: ${skill.name.trim()}`;
}

export const SKILL_ORDER_STORAGE_KEY = "hbclient.skillOrder";

/** Orders skills by the user's preferred id order; unknown skills keep name order at the end. */
export function orderSkillsByPreference(
  skills: CapabilityDefinition[],
  preferredOrder: readonly string[],
): CapabilityDefinition[] {
  const remaining = new Map(skills.map((skill) => [skill.id, skill]));
  const ordered: CapabilityDefinition[] = [];
  for (const id of preferredOrder) {
    const skill = remaining.get(id);
    if (skill) {
      ordered.push(skill);
      remaining.delete(id);
    }
  }
  const rest = [...remaining.values()].sort((left, right) => left.name.localeCompare(right.name));
  return [...ordered, ...rest];
}

export function loadSkillOrder(): string[] {
  try {
    const stored = window.localStorage.getItem(SKILL_ORDER_STORAGE_KEY);
    if (!stored) {
      return [];
    }
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function saveSkillOrder(order: readonly string[]): void {
  try {
    window.localStorage.setItem(SKILL_ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Ignore storage failures; the in-memory order still applies.
  }
}
