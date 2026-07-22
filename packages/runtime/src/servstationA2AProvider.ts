import type { IdentityContext, ServstationA2AConfig, ServstationA2AConfigUpdate } from "@supbot/shared";
import type { ToolDefinition, ToolExecutionResult, ToolProvider } from "./toolRegistry";

interface ServstationA2AHost {
  getConfig(): ServstationA2AConfig;
  getAccessToken(signal?: AbortSignal): Promise<string | undefined>;
  getIdentityContext(): IdentityContext | undefined;
  updateConfig(input: ServstationA2AConfigUpdate): Promise<ServstationA2AConfig>;
  randomId(prefix: string): string;
}

interface AgentConnectResponse {
  agentInstanceId?: string;
  connectionMode?: string;
  sessionToken?: string;
}

interface AgentConversation {
  id?: string;
  conversationId?: string;
}

interface AgentSessionJob {
  id?: string;
  status?: string;
  conversationId?: string;
  result?: unknown;
  error?: unknown;
  progress?: unknown;
}

interface AgentJobsResponse {
  jobs?: AgentSessionJob[];
}

interface WaitForJobResult {
  job?: AgentSessionJob;
  timedOut: boolean;
}

export class ServstationA2AProvider implements ToolProvider {
  constructor(private readonly host: ServstationA2AHost) {}

  list(): ToolDefinition[] {
    const config = this.host.getConfig();
    if (!config.enabled) {
      return [];
    }
    return [
      {
        name: "ServstationConnect",
        modelName: "servstation_connect",
        description:
          "Connect to the paired Servstation agent using HBClient's bound identity context and return the agent instance id.",
        risk: "dangerous",
        concurrency: "exclusive",
        interruptBehavior: "cancel",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        summarize() {
          return "Connect to Servstation";
        },
        execute: async (_input, context) => {
          const connected = await this.connect(context.signal);
          return {
            text: JSON.stringify(
              {
                agentInstanceId: connected.agentInstanceId,
                connectionMode: connected.connectionMode || "unknown",
              },
              null,
              2,
            ),
          };
        },
      },
      {
        name: "ServstationPrompt",
        modelName: "servstation_prompt",
        description:
          "Send a prompt to the paired Servstation agent. Creates a Servstation conversation when conversationId is omitted.",
        risk: "dangerous",
        concurrency: "exclusive",
        interruptBehavior: "cancel",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Prompt to enqueue on Servstation." },
            conversationId: { type: "string", description: "Optional Servstation conversation id to continue." },
            requestId: { type: "string", description: "Optional idempotency/request id." },
            waitForResult: {
              type: "boolean",
              description: "Wait for the remote Servstation job result before returning. Defaults to true.",
            },
            timeoutMs: {
              type: "number",
              description: "Maximum time to wait for the remote result. Defaults to 120000 ms.",
            },
            pollIntervalMs: {
              type: "number",
              description: "Polling interval while waiting for the remote result. Defaults to 1000 ms.",
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
        summarize(input) {
          const parsed = objectInput(input);
          return `Send Servstation prompt ${String(parsed.prompt || "").slice(0, 120)}`;
        },
        execute: async (input, context) => this.sendPrompt(input, context.signal),
      },
    ];
  }

  private async sendPrompt(input: unknown, signal: AbortSignal): Promise<ToolExecutionResult> {
    const parsed = objectInput(input);
    const prompt = requiredString(parsed.prompt, "prompt");
    const requestId =
      typeof parsed.requestId === "string" && parsed.requestId.trim()
        ? parsed.requestId.trim()
        : this.host.randomId("a2a_req");
    const waitForResult = parsed.waitForResult !== false;
    const timeoutMs = numberInput(parsed.timeoutMs, 120_000, 1_000, 300_000);
    const pollIntervalMs = numberInput(parsed.pollIntervalMs, 1_000, 250, 10_000);
    const connected = await this.connect(signal);
    const agentInstanceId = requiredString(connected.agentInstanceId, "agentInstanceId");
    const conversationId =
      typeof parsed.conversationId === "string" && parsed.conversationId.trim()
        ? parsed.conversationId.trim()
        : await this.createConversation(agentInstanceId, signal);
    const job = await this.request<AgentSessionJob>(`/api/v1/agent/${encodeURIComponent(agentInstanceId)}/jobs`, {
      method: "POST",
      signal,
      body: JSON.stringify({
        requestId,
        clientId: "supbot-a2a",
        jobType: "interactive",
        conversationId,
        payload: {
          prompt,
          requestId,
          source: "supbot-a2a",
        },
      }),
    });
    const resultConversationId = job.conversationId || conversationId;
    const waited =
      waitForResult && job.id
        ? await this.waitForJob(agentInstanceId, job.id, resultConversationId, timeoutMs, pollIntervalMs, signal)
        : { job, timedOut: false };
    const finalJob = waited.job || job;
    const remoteResult = compactRemoteJobResult(finalJob.result);
    return {
      text: JSON.stringify(
        {
          agentInstanceId,
          conversationId: finalJob.conversationId || resultConversationId,
          jobId: finalJob.id || job.id,
          status: finalJob.status || job.status || "queued",
          requestId,
          timedOut: waited.timedOut || undefined,
          assistantText: assistantTextFromResult(remoteResult),
          result: remoteResult,
          error: finalJob.error,
          progress: finalJob.progress,
        },
        null,
        2,
      ),
    };
  }

  private async waitForJob(
    agentInstanceId: string,
    jobId: string,
    conversationId: string,
    timeoutMs: number,
    pollIntervalMs: number,
    signal: AbortSignal,
  ): Promise<WaitForJobResult> {
    const startedAt = Date.now();
    let latest: AgentSessionJob | undefined;
    while (Date.now() - startedAt <= timeoutMs) {
      const response = await this.request<AgentJobsResponse>(
        `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/jobs?conversationId=${encodeURIComponent(conversationId)}`,
        { method: "GET", signal },
      );
      latest = Array.isArray(response.jobs) ? response.jobs.find((item) => item.id === jobId) : latest;
      if (latest?.status && isTerminalJobStatus(latest.status)) {
        return { job: latest, timedOut: false };
      }
      await sleep(pollIntervalMs, signal);
    }
    return { job: latest, timedOut: true };
  }

  private async connect(signal: AbortSignal): Promise<AgentConnectResponse> {
    const current = this.host.getConfig();
    const response = await this.request<AgentConnectResponse>("/api/v1/agent/connect", {
      method: "POST",
      signal,
      body: JSON.stringify({ clientId: "supbot-a2a" }),
    });
    if (response.agentInstanceId && response.agentInstanceId !== current.agentInstanceId) {
      await this.host.updateConfig({ agentInstanceId: response.agentInstanceId });
    }
    return response;
  }

  private async createConversation(agentInstanceId: string, signal: AbortSignal): Promise<string> {
    const conversation = await this.request<AgentConversation>(
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/conversations`,
      {
        method: "POST",
        signal,
        body: JSON.stringify({ clientId: "supbot-a2a" }),
      },
    );
    const id = conversation.id || conversation.conversationId;
    if (!id) {
      throw new Error("Servstation did not return a conversation id.");
    }
    return id;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const config = this.host.getConfig();
    const baseUrl = normalizeBaseUrl(config.baseUrl || this.host.getIdentityContext()?.servstationUrl);
    if (!baseUrl) {
      throw new Error("Servstation A2A base URL is not configured.");
    }
    const identity = this.host.getIdentityContext();
    if (!identity) {
      throw new Error("Servstation A2A identity context is not paired.");
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-tenant-id": identity.tenantId,
      "x-organization-id": identity.organizationId,
      "x-department-id": identity.departmentId,
      "x-user-id": identity.userId,
      "x-role-ids": identity.roleIds.join(","),
    };
    const token = await this.host.getAccessToken(init.signal instanceof AbortSignal ? init.signal : undefined);
    if (config.authMode === "bearer" || config.authMode === "oidc") {
      if (!token) {
        throw new Error(`Servstation A2A ${config.authMode} token is not configured.`);
      }
      headers.Authorization = `Bearer ${token}`;
    } else if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        ...headers,
        ...(init.headers || {}),
      },
    });
    const text = await response.text();
    const payload = text ? safeJson(text) : {};
    if (!response.ok) {
      const message = errorMessage(payload) || text || `HTTP ${response.status}`;
      throw new Error(`Servstation A2A ${path} failed: ${message}`);
    }
    return payload as T;
  }
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function errorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return typeof record.error === "string"
    ? record.error
    : typeof record.message === "string"
      ? record.message
      : undefined;
}

function objectInput(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

function numberInput(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function isTerminalJobStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new Error("Servstation A2A wait aborted."));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Servstation A2A wait aborted."));
      },
      { once: true },
    );
  });
}

function compactRemoteJobResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const record = result as Record<string, unknown>;
  return removeUndefined({
    assistantText: typeof record.assistantText === "string" ? record.assistantText : undefined,
    assistantMessages: stringArray(record.assistantMessages),
    statusEvents: stringArray(record.statusEvents),
    usage: record.usage && typeof record.usage === "object" ? record.usage : undefined,
    model: typeof record.model === "string" ? record.model : undefined,
    mode: typeof record.mode === "string" ? record.mode : undefined,
    cwd: typeof record.cwd === "string" ? record.cwd : undefined,
    toolCallCount: Array.isArray(record.toolCalls) ? record.toolCalls.length : undefined,
    generatedFiles: Array.isArray(record.generatedFiles) ? record.generatedFiles : undefined,
    output: typeof record.output === "string" ? record.output : undefined,
    text: typeof record.text === "string" ? record.text : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  });
}

function assistantTextFromResult(result: unknown): string | undefined {
  if (typeof result === "string") {
    return result;
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  if (typeof record.assistantText === "string" && record.assistantText.trim()) {
    return record.assistantText;
  }
  const messages = stringArray(record.assistantMessages);
  if (messages?.length) {
    return messages.join("\n");
  }
  for (const key of ["output", "text", "message"]) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return record[key];
    }
  }
  return undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  return items.length ? items : undefined;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
