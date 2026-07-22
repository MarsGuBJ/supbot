import type {
  ServstationLocalCapabilityAsset,
  ServstationServiceDefinition,
  ServstationServiceInstallSpec,
} from "@supbot/shared";

export type ServstationVisibleCapabilityType = "skill" | "mcp";

export interface ServstationVisibleCapability {
  key: string;
  name: string;
  promptName: string;
  idLabel: string;
  description: string;
  capabilityType: ServstationVisibleCapabilityType;
  normalizedName: string;
  normalizedIdLabel: string;
  normalizedDescription: string;
  searchText: string;
}

export function buildEffectiveServstationServices(
  services: ServstationServiceDefinition[],
  localCapabilities: ServstationLocalCapabilityAsset[],
): ServstationServiceDefinition[] {
  const overrides = new Map(
    localCapabilities
      .filter((item) => item.enabled && item.sourceServiceId)
      .map((item) => [item.sourceServiceId || "", item]),
  );
  const effectiveServices = services.map((service) => applyLocalOverride(service, overrides.get(service.serviceId)));
  const localServices = localCapabilities
    .filter((item) => item.enabled && !item.sourceServiceId)
    .map(localCapabilityToService)
    .filter((item): item is ServstationServiceDefinition => Boolean(item));
  return [...effectiveServices, ...localServices];
}

export function buildVisibleServstationCapabilities(
  services: ServstationServiceDefinition[],
): ServstationVisibleCapability[] {
  const items: ServstationVisibleCapability[] = [];
  for (const service of services) {
    const capabilityType = normalizeCapabilityType(service.serviceType);
    if (capabilityType === "skill" || capabilityType === "mcp") {
      const promptName = capabilityPromptName(service, capabilityType);
      items.push(
        createVisibleCapability({
          key: service.serviceId,
          name: service.name,
          promptName,
          idLabel: service.serviceId,
          description: service.description || "",
          capabilityType,
          searchParts: [promptName],
        }),
      );
    }
    if (capabilityType !== "plugin") {
      continue;
    }
    const plugin = service.installSpec?.plugin;
    const mcpEntries = [...(plugin?.mcps || []), ...(plugin?.mcpServers || [])];
    mcpEntries.forEach((entry, index) => {
      const name = (entry.name || "").trim();
      if (!name) {
        return;
      }
      items.push(
        createVisibleCapability({
          key: `${service.serviceId}:mcp:${name}:${index}`,
          name,
          promptName: name,
          idLabel: `${service.serviceId} / ${name}`,
          description: entry.description || service.description || "",
          capabilityType: "mcp",
          searchParts: [service.serviceId, service.name, entry.description || "", service.description || ""],
        }),
      );
    });
    (plugin?.skills || []).forEach((entry, index) => {
      const promptName = (entry.name || "").trim();
      if (!promptName) {
        return;
      }
      const name = entry.displayName?.trim() || promptName;
      items.push(
        createVisibleCapability({
          key: `${service.serviceId}:skill:${promptName}:${index}`,
          name,
          promptName,
          idLabel: `${service.serviceId} / ${promptName}`,
          description: entry.description || service.description || "",
          capabilityType: "skill",
          searchParts: [
            promptName,
            service.serviceId,
            service.name,
            entry.description || "",
            service.description || "",
          ],
        }),
      );
    });
  }
  return items;
}

export function filterVisibleServstationCapabilities(
  items: ServstationVisibleCapability[],
  query: string,
): ServstationVisibleCapability[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    return items;
  }
  return items
    .filter((item) => tokens.every((token) => item.searchText.includes(token)))
    .sort((left, right) => compareCapabilitySearchRank(left, right, tokens));
}

export function formatServstationCapabilityPromptDirective(item: ServstationVisibleCapability): string {
  const name = item.promptName.trim() || item.name.trim() || item.idLabel;
  return item.capabilityType === "mcp" ? `使用MCP:${name}` : `使用skill:${name}`;
}

function applyLocalOverride(
  service: ServstationServiceDefinition,
  asset?: ServstationLocalCapabilityAsset,
): ServstationServiceDefinition {
  if (!asset) {
    return service;
  }
  const name = asset.name.trim() || service.name;
  const description = (asset.description || "").trim() || service.description;
  const serviceWithMetadata = { ...service, name, description };
  const capabilityType = editableCapabilityType(asset.capabilityType);
  if (capabilityType === "prompt-template" && asset.effectivePromptTemplate !== undefined) {
    return { ...serviceWithMetadata, effectivePromptTemplate: asset.effectivePromptTemplate };
  }
  if (capabilityType === "mcp" && asset.mcpServers !== undefined) {
    return {
      ...serviceWithMetadata,
      installSpec: { ...(service.installSpec || {}), mcpServers: asset.mcpServers },
    };
  }
  if (capabilityType === "skill") {
    return {
      ...serviceWithMetadata,
      installSpec: {
        ...(service.installSpec || {}),
        skill: {
          ...(service.installSpec?.skill || {}),
          name: service.installSpec?.skill?.name || asset.name,
          displayName: name,
          description,
          skillMarkdown: asset.skillMarkdown ?? service.installSpec?.skill?.skillMarkdown,
        },
      },
    };
  }
  return serviceWithMetadata;
}

function localCapabilityToService(asset: ServstationLocalCapabilityAsset): ServstationServiceDefinition | null {
  const capabilityType = editableCapabilityType(asset.capabilityType);
  if (!capabilityType) {
    return null;
  }
  return {
    serviceId: asset.assetId,
    name: asset.name,
    description: asset.description || "",
    serviceType: capabilityType,
    status: "local",
    currentVersion: asset.assetKind,
    effectivePromptTemplate: capabilityType === "prompt-template" ? asset.effectivePromptTemplate || "" : "",
    promptTemplateSchema: { inputs: [] },
    installSpec:
      capabilityType === "mcp"
        ? { mcpServers: asset.mcpServers || {} }
        : capabilityType === "skill"
          ? {
              skill: {
                name: asset.name,
                displayName: asset.name,
                description: asset.description || "",
                skillMarkdown: asset.skillMarkdown,
              },
            }
          : {},
  };
}

function createVisibleCapability(input: {
  key: string;
  name: string;
  promptName: string;
  idLabel: string;
  description: string;
  capabilityType: ServstationVisibleCapabilityType;
  searchParts?: string[];
}): ServstationVisibleCapability {
  const normalizedName = input.name.toLowerCase();
  const normalizedIdLabel = input.idLabel.toLowerCase();
  const normalizedDescription = input.description.toLowerCase();
  return {
    ...input,
    normalizedName,
    normalizedIdLabel,
    normalizedDescription,
    searchText: [
      normalizedName,
      normalizedIdLabel,
      normalizedDescription,
      input.promptName.toLowerCase(),
      input.capabilityType,
      ...(input.searchParts || []).map((part) => part.toLowerCase()),
    ].join(" "),
  };
}

function normalizeCapabilityType(value: string | undefined): string {
  const type = (value || "prompt-template").trim().toLowerCase();
  if (type === "cli" || type === "skills") {
    return "skill";
  }
  if (type === "mcps") {
    return "mcp";
  }
  return type;
}

function editableCapabilityType(value: string | undefined): "skill" | "mcp" | "prompt-template" | null {
  const type = normalizeCapabilityType(value);
  return type === "skill" || type === "mcp" || type === "prompt-template" ? type : null;
}

function capabilityPromptName(
  service: ServstationServiceDefinition,
  capabilityType: ServstationVisibleCapabilityType,
): string {
  if (capabilityType === "skill") {
    return (
      service.installSpec?.skill?.displayName?.trim() ||
      service.name.trim() ||
      service.installSpec?.skill?.name?.trim() ||
      service.serviceId
    );
  }
  return service.name.trim() || firstMcpServerName(service.installSpec?.mcpServers) || service.serviceId;
}

function firstMcpServerName(value: ServstationServiceInstallSpec["mcpServers"]): string {
  if (!value) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => entry.name?.trim()).find(Boolean) || "";
  }
  return Object.keys(value).find((name) => name.trim()) || "";
}

function compareCapabilitySearchRank(
  left: ServstationVisibleCapability,
  right: ServstationVisibleCapability,
  tokens: string[],
): number {
  const scoreDiff = capabilitySearchScore(right, tokens) - capabilitySearchScore(left, tokens);
  if (scoreDiff !== 0) {
    return scoreDiff;
  }
  const nameDiff = firstTokenIndex(left.normalizedName, tokens) - firstTokenIndex(right.normalizedName, tokens);
  if (nameDiff !== 0) {
    return nameDiff;
  }
  const idDiff = firstTokenIndex(left.normalizedIdLabel, tokens) - firstTokenIndex(right.normalizedIdLabel, tokens);
  if (idDiff !== 0) {
    return idDiff;
  }
  return left.name.localeCompare(right.name) || left.idLabel.localeCompare(right.idLabel);
}

function capabilitySearchScore(item: ServstationVisibleCapability, tokens: string[]): number {
  return tokens.reduce(
    (total, token) =>
      total +
      capabilityFieldScore(item.normalizedName, token, 200) +
      capabilityFieldScore(item.normalizedIdLabel, token, 120) +
      capabilityFieldScore(item.normalizedDescription, token, 40),
    0,
  );
}

function capabilityFieldScore(value: string, token: string, baseScore: number): number {
  if (!value) {
    return 0;
  }
  if (value === token) {
    return baseScore + 100;
  }
  if (value.startsWith(token)) {
    return baseScore + 80;
  }
  if (hasWordBoundaryMatch(value, token)) {
    return baseScore + 50;
  }
  const index = value.indexOf(token);
  return index >= 0 ? baseScore + Math.max(1, 30 - index) : 0;
}

function hasWordBoundaryMatch(value: string, token: string): boolean {
  return value
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .some((part) => part === token || part.startsWith(token));
}

function firstTokenIndex(value: string, tokens: string[]): number {
  let best = Number.MAX_SAFE_INTEGER;
  for (const token of tokens) {
    const index = value.indexOf(token);
    if (index >= 0 && index < best) {
      best = index;
    }
  }
  return best;
}
