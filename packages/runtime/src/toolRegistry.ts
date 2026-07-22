import { isAbsolute, resolve } from "node:path";
import type { GeneratedFile, LocalPackageInspection, LocalPackageInstallResult, SubagentConfig, ToolCallRecord } from "@supbot/shared";
import type { OpenAiToolDefinition } from "./modelAdapter";
import { readLocalFile, shellLocalCommand, writeLocalFile, type LocalToolHost } from "./localTools";

export type ToolRisk = "read" | "dangerous";

export type ToolConcurrency = "safe" | "exclusive";

export type ToolInterruptBehavior = "cancel" | "block";

export interface ToolExecutionResult {
  text: string;
  generatedFiles?: GeneratedFile[];
  outputParts?: ToolCallRecord["outputParts"];
  outputTruncated?: boolean;
}

export interface ToolExecutionContext {
  signal: AbortSignal;
  host: LocalToolHost;
  workspaceMode?: "main" | "isolated" | "readOnly";
  projectId?: string;
  projectRoot?: string;
  allowedWriteRoots?: string[];
  ensureIsolatedWorkspace?(toolName: string): Promise<LocalToolHost | undefined>;
  allowedAttachmentPaths?: string[];
  inspectPackageArchive?(input: { path: string }): Promise<LocalPackageInspection>;
  installPackageArchive?(input: { path: string; expectedSha256: string }): Promise<LocalPackageInstallResult>;
  subagents: SubagentConfig[];
  runSubagent(input: { subagentType?: string; prompt: string; signal: AbortSignal }): Promise<ToolExecutionResult>;
}

export interface ToolDefinition {
  name: string;
  modelName?: string;
  description: string;
  risk: ToolRisk;
  concurrency: ToolConcurrency;
  interruptBehavior: ToolInterruptBehavior;
  usesWorkspace?: boolean;
  parameters: OpenAiToolDefinition["function"]["parameters"];
  validationError?: string;
  summarize(input: unknown): string;
  execute(input: unknown, context: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export interface ToolProvider {
  list(): ToolDefinition[];
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly providers: ToolProvider[] = [];

  constructor(definitions: ToolDefinition[] = defaultToolDefinitions(), providers: ToolProvider[] = []) {
    for (const tool of definitions) {
      this.tools.set(tool.name, tool);
    }
    this.providers = providers;
  }

  list(): ToolDefinition[] {
    return [
      ...this.tools.values(),
      ...this.providers.flatMap((provider) => provider.list())
    ];
  }

  get(name: string): ToolDefinition | undefined {
    return this.list().find((tool) => tool.name === name || tool.modelName === name);
  }

  publicName(name: string): string {
    return this.get(name)?.name || name;
  }

  addProvider(provider: ToolProvider): void {
    this.providers.push(provider);
  }

  toOpenAiTools(): OpenAiToolDefinition[] {
    return this.list().map((tool) => ({
      type: "function",
      function: {
        name: tool.modelName || tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
  }
}

export function defaultToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "InspectPackageArchive",
      description: "Inspect an uploaded ZIP package archive before installation. Supports Skill, Plugin, and MCP packages.",
      risk: "read",
      concurrency: "safe",
      interruptBehavior: "cancel",
      usesWorkspace: false,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to a ZIP file uploaded in the current conversation." }
        },
        required: ["path"],
        additionalProperties: false
      },
      summarize(input) {
        const parsed = objectInput(input);
        return `Inspect package ${String(parsed.path || "")}`;
      },
      async execute(input, context) {
        const parsed = objectInput(input);
        if (!context.inspectPackageArchive) {
          throw new Error("Package archive inspection is not available in this runtime.");
        }
        const result = await context.inspectPackageArchive({ path: requiredString(parsed.path, "path") });
        return {
          text: formatPackageInspection(result)
        };
      }
    },
    {
      name: "InstallPackageArchive",
      description: "Install an inspected uploaded ZIP package archive into the app data directory, replacing an existing package with the same id atomically. Requires the SHA-256 from InspectPackageArchive.",
      risk: "dangerous",
      concurrency: "exclusive",
      interruptBehavior: "block",
      usesWorkspace: false,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to a ZIP file uploaded in the current conversation." },
          expectedSha256: { type: "string", description: "SHA-256 returned by InspectPackageArchive." }
        },
        required: ["path", "expectedSha256"],
        additionalProperties: false
      },
      summarize(input) {
        const parsed = objectInput(input);
        return `Install package ${String(parsed.path || "")}`;
      },
      async execute(input, context) {
        const parsed = objectInput(input);
        if (!context.installPackageArchive) {
          throw new Error("Package archive installation is not available in this runtime.");
        }
        const result = await context.installPackageArchive({
          path: requiredString(parsed.path, "path"),
          expectedSha256: requiredString(parsed.expectedSha256, "expectedSha256")
        });
        return {
          text: formatPackageInstallResult(result)
        };
      }
    },
    {
      name: "ReadFile",
      description: "Read a local UTF-8 text file.",
      risk: "read",
      concurrency: "safe",
      interruptBehavior: "cancel",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path to the file to read." }
        },
        required: ["path"],
        additionalProperties: false
      },
      summarize(input) {
        const parsed = objectInput(input);
        return `Read ${String(parsed.path || "")}`;
      },
      async execute(input, context) {
        const parsed = objectInput(input);
        const filePath = requiredString(parsed.path, "path");
        return readLocalFile(context.projectRoot && !isAbsolute(filePath) ? resolve(context.projectRoot, filePath) : filePath);
      }
    },
    {
      name: "WriteFile",
      description: "Write UTF-8 text to a local file. Relative paths are written under the app generated-files directory.",
      risk: "dangerous",
      concurrency: "exclusive",
      interruptBehavior: "block",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Target file path or generated file name." },
          content: { type: "string", description: "UTF-8 text content to write." }
        },
        required: ["path", "content"],
        additionalProperties: false
      },
      summarize(input) {
        const parsed = objectInput(input);
        return `Write ${String(parsed.path || "")}`;
      },
      async execute(input, context) {
        const parsed = objectInput(input);
        return writeLocalFile(requiredString(parsed.path, "path"), requiredString(parsed.content, "content"), context.host);
      }
    },
    {
      name: "Shell",
      description: "Run a local shell command. On Windows this uses PowerShell.",
      risk: "dangerous",
      concurrency: "exclusive",
      interruptBehavior: "cancel",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to execute." },
          timeoutMs: { type: "number", description: "Optional timeout in milliseconds, between 1000 and 300000." }
        },
        required: ["command"],
        additionalProperties: false
      },
      summarize(input) {
        const parsed = objectInput(input);
        return `Shell ${String(parsed.command || "").slice(0, 120)}`;
      },
      async execute(input, context) {
        const parsed = objectInput(input);
        return shellLocalCommand(
          requiredString(parsed.command, "command"),
          context.signal,
          normalizeTimeoutMs(parsed.timeoutMs, context.host.shellTimeoutMs),
          context.host.cwd || context.host.workspacePath
        );
      }
    },
    {
      name: "Agent",
      description: "Run a configured subagent on a focused prompt and return its concise result.",
      risk: "dangerous",
      concurrency: "exclusive",
      interruptBehavior: "block",
      parameters: {
        type: "object",
        properties: {
          subagent_type: { type: "string", description: "Subagent id or name, such as research or builder." },
          prompt: { type: "string", description: "Task for the subagent." }
        },
        required: ["prompt"],
        additionalProperties: false
      },
      summarize(input) {
        const parsed = objectInput(input);
        const subagentType = typeof parsed.subagent_type === "string" ? parsed.subagent_type : "default";
        return `Run @${subagentType}: ${String(parsed.prompt || "").slice(0, 100)}`;
      },
      async execute(input, context) {
        const parsed = objectInput(input);
        return context.runSubagent({
          subagentType: typeof parsed.subagent_type === "string" ? parsed.subagent_type : undefined,
          prompt: requiredString(parsed.prompt, "prompt"),
          signal: context.signal
        });
      }
    }
  ];
}

export function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  return input as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function normalizeTimeoutMs(value: unknown, fallback = 60_000): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1_000, Math.min(300_000, Math.round(value)));
}

function formatPackageInspection(result: LocalPackageInspection): string {
  return [
    `Package inspection: ${result.name}`,
    `Kind: ${result.kind}`,
    result.version ? `Version: ${result.version}` : "",
    `Id: ${result.id}`,
    `SHA-256: ${result.sha256}`,
    `Install path: ${result.installPath}`,
    result.rootPrefix ? `Wrapper directory: ${result.rootPrefix}` : "",
    result.description ? `Description: ${result.description}` : "",
    result.skills.length ? `Skills:\n${result.skills.map((skill) => `- ${skill.name} (${skill.capabilityId})\n  ${skill.description}\n  ${skill.path}`).join("\n")}` : "Skills: none",
    result.mcpServers.length ? `MCP servers:\n${result.mcpServers.map((server) => `- ${server.name}${server.skipped ? " [skipped]" : ""}${server.serverId ? ` (${server.serverId})` : ""}${server.reason ? `\n  ${server.reason}` : ""}${server.command ? `\n  ${server.command} ${(server.args || []).join(" ")}` : ""}`).join("\n")}` : "MCP servers: none",
    result.dependencyPlan.length ? `Dependency plan:\n${result.dependencyPlan.map((step) => `- ${step.manager}: ${step.command} ${step.args.join(" ")}\n  cwd: ${step.cwd}\n  reason: ${step.reason}`).join("\n")}` : "Dependency plan: none",
    result.warnings.length ? `Warnings:\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}` : "",
    "Call InstallPackageArchive with this exact SHA-256 after the user approves installation."
  ].filter(Boolean).join("\n");
}

function formatPackageInstallResult(result: LocalPackageInstallResult): string {
  return [
    `Installed package: ${result.name}`,
    `Kind: ${result.kind}`,
    result.version ? `Version: ${result.version}` : "",
    `Id: ${result.id}`,
    `SHA-256: ${result.sha256}`,
    `Install path: ${result.installPath}`,
    `Replaced existing package: ${result.replaced ? "yes" : "no"}`,
    result.capabilityIds.length ? `Capabilities: ${result.capabilityIds.join(", ")}` : "",
    result.activatedMcpServerIds.length ? `Activated MCP servers: ${result.activatedMcpServerIds.join(", ")}` : "",
    result.dependencyResults.length ? `Dependency installs:\n${result.dependencyResults.map((step) => `- ${step.manager}: exit ${step.exitCode}\n  ${step.command} ${step.args.join(" ")}\n  cwd: ${step.cwd}`).join("\n")}` : "Dependency installs: none",
    result.warnings.length ? `Warnings:\n${result.warnings.map((warning) => `- ${warning}`).join("\n")}` : "",
    result.skills.length ? `Installed skills:\n${result.skills.map((skill) => `- ${skill.name} (${skill.capabilityId})\n  ${skill.path}`).join("\n")}` : "",
    result.skillContext ? `\nInstalled skill instructions available now:\n${result.skillContext}` : ""
  ].filter(Boolean).join("\n");
}
