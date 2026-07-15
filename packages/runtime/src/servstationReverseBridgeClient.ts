import type {
  AutopilotRun,
  AutopilotStartDataRunInput,
  IdentityContext,
  RuntimeSnapshot,
  ScheduledJob,
  ScheduledJobInput,
  ServstationA2AConfig,
  ServstationA2AConfigUpdate,
  ServstationA2AReverseConfig,
  TranscriptLoadResult
} from "@supbot/shared";

interface ReverseBridgeHost {
  getConfig(): ServstationA2AConfig;
  getAccessToken(signal?: AbortSignal): Promise<string | undefined>;
  getIdentityContext(): IdentityContext | undefined;
  updateConfig(input: ServstationA2AConfigUpdate): Promise<ServstationA2AConfig>;
  updateReverseState(input: Partial<ServstationA2AReverseConfig>): Promise<void>;
  sendReadOnlyPromptAndWait(input: ReversePromptInput): Promise<ReversePromptResult>;
  getSnapshot(): RuntimeSnapshot;
  loadTranscript(conversationId: string): Promise<TranscriptLoadResult>;
  createScheduledJob(input: ScheduledJobInput): Promise<ScheduledJob>;
  updateScheduledJob(id: string, input: Partial<ScheduledJobInput>): Promise<ScheduledJob>;
  deleteScheduledJob(id: string): Promise<void>;
  startAutopilotDataRun(input: AutopilotStartDataRunInput): Promise<AutopilotRun>;
  pauseAutopilotRun(id: string): Promise<AutopilotRun>;
  resumeAutopilotRun(id: string): Promise<AutopilotRun>;
  cancelAutopilotRun(id: string): Promise<AutopilotRun>;
  randomId(prefix: string): string;
  nowIso(): string;
}

export const SERVSTATION_PROJECT_AWARE_CAPABILITY = "conversation.projectAware";
export const SERVSTATION_SCHEDULE_MANAGE_CAPABILITY = "schedule.manage";
export const SERVSTATION_AUTOPILOT_MANAGE_CAPABILITY = "autopilot.manage";

export interface ReversePromptInput {
  prompt: string;
  conversationId?: string;
  projectId?: string;
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
  clientHeartbeatTimeoutMs?: number;
}

interface ReversePeerLink {
  id?: string;
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
  projectId?: string;
  timeoutMs?: number;
  userContext?: IdentityContext;
  agentInstanceId?: string;
}

interface ReverseRequestEvent {
  requestId?: string;
  conversationId?: string;
  action?: string;
  payload?: unknown;
}

export interface ReverseWorkspaceSnapshot {
  status: RuntimeSnapshot["status"];
  scheduledJobs: ScheduledJob[];
  autopilotRuns: Array<Pick<AutopilotRun,
    "id" | "projectId" | "title" | "goal" | "status" | "currentStage" | "taskIds" | "artifactIds" |
    "error" | "createdAt" | "updatedAt" | "startedAt" | "finishedAt"
  >>;
  autopilotTasks: Array<Pick<RuntimeSnapshot["autopilotTasks"][number],
    "id" | "runId" | "projectId" | "stage" | "staffAgent" | "title" | "status" | "attempts" |
    "maxAttempts" | "artifactIds" | "error" | "startedAt" | "finishedAt" | "createdAt" | "updatedAt"
  >>;
  autopilotEvents: Array<Pick<RuntimeSnapshot["autopilotEvents"][number],
    "id" | "runId" | "projectId" | "taskId" | "level" | "message" | "createdAt"
  >>;
  dataArtifacts: Array<Pick<RuntimeSnapshot["dataArtifacts"][number],
    "id" | "projectId" | "runId" | "taskId" | "kind" | "stage" | "name" | "size" | "lineCount" | "createdAt"
  >>;
  fetchedAt: string;
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
    this.loop = this.runLoop().finally(() => {
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
    const clientInstanceId = config.reverse?.clientInstanceId || this.host.randomId("hbclient");
    await this.host.updateReverseState({ enabled: true, status: "connecting", clientInstanceId });
    const agentInstanceId = await this.ensureAgentInstanceId(baseUrl, signal);
    const registration = await this.registerReverseConnection(baseUrl, agentInstanceId, clientInstanceId, signal);
    const peerId = registration.peer?.id;
    if (!peerId) {
      throw new Error("Botstation HBClient reverse registration did not return a peer id.");
    }
    const streamUrl = registration.streamUrl || `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/a2a-peers/${encodeURIComponent(peerId)}/events`;
    await this.host.updateReverseState({
      enabled: true,
      status: "connected",
      peerId,
      clientInstanceId,
      connectedAt: this.host.nowIso(),
      lastError: undefined
    });
    await this.openEventStream(baseUrl, streamUrl, agentInstanceId, peerId, signal);
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
            clientInstanceId,
            displayName: "HBClient Desktop",
            capabilities: [
              "prompt.readOnly",
              SERVSTATION_PROJECT_AWARE_CAPABILITY,
              SERVSTATION_SCHEDULE_MANAGE_CAPABILITY,
              SERVSTATION_AUTOPILOT_MANAGE_CAPABILITY
            ],
            hbclientVersion: "0.1.0"
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
      body: JSON.stringify({ clientId: "hbclient-reverse-a2a" })
    });
    const agentInstanceId = connected.agentInstanceId;
    if (!agentInstanceId) {
      throw new Error("Botstation connect did not return an agent instance id.");
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
      throw new Error(`Botstation HBClient reverse event stream failed: ${text || `HTTP ${response.status}`}`);
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
        try {
          await this.request(baseUrl, heartbeatPath(agentInstanceId, peerId), {
            method: "POST",
            signal,
            body: JSON.stringify({ at: this.host.nowIso() })
          });
        } catch (error) {
          if (!isRecoverableHeartbeatError(error)) {
            throw error;
          }
        }
        await this.host.updateReverseState({
          status: "connected",
          lastHeartbeatAt: this.host.nowIso(),
          lastError: undefined
        });
        continue;
      }
      if (event.event === "invoke_prompt") {
        void this.handleInvocation(baseUrl, agentInstanceId, peerId, event, signal);
        continue;
      }
      if (event.event === "snapshot_request") {
        void this.handleSnapshotRequest(baseUrl, agentInstanceId, peerId, event, signal);
        continue;
      }
      if (event.event === "transcript_request") {
        void this.handleTranscriptRequest(baseUrl, agentInstanceId, peerId, event, signal);
        continue;
      }
      if (event.event === "workspace_snapshot_request") {
        void this.handleWorkspaceSnapshotRequest(baseUrl, agentInstanceId, peerId, event, signal);
        continue;
      }
      if (event.event === "workspace_action") {
        void this.handleWorkspaceAction(baseUrl, agentInstanceId, peerId, event, signal);
      }
    }
    if (!signal.aborted) {
      throw new Error("Botstation HBClient reverse event stream ended.");
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
        projectId: payload.projectId,
        timeoutMs: normalizeTimeout(payload.timeoutMs),
        signal,
        remoteCaller: {
          requestId,
          agentInstanceId: payload.agentInstanceId || agentInstanceId,
          peerId,
          clientId: "hbclient-reverse",
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

  private async handleSnapshotRequest(
    baseUrl: string,
    agentInstanceId: string,
    peerId: string,
    event: SseEvent,
    signal: AbortSignal
  ): Promise<void> {
    const payload = safeJson(event.data) as ReverseRequestEvent;
    const requestId = requiredString(payload.requestId || event.id, "requestId");
    try {
      await this.request(baseUrl, requestPath(agentInstanceId, peerId, requestId, "ack"), {
        method: "POST",
        signal,
        body: JSON.stringify({ requestId })
      });
      const snapshot = this.host.getSnapshot();
      await this.request(baseUrl, requestPath(agentInstanceId, peerId, requestId, "result"), {
        method: "POST",
        signal,
        body: JSON.stringify({ status: "completed", result: snapshot })
      });
    } catch (error) {
      await this.request(baseUrl, requestPath(agentInstanceId, peerId, requestId, "result"), {
        method: "POST",
        signal,
        body: JSON.stringify({ status: "failed", error: (error as Error).message })
      }).catch(() => undefined);
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
      await this.request(baseUrl, requestPath(agentInstanceId, peerId, requestId, "ack"), {
        method: "POST",
        signal,
        body: JSON.stringify({ requestId })
      });
      const transcript = await this.host.loadTranscript(conversationId);
      await this.request(baseUrl, requestPath(agentInstanceId, peerId, requestId, "result"), {
        method: "POST",
        signal,
        body: JSON.stringify({ status: "completed", result: transcript })
      });
    } catch (error) {
      await this.request(baseUrl, requestPath(agentInstanceId, peerId, requestId, "result"), {
        method: "POST",
        signal,
        body: JSON.stringify({ status: "failed", error: (error as Error).message })
      }).catch(() => undefined);
    }
  }

  private async handleWorkspaceSnapshotRequest(
    baseUrl: string,
    agentInstanceId: string,
    peerId: string,
    event: SseEvent,
    signal: AbortSignal
  ): Promise<void> {
    const payload = safeJson(event.data) as ReverseRequestEvent;
    const requestId = requiredString(payload.requestId || event.id, "requestId");
    try {
      await this.request(baseUrl, requestPath(agentInstanceId, peerId, requestId, "ack"), {
        method: "POST",
        signal,
        body: JSON.stringify({ requestId })
      });
      const workspace = buildReverseWorkspaceSnapshot(this.host.getSnapshot(), this.host.nowIso());
      await this.request(baseUrl, requestPath(agentInstanceId, peerId, requestId, "result"), {
        method: "POST",
        signal,
        body: JSON.stringify({ status: "completed", result: workspace })
      });
    } catch (error) {
      await this.request(baseUrl, requestPath(agentInstanceId, peerId, requestId, "result"), {
        method: "POST",
        signal,
        body: JSON.stringify({ status: "failed", error: (error as Error).message })
      }).catch(() => undefined);
    }
  }

  private async handleWorkspaceAction(
    baseUrl: string,
    agentInstanceId: string,
    peerId: string,
    event: SseEvent,
    signal: AbortSignal
  ): Promise<void> {
    const request = safeJson(event.data) as ReverseRequestEvent;
    const requestId = requiredString(request.requestId || event.id, "requestId");
    try {
      const action = requiredString(request.action, "workspace action");
      const payload = objectValue(request.payload);
      await this.request(baseUrl, requestPath(agentInstanceId, peerId, requestId, "ack"), {
        method: "POST",
        signal,
        body: JSON.stringify({ requestId })
      });
      const result = await this.executeWorkspaceAction(action, payload);
      await this.request(baseUrl, requestPath(agentInstanceId, peerId, requestId, "result"), {
        method: "POST",
        signal,
        body: JSON.stringify({ status: "completed", result })
      });
    } catch (error) {
      await this.request(baseUrl, requestPath(agentInstanceId, peerId, requestId, "result"), {
        method: "POST",
        signal,
        body: JSON.stringify({ status: "failed", error: (error as Error).message })
      }).catch(() => undefined);
    }
  }

  private async executeWorkspaceAction(action: string, payload: Record<string, unknown>): Promise<unknown> {
    switch (action) {
      case "schedule.create":
        return this.host.createScheduledJob(scheduledJobInput(payload));
      case "schedule.update":
        return this.host.updateScheduledJob(requiredString(payload.id, "scheduled job id"), {
          enabled: requiredBoolean(payload.enabled, "enabled")
        });
      case "schedule.delete":
        await this.host.deleteScheduledJob(requiredString(payload.id, "scheduled job id"));
        return { status: "ok" };
      case "autopilot.start":
        return this.host.startAutopilotDataRun({
          projectId: requiredString(payload.projectId, "project id"),
          goal: requiredString(payload.goal, "autopilot goal"),
          title: optionalString(payload.title),
          dataSources: []
        });
      case "autopilot.pause":
        return this.host.pauseAutopilotRun(requiredString(payload.id, "autopilot run id"));
      case "autopilot.resume":
        return this.host.resumeAutopilotRun(requiredString(payload.id, "autopilot run id"));
      case "autopilot.cancel":
        return this.host.cancelAutopilotRun(requiredString(payload.id, "autopilot run id"));
      default:
        throw new Error(`Unsupported workspace action: ${action}`);
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
      throw new Error("Botstation HBClient reverse A2A identity context is not paired.");
    }
    return identity;
  }

  private requireBaseUrl(config: ServstationA2AConfig, identity: IdentityContext): string {
    const baseUrl = normalizeBaseUrl(config.baseUrl || identity.servstationUrl);
    if (!baseUrl) {
      throw new Error("Botstation HBClient reverse A2A base URL is not configured.");
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function scheduledJobInput(payload: Record<string, unknown>): ScheduledJobInput {
  const scheduleKind = requiredString(payload.scheduleKind, "schedule kind");
  if (scheduleKind !== "once" && scheduleKind !== "daily" && scheduleKind !== "cron") {
    throw new Error(`Unsupported schedule kind: ${scheduleKind}`);
  }
  const runAt = optionalString(payload.runAt);
  const cronExpr = optionalString(payload.cronExpr);
  if ((scheduleKind === "once" || scheduleKind === "daily") && !runAt) {
    throw new Error("runAt is required.");
  }
  if (runAt && Number.isNaN(Date.parse(runAt))) {
    throw new Error("runAt must be a valid ISO timestamp.");
  }
  if (scheduleKind === "cron" && !cronExpr) {
    throw new Error("cronExpr is required.");
  }
  return {
    projectId: optionalString(payload.projectId),
    title: requiredString(payload.title, "scheduled job title"),
    prompt: requiredString(payload.prompt, "scheduled job prompt"),
    scheduleKind,
    runAt,
    cronExpr,
    enabled: typeof payload.enabled === "boolean" ? payload.enabled : true
  };
}

export function buildReverseWorkspaceSnapshot(snapshot: RuntimeSnapshot, fetchedAt: string): ReverseWorkspaceSnapshot {
  return {
    status: snapshot.status,
    scheduledJobs: snapshot.scheduledJobs.map((job) => ({
      id: job.id,
      projectId: job.projectId,
      title: job.title,
      prompt: job.prompt,
      scheduleKind: job.scheduleKind,
      runAt: job.runAt,
      cronExpr: job.cronExpr,
      enabled: job.enabled,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      lastRunAt: job.lastRunAt,
      nextRunAt: job.nextRunAt
    })),
    autopilotRuns: snapshot.autopilotRuns.map((run) => ({
      id: run.id,
      projectId: run.projectId,
      title: run.title,
      goal: run.goal,
      status: run.status,
      currentStage: run.currentStage,
      taskIds: run.taskIds,
      artifactIds: run.artifactIds,
      error: run.error,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt
    })),
    autopilotTasks: snapshot.autopilotTasks.map((task) => ({
      id: task.id,
      runId: task.runId,
      projectId: task.projectId,
      stage: task.stage,
      staffAgent: task.staffAgent,
      title: task.title,
      status: task.status,
      attempts: task.attempts,
      maxAttempts: task.maxAttempts,
      artifactIds: task.artifactIds,
      error: task.error,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    })),
    autopilotEvents: snapshot.autopilotEvents.map((event) => ({
      id: event.id,
      runId: event.runId,
      projectId: event.projectId,
      taskId: event.taskId,
      level: event.level,
      message: event.message,
      createdAt: event.createdAt
    })),
    dataArtifacts: snapshot.dataArtifacts.map((artifact) => ({
      id: artifact.id,
      projectId: artifact.projectId,
      runId: artifact.runId,
      taskId: artifact.taskId,
      kind: artifact.kind,
      stage: artifact.stage,
      name: artifact.name,
      size: artifact.size,
      lineCount: artifact.lineCount,
      createdAt: artifact.createdAt
    })),
    fetchedAt
  };
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
