import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import type {
  RemoteBridgeAuditRecord,
  RemoteBridgeConfig,
  RemoteBridgeSession,
  RuntimeSnapshot,
  SendPromptInput,
  TranscriptLoadResult,
  WorktreeDiffSummary
} from "@supbot/shared";

interface RemoteBridgeHost {
  randomId(prefix: string): string;
  nowIso(): string;
  getSnapshot(): RuntimeSnapshot;
  loadTranscript(conversationId: string): Promise<TranscriptLoadResult>;
  getWorktreeDiff(id: string): Promise<WorktreeDiffSummary>;
  sendRemotePrompt(input: SendPromptInput): Promise<unknown>;
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
    this.config = { ...input.config, tokenSaved: Boolean(input.token) };
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
    this.config = {
      ...this.config,
      ...update,
      port: normalizePort(update.port ?? this.config.port),
      host: update.host?.trim() || this.config.host || "127.0.0.1",
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
      void this.handle(request, response);
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
    const path = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`).pathname;
    const method = request.method || "GET";
    const remoteAddress = request.socket.remoteAddress;
    let statusCode = 200;
    let message = "ok";
    let sessionId: string | undefined;
    try {
      const session = this.authenticate(request);
      sessionId = session.id;
      if (method === "GET" && path === "/snapshot") {
        return this.sendJson(response, this.readOnlySnapshot());
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
        const prompt = typeof body.prompt === "string" ? body.prompt : "";
        if (!prompt.trim()) {
          throw httpError(400, "prompt is required");
        }
        return this.sendJson(response, await this.host.sendRemotePrompt({
          conversationId: typeof body.conversationId === "string" ? body.conversationId : undefined,
          prompt,
          workspaceMode: "readOnly"
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
        remoteAddress
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
    tokenSaved
  };
}

function createBridgeToken(): string {
  return randomBytes(24).toString("hex");
}

function shortPairingCode(token?: string): string | undefined {
  return token ? token.slice(0, 6).toUpperCase() : undefined;
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk.toString();
  }
  return raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {};
}

function normalizePort(value: unknown): number {
  const port = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 47831;
  return port === 0 ? 0 : Math.min(65535, Math.max(1024, port));
}

interface HttpError extends Error {
  statusCode?: number;
}

function httpError(statusCode: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
}
