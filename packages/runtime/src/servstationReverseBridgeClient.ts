import type {
  ChatMessage,
  IdentityContext,
  RuntimeSnapshot,
  ServstationA2AConfig,
  ServstationA2AConfigUpdate,
  ServstationA2AReverseConfig,
  TranscriptLoadResult
} from "@supbot/shared";
import { fetchWithRetry } from "./httpClient";

interface ReverseBridgeHost {
  getConfig(): ServstationA2AConfig;
  getAccessToken(signal?: AbortSignal): Promise<string | undefined>;
  getIdentityContext(): IdentityContext | undefined;
  getSnapshot(): RuntimeSnapshot;
  loadTranscript(conversationId: string): Promise<TranscriptLoadResult>;
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
  peer?: { id?: string; agentInstanceId?: string };
  agentId?: string;
  agentInstanceId?: string;
  streamUrl?: string;
  heartbeatMs?: number;
  clientHeartbeatTimeoutMs?: number;
}

interface ReversePeerLink {
  id?: string;
  agentInstanceId?: string;
  connectionMode?: string;
  clientInstanceId?: string;
}

interface ReversePeerListResponse {
  peers?: ReversePeerLink[];
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

interface ReverseRequestEvent {
  requestId?: string;
  conversationId?: string;
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
  private wakeRetry?: () => void;
  private restartAfterLoop = false;

  constructor(private readonly host: ReverseBridgeHost) {}

  start(): void {
    if (this.loop) {
      this.stopped = false;
      this.retryDelayMs = 1_000;
      this.wakeRetry?.();
      if (this.controller?.signal.aborted) {
        this.restartAfterLoop = true;
      }
      return;
    }
    this.restartAfterLoop = false;
    this.stopped = false;
    this.retryDelayMs = 1_000;
    this.loop = this.runLoop().catch((error) => {
      console.error("Servstation reverse bridge loop failed", error);
    }).finally(() => {
      const shouldRestart = this.restartAfterLoop && !this.stopped;
      this.loop = undefined;
      this.restartAfterLoop = false;
      if (shouldRestart) {
        this.start();
      }
    });
  }

  async stop(disable = true): Promise<void> {
    this.restartAfterLoop = false;
    this.stopped = true;
    this.controller?.abort();
    this.controller = undefined;
    this.wakeRetry?.();
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
        await this.waitBeforeRetry(this.retryDelayMs);
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
    const registration = await this.registerReverseConnection(baseUrl, agentInstanceId, clientInstanceId, signal);
    const registeredAgentInstanceId = registration.agentInstanceId || registration.agentId || registration.peer?.agentInstanceId || agentInstanceId;
    if (registeredAgentInstanceId !== agentInstanceId) {
      await this.host.updateConfig({ agentInstanceId: registeredAgentInstanceId });
    }
    const peerId = registration.peer?.id;
    if (!peerId) {
      throw new Error("Servstation reverse registration did not return a peer id.");
    }
    const streamUrl = registration.streamUrl || `/api/v1/agent/${encodeURIComponent(registeredAgentInstanceId)}/a2a-peers/${encodeURIComponent(peerId)}/events`;
    await this.host.updateReverseState({ enabled: true, status: "connecting", peerId, clientInstanceId });
    await this.openEventStream(baseUrl, streamUrl, registeredAgentInstanceId, peerId, registration, signal);
  }

  private async registerReverseConnection(
    baseUrl: string,
    agentInstanceId: string,
    clientInstanceId: string,
    signal: AbortSignal
  ): Promise<ReverseRegisterResponse> {
    try {
      return await this.request<ReverseRegisterResponse>(
        baseUrl,
        `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/a2a-peers/reverse-connections`,
        {
          method: "POST",
          signal,
          body: JSON.stringify({
            agentInstanceId,
            clientInstanceId,
            displayName: "Supbot Desktop",
            capabilities: ["prompt.readOnly"],
            supbotVersion: "0.1.0"
          })
        }
      );
    } catch (error) {
      if (!isRecoverableReverseRegistrationError(error)) {
        throw error;
      }
      const peer = await this.findExistingReversePeer(baseUrl, agentInstanceId, clientInstanceId, signal);
      if (!peer?.id) {
        throw error;
      }
      return {
        peer: { id: peer.id },
        streamUrl: `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/a2a-peers/${encodeURIComponent(peer.id)}/events`
      };
    }
  }

  private async findExistingReversePeer(
    baseUrl: string,
    agentInstanceId: string,
    clientInstanceId: string,
    signal: AbortSignal
  ): Promise<ReversePeerLink | undefined> {
    const response = await this.request<ReversePeerListResponse>(
      baseUrl,
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/a2a-peers`,
      { method: "GET", signal }
    );
    return (response.peers || []).find((peer) =>
      peer.connectionMode === "reverse_sse" &&
      peer.clientInstanceId === clientInstanceId &&
      Boolean(peer.id)
    );
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
    registration: ReverseRegisterResponse,
    signal: AbortSignal
  ): Promise<void> {
    const response = await fetchWithRetry(joinUrl(baseUrl, streamUrl), {
      method: "GET",
      signal,
      headers: await this.headers(signal)
    }, { timeoutMs: 30_000, idleTimeoutMs: 45_000, maxRetries: 0 });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(`Servstation reverse event stream failed: ${text || `HTTP ${response.status}`}`);
    }
    await this.host.updateReverseState({
      enabled: true,
      status: "connecting",
      peerId,
      connectedAt: undefined,
      lastHeartbeatAt: undefined,
      lastError: undefined
    });
    const heartbeatEveryMs = reverseClientHeartbeatIntervalMs(registration);
    let heartbeatInFlight: Promise<void> | undefined;
    const postHeartbeat = (): Promise<void> => {
      if (heartbeatInFlight) {
        return heartbeatInFlight;
      }
      heartbeatInFlight = this.request(baseUrl, heartbeatPath(agentInstanceId, peerId), {
        method: "POST",
        signal,
        body: JSON.stringify({ at: this.host.nowIso(), agentInstanceId, peerId })
      })
        .then(() => this.host.updateReverseState({
          status: "connected",
          connectedAt: connectedAtFor(this.host.getConfig().reverse, this.host.nowIso()),
          peerId,
          lastHeartbeatAt: this.host.nowIso(),
          lastError: undefined
        }))
        .catch((error) => {
          if (!isRecoverableHeartbeatError(error)) {
            throw error;
          }
          return this.host.updateReverseState({
            status: "connected",
            connectedAt: connectedAtFor(this.host.getConfig().reverse, this.host.nowIso()),
            peerId,
            lastHeartbeatAt: undefined,
            lastError: undefined
          });
        })
        .finally(() => {
          heartbeatInFlight = undefined;
        });
      return heartbeatInFlight;
    };
    await postHeartbeat();
    const heartbeatTimer = setInterval(() => {
      void postHeartbeat().catch((error) => {
        if (signal.aborted) {
          return;
        }
        void this.host.updateReverseState({
          status: "error",
          connectedAt: undefined,
          lastHeartbeatAt: undefined,
          lastError: (error as Error).message || "Servstation reverse heartbeat failed."
        }).catch((updateError) => console.error("Failed to persist reverse heartbeat error", updateError));
        void response.body?.cancel().catch(() => undefined);
      });
    }, heartbeatEveryMs);
    heartbeatTimer.unref?.();

    try {
      for await (const event of parseSse(response.body, signal)) {
        if (event.event === "heartbeat") {
          await postHeartbeat();
          continue;
        }
        if (event.event === "invoke_prompt") {
          void this.handleInvocation(baseUrl, agentInstanceId, peerId, event, signal)
            .catch((error) => console.error("Reverse prompt invocation failed", error));
          continue;
        }
        if (event.event === "snapshot_request") {
          void this.handleSnapshotRequest(baseUrl, agentInstanceId, peerId, event, signal)
            .catch((error) => console.error("Reverse snapshot request failed", error));
          continue;
        }
        if (event.event === "transcript_request") {
          void this.handleTranscriptRequest(baseUrl, agentInstanceId, peerId, event, signal)
            .catch((error) => console.error("Reverse transcript request failed", error));
        }
      }
      if (!signal.aborted) {
        throw new Error("Servstation reverse event stream ended.");
      }
    } finally {
      clearInterval(heartbeatTimer);
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
        body: JSON.stringify({ requestId, agentInstanceId, peerId })
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
        body: JSON.stringify({ ...result, requestId, agentInstanceId, peerId })
      });
    } catch (error) {
      await this.request(baseUrl, invocationPath(agentInstanceId, peerId, invocationId, "result"), {
        method: "POST",
        signal,
        body: JSON.stringify({
          status: "failed",
          requestId,
          agentInstanceId,
          peerId,
          error: (error as Error).message
        })
      }).catch(() => undefined);
    }
  }

  private async handleSnapshotRequest(
    baseUrl: string,
    agentInstanceId: string,
    peerId: string,
    event: SseEvent,
    signal: AbortSignal
  ): Promise<void> {
    const requestId = requestIdFromEvent(event);
    try {
      await this.ackRequest(baseUrl, agentInstanceId, peerId, requestId, signal);
      await this.completeRequest(baseUrl, agentInstanceId, peerId, requestId, toSupbotSnapshot(this.host.getSnapshot()), signal);
    } catch (error) {
      await this.failRequest(baseUrl, agentInstanceId, peerId, requestId, error, signal);
    }
  }

  private async handleTranscriptRequest(
    baseUrl: string,
    agentInstanceId: string,
    peerId: string,
    event: SseEvent,
    signal: AbortSignal
  ): Promise<void> {
    const payload = safeJson(event.data) as ReverseRequestEvent;
    const requestId = requiredString(payload.requestId || event.id, "requestId");
    try {
      const conversationId = requiredString(payload.conversationId, "conversationId");
      await this.ackRequest(baseUrl, agentInstanceId, peerId, requestId, signal);
      const transcript = await this.host.loadTranscript(conversationId);
      const conversation = this.host.getSnapshot().conversations.find((item) => item.id === conversationId);
      await this.completeRequest(baseUrl, agentInstanceId, peerId, requestId, {
        conversation: conversation ? toSupbotConversation(conversation) : undefined,
        messages: transcript.activeMessages.map(toSupbotMessage),
        source: transcript.source,
        diagnostics: transcript.diagnostics
      }, signal);
    } catch (error) {
      await this.failRequest(baseUrl, agentInstanceId, peerId, requestId, error, signal);
    }
  }

  private ackRequest(
    baseUrl: string,
    agentInstanceId: string,
    peerId: string,
    requestId: string,
    signal: AbortSignal
  ): Promise<unknown> {
    return this.request(baseUrl, requestPath(agentInstanceId, peerId, requestId, "ack"), {
      method: "POST",
      signal,
      body: JSON.stringify({ agentInstanceId, peerId })
    });
  }

  private completeRequest(
    baseUrl: string,
    agentInstanceId: string,
    peerId: string,
    requestId: string,
    result: unknown,
    signal: AbortSignal
  ): Promise<unknown> {
    return this.request(baseUrl, requestPath(agentInstanceId, peerId, requestId, "result"), {
      method: "POST",
      signal,
      body: JSON.stringify({ status: "completed", agentInstanceId, peerId, result })
    });
  }

  private failRequest(
    baseUrl: string,
    agentInstanceId: string,
    peerId: string,
    requestId: string,
    error: unknown,
    signal: AbortSignal
  ): Promise<unknown> {
    return this.request(baseUrl, requestPath(agentInstanceId, peerId, requestId, "result"), {
      method: "POST",
      signal,
      body: JSON.stringify({
        status: "failed",
        agentInstanceId,
        peerId,
        error: (error as Error).message
      })
    }).catch(() => undefined);
  }

  private async request<T = unknown>(baseUrl: string, path: string, init: RequestInit): Promise<T> {
    const response = await fetchWithRetry(joinUrl(baseUrl, path), {
      ...init,
      headers: {
        ...await this.headers(init.signal instanceof AbortSignal ? init.signal : undefined),
        ...(init.headers || {})
      }
    }, { timeoutMs: 30_000, idleTimeoutMs: 30_000, maxRetries: 2 });
    const text = await response.text();
    const payload = text.trim() ? safeJson(text) : {};
    if (!response.ok) {
      throw new ServstationHttpError(errorMessage(payload) || text || `HTTP ${response.status}`, response.status, payload);
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

  private waitBeforeRetry(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (this.wakeRetry === finish) {
          this.wakeRetry = undefined;
        }
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wakeRetry = finish;
    });
  }
}

function invocationPath(agentInstanceId: string, peerId: string, invocationId: string, action: "ack" | "result"): string {
  return `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/a2a-peers/${encodeURIComponent(peerId)}/invocations/${encodeURIComponent(invocationId)}/${action}`;
}

function requestPath(agentInstanceId: string, peerId: string, requestId: string, action: "ack" | "result"): string {
  return `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/a2a-peers/${encodeURIComponent(peerId)}/requests/${encodeURIComponent(requestId)}/${action}`;
}

function heartbeatPath(agentInstanceId: string, peerId: string): string {
  return `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/a2a-peers/${encodeURIComponent(peerId)}/heartbeat`;
}

function requestIdFromEvent(event: SseEvent): string {
  const payload = safeJson(event.data) as ReverseRequestEvent;
  return requiredString(payload.requestId || event.id, "requestId");
}

function toSupbotSnapshot(snapshot: RuntimeSnapshot): Record<string, unknown> {
  const conversations = snapshot.conversations.map(toSupbotConversation);
  return {
    status: snapshot.status,
    activeConversationId: conversations[0]?.id,
    conversations
  };
}

function toSupbotConversation(conversation: RuntimeSnapshot["conversations"][number]): Record<string, unknown> {
  const lastMessage = conversation.messages.at(-1);
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastMessageAt: conversation.lastMessageAt,
    lastMessage: lastMessage?.text,
    messageCount: conversation.messages.length
  };
}

function toSupbotMessage(message: ChatMessage): Record<string, unknown> {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
    jobId: message.jobId,
    status: message.status,
    attachments: message.attachments,
    generatedFiles: message.generatedFiles
  };
}

class ServstationHttpError extends Error {
  constructor(message: string, readonly status: number, readonly payload: unknown) {
    super(message);
    this.name = "ServstationHttpError";
  }
}

function isRecoverableReverseRegistrationError(error: unknown): boolean {
  if (!(error instanceof ServstationHttpError) || error.status !== 400) {
    return false;
  }
  return error.message.toLowerCase().includes("invalid input syntax for type json");
}

function isRecoverableHeartbeatError(error: unknown): boolean {
  if (!(error instanceof ServstationHttpError)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (error.status === 400 && message.includes("missing agent instance id"))
    || error.status === 404
    || error.status === 405;
}

function reverseClientHeartbeatIntervalMs(registration: ReverseRegisterResponse): number {
  const heartbeatMs = positiveFinite(registration.heartbeatMs);
  const timeoutMs = positiveFinite(registration.clientHeartbeatTimeoutMs);
  const interval = Math.min(
    heartbeatMs ?? 15_000,
    timeoutMs ? Math.max(1_000, Math.floor(timeoutMs / 2)) : 15_000
  );
  return Math.max(1_000, Math.min(30_000, interval));
}

function connectedAtFor(
  reverse: ReturnType<ReverseBridgeHost["getConfig"]>["reverse"] | undefined,
  now: string
): string {
  return reverse?.status === "connected" && reverse.connectedAt ? reverse.connectedAt : now;
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
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
