import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { fetchWithRetry } from "./fetchWithRetry";
import type {
  Attachment,
  IdentityContext,
  ServstationA2AConfig,
  ServstationA2AConfigUpdate,
  ServstationAutopilotEvent,
  ServstationAutopilotRun,
  ServstationAutopilotStartInput,
  ServstationAutopilotStep,
  ServstationAutopilotStatusUpdate,
  ServstationClientSnapshot,
  ServstationClientSnapshotQuery,
  ServstationConversation,
  ServstationConversationMessage,
  ServstationDeleteProjectResourceResponse,
  ServstationDeleteProjectResponse,
  ServstationFlowEngineApprovalDecisionInput,
  ServstationFlowEngineExecutionEvent,
  ServstationFlowEngineInitiatedExecution,
  ServstationFlowEngineLaunchInput,
  ServstationFlowEngineLaunchableWorkflow,
  ServstationFlowEnginePendingTask,
  ServstationFlowEngineSnapshot,
  ServstationMailAccount,
  ServstationMailAccountDraft,
  ServstationMailConnectionTestResult,
  ServstationInstalledService,
  ServstationJobFileContent,
  ServstationLocalCapabilityAsset,
  ServstationMessageAttachmentContent,
  ServstationMessageDetail,
  ServstationMessageEvent,
  ServstationMessageFolder,
  ServstationMessageListResponse,
  ServstationMessageUnreadSummary,
  ServstationProject,
  ServstationProjectResource,
  ServstationScheduledJob,
  ServstationScheduledJobInput,
  ServstationServiceDefinition,
  ServstationSendAgentMessageInput,
  ServstationSendDirectMessageInput,
  ServstationSendPromptInput,
  ServstationSendPromptResult,
  ServstationSessionJob,
} from "@supbot/shared";

interface ServstationAgentClientHost {
  getConfig(): ServstationA2AConfig;
  getAccessToken(signal?: AbortSignal): Promise<string | undefined>;
  refreshAccessToken?(signal?: AbortSignal): Promise<string | undefined>;
  getIdentityContext(): IdentityContext | undefined;
  updateConfig(input: ServstationA2AConfigUpdate): Promise<ServstationA2AConfig>;
  randomId(prefix: string): string;
  nowIso(): string;
}

interface ConversationsResponse {
  conversations?: ServstationConversation[];
}

interface ProjectsResponse {
  projects?: ServstationProject[];
}

interface ProjectResourcesResponse {
  resources?: ServstationProjectResource[];
}

interface JobsResponse {
  jobs?: ServstationSessionJob[];
}

interface ScheduledJobsResponse {
  scheduledJobs?: ServstationScheduledJob[];
  tasks?: ServstationScheduledTask[];
}

interface ServicesResponse {
  services?: ServstationServiceDefinition[];
}

interface InstalledServicesResponse {
  services?: ServstationInstalledService[];
}

interface LocalCapabilitiesResponse {
  assets?: ServstationLocalCapabilityAsset[];
}

interface CapabilitySnapshot {
  services: ServstationServiceDefinition[];
  installedServices: ServstationInstalledService[];
  localCapabilities: ServstationLocalCapabilityAsset[];
  capabilityLoadError?: string;
}

interface AutopilotRunResponse {
  run?: ServstationAutopilotRun;
}

interface AutopilotEventResponse {
  events?: ServstationAutopilotEvent[];
}

interface AutopilotStepResponse {
  steps?: ServstationAutopilotStep[];
}

interface FlowEngineLaunchableResponse {
  workflows?: ServstationFlowEngineLaunchableWorkflow[];
  launchableWorkflows?: ServstationFlowEngineLaunchableWorkflow[];
}

interface FlowEnginePendingTasksResponse {
  tasks?: ServstationFlowEnginePendingTask[];
  pendingTasks?: ServstationFlowEnginePendingTask[];
}

interface FlowEngineExecutionsResponse {
  executions?: ServstationFlowEngineInitiatedExecution[];
}

interface FlowEngineExecutionEventsResponse {
  events?: ServstationFlowEngineExecutionEvent[];
}

interface AgentConnectResponse {
  agentInstanceId?: string;
}

interface ServstationScheduledTask {
  id?: string;
  agentInstanceId?: string;
  name?: string;
  title?: string;
  prompt?: string;
  scheduleType?: string;
  scheduleKind?: string;
  cronExpression?: string;
  cronExpr?: string;
  runAt?: string | null;
  status?: string;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface MessageDetailResponse {
  message?: ServstationMessageDetail;
}

interface MessageStateResponse {
  message?: ServstationMessageDetail;
}

interface MessageAttachmentResponse {
  attachment?: ServstationMessageAttachmentContent;
}

interface MailAccountsResponse {
  accounts?: ServstationMailAccount[];
}

interface MailAccountResponse {
  account?: ServstationMailAccount;
}

interface PromptAttachment {
  name: string;
  mimeType: string;
  size: number;
  contentBase64: string;
}

const CLIENT_ID = "supbot-server-agent-client";
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "canceled", "cancelled"]);
const TERMINAL_AUTOPILOT_STATUSES = new Set(["completed", "failed", "stopped"]);
const AUTOPILOT_STREAM_RETRY_MS = 1_500;
const SSE_FRAME_BOUNDARY = /\r?\n\r?\n/;

export class ServstationAgentClient {
  constructor(private readonly host: ServstationAgentClientHost) {}

  async connect(signal?: AbortSignal): Promise<string> {
    return this.ensureAgentInstanceId(signal);
  }

  async snapshot(query: ServstationClientSnapshotQuery = {}, signal?: AbortSignal): Promise<ServstationClientSnapshot> {
    const config = this.host.getConfig();
    const identity = this.host.getIdentityContext();
    const reverse = config.reverse;
    const reverseStatus = reverse?.status || "disconnected";
    const baseUrl = normalizeBaseUrl(config.baseUrl || identity?.servstationUrl);
    const connected = reverseStatus === "connected";
    const baseSnapshot = {
      connected,
      reverseStatus,
      baseUrl,
      agentInstanceId: config.agentInstanceId || identity?.agentInstanceId,
      identity,
      lastError: reverse?.lastError,
      activeConversationId: query.conversationId,
      projects: [],
      conversations: [],
      jobs: [],
      scheduledJobs: [],
      services: [],
      installedServices: [],
      localCapabilities: [],
      autopilotRun: null,
      autopilotEvents: [],
      autopilotSteps: [],
      fetchedAt: this.host.nowIso(),
    } satisfies ServstationClientSnapshot;
    if (!connected) {
      return baseSnapshot;
    }
    const agentInstanceId = await this.ensureAgentInstanceId(signal);
    const [projects, conversations, scheduledJobs, currentAutopilot, capabilities] = await Promise.all([
      this.listProjects(agentInstanceId, signal),
      this.listConversations(agentInstanceId, signal),
      this.listScheduledJobs(agentInstanceId, signal),
      this.fetchCurrentAutopilotRun(agentInstanceId, signal),
      this.fetchCapabilitySnapshot(agentInstanceId, signal),
    ]);
    const activeConversationId =
      query.conversationId && conversations.some((item) => item.id === query.conversationId)
        ? query.conversationId
        : conversations[0]?.id;
    const selectedConversation = conversations.find((conversation) => conversation.id === activeConversationId);
    const [jobs, hydratedConversation, autopilotEvents, autopilotSteps] = await Promise.all([
      activeConversationId ? this.listJobs(agentInstanceId, activeConversationId, signal) : Promise.resolve([]),
      selectedConversation
        ? this.fetchConversation(agentInstanceId, selectedConversation, signal)
        : Promise.resolve(undefined),
      currentAutopilot?.id
        ? this.fetchAutopilotEvents(agentInstanceId, currentAutopilot.id, signal)
        : Promise.resolve([]),
      currentAutopilot?.id
        ? this.fetchAutopilotStepsForAgent(agentInstanceId, currentAutopilot.id, signal)
        : Promise.resolve([]),
    ]);
    const hydratedConversations = hydratedConversation
      ? conversations.map((conversation) =>
          conversation.id === hydratedConversation.id ? hydratedConversation : conversation,
        )
      : conversations;
    return {
      ...baseSnapshot,
      agentInstanceId,
      activeConversationId,
      projects,
      conversations: hydratedConversations,
      jobs,
      scheduledJobs,
      services: capabilities.services,
      installedServices: capabilities.installedServices,
      localCapabilities: capabilities.localCapabilities,
      capabilityLoadError: capabilities.capabilityLoadError,
      autopilotRun: currentAutopilot,
      autopilotEvents,
      autopilotSteps,
      fetchedAt: this.host.nowIso(),
    };
  }

  async createProject(name: string, signal?: AbortSignal): Promise<ServstationProject> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    return this.request<ServstationProject>(`/api/v1/agent/${encodeURIComponent(agentInstanceId)}/projects`, {
      method: "POST",
      signal,
      body: JSON.stringify({ name }),
    });
  }

  async updateProject(projectId: string, name: string, signal?: AbortSignal): Promise<ServstationProject> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    return this.request<ServstationProject>(
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/projects/${encodeURIComponent(projectId)}`,
      {
        method: "PATCH",
        signal,
        body: JSON.stringify({ name }),
      },
    );
  }

  async deleteProject(projectId: string, signal?: AbortSignal): Promise<ServstationDeleteProjectResponse> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    return this.request<ServstationDeleteProjectResponse>(
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/projects/${encodeURIComponent(projectId)}`,
      { method: "DELETE", signal },
    );
  }

  async listProjectResources(projectId: string, signal?: AbortSignal): Promise<ServstationProjectResource[]> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    const response = await this.request<ProjectResourcesResponse>(
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/projects/${encodeURIComponent(projectId)}/resources`,
      { method: "GET", signal },
    );
    return Array.isArray(response.resources) ? response.resources : [];
  }

  async deleteProjectResource(
    projectId: string,
    resourceId: string,
    signal?: AbortSignal,
  ): Promise<ServstationDeleteProjectResourceResponse> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    return this.request<ServstationDeleteProjectResourceResponse>(
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceId)}`,
      { method: "DELETE", signal },
    );
  }

  async createConversation(title?: string, projectId?: string, signal?: AbortSignal): Promise<ServstationConversation> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    return this.request<ServstationConversation>(`/api/v1/agent/${encodeURIComponent(agentInstanceId)}/conversations`, {
      method: "POST",
      signal,
      body: JSON.stringify({ title, projectId }),
    });
  }

  async deleteConversation(conversationId: string, signal?: AbortSignal): Promise<void> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    await this.request(
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/conversations/${encodeURIComponent(conversationId)}`,
      {
        method: "DELETE",
        signal,
      },
    );
  }

  async sendPrompt(input: ServstationSendPromptInput, signal?: AbortSignal): Promise<ServstationSendPromptResult> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    const conversation = input.conversationId
      ? undefined
      : await this.createConversation(undefined, input.projectId, signal);
    const conversationId = input.conversationId || conversation?.id || "";
    if (!conversationId) {
      throw new Error("Servstation conversation id is required.");
    }
    const requestId = input.requestId?.trim() || this.host.randomId("serv_req");
    const attachments = await toPromptAttachments(input.attachments || []);
    const runtimeOptions =
      typeof input.allowWebSearch === "boolean" ? { allowWebSearch: input.allowWebSearch } : undefined;
    const job = await this.request<ServstationSessionJob>(`/api/v1/agent/${encodeURIComponent(agentInstanceId)}/jobs`, {
      method: "POST",
      signal,
      body: JSON.stringify({
        requestId,
        clientId: CLIENT_ID,
        jobType: "interactive",
        conversationId,
        payload: {
          prompt: input.prompt,
          requestId,
          source: "supbot-server-agent-client",
          ...(attachments.length ? { attachments } : {}),
          ...(runtimeOptions ? { runtimeOptions } : {}),
        },
      }),
    });
    const resolvedConversation =
      conversation ||
      (await this.findConversation(agentInstanceId, conversationId, signal)) ||
      fallbackConversation(agentInstanceId, conversationId, job);
    return {
      conversation: resolvedConversation,
      job,
      snapshot: await this.snapshot({ conversationId }, signal),
    };
  }

  async cancelJob(jobId: string, signal?: AbortSignal): Promise<ServstationSessionJob> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    return this.request<ServstationSessionJob>(
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/jobs?jobId=${encodeURIComponent(jobId)}`,
      {
        method: "PATCH",
        signal,
      },
    );
  }

  async fetchJobFile(jobId: string, fileId: string, signal?: AbortSignal): Promise<ServstationJobFileContent> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    const response = await this.requestResponse(
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(fileId)}/download`,
      {
        method: "GET",
        headers: { Accept: "application/octet-stream" },
        signal,
      },
    );
    if (!response.ok) {
      const text = await response.text();
      const payload = text.trim() ? safeJson(text) : {};
      throw servstationResponseError(response, text, payload);
    }
    const content = Buffer.from(await response.arrayBuffer());
    return {
      fileId,
      fileName: servstationDownloadFileName(response.headers.get("content-disposition")),
      contentType: response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream",
      sizeBytes: content.byteLength,
      contentBase64: content.toString("base64"),
    };
  }

  async createScheduledJob(
    input: ServstationScheduledJobInput,
    signal?: AbortSignal,
  ): Promise<ServstationScheduledJob> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    const task = await this.request<ServstationScheduledJob | ServstationScheduledTask>(
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/scheduled-tasks`,
      {
        method: "POST",
        signal,
        body: JSON.stringify(toScheduledTaskInput(input)),
      },
    );
    return normalizeScheduledJob(task);
  }

  async updateScheduledJob(
    id: string,
    input: Partial<ServstationScheduledJobInput>,
    signal?: AbortSignal,
  ): Promise<ServstationScheduledJob> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    if (typeof input.enabled === "boolean" && Object.keys(input).every((key) => key === "enabled")) {
      const task = await this.request<ServstationScheduledJob | ServstationScheduledTask>(
        `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/scheduled-tasks/${encodeURIComponent(id)}/${input.enabled ? "resume" : "pause"}`,
        {
          method: "POST",
          signal,
          body: JSON.stringify({}),
        },
      );
      return normalizeScheduledJob(task);
    }
    const task = await this.request<ServstationScheduledJob | ServstationScheduledTask>(
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/scheduled-tasks/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        signal,
        body: JSON.stringify(toScheduledTaskInput(input)),
      },
    );
    return normalizeScheduledJob(task);
  }

  async deleteScheduledJob(id: string, signal?: AbortSignal): Promise<void> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    await this.request(
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/scheduled-tasks/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        signal,
      },
    );
  }

  async startAutopilotRun(
    input: ServstationAutopilotStartInput,
    signal?: AbortSignal,
  ): Promise<ServstationAutopilotRun> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    const conversationId = input.conversationId?.trim();
    const goal = input.goal?.trim();
    const prompt = input.prompt?.trim() || goal;
    const requestId = input.requestId?.trim() || this.host.randomId("serv_autopilot");
    const response = await this.request<AutopilotRunResponse>(
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/autopilot-runs`,
      {
        method: "POST",
        signal,
        body: JSON.stringify({
          ...(conversationId ? { conversationId } : {}),
          ...(goal ? { goal } : {}),
          ...(prompt ? { prompt } : {}),
          requestId,
        }),
      },
    );
    if (!response.run) {
      throw new Error("Servstation did not return an autopilot run.");
    }
    return response.run;
  }

  async fetchAutopilotRun(runId: string, signal?: AbortSignal): Promise<ServstationAutopilotRun | null> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    return this.fetchAutopilotRunForAgent(agentInstanceId, runId, signal);
  }

  async fetchAutopilotSteps(runId: string, signal?: AbortSignal): Promise<ServstationAutopilotStep[]> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    return this.fetchAutopilotStepsForAgent(agentInstanceId, runId, signal);
  }

  async streamAutopilotEvents(
    runId: string,
    onEvent: (event: ServstationAutopilotEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    let lastEventId = "";
    while (!signal?.aborted) {
      try {
        await this.openAutopilotEventStream(
          agentInstanceId,
          runId,
          lastEventId,
          (event) => {
            lastEventId = event.id;
            onEvent(event);
          },
          signal,
        );
      } catch (error) {
        if (signal?.aborted) {
          return;
        }
        if (isOptionalAgentFeatureMissing(error)) {
          return;
        }
        await waitForAutopilotReconnect(signal);
        continue;
      }
      if (signal?.aborted) {
        return;
      }
      try {
        const run = await this.fetchAutopilotRunForAgent(agentInstanceId, runId, signal);
        if (!run || isTerminalAutopilotRun(run)) {
          return;
        }
      } catch (error) {
        if (signal?.aborted || isOptionalAgentFeatureMissing(error)) {
          return;
        }
      }
      await waitForAutopilotReconnect(signal);
    }
  }

  async updateAutopilotRun(
    input: ServstationAutopilotStatusUpdate,
    signal?: AbortSignal,
  ): Promise<ServstationAutopilotRun> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    const response = await this.request<AutopilotRunResponse>(
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/autopilot-runs/${encodeURIComponent(input.runId)}`,
      {
        method: "PATCH",
        signal,
        body: JSON.stringify({ status: input.status }),
      },
    );
    if (!response.run) {
      throw new Error("Servstation did not return an autopilot run.");
    }
    return response.run;
  }

  async flowEngineSnapshot(signal?: AbortSignal): Promise<ServstationFlowEngineSnapshot> {
    await this.ensureConnectedAgent(signal);
    const [launchableWorkflows, pendingTasks, executions] = await Promise.all([
      this.listFlowEngineLaunchableWorkflows(signal),
      this.listFlowEnginePendingTasks(signal),
      this.listFlowEngineExecutions(signal),
    ]);
    return {
      launchableWorkflows,
      pendingTasks,
      executions,
      fetchedAt: this.host.nowIso(),
    };
  }

  async launchFlowEngineWorkflow(
    input: ServstationFlowEngineLaunchInput,
    signal?: AbortSignal,
  ): Promise<ServstationFlowEngineInitiatedExecution> {
    await this.ensureConnectedAgent(signal);
    return this.request<ServstationFlowEngineInitiatedExecution>("/api/v1/flow-engine/executions", {
      method: "POST",
      signal,
      body: JSON.stringify({
        workflowId: input.workflowId,
        input: input.input || {},
      }),
    });
  }

  async getFlowEngineExecution(
    executionId: string,
    signal?: AbortSignal,
  ): Promise<ServstationFlowEngineInitiatedExecution> {
    await this.ensureConnectedAgent(signal);
    return this.request<ServstationFlowEngineInitiatedExecution>(
      `/api/v1/flow-engine/executions/mine/${encodeURIComponent(executionId)}`,
      {
        method: "GET",
        signal,
      },
    );
  }

  async getFlowEngineExecutionEvents(
    executionId: string,
    signal?: AbortSignal,
  ): Promise<ServstationFlowEngineExecutionEvent[]> {
    await this.ensureConnectedAgent(signal);
    const response = await this.request<ServstationFlowEngineExecutionEvent[] | FlowEngineExecutionEventsResponse>(
      `/api/v1/flow-engine/executions/mine/${encodeURIComponent(executionId)}/events`,
      { method: "GET", signal },
    );
    return Array.isArray(response) ? response : Array.isArray(response.events) ? response.events : [];
  }

  async decideFlowEngineApproval(
    input: ServstationFlowEngineApprovalDecisionInput,
    signal?: AbortSignal,
  ): Promise<ServstationFlowEnginePendingTask> {
    await this.ensureConnectedAgent(signal);
    return this.request<ServstationFlowEnginePendingTask>(
      `/api/v1/flow-engine/approvals/${encodeURIComponent(input.approvalId)}/decision`,
      {
        method: "POST",
        signal,
        body: JSON.stringify({
          decision: input.decision,
          comment: input.comment?.trim() || undefined,
        }),
      },
    );
  }

  async listMessages(
    folder: ServstationMessageFolder,
    unreadOnly = false,
    signal?: AbortSignal,
  ): Promise<ServstationMessageListResponse> {
    await this.ensureConnectedAgent(signal);
    const query = new URLSearchParams({ folder, unreadOnly: String(unreadOnly) });
    const response = await this.request<ServstationMessageListResponse>(`/api/v1/messages?${query.toString()}`, {
      method: "GET",
      signal,
    });
    return {
      messages: Array.isArray(response.messages) ? response.messages : [],
    };
  }

  async getUnreadMessages(signal?: AbortSignal): Promise<ServstationMessageUnreadSummary> {
    await this.ensureConnectedAgent(signal);
    const response = await this.request<ServstationMessageUnreadSummary>("/api/v1/messages/unread", {
      method: "GET",
      signal,
    });
    return {
      unreadCount: typeof response.unreadCount === "number" ? response.unreadCount : 0,
      messages: Array.isArray(response.messages) ? response.messages : [],
    };
  }

  async getMessage(messageId: string, signal?: AbortSignal): Promise<ServstationMessageDetail> {
    await this.ensureConnectedAgent(signal);
    const response = await this.request<MessageDetailResponse>(`/api/v1/messages/${encodeURIComponent(messageId)}`, {
      method: "GET",
      signal,
    });
    if (!response.message) {
      throw new Error("Servstation did not return a message.");
    }
    return response.message;
  }

  async markMessageRead(messageId: string, signal?: AbortSignal): Promise<ServstationMessageDetail> {
    await this.ensureConnectedAgent(signal);
    const response = await this.request<MessageStateResponse>(
      `/api/v1/messages/${encodeURIComponent(messageId)}/read`,
      {
        method: "POST",
        signal,
        body: JSON.stringify({}),
      },
    );
    if (!response.message) {
      throw new Error("Servstation did not return a message.");
    }
    return response.message;
  }

  async setMessageFavorite(
    messageId: string,
    favorited: boolean,
    signal?: AbortSignal,
  ): Promise<ServstationMessageDetail> {
    await this.ensureConnectedAgent(signal);
    const response = await this.request<MessageStateResponse>(
      `/api/v1/messages/${encodeURIComponent(messageId)}/favorite`,
      {
        method: "POST",
        signal,
        body: JSON.stringify({ favorited }),
      },
    );
    if (!response.message) {
      throw new Error("Servstation did not return a message.");
    }
    return response.message;
  }

  async trashMessage(messageId: string, signal?: AbortSignal): Promise<ServstationMessageDetail> {
    await this.ensureConnectedAgent(signal);
    const response = await this.request<MessageStateResponse>(
      `/api/v1/messages/${encodeURIComponent(messageId)}/trash`,
      {
        method: "POST",
        signal,
        body: JSON.stringify({}),
      },
    );
    if (!response.message) {
      throw new Error("Servstation did not return a message.");
    }
    return response.message;
  }

  async restoreMessage(messageId: string, signal?: AbortSignal): Promise<ServstationMessageDetail> {
    await this.ensureConnectedAgent(signal);
    const response = await this.request<MessageStateResponse>(
      `/api/v1/messages/${encodeURIComponent(messageId)}/restore`,
      {
        method: "POST",
        signal,
        body: JSON.stringify({}),
      },
    );
    if (!response.message) {
      throw new Error("Servstation did not return a message.");
    }
    return response.message;
  }

  async deleteMessage(messageId: string, signal?: AbortSignal): Promise<void> {
    await this.ensureConnectedAgent(signal);
    await this.request(`/api/v1/messages/${encodeURIComponent(messageId)}`, {
      method: "DELETE",
      signal,
    });
  }

  async fetchMessageAttachment(
    messageId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ): Promise<ServstationMessageAttachmentContent> {
    await this.ensureConnectedAgent(signal);
    const response = await this.request<MessageAttachmentResponse>(
      `/api/v1/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "GET", signal },
    );
    if (!response.attachment) {
      throw new Error("Servstation did not return a message attachment.");
    }
    return response.attachment;
  }

  async sendAgentMessage(
    input: ServstationSendAgentMessageInput,
    signal?: AbortSignal,
  ): Promise<ServstationSessionJob> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    return this.request<ServstationSessionJob>("/api/v1/messages/send", {
      method: "POST",
      signal,
      body: JSON.stringify({
        agentInstanceId,
        recipients: input.recipients,
        subject: input.subject,
        body: input.body,
        attachments: input.attachments || [],
      }),
    });
  }

  async sendDirectMessage(
    input: ServstationSendDirectMessageInput,
    signal?: AbortSignal,
  ): Promise<ServstationMessageDetail> {
    const agentInstanceId = await this.ensureConnectedAgent(signal);
    const response = await this.request<MessageDetailResponse>("/api/v1/messages/deliver", {
      method: "POST",
      signal,
      body: JSON.stringify({
        senderAgentInstanceId: agentInstanceId,
        recipients: input.recipients,
        externalRecipients: input.externalRecipients || [],
        senderMailAccountId: input.senderMailAccountId || "",
        subject: input.subject,
        body: input.body,
        attachments: input.attachments || [],
      }),
    });
    if (!response.message) {
      throw new Error("Servstation did not return a message.");
    }
    return response.message;
  }

  async listMailAccounts(signal?: AbortSignal): Promise<ServstationMailAccount[]> {
    await this.ensureConnectedAgent(signal);
    const response = await this.request<MailAccountsResponse>("/api/v1/mail/accounts", {
      method: "GET",
      signal,
    });
    return Array.isArray(response.accounts) ? response.accounts.map(sanitizeMailAccount) : [];
  }

  async createMailAccount(input: ServstationMailAccountDraft, signal?: AbortSignal): Promise<ServstationMailAccount> {
    await this.ensureConnectedAgent(signal);
    const response = await this.request<MailAccountResponse>("/api/v1/mail/accounts", {
      method: "POST",
      signal,
      body: JSON.stringify(input),
    });
    if (!response.account) {
      throw new Error("Servstation did not return a mail account.");
    }
    return sanitizeMailAccount(response.account);
  }

  async updateMailAccount(
    id: string,
    input: ServstationMailAccountDraft,
    signal?: AbortSignal,
  ): Promise<ServstationMailAccount> {
    await this.ensureConnectedAgent(signal);
    const response = await this.request<MailAccountResponse>(`/api/v1/mail/accounts/${encodeURIComponent(id)}`, {
      method: "PUT",
      signal,
      body: JSON.stringify(input),
    });
    if (!response.account) {
      throw new Error("Servstation did not return a mail account.");
    }
    return sanitizeMailAccount(response.account);
  }

  async deleteMailAccount(id: string, signal?: AbortSignal): Promise<void> {
    await this.ensureConnectedAgent(signal);
    await this.request(`/api/v1/mail/accounts/${encodeURIComponent(id)}`, {
      method: "DELETE",
      signal,
    });
  }

  async setDefaultMailAccount(id: string, signal?: AbortSignal): Promise<ServstationMailAccount> {
    await this.ensureConnectedAgent(signal);
    const response = await this.request<MailAccountResponse>(
      `/api/v1/mail/accounts/${encodeURIComponent(id)}/default`,
      {
        method: "POST",
        signal,
        body: JSON.stringify({}),
      },
    );
    if (!response.account) {
      throw new Error("Servstation did not return a mail account.");
    }
    return sanitizeMailAccount(response.account);
  }

  async testMailAccountConnection(id: string, signal?: AbortSignal): Promise<ServstationMailConnectionTestResult> {
    await this.ensureConnectedAgent(signal);
    return this.request<ServstationMailConnectionTestResult>(`/api/v1/mail/accounts/${encodeURIComponent(id)}/test`, {
      method: "POST",
      signal,
      body: JSON.stringify({}),
    });
  }

  async syncMailAccountNow(id: string, signal?: AbortSignal): Promise<{ status: string }> {
    await this.ensureConnectedAgent(signal);
    return this.request<{ status: string }>(`/api/v1/mail/accounts/${encodeURIComponent(id)}/sync`, {
      method: "POST",
      signal,
      body: JSON.stringify({}),
    });
  }

  async streamMessageEvents(onEvent: (event: ServstationMessageEvent) => void, signal?: AbortSignal): Promise<void> {
    await this.ensureConnectedAgent(signal);
    const config = this.host.getConfig();
    const identity = this.host.getIdentityContext();
    const baseUrl = normalizeBaseUrl(config.baseUrl || identity?.servstationUrl);
    if (!baseUrl) {
      throw new Error("Servstation base URL is not configured.");
    }
    const response = await fetch(joinUrl(baseUrl, "/api/v1/messages/events"), {
      method: "GET",
      headers: {
        ...(await this.headers(signal)),
        Accept: "text/event-stream",
      },
      signal,
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(text || response.statusText || `Servstation message stream failed with HTTP ${response.status}.`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let splitAt = buffer.indexOf("\n\n");
        while (splitAt >= 0) {
          const frame = buffer.slice(0, splitAt);
          buffer = buffer.slice(splitAt + 2);
          const event = parseMessageSseFrame(frame);
          if (event) {
            onEvent(event);
          }
          splitAt = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async listConversations(agentInstanceId: string, signal?: AbortSignal): Promise<ServstationConversation[]> {
    const response = await this.request<ConversationsResponse>(
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/conversations`,
      {
        method: "GET",
        signal,
      },
    );
    return Array.isArray(response.conversations) ? response.conversations : [];
  }

  private async fetchConversation(
    agentInstanceId: string,
    fallback: ServstationConversation,
    signal?: AbortSignal,
  ): Promise<ServstationConversation | undefined> {
    try {
      const response = await this.request<unknown>(
        `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/conversations/${encodeURIComponent(fallback.id)}`,
        { method: "GET", signal },
      );
      return {
        ...fallback,
        messages: normalizeConversationMessages(response, fallback.id),
      };
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      return fallback;
    }
  }

  private async listProjects(agentInstanceId: string, signal?: AbortSignal): Promise<ServstationProject[]> {
    const response = await this.request<ProjectsResponse>(
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/projects`,
      {
        method: "GET",
        signal,
      },
    );
    return Array.isArray(response.projects) ? response.projects : [];
  }

  private async fetchCapabilitySnapshot(agentInstanceId: string, signal?: AbortSignal): Promise<CapabilitySnapshot> {
    const [servicesResult, installedResult, localResult] = await Promise.allSettled([
      this.listServices(signal),
      this.listInstalledServices(agentInstanceId, signal),
      this.listLocalCapabilities(signal),
    ]);
    const errors: string[] = [];
    if (servicesResult.status === "rejected") {
      errors.push(capabilityRequestError("/api/v1/services", servicesResult.reason));
    }
    if (installedResult.status === "rejected") {
      errors.push(
        capabilityRequestError(`/api/v1/agent/${agentInstanceId}/installed-services`, installedResult.reason),
      );
    }
    if (localResult.status === "rejected") {
      errors.push(capabilityRequestError("/api/v1/capabilities/local", localResult.reason));
    }
    return {
      services: servicesResult.status === "fulfilled" ? servicesResult.value : [],
      installedServices: installedResult.status === "fulfilled" ? installedResult.value : [],
      localCapabilities: localResult.status === "fulfilled" ? localResult.value : [],
      ...(errors.length ? { capabilityLoadError: errors.join("; ") } : {}),
    };
  }

  private async listServices(signal?: AbortSignal): Promise<ServstationServiceDefinition[]> {
    const response = await this.request<ServicesResponse | ServstationServiceDefinition[]>("/api/v1/services", {
      method: "GET",
      signal,
    });
    return Array.isArray(response) ? response : Array.isArray(response.services) ? response.services : [];
  }

  private async listInstalledServices(
    agentInstanceId: string,
    signal?: AbortSignal,
  ): Promise<ServstationInstalledService[]> {
    const response = await this.request<InstalledServicesResponse | ServstationInstalledService[]>(
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/installed-services`,
      { method: "GET", signal },
    );
    return Array.isArray(response) ? response : Array.isArray(response.services) ? response.services : [];
  }

  private async listLocalCapabilities(signal?: AbortSignal): Promise<ServstationLocalCapabilityAsset[]> {
    try {
      const response = await this.request<LocalCapabilitiesResponse | ServstationLocalCapabilityAsset[]>(
        "/api/v1/capabilities/local",
        {
          method: "GET",
          signal,
        },
      );
      return Array.isArray(response) ? response : Array.isArray(response.assets) ? response.assets : [];
    } catch (error) {
      if ((error as Error & { status?: number }).status === 404) {
        return [];
      }
      throw error;
    }
  }

  private async listJobs(
    agentInstanceId: string,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<ServstationSessionJob[]> {
    const response = await this.request<JobsResponse>(
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/jobs?conversationId=${encodeURIComponent(conversationId)}`,
      {
        method: "GET",
        signal,
      },
    );
    return Array.isArray(response.jobs)
      ? response.jobs.flatMap((job) => {
          const returnedConversationId = job.conversationId?.trim();
          if (returnedConversationId && returnedConversationId !== conversationId) {
            return [];
          }
          return [{ ...job, conversationId }];
        })
      : [];
  }

  private async listScheduledJobs(agentInstanceId: string, signal?: AbortSignal): Promise<ServstationScheduledJob[]> {
    const response = await this.request<ScheduledJobsResponse>(
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/scheduled-tasks`,
      {
        method: "GET",
        signal,
      },
    );
    const jobs = Array.isArray(response.scheduledJobs) ? response.scheduledJobs : response.tasks;
    return Array.isArray(jobs) ? jobs.map(normalizeScheduledJob) : [];
  }

  private async fetchCurrentAutopilotRun(
    agentInstanceId: string,
    signal?: AbortSignal,
  ): Promise<ServstationAutopilotRun | null> {
    try {
      const response = await this.request<AutopilotRunResponse>(
        `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/autopilot-runs/current`,
        {
          method: "GET",
          signal,
        },
      );
      return response.run || null;
    } catch (error) {
      if (isOptionalAgentFeatureMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  private async fetchAutopilotEvents(
    agentInstanceId: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<ServstationAutopilotEvent[]> {
    const response = await this.request<AutopilotEventResponse>(
      `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/autopilot-runs/${encodeURIComponent(runId)}/events?limit=50`,
      { method: "GET", signal },
    );
    return Array.isArray(response.events) ? response.events : [];
  }

  private async fetchAutopilotRunForAgent(
    agentInstanceId: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<ServstationAutopilotRun | null> {
    try {
      const response = await this.request<AutopilotRunResponse>(
        `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/autopilot-runs/${encodeURIComponent(runId)}`,
        { method: "GET", signal },
      );
      return response.run || null;
    } catch (error) {
      if (isOptionalAgentFeatureMissing(error)) {
        return null;
      }
      throw error;
    }
  }

  private async fetchAutopilotStepsForAgent(
    agentInstanceId: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<ServstationAutopilotStep[]> {
    try {
      const response = await this.request<AutopilotStepResponse>(
        `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/autopilot-runs/${encodeURIComponent(runId)}/steps?limit=50`,
        { method: "GET", signal },
      );
      return Array.isArray(response.steps) ? response.steps : [];
    } catch (error) {
      if (isOptionalAgentFeatureMissing(error)) {
        return [];
      }
      throw error;
    }
  }

  private async openAutopilotEventStream(
    agentInstanceId: string,
    runId: string,
    lastEventId: string,
    onEvent: (event: ServstationAutopilotEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const config = this.host.getConfig();
    const identity = this.host.getIdentityContext();
    const baseUrl = normalizeBaseUrl(config.baseUrl || identity?.servstationUrl);
    if (!baseUrl) {
      throw new Error("Servstation base URL is not configured.");
    }
    const response = await fetch(
      joinUrl(
        baseUrl,
        `/api/v1/agent/${encodeURIComponent(agentInstanceId)}/autopilot-runs/${encodeURIComponent(runId)}/stream`,
      ),
      {
        method: "GET",
        headers: {
          ...(await this.headers(signal)),
          Accept: "text/event-stream",
          ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
        },
        signal,
      },
    );
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      const payload = text.trim() ? safeJson(text) : {};
      const error = new Error(
        errorMessage(payload) ||
          text ||
          response.statusText ||
          `Servstation autopilot stream failed with HTTP ${response.status}.`,
      ) as Error & { status?: number; payload?: unknown };
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = SSE_FRAME_BOUNDARY.exec(buffer);
        while (boundary) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const event = parseAutopilotSseFrame(frame);
          if (event) {
            onEvent(event);
          }
          boundary = SSE_FRAME_BOUNDARY.exec(buffer);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async listFlowEngineLaunchableWorkflows(
    signal?: AbortSignal,
  ): Promise<ServstationFlowEngineLaunchableWorkflow[]> {
    const response = await this.request<ServstationFlowEngineLaunchableWorkflow[] | FlowEngineLaunchableResponse>(
      "/api/v1/flow-engine/workflows/launchable",
      {
        method: "GET",
        signal,
      },
    );
    return Array.isArray(response)
      ? response
      : Array.isArray(response.launchableWorkflows)
        ? response.launchableWorkflows
        : Array.isArray(response.workflows)
          ? response.workflows
          : [];
  }

  private async listFlowEnginePendingTasks(signal?: AbortSignal): Promise<ServstationFlowEnginePendingTask[]> {
    const response = await this.request<ServstationFlowEnginePendingTask[] | FlowEnginePendingTasksResponse>(
      "/api/v1/flow-engine/tasks/pending",
      {
        method: "GET",
        signal,
      },
    );
    return Array.isArray(response)
      ? response
      : Array.isArray(response.pendingTasks)
        ? response.pendingTasks
        : Array.isArray(response.tasks)
          ? response.tasks
          : [];
  }

  private async listFlowEngineExecutions(signal?: AbortSignal): Promise<ServstationFlowEngineInitiatedExecution[]> {
    const response = await this.request<ServstationFlowEngineInitiatedExecution[] | FlowEngineExecutionsResponse>(
      "/api/v1/flow-engine/executions/mine",
      {
        method: "GET",
        signal,
      },
    );
    return Array.isArray(response) ? response : Array.isArray(response.executions) ? response.executions : [];
  }

  private async findConversation(
    agentInstanceId: string,
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<ServstationConversation | undefined> {
    const conversations = await this.listConversations(agentInstanceId, signal);
    return conversations.find((item) => item.id === conversationId);
  }

  private async ensureConnectedAgent(signal?: AbortSignal): Promise<string> {
    const reverse = this.host.getConfig().reverse;
    if (reverse?.status !== "connected") {
      throw new Error(reverse?.lastError || "Servstation reverse A2A is not connected.");
    }
    return this.ensureAgentInstanceId(signal);
  }

  private async ensureAgentInstanceId(signal?: AbortSignal): Promise<string> {
    const config = this.host.getConfig();
    const existing = config.agentInstanceId?.trim() || this.host.getIdentityContext()?.agentInstanceId?.trim();
    if (existing) {
      return existing;
    }
    const connected = await this.request<AgentConnectResponse>("/api/v1/agent/connect", {
      method: "POST",
      signal,
      body: JSON.stringify({ clientId: CLIENT_ID }),
    });
    if (!connected.agentInstanceId) {
      throw new Error("Servstation connect did not return an agent instance id.");
    }
    await this.host.updateConfig({ agentInstanceId: connected.agentInstanceId });
    return connected.agentInstanceId;
  }

  private async request<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const response = await this.requestResponse(path, init);
    const text = await response.text();
    const payload = text.trim() ? safeJson(text) : {};
    if (!response.ok) {
      throw servstationResponseError(response, text, payload);
    }
    return payload as T;
  }

  private async requestResponse(path: string, init: RequestInit): Promise<Response> {
    const config = this.host.getConfig();
    const identity = this.host.getIdentityContext();
    const baseUrl = normalizeBaseUrl(config.baseUrl || identity?.servstationUrl);
    if (!baseUrl) {
      throw new Error("Servstation base URL is not configured.");
    }
    if (!identity) {
      throw new Error("Servstation identity context is not paired.");
    }
    const signal = init.signal instanceof AbortSignal ? init.signal : undefined;
    let response = await this.requestOnce(joinUrl(baseUrl, path), init, signal);
    if (response.status === 401 && this.host.refreshAccessToken) {
      await response.arrayBuffer().catch(() => undefined);
      const refreshed = await this.host.refreshAccessToken(signal).catch(() => undefined);
      if (refreshed) {
        response = await this.requestOnce(joinUrl(baseUrl, path), init, signal, 0);
      }
    }
    return response;
  }

  private async requestOnce(
    url: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    retries?: number,
  ): Promise<Response> {
    return fetchWithRetry(
      url,
      {
        ...init,
        headers: {
          ...(await this.headers(signal)),
          ...(init.headers || {}),
        },
      },
      { signal, retries },
    );
  }

  private async headers(signal?: AbortSignal): Promise<Record<string, string>> {
    const identity = this.host.getIdentityContext();
    if (!identity) {
      throw new Error("Servstation identity context is not paired.");
    }
    const token = await this.host.getAccessToken(signal);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-tenant-id": identity.tenantId,
      "x-organization-id": identity.organizationId,
      "x-department-id": identity.departmentId,
      "x-user-id": identity.userId,
      "x-role-ids": identity.roleIds.join(","),
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }
}

function servstationResponseError(response: Response, text: string, payload: unknown): Error {
  const error = new Error(errorMessage(payload) || text || `HTTP ${response.status}`) as Error & {
    status?: number;
    payload?: unknown;
  };
  error.status = response.status;
  error.payload = payload;
  return error;
}

function servstationDownloadFileName(contentDisposition: string | null): string | undefined {
  if (!contentDisposition) {
    return undefined;
  }
  const encoded = contentDisposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  const regular = contentDisposition.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  const raw = encoded ? decodeURIComponentSafely(encoded.trim()) : (regular?.[1] || regular?.[2])?.trim();
  return raw ? raw.split(/[\\/]/).pop()?.trim() || undefined : undefined;
}

function decodeURIComponentSafely(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function servstationJobIsTerminal(job: Pick<ServstationSessionJob, "status">): boolean {
  return TERMINAL_JOB_STATUSES.has(job.status);
}

async function toPromptAttachments(attachments: Attachment[]): Promise<PromptAttachment[]> {
  const result: PromptAttachment[] = [];
  for (const attachment of attachments) {
    if (!attachment.path) {
      continue;
    }
    const content = await readFile(attachment.path);
    result.push({
      name: attachment.name,
      mimeType: attachment.mimeType || "application/octet-stream",
      size: attachment.size,
      contentBase64: content.toString("base64"),
    });
  }
  return result;
}

function fallbackConversation(
  agentInstanceId: string,
  conversationId: string,
  job: ServstationSessionJob,
): ServstationConversation {
  const now = new Date().toISOString();
  return {
    id: conversationId,
    agentInstanceId,
    projectId: job.projectId,
    title: "Remote conversation",
    runtimeSessionId: job.runtimeSessionId || "",
    jobCount: 1,
    lastMessageAt: job.createdAt || now,
    createdAt: job.createdAt || now,
    updatedAt: job.createdAt || now,
  };
}

function normalizeConversationMessages(response: unknown, conversationId: string): ServstationConversationMessage[] {
  const root = objectRecord(response);
  const transcript = objectRecord(root?.transcript) || objectRecord(root?.result) || root;
  if (!transcript) {
    return [];
  }
  const values = Array.isArray(transcript.activeMessages)
    ? transcript.activeMessages
    : Array.isArray(transcript.messages)
      ? transcript.messages
      : Array.isArray(transcript.entries)
        ? transcript.entries
        : [];
  return values.flatMap((value, index) => {
    const entry = objectRecord(value);
    const message = entry?.type === "message" ? objectRecord(entry.message) : entry;
    const text = stringValue(message?.text) || stringValue(message?.content) || stringValue(message?.assistantText);
    const role = normalizeConversationMessageRole(stringValue(message?.role));
    if (!message || !text || !role) {
      return [];
    }
    return [
      {
        id: stringValue(message.id) || `${conversationId}-message-${index + 1}`,
        role,
        text,
        ...(message.payload !== undefined ? { payload: message.payload } : {}),
        ...(stringValue(message.status) ? { status: stringValue(message.status) } : {}),
        ...(stringValue(message.jobId) ? { jobId: stringValue(message.jobId) } : {}),
        createdAt: normalizeMessageTimestamp(message.createdAt ?? message.timestamp),
      } satisfies ServstationConversationMessage,
    ];
  });
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeConversationMessageRole(role: string): ServstationConversationMessage["role"] | undefined {
  if (role === "user") {
    return "user";
  }
  return role === "agent" || role === "assistant" ? "agent" : undefined;
}

function normalizeMessageTimestamp(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return new Date(0).toISOString();
}

function toScheduledTaskInput(input: Partial<ServstationScheduledJobInput>): Record<string, unknown> {
  const scheduleKind = input.scheduleKind?.trim();
  return compactRecord({
    name: input.title,
    prompt: input.prompt,
    scheduleType: scheduleTypeFromKind(scheduleKind),
    cronExpression: input.cronExpr,
    runAt: input.runAt,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    clientId: CLIENT_ID,
  });
}

function normalizeScheduledJob(input: ServstationScheduledJob | ServstationScheduledTask): ServstationScheduledJob {
  const task = input as ServstationScheduledTask & ServstationScheduledJob;
  const scheduleType = task.scheduleType || task.scheduleKind;
  const cronExpr = task.cronExpression || task.cronExpr;
  const now = new Date().toISOString();
  return {
    id: task.id || "",
    agentInstanceId: task.agentInstanceId || "",
    conversationId: task.conversationId || "",
    title: task.title || task.name || "Scheduled prompt",
    prompt: task.prompt || "",
    scheduleKind: scheduleKindFromType(scheduleType, cronExpr),
    runAt: task.runAt ?? null,
    cronExpr,
    enabled:
      typeof task.enabled === "boolean"
        ? task.enabled
        : task.status !== "paused" && task.status !== "deleted" && task.status !== "completed",
    lastRunAt: task.lastRunAt ?? null,
    nextRunAt: task.nextRunAt ?? null,
    lastError: task.lastError,
    createdAt: task.createdAt || now,
    updatedAt: task.updatedAt || now,
  };
}

function scheduleTypeFromKind(kind: string | undefined): string | undefined {
  if (!kind) {
    return undefined;
  }
  if (kind === "cron" || kind === "daily") {
    return "unbounded_recurring";
  }
  return kind;
}

function scheduleKindFromType(type: string | undefined, cronExpr: string | undefined): string {
  if (type === "once") {
    return "once";
  }
  if (type === "bounded_recurring" || type === "unbounded_recurring") {
    return cronExpr ? "cron" : type;
  }
  return type || "once";
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== ""));
}

function normalizeBaseUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
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
  return typeof record.error === "string"
    ? record.error
    : typeof record.message === "string"
      ? record.message
      : undefined;
}

function capabilityRequestError(path: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${path}: ${message}`;
}

function isOptionalAgentFeatureMissing(error: unknown): boolean {
  const status = (error as Error & { status?: number }).status;
  const message = (error as Error).message || "";
  return status === 404 || status === 405 || (status === 400 && message.includes("missing agent instance id"));
}

function isTerminalAutopilotRun(run: ServstationAutopilotRun): boolean {
  return TERMINAL_AUTOPILOT_STATUSES.has(run.status) || TERMINAL_AUTOPILOT_STATUSES.has(run.lifecycleStatus || "");
}

async function waitForAutopilotReconnect(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, AUTOPILOT_STREAM_RETRY_MS);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) {
      finish();
    }
  });
}

function sanitizeMailAccount(account: ServstationMailAccount): ServstationMailAccount {
  const copy = { ...account } as ServstationMailAccount & Record<string, unknown>;
  delete copy.smtpPassword;
  delete copy.imapPassword;
  delete copy.password;
  return copy;
}

function parseMessageSseFrame(frame: string): ServstationMessageEvent | null {
  let type = "message";
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      type = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }
  if (!data.length || type !== "messages.unread") {
    return null;
  }
  try {
    return { type: "messages.unread", data: JSON.parse(data.join("\n")) as ServstationMessageUnreadSummary };
  } catch {
    return null;
  }
}

function parseAutopilotSseFrame(frame: string): ServstationAutopilotEvent | null {
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }
  if (!data.length) {
    return null;
  }
  try {
    const event = JSON.parse(data.join("\n")) as ServstationAutopilotEvent;
    return event?.id && event?.runId ? event : null;
  } catch {
    return null;
  }
}
