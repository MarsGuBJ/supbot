import { isAbsolute, resolve } from "node:path";
import type { ToolMarketLocalDeployment, ToolMarketMcpDeployment, ToolMarketProduct } from "@supbot/shared";
import { pathIsInside } from "./pathUtils";

/** Tool-market install policy and normalization kept separate from runtime orchestration. */
export function resolveToolMarketPackagePath(root: string, filePath: string): string {
  if (isAbsolute(filePath)) {
    throw new Error(`Tool market package file must be relative: ${filePath}`);
  }
  const target = resolve(root, filePath);
  if (!pathIsInside(root, target)) {
    throw new Error(`Tool market package file escapes install directory: ${filePath}`);
  }
  return target;
}

export function defaultLocalDeployment(product: ToolMarketProduct): ToolMarketLocalDeployment {
  return {
    kind: product.type,
    capability: product.capability,
    commandTemplates: product.commandTemplates || []
  };
}

export function localToolDirName(kind: ToolMarketProduct["type"]): string {
  switch (kind) {
    case "skill":
      return "skills";
    case "plugin":
      return "plugins";
    case "mcp":
      return "mcp";
    default:
      return "tools";
  }
}

export function uniqueMarketProducts(products: ToolMarketProduct[]): ToolMarketProduct[] {
  const byId = new Map<string, ToolMarketProduct>();
  for (const product of products) byId.set(product.id, product);
  return [...byId.values()];
}

export function marketMcpServerId(product: ToolMarketProduct, input: ToolMarketMcpDeployment): string {
  return sanitizeMarketId(input.id || `market-${product.id}`);
}

export function marketInstallSlug(value: string): string {
  return sanitizeMarketId(value);
}

export function materializeInstallPath(value: string, installPath: string): string {
  return value.replace(/\{(?:installDir|productDir)\}/g, installPath);
}

export function normalizeMarketMcpTimeout(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(120_000, Math.max(1_000, Math.round(value)));
}

function sanitizeMarketId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "market-tool";
}
