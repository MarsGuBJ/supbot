import type {
  CapabilityDefinition,
  ToolMarketCatalogItem,
  ToolMarketConfig,
  ToolMarketLocalDeployment,
  ToolMarketMcpDeployment,
  ToolMarketPackageFile,
  ToolMarketProduct,
  ToolMarketProductType,
  ToolMarketQuery,
} from "@supbot/shared";

const toolMarketRequestTimeoutMs = 8000;

export const localToolMarketProducts: ToolMarketProduct[] = [
  {
    id: "local-files-plus",
    name: "Local Files Plus",
    type: "tool",
    providerName: "HBClient Local",
    description: "Curated file workflows for reading, writing, and tracking generated local artifacts.",
    tags: ["files", "local", "automation"],
    free: true,
    capability: {
      id: "market.tool.local-files-plus",
      name: "Local Files Plus",
      kind: "tool",
      description: "Adds local file workflow templates on top of /read and /write.",
      enabled: true,
    },
    commandTemplates: ["/read ", "/write report.txt\n"],
    localDeployment: {
      kind: "tool",
      commandTemplates: ["/read ", "/write report.txt\n"],
    },
  },
  {
    id: "shell-runner",
    name: "Shell Runner",
    type: "tool",
    providerName: "HBClient Local",
    description: "Run repeatable local shell automation with guarded command templates.",
    tags: ["shell", "automation", "local"],
    free: true,
    capability: {
      id: "market.tool.shell-runner",
      name: "Shell Runner",
      kind: "tool",
      description: "Adds shell command automation templates backed by /shell.",
      enabled: true,
    },
    commandTemplates: ["/shell npm test", "/shell git status --short"],
    localDeployment: {
      kind: "tool",
      commandTemplates: ["/shell npm test", "/shell git status --short"],
    },
  },
  {
    id: "document-skills",
    name: "Document Skills",
    type: "skill",
    providerName: "HBClient Local",
    description: "Document-oriented workflows for Word, spreadsheet, presentation, and PDF tasks.",
    tags: ["documents", "pdf", "office"],
    free: true,
    capability: {
      id: "market.skill.document-skills",
      name: "Document Skills",
      kind: "skill",
      description: "Adds document workflow prompts for docs, sheets, slides, and PDFs.",
      enabled: true,
    },
    commandTemplates: ["Summarize this document: ", "Create a PDF report for: "],
    localDeployment: {
      kind: "skill",
      commandTemplates: ["Summarize this document: ", "Create a PDF report for: "],
    },
  },
  {
    id: "planner-subagent-kit",
    name: "Planner Subagent Kit",
    type: "plugin",
    providerName: "HBClient Local",
    description: "Planning and review helper prompts for multi-step local agent work.",
    tags: ["planning", "review", "subagents"],
    free: true,
    capability: {
      id: "market.plugin.planner-subagent-kit",
      name: "Planner Subagent Kit",
      kind: "plugin",
      description: "Adds planning and review prompt templates for subagent workflows.",
      enabled: true,
    },
    commandTemplates: ["@research map the options for ", "@builder implement and verify "],
    localDeployment: {
      kind: "plugin",
      commandTemplates: ["@research map the options for ", "@builder implement and verify "],
    },
  },
  {
    id: "local-mcp-bridge",
    name: "Local MCP Bridge",
    type: "mcp",
    providerName: "HBClient Local",
    description: "Open the local MCP server preset and configuration workflow.",
    tags: ["mcp", "adapter", "local", "stdio"],
    free: true,
    capability: {
      id: "market.mcp.local-mcp-bridge",
      name: "Local MCP Bridge",
      kind: "mcp",
      description: "Connect local stdio MCP servers through presets, diagnostics, import/export, and permission rules.",
      enabled: true,
    },
    commandTemplates: ["Open Config > MCP"],
    localDeployment: {
      kind: "mcp",
      commandTemplates: ["Open Config > MCP"],
    },
  },
];

export function listLocalToolMarket(
  capabilities: CapabilityDefinition[],
  query: ToolMarketQuery = {},
): ToolMarketCatalogItem[] {
  return listToolMarketCatalog(localToolMarketProducts, capabilities, query);
}

export function listToolMarketCatalog(
  products: ToolMarketProduct[],
  capabilities: CapabilityDefinition[],
  query: ToolMarketQuery = {},
): ToolMarketCatalogItem[] {
  const installed = new Map(capabilities.map((capability) => [capability.id, capability]));
  const needle = (query.query || "").trim().toLowerCase();
  const type = query.type && query.type !== "all" ? query.type : undefined;
  return products
    .filter((product) => !type || product.type === type)
    .filter((product) => {
      if (!needle) {
        return true;
      }
      return [product.name, product.providerName, product.description, product.type, ...product.tags].some((value) =>
        value.toLowerCase().includes(needle),
      );
    })
    .map((product) => {
      const capability = installed.get(product.capability.id);
      return {
        ...product,
        origin: product.origin || "local",
        installed: Boolean(capability),
        enabled: capability?.enabled ?? product.capability.enabled,
        capabilityId: product.capability.id,
      };
    });
}

export function findLocalToolMarketProduct(productId: string): ToolMarketProduct | undefined {
  return localToolMarketProducts.find((product) => product.id === productId);
}

export async function fetchRemoteToolMarketProducts(
  config: ToolMarketConfig,
  query: ToolMarketQuery = {},
  auth: ToolMarketAuth = {},
): Promise<ToolMarketProduct[]> {
  if (!config.apiUrl.trim()) {
    return [];
  }
  const url = new URL(normalizeMarketApiUrl(config.apiUrl.trim()));
  if (query.query?.trim()) {
    url.searchParams.set("query", query.query.trim());
  }
  if (query.type && query.type !== "all") {
    url.searchParams.set("type", query.type);
  }
  const cookie = await authenticateToolMarket(config, auth);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), toolMarketRequestTimeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...authHeaders(auth.accessToken, cookie),
      },
    });
  } catch (error) {
    throw toolMarketConnectionError(error, url, "request");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw await toolMarketHttpError(response, "request");
  }
  let payload: RemoteToolMarketListPayload;
  try {
    payload = (await response.json()) as RemoteToolMarketListPayload;
  } catch {
    throw new Error("Tool market request failed: catalog API returned invalid JSON.");
  }
  const items = Array.isArray(payload) ? payload : Array.isArray(payload.items) ? payload.items : [];
  return items.map(normalizeRemoteMarketProduct);
}

export interface ToolMarketAuth {
  accessToken?: string;
  email?: string;
  password?: string;
}

async function authenticateToolMarket(config: ToolMarketConfig, auth: ToolMarketAuth): Promise<string | undefined> {
  if (!auth.email?.trim() || !auth.password?.trim()) {
    return undefined;
  }
  const loginUrl = new URL(normalizeMarketApiUrl(config.apiUrl));
  loginUrl.searchParams.set("action", "login");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), toolMarketRequestTimeoutMs);
  try {
    const response = await fetch(loginUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...authHeaders(auth.accessToken),
      },
      body: JSON.stringify({ email: auth.email.trim(), password: auth.password }),
    });
    if (!response.ok) {
      throw await toolMarketHttpError(response, "login");
    }
    return readSetCookie(response.headers);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Tool market ")) {
      throw error;
    }
    throw toolMarketConnectionError(error, loginUrl, "login");
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(accessToken?: string, cookie?: string): Record<string, string> {
  return {
    ...(accessToken?.trim() ? { Authorization: `Bearer ${accessToken.trim()}` } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

function readSetCookie(headers: Headers): string | undefined {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  const cookies = getSetCookie?.length ? getSetCookie : [headers.get("set-cookie") || ""];
  const pairs = cookies
    .filter(Boolean)
    .map((cookie) => cookie.split(";", 1)[0])
    .filter(Boolean);
  return pairs.length ? pairs.join("; ") : undefined;
}

async function toolMarketHttpError(response: Response, phase: "login" | "request"): Promise<Error> {
  const detailText = await response.text().catch(() => response.statusText);
  const detail = parseMarketErrorDetail(detailText) || response.statusText || `HTTP ${response.status}`;
  if (phase === "login") {
    return new Error(`Tool market login failed: ${detail}`);
  }
  if (response.status === 401 || response.status === 403) {
    return new Error(`Tool market requires a valid subscriber login: ${detail}`);
  }
  return new Error(`Tool market request failed (${response.status}): ${detail}`);
}

function toolMarketConnectionError(error: unknown, url: URL, phase: "login" | "request"): Error {
  const original = error as Error & { cause?: { code?: string; message?: string } };
  if (original.name === "AbortError") {
    return new Error(`Tool market ${phase} timed out while contacting ${url.origin}.`);
  }
  const reason = original.cause?.code || original.cause?.message;
  return new Error(`Tool market ${phase} failed while contacting ${url.origin}${reason ? ` (${reason})` : ""}.`);
}

function parseMarketErrorDetail(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const payload = JSON.parse(trimmed) as { error?: { message?: unknown }; message?: unknown };
    if (typeof payload.error?.message === "string" && payload.error.message.trim()) {
      return payload.error.message.trim();
    }
    if (typeof payload.message === "string" && payload.message.trim()) {
      return payload.message.trim();
    }
  } catch {
    // Plain text error bodies are fine.
  }
  return trimmed.slice(0, 400);
}

export function normalizeMarketApiUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "") {
    url.pathname = "/subscriber/market/api";
  } else if (path === "/subscriber" || path === "/subscriber/market") {
    url.pathname = `${path}/api`;
  }
  return url.toString();
}

export function findMarketProduct(products: ToolMarketProduct[], productId: string): ToolMarketProduct | undefined {
  return products.find((product) => product.id === productId);
}

type RemoteToolMarketListPayload = RemoteToolMarketProduct[] | { items?: RemoteToolMarketProduct[] };

interface RemoteToolMarketProduct {
  id?: string;
  name?: string;
  type?: string;
  providerName?: string;
  provider_name?: string;
  provider_id?: string;
  description?: string;
  tags?: unknown;
  billing_mode?: string;
  unit_price_cents?: number;
  unit_label?: string;
  priceLabel?: string;
  purchased?: boolean;
  subscription_id?: string;
  source_health?: string;
  serviceId?: string;
  capability?: unknown;
  commandTemplates?: unknown;
  command_templates?: unknown;
  localDeployment?: unknown;
  local_deployment?: unknown;
  deployment?: unknown;
  install?: unknown;
  package?: unknown;
  files?: unknown;
  mcpServer?: unknown;
  mcp_server?: unknown;
}

function normalizeRemoteMarketProduct(product: RemoteToolMarketProduct): ToolMarketProduct {
  const id = safeText(product.id, "remote-tool");
  const type = normalizeType(product.type);
  const name = safeText(product.name, id);
  const providerName = safeText(product.providerName || product.provider_name || product.provider_id, "ToolsMarket");
  const description = safeText(product.description, "Remote tool market product.");
  const capability = normalizeRemoteCapability(product.capability, {
    id: `market.remote.${slug(id)}`,
    name,
    kind: type === "plugin" || type === "mcp" ? type : type === "skill" ? "skill" : "tool",
    description,
    enabled: true,
  });
  const localDeployment = normalizeRemoteLocalDeployment(product, type, capability);
  return {
    id,
    name,
    type,
    origin: "remote",
    providerName,
    description,
    tags: normalizeTags(product.tags, type),
    free: isRemoteProductFree(product),
    priceLabel: product.priceLabel || formatRemotePrice(product),
    purchased: product.purchased === true || Boolean(product.subscription_id),
    sourceHealth: product.source_health,
    capability: localDeployment.capability || capability,
    commandTemplates: localDeployment.commandTemplates,
    localDeployment,
  };
}

function normalizeRemoteCapability(value: unknown, fallback: CapabilityDefinition): CapabilityDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const input = value as Partial<CapabilityDefinition>;
  return {
    id: safeText(input.id, fallback.id),
    name: safeText(input.name, fallback.name),
    kind: normalizeCapabilityKind(input.kind, fallback.kind),
    description: safeText(input.description, fallback.description),
    enabled: input.enabled !== false,
  };
}

function normalizeRemoteLocalDeployment(
  product: RemoteToolMarketProduct,
  type: ToolMarketProductType,
  capability: CapabilityDefinition,
): ToolMarketLocalDeployment {
  const source = (objectValue(product.localDeployment) ||
    objectValue(product.local_deployment) ||
    objectValue(product.deployment) ||
    objectValue(product.install) ||
    objectValue(product.package) ||
    objectValue(product)) as Record<string, unknown>;
  const deploymentKind = normalizeType(stringValue(source.kind) || stringValue(source.type) || type);
  const commandTemplates = normalizeStringArray(
    source.commandTemplates || source.command_templates || product.commandTemplates || product.command_templates,
  );
  const files = normalizePackageFiles(source.files || product.files);
  const mcpServer = normalizeMcpDeployment(
    source.mcpServer || source.mcp_server || product.mcpServer || product.mcp_server,
  );
  const deploymentCapability = normalizeRemoteCapability(source.capability || product.capability, capability);
  return {
    kind: deploymentKind,
    ...(files.length ? { files } : {}),
    capability: deploymentCapability,
    ...(mcpServer ? { mcpServer } : {}),
    ...(commandTemplates.length ? { commandTemplates } : {}),
  };
}

function normalizeCapabilityKind(value: unknown, fallback: CapabilityDefinition["kind"]): CapabilityDefinition["kind"] {
  return value === "skill" ||
    value === "tool" ||
    value === "plugin" ||
    value === "mcp" ||
    value === "subagent" ||
    value === "scheduler" ||
    value === "storage"
    ? value
    : fallback;
}

function normalizePackageFiles(value: unknown): ToolMarketPackageFile[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const files: ToolMarketPackageFile[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const file = item as Partial<ToolMarketPackageFile>;
    const path = safeText(file.path, "");
    const content = typeof file.content === "string" ? file.content : undefined;
    if (!path || typeof content !== "string") {
      continue;
    }
    files.push({
      path,
      content,
      encoding: file.encoding === "base64" ? "base64" : "utf8",
    });
  }
  return files;
}

function normalizeMcpDeployment(value: unknown): ToolMarketMcpDeployment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Partial<ToolMarketMcpDeployment>;
  const name = safeText(input.name, "");
  const command = safeText(input.command, "");
  if (!name || !command) {
    return undefined;
  }
  return {
    ...(typeof input.id === "string" && input.id.trim() ? { id: input.id.trim() } : {}),
    name,
    command,
    args: Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === "string") : [],
    cwd: typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : undefined,
    env: normalizeEnv(input.env),
    requestTimeoutMs: typeof input.requestTimeoutMs === "number" ? input.requestTimeoutMs : undefined,
    enabled: input.enabled !== false,
    autoConnect: Boolean(input.autoConnect),
  };
}

function normalizeEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .filter(([key, entry]) => key.trim() && typeof entry === "string")
    .map(([key, entry]) => [key.trim(), entry as string]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function normalizeType(type: string | undefined): ToolMarketProductType {
  const normalized = (type || "tool").toLowerCase();
  return normalized === "mcp" || normalized === "plugin" || normalized === "skill" || normalized === "tool"
    ? normalized
    : "tool";
}

function normalizeTags(tags: unknown, type: ToolMarketProductType): string[] {
  if (Array.isArray(tags)) {
    return tags
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim())
      .slice(0, 5);
  }
  return ["remote", type];
}

function isRemoteProductFree(product: RemoteToolMarketProduct): boolean {
  return (
    product.billing_mode === "free" || product.unit_price_cents === 0 || typeof product.unit_price_cents === "undefined"
  );
}

function formatRemotePrice(product: RemoteToolMarketProduct): string {
  if (isRemoteProductFree(product)) {
    return "Free";
  }
  if (typeof product.unit_price_cents === "number") {
    const label = product.unit_label ? `/${product.unit_label}` : "";
    return `$${(product.unit_price_cents / 100).toFixed(2)}${label}`;
  }
  return product.billing_mode || "Paid";
}

function safeText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "remote-tool"
  );
}
