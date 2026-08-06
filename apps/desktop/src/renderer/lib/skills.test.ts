import type { CapabilityDefinition } from "@supbot/shared";
import { describe, expect, it } from "vitest";
import { enabledSkillCapabilities, formatSkillPromptDirective } from "./skills";

describe("local skill prompt helpers", () => {
  it("keeps only enabled skill capabilities in name order", () => {
    const capabilities = [
      { id: "tool", name: "Tool", kind: "tool", description: "", enabled: true },
      { id: "disabled", name: "Disabled", kind: "skill", description: "", enabled: false },
      { id: "zeta", name: "Zeta", kind: "skill", description: "", enabled: true },
      { id: "alpha", name: "Alpha", kind: "skill", description: "", enabled: true },
    ] satisfies CapabilityDefinition[];

    expect(enabledSkillCapabilities(capabilities).map((skill) => skill.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("formats the requested skill directive", () => {
    expect(formatSkillPromptDirective({ name: " Document Skills " })).toBe("使用SKILL: Document Skills");
  });
});
