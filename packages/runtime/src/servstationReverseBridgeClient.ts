import type {
  IdentityContext,
  ServstationA2AConfig,
  ServstationA2AConfigUpdate,
  ServstationA2AReverseConfig
} from "@supbot/shared";

interface ReverseBridgeHost {
  getConfig(): ServstationA2AConfig;
  getAccessToken(signal?: AbortSignal): Promise<string | undefined>;
  getIdentityContext(): IdentityContext | undefined;
  updateConfig(input: ServstationA2AConfigUpdate): Promise<ServstationA2AConfig>;
  updateReverseState(input: Partial<ServstationA2AReverseConfig>): Promise<void>;
  sendReadOnlyPromptAndWait(input: ReversePromptInput): Promise<ReversePromptResult>;
  randomId(prefix: string): string;
  nowIso(): string;
}

export interface ReversePromptInput {
  prompt: string;
  conversationId?: string;
  timeoutMs?: number;
  remoteCaller?: {
    requestId?: string;
    agentInstanceId?: string;
    peerId?: string;
    clientId?: string;
    userContext?: IdentityContext;
  };
  signal?: AbortSignal;
}

export interface ReversePromptResult {
  status: string;
  conversationId?: string;
  jobId?: string;
  assistantText?: string;
  result?: unknown;
  error?: string;
}

interface AgentConnectResponse {
  agentInstanceId?: string;
}

interface ReverseRegisterResponse {
  peer?: { id?: string };
  streamUrl?: string;
  heartbeatMs?: number;
}

interface ReverseInvocationEvent {
  invocationId?: string;
  requestId?: string;
  prompt?: string;
  conversationId?: string;
  timeoutMs?: number;
  userContext?: IdentityContext;
  agentInstanceId?: string;
}

interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export class ServstationReverseBridgeClient {
  private controller?: AbortController;
  private loop?: Promise<void>;
  private stopped = true;
  private retryDelayMs = 1_000;

  constructor(private readonly host: ReverseBridgeHost) {}

  start(): void {
    if (this.loop) {
      return;
    }
    this.stopped = false;
    this.retryDelayMs = 1_000;
    this.loop = this.runLoop().finally(() => {
      this.loop = undefined;
    });
  }

  async stop(disable = true): Promise<void> {
    this.stopped = true;
    this.controller?.abort();
    this.controller = undefined;
    await this.host.updateReverseState({
      ...(disable ? { enabled: false } : {}),
      status: "disconnected",
      connectedAt: undefined,
      lastError: undefined
    });
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      this.controller = new AbortController();
      try {
        await this.host.updateReverseState({ enabled: true, status: "connecting", lastError: undefined });
        await this.connectOnce(this.controller.signal);
        this.retryDelayMs = 1_000;
      } catch (error) {
        if (this.stopped || this.controller.signal.aborted) {
          break;
        }
        await this.host.updateReverseState({
          enabled: true,
          status: "error",
          connectedAt: undefined,
          lastError: (error as Error).message
        });
        await sleep(this.retryDelayMs);
        this.retryDelayMs = Math.min(30_000, Math.round(this.retryDelayMs * 1.8));
      }
    }
    if (!this.stopped) {
      await this.host.updateReverseState({ status: "disconnected", connectedAt: undefined });
    }
  }

  private async connectOnce(signal: AbortSignal): Promise<void> {
    const config = this.host.getConfig();
    const identity = this.requireIdentity();
    const baseUrl = this.requireBaseUrl(config, identity);
    const clientInstanceId = config.reverse?.clientInstanceId || this.host.randomId("supbot_client");
    await this.host.updateReverseState({ enabled: true, status: "connecting", clientInstanceId });
    const agentInstanceId = await this.ensureAgentInstanceId(baseUrl, signal);
    const registration = await this.request<ReverseRegisterResponse>(
      baseUrl,
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/a2a-peers/reverse-connections`,
      {
        method: "POST",
        signal,
        body: JSON.stringify({
          clientInstanceId,
          displayName: "Supbot Desktop",
          capabilities: ["prompt.readOnly"],
          supbotVersion: "0.1.0"
        })
      }
    );
    const peerId = registration.peer?.id;
    if (!peerId) {
      throw new Error("Servstation reverse registration did not return a peer id.");
    }
    const streamUrl = registration.streamUrl || `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/a2a-peers/${encodeURIComponent(peerId)}/events`;
    await this.host.updateReverseState({ enabled: true, status: "connecting", peerId, clientInstanceId });
    await this.openEventStream(baseUrl, streamUrl, agentInstanceId, peerId, signal);
  }

  private async ensureAgentInstanceId(baseUrl: string, signal: AbortSignal): Promise<string> {
    const config = this.host.getConfig();
    const existing = config.agentInstanceId || this.host.getIdentityContext()?.agentInstanceId;
    if (existing) {
      return existing;
    }
    const connected = await this.request<AgentConnectResponse>(baseUrl, "/api/v1/agent/connect", {
      method: "POST",
      signal,
      body: JSON.stringify({ clientId: "supbot-reverse-a2a" })
    });
    const agentInstanceId = connected.agentInstanceId;
    if (!agentInstanceId) {
      throw new Error("Servstation connect did not return an agent instance id.");
    }
    await this.host.updateConfig({ agentInstanceId });
    return agentInstanceId;
  }

  private async openEventStream(
    baseUrl: string,
    streamUrl: string,
    agentInstanceId: string,
    peerId: string,
    signal: AbortSignal
  ): Promise<void> {
    const response = await fetch(joinUrl(baseUrl, streamUrl), {
      method: "GET",
      signal,
      headers: await this.headers(signal)
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(`Servstation reverse event stream failed: ${text || `HTTP ${response.status}`}`);
    }
    await this.host.updateReverseState({
      enabled: true,
      status: "connected",
      peerId,
      connectedAt: this.host.nowIso(),
      lastError: undefined
    });

    for await (const event of parseSse(response.body, signal)) {
      if (event.event === "heartbeat") {
        await this.host.updateReverseState({
          status: "connected",
          lastHeartbeatAt: this.host.nowIso(),
          lastError: undefined
        });
        continue;
      }
      if (event.event === "invoke_prompt") {
        void this.handleInvocation(baseUrl, agentInstanceId, peerId, event, signal);
      }
    }
    if (!signal.aborted) {
      throw new Error("Servstation reverse event stream ended.");
    }
  }

  private async handleInvocation(
    baseUrl: string,
    agentInstanceId: string,
    peerId: string,
    event: SseEvent,
    signal: AbortSignal
  ): Promise<void> {
    const payload = safeJson(event.data) as ReverseInvocationEvent;
    const invocationId = requiredString(payload.invocationId || event.id, "invocationId");
    const requestId = payload.requestId || invocationId;
    try {
      const prompt = requiredString(payload.prompt, "prompt");
      await this.request(baseUrl, invocationPath(agentInstanceId, peerId, invocationId, "ack"), {
        method: "POST",
        signal,
        body: JSON.stringify({ requestId })
      });
      const result = await this.host.sendReadOnlyPromptAndWait({
        prompt,
        conversationId: payload.conversationId,
        timeoutMs: normalizeTimeout(payload.timeoutMs),
        signal,
        remoteCaller: {
          requestId,
          agentInstanceId: payload.agentInstanceId || agentInstanceId,
          peerId,
          clientId: "servstation-reverse",
          userContext: payload.userContext
        }
      });
      await this.request(baseUrl, invocationPath(agentInstanceId, peerId, invocationId, "result"), {
        method: "POST",
        signal,
        body: JSON.stringify(result)
      });
    } catch (error) {
      await this.request(baseUrl, invocationPath(agentInstanceId, peerId, invocationId, "result"), {
        method: "POST",
        signal,
        body: JSON.stringify({
          status: "failed",
          error: (error as Error).message
        })
      }).catch(() => undefined);
    }
  }

  private async request<T = unknown>(baseUrl: string, path: string, init: RequestInit): Promise<T> {
    const response = await fetch(joinUrl(baseUrl, path), {
      ...init,
      headers: {
        ...await this.headers(init.signal instanceof AbortSignal ? init.signal : undefined),
        ...(init.headers || {})
      }
    });
    const text = await response.text();
    const payload = text.trim() ? safeJson(text) : {};
    if (!response.ok) {
      throw new Error(errorMessage(payload) || text || `HTTP ${response.status}`);
    }
    return payload as T;
  }

  private async headers(signal?: AbortSignal): Promise<Record<string, string>> {
    const identity = this.requireIdentity();
    const token = await this.host.getAccessToken(signal);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-tenant-id": identity.tenantId,
      "x-organization-id": identity.organizationId,
      "x-department-id": identity.departmentId,
      "x-user-id": identity.userId,
      "x-role-ids": identity.roleIds.join(",")
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private requireIdentity(): IdentityContext {
    const identity = this.host.getIdentityContext();
    if (!identity) {
      throw new Error("Servstation reverse A2A identity context is not paired.");
    }
    return identity;
  }

  private requireBaseUrl(config: ServstationA2AConfig, identity: IdentityContext): string {
    const baseUrl = normalizeBaseUrl(config.baseUrl || identity.servstationUrl);
    if (!baseUrl) {
      throw new Error("Servstation reverse A2A base URL is not configured.");
    }
    return baseUrl;
  }
}

function invocationPath(agentInstanceId: string, peerId: string, invocationId: string, action: "ack" | "result"): string {
  return `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/a2a-peers/${encodeURIComponent(peerId)}/invocations/${encodeURIComponent(invocationId)}/${action}`;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function joinUrl(baseUrl: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }
  return `${baseUrl.replace(/\/+$/, "")}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function normalizeTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 120_000;
  }
  return Math.max(1_000, Math.min(300_000, Math.trunc(value)));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function errorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return typeof record.error === "string" ? record.error : typeof record.message === "string" ? record.message : undefined;
}

async function* parseSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let eventId: string | undefined;
  let dataLines: string[] = [];
  const dispatch = (): SseEvent | undefined => {
    if (!dataLines.length) {
      eventName = "message";
      eventId = undefined;
      return undefined;
    }
    const event = { event: eventName, id: eventId, data: dataLines.join("\n") };
    eventName = "message";
    eventId = undefined;
    dataLines = [];
    return event;
  };
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        const event = dispatch();
        if (event) {
          yield event;
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.search(/\r?\n/);
      while (newlineIndex >= 0) {
        const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(rawLine.length + (buffer[rawLine.length] === "\r" ? 2 : 1));
        if (rawLine === "") {
          const event = dispatch();
          if (event) {
            yield event;
          }
        } else if (!rawLine.startsWith(":")) {
          const separator = rawLine.indexOf(":");
          const field = separator >= 0 ? rawLine.slice(0, separator) : rawLine;
          const valueText = separator >= 0 ? rawLine.slice(separator + 1).replace(/^ /, "") : "";
          if (field === "event") {
            eventName = valueText || "message";
          } else if (field === "data") {
            dataLines.push(valueText);
          } else if (field === "id") {
            eventId = valueText;
          }
        }
        newlineIndex = buffer.search(/\r?\n/);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
