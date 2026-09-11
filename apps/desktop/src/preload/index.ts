import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  Attachment,
  FilePreviewResult,
  AutopilotStartDataRunInput,
  CapabilityUpdateInput,
  CreateConversationInput,
  IdentityContext,
  MemoryAddInput,
  MemoryImportInput,
  MemoryRecallFeedbackInput,
  MemoryReplayRecallInput,
  MemorySearchQuery,
  MemoryUpdateInput,
  McpRemoteAddInput,
  McpServerInput,
  McpServerUpdate,
  ModelConfigUpdate,
  ModelProviderUpdate,
  PermissionMode,
  PermissionRule,
  PersonalityConfig,
  ProjectCreateFromNameInput,
  ProjectCreateInput,
  ProjectUpdateInput,
  RemoteBridgeConfig,
  ScheduledJobInput,
  SendPromptInput,
  ServstationA2AConfigUpdate,
  ServstationA2AOidcLoginInput,
  ServstationAutopilotEvent,
  ServstationAutopilotStartInput,
  ServstationAutopilotStatusUpdate,
  ServstationClientSnapshotQuery,
  ServstationFlowEngineApprovalDecisionInput,
  ServstationFlowEngineLaunchInput,
  ServstationMailAccountDraft,
  ServstationMessageEvent,
  ServstationMessageFolder,
  ServstationScheduledJobInput,
  ServstationSendAgentMessageInput,
  ServstationSendDirectMessageInput,
  ServstationSendPromptInput,
  SubagentConfig,
  HBClientUpdateState,
  SupbotEvent,
  ToolMarketConfigUpdate,
  ToolMarketQuery,
  UserQuestionAnswer,
} from "@supbot/shared";

const api = {
  snapshot: (activeConversationId?: string) => ipcRenderer.invoke("snapshot", activeConversationId),
  getHBClientUpdateState: () => ipcRenderer.invoke("hbclient:update:getState"),
  checkHBClientUpdate: () => ipcRenderer.invoke("hbclient:update:check"),
  downloadHBClientUpdate: () => ipcRenderer.invoke("hbclient:update:download"),
  installHBClientUpdate: () => ipcRenderer.invoke("hbclient:update:install"),
  onHBClientUpdate: (listener: (state: HBClientUpdateState) => void) => {
    const wrapped = (_event: unknown, state: HBClientUpdateState) => listener(state);
    ipcRenderer.on("hbclient:updateState", wrapped);
    return () => ipcRenderer.off("hbclient:updateState", wrapped);
  },
  createConversation: (input?: string | CreateConversationInput) => ipcRenderer.invoke("conversation:create", input),
  deleteConversation: (id: string) => ipcRenderer.invoke("conversation:delete", id),
  sendPrompt: (input: SendPromptInput) => ipcRenderer.invoke("prompt:send", input),
  readClipboardText: () => ipcRenderer.invoke("clipboard:readText"),
  cancelJob: (id: string) => ipcRenderer.invoke("job:cancel", id),
  interruptJob: (id: string) => ipcRenderer.invoke("job:interrupt", id),
  resumeJob: (id: string) => ipcRenderer.invoke("job:resume", id),
  approveToolPermission: (id: string) => ipcRenderer.invoke("tool:approve", id),
  denyToolPermission: (id: string) => ipcRenderer.invoke("tool:deny", id),
  answerUserQuestion: (id: string, answers: UserQuestionAnswer[]) => ipcRenderer.invoke("question:answer", id, answers),
  setPermissionMode: (mode: PermissionMode) => ipcRenderer.invoke("permission:setMode", mode),
  setMemoryEnabled: (enabled: boolean) => ipcRenderer.invoke("memory:setEnabled", enabled),
  addPermissionRule: (rule: Omit<PermissionRule, "id" | "createdAt" | "scope"> & { id?: string }) =>
    ipcRenderer.invoke("permission:addRule", rule),
  removePermissionRule: (id: string) => ipcRenderer.invoke("permission:removeRule", id),
  compactConversation: (id: string) => ipcRenderer.invoke("conversation:compact", id),
  loadTranscript: (id: string) => ipcRenderer.invoke("conversation:loadTranscript", id),
  loadConversationHistory: (id: string, beforeMessageId?: string, limit?: number) =>
    ipcRenderer.invoke("conversation:loadHistory", id, beforeMessageId, limit),
  createProjectFromFolder: (input: ProjectCreateInput) => ipcRenderer.invoke("project:createFromFolder", input),
  createProjectFromName: (input: ProjectCreateFromNameInput) => ipcRenderer.invoke("project:createFromName", input),
  listProjects: () => ipcRenderer.invoke("project:list"),
  removeProject: (id: string) => ipcRenderer.invoke("project:remove", id),
  pickProjectFolder: () => ipcRenderer.invoke("project:pickFolder"),
  openProject: (id: string) => ipcRenderer.invoke("project:open", id),
  updateProject: (id: string, input: ProjectUpdateInput) => ipcRenderer.invoke("project:update", id, input),
  startAutopilotDataRun: (input: AutopilotStartDataRunInput) => ipcRenderer.invoke("autopilot:startDataRun", input),
  pauseAutopilotRun: (id: string) => ipcRenderer.invoke("autopilot:pause", id),
  resumeAutopilotRun: (id: string) => ipcRenderer.invoke("autopilot:resume", id),
  cancelAutopilotRun: (id: string) => ipcRenderer.invoke("autopilot:cancel", id),
  getAutopilotRunReport: (id: string) => ipcRenderer.invoke("autopilot:getRunReport", id),
  listWorktrees: () => ipcRenderer.invoke("worktree:list"),
  getWorktreeDiff: (id: string) => ipcRenderer.invoke("worktree:getDiff", id),
  applyWorktree: (id: string) => ipcRenderer.invoke("worktree:apply", id),
  discardWorktree: (id: string) => ipcRenderer.invoke("worktree:discard", id),
  openWorktreeFolder: (id: string) => ipcRenderer.invoke("worktree:openFolder", id),
  getRemoteBridgeConfig: () => ipcRenderer.invoke("remoteBridge:getConfig"),
  updateRemoteBridgeConfig: (input: Partial<RemoteBridgeConfig> & { token?: string; clearToken?: boolean }) =>
    ipcRenderer.invoke("remoteBridge:updateConfig", input),
  listRemoteBridgeSessions: () => ipcRenderer.invoke("remoteBridge:listSessions"),
  revokeRemoteBridgeSession: (id: string) => ipcRenderer.invoke("remoteBridge:revokeSession", id),
  listRemoteBridgeAudit: () => ipcRenderer.invoke("remoteBridge:listAudit"),
  getIdentityContext: () => ipcRenderer.invoke("identity:get"),
  updateIdentityContext: (input: IdentityContext) => ipcRenderer.invoke("identity:update", input),
  getServstationA2AConfig: () => ipcRenderer.invoke("servstationA2A:getConfig"),
  updateServstationA2AConfig: (input: ServstationA2AConfigUpdate) =>
    ipcRenderer.invoke("servstationA2A:updateConfig", input),
  loginServstationOidc: (input?: ServstationA2AOidcLoginInput) => ipcRenderer.invoke("servstationA2A:loginOidc", input),
  refreshServstationOidc: () => ipcRenderer.invoke("servstationA2A:refreshOidc"),
  logoutServstationOidc: () => ipcRenderer.invoke("servstationA2A:logoutOidc"),
  connectServstationReverseBridge: () => ipcRenderer.invoke("servstationA2A:connectReverse"),
  disconnectServstationReverseBridge: () => ipcRenderer.invoke("servstationA2A:disconnectReverse"),
  getServstationClientSnapshot: (query?: ServstationClientSnapshotQuery) =>
    ipcRenderer.invoke("servstationClient:snapshot", query),
  createServstationProject: (name: string) => ipcRenderer.invoke("servstationClient:createProject", name),
  updateServstationProject: (id: string, name: string) =>
    ipcRenderer.invoke("servstationClient:updateProject", id, name),
  deleteServstationProject: (id: string) => ipcRenderer.invoke("servstationClient:deleteProject", id),
  listServstationProjectResources: (id: string) => ipcRenderer.invoke("servstationClient:listProjectResources", id),
  deleteServstationProjectResource: (projectId: string, resourceId: string) =>
    ipcRenderer.invoke("servstationClient:deleteProjectResource", projectId, resourceId),
  createServstationConversation: (title?: string, projectId?: string) =>
    ipcRenderer.invoke("servstationClient:createConversation", title, projectId),
  deleteServstationConversation: (id: string) => ipcRenderer.invoke("servstationClient:deleteConversation", id),
  sendServstationPrompt: (input: ServstationSendPromptInput) =>
    ipcRenderer.invoke("servstationClient:sendPrompt", input),
  cancelServstationJob: (id: string) => ipcRenderer.invoke("servstationClient:cancelJob", id),
  fetchServstationJobFile: (jobId: string, fileId: string) =>
    ipcRenderer.invoke("servstationClient:fetchJobFile", jobId, fileId),
  createServstationScheduledJob: (input: ServstationScheduledJobInput) =>
    ipcRenderer.invoke("servstationClient:createScheduledJob", input),
  updateServstationScheduledJob: (id: string, input: Partial<ServstationScheduledJobInput>) =>
    ipcRenderer.invoke("servstationClient:updateScheduledJob", id, input),
  deleteServstationScheduledJob: (id: string) => ipcRenderer.invoke("servstationClient:deleteScheduledJob", id),
  startServstationAutopilotRun: (input: ServstationAutopilotStartInput) =>
    ipcRenderer.invoke("servstationClient:startAutopilotRun", input),
  updateServstationAutopilotRun: (input: ServstationAutopilotStatusUpdate) =>
    ipcRenderer.invoke("servstationClient:updateAutopilotRun", input),
  onServstationAutopilotEvent: (runId: string, listener: (event: ServstationAutopilotEvent) => void) => {
    const subscriptionId = `autopilot_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const channel = `servstationClient:autopilotEvent:${subscriptionId}`;
    const wrapped = (_event: unknown, payload: ServstationAutopilotEvent) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    ipcRenderer.invoke("servstationClient:subscribeAutopilotEvents", subscriptionId, runId).catch(() => undefined);
    return () => {
      ipcRenderer.off(channel, wrapped);
      ipcRenderer.invoke("servstationClient:unsubscribeAutopilotEvents", subscriptionId).catch(() => undefined);
    };
  },
  getServstationFlowEngineSnapshot: () => ipcRenderer.invoke("servstationClient:getFlowEngineSnapshot"),
  launchServstationFlowEngineWorkflow: (input: ServstationFlowEngineLaunchInput) =>
    ipcRenderer.invoke("servstationClient:launchFlowEngineWorkflow", input),
  getServstationFlowEngineExecution: (id: string) => ipcRenderer.invoke("servstationClient:getFlowEngineExecution", id),
  getServstationFlowEngineExecutionEvents: (id: string) =>
    ipcRenderer.invoke("servstationClient:getFlowEngineExecutionEvents", id),
  decideServstationFlowEngineApproval: (input: ServstationFlowEngineApprovalDecisionInput) =>
    ipcRenderer.invoke("servstationClient:decideFlowEngineApproval", input),
  listServstationMessages: (folder: ServstationMessageFolder, unreadOnly?: boolean) =>
    ipcRenderer.invoke("servstationClient:listMessages", folder, unreadOnly),
  getServstationUnreadMessages: () => ipcRenderer.invoke("servstationClient:getUnreadMessages"),
  getServstationMessage: (id: string) => ipcRenderer.invoke("servstationClient:getMessage", id),
  markServstationMessageRead: (id: string) => ipcRenderer.invoke("servstationClient:markMessageRead", id),
  setServstationMessageFavorite: (id: string, favorited: boolean) =>
    ipcRenderer.invoke("servstationClient:setMessageFavorite", id, favorited),
  trashServstationMessage: (id: string) => ipcRenderer.invoke("servstationClient:trashMessage", id),
  restoreServstationMessage: (id: string) => ipcRenderer.invoke("servstationClient:restoreMessage", id),
  deleteServstationMessage: (id: string) => ipcRenderer.invoke("servstationClient:deleteMessage", id),
  fetchServstationMessageAttachment: (messageId: string, attachmentId: string) =>
    ipcRenderer.invoke("servstationClient:fetchMessageAttachment", messageId, attachmentId),
  sendServstationAgentMessage: (input: ServstationSendAgentMessageInput) =>
    ipcRenderer.invoke("servstationClient:sendAgentMessage", input),
  sendServstationDirectMessage: (input: ServstationSendDirectMessageInput) =>
    ipcRenderer.invoke("servstationClient:sendDirectMessage", input),
  listServstationMailAccounts: () => ipcRenderer.invoke("servstationClient:listMailAccounts"),
  createServstationMailAccount: (input: ServstationMailAccountDraft) =>
    ipcRenderer.invoke("servstationClient:createMailAccount", input),
  updateServstationMailAccount: (id: string, input: ServstationMailAccountDraft) =>
    ipcRenderer.invoke("servstationClient:updateMailAccount", id, input),
  deleteServstationMailAccount: (id: string) => ipcRenderer.invoke("servstationClient:deleteMailAccount", id),
  setDefaultServstationMailAccount: (id: string) => ipcRenderer.invoke("servstationClient:setDefaultMailAccount", id),
  testServstationMailAccountConnection: (id: string) =>
    ipcRenderer.invoke("servstationClient:testMailAccountConnection", id),
  syncServstationMailAccountNow: (id: string) => ipcRenderer.invoke("servstationClient:syncMailAccountNow", id),
  onServstationMessageEvent: (listener: (event: ServstationMessageEvent) => void) => {
    const subscriptionId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const channel = `servstationClient:messageEvent:${subscriptionId}`;
    const wrapped = (_event: unknown, payload: ServstationMessageEvent) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    ipcRenderer.invoke("servstationClient:subscribeMessageEvents", subscriptionId).catch(() => undefined);
    return () => {
      ipcRenderer.off(channel, wrapped);
      ipcRenderer.invoke("servstationClient:unsubscribeMessageEvents", subscriptionId).catch(() => undefined);
    };
  },
  listMemory: (query?: MemorySearchQuery) => ipcRenderer.invoke("memory:list", query),
  searchMemory: (query?: MemorySearchQuery) => ipcRenderer.invoke("memory:search", query),
  addMemory: (input: MemoryAddInput) => ipcRenderer.invoke("memory:add", input),
  updateMemory: (id: string, input: MemoryUpdateInput) => ipcRenderer.invoke("memory:update", id, input),
  deleteMemory: (id: string) => ipcRenderer.invoke("memory:delete", id),
  approveMemoryCandidate: (id: string) => ipcRenderer.invoke("memory:approveCandidate", id),
  denyMemoryCandidate: (id: string) => ipcRenderer.invoke("memory:denyCandidate", id),
  exportMemory: () => ipcRenderer.invoke("memory:export"),
  importMemory: (input: MemoryImportInput) => ipcRenderer.invoke("memory:import", input),
  backupMemory: () => ipcRenderer.invoke("memory:backup"),
  restoreMemory: (filePath?: string) => ipcRenderer.invoke("memory:restore", filePath),
  replayMemoryRecall: (input: MemoryReplayRecallInput) => ipcRenderer.invoke("memory:replayRecall", input),
  evaluateMemoryRecall: (input: MemoryReplayRecallInput) => ipcRenderer.invoke("memory:evaluateRecall", input),
  addMemoryRecallFeedback: (input: MemoryRecallFeedbackInput) => ipcRenderer.invoke("memory:addRecallFeedback", input),
  updateModelConfig: (input: ModelConfigUpdate) => ipcRenderer.invoke("model:update", input),
  testModelConfig: (input?: Partial<ModelConfigUpdate>) => ipcRenderer.invoke("model:test", input),
  createModelProvider: (input: ModelProviderUpdate) => ipcRenderer.invoke("modelProvider:create", input),
  updateModelProvider: (id: string, input: ModelProviderUpdate) =>
    ipcRenderer.invoke("modelProvider:update", id, input),
  deleteModelProvider: (id: string) => ipcRenderer.invoke("modelProvider:delete", id),
  setActiveModelProvider: (id: string) => ipcRenderer.invoke("modelProvider:setActive", id),
  testModelProvider: (id?: string, input?: Partial<ModelProviderUpdate>) =>
    ipcRenderer.invoke("modelProvider:test", id, input),
  listModelProviderModels: (id?: string, input?: Partial<ModelProviderUpdate>) =>
    ipcRenderer.invoke("modelProvider:listModels", id, input),
  updateToolMarketConfig: (input: ToolMarketConfigUpdate) => ipcRenderer.invoke("market-config:update", input),
  updatePersonality: (input: PersonalityConfig) => ipcRenderer.invoke("personality:update", input),
  updateCapability: (id: string, input: CapabilityUpdateInput) => ipcRenderer.invoke("capability:update", id, input),
  deleteCapability: (id: string) => ipcRenderer.invoke("capability:delete", id),
  saveSubagent: (input: SubagentConfig) => ipcRenderer.invoke("subagent:save", input),
  deleteSubagent: (id: string) => ipcRenderer.invoke("subagent:delete", id),
  listToolMarket: (query?: ToolMarketQuery) => ipcRenderer.invoke("market:list", query),
  installToolMarketProduct: (id: string) => ipcRenderer.invoke("market:install", id),
  uninstallToolMarketProduct: (id: string) => ipcRenderer.invoke("market:uninstall", id),
  listMcpServers: () => ipcRenderer.invoke("mcp:listServers"),
  addMcpServer: (input: McpServerInput) => ipcRenderer.invoke("mcp:addServer", input),
  updateMcpServer: (id: string, input: McpServerUpdate) => ipcRenderer.invoke("mcp:updateServer", id, input),
  removeMcpServer: (id: string) => ipcRenderer.invoke("mcp:removeServer", id),
  connectMcpServer: (id: string) => ipcRenderer.invoke("mcp:connect", id),
  disconnectMcpServer: (id: string) => ipcRenderer.invoke("mcp:disconnect", id),
  refreshMcpTools: (id: string) => ipcRenderer.invoke("mcp:refreshTools", id),
  getMcpLogs: (id: string) => ipcRenderer.invoke("mcp:getLogs", id),
  listMcpPresets: () => ipcRenderer.invoke("mcp:listPresets"),
  exportMcpConfig: () => ipcRenderer.invoke("mcp:export"),
  importMcpConfig: (input: unknown) => ipcRenderer.invoke("mcp:import", input),
  diagnoseMcpServer: (input: McpServerInput) => ipcRenderer.invoke("mcp:diagnoseServer", input),
  addRemoteMcpServer: (input: McpRemoteAddInput) => ipcRenderer.invoke("mcp:add-remote", input),
  createScheduledJob: (input: ScheduledJobInput) => ipcRenderer.invoke("schedule:create", input),
  updateScheduledJob: (id: string, input: Partial<ScheduledJobInput>) =>
    ipcRenderer.invoke("schedule:update", id, input),
  deleteScheduledJob: (id: string) => ipcRenderer.invoke("schedule:delete", id),
  pickAttachments: () => ipcRenderer.invoke("attachment:pick"),
  importAttachmentPaths: (paths: string[]) => ipcRenderer.invoke("attachment:importPaths", paths),
  searchProjectFiles: (projectId: string, query: string) => ipcRenderer.invoke("file:search", { projectId, query }),
  importDroppedAttachments: (files: File[]) => {
    const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean);
    return paths.length ? ipcRenderer.invoke("attachment:importPaths", paths) : Promise.resolve([]);
  },
  // Pasted clipboard files may be in-memory blobs without a filesystem path.
  // Import path-backed files via their path and ship blob bytes to the main
  // process, which persists them under userData.
  importClipboardAttachments: async (files: File[]) => {
    const paths: string[] = [];
    const blobs: Array<{ name: string; mimeType?: string; data: Uint8Array }> = [];
    for (const file of files) {
      const filePath = webUtils.getPathForFile(file);
      if (filePath) {
        paths.push(filePath);
        continue;
      }
      blobs.push({
        name: file.name,
        mimeType: file.type || undefined,
        data: new Uint8Array(await file.arrayBuffer()),
      });
    }
    const imported: Attachment[] = [];
    if (paths.length) {
      imported.push(...((await ipcRenderer.invoke("attachment:importPaths", paths)) as Attachment[]));
    }
    if (blobs.length) {
      imported.push(...((await ipcRenderer.invoke("attachment:importData", blobs)) as Attachment[]));
    }
    return imported;
  },
  openFile: (filePath: string) => ipcRenderer.invoke("file:open", filePath),
  showFileInFolder: (filePath: string) => ipcRenderer.invoke("file:showInFolder", filePath),
  previewFile: (filePath: string): Promise<FilePreviewResult> => ipcRenderer.invoke("file:preview", filePath),
  downloadFile: (filePath: string, suggestedName?: string) =>
    ipcRenderer.invoke("file:download", filePath, suggestedName),
  userDataPath: () => ipcRenderer.invoke("path:userData"),
  onEvent: (listener: (event: SupbotEvent) => void) => {
    const wrapped = (_event: unknown, payload: SupbotEvent) => listener(payload);
    ipcRenderer.on("supbot:event", wrapped);
    return () => ipcRenderer.off("supbot:event", wrapped);
  },
};

contextBridge.exposeInMainWorld("supbot", api);
