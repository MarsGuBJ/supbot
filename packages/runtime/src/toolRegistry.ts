import type { GeneratedFile, SubagentConfig, ToolCallRecord } from "@supbot/shared";
import type { OpenAiToolDefinition } from "./modelClient";
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
      async execute(input) {
        const parsed = objectInput(input);
        return readLocalFile(requiredString(parsed.path, "path"));
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
          command: { type: "string", description: "Command to execute." }
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
        return shellLocalCommand(requiredString(parsed.command, "command"), context.signal, context.host.shellTimeoutMs, context.host.cwd || context.host.workspacePath);
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
