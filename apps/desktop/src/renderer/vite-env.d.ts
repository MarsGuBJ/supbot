/// <reference types="vite/client" />

import type {
  Attachment,
  Conversation,
  GeneratedFile,
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
  RemoteBridgeAuditRecord,
  RemoteBridgeConfig,
  RemoteBridgeSession,
  RuntimeSnapshot,
  ScheduledJob,
  ScheduledJobInput,
  SendPromptInput,
  SendPromptResult,
  SubagentConfig,
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
