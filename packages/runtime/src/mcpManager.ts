import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  McpConnectionState,
  McpConfigTransfer,
  McpDiagnosticResult,
  McpImportResult,
  McpLogRecord,
  McpServerConfig,
  McpServerInput,
  McpServerPreset,
  McpServerSnapshot,
  McpServerStatus,
  McpServerUpdate,
  McpToolInfo,
  ToolCallRecord,
} from "@supbot/shared";
import { nowIso } from "@supbot/shared";
import { inspectJsonSchema } from "./jsonSchema";
import type { ToolDefinition, ToolExecutionContext, ToolExecutionResult, ToolProvider } from "./toolRegistry";

type McpJsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

type McpJsonRpcResponse = {
  jsonrpc?: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type McpToolPayload = {
  name?: string;
  description?: string;
  inputSchema?: unknown;
};

class McpProtocolError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpProtocolError";
  }
}

interface McpManagerHost {
  randomId(prefix: string): string;
  nowIso(): string;
  onEvent?(event: { kind: "mcp_server"; message: string; serverId?: string; data?: unknown }): void | Promise<void>;
}

interface McpConnection {
  config: McpServerConfig;
  process?: ChildProcessWithoutNullStreams;
  status: McpServerStatus;
  tools: McpToolInfo[];
  pending: Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >;
  buffer: Buffer;
  nextRequestId: number;
  manualDisconnect: boolean;
  protocolVersion?: string;
  capabilities?: unknown;
}

export class McpManager implements ToolProvider {
  private servers: McpServerConfig[] = [];
  private readonly connections = new Map<string, McpConnection>();
  private readonly logs = new Map<string, McpLogRecord[]>();

  constructor(private readonly host: McpManagerHost) {}

  setServers(servers: McpServerConfig[]): void {
    this.servers = servers.map(cloneServer);
    const ids = new Set(this.servers.map((server) => server.id));
    for (const serverId of [...this.connections.keys()]) {
      if (!ids.has(serverId)) {
        void this.disconnect(serverId);
      }
    }
    for (const server of this.servers) {
      const existing = this.connections.get(server.id);
      if (existing) {
        existing.config = cloneServer(server);
      } else {
        this.connections.set(server.id, createDisconnectedConnection(server, this.host.nowIso()));
      }
    }
  }

  snapshot(): { mcpServers: McpServerSnapshot[]; mcpTools: McpToolInfo[] } {
    return {
      mcpServers: this.servers.map((server) => {
        const connection = this.connectionFor(server.id);
        return {
          ...cloneServer(server),
          status: { ...connection.status },
        };
      }),
      mcpTools: this.listToolInfos(),
    };
  }

  listToolInfos(): McpToolInfo[] {
    return [...this.connections.values()].flatMap((connection) => connection.tools.map((tool) => ({ ...tool })));
  }

  getLogs(serverId: string): McpLogRecord[] {
    this.connectionFor(serverId);
    return [...(this.logs.get(serverId) || [])];
  }

  list(): ToolDefinition[] {
    return [...this.connections.values()].flatMap((connection) =>
      connection.tools.map((tool) => this.toToolDefinition(connection, tool)),
    );
  }

  async autoConnectEnabled(): Promise<void> {
    await Promise.all(
      this.servers
        .filter((server) => server.enabled && server.autoConnect)
        .map((server) => this.connect(server.id).catch(() => undefined)),
    );
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((serverId) => this.disconnect(serverId).catch(() => undefined)));
  }

  listPresets(): McpServerPreset[] {
    return mcpServerPresets.map(clonePreset);
  }

  exportConfig(permissionRules: McpConfigTransfer["permissionRules"] = []): McpConfigTransfer {
    return {
      version: 1,
      exportedAt: this.host.nowIso(),
      servers: this.servers.map((server) => ({
        ...cloneServer(server),
        env: redactEnv(server.env),
      })),
      permissionRules: permissionRules
        .filter((rule) => rule.toolName.startsWith("mcp."))
        .map((rule) => ({ toolName: rule.toolName, behavior: rule.behavior })),
    };
  }

  importConfig(transfer: McpConfigTransfer | { servers?: unknown[] }): McpImportResult {
    const items = Array.isArray(transfer.servers) ? transfer.servers : [];
    const now = this.host.nowIso();
    const imported: McpServerConfig[] = [];
    let skipped = 0;
    for (const item of items) {
      const input = transferServerToInput(item);
      if (!input) {
        skipped += 1;
        continue;
      }
      const server = normalizeServerInput(
        { ...input, autoConnect: false },
        uniqueServerId(input.name, [...this.servers, ...imported]),
        now,
      );
      imported.push(server);
    }
    this.servers = [...imported, ...this.servers];
    for (const server of imported) {
      this.connections.set(server.id, createDisconnectedConnection(server, now));
    }
    return {
      servers: imported.map(cloneServer),
      imported: imported.length,
      skipped,
    };
  }

  async diagnose(input: McpServerInput | McpServerConfig): Promise<McpDiagnosticResult> {
    const startedAt = this.host.nowIso();
    const startTime = Date.now();
    const now = this.host.nowIso();
    const server = normalizeServerInput(input, "diagnostic", now);
    const connection = createDisconnectedConnection(server, now);
    let stderrPreview = "";
    let initializeMs: number | undefined;
    let toolsListMs: number | undefined;
    try {
      const child = spawn(server.command, server.args, {
        cwd: server.cwd || process.cwd(),
        env: { ...process.env, ...(server.env || {}) },
        windowsHide: true,
        stdio: "pipe",
      });
      connection.process = child;
      child.stdout.on("data", (chunk) => this.handleData(connection, chunk));
      child.stderr.on("data", (chunk) => {
        const text = String(chunk).trim();
        if (text) {
          stderrPreview = appendPreview(stderrPreview, text, 2_000);
        }
      });
      child.on("exit", (code, signal) => {
        this.rejectPending(connection, new Error(formatExitReason(code, signal)));
        connection.process = undefined;
      });
      child.on("error", (error) => {
        this.rejectPending(connection, error);
      });

      const initializeStart = Date.now();
      const initializeResult = await this.request(connection, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "hbclient", version: "4.3.0" },
      });
      recordInitializeResult(connection, initializeResult);
      initializeMs = Date.now() - initializeStart;
      this.notify(connection, "notifications/initialized", {});
      const toolsStart = Date.now();
      const result = await this.request(connection, "tools/list", {});
      toolsListMs = Date.now() - toolsStart;
      const tools = parseTools(result, server);
      return finishDiagnostic({
        ok: true,
        serverName: server.name,
        startedAt,
        startTime,
        tools,
        stderrPreview,
        initializeMs,
        toolsListMs,
        protocolVersion: connection.protocolVersion,
        capabilities: connection.capabilities,
      });
    } catch (error) {
      const protocolError = error instanceof McpProtocolError ? error : undefined;
      return finishDiagnostic({
        ok: false,
        serverName: server.name,
        startedAt,
        startTime,
        tools: [],
        stderrPreview,
        error: (error as Error).message,
        initializeMs,
        toolsListMs,
        protocolVersion: connection.protocolVersion,
        capabilities: connection.capabilities,
        errorCode: protocolError?.code,
        errorData: protocolError?.data,
      });
    } finally {
      this.rejectPending(connection, new Error("MCP diagnostic finished."));
      if (connection.process) {
        connection.process.kill();
      }
    }
  }

  add(input: McpServerInput): McpServerConfig {
    const now = this.host.nowIso();
    const server = normalizeServerInput(input, uniqueServerId(input.name, this.servers), now);
    this.servers = [server, ...this.servers.filter((item) => item.id !== server.id)];
    this.connections.set(server.id, createDisconnectedConnection(server, now));
    return cloneServer(server);
  }

  update(serverId: string, update: McpServerUpdate): McpServerConfig {
    const current = this.servers.find((server) => server.id === serverId);
    if (!current) {
      throw new Error(`MCP server not found: ${serverId}`);
    }
    const next = normalizeServerInput({ ...current, ...update }, serverId, this.host.nowIso(), current.createdAt);
    this.servers = this.servers.map((server) => (server.id === serverId ? next : server));
    const connection = this.connectionFor(serverId);
    connection.config = cloneServer(next);
    if (!next.enabled) {
      void this.disconnect(serverId);
    }
    return cloneServer(next);
  }

  async remove(serverId: string): Promise<void> {
    await this.disconnect(serverId);
    this.servers = this.servers.filter((server) => server.id !== serverId);
    this.connections.delete(serverId);
  }

  async connect(serverId: string): Promise<McpServerStatus> {
    const server = this.servers.find((item) => item.id === serverId);
    if (!server) {
      throw new Error(`MCP server not found: ${serverId}`);
    }
    if (!server.enabled) {
      throw new Error(`MCP server is disabled: ${server.name}`);
    }
    const connection = this.connectionFor(serverId);
    if (connection.status.state === "connected") {
      return { ...connection.status };
    }
    if (connection.process) {
      await this.disconnect(serverId);
    }
    connection.config = cloneServer(server);
    connection.pending = new Map();
    connection.buffer = Buffer.alloc(0);
    connection.nextRequestId = 1;
    connection.manualDisconnect = false;
    this.setStatus(connection, "connecting", { lastError: undefined, lastExitReason: undefined, pid: undefined });
    await this.emit("Connecting MCP server", serverId, { name: server.name });

    try {
      const child = spawn(server.command, server.args, {
        cwd: server.cwd || process.cwd(),
        env: { ...process.env, ...(server.env || {}) },
        windowsHide: true,
        stdio: "pipe",
      });
      connection.process = child;
      this.setStatus(connection, "connecting", { pid: child.pid });
      child.stdout.on("data", (chunk) => this.handleData(connection, chunk));
      child.stderr.on("data", (chunk) => {
        const text = String(chunk).trim();
        if (text) {
          const preview = appendPreview(connection.status.stderrPreview, text, 2_000);
          this.setStatus(connection, connection.status.state, { stderrPreview: preview });
          this.pushLog(connection.config.id, "warning", text.slice(0, 1_000));
        }
      });
      child.on("exit", (code, signal) => {
        const message = formatExitReason(code, signal);
        const wasConnected = connection.status.state === "connected";
        const manual = connection.manualDisconnect;
        const preserveError = manual && connection.status.state === "error";
        this.rejectPending(connection, new Error(message));
        connection.process = undefined;
        connection.tools = [];
        connection.manualDisconnect = false;
        this.setStatus(connection, preserveError ? "error" : "disconnected", {
          toolCount: 0,
          pid: undefined,
          connectedAt: undefined,
          lastExitReason: message,
          lastError: preserveError ? connection.status.lastError : manual || wasConnected ? undefined : message,
        });
        if (manual) {
          this.pushLog(serverId, "info", message, { code, signal });
        } else {
          void this.emit(message, serverId, { code, signal }, "warning");
        }
      });
      child.on("error", (error) => {
        this.rejectPending(connection, error);
        this.setStatus(connection, "error", {
          lastError: error.message,
          lastExitReason: error.message,
          pid: undefined,
          toolCount: 0,
        });
        void this.emit("MCP server failed to start", serverId, { error: error.message }, "error");
      });

      const initializeResult = await this.request(connection, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "hbclient", version: "4.3.0" },
      });
      recordInitializeResult(connection, initializeResult);
      this.notify(connection, "notifications/initialized", {});
      await this.refreshTools(serverId);
      const connectedAt = this.host.nowIso();
      this.setStatus(connection, "connected", { connectedAt, lastConnectedAt: connectedAt, lastError: undefined });
      await this.emit("MCP server connected", serverId, { toolCount: connection.tools.length });
      return { ...connection.status };
    } catch (error) {
      await this.disconnect(serverId);
      const message = (error as Error).message;
      this.setStatus(connection, "error", { lastError: message, toolCount: 0 });
      await this.emit("MCP server connection failed", serverId, { error: message });
      throw error;
    }
  }

  async disconnect(serverId: string): Promise<McpServerStatus> {
    const connection = this.connectionFor(serverId);
    this.rejectPending(connection, new Error("MCP server disconnected."));
    if (connection.process) {
      const child = connection.process;
      connection.process = undefined;
      connection.manualDisconnect = true;
      child.kill();
    }
    connection.tools = [];
    this.setStatus(connection, "disconnected", { toolCount: 0, connectedAt: undefined, pid: undefined });
    await this.emit("MCP server disconnected", serverId);
    return { ...connection.status };
  }

  async refreshTools(serverId: string): Promise<McpToolInfo[]> {
    const connection = this.connectionFor(serverId);
    if (!connection.process || (connection.status.state !== "connecting" && connection.status.state !== "connected")) {
      throw new Error(`MCP server is not connected: ${connection.config.name}`);
    }
    const result = await this.request(connection, "tools/list", {});
    const tools = parseTools(result, connection.config);
    connection.tools = tools;
    this.setStatus(connection, connection.status.state, { toolCount: tools.length, lastError: undefined });
    await this.emit("MCP tools refreshed", serverId, { toolCount: tools.length });
    return tools.map((tool) => ({ ...tool }));
  }

  private toToolDefinition(connection: McpConnection, tool: McpToolInfo): ToolDefinition {
    return {
      name: tool.runtimeToolName,
      modelName: tool.modelToolName,
      description: tool.description || `MCP tool ${tool.name} from ${tool.serverName}.`,
      risk: "dangerous",
      concurrency: "exclusive",
      interruptBehavior: "cancel",
      parameters: tool.inputSchema,
      validationError:
        tool.schemaValid === false
          ? `MCP tool schema is invalid for ${tool.runtimeToolName}: ${tool.schemaWarnings.join("; ")}`
          : undefined,
      summarize(input) {
        return `${tool.runtimeToolName} ${JSON.stringify(input).slice(0, 160)}`;
      },
      execute: async (input, context) => this.callTool(tool, input, context),
    };
  }

  private async callTool(
    tool: McpToolInfo,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const connection = this.connectionFor(tool.serverId);
    if (!connection.process || connection.status.state !== "connected") {
      throw new Error(`MCP server is not connected: ${tool.serverName}`);
    }
    if (context.signal.aborted) {
      throw new Error("MCP tool call canceled.");
    }
    try {
      const result = await this.request(
        connection,
        "tools/call",
        {
          name: tool.name,
          arguments: input,
        },
        context.signal,
      );
      const formatted = formatMcpToolResult(result);
      return { text: formatted.text, outputParts: formatted.parts, outputTruncated: formatted.truncated };
    } catch (error) {
      if (error instanceof McpProtocolError) {
        throw new Error(formatMcpProtocolError(error), { cause: error });
      }
      throw error;
    }
  }

  private async request(
    connection: McpConnection,
    method: string,
    params?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!connection.process) {
      throw new Error(`MCP server is not running: ${connection.config.name}`);
    }
    const id = connection.nextRequestId++;
    const request: McpJsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const payload = Buffer.from(JSON.stringify(request), "utf8");
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8"), payload]);
    return new Promise((resolve, reject) => {
      const timeoutMs = normalizeRequestTimeout(connection.config.requestTimeoutMs);
      const timer = setTimeout(() => {
        connection.pending.delete(id);
        const message = `MCP request timed out after ${timeoutMs}ms: ${method}`;
        this.setStatus(connection, connection.status.state, { lastError: message });
        this.pushLog(connection.config.id, "error", message);
        reject(new Error(message));
      }, timeoutMs);
      const abort = () => {
        clearTimeout(timer);
        connection.pending.delete(id);
        reject(new Error(`MCP request canceled: ${method}`));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      connection.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
        timer,
      });
      connection.process!.stdin.write(frame, (error) => {
        if (error) {
          clearTimeout(timer);
          connection.pending.delete(id);
          signal?.removeEventListener("abort", abort);
          this.pushLog(connection.config.id, "error", error.message);
          reject(error);
        }
      });
    });
  }

  private notify(connection: McpConnection, method: string, params?: unknown): void {
    if (!connection.process) {
      return;
    }
    const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method, params }), "utf8");
    connection.process.stdin.write(
      Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8"), payload]),
    );
  }

  private handleData(connection: McpConnection, chunk: Buffer): void {
    connection.buffer = Buffer.concat([connection.buffer, chunk]);
    while (connection.buffer.length) {
      const headerEnd = connection.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = connection.buffer.subarray(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        connection.buffer = Buffer.alloc(0);
        this.setStatus(connection, "error", { lastError: "Invalid MCP frame header." });
        this.pushLog(connection.config.id, "error", "Invalid MCP frame header.");
        return;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (connection.buffer.length < bodyStart + length) {
        return;
      }
      const body = connection.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      connection.buffer = connection.buffer.subarray(bodyStart + length);
      this.handleMessage(connection, body);
    }
  }

  private handleMessage(connection: McpConnection, body: string): void {
    let message: McpJsonRpcResponse;
    try {
      message = JSON.parse(body) as McpJsonRpcResponse;
    } catch {
      this.setStatus(connection, "error", { lastError: "Invalid MCP JSON message." });
      this.pushLog(connection.config.id, "error", "Invalid MCP JSON message.");
      return;
    }
    if (typeof message.id !== "number") {
      if (typeof message.method === "string") {
        this.pushLog(connection.config.id, "info", `MCP notification: ${message.method}`, message.params);
      }
      return;
    }
    const pending = connection.pending.get(message.id);
    if (!pending) {
      this.pushLog(
        connection.config.id,
        "warning",
        `Ignored MCP response for unknown request id ${message.id}.`,
        message,
      );
      return;
    }
    clearTimeout(pending.timer);
    connection.pending.delete(message.id);
    if (message.error) {
      const messageText = message.error.message || `MCP error ${message.error.code ?? ""}`.trim();
      this.pushLog(connection.config.id, "error", messageText, message.error);
      pending.reject(new McpProtocolError(messageText, message.error.code, message.error.data));
      return;
    }
    pending.resolve(message.result);
  }

  private connectionFor(serverId: string): McpConnection {
    let connection = this.connections.get(serverId);
    if (!connection) {
      const server = this.servers.find((item) => item.id === serverId);
      if (!server) {
        throw new Error(`MCP server not found: ${serverId}`);
      }
      connection = createDisconnectedConnection(server, this.host.nowIso());
      this.connections.set(serverId, connection);
    }
    return connection;
  }

  private setStatus(connection: McpConnection, state: McpConnectionState, patch: Partial<McpServerStatus> = {}): void {
    connection.status = {
      ...connection.status,
      ...patch,
      serverId: connection.config.id,
      state,
      toolCount: patch.toolCount ?? connection.tools.length,
      updatedAt: this.host.nowIso(),
    };
  }

  private rejectPending(connection: McpConnection, error: Error): void {
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    connection.pending.clear();
  }

  private pushLog(serverId: string, level: McpLogRecord["level"], message: string, data?: unknown): McpLogRecord {
    const record: McpLogRecord = {
      id: this.host.randomId("mcp_log"),
      serverId,
      level,
      message,
      createdAt: this.host.nowIso(),
      data,
    };
    const next = [record, ...(this.logs.get(serverId) || [])].slice(0, 100);
    this.logs.set(serverId, next);
    return record;
  }

  private async emit(
    message: string,
    serverId?: string,
    data?: unknown,
    level: McpLogRecord["level"] = "info",
  ): Promise<void> {
    if (serverId) {
      this.pushLog(serverId, level, message, data);
    }
    await this.host.onEvent?.({ kind: "mcp_server", message, serverId, data });
  }
}

function createDisconnectedConnection(server: McpServerConfig, now: string): McpConnection {
  return {
    config: cloneServer(server),
    status: {
      serverId: server.id,
      state: "disconnected",
      toolCount: 0,
      updatedAt: now,
    },
    tools: [],
    pending: new Map(),
    buffer: Buffer.alloc(0),
    nextRequestId: 1,
    manualDisconnect: false,
  };
}

function normalizeServerInput(input: McpServerInput, id: string, now: string, createdAt = now): McpServerConfig {
  const name = input.name.trim();
  const command = input.command.trim();
  if (!name) {
    throw new Error("MCP server name is required.");
  }
  if (!command) {
    throw new Error("MCP server command is required.");
  }
  const env =
    input.env && typeof input.env === "object"
      ? Object.fromEntries(Object.entries(input.env).filter(([key, value]) => key.trim() && typeof value === "string"))
      : undefined;
  return {
    id: sanitizeServerId(id),
    name,
    command,
    args: Array.isArray(input.args)
      ? input.args.filter((item: unknown): item is string => typeof item === "string")
      : [],
    cwd: input.cwd?.trim() || undefined,
    env,
    requestTimeoutMs: normalizeRequestTimeout(input.requestTimeoutMs),
    enabled: input.enabled !== false,
    autoConnect: Boolean(input.autoConnect),
    createdAt,
    updatedAt: now,
    source: cloneServerSource(input.source),
  };
}

function cloneServer(server: McpServerConfig): McpServerConfig {
  return {
    ...server,
    args: [...server.args],
    env: server.env ? { ...server.env } : undefined,
    source: cloneServerSource(server.source),
  };
}

function cloneServerSource(source: McpServerConfig["source"]): McpServerConfig["source"] {
  return source ? { ...source } : undefined;
}

function parseTools(result: unknown, server: McpServerConfig): McpToolInfo[] {
  const tools = Array.isArray((result as { tools?: unknown[] } | undefined)?.tools)
    ? (result as { tools: unknown[] }).tools
    : [];
  return tools
    .map((item) => item as McpToolPayload)
    .filter((item) => typeof item.name === "string" && item.name.trim())
    .map((item) => {
      const name = item.name!.trim();
      const runtimeToolName = `mcp.${server.id}.${sanitizeToolName(name)}`;
      const normalized = normalizeInputSchema(item.inputSchema, `${runtimeToolName}.inputSchema`);
      return {
        serverId: server.id,
        serverName: server.name,
        name,
        runtimeToolName,
        modelToolName: `mcp__${sanitizeAliasPart(server.id)}__${sanitizeToolName(name)}`,
        description: typeof item.description === "string" ? item.description : "",
        inputSchema: normalized.schema,
        schemaValid: normalized.warnings.length === 0,
        schemaWarnings: normalized.warnings,
        connected: true,
      };
    });
}

function normalizeInputSchema(
  schema: unknown,
  path: string,
): { schema: McpToolInfo["inputSchema"]; warnings: string[] } {
  const warnings = inspectJsonSchema(schema, path);
  const value =
    schema && typeof schema === "object" && !Array.isArray(schema)
      ? (schema as Partial<McpToolInfo["inputSchema"]>)
      : {};
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    warnings.push(`${path} must be an object schema.`);
  }
  return {
    schema: {
      type: "object",
      properties:
        value.properties && typeof value.properties === "object" && !Array.isArray(value.properties)
          ? value.properties
          : {},
      required: Array.isArray(value.required)
        ? value.required.filter((item: unknown): item is string => typeof item === "string")
        : undefined,
      additionalProperties: typeof value.additionalProperties === "boolean" ? value.additionalProperties : true,
    },
    warnings: [...new Set(warnings)],
  };
}

function sanitizeServerId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-|-$/g, "") || "mcp"
  );
}

function uniqueServerId(name: string, servers: McpServerConfig[]): string {
  const base = sanitizeServerId(name);
  const used = new Set(servers.map((server) => server.id));
  if (!used.has(base)) {
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  return `${base}-${Date.now().toString(36)}`;
}

function sanitizeToolName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
}

function sanitizeAliasPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "mcp";
}

function normalizeRequestTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 30_000;
  }
  return Math.min(120_000, Math.max(1_000, Math.round(value)));
}

function appendPreview(current: string | undefined, text: string, maxLength: number): string {
  const next = [current, text].filter(Boolean).join("\n");
  return next.length > maxLength ? next.slice(next.length - maxLength) : next;
}

function formatExitReason(code: number | null, signal: NodeJS.Signals | null): string {
  const detail = [typeof code === "number" ? `code ${code}` : undefined, signal ? `signal ${signal}` : undefined]
    .filter(Boolean)
    .join(", ");
  return detail ? `MCP server exited (${detail}).` : "MCP server exited.";
}

function formatMcpProtocolError(error: McpProtocolError): string {
  const details = [
    error.message,
    typeof error.code === "number" ? `MCP code ${error.code}` : undefined,
    error.data !== undefined ? `data ${stringifyCompact(error.data, 600)}` : undefined,
  ].filter(Boolean);
  return details.join("; ");
}

function recordInitializeResult(connection: McpConnection, result: unknown): void {
  const payload =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as { protocolVersion?: unknown; capabilities?: unknown })
      : undefined;
  if (typeof payload?.protocolVersion === "string") {
    connection.protocolVersion = payload.protocolVersion;
  }
  if (payload && "capabilities" in payload) {
    connection.capabilities = payload.capabilities;
  }
}

function formatMcpToolResult(result: unknown): {
  text: string;
  parts: ToolCallRecord["outputParts"];
  truncated: boolean;
} {
  const payload = result as { content?: unknown[]; isError?: boolean } | undefined;
  let parts: ToolCallRecord["outputParts"] = [];
  if (Array.isArray(payload?.content)) {
    parts = payload.content
      .map(formatContentPart)
      .filter((part): part is NonNullable<typeof parts>[number] => Boolean(part));
    const text = parts
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n");
    if (text.trim()) {
      const formattedText = payload.isError ? `Error: ${text}` : text;
      const truncated = formattedText.length > 8_000;
      return {
        text: truncated ? `${formattedText.slice(0, 8_000)}\n[truncated]` : formattedText,
        parts,
        truncated,
      };
    }
  }
  const text = stringifyPretty(result, 8_000);
  return {
    text,
    parts: [{ type: "json", text }],
    truncated: text.endsWith("\n[truncated]"),
  };
}

function formatContentPart(part: unknown): NonNullable<ToolCallRecord["outputParts"]>[number] | undefined {
  if (!part || typeof part !== "object") {
    return undefined;
  }
  const value = part as { type?: string; text?: unknown; data?: unknown; mimeType?: unknown; resource?: unknown };
  if (value.type === "text" && typeof value.text === "string") {
    return { type: "text", text: value.text };
  }
  if (value.type === "image") {
    const mimeType = typeof value.mimeType === "string" ? value.mimeType : undefined;
    const dataLength = typeof value.data === "string" ? value.data.length : undefined;
    return {
      type: "image",
      mimeType,
      text: `[image${mimeType ? ` ${mimeType}` : ""}${dataLength ? `, ${dataLength} base64 chars` : ""}]`,
    };
  }
  if (value.type === "resource") {
    const resource =
      value.resource && typeof value.resource === "object" && !Array.isArray(value.resource)
        ? (value.resource as { uri?: unknown; name?: unknown; mimeType?: unknown; text?: unknown; blob?: unknown })
        : undefined;
    const mimeType =
      typeof resource?.mimeType === "string"
        ? resource.mimeType
        : typeof value.mimeType === "string"
          ? value.mimeType
          : undefined;
    const label = [
      typeof resource?.uri === "string" ? resource.uri : undefined,
      typeof resource?.name === "string" ? resource.name : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    const text =
      typeof resource?.text === "string"
        ? resource.text
        : `[resource${label ? ` ${label}` : ""}${mimeType ? ` ${mimeType}` : ""}]`;
    return { type: "resource", mimeType, text };
  }
  return { type: value.type || "unknown", text: stringifyCompact(value, 2_000) };
}

function stringifyPretty(value: unknown, limit: number): string {
  const text = JSON.stringify(value, null, 2) || "";
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}

function stringifyCompact(value: unknown, limit: number): string {
  const text = JSON.stringify(value) || "";
  return text.length > limit ? `${text.slice(0, limit)}...[truncated]` : text;
}

function redactEnv(env: McpServerConfig["env"]): McpConfigTransfer["servers"][number]["env"] {
  if (!env) {
    return undefined;
  }
  const entries = Object.keys(env)
    .filter(Boolean)
    .map((key) => [key, { redacted: true as const }]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function transferServerToInput(item: unknown): McpServerInput | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return undefined;
  }
  const value = item as Partial<McpServerConfig> & { env?: Record<string, unknown> };
  const name = typeof value.name === "string" && value.name.trim() ? value.name : undefined;
  const command = typeof value.command === "string" && value.command.trim() ? value.command : undefined;
  if (!name || !command) {
    return undefined;
  }
  return {
    name,
    command,
    args: Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === "string") : [],
    cwd: typeof value.cwd === "string" ? value.cwd : undefined,
    env: importEnvPlaceholders(value.env),
    requestTimeoutMs: value.requestTimeoutMs,
    enabled: value.enabled !== false,
    autoConnect: false,
  };
}

function importEnvPlaceholders(env: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return undefined;
  }
  const entries = Object.entries(env)
    .filter(([key]) => key.trim())
    .map(([key, value]) => [key, typeof value === "string" ? value : ""]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function finishDiagnostic(input: {
  ok: boolean;
  serverName: string;
  startedAt: string;
  startTime: number;
  tools: McpToolInfo[];
  stderrPreview?: string;
  error?: string;
  initializeMs?: number;
  toolsListMs?: number;
  protocolVersion?: string;
  capabilities?: unknown;
  errorCode?: number;
  errorData?: unknown;
}): McpDiagnosticResult {
  const finishedAt = nowIso();
  const schemaWarnings = input.tools.flatMap((tool) => schemaWarningsForTool(tool));
  return {
    ok: input.ok,
    serverName: input.serverName,
    startedAt: input.startedAt,
    finishedAt,
    durationMs: Date.now() - input.startTime,
    tools: input.tools,
    toolCount: input.tools.length,
    schemaWarnings,
    stderrPreview: input.stderrPreview || undefined,
    error: input.error,
    errorCode: input.errorCode,
    errorData: input.errorData,
    protocolVersion: input.protocolVersion,
    capabilities: input.capabilities,
    initializeMs: input.initializeMs,
    toolsListMs: input.toolsListMs,
  };
}

function schemaWarningsForTool(tool: McpToolInfo): string[] {
  const warnings: string[] = [...(tool.schemaWarnings || []).map((warning) => `${tool.runtimeToolName}: ${warning}`)];
  if (tool.inputSchema.type !== "object") {
    warnings.push(`${tool.runtimeToolName}: input schema is not an object.`);
  }
  for (const key of tool.inputSchema.required || []) {
    if (!(key in (tool.inputSchema.properties || {}))) {
      warnings.push(`${tool.runtimeToolName}: required property ${key} is missing from properties.`);
    }
  }
  return warnings;
}

function clonePreset(preset: McpServerPreset): McpServerPreset {
  return {
    ...preset,
    argsTemplate: [...preset.argsTemplate],
    envHints: preset.envHints.map((hint) => ({ ...hint })),
    serverInput: {
      ...preset.serverInput,
      args: [...(preset.serverInput.args || [])],
      env: preset.serverInput.env ? { ...preset.serverInput.env } : undefined,
    },
    recommendedPermissionRules: preset.recommendedPermissionRules.map((rule) => ({ ...rule })),
  };
}

const mcpServerPresets: McpServerPreset[] = [
  {
    id: "node-stdio",
    name: "Node stdio server",
    description: "Start a local MCP server from a JavaScript entry file.",
    commandTemplate: "node",
    argsTemplate: ["D:\\tools\\mcp-server.js"],
    cwdTemplate: "D:\\tools",
    envHints: [{ key: "API_KEY", description: "Optional API key required by the server.", required: false }],
    docsUrl: "https://modelcontextprotocol.io",
    riskNote: "Runs a local Node.js process and exposes every tool returned by that server.",
    serverInput: {
      name: "node-mcp",
      command: "node",
      args: ["D:\\tools\\mcp-server.js"],
      cwd: "D:\\tools",
      env: { API_KEY: "" },
      requestTimeoutMs: 30000,
      enabled: true,
      autoConnect: false,
    },
    recommendedPermissionRules: [{ toolName: "mcp.node-mcp.*", behavior: "ask" }],
  },
  {
    id: "python-stdio",
    name: "Python stdio server",
    description: "Start a local MCP server from a Python module or script.",
    commandTemplate: "python",
    argsTemplate: ["D:\\tools\\mcp_server.py"],
    cwdTemplate: "D:\\tools",
    envHints: [{ key: "PYTHONPATH", description: "Optional module path for local packages.", required: false }],
    docsUrl: "https://modelcontextprotocol.io",
    riskNote: "Runs a local Python process; review the script before allowing tools.",
    serverInput: {
      name: "python-mcp",
      command: "python",
      args: ["D:\\tools\\mcp_server.py"],
      cwd: "D:\\tools",
      env: { PYTHONPATH: "" },
      requestTimeoutMs: 30000,
      enabled: true,
      autoConnect: false,
    },
    recommendedPermissionRules: [{ toolName: "mcp.python-mcp.*", behavior: "ask" }],
  },
  {
    id: "npx-stdio",
    name: "npx stdio package",
    description: "Start an already installed npm MCP package through npx.",
    commandTemplate: "npx",
    argsTemplate: ["-y", "@example/mcp-server"],
    envHints: [{ key: "TOKEN", description: "Optional token used by the MCP package.", required: false }],
    docsUrl: "https://modelcontextprotocol.io",
    riskNote:
      "Does not install from HBClient, but npx may execute package code available on this machine or registry cache.",
    serverInput: {
      name: "npx-mcp",
      command: "npx",
      args: ["-y", "@example/mcp-server"],
      env: { TOKEN: "" },
      requestTimeoutMs: 30000,
      enabled: true,
      autoConnect: false,
    },
    recommendedPermissionRules: [{ toolName: "mcp.npx-mcp.*", behavior: "ask" }],
  },
];
