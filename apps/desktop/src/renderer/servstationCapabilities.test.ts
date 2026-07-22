import { describe, expect, test } from "vitest";
import type { ServstationLocalCapabilityAsset, ServstationServiceDefinition } from "@supbot/shared";
import {
  buildEffectiveServstationServices,
  buildVisibleServstationCapabilities,
  filterVisibleServstationCapabilities,
  formatServstationCapabilityPromptDirective,
} from "./servstationCapabilities";

function service(overrides: Partial<ServstationServiceDefinition> = {}): ServstationServiceDefinition {
  return {
    serviceId: "service-1",
    name: "Service one",
    description: "General capability",
    serviceType: "skill",
    status: "published",
    ...overrides,
  };
}

function localCapability(overrides: Partial<ServstationLocalCapabilityAsset> = {}): ServstationLocalCapabilityAsset {
  return {
    assetId: "asset-1",
    tenantId: "tenant-1",
    organizationId: "org-1",
    departmentId: "department-1",
    userId: "user-1",
    assetKind: "catalog_override",
    capabilityType: "skill",
    name: "Local capability",
    enabled: true,
    createdBy: "user-1",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("Servstation visible capabilities", () => {
  test("includes skill and MCP services", () => {
    const items = buildVisibleServstationCapabilities([
      service({ serviceId: "skill-1", name: "Review files", serviceType: "skill" }),
      service({ serviceId: "mcp-1", name: "Database tools", serviceType: "mcp" }),
    ]);

    expect(items.map((item) => [item.name, item.capabilityType])).toEqual([
      ["Review files", "skill"],
      ["Database tools", "mcp"],
    ]);
  });

  test("expands plugin skills, mcps, and mcpServers", () => {
    const items = buildVisibleServstationCapabilities([
      service({
        serviceId: "plugin-1",
        name: "Operations plugin",
        serviceType: "plugin",
        installSpec: {
          plugin: {
            skills: [{ name: "triage", displayName: "Triage queue" }],
            mcps: [{ name: "ticket-api" }],
            mcpServers: [{ name: "metrics-api" }],
          },
        },
      }),
    ]);

    expect(items.map((item) => [item.promptName, item.capabilityType])).toEqual([
      ["ticket-api", "mcp"],
      ["metrics-api", "mcp"],
      ["triage", "skill"],
    ]);
  });

  test("applies local metadata, skill markdown, and MCP server overrides", () => {
    const effective = buildEffectiveServstationServices(
      [
        service({
          serviceId: "skill-1",
          name: "Original skill",
          installSpec: { skill: { name: "original-skill", displayName: "Original skill", skillMarkdown: "old" } },
        }),
        service({
          serviceId: "mcp-1",
          name: "Original MCP",
          serviceType: "mcp",
          installSpec: { mcpServers: { old: { command: "old" } } },
        }),
      ],
      [
        localCapability({
          assetId: "skill-override",
          sourceServiceId: "skill-1",
          name: "Local skill",
          description: "Local skill description",
          skillMarkdown: "# Local instructions",
        }),
        localCapability({
          assetId: "mcp-override",
          sourceServiceId: "mcp-1",
          capabilityType: "mcp",
          name: "Local MCP",
          description: "Local MCP description",
          mcpServers: { current: { command: "new" } },
        }),
      ],
    );

    expect(effective[0]).toMatchObject({
      name: "Local skill",
      description: "Local skill description",
      installSpec: { skill: { displayName: "Local skill", skillMarkdown: "# Local instructions" } },
    });
    expect(effective[1]).toMatchObject({
      name: "Local MCP",
      description: "Local MCP description",
      installSpec: { mcpServers: { current: { command: "new" } } },
    });
  });

  test.each([
    ["database", "service-mcp"],
    ["service-mcp", "service-mcp"],
    ["warehouse", "service-mcp"],
    ["mcp", "service-mcp"],
    ["review", "skill-review"],
  ])("searches %s across name, ID, description, and type", (query, expectedId) => {
    const items = buildVisibleServstationCapabilities([
      service({
        serviceId: "service-mcp",
        name: "Database tools",
        description: "Query the warehouse",
        serviceType: "mcp",
      }),
      service({
        serviceId: "skill-review",
        name: "Review files",
        description: "Inspect changes",
        serviceType: "skill",
      }),
    ]);

    expect(filterVisibleServstationCapabilities(items, query)[0]?.key).toBe(expectedId);
  });

  test("formats prompt directives for skills and MCPs", () => {
    const [skill, mcp] = buildVisibleServstationCapabilities([
      service({ serviceId: "skill-1", name: "Review files", serviceType: "skill" }),
      service({ serviceId: "mcp-1", name: "Database tools", serviceType: "mcp" }),
    ]);

    expect(formatServstationCapabilityPromptDirective(skill)).toBe("使用skill:Review files");
    expect(formatServstationCapabilityPromptDirective(mcp)).toBe("使用MCP:Database tools");
  });
});
