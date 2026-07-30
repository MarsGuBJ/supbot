import type { ToolMarketCatalogItem, ToolMarketProductType } from "@supbot/shared";
import type { InstallResolution } from "./installResolver";
import { resolveInstallSource } from "./installResolver";
import { shortDigest } from "./installSafety";
import type { OpenAiToolDefinition } from "./modelAdapter";
import { objectInput } from "./toolRegistry";
import type { ToolDefinition, ToolProvider } from "./toolRegistry";

export interface PromptInstallProviderOptions {
  installResolution: (resolution: InstallResolution) => Promise<ToolMarketCatalogItem>;
}

interface PromptInstallInput {
  source: string;
  product_id?: string;
  kind?: ToolMarketProductType;
}

export class PromptInstallProvider implements ToolProvider {
  constructor(private readonly options: PromptInstallProviderOptions) {}

  list(): ToolDefinition[] {
    return [
      this.buildDefinition("install_skill", "skill", "Install a local skill from a prompt-supplied source."),
      this.buildDefinition("install_plugin", "plugin", "Install a local plugin from a prompt-supplied source."),
      this.buildDefinition("install_mcp", "mcp", "Register a local MCP server from a prompt-supplied source.")
    ];
  }

  private buildDefinition(name: string, kind: ToolMarketProductType, description: string): ToolDefinition {
    return {
      name,
      description,
      risk: "dangerous",
      concurrency: "exclusive",
      interruptBehavior: "block",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "GitHub repo URL, zip URL, local file/directory path, or pasted markdown / JSON manifest."
          },
          product_id: {
            type: "string",
            description: "Optional override for the resulting tool-market product id (alphanumeric, '-', '_')."
          },
          kind: {
            type: "string",
            enum: ["tool", "skill", "plugin", "mcp"],
            description: "Optional explicit product kind. When omitted, inferred from the source manifest."
          }
        },
        required: ["source"],
        additionalProperties: false
      } satisfies OpenAiToolDefinition["function"]["parameters"],
      summarize(input: unknown): string {
        const parsed = objectInput(input);
        const source = String(parsed.source || "").trim();
        const explicitKind = typeof parsed.kind === "string" ? parsed.kind : kind;
        return `Install ${explicitKind} from ${source.length > 120 ? `${source.slice(0, 117)}...` : source}`;
      },
      execute: (input: unknown) => this.executeInstall(kind, input)
    };
  }

  private async executeInstall(kind: ToolMarketProductType, input: unknown) {
    const parsed = parseInput(input);
    const resolution = await resolveInstallSource(parsed.source, {
      kindHint: parsed.kind || kind,
      productIdHint: parsed.product_id
    });
    assertKindMatches(kind, resolution);
    const summary = describeResolution(resolution);
    const installed = await this.options.installResolution(resolution);
    const payload = `${summary}\nInstalled as \`${installed.name}\` (${installed.id}).`;
    return { text: payload };
  }
}

function parseInput(input: unknown): PromptInstallInput {
  const parsed = objectInput(input);
  const source = typeof parsed.source === "string" ? parsed.source.trim() : "";
  if (!source) {
    throw new Error("Install tool requires a non-empty `source` parameter.");
  }
  const productId = typeof parsed.product_id === "string" && parsed.product_id.trim() ? parsed.product_id.trim() : undefined;
  const kind = typeof parsed.kind === "string" ? parsed.kind as ToolMarketProductType : undefined;
  return { source, product_id: productId, kind };
}

function assertKindMatches(expected: ToolMarketProductType, resolution: InstallResolution): void {
  if (resolution.product.type !== expected) {
    throw new Error(
      `Resolved install is a ${resolution.product.type} but the agent requested ${expected}. ` +
      `Pass kind="${resolution.product.type}" or use the matching install_* tool.`
    );
  }
}

function describeResolution(resolution: InstallResolution): string {
  const product = resolution.product;
  const files = resolution.deployment.files || [];
  const fileSummaries = files.slice(0, 5).map((file) => `  - ${file.path} (${Buffer.byteLength(file.content, "utf8")} bytes)`).join("\n");
  const overflow = files.length > 5 ? `\n  - … ${files.length - 5} more files` : "";
  const totalBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
  const sourceLabel = resolution.source.url || resolution.source.localPath || "pasted markdown";
  const sha = resolution.archiveSha256 ? shortDigest(resolution.archiveSha256, 16) : "(inline)";
  return [
    `Install plan for ${product.name} (${product.type})`,
    `  source: ${sourceLabel}`,
    `  files: ${files.length} (${totalBytes} bytes)`,
    fileSummaries ? `  top files:\n${fileSummaries}${overflow}` : "",
    `  sha256: ${sha}`
  ].filter(Boolean).join("\n");
}