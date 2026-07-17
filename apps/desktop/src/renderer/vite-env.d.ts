/// <reference types="vite/client" />

import type {
  AutopilotApprovalDecisionInput,
  AutopilotQualitySummary,
  AutopilotRunMetrics,
  AutopilotRun,
  AutopilotRunReport,
  AutopilotStartDataRunInput,
  AutopilotStartInput,
  Attachment,
  CapabilityUpdateInput,
  Conversation,
  GeneratedFile,
  IdentityContext,
  MemoryAddInput,
  MemoryFact,
  MemoryImportInput,
  MemoryImportResult,
  MemoryPage,
  MemoryRecallFeedback,
  MemoryRecallFeedbackInput,
  MemoryReplayRecallInput,
  MemoryReplayRecallResult,
  MemorySearchQuery,
  MemorySearchResult,
  MemoryTransfer,
  MemoryUpdateInput,
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
  ModelConfig,
  ModelConfigUpdate,
  ModelTestResult,
  PermissionMode,
  PermissionRule,
  PersonalityConfig,
  Project,
  ProjectCreateInput,
  ProjectUpdateInput,
  RemoteBridgeAuditRecord,
  RemoteBridgeConfig,
  RemoteBridgeSession,
  RuntimeSnapshot,
  ScheduledJob,
  ScheduledJobInput,
  SendPromptInput,
  SendPromptResult,
  ServstationA2AConfig,
  ServstationA2AConfigUpdate,
  ServstationA2AOidcLoginInput,
  ServstationA2AOidcLoginResult,
  ServstationAutopilotRun,
  ServstationAutopilotStartInput,
  ServstationAutopilotStatusUpdate,
  ServstationClientSnapshot,
  ServstationClientSnapshotQuery,
  ServstationConversation,
  ServstationFlowEngineApprovalDecisionInput,
  ServstationFlowEngineExecutionEvent,
  ServstationFlowEngineInitiatedExecution,
  ServstationFlowEngineLaunchInput,
  ServstationFlowEngineSnapshot,
  ServstationMailAccount,
  ServstationMailAccountDraft,
  ServstationMailConnectionTestResult,
  ServstationMessageAttachmentContent,
  ServstationMessageDetail,
  ServstationMessageEvent,
  ServstationMessageFolder,
  ServstationMessageListResponse,
  ServstationMessageUnreadSummary,
  ServstationScheduledJob,
  ServstationScheduledJobInput,
  ServstationSendAgentMessageInput,
  ServstationSendDirectMessageInput,
  ServstationSendPromptInput,
  ServstationSendPromptResult, 
  ServstationSessionJob, 
  ServstationSkillSummary,
  SubagentConfig, 
  SupbotUpdateState, 
  SupbotEvent, 
  ToolMarketCatalogItem,
  ToolMarketConfig,
  ToolMarketConfigUpdate,
  ToolMarketQuery,
  TaskWorktree,
  TranscriptLoadResult
} from "@supbot/shared";

declare global {
  interface Window {
    supbot: { 
      snapshot(): Promise<RuntimeSnapshot>; 
      getSupbotUpdateState(): Promise<SupbotUpdateState>;
      checkSupbotUpdate(): Promise<SupbotUpdateState>;
      downloadSupbotUpdate(): Promise<SupbotUpdateState>;
      installSupbotUpdate(): Promise<SupbotUpdateState>;
      onSupbotUpdate(listener: (state: SupbotUpdateState) => void): () => void;
      createConversation(title?: string): Promise<Conversation>; 
      deleteConversation(id: string): Promise<void>;
      sendPrompt(input: SendPromptInput): Promise<SendPromptResult>;
      cancelJob(id: string): Promise<void>;
      approveToolPermission(id: string): Promise<void>;
      denyToolPermission(id: string): Promise<void>;
      setPermissionMode(mode: PermissionMode): Promise<PermissionMode>;
      addPermissionRule(rule: Omit<PermissionRule, "id" | "createdAt" | "scope"> & { id?: string }): Promise<PermissionRule>;
      removePermissionRule(id: string): Promise<void>;
      compactConversation(conversationId: string): Promise<import("@supbot/shared").CompactBoundary>;
      loadTranscript(conversationId: string): Promise<TranscriptLoadResult>;
      createProjectFromFolder(input: ProjectCreateInput): Promise<Project>;
      listProjects(): Promise<Project[]>;
      pickProjectFolder(): Promise<string>;
      openProject(id: string): Promise<Project>;
      updateProject(id: string, input: ProjectUpdateInput): Promise<Project>;
      startAutopilotDataRun(input: AutopilotStartDataRunInput): Promise<AutopilotRun>;
      startAutopilotRun(input: AutopilotStartInput): Promise<AutopilotRun>;
      pauseAutopilotRun(id: string): Promise<AutopilotRun>;
      resumeAutopilotRun(id: string): Promise<AutopilotRun>;
      cancelAutopilotRun(id: string): Promise<AutopilotRun>;
      getAutopilotRunReport(id: string): Promise<AutopilotRunReport>;
      getAutopilotRunMetrics(id: string): Promise<AutopilotRunMetrics>;
      getAutopilotQualitySummary(): Promise<AutopilotQualitySummary>;
      decideAutopilotApproval(input: AutopilotApprovalDecisionInput): Promise<AutopilotRun>;
      retryAutopilotFromCheckpoint(id: string): Promise<AutopilotRun>;
      applyAutopilotWorktree(id: string): Promise<AutopilotRun>;
      discardAutopilotWorktree(id: string): Promise<AutopilotRun>;
      listWorktrees(): Promise<TaskWorktree[]>;
      getWorktreeDiff(id: string): Promise<import("@supbot/shared").WorktreeDiffSummary>;
      applyWorktree(id: string): Promise<TaskWorktree>;
      discardWorktree(id: string): Promise<TaskWorktree>;
      openWorktreeFolder(id: string): Promise<void>;
      getRemoteBridgeConfig(): Promise<RemoteBridgeConfig>;
      updateRemoteBridgeConfig(input: Partial<RemoteBridgeConfig> & { token?: string; clearToken?: boolean }): Promise<RemoteBridgeConfig>;
      listRemoteBridgeSessions(): Promise<RemoteBridgeSession[]>;
      revokeRemoteBridgeSession(id: string): Promise<RemoteBridgeSession>;
      listRemoteBridgeAudit(): Promise<RemoteBridgeAuditRecord[]>;
      getIdentityContext(): Promise<IdentityContext | undefined>;
      updateIdentityContext(input: IdentityContext): Promise<IdentityContext>;
      getServstationA2AConfig(): Promise<ServstationA2AConfig>;
      updateServstationA2AConfig(input: ServstationA2AConfigUpdate): Promise<ServstationA2AConfig>;
      loginServstationOidc(input?: ServstationA2AOidcLoginInput): Promise<ServstationA2AOidcLoginResult>;
      refreshServstationOidc(): Promise<ServstationA2AConfig>;
      logoutServstationOidc(): Promise<ServstationA2AConfig>;
      connectServstationReverseBridge(): Promise<ServstationA2AConfig>;
      disconnectServstationReverseBridge(): Promise<ServstationA2AConfig>;
      getServstationClientSnapshot(query?: ServstationClientSnapshotQuery): Promise<ServstationClientSnapshot>;
      listServstationSkills(): Promise<ServstationSkillSummary[]>;
      createServstationConversation(title?: string): Promise<ServstationConversation>;
      deleteServstationConversation(id: string): Promise<void>;
      sendServstationPrompt(input: ServstationSendPromptInput): Promise<ServstationSendPromptResult>;
      cancelServstationJob(id: string): Promise<ServstationSessionJob>;
      createServstationScheduledJob(input: ServstationScheduledJobInput): Promise<ServstationScheduledJob>;
      updateServstationScheduledJob(id: string, input: Partial<ServstationScheduledJobInput>): Promise<ServstationScheduledJob>;
      deleteServstationScheduledJob(id: string): Promise<void>;
      startServstationAutopilotRun(input: ServstationAutopilotStartInput): Promise<ServstationAutopilotRun>;
      updateServstationAutopilotRun(input: ServstationAutopilotStatusUpdate): Promise<ServstationAutopilotRun>;
      getServstationFlowEngineSnapshot(): Promise<ServstationFlowEngineSnapshot>;
      launchServstationFlowEngineWorkflow(input: ServstationFlowEngineLaunchInput): Promise<ServstationFlowEngineInitiatedExecution>;
      getServstationFlowEngineExecution(id: string): Promise<ServstationFlowEngineInitiatedExecution>;
      getServstationFlowEngineExecutionEvents(id: string): Promise<ServstationFlowEngineExecutionEvent[]>;
      decideServstationFlowEngineApproval(input: ServstationFlowEngineApprovalDecisionInput): Promise<import("@supbot/shared").ServstationFlowEnginePendingTask>;
      listServstationMessages(folder: ServstationMessageFolder, unreadOnly?: boolean): Promise<ServstationMessageListResponse>;
      getServstationUnreadMessages(): Promise<ServstationMessageUnreadSummary>;
      getServstationMessage(id: string): Promise<ServstationMessageDetail>;
      markServstationMessageRead(id: string): Promise<ServstationMessageDetail>;
      setServstationMessageFavorite(id: string, favorited: boolean): Promise<ServstationMessageDetail>;
      trashServstationMessage(id: string): Promise<ServstationMessageDetail>;
      restoreServstationMessage(id: string): Promise<ServstationMessageDetail>;
      deleteServstationMessage(id: string): Promise<void>;
      fetchServstationMessageAttachment(messageId: string, attachmentId: string): Promise<ServstationMessageAttachmentContent>;
      sendServstationAgentMessage(input: ServstationSendAgentMessageInput): Promise<ServstationSessionJob>;
      sendServstationDirectMessage(input: ServstationSendDirectMessageInput): Promise<ServstationMessageDetail>;
      listServstationMailAccounts(): Promise<ServstationMailAccount[]>;
      createServstationMailAccount(input: ServstationMailAccountDraft): Promise<ServstationMailAccount>;
      updateServstationMailAccount(id: string, input: ServstationMailAccountDraft): Promise<ServstationMailAccount>;
      deleteServstationMailAccount(id: string): Promise<void>;
      setDefaultServstationMailAccount(id: string): Promise<ServstationMailAccount>;
      testServstationMailAccountConnection(id: string): Promise<ServstationMailConnectionTestResult>;
      syncServstationMailAccountNow(id: string): Promise<{ status: string }>;
      onServstationMessageEvent(listener: (event: ServstationMessageEvent) => void): () => void;
      listMemory(query?: MemorySearchQuery): Promise<MemorySearchResult[]>;
      searchMemory(query?: MemorySearchQuery): Promise<MemorySearchResult[]>;
      addMemory(input: MemoryAddInput): Promise<MemoryPage | MemoryFact>;
      updateMemory(id: string, input: MemoryUpdateInput): Promise<MemoryPage | MemoryFact>;
      deleteMemory(id: string): Promise<void>;
      approveMemoryCandidate(id: string): Promise<MemoryPage | MemoryFact>;
      denyMemoryCandidate(id: string): Promise<import("@supbot/shared").MemoryCandidate>;
      exportMemory(): Promise<MemoryTransfer>;
      importMemory(input: MemoryImportInput): Promise<MemoryImportResult>;
      backupMemory(): Promise<GeneratedFile>;
      restoreMemory(filePath?: string): Promise<MemoryImportResult>;
      replayMemoryRecall(input: MemoryReplayRecallInput): Promise<MemoryReplayRecallResult>;
      evaluateMemoryRecall(input: MemoryReplayRecallInput): Promise<MemoryReplayRecallResult>;
      addMemoryRecallFeedback(input: MemoryRecallFeedbackInput): Promise<MemoryRecallFeedback>;
      updateModelConfig(input: ModelConfigUpdate): Promise<ModelConfig>;
      testModelConfig(input?: Partial<ModelConfigUpdate>): Promise<ModelTestResult>;
      updateToolMarketConfig(input: ToolMarketConfigUpdate): Promise<ToolMarketConfig>;
      updatePersonality(input: PersonalityConfig): Promise<PersonalityConfig>;
      updateCapability(id: string, input: CapabilityUpdateInput): Promise<import("@supbot/shared").CapabilityDefinition>;
      deleteCapability(id: string): Promise<void>;
      saveSubagent(input: SubagentConfig): Promise<SubagentConfig>;
      deleteSubagent(id: string): Promise<void>;
      listToolMarket(query?: ToolMarketQuery): Promise<ToolMarketCatalogItem[]>;
      installToolMarketProduct(id: string): Promise<ToolMarketCatalogItem>;
      uninstallToolMarketProduct(id: string): Promise<ToolMarketCatalogItem>;
      listMcpServers(): Promise<McpServerSnapshot[]>;
      addMcpServer(input: McpServerInput): Promise<McpServerConfig>;
      updateMcpServer(id: string, input: McpServerUpdate): Promise<McpServerConfig>;
      removeMcpServer(id: string): Promise<void>;
      connectMcpServer(id: string): Promise<McpServerStatus>;
      disconnectMcpServer(id: string): Promise<McpServerStatus>;
      refreshMcpTools(id: string): Promise<McpToolInfo[]>;
      getMcpLogs(id: string): Promise<McpLogRecord[]>;
      listMcpPresets(): Promise<McpServerPreset[]>;
      exportMcpConfig(): Promise<McpConfigTransfer>;
      importMcpConfig(input: McpConfigTransfer): Promise<McpImportResult>;
      diagnoseMcpServer(input: McpServerInput): Promise<McpDiagnosticResult>;
      createScheduledJob(input: ScheduledJobInput): Promise<ScheduledJob>;
      updateScheduledJob(id: string, input: Partial<ScheduledJobInput>): Promise<ScheduledJob>;
      deleteScheduledJob(id: string): Promise<void>;
      pickAttachments(): Promise<Attachment[]>;
      openFile(filePath: string): Promise<void>;
      userDataPath(): Promise<string>;
      onEvent(listener: (event: SupbotEvent) => void): () => void;
    };
  }
}
