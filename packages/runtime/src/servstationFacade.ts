import { EventEmitter } from "node:events";
import {
  type ServstationAutopilotEvent,
  type ServstationAutopilotRun,
  type ServstationAutopilotStartInput,
  type ServstationAutopilotStatusUpdate,
  type ServstationAutopilotStep,
  type ServstationClientSnapshot,
  type ServstationClientSnapshotQuery,
  type ServstationConversation,
  type ServstationDeleteProjectResourceResponse,
  type ServstationDeleteProjectResponse,
  type ServstationFlowEngineApprovalDecisionInput,
  type ServstationFlowEngineExecutionEvent,
  type ServstationFlowEngineInitiatedExecution,
  type ServstationFlowEngineLaunchInput,
  type ServstationFlowEnginePendingTask,
  type ServstationFlowEngineSnapshot,
  type ServstationJobFileContent,
  type ServstationMailAccount,
  type ServstationMailAccountDraft,
  type ServstationMailConnectionTestResult,
  type ServstationMessageAttachmentContent,
  type ServstationMessageDetail,
  type ServstationMessageEvent,
  type ServstationMessageFolder,
  type ServstationMessageListResponse,
  type ServstationMessageUnreadSummary,
  type ServstationProject,
  type ServstationProjectResource,
  type ServstationScheduledJob,
  type ServstationScheduledJobInput,
  type ServstationSendAgentMessageInput,
  type ServstationSendDirectMessageInput,
  type ServstationSendPromptInput,
  type ServstationSendPromptResult,
  type ServstationSessionJob,
} from "@supbot/shared";
import type { ServstationAgentClient } from "./servstationAgentClient";

export abstract class ServstationRuntimeFacade extends EventEmitter {
  declare protected servstationAgentClient: ServstationAgentClient;

  protected abstract assertLoaded(): void;

  async getServstationClientSnapshot(query: ServstationClientSnapshotQuery = {}): Promise<ServstationClientSnapshot> {
    this.assertLoaded();
    return this.servstationAgentClient.snapshot(query);
  }

  async createServstationProject(name: string): Promise<ServstationProject> {
    this.assertLoaded();
    return this.servstationAgentClient.createProject(name);
  }

  async updateServstationProject(projectId: string, name: string): Promise<ServstationProject> {
    this.assertLoaded();
    return this.servstationAgentClient.updateProject(projectId, name);
  }

  async deleteServstationProject(projectId: string): Promise<ServstationDeleteProjectResponse> {
    this.assertLoaded();
    return this.servstationAgentClient.deleteProject(projectId);
  }

  async listServstationProjectResources(projectId: string): Promise<ServstationProjectResource[]> {
    this.assertLoaded();
    return this.servstationAgentClient.listProjectResources(projectId);
  }

  async deleteServstationProjectResource(
    projectId: string,
    resourceId: string,
  ): Promise<ServstationDeleteProjectResourceResponse> {
    this.assertLoaded();
    return this.servstationAgentClient.deleteProjectResource(projectId, resourceId);
  }

  async createServstationConversation(title?: string, projectId?: string): Promise<ServstationConversation> {
    this.assertLoaded();
    return this.servstationAgentClient.createConversation(title, projectId);
  }

  async deleteServstationConversation(conversationId: string): Promise<void> {
    this.assertLoaded();
    await this.servstationAgentClient.deleteConversation(conversationId);
  }

  async sendServstationPrompt(input: ServstationSendPromptInput): Promise<ServstationSendPromptResult> {
    this.assertLoaded();
    return this.servstationAgentClient.sendPrompt(input);
  }

  async cancelServstationJob(jobId: string): Promise<ServstationSessionJob> {
    this.assertLoaded();
    return this.servstationAgentClient.cancelJob(jobId);
  }

  async fetchServstationJobFile(jobId: string, fileId: string): Promise<ServstationJobFileContent> {
    this.assertLoaded();
    return this.servstationAgentClient.fetchJobFile(jobId, fileId);
  }

  async createServstationScheduledJob(input: ServstationScheduledJobInput): Promise<ServstationScheduledJob> {
    this.assertLoaded();
    return this.servstationAgentClient.createScheduledJob(input);
  }

  async updateServstationScheduledJob(
    id: string,
    input: Partial<ServstationScheduledJobInput>,
  ): Promise<ServstationScheduledJob> {
    this.assertLoaded();
    return this.servstationAgentClient.updateScheduledJob(id, input);
  }

  async deleteServstationScheduledJob(id: string): Promise<void> {
    this.assertLoaded();
    await this.servstationAgentClient.deleteScheduledJob(id);
  }

  async startServstationAutopilotRun(input: ServstationAutopilotStartInput): Promise<ServstationAutopilotRun> {
    this.assertLoaded();
    return this.servstationAgentClient.startAutopilotRun(input);
  }

  async updateServstationAutopilotRun(input: ServstationAutopilotStatusUpdate): Promise<ServstationAutopilotRun> {
    this.assertLoaded();
    return this.servstationAgentClient.updateAutopilotRun(input);
  }

  async getServstationAutopilotRun(runId: string): Promise<ServstationAutopilotRun | null> {
    this.assertLoaded();
    return this.servstationAgentClient.fetchAutopilotRun(runId);
  }

  async getServstationAutopilotSteps(runId: string): Promise<ServstationAutopilotStep[]> {
    this.assertLoaded();
    return this.servstationAgentClient.fetchAutopilotSteps(runId);
  }

  async streamServstationAutopilotEvents(
    runId: string,
    onEvent: (event: ServstationAutopilotEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertLoaded();
    await this.servstationAgentClient.streamAutopilotEvents(runId, onEvent, signal);
  }

  async getServstationFlowEngineSnapshot(): Promise<ServstationFlowEngineSnapshot> {
    this.assertLoaded();
    return this.servstationAgentClient.flowEngineSnapshot();
  }

  async launchServstationFlowEngineWorkflow(
    input: ServstationFlowEngineLaunchInput,
  ): Promise<ServstationFlowEngineInitiatedExecution> {
    this.assertLoaded();
    return this.servstationAgentClient.launchFlowEngineWorkflow(input);
  }

  async getServstationFlowEngineExecution(executionId: string): Promise<ServstationFlowEngineInitiatedExecution> {
    this.assertLoaded();
    return this.servstationAgentClient.getFlowEngineExecution(executionId);
  }

  async getServstationFlowEngineExecutionEvents(executionId: string): Promise<ServstationFlowEngineExecutionEvent[]> {
    this.assertLoaded();
    return this.servstationAgentClient.getFlowEngineExecutionEvents(executionId);
  }

  async decideServstationFlowEngineApproval(
    input: ServstationFlowEngineApprovalDecisionInput,
  ): Promise<ServstationFlowEnginePendingTask> {
    this.assertLoaded();
    return this.servstationAgentClient.decideFlowEngineApproval(input);
  }

  async listServstationMessages(
    folder: ServstationMessageFolder,
    unreadOnly = false,
  ): Promise<ServstationMessageListResponse> {
    this.assertLoaded();
    return this.servstationAgentClient.listMessages(folder, unreadOnly);
  }

  async getServstationUnreadMessages(): Promise<ServstationMessageUnreadSummary> {
    this.assertLoaded();
    return this.servstationAgentClient.getUnreadMessages();
  }

  async getServstationMessage(messageId: string): Promise<ServstationMessageDetail> {
    this.assertLoaded();
    return this.servstationAgentClient.getMessage(messageId);
  }

  async markServstationMessageRead(messageId: string): Promise<ServstationMessageDetail> {
    this.assertLoaded();
    return this.servstationAgentClient.markMessageRead(messageId);
  }

  async setServstationMessageFavorite(messageId: string, favorited: boolean): Promise<ServstationMessageDetail> {
    this.assertLoaded();
    return this.servstationAgentClient.setMessageFavorite(messageId, favorited);
  }

  async trashServstationMessage(messageId: string): Promise<ServstationMessageDetail> {
    this.assertLoaded();
    return this.servstationAgentClient.trashMessage(messageId);
  }

  async restoreServstationMessage(messageId: string): Promise<ServstationMessageDetail> {
    this.assertLoaded();
    return this.servstationAgentClient.restoreMessage(messageId);
  }

  async deleteServstationMessage(messageId: string): Promise<void> {
    this.assertLoaded();
    await this.servstationAgentClient.deleteMessage(messageId);
  }

  async fetchServstationMessageAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<ServstationMessageAttachmentContent> {
    this.assertLoaded();
    return this.servstationAgentClient.fetchMessageAttachment(messageId, attachmentId);
  }

  async sendServstationAgentMessage(input: ServstationSendAgentMessageInput): Promise<ServstationSessionJob> {
    this.assertLoaded();
    return this.servstationAgentClient.sendAgentMessage(input);
  }

  async sendServstationDirectMessage(input: ServstationSendDirectMessageInput): Promise<ServstationMessageDetail> {
    this.assertLoaded();
    return this.servstationAgentClient.sendDirectMessage(input);
  }

  async listServstationMailAccounts(): Promise<ServstationMailAccount[]> {
    this.assertLoaded();
    return this.servstationAgentClient.listMailAccounts();
  }

  async createServstationMailAccount(input: ServstationMailAccountDraft): Promise<ServstationMailAccount> {
    this.assertLoaded();
    return this.servstationAgentClient.createMailAccount(input);
  }

  async updateServstationMailAccount(id: string, input: ServstationMailAccountDraft): Promise<ServstationMailAccount> {
    this.assertLoaded();
    return this.servstationAgentClient.updateMailAccount(id, input);
  }

  async deleteServstationMailAccount(id: string): Promise<void> {
    this.assertLoaded();
    await this.servstationAgentClient.deleteMailAccount(id);
  }

  async setDefaultServstationMailAccount(id: string): Promise<ServstationMailAccount> {
    this.assertLoaded();
    return this.servstationAgentClient.setDefaultMailAccount(id);
  }

  async testServstationMailAccountConnection(id: string): Promise<ServstationMailConnectionTestResult> {
    this.assertLoaded();
    return this.servstationAgentClient.testMailAccountConnection(id);
  }

  async syncServstationMailAccountNow(id: string): Promise<{ status: string }> {
    this.assertLoaded();
    return this.servstationAgentClient.syncMailAccountNow(id);
  }

  async streamServstationMessageEvents(
    onEvent: (event: ServstationMessageEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertLoaded();
    await this.servstationAgentClient.streamMessageEvents(onEvent, signal);
  }
}
