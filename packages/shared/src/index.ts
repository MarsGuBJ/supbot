export type RuntimeStatus = "ready" | "running" | "error";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "canceled";

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

export type PermissionRuleBehavior = "allow" | "deny" | "ask";

export interface PermissionRule {
  id: string;
  toolName: string;
  behavior: PermissionRuleBehavior;
  scope: "session";
  createdAt: string;
}

export type ScheduleKind = "once" | "daily" | "cron";

export type ToolMarketProductType = "tool" | "skill" | "plugin" | "mcp";
export type ToolMarketSource = "local" | "remote" | "hybrid";

export const defaultToolMarketApiUrl = "http://localhost:3000/subscriber/market/api";

export interface ModelConfig {
  providerName: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  apiKeySaved: boolean;
  apiKeyStorage?: "safeStorage" | "file";
}

export interface ModelConfigUpdate {
  providerName: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface ToolMarketConfig {
  source: ToolMarketSource;
  apiUrl: string;
  accountEmail: string;
  accessTokenSaved: boolean;
  passwordSaved: boolean;
  tokenStorage?: "safeStorage" | "file";
  passwordStorage?: "safeStorage" | "file";
  lastSyncedAt?: string;
}

export interface ToolMarketConfigUpdate {
  source: ToolMarketSource;
  apiUrl: string;
  accountEmail?: string;
  accessToken?: string;
  password?: string;
  clearAccessToken?: boolean;
  clearPassword?: boolean;
}

export interface PersonalityConfig {
  summary: string;
  traits: string[];
  instructions: string;
}

export interface SubagentConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  enabled: boolean;
}

export interface CapabilityDefinition {
  id: string;
  name: string;
  kind: "skill" | "tool" | "subagent" | "scheduler" | "storage";
  description: string;
  enabled: boolean;
}

export interface ToolMarketProduct {
  id: string;
  name: string;
  type: ToolMarketProductType;
  origin?: "local" | "remote";
  providerName: string;
  description: string;
  tags: string[];
  free: boolean;
  priceLabel?: string;
  purchased?: boolean;
  sourceHealth?: string;
  capability: CapabilityDefinition;
  commandTemplates?: string[];
}

export interface ToolMarketCatalogItem extends ToolMarketProduct {
  installed: boolean;
  enabled: boolean;
  capabilityId: string;
}

export interface ToolMarketQuery {
  query?: string;
  type?: ToolMarketProductType | "all";
}

export type McpConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  enabled: boolean;
  autoConnect: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerStatus {
  serverId: string;
  state: McpConnectionState;
  toolCount: number;
  pid?: number;
  connectedAt?: string;
  lastConnectedAt?: string;
  updatedAt: string;
  lastError?: string;
  lastExitReason?: string;
  stderrPreview?: string;
}

export interface McpServerSnapshot extends McpServerConfig {
  status: McpServerStatus;
}

export interface McpToolInfo {
  serverId: string;
  serverName: string;
  name: string;
  runtimeToolName: string;
  modelToolName: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  schemaValid: boolean;
  schemaWarnings: string[];
  connected: boolean;
}

export interface McpServerInput {
  name: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  enabled?: boolean;
  autoConnect?: boolean;
}

export type McpServerUpdate = Partial<McpServerInput>;

export interface McpLogRecord {
  id: string;
  serverId: string;
  level: "info" | "warning" | "error";
  message: string;
  createdAt: string;
  data?: unknown;
}

export interface McpServerPreset {
  id: string;
  name: string;
  description: string;
  commandTemplate: string;
  argsTemplate: string[];
  cwdTemplate?: string;
  envHints: Array<{
    key: string;
    description: string;
    required: boolean;
  }>;
  docsUrl?: string;
  riskNote: string;
  serverInput: McpServerInput;
  recommendedPermissionRules: Array<{
    toolName: string;
    behavior: PermissionRuleBehavior;
  }>;
}

export interface McpConfigTransfer {
  version: 1;
  exportedAt: string;
  servers: Array<Omit<McpServerConfig, "env"> & {
    env?: Record<string, { redacted: true }>;
  }>;
  permissionRules: Array<Pick<PermissionRule, "toolName" | "behavior">>;
}

export interface McpImportResult {
  servers: McpServerConfig[];
  imported: number;
  skipped: number;
}

export interface McpDiagnosticResult {
  ok: boolean;
  serverName: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  tools: McpToolInfo[];
  toolCount: number;
  schemaWarnings: string[];
  stderrPreview?: string;
  error?: string;
  errorCode?: number;
  errorData?: unknown;
  protocolVersion?: string;
  capabilities?: unknown;
  initializeMs?: number;
  toolsListMs?: number;
}

export interface Attachment {
  id: string;
  name: string;
  path?: string;
  size: number;
  mimeType?: string;
}

export interface GeneratedFile {
  id: string;
  name: string;
  path: string;
  size: number;
  createdAt: string;
}

export type WorkspaceMode = "main" | "isolated" | "readOnly";

export type TaskWorktreeStatus = "creating" | "active" | "completed" | "applied" | "discarded" | "failed" | "abandoned";

export type WorktreeDiffStatus = "none" | "dirty" | "applied" | "discarded" | "unavailable";

export interface WorktreeDiffSummary {
  worktreeId: string;
  changedFiles: string[];
  insertions?: number;
  deletions?: number;
  summary: string;
  patch?: string;
}

export interface TaskWorktree {
  id: string;
  taskId: string;
  jobId: string;
  conversationId: string;
  baseRef: string;
  branchName: string;
  path: string;
  status: TaskWorktreeStatus;
  diffStatus: WorktreeDiffStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  appliedAt?: string;
  discardedAt?: string;
  error?: string;
  diffSummary?: WorktreeDiffSummary;
}

export interface RemoteBridgeConfig {
  enabled: boolean;
  host: string;
  port: number;
  tokenSaved: boolean;
  pairingCode?: string;
  updatedAt?: string;
}

export interface RemoteBridgeSession {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

export interface RemoteBridgeAuditRecord {
  id: string;
  sessionId?: string;
  method: string;
  path: string;
  ok: boolean;
  statusCode: number;
  message: string;
  createdAt: string;
  remoteAddress?: string;
}

export type MemoryScope = "global" | "conversation" | "subagent";

export type MemoryRecordStatus = "active" | "disabled";

export type MemoryCandidateStatus = "pending" | "approved" | "denied";

export type MemoryFactKind = "fact" | "preference" | "decision" | "task" | "warning";

export interface MemoryBaseRecord {
  id: string;
  scope: MemoryScope;
  conversationId?: string;
  subagentName?: string;
  title: string;
  content: string;
  source: string;
  status: MemoryRecordStatus;
  keywords: string[];
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  accessCount: number;
  embedding?: number[];
}

export interface MemoryPage extends MemoryBaseRecord {
  type: "page";
}

export interface MemoryFact extends MemoryBaseRecord {
  type: "fact";
  kind: MemoryFactKind;
  confidence: number;
}

export interface MemoryChunk {
  id: string;
  memoryId: string;
  memoryType: "page" | "fact";
  ordinal: number;
  heading: string;
  content: string;
  keywords: string[];
  embedding?: number[];
  createdAt: string;
}

export interface MemoryLink {
  id: string;
  sourceType: "page" | "fact";
  sourceId: string;
  targetType: "page" | "fact";
  targetId: string;
  relation: string;
  weight: number;
  createdAt: string;
}

export interface MemoryCandidate {
  id: string;
  scope: MemoryScope;
  conversationId?: string;
  subagentName?: string;
  title: string;
  content: string;
  source: string;
  kind: MemoryFactKind;
  confidence: number;
  keywords: string[];
  status: MemoryCandidateStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySearchQuery {
  query?: string;
  scope?: MemoryScope | "all";
  conversationId?: string;
  subagentName?: string;
  excludeSources?: string[];
  includeDisabled?: boolean;
  limit?: number;
  budgetChars?: number;
}

export interface MemorySearchResult {
  id: string;
  type: "page" | "fact";
  scope: MemoryScope;
  conversationId?: string;
  subagentName?: string;
  title: string;
  content: string;
  source: string;
  keywords: string[];
  score: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  status: MemoryRecordStatus;
  matchedKeywords: string[];
  reason: string;
  sourceLabel: string;
  feedback?: MemoryRecallFeedbackKind;
}

export interface MemoryAddInput {
  type?: "page" | "fact";
  scope: MemoryScope;
  conversationId?: string;
  subagentName?: string;
  title: string;
  content: string;
  source?: string;
  kind?: MemoryFactKind;
  confidence?: number;
  keywords?: string[];
}

export interface MemoryUpdateInput {
  title?: string;
  content?: string;
  status?: MemoryRecordStatus;
  scope?: MemoryScope;
  conversationId?: string;
  subagentName?: string;
  kind?: MemoryFactKind;
  confidence?: number;
  keywords?: string[];
}

export interface MemoryRecallRecord {
  id: string;
  conversationId?: string;
  subagentName?: string;
  query: string;
  resultIds: string[];
  resultCount: number;
  injected: boolean;
  budgetChars: number;
  usedChars: number;
  createdAt: string;
  results: Array<{
    id: string;
    title: string;
    score: number;
    matchedKeywords: string[];
    reason: string;
    sourceLabel: string;
  }>;
  excludedResults?: Array<{
    id: string;
    title: string;
    score: number;
    matchedKeywords: string[];
    reason: string;
    sourceLabel: string;
  }>;
  blockPreview?: string;
}

export type MemoryRecallFeedbackKind = "useful" | "irrelevant" | "stale" | "wrong";

export interface MemoryRecallFeedback {
  id: string;
  memoryId: string;
  kind: MemoryRecallFeedbackKind;
  query?: string;
  recallId?: string;
  note?: string;
  createdAt: string;
}

export interface MemoryReplayRecallInput extends MemorySearchQuery {
  query: string;
  recallId?: string;
}

export interface MemoryReplayRecallResult {
  query: string;
  recallId?: string;
  results: MemorySearchResult[];
  excludedResults: MemorySearchResult[];
  blockPreview?: string;
  budgetChars: number;
  usedChars: number;
  comparedTo?: {
    resultIds: string[];
    addedIds: string[];
    removedIds: string[];
  };
}

export interface MemoryRecallFeedbackInput {
  memoryId: string;
  kind: MemoryRecallFeedbackKind;
  query?: string;
  recallId?: string;
  note?: string;
}

export interface MemorySnapshot {
  pages: MemoryPage[];
  facts: MemoryFact[];
  chunks: MemoryChunk[];
  links: MemoryLink[];
  candidates: MemoryCandidate[];
  recallHistory: MemoryRecallRecord[];
  recallFeedback: MemoryRecallFeedback[];
}

export interface MemoryTransfer {
  version: 1;
  exportedAt: string;
  memory: MemorySnapshot;
}

export interface MemoryImportInput {
  data: MemoryTransfer | MemorySnapshot;
  mode?: "merge" | "replace";
}

export interface MemoryImportResult {
  memory: MemorySnapshot;
  imported: {
    pages: number;
    facts: number;
    chunks: number;
    links: number;
    candidates: number;
    recallHistory: number;
    recallFeedback: number;
  };
  mode: "merge" | "replace";
}

export type ChatMessageBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; toolCallId: string; toolName: string; input: unknown; status: "pending" | "running" | "completed" | "failed" | "denied" }
  | {
      type: "tool_result";
      toolCallId: string;
      toolName: string;
      output: string;
      isError?: boolean;
      outputParts?: Array<{ type: string; text: string; mimeType?: string }>;
      outputTruncated?: boolean;
    }
  | { type: "thinking"; text: string }
  | { type: "message_delta"; text: string }
  | { type: "progress"; text: string }
  | { type: "compact_summary"; boundaryId: string; summary: string }
  | { type: "subagent_start"; agentName: string; prompt: string; taskId?: string }
  | { type: "subagent_done"; agentName: string; output: string; taskId?: string; isError?: boolean }
  | { type: "error"; message: string };

export type ToolCallStatus = "pending_permission" | "running" | "completed" | "failed" | "denied";

export type RuntimeContentBlock =
  | { type: "text"; text: string }
  | RuntimeToolUse
  | RuntimeToolResult
  | RuntimeProgress
  | { type: "compact_summary"; boundaryId: string; summary: string }
  | { type: "error"; message: string };

export interface RuntimeToolUse {
  type: "tool_use";
  toolCallId: string;
  toolName: string;
  input: unknown;
  status: ToolCallStatus;
}

export interface RuntimeToolResult {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  output: string;
  isError?: boolean;
  outputParts?: Array<{ type: string; text: string; mimeType?: string }>;
  outputTruncated?: boolean;
}

export interface RuntimeProgress {
  type: "progress";
  text: string;
  toolCallId?: string;
}

export interface RuntimeMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: RuntimeContentBlock[];
  createdAt: string;
  jobId?: string;
}

export interface ToolCallRecord {
  id: string;
  jobId: string;
  conversationId: string;
  toolName: string;
  input: unknown;
  status: ToolCallStatus;
  createdAt: string;
  updatedAt: string;
  output?: string;
  outputParts?: Array<{
    type: string;
    text: string;
    mimeType?: string;
  }>;
  outputTruncated?: boolean;
  error?: string;
}

export interface PendingToolPermission {
  id: string;
  jobId: string;
  conversationId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  summary: string;
  executionPath?: string;
  createdAt: string;
}

export interface AgentLoopTrace {
  jobId: string;
  conversationId: string;
  turns: number;
  toolCalls: ToolCallRecord[];
  startedAt: string;
  updatedAt: string;
}

export type QuerySessionStatus = "running" | "completed" | "failed" | "canceled";

export interface QuerySession {
  id: string;
  jobId: string;
  conversationId: string;
  status: QuerySessionStatus;
  turns: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
  subagentName?: string;
}

export type RuntimeEventKind =
  | "query_start"
  | "message_delta"
  | "tool_use_start"
  | "tool_progress"
  | "tool_result"
  | "compact"
  | "permission_decision"
  | "permission_timeout"
  | "subagent_start"
  | "subagent_done"
  | "transcript_recovery"
  | "memory_recall"
  | "memory_candidate"
  | "memory_write"
  | "mcp_server"
  | "worktree_event"
  | "remote_bridge"
  | "turn_complete"
  | "turn_failed";

export interface RuntimeEventRecord {
  id: string;
  jobId?: string;
  conversationId?: string;
  kind: RuntimeEventKind;
  message: string;
  createdAt: string;
  data?: unknown;
}

export interface CompactBoundary {
  id: string;
  conversationId: string;
  jobId?: string;
  messageId?: string;
  summary: string;
  preservedMessageIds: string[];
  originalMessageCount: number;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  text: string;
  createdAt: string;
  jobId?: string;
  status?: JobStatus;
  attachments?: Attachment[];
  generatedFiles?: GeneratedFile[];
  blocks?: ChatMessageBlock[];
  toolCallId?: string;
  toolName?: string;
}

export interface TranscriptDiagnostic {
  level: "warning" | "error";
  message: string;
  line?: number;
  createdAt: string;
}

export type TranscriptRecord =
  | ({ type: "message"; message: ChatMessage } & { recordedAt?: string })
  | ({ type: "event"; event: RuntimeEventRecord } & { recordedAt?: string })
  | ({ type: "compact"; boundary: CompactBoundary } & { recordedAt?: string });

export interface TranscriptLoadResult {
  conversationId: string;
  entries: TranscriptRecord[];
  activeMessages: ChatMessage[];
  compactBoundary?: CompactBoundary;
  source: "transcript" | "state";
  diagnostics: TranscriptDiagnostic[];
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  messages: ChatMessage[];
}

export interface AgentJob {
  id: string;
  conversationId: string;
  prompt: string;
  status: JobStatus;
  workspaceMode?: WorkspaceMode;
  worktreeId?: string;
  baseRef?: string;
  diffStatus?: WorktreeDiffStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  progress: string[];
}

export interface ScheduledJob {
  id: string;
  title: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  runAt?: string;
  cronExpr?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
}

export interface RuntimeSnapshot {
  status: RuntimeStatus;
  agentName: string;
  modelConfig: ModelConfig;
  toolMarketConfig: ToolMarketConfig;
  personality: PersonalityConfig;
  capabilities: CapabilityDefinition[];
  subagents: SubagentConfig[];
  conversations: Conversation[];
  jobs: AgentJob[];
  scheduledJobs: ScheduledJob[];
  pendingToolPermissions: PendingToolPermission[];
  agentLoopTraces: AgentLoopTrace[];
  querySessions: QuerySession[];
  runtimeEvents: RuntimeEventRecord[];
  compactBoundaries: CompactBoundary[];
  memory: MemorySnapshot;
  permissionMode: PermissionMode;
  permissionRules: PermissionRule[];
  mcpServers: McpServerSnapshot[];
  mcpTools: McpToolInfo[];
  worktrees: TaskWorktree[];
  remoteBridge: {
    config: RemoteBridgeConfig;
    sessions: RemoteBridgeSession[];
    audit: RemoteBridgeAuditRecord[];
  };
}

export type SupbotEvent =
  | { type: "snapshot"; snapshot: RuntimeSnapshot }
  | { type: "job"; job: AgentJob }
  | { type: "message"; conversationId: string; message: ChatMessage }
  | { type: "tool_permission"; permission: PendingToolPermission }
  | { type: "tool_progress"; toolCall: ToolCallRecord }
  | { type: "query_event"; event: RuntimeEventRecord }
  | { type: "message_delta"; conversationId: string; messageId: string; delta: string }
  | { type: "compact"; boundary: CompactBoundary }
  | { type: "memory_candidate"; candidate: MemoryCandidate }
  | { type: "memory_changed"; memory: MemorySnapshot }
  | { type: "permission_timeout"; permission: PendingToolPermission }
  | { type: "subagent_event"; event: RuntimeEventRecord }
  | { type: "worktree_event"; worktree: TaskWorktree; event: RuntimeEventRecord }
  | { type: "remote_bridge"; config: RemoteBridgeConfig; event?: RuntimeEventRecord }
  | { type: "error"; message: string };

export interface SendPromptInput {
  conversationId?: string;
  prompt: string;
  attachments?: Attachment[];
  workspaceMode?: WorkspaceMode;
}

export interface SendPromptResult {
  conversation: Conversation;
  userMessage: ChatMessage;
  job: AgentJob;
}

export interface ModelTestResult {
  ok: boolean;
  message: string;
}

export interface ScheduledJobInput {
  title: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  runAt?: string;
  cronExpr?: string;
  enabled?: boolean;
}

export const defaultModelConfig: ModelConfig = {
  providerName: "OpenAI Compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  temperature: 0.2,
  maxTokens: 1600,
  apiKeySaved: false
};

export const defaultToolMarketConfig: ToolMarketConfig = {
  source: "hybrid",
  apiUrl: defaultToolMarketApiUrl,
  accountEmail: "subscriber@example.com",
  accessTokenSaved: false,
  passwordSaved: false
};

export const defaultPersonality: PersonalityConfig = {
  summary: "A careful local desktop agent for coding, documents, and day-to-day automation.",
  traits: ["precise", "calm", "proactive"],
  instructions: "Work locally, explain important actions, and keep user data on this machine."
};

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

export function nowIso(): string {
  return new Date().toISOString();
}
