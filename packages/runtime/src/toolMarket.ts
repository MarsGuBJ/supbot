import type { CapabilityDefinition, ToolMarketCatalogItem, ToolMarketConfig, ToolMarketProduct, ToolMarketProductType, ToolMarketQuery } from "@supbot/shared";

export const localToolMarketProducts: ToolMarketProduct[] = [
  {
    id: "local-files-plus",
    name: "Local Files Plus",
    type: "tool",
    providerName: "Supbot Local",
    description: "Curated file workflows for reading, writing, and tracking generated local artifacts.",
    tags: ["files", "local", "automation"],
    free: true,
    capability: {
      id: "market.tool.local-files-plus",
      name: "Local Files Plus",
      kind: "tool",
      description: "Adds local file workflow templates on top of /read and /write.",
      enabled: true
    },
    commandTemplates: ["/read ", "/write report.txt\n"]
  },
  {
    id: "shell-runner",
    name: "Shell Runner",
    type: "tool",
    providerName: "Supbot Local",
    description: "Run repeatable local shell automation with guarded command templates.",
    tags: ["shell", "automation", "local"],
    free: true,
    capability: {
      id: "market.tool.shell-runner",
      name: "Shell Runner",
      kind: "tool",
      description: "Adds shell command automation templates backed by /shell.",
      enabled: true
    },
    commandTemplates: ["/shell npm test", "/shell git status --short"]
  },
  {
    id: "document-skills",
    name: "Document Skills",
    type: "skill",
    providerName: "Supbot Local",
    description: "Document-oriented workflows for Word, spreadsheet, presentation, and PDF tasks.",
    tags: ["documents", "pdf", "office"],
    free: true,
    capability: {
      id: "market.skill.document-skills",
      name: "Document Skills",
      kind: "skill",
      description: "Adds document workflow prompts for docs, sheets, slides, and PDFs.",
      enabled: true
    },
    commandTemplates: ["Summarize this document: ", "Create a PDF report for: "]
  },
  {
    id: "planner-subagent-kit",
    name: "Planner Subagent Kit",
    type: "plugin",
    providerName: "Supbot Local",
    description: "Planning and review helper prompts for multi-step local agent work.",
    tags: ["planning", "review", "subagents"],
    free: true,
    capability: {
      id: "market.plugin.planner-subagent-kit",
      name: "Planner Subagent Kit",
      kind: "skill",
      description: "Adds planning and review prompt templates for subagent workflows.",
      enabled: true
    },
    commandTemplates: ["@research map the options for ", "@builder implement and verify "]
  },
  {
    id: "local-mcp-bridge",
    name: "Local MCP Bridge",
    type: "mcp",
    providerName: "Supbot Local",
    description: "Open the local MCP server preset and configuration workflow.",
    tags: ["mcp", "adapter", "local", "stdio"],
    free: true,
    capability: {
      id: "market.mcp.local-mcp-bridge",
      name: "Local MCP Bridge",
      kind: "tool",
      description: "Connect local stdio MCP servers through presets, diagnostics, import/export, and permission rules.",
      enabled: true
    },
    commandTemplates: ["Open Config > MCP"]
  }
];

export function listLocalToolMarket(capabilities: CapabilityDefinition[], query: ToolMarketQuery = {}): ToolMarketCatalogItem[] {
  return listToolMarketCatalog(localToolMarketProducts, capabilities, query);
}

export function listToolMarketCatalog(products: ToolMarketProduct[], capabilities: CapabilityDefinition[], query: ToolMarketQuery = {}): ToolMarketCatalogItem[] {
  const installed = new Map(capabilities.map((capability) => [capability.id, capability]));
  const needle = (query.query || "").trim().toLowerCase();
  const type = query.type && query.type !== "all" ? query.type : undefined;
  return products
    .filter((product) => !type || product.type === type)
    .filter((product) => {
      if (!needle) {
        return true;
      }
      return [
        product.name,
        product.providerName,
        product.description,
        product.type,
        ...product.tags
      ].some((value) => value.toLowerCase().includes(needle));
    })
    .map((product) => {
      const capability = installed.get(product.capability.id);
      return {
        ...product,
        origin: product.origin || "local",
        installed: Boolean(capability),
        enabled: capability?.enabled ?? product.capability.enabled,
        capabilityId: product.capability.id
      };
    });
}

export function findLocalToolMarketProduct(productId: string): ToolMarketProduct | undefined {
  return localToolMarketProducts.find((product) => product.id === productId);
}

export async function fetchRemoteToolMarketProducts(
  config: ToolMarketConfig,
  query: ToolMarketQuery = {},
  auth: ToolMarketAuth = {}
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  const cookie = await authenticateToolMarket(config, auth);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...authHeaders(auth.accessToken, cookie)
      }
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(detail || `Tool market request failed with status ${response.status}`);
  }
  const payload = await response.json() as RemoteToolMarketListPayload;
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
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(loginUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...authHeaders(auth.accessToken)
      },
      body: JSON.stringify({ email: auth.email.trim(), password: auth.password })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      throw new Error(detail || `Tool market login failed with status ${response.status}`);
    }
    return readSetCookie(response.headers);
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(accessToken?: string, cookie?: string): Record<string, string> {
  return {
    ...(accessToken?.trim() ? { Authorization: `Bearer ${accessToken.trim()}` } : {}),
    ...(cookie ? { Cookie: cookie } : {})
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
}

function normalizeRemoteMarketProduct(product: RemoteToolMarketProduct): ToolMarketProduct {
  const id = safeText(product.id, "remote-tool");
  const type = normalizeType(product.type);
  const name = safeText(product.name, id);
  const providerName = safeText(product.providerName || product.provider_name || product.provider_id, "ToolsMarket");
  const description = safeText(product.description, "Remote tool market product.");
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
    capability: {
      id: `market.remote.${slug(id)}`,
      name,
      kind: type === "skill" || type === "plugin" ? "skill" : "tool",
      description,
      enabled: true
    }
  };
}

function normalizeType(type: string | undefined): ToolMarketProductType {
  const normalized = (type || "tool").toLowerCase();
  return normalized === "mcp" || normalized === "plugin" || normalized === "skill" || normalized === "tool" ? normalized : "tool";
}

function normalizeTags(tags: unknown, type: ToolMarketProductType): string[] {
  if (Array.isArray(tags)) {
    return tags.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()).slice(0, 5);
  }
  return ["remote", type];
}

function isRemoteProductFree(product: RemoteToolMarketProduct): boolean {
  return product.billing_mode === "free" || product.unit_price_cents === 0 || typeof product.unit_price_cents === "undefined";
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

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "remote-tool";
}
