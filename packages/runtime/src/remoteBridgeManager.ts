import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import type {
  IdentityContext,
  RemoteBridgeCallerMetadata,
  RemoteBridgeAuditRecord,
  RemoteBridgeConfig,
  RemoteBridgeSession,
  RuntimeSnapshot,
  SendPromptInput,
  TranscriptLoadResult,
  WorktreeDiffSummary
} from "@supbot/shared";

const maxRequestBodyBytes = 64 * 1024;

interface RemoteBridgeHost {
  randomId(prefix: string): string;
  nowIso(): string;
  getSnapshot(): RuntimeSnapshot;
  loadTranscript(conversationId: string): Promise<TranscriptLoadResult>;
  getWorktreeDiff(id: string): Promise<WorktreeDiffSummary>;
  sendRemotePrompt(input: SendPromptInput): Promise<unknown>;
  getIdentityContext(): IdentityContext | undefined;
  updateIdentityContext(input: IdentityContext): Promise<IdentityContext>;
  onAudit(record: RemoteBridgeAuditRecord): Promise<void> | void;
  onEvent(message: string, data?: unknown): Promise<void> | void;
}

export class RemoteBridgeManager {
  private config: RemoteBridgeConfig = defaultRemoteBridgeConfig(false);
  private token?: string;
  private sessions: RemoteBridgeSession[] = [];
  private audit: RemoteBridgeAuditRecord[] = [];
  private server?: Server;

  constructor(private readonly host: RemoteBridgeHost) {}

  async configure(input: {
    config: RemoteBridgeConfig;
    token?: string;
    sessions: RemoteBridgeSession[];
    audit: RemoteBridgeAuditRecord[];
  }): Promise<void> {
    let host: string;
    let allowRemoteBind = input.config.allowRemoteBind;
    try {
      host = normalizeHost(input.config.host, allowRemoteBind);
    } catch {
      host = "127.0.0.1";
      allowRemoteBind = false;
      await this.host.onEvent("Remote bridge remote bind was disabled because HTTP transport is loopback-only.", {
        requestedHost: input.config.host
      });
    }
    this.config = { ...input.config, host, allowRemoteBind, tokenSaved: Boolean(input.token) };
    this.token = input.token;
    this.sessions = [...input.sessions];
    this.audit = [...input.audit];
    if (this.config.enabled) {
      await this.start();
    }
  }

  snapshot(): { config: RemoteBridgeConfig; sessions: RemoteBridgeSession[]; audit: RemoteBridgeAuditRecord[] } {
    return {
      config: { ...this.config, tokenSaved: Boolean(this.token) },
      sessions: this.sessions.map((item) => ({ ...item })),
      audit: this.audit.map((item) => ({ ...item }))
    };
  }

  async update(update: Partial<RemoteBridgeConfig> & { token?: string; clearToken?: boolean }): Promise<{ config: RemoteBridgeConfig; token?: string }> {
    const nextToken = update.clearToken ? undefined : update.token?.trim() || this.token || createBridgeToken();
    const allowRemoteBind = update.allowRemoteBind ?? this.config.allowRemoteBind;
    this.config = {
      ...this.config,
      ...update,
      port: normalizePort(update.port ?? this.config.port),
      host: normalizeHost(update.host || this.config.host, allowRemoteBind),
      allowRemoteBind,
      tokenSaved: Boolean(nextToken),
      pairingCode: update.enabled ? shortPairingCode(nextToken) : undefined,
      updatedAt: this.host.nowIso()
    };
    delete (this.config as RemoteBridgeConfig & { token?: string; clearToken?: boolean }).token;
    delete (this.config as RemoteBridgeConfig & { token?: string; clearToken?: boolean }).clearToken;
    this.token = nextToken;
    if (this.config.enabled) {
      await this.restart();
    } else {
      await this.stop();
    }
    await this.host.onEvent(this.config.enabled ? "Remote bridge enabled" : "Remote bridge disabled", {
      host: this.config.host,
      port: this.config.port
    });
    return { config: { ...this.config, tokenSaved: Boolean(this.token) }, token: this.token };
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const current = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => current.close((error) => error ? reject(error) : resolve()));
  }

  listSessions(): RemoteBridgeSession[] {
    return this.sessions.map((item) => ({ ...item }));
  }

  listAudit(): RemoteBridgeAuditRecord[] {
    return this.audit.map((item) => ({ ...item }));
  }

  revokeSession(id: string): RemoteBridgeSession {
    const now = this.host.nowIso();
    let revoked: RemoteBridgeSession | undefined;
    this.sessions = this.sessions.map((session) => {
      if (session.id !== id) {
        return session;
      }
      revoked = { ...session, revokedAt: now };
      return revoked;
    });
    if (!revoked) {
      throw new Error(`Remote bridge session not found: ${id}`);
    }
    return revoked;
  }

  private async start(): Promise<void> {
    if (this.server) {
      return;
    }
    if (!this.token) {
      this.token = createBridgeToken();
      this.config = { ...this.config, tokenSaved: true, pairingCode: shortPairingCode(this.token) };
    }
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        console.error("Remote bridge request failed", error);
        if (!response.headersSent) {
          response.statusCode = 500;
          this.sendJson(response, { ok: false, error: "Remote bridge request failed" });
        } else if (!response.writableEnded) {
          response.end();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.config.port, this.config.host, () => {
        this.server!.off("error", reject);
        const address = this.server!.address() as AddressInfo | null;
        if (address && typeof address.port === "number") {
          this.config = { ...this.config, port: address.port, updatedAt: this.host.nowIso() };
        }
        resolve();
      });
    });
  }

  private async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let path = request.url || "/";
    const method = request.method || "GET";
    const remoteAddress = request.socket.remoteAddress;
    let statusCode = 200;
    let message = "ok";
    let sessionId: string | undefined;
    let caller = callerMetadataFromRequest(request);
    try {
      path = new URL(path, `http://${request.headers.host || "127.0.0.1"}`).pathname;
      const session = this.authenticate(request);
      sessionId = session.id;
      if (method === "GET" && path === "/snapshot") {
        return this.sendJson(response, this.readOnlySnapshot());
      }
      if (method === "GET" && path === "/identity") {
        return this.sendJson(response, { identityContext: this.host.getIdentityContext() });
      }
      if (method === "PUT" && path === "/identity") {
        const body = await readJson(request);
        caller = callerMetadataFromRequest(request, body);
        const identity = body.identityContext && typeof body.identityContext === "object"
          ? body.identityContext
          : body;
        return this.sendJson(response, { identityContext: await this.host.updateIdentityContext(identity as IdentityContext) });
      }
      if (method === "GET" && path.startsWith("/transcript/")) {
        const conversationId = decodeURIComponent(path.slice("/transcript/".length));
        return this.sendJson(response, await this.host.loadTranscript(conversationId));
      }
      if (method === "GET" && path.startsWith("/worktree/") && path.endsWith("/diff")) {
        const id = decodeURIComponent(path.slice("/worktree/".length, -"/diff".length));
        return this.sendJson(response, await this.host.getWorktreeDiff(id));
      }
      if (method === "POST" && path === "/prompt") {
        const body = await readJson(request);
        caller = callerMetadataFromRequest(request, body);
        const prompt = typeof body.prompt === "string" ? body.prompt : "";
        if (!prompt.trim()) {
          throw httpError(400, "prompt is required");
        }
        return this.sendJson(response, await this.host.sendRemotePrompt({
          conversationId: typeof body.conversationId === "string" ? body.conversationId : undefined,
          prompt,
          workspaceMode: "readOnly",
          remoteCaller: caller
        } as SendPromptInput));
      }
      throw httpError(404, "Not found");
    } catch (error) {
      statusCode = (error as HttpError).statusCode || 500;
      message = (error as Error).message;
      response.statusCode = statusCode;
      this.sendJson(response, { ok: false, error: message });
    } finally {
      const record = this.recordAudit({
        sessionId,
        method,
        path,
        ok: statusCode < 400,
        statusCode,
        message,
        remoteAddress,
        requestId: caller.requestId,
        agentInstanceId: caller.agentInstanceId,
        peerId: caller.peerId,
        caller,
        identity: this.host.getIdentityContext()
      });
      await this.host.onAudit(record);
    }
  }

  private authenticate(request: IncomingMessage): RemoteBridgeSession {
    const auth = request.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
    if (!this.token || token !== this.token) {
      throw httpError(401, "Unauthorized");
    }
    const now = this.host.nowIso();
    const tokenPrefix = token.slice(0, 8);
    if (this.sessions.some((session) => session.tokenPrefix === tokenPrefix && session.revokedAt)) {
      throw httpError(401, "Remote bridge session was revoked. Rotate the bridge token before reconnecting.");
    }
    const current = this.sessions.find((session) => session.tokenPrefix === tokenPrefix && !session.revokedAt);
    if (current) {
      const next = { ...current, lastSeenAt: now };
      this.sessions = this.sessions.map((item) => item.id === next.id ? next : item);
      return next;
    }
    const session: RemoteBridgeSession = {
      id: this.host.randomId("remote_session"),
      name: "Remote bridge client",
      tokenPrefix,
      createdAt: now,
      lastSeenAt: now
    };
    this.sessions = [session, ...this.sessions].slice(0, 50);
    return session;
  }

  private readOnlySnapshot(): RuntimeSnapshot {
    const snapshot = this.host.getSnapshot();
    return {
      ...snapshot,
      pendingToolPermissions: [],
      permissionRules: [],
      modelConfig: { ...snapshot.modelConfig, apiKeySaved: snapshot.modelConfig.apiKeySaved },
      toolMarketConfig: { ...snapshot.toolMarketConfig }
    };
  }

  private sendJson(response: ServerResponse, value: unknown): void {
    if (!response.headersSent) {
      response.setHeader("Content-Type", "application/json");
    }
    response.end(JSON.stringify(value));
  }

  private recordAudit(input: Omit<RemoteBridgeAuditRecord, "id" | "createdAt">): RemoteBridgeAuditRecord {
    const record: RemoteBridgeAuditRecord = {
      id: this.host.randomId("remote_audit"),
      createdAt: this.host.nowIso(),
      ...input
    };
    this.audit = [record, ...this.audit].slice(0, 300);
    return record;
  }
}

export function defaultRemoteBridgeConfig(tokenSaved: boolean): RemoteBridgeConfig {
  return {
    enabled: false,
    host: "127.0.0.1",
    port: 47831,
    tokenSaved,
    allowRemoteBind: false
  };
}

function createBridgeToken(): string {
  return randomBytes(24).toString("hex");
}

function shortPairingCode(token?: string): string | undefined {
  return token
    ? createHash("sha256").update("supbot:remote-bridge:pairing:").update(token).digest("hex").slice(0, 6).toUpperCase()
    : undefined;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  let size = 0;
  for await (const chunk of request) {
    const text = chunk.toString();
    size += Buffer.byteLength(text);
    if (size > maxRequestBodyBytes) {
      throw httpError(413, "Request body is too large");
    }
    raw += text;
  }
  try {
    const parsed = raw.trim() ? JSON.parse(raw) as unknown : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw httpError(400, "JSON body must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as HttpError).statusCode) {
      throw error;
    }
    throw httpError(400, "Invalid JSON body");
  }
}

function normalizePort(value: unknown): number {
  const port = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 47831;
  return port === 0 ? 0 : Math.min(65535, Math.max(1024, port));
}

function normalizeHost(value: unknown, allowRemoteBind = false): string {
  const host = typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "127.0.0.1";
  if (host === "localhost" || host === "::1" || host === "127.0.0.1") {
    return host;
  }
  if (allowRemoteBind) {
    throw new Error("Remote bridge HTTP transport is restricted to loopback. Use a TLS-terminating reverse proxy for remote access.");
  }
  return "127.0.0.1";
}

function callerMetadataFromRequest(request: IncomingMessage, body?: Record<string, unknown>): RemoteBridgeCallerMetadata {
  const bodyUserContext = body?.userContext && typeof body.userContext === "object" ? body.userContext as Partial<IdentityContext> : undefined;
  const headerUserContext = identityContextFromHeaders(request);
  return {
    requestId: firstString(body?.requestId) ?? headerValue(request, "x-a2a-request-id") ?? headerValue(request, "x-request-id"),
    agentInstanceId: firstString(body?.agentInstanceId) ?? headerValue(request, "x-servstation-agent-id") ?? headerValue(request, "x-agent-instance-id"),
    peerId: firstString(body?.peerId) ?? headerValue(request, "x-a2a-peer-id"),
    clientId: firstString(body?.clientId) ?? headerValue(request, "x-a2a-client-id"),
    userContext: bodyUserContext
      ? identityContextFromObject(bodyUserContext)
      : headerUserContext
  };
}

function identityContextFromHeaders(request: IncomingMessage): IdentityContext | undefined {
  const context = identityContextFromObject({
    tenantId: headerValue(request, "x-tenant-id"),
    organizationId: headerValue(request, "x-organization-id"),
    departmentId: headerValue(request, "x-department-id"),
    userId: headerValue(request, "x-user-id"),
    roleIds: headerValue(request, "x-role-ids")?.split(",").map((item) => item.trim()).filter(Boolean),
    source: "servstation"
  });
  return context;
}

function identityContextFromObject(value: Partial<IdentityContext>): IdentityContext | undefined {
  const tenantId = firstString(value.tenantId);
  const organizationId = firstString(value.organizationId);
  const departmentId = firstString(value.departmentId);
  const userId = firstString(value.userId);
  if (!tenantId || !organizationId || !departmentId || !userId) {
    return undefined;
  }
  return {
    tenantId,
    organizationId,
    departmentId,
    userId,
    roleIds: Array.isArray(value.roleIds) ? value.roleIds.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim()) : [],
    source: value.source === "manual" ? "manual" : "servstation",
    agentInstanceId: firstString(value.agentInstanceId),
    servstationUrl: firstString(value.servstationUrl),
    updatedAt: firstString(value.updatedAt)
  };
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

interface HttpError extends Error {
  statusCode?: number;
}

function httpError(statusCode: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
}
