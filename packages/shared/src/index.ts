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

export const defaultToolMarketApiUrl = "https://i-shu.com";

// Default Servstation/Botstation endpoints. The current deployment only serves
// plain HTTP on this host; migrate these defaults to https:// once TLS is available.
export const defaultServstationBaseUrl = "http://101.227.67.76:8800";
export const defaultServstationIssuerUrl = "http://101.227.67.76:8092";
export const defaultServstationClientId = "botstation-agent-client-web";
export const defaultServstationScope = "openid profile email";
export const defaultServstationRedirectUri = "http://localhost:8800/oauth2/callback";
export const defaultServstationUser = "dev-user";

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

export interface ModelProviderConfig {
  id: string;
  providerName: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  apiKeySaved: boolean;
  apiKeyStorage?: "safeStorage" | "file";
  createdAt: string;
  updatedAt: string;
}

export interface ModelProviderUpdate {
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
  kind: "skill" | "tool" | "plugin" | "mcp" | "subagent" | "scheduler" | "storage";
  description: string;
  enabled: boolean;
}

export interface CapabilityUpdateInput {
  name?: string;
  description?: string;
  enabled?: boolean;
}

export interface ToolMarketPackageFile {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

export interface ToolMarketMcpDeployment extends McpServerInput {
  id?: string;
}

export interface ToolMarketLocalDeployment {
  kind: ToolMarketProductType;
  files?: ToolMarketPackageFile[];
  capability?: CapabilityDefinition;
  mcpServer?: ToolMarketMcpDeployment;
  commandTemplates?: string[];
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
  localDeployment?: ToolMarketLocalDeployment;
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
  source?: McpServerSource;
}

export type LocalPackageKind = "skill" | "plugin" | "mcp";

export interface McpServerSource {
  kind: "tool-market" | "local-package";
  packageId?: string;
  packageKind?: LocalPackageKind;
  packagePath?: string;
  componentId?: string;
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
  source?: McpServerSource;
}

export type McpServerUpdate = Partial<McpServerInput>;

export type LocalPackageDependencyKind = "node" | "python";

export interface LocalPackageDependencyPlan {
  kind: LocalPackageDependencyKind;
  manager: "pnpm" | "yarn" | "npm" | "pip";
  command: string;
  args: string[];
  cwd: string;
  reason: string;
}

export interface LocalPackageDependencyResult extends LocalPackageDependencyPlan {
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
}

export interface LocalPackageSkillComponent {
  id: string;
  name: string;
  description: string;
  path: string;
  capabilityId: string;
}

export interface LocalPackageMcpComponent {
  id: string;
  name: string;
  path: string;
  serverId?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  skipped?: boolean;
  reason?: string;
}

export interface LocalPackageInspection {
  kind: LocalPackageKind;
  id: string;
  name: string;
  version?: string;
  description: string;
  sha256: string;
  archivePath: string;
  installPath: string;
  rootPrefix?: string;
  skills: LocalPackageSkillComponent[];
  mcpServers: LocalPackageMcpComponent[];
  dependencyPlan: LocalPackageDependencyPlan[];
  warnings: string[];
}

export interface LocalPackageInstallResult extends LocalPackageInspection {
  installedAt: string;
  replaced: boolean;
  dependencyResults: LocalPackageDependencyResult[];
  capabilityIds: string[];
  activatedMcpServerIds: string[];
  skillContext?: string;
}

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
export type TaskWorktreeMode = "git" | "scratch";

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
  mode?: TaskWorktreeMode;
  rootDir?: string;
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
  allowRemoteBind?: boolean;
  pairingCode?: string;
  updatedAt?: string;
}

export interface IdentityContext {
  tenantId: string;
  organizationId: string;
  departmentId: string;
  userId: string;
  roleIds: string[];
  source?: "manual" | "servstation";
  agentInstanceId?: string;
  servstationUrl?: string;
  updatedAt?: string;
}

export type ServstationA2AAuthMode = "identityHeaders" | "bearer" | "oidc";

export interface ServstationA2AOidcConfig {
  issuerUrl?: string;
  clientId?: string;
  scope?: string;
  redirectUri?: string;
  accessTokenExpiresAt?: string;
  refreshTokenSaved: boolean;
  userId?: string;
}

export type ServstationA2AReverseStatus = "disconnected" | "connecting" | "connected" | "error";

export interface ServstationA2AReverseConfig {
  enabled: boolean;
  status: ServstationA2AReverseStatus;
  peerId?: string;
  clientInstanceId?: string;
  connectedAt?: string;
  lastHeartbeatAt?: string;
  lastError?: string;
  updatedAt?: string;
}

export interface ServstationA2AConfig {
  enabled: boolean;
  baseUrl?: string;
  authMode: ServstationA2AAuthMode;
  bearerTokenSaved: boolean;
  staffAgentAccount?: string;
  staffAgentPasswordSaved: boolean;
  staffAgentPasswordStorage?: "safeStorage" | "file";
  oidc?: ServstationA2AOidcConfig;
  reverse?: ServstationA2AReverseConfig;
  agentInstanceId?: string;
  updatedAt?: string;
}

export interface ServstationA2AConfigUpdate {
  enabled?: boolean;
  baseUrl?: string;
  authMode?: ServstationA2AAuthMode;
  bearerToken?: string;
  clearBearerToken?: boolean;
  staffAgentAccount?: string;
  staffAgentPassword?: string;
  clearStaffAgentPassword?: boolean;
  agentInstanceId?: string;
  oidcIssuerUrl?: string;
  oidcClientId?: string;
  oidcScope?: string;
  oidcRedirectUri?: string;
  reverseEnabled?: boolean;
  reverseClientInstanceId?: string;
}

export interface ServstationServiceSkillSpec {
  name?: string;
  displayName?: string;
  description?: string;
  skillMarkdown?: string;
}

export interface ServstationServiceMcpEntry {
  name?: string;
  description?: string;
}

export interface ServstationServicePluginSpec {
  name?: string;
  skills?: ServstationServiceSkillSpec[];
  mcps?: ServstationServiceMcpEntry[];
  mcpServers?: ServstationServiceMcpEntry[];
}

export interface ServstationServiceInstallSpec {
  mcpServers?: Record<string, unknown> | ServstationServiceMcpEntry[];
  skill?: ServstationServiceSkillSpec;
  plugin?: ServstationServicePluginSpec;
  url?: string;
  openInNewTab?: boolean;
}

export interface ServstationServiceDefinition {
  serviceId: string;
  name: string;
  description: string;
  serviceType: "prompt-template" | "mcp" | "cli" | "skill" | "plugin" | "external-link" | string;
  currentVersion?: string;
  status: string;
  effectivePromptTemplate?: string;
  promptTemplateSchema?: {
    inputs?: Array<{
      name: string;
      label: string;
      type: string;
      required: boolean;
    }>;
  };
  installSpec?: ServstationServiceInstallSpec;
}

export interface ServstationInstalledService {
  agentInstanceId: string;
  serviceId: string;
  serviceVersion: string;
  status: string;
  syncedAt: string;
  lastError?: string;
}

export type ServstationLocalCapabilityAssetKind = "catalog_override" | "user_created" | "agent_generated";
export type ServstationLocalCapabilityType = "skill" | "mcp" | "prompt-template";

export interface ServstationLocalCapabilityAsset {
  assetId: string;
  tenantId: string;
  organizationId: string;
  departmentId: string;
  userId: string;
  assetKind: ServstationLocalCapabilityAssetKind | string;
  capabilityType: ServstationLocalCapabilityType | string;
  sourceServiceId?: string;
  baseServiceVersion?: string;
  name: string;
  description?: string;
  skillMarkdown?: string;
  mcpServers?: Record<string, unknown>;
  effectivePromptTemplate?: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServstationConversation {
  id: string;
  agentInstanceId: string;
  projectId?: string;
  projectName?: string;
  title: string;
  runtimeSessionId: string;
  jobCount: number;
  lastMessageAt?: string | null;
  createdAt: string;
  updatedAt: string;
  messages?: ServstationConversationMessage[];
}

export interface ServstationConversationMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  payload?: unknown;
  status?: string;
  jobId?: string;
  createdAt: string;
}

export interface ServstationSessionJob {
  id: string;
  agentInstanceId: string;
  requestId: string;
  clientId: string;
  jobType: string;
  conversationId?: string;
  projectId?: string;
  runtimeSessionId?: string;
  payload?: unknown;
  status: string;
  queuePosition: number;
  progress?: unknown;
  result?: unknown;
  terminalCode?: string;
  terminalMessage?: string;
  createdAt: string;
  startedAt?: string | null;
  heartbeatAt?: string | null;
  leaseExpiresAt?: string | null;
  finishedAt?: string | null;
}

export interface ServstationProject {
  id: string;
  agentInstanceId: string;
  name: string;
  resourceCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ServstationProjectResource {
  id: string;
  projectId: string;
  agentInstanceId: string;
  conversationId?: string;
  jobId?: string;
  resourceType: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256?: string;
  relativePath?: string;
  summary?: string;
  createdAt: string;
}

export interface ServstationDeleteProjectResponse {
  deletedProjectId: string;
  deletedResources: number;
  unlinkedConversations: number;
}

export interface ServstationDeleteProjectResourceResponse {
  deletedResourceId: string;
}

export interface ServstationScheduledJob {
  id: string;
  agentInstanceId: string;
  conversationId: string;
  title: string;
  prompt: string;
  scheduleKind: string;
  runAt?: string | null;
  cronExpr?: string;
  enabled: boolean;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServstationAutopilotEvaluation {
  jobId?: string;
  completed: boolean;
  confidence: number;
  reason?: string;
  nextPrompt?: string;
  needsUser?: boolean;
  evaluatedAt?: string;
}

export interface ServstationAutopilotEvidence {
  id: string;
  type: string;
  status: "met" | "unmet" | "unknown";
  label: string;
  source: string;
  reference?: string;
  details?: unknown;
}

export interface ServstationAutopilotSuccessCriterion {
  id: string;
  description: string;
  kind: string;
  required: boolean;
}

export type ServstationAutopilotDecision =
  | { action: "complete"; reason: string; evidence: ServstationAutopilotEvidence[] }
  | { action: "continue"; reason: string; nextPrompt: string }
  | { action: "retry"; reason: string; errorClass: string }
  | { action: "ask_user"; reason: string; question: string }
  | { action: "fail"; reason: string };

export interface ServstationAutopilotStep {
  id: string;
  runId: string;
  parentStepId?: string;
  sequence: number;
  kind: string;
  status: string;
  agentInstanceId: string;
  jobId?: string;
  attempt: number;
  input?: unknown;
  decision?: ServstationAutopilotDecision | Record<string, never>;
  evidence?: ServstationAutopilotEvidence[];
  errorClass?: string;
  progressFingerprint?: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServstationAutopilotStepListResponse {
  steps: ServstationAutopilotStep[];
}

export interface ServstationAutopilotRun {
  id: string;
  agentInstanceId: string;
  conversationId: string;
  runtimeSessionId?: string;
  goal: string;
  status: string;
  currentJobId?: string;
  retryState?: Record<string, number>;
  totalRetries?: number;
  activeTargetId?: string;
  activeTargetKind?: string;
  monitoredAgents?: Array<Record<string, unknown>>;
  monitoredJobs?: Array<Record<string, unknown>>;
  lastEvaluation?: ServstationAutopilotEvaluation;
  lifecycleStatus?: string;
  phase?: string;
  stepCount?: number;
  maxSteps?: number;
  deadlineAt?: string | null;
  successCriteria?: ServstationAutopilotSuccessCriterion[];
  latestEvidence?: ServstationAutopilotEvidence[];
  lastDecision?: ServstationAutopilotDecision;
  noProgressCount?: number;
  failureMessage?: string;
  lastCheckedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServstationAutopilotEvent {
  id: string;
  runId: string;
  agentInstanceId: string;
  jobId?: string;
  eventType: string;
  level: string;
  message: string;
  data?: unknown;
  createdAt: string;
}

export interface ServstationFlowEnginePendingTask {
  id: string;
  executionId: string;
  workflowId: string;
  spaceId: string;
  nodeId: string;
  assigneeId?: string;
  title: string;
  instructions?: string;
  approverRoles: string[];
  openUrl?: string;
  status: "pending" | "approved" | "rejected" | string;
  comment?: string;
  decision?: "approved" | "rejected";
  actedAt?: string;
  executionInput?: Record<string, unknown>;
}

export interface ServstationFlowEngineLaunchableWorkflow {
  id: string;
  slug: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ServstationFlowEngineInitiatedExecution {
  id: string;
  workflowId: string;
  workflowName?: string;
  workflowVersionId: string;
  spaceId: string;
  initiatorUserId?: string;
  status: "queued" | "running" | "waiting_approval" | "waiting_timer" | "succeeded" | "failed" | "cancelled" | string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: Record<string, unknown>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ServstationFlowEngineExecutionEvent {
  id: string;
  executionId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ServstationFlowEngineSnapshot {
  launchableWorkflows: ServstationFlowEngineLaunchableWorkflow[];
  pendingTasks: ServstationFlowEnginePendingTask[];
  executions: ServstationFlowEngineInitiatedExecution[];
  fetchedAt: string;
}

export interface ServstationFlowEngineLaunchInput {
  workflowId: string;
  input: Record<string, unknown>;
}

export interface ServstationFlowEngineApprovalDecisionInput {
  approvalId: string;
  decision: "approved" | "rejected";
  comment?: string;
}

export type ServstationMessageFolder = "inbox" | "trash";

export interface ServstationMessageAccountRef {
  tenantId: string;
  organizationId: string;
  departmentId: string;
  userId: string;
}

export interface ServstationMessageAttachmentUpload {
  fileName: string;
  contentType: string;
  contentBase64: string;
}

export interface ServstationMessageAttachmentMeta {
  attachmentId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface ServstationMessageAttachmentContent extends ServstationMessageAttachmentMeta {
  contentBase64: string;
}

export interface ServstationMessageListItem {
  messageId: string;
  sender: ServstationMessageAccountRef;
  senderAgentInstanceId?: string;
  subject: string;
  preview: string;
  attachments?: ServstationMessageAttachmentMeta[];
  attachmentCount: number;
  createdAt: string;
  readAt?: string | null;
  favorited: boolean;
  trashed: boolean;
  channel?: "internal" | "email" | string;
  externalFromAddress?: string | null;
}

export interface ServstationMessageDetail extends ServstationMessageListItem {
  body: string;
  recipients: ServstationMessageAccountRef[];
}

export interface ServstationMessageListResponse {
  messages: ServstationMessageListItem[];
}

export interface ServstationMessageUnreadSummary {
  unreadCount: number;
  messages: ServstationMessageListItem[];
}

export type ServstationMailSecurityMode = "starttls" | "tls" | "none";

export interface ServstationMailAccount {
  id: string;
  tenantId: string;
  organizationId: string;
  departmentId: string;
  userId: string;
  emailAddress: string;
  displayName: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: ServstationMailSecurityMode;
  smtpUsername: string;
  hasSmtpPassword: boolean;
  imapHost: string;
  imapPort: number;
  imapSecurity: ServstationMailSecurityMode;
  imapUsername: string;
  hasImapPassword: boolean;
  isDefault: boolean;
  enabled: boolean;
  lastSyncAt?: string | null;
  lastSyncError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ServstationMailAccountDraft {
  emailAddress: string;
  displayName: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: ServstationMailSecurityMode;
  smtpUsername: string;
  smtpPassword?: string;
  imapHost: string;
  imapPort: number;
  imapSecurity: ServstationMailSecurityMode;
  imapUsername: string;
  imapPassword?: string;
  isDefault: boolean;
  enabled: boolean;
}

export interface ServstationMailConnectionTestResult {
  imapOk: boolean;
  smtpOk: boolean;
  imapError?: string;
  smtpError?: string;
}

export interface ServstationSendAgentMessageInput {
  recipients: ServstationMessageAccountRef[];
  subject: string;
  body: string;
  attachments?: ServstationMessageAttachmentUpload[];
}

export interface ServstationSendDirectMessageInput {
  recipients: ServstationMessageAccountRef[];
  externalRecipients?: string[];
  senderMailAccountId?: string;
  subject: string;
  body: string;
  attachments?: ServstationMessageAttachmentUpload[];
}

export type ServstationMessageEvent =
  | { type: "messages.unread"; data: ServstationMessageUnreadSummary };

export interface ServstationClientSnapshot {
  connected: boolean;
  reverseStatus: ServstationA2AReverseStatus;
  baseUrl?: string;
  agentInstanceId?: string;
  identity?: IdentityContext;
  lastError?: string;
  activeConversationId?: string;
  projects: ServstationProject[];
  conversations: ServstationConversation[];
  jobs: ServstationSessionJob[];
  scheduledJobs: ServstationScheduledJob[];
  services: ServstationServiceDefinition[];
  installedServices: ServstationInstalledService[];
  localCapabilities: ServstationLocalCapabilityAsset[];
  capabilityLoadError?: string;
  autopilotRun?: ServstationAutopilotRun | null;
  autopilotEvents: ServstationAutopilotEvent[];
  autopilotSteps: ServstationAutopilotStep[];
  fetchedAt: string;
}

export interface ServstationClientSnapshotQuery {
  conversationId?: string;
}

export interface ServstationSendPromptInput {
  conversationId?: string;
  projectId?: string;
  prompt: string;
  requestId?: string;
  attachments?: Attachment[];
  allowWebSearch?: boolean;
}

export interface ServstationSendPromptResult {
  conversation: ServstationConversation;
  job: ServstationSessionJob;
  snapshot: ServstationClientSnapshot;
}

export interface ServstationScheduledJobInput {
  title?: string;
  prompt: string;
  scheduleKind: string;
  runAt?: string;
  cronExpr?: string;
  conversationId?: string;
  enabled?: boolean;
}

export interface ServstationAutopilotStartInput {
  conversationId?: string;
  goal?: string;
  prompt?: string;
  requestId?: string;
}

export interface ServstationAutopilotStatusUpdate {
  runId: string;
  status: "paused" | "watching" | "stopped";
}

export interface ServstationA2AOidcTokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  tokenType?: string;
  scope?: string;
  expiresAt?: string;
  issuerUrl: string;
  clientId: string;
}

export interface ServstationA2AOidcSessionUpdate {
  baseUrl?: string;
  issuerUrl: string;
  clientId: string;
  scope?: string;
  redirectUri?: string;
  tokens: ServstationA2AOidcTokenSet;
  identityContext?: IdentityContext;
}

export interface ServstationA2AOidcLoginInput {
  baseUrl?: string;
  issuerUrl?: string;
  clientId?: string;
  scope?: string;
  redirectUri?: string;
  loginHint?: string;
}

export interface ServstationA2AOidcLoginResult {
  config: ServstationA2AConfig;
  identityContext?: IdentityContext;
}

export interface RemoteBridgeCallerMetadata {
  requestId?: string;
  agentInstanceId?: string;
  peerId?: string;
  clientId?: string;
  userContext?: IdentityContext;
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
  requestId?: string;
  agentInstanceId?: string;
  peerId?: string;
  caller?: RemoteBridgeCallerMetadata;
  identity?: IdentityContext;
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
  | "servstation_a2a"
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
  projectId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt?: string;
  messages: ChatMessage[];
}

export interface AgentJob {
  id: string;
  conversationId: string;
  projectId?: string;
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
  projectId?: string;
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

export type ProjectStatus = "active" | "archived" | "error";

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  metadataPath: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  error?: string;
}

export interface ProjectCreateInput {
  rootPath: string;
  name?: string;
}

export interface ProjectCreateFromNameInput {
  name: string;
}

export interface ProjectUpdateInput {
  name?: string;
  status?: ProjectStatus;
}

export type DataSourceKind = "localFiles" | "folderScan" | "httpApi" | "webUrl" | "mcpTool" | "shellCommand";

export interface DataSourceSpec {
  id: string;
  kind: DataSourceKind;
  label: string;
  path?: string;
  paths?: string[];
  url?: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  mcpToolName?: string;
  shellCommand?: string;
}

export type DataArtifactKind = "raw" | "processed" | "analysis" | "report" | "output";

export type AutopilotStage = "clarify" | "inventory" | "collect" | "process" | "analyze" | "report" | "review";

export interface DataArtifact {
  id: string;
  projectId: string;
  runId: string;
  taskId?: string;
  kind: DataArtifactKind;
  stage: AutopilotStage;
  name: string;
  path: string;
  source: string;
  size: number;
  sha256?: string;
  lineCount?: number;
  createdAt: string;
}

export interface AutopilotWritePolicy {
  mode: "projectSandbox";
  allowedWriteRoots: string[];
  allowNetwork: boolean;
  allowMcp: boolean;
  maxRuntimeMinutes: number;
  maxTasks: number;
  maxRetries: number;
}

export type AutopilotRunStatus = "queued" | "planning" | "running" | "paused" | "blocked" | "reviewing" | "completed" | "failed" | "canceled";

export type AutopilotTaskStatus = "queued" | "running" | "completed" | "failed" | "blocked" | "skipped";

export interface AutopilotTask {
  id: string;
  runId: string;
  projectId: string;
  stage: AutopilotStage;
  staffAgent: string;
  title: string;
  prompt: string;
  status: AutopilotTaskStatus;
  attempts: number;
  maxAttempts: number;
  artifactIds: string[];
  evidence: string[];
  output?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AutopilotCheckpoint {
  id: string;
  runId: string;
  projectId: string;
  stage: AutopilotStage;
  status: AutopilotRunStatus;
  summary: string;
  taskIds: string[];
  artifactIds: string[];
  createdAt: string;
}

export interface AutopilotEvent {
  id: string;
  runId: string;
  projectId: string;
  taskId?: string;
  level: "info" | "warning" | "error";
  message: string;
  createdAt: string;
  data?: unknown;
}

export interface AutopilotRun {
  id: string;
  projectId: string;
  projectRoot: string;
  title: string;
  goal: string;
  status: AutopilotRunStatus;
  currentStage?: AutopilotStage;
  writePolicy: AutopilotWritePolicy;
  dataSources: DataSourceSpec[];
  taskIds: string[];
  artifactIds: string[];
  checkpointIds: string[];
  evidence: string[];
  reportPath?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface AutopilotStartDataRunInput {
  projectId: string;
  goal: string;
  title?: string;
  dataSources?: DataSourceSpec[];
  writePolicy?: Partial<AutopilotWritePolicy>;
}

export interface AutopilotRunReport {
  run: AutopilotRun;
  project?: Project;
  tasks: AutopilotTask[];
  artifacts: DataArtifact[];
  checkpoints: AutopilotCheckpoint[];
  events: AutopilotEvent[];
}

export interface RuntimeSnapshot {
  status: RuntimeStatus;
  agentName: string;
  identityContext?: IdentityContext;
  modelConfig: ModelConfig;
  modelProviders: ModelProviderConfig[];
  activeModelProviderId?: string;
  toolMarketConfig: ToolMarketConfig;
  personality: PersonalityConfig;
  capabilities: CapabilityDefinition[];
  subagents: SubagentConfig[];
  conversations: Conversation[];
  jobs: AgentJob[];
  scheduledJobs: ScheduledJob[];
  projects: Project[];
  autopilotRuns: AutopilotRun[];
  autopilotTasks: AutopilotTask[];
  autopilotEvents: AutopilotEvent[];
  autopilotCheckpoints: AutopilotCheckpoint[];
  dataArtifacts: DataArtifact[];
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
  servstationA2A: {
    config: ServstationA2AConfig;
  };
}

export type HBClientUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not_available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export interface HBClientUpdateProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export interface HBClientUpdateState {
  status: HBClientUpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  progress?: HBClientUpdateProgress;
  error?: string;
  checkedAt?: string;
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
  | { type: "project_changed"; project: Project }
  | { type: "autopilot_event"; event: AutopilotEvent }
  | { type: "data_artifact"; artifact: DataArtifact }
  | { type: "worktree_event"; worktree: TaskWorktree; event: RuntimeEventRecord }
  | { type: "remote_bridge"; config: RemoteBridgeConfig; event?: RuntimeEventRecord }
  | { type: "servstation_a2a"; config: ServstationA2AConfig; event?: RuntimeEventRecord }
  | { type: "error"; message: string };

export interface SendPromptInput {
  conversationId?: string;
  projectId?: string;
  prompt: string;
  attachments?: Attachment[];
  workspaceMode?: WorkspaceMode;
  remoteCaller?: RemoteBridgeCallerMetadata;
}

export interface SendPromptResult {
  conversation: Conversation;
  userMessage: ChatMessage;
  job: AgentJob;
}

export interface CreateConversationInput {
  title?: string;
  projectId?: string;
}

export interface ModelTestResult {
  ok: boolean;
  message: string;
}

export interface ScheduledJobInput {
  projectId?: string;
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
  maxTokens: 4096,
  apiKeySaved: false
};

export const defaultModelProviderConfig: ModelProviderConfig = {
  id: "default",
  providerName: defaultModelConfig.providerName,
  baseUrl: defaultModelConfig.baseUrl,
  model: defaultModelConfig.model,
  temperature: defaultModelConfig.temperature,
  maxTokens: defaultModelConfig.maxTokens,
  apiKeySaved: false,
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z"
};

export const defaultToolMarketConfig: ToolMarketConfig = {
  source: "hybrid",
  apiUrl: defaultToolMarketApiUrl,
  accountEmail: "subscriber@toolsmarket.local",
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

// ---- UI helpers merged from the former @supbot/ui package ----
export type SlashAction = "new" | "history" | "config" | "model" | "clear" | "copy" | "tool";

export interface SlashCommand {
  command: string;
  action: SlashAction;
  title: string;
  description: string;
  template?: string;
}

export const slashCommandTemplates: SlashCommand[] = [
  { command: "/new", action: "new", title: "New conversation", description: "Start a fresh local thread." },
  { command: "/history", action: "history", title: "History", description: "Open conversation history." },
  { command: "/config", action: "config", title: "Config", description: "Open agent configuration." },
  { command: "/model", action: "model", title: "Model", description: "Jump to model settings." },
  { command: "/clear", action: "clear", title: "Clear", description: "Create a clean chat." },
  { command: "/copy", action: "copy", title: "Copy latest", description: "Copy the newest assistant response." },
  { command: "/read", action: "tool", title: "Read file", description: "Read a local UTF-8 text file.", template: "/read " },
  { command: "/write", action: "tool", title: "Write file", description: "Create a generated local text file.", template: "/write note.txt\n" },
  { command: "/shell", action: "tool", title: "Shell", description: "Run a local shell command.", template: "/shell " }
];

export const slashCommands = slashCommandTemplates;

export function buildSlashCommands(t: (key: string) => string): SlashCommand[] {
  return slashCommandTemplates.map((item) => ({
    ...item,
    title: t(item.title),
    description: t(item.description)
  }));
}

export function resolveSlashCommand(input: string): SlashCommand | undefined {
  const head = input.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return slashCommandTemplates.find((item) => item.action !== "tool" && item.command === head);
}

export function conversationTitle(conversation: Conversation, fallback = "New conversation"): string {
  return conversation.title || conversation.messages.find((message) => message.role === "user")?.text.slice(0, 60) || fallback;
}

export function latestAssistantMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return [...messages].reverse().find((message) => message.role === "assistant");
}

export function statusLabel(status?: JobStatus, t: (key: string) => string = (key) => key): string {
  switch (status) {
    case "queued":
      return t("Queued");
    case "running":
      return t("Running");
    case "completed":
      return t("Completed");
    case "failed":
      return t("Failed");
    case "canceled":
      return t("Canceled");
    default:
      return t("Ready");
  }
}

export function statusColor(status?: JobStatus): string {
  switch (status) {
    case "queued":
      return "gold";
    case "running":
      return "cyan";
    case "completed":
      return "green";
    case "failed":
      return "red";
    case "canceled":
      return "default";
    default:
      return "blue";
  }
}

export function formatDateTime(value?: string): string {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

export function formatSchedule(job: ScheduledJob, t: (key: string, vars?: Record<string, string | number>) => string = (key, vars) => {
  if (!vars) return key;
  return Object.entries(vars).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), key);
}): string {
  if (job.scheduleKind === "once") {
    return job.runAt ? t("Once at {time}", { time: formatDateTime(job.runAt) }) : t("One-time task");
  }
  if (job.scheduleKind === "daily") {
    return job.runAt ? t("Daily around {time}", { time: new Date(job.runAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }) : t("Daily");
  }
  return job.cronExpr ? t("Cron {expr}", { expr: job.cronExpr }) : t("Cron");
}
