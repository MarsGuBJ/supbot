import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AppstoreAddOutlined,
  AppstoreOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  CompressOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  MailOutlined,
  MessageOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ApiOutlined,
  OrderedListOutlined,
  PaperClipOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  RollbackOutlined,
  SaveOutlined,
  SendOutlined,
  SettingOutlined,
  StarFilled,
  StarOutlined,
  StopOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  ToolOutlined
} from "@ant-design/icons";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfigProvider,
  Descriptions,
  Divider,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Slider,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message
} from "antd";
import type { FormInstance } from "antd/es/form";
import type { TextAreaRef } from "antd/es/input/TextArea";
import type { UploadFile } from "antd/es/upload/interface";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import type {
  AgentJob,
  AutopilotRun,
  Attachment,
  CapabilityUpdateInput,
  ChatMessage,
  CompactBoundary,
  Conversation,
  IdentityContext,
  MemoryAddInput,
  MemoryCandidate,
  MemoryFactKind,
  MemoryReplayRecallResult,
  MemoryScope,
  MemorySearchResult,
  McpConfigTransfer,
  McpDiagnosticResult,
  McpLogRecord,
  McpServerInput,
  McpServerPreset,
  McpServerSnapshot,
  ModelConfigUpdate,
  PendingToolPermission,
  PermissionRule,
  PersonalityConfig,
  Project,
  RemoteBridgeConfig,
  RuntimeEventRecord,
  RuntimeSnapshot,
  ScheduledJobInput,
  ServstationA2AConfigUpdate,
  ServstationAutopilotRun,
  ServstationClientSnapshot,
  ServstationConversation,
  ServstationFlowEngineExecutionEvent,
  ServstationFlowEngineInitiatedExecution,
  ServstationFlowEngineLaunchableWorkflow,
  ServstationFlowEnginePendingTask,
  ServstationFlowEngineSnapshot,
  ServstationMailAccount,
  ServstationMailAccountDraft,
  ServstationMailSecurityMode,
  ServstationMessageAccountRef,
  ServstationMessageAttachmentContent,
  ServstationMessageAttachmentUpload,
  ServstationMessageDetail,
  ServstationMessageFolder,
  ServstationMessageListItem,
  ServstationScheduledJob,
  ServstationSessionJob,
  SubagentConfig,
  ToolCallRecord,
  ToolMarketCatalogItem,
  ToolMarketConfigUpdate,
  ToolMarketProductType,
  TranscriptLoadResult
} from "@supbot/shared";
import {
  conversationTitle,
  buildSlashCommands,
  formatDateTime,
  formatSchedule,
  latestAssistantMessage,
  resolveSlashCommand,
  statusColor,
  statusLabel
} from "@supbot/ui";
import { loadLanguage, saveLanguage, translate, type Language } from "./i18n";
import "./styles.css";

type WorkspaceView = "chat" | "server" | "config" | "market";
type DetailPanel = "memory" | "schedule" | "autopilot" | null;
type Translator = (key: string, vars?: Record<string, string | number>) => string;
type SelectionContextMenu = { x: number; y: number; text: string };
type PromptContextMenu = { x: number; y: number; selectionStart: number; selectionEnd: number; selectedText: string };
const defaultToolMarketApiUrl = "https://i-shu.com";
const defaultBotstationBaseUrl = "http://localhost:8081";
const defaultBotstationIssuerUrl = "http://localhost:8092";
const defaultBotstationClientId = "botstation-agent-client-web";
const defaultBotstationScope = "openid profile email";
const defaultBotstationRedirectUri = "http://localhost:8800/oauth2/callback";
const defaultBotstationUser = "dev-user";
const hiddenSlashCommandCapabilityIds = new Set(["tool.file", "tool.shell"]);
const hiddenChatGeneratedFileExtensions = new Set([
  ".bat",
  ".cmd",
  ".cjs",
  ".fish",
  ".js",
  ".jsx",
  ".mjs",
  ".pl",
  ".ps1",
  ".psd1",
  ".psm1",
  ".py",
  ".rb",
  ".sh",
  ".ts",
  ".tsx",
  ".vbs",
  ".wsf",
  ".zsh"
]);

const theme = {
  token: {
    colorPrimary: "#D4750A",
    colorInfo: "#D4750A",
    colorSuccess: "#10b981",
    colorWarning: "#f59e0b",
    colorError: "#ef4444",
    colorBgBase: "#FFFAF5",
    colorTextBase: "#1a1d23",
    colorBorder: "#dde0e5",
    borderRadius: 8,
    fontFamily: "Aptos, Bahnschrift, Segoe UI, sans-serif"
  },
  components: {
    Button: { borderRadius: 8, primaryShadow: "0 8px 22px rgba(212, 117, 10, 0.16)" },
    Input: { borderRadius: 8, activeBorderColor: "#D4750A", hoverBorderColor: "#FFD6A8" },
    Select: { optionSelectedBg: "#FFEFE0" },
    Segmented: { itemSelectedBg: "#FFEFE0", itemSelectedColor: "#B8650A" },
    Tag: { borderRadiusSM: 6 },
    Card: { borderRadius: 8 }
  }
};

function App() {
  const [language, setLanguageState] = useState<Language>(() => loadLanguage());
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [view, setView] = useState<WorkspaceView>("chat");
  const [detailPanel, setDetailPanel] = useState<DetailPanel>("memory");
  const [activeConversationId, setActiveConversationId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [subagentOpen, setSubagentOpen] = useState(false);
  const [editingSubagent, setEditingSubagent] = useState<SubagentConfig | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [transcriptResult, setTranscriptResult] = useState<TranscriptLoadResult | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [focusConfigTab, setFocusConfigTab] = useState("model");
  const [userDataPath, setUserDataPath] = useState("");
  const [messageApi, contextHolder] = message.useMessage();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const messageStackRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const t = useCallback((key: string, vars?: Record<string, string | number>) => translate(language, key, vars), [language]);
  const slashCommandList = useMemo(() => buildSlashCommands(t), [t]);

  const updateMessageStickiness = useCallback(() => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom <= 48;
  }, []);

  const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const element = scrollRef.current;
    if (!element) {
      return;
    }
    const top = Math.max(0, element.scrollHeight - element.clientHeight);
    if (behavior === "auto") {
      element.scrollTop = top;
      return;
    }
    element.scrollTo({ top, behavior });
  }, []);

  const setLanguage = (next: Language) => {
    setLanguageState(next);
    saveLanguage(next);
  };

  const refresh = useCallback(async () => {
    const next = await window.supbot.snapshot();
    setSnapshot(next);
    setActiveConversationId((current) => current || next.conversations[0]?.id || "");
  }, []);

  useEffect(() => {
    void refresh();
    void window.supbot.userDataPath().then(setUserDataPath);
    return window.supbot.onEvent((event) => {
      if (event.type === "snapshot") {
        setSnapshot(event.snapshot);
        setActiveConversationId((current) => current || event.snapshot.conversations[0]?.id || "");
      }
      if (event.type === "message_delta") {
        setSnapshot((current) => current ? applyMessageDelta(current, event.conversationId, event.messageId, event.delta) : current);
      }
      if (event.type === "message") {
        setSnapshot((current) => current ? applyMessageEvent(current, event.conversationId, event.message) : current);
      }
      if (event.type === "job") {
        setSnapshot((current) => current ? applyJobEvent(current, event.job) : current);
      }
      if (event.type === "tool_progress") {
        setSnapshot((current) => current ? applyToolProgress(current, event.toolCall) : current);
      }
      if (event.type === "tool_permission") {
        setSnapshot((current) => current ? applyPendingPermission(current, event.permission) : current);
      }
      if (event.type === "permission_timeout") {
        setSnapshot((current) => current ? clearPendingPermission(current, event.permission) : current);
      }
      if (event.type === "compact") {
        setSnapshot((current) => current ? applyCompactBoundary(current, event.boundary) : current);
      }
      if (event.type === "memory_changed") {
        setSnapshot((current) => current ? { ...current, memory: event.memory } : current);
      }
      if (event.type === "memory_candidate") {
        setSnapshot((current) => current ? applyMemoryCandidate(current, event.candidate) : current);
      }
      if (event.type === "query_event" || event.type === "subagent_event") {
        setSnapshot((current) => current ? applyRuntimeEvent(current, event.event) : current);
      }
      if (event.type === "servstation_a2a") {
        setSnapshot((current) => current ? {
          ...applyRuntimeEvent(current, event.event!),
          servstationA2A: { config: event.config }
        } : current);
      }
      if (event.type === "error") {
        message.error(event.message);
      }
    });
  }, [refresh]);

  useEffect(() => {
    if (view !== "chat") {
      return;
    }
    shouldStickToBottomRef.current = true;
    const frame = window.requestAnimationFrame(() => scrollMessagesToBottom("auto"));
    return () => window.cancelAnimationFrame(frame);
  }, [activeConversationId, scrollMessagesToBottom, view]);

  useEffect(() => {
    if (view !== "chat") {
      return;
    }
    const scrollElement = scrollRef.current;
    const stackElement = messageStackRef.current;
    if (!scrollElement || !stackElement || typeof ResizeObserver === "undefined") {
      return;
    }
    let frame = 0;
    const keepPinned = () => {
      if (shouldStickToBottomRef.current) {
        scrollElement.scrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
      }
    };
    const schedulePin = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(keepPinned);
    };
    const observer = new ResizeObserver(schedulePin);
    observer.observe(stackElement);
    schedulePin();
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeConversationId, view]);

  useEffect(() => {
    if (!shouldStickToBottomRef.current) {
      return;
    }
    const frame = window.requestAnimationFrame(() => scrollMessagesToBottom("smooth"));
    return () => window.cancelAnimationFrame(frame);
  }, [snapshot?.conversations, scrollMessagesToBottom]);

  const activeConversation = useMemo(
    () => snapshot?.conversations.find((item) => item.id === activeConversationId) || snapshot?.conversations[0],
    [snapshot?.conversations, activeConversationId]
  );
  const runningJob = useMemo(
    () => {
      const conversationId = activeConversation?.id || activeConversationId;
      if (!conversationId) {
        return undefined;
      }
      return snapshot?.jobs.find((job) =>
        job.conversationId === conversationId && (job.status === "queued" || job.status === "running")
      );
    },
    [activeConversation?.id, activeConversationId, snapshot?.jobs]
  );
  const startNewConversation = async () => {
    const conversation = await window.supbot.createConversation();
    setActiveConversationId(conversation.id);
    setPrompt("");
    setView("chat");
    await refresh();
  };

  const openConfig = (tab = "model") => {
    setFocusConfigTab(tab);
    setView("config");
  };

  const runSlashAction = async (text: string): Promise<boolean> => {
    const command = resolveSlashCommand(text);
    if (!command) {
      return false;
    }
    setPrompt("");
    if (command.action === "new" || command.action === "clear") {
      await startNewConversation();
    } else if (command.action === "history") {
      setLeftCollapsed(false);
      setView("chat");
    } else if (command.action === "config") {
      openConfig("model");
    } else if (command.action === "model") {
      setModelOpen(true);
      openConfig("model");
    } else if (command.action === "copy") {
      await copyLatest();
    }
    return true;
  };

  const send = async () => {
    const text = prompt.trim();
    if (!text || sending) {
      return;
    }
    if (text.startsWith("/") && await runSlashAction(text)) {
      return;
    }
    setSending(true);
    setPrompt("");
    setAttachments([]);
    try {
      const result = await window.supbot.sendPrompt({
        conversationId: activeConversation?.id,
        prompt: text,
        attachments
      });
      setActiveConversationId(result.conversation.id);
      await refresh();
    } catch (error) {
      setPrompt(text);
      messageApi.error((error as Error).message);
    } finally {
      setSending(false);
    }
  };

  const stopRunning = async () => {
    if (!runningJob) {
      return;
    }
    await window.supbot.cancelJob(runningJob.id);
    await refresh();
  };

  const approveToolPermission = useCallback(async (id: string) => {
    try {
      await window.supbot.approveToolPermission(id);
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
    }
  }, [messageApi, refresh]);

  const denyToolPermission = useCallback(async (id: string) => {
    try {
      await window.supbot.denyToolPermission(id);
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
    }
  }, [messageApi, refresh]);

  const pickAttachments = async () => {
    const picked = await window.supbot.pickAttachments();
    setAttachments((items) => [...items, ...picked]);
  };

  const copyLatest = async () => {
    const latest = activeConversation ? latestAssistantMessage(activeConversation.messages) : undefined;
    if (!latest) {
      messageApi.info(t("No assistant response to copy yet."));
      return;
    }
    await navigator.clipboard.writeText(latest.text);
    messageApi.success(t("Copied latest response."));
  };

  const copySelectedText = useCallback(async (text: string) => {
    try {
      await writeClipboardText(text);
      messageApi.success(t("已复制选中文本。"));
    } catch (error) {
      messageApi.error((error as Error).message);
    }
  }, [messageApi, t]);

  const addSelectedTextToMemory = useCallback(async (text: string) => {
    const content = text.trim();
    if (!content) {
      return;
    }
    try {
      await window.supbot.addMemory({
        type: "fact",
        scope: "global",
        title: selectionMemoryTitle(content),
        content,
        source: "chat-selection",
        kind: "fact"
      });
      messageApi.success(t("Memory saved."));
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
    }
  }, [messageApi, refresh, t]);

  const compactActiveConversation = useCallback(async () => {
    if (!activeConversation) {
      return;
    }
    await window.supbot.compactConversation(activeConversation.id);
    messageApi.success(t("Conversation compacted."));
    await refresh();
  }, [activeConversation, messageApi, refresh, t]);

  const loadActiveTranscript = useCallback(async () => {
    if (!activeConversation) {
      return;
    }
    setTranscriptOpen(true);
    setTranscriptLoading(true);
    try {
      const result = await window.supbot.loadTranscript(activeConversation.id);
      setTranscriptResult(result);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setTranscriptLoading(false);
    }
  }, [activeConversation, messageApi]);

  const saveModel = async (values: ModelConfigUpdate) => {
    await window.supbot.updateModelConfig(values);
    setModelOpen(false);
    messageApi.success(t("Model configuration saved."));
    await refresh();
  };

  if (!snapshot) {
    return (
      <ConfigProvider theme={theme}>
        <div className="boot-screen">
          <div className="brand-mark"><RobotOutlined /></div>
          <Typography.Title level={3}>{t("Starting HBClient")}</Typography.Title>
        </div>
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider theme={theme} locale={language === "zh" ? zhCN : enUS}>
      {contextHolder}
      <main className="workspace-shell">
        <Topbar
          snapshot={snapshot}
          view={view}
          setView={setView}
          refresh={refresh}
          language={language}
          setLanguage={setLanguage}
          leftCollapsed={leftCollapsed}
          rightCollapsed={rightCollapsed}
          setLeftCollapsed={setLeftCollapsed}
          setRightCollapsed={setRightCollapsed}
        />
        {view === "chat" ? (
          <section className={`workspace-grid ${leftCollapsed ? "left-collapsed" : ""} ${rightCollapsed ? "right-collapsed" : ""}`}>
            <LeftPanel
              snapshot={snapshot}
              activeConversationId={activeConversation?.id || ""}
              setActiveConversationId={setActiveConversationId}
              collapsed={leftCollapsed}
              refresh={refresh}
              startNewConversation={startNewConversation}
              t={t}
            />
            <ChatPanel
              conversation={activeConversation}
              prompt={prompt}
              setPrompt={setPrompt}
              attachments={attachments}
              setAttachments={setAttachments}
              sending={sending}
              runningJob={runningJob}
              pendingToolPermissions={snapshot.pendingToolPermissions}
              approveToolPermission={approveToolPermission}
              denyToolPermission={denyToolPermission}
              send={send}
              stopRunning={stopRunning}
              pickAttachments={pickAttachments}
              copyLatest={copyLatest}
              copySelectedText={copySelectedText}
              addSelectedTextToMemory={addSelectedTextToMemory}
              compactConversation={compactActiveConversation}
              loadTranscript={loadActiveTranscript}
              scrollRef={scrollRef}
              messageStackRef={messageStackRef}
              onMessageScroll={updateMessageStickiness}
              t={t}
              slashCommands={slashCommandList}
            />
            <RightPanel
              snapshot={snapshot}
              activeConversationId={activeConversation?.id || ""}
              panel={detailPanel}
              setPanel={setDetailPanel}
              collapsed={rightCollapsed}
              refresh={refresh}
              t={t}
              openSchedule={() => setScheduleOpen(true)}
            />
          </section>
        ) : view === "server" ? (
          <ServerAgentWorkspace
            snapshot={snapshot}
            refreshRuntime={refresh}
            t={t}
          />
        ) : view === "config" ? (
          <ConfigWorkspace
            snapshot={snapshot}
            userDataPath={userDataPath}
            focusTab={focusConfigTab}
            setFocusTab={setFocusConfigTab}
            openModel={() => setModelOpen(true)}
            refresh={refresh}
            t={t}
            openSubagent={(subagent) => {
              setEditingSubagent(subagent);
              setSubagentOpen(true);
            }}
          />
        ) : (
          <MarketWorkspace
            refresh={refresh}
            snapshot={snapshot}
            openMarketConfig={() => {
              setFocusConfigTab("market");
              setView("config");
            }}
            openMcpConfig={() => {
              setFocusConfigTab("mcp");
              setView("config");
            }}
            t={t}
          />
        )}
      </main>
      <ModelModal open={modelOpen} config={snapshot.modelConfig} onCancel={() => setModelOpen(false)} onSave={saveModel} t={t} />
      <SubagentModal
        open={subagentOpen}
        subagent={editingSubagent}
        onCancel={() => setSubagentOpen(false)}
        t={t}
        onSave={async (subagent) => {
          await window.supbot.saveSubagent(subagent);
          setSubagentOpen(false);
          setEditingSubagent(null);
          await refresh();
        }}
      />
      <ScheduleModal
        open={scheduleOpen}
        onCancel={() => setScheduleOpen(false)}
        t={t}
        onSave={async (input) => {
          await window.supbot.createScheduledJob(input);
          setScheduleOpen(false);
          setDetailPanel("schedule");
          await refresh();
        }}
      />
      <TranscriptModal
        open={transcriptOpen}
        result={transcriptResult}
        loading={transcriptLoading}
        onCancel={() => setTranscriptOpen(false)}
        t={t}
      />
    </ConfigProvider>
  );
}

function Topbar({
  snapshot,
  view,
  setView,
  refresh,
  language,
  setLanguage,
  leftCollapsed,
  rightCollapsed,
  setLeftCollapsed,
  setRightCollapsed
}: {
  snapshot: RuntimeSnapshot;
  view: WorkspaceView;
  setView: (view: WorkspaceView) => void;
  refresh: () => void;
  language: Language;
  setLanguage: (language: Language) => void;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  setLeftCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  setRightCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <header className="topbar">
      <div className="identity">
        <div className="brand-mark small"><RobotOutlined /></div>
        <div>
          <div className="eyebrow">{translate(language, "LOCAL AGENT CONSOLE")}</div>
          <div className="agent-title">{snapshot.agentName}</div>
          <div className="muted mono">{snapshot.modelConfig.providerName} / {snapshot.modelConfig.model}</div>
        </div>
      </div>
      <Segmented
        value={view}
        onChange={(value) => setView(value as WorkspaceView)}
        options={[
          { label: translate(language, "Chat"), value: "chat" },
          { label: translate(language, "Server Agent"), value: "server" },
          { label: translate(language, "Config"), value: "config" }
        ]}
      />
      <div className="topbar-actions">
        <Segmented
          size="small"
          value={language}
          onChange={(value) => setLanguage(value as Language)}
          options={[
            { label: "中文", value: "zh" },
            { label: "EN", value: "en" }
          ]}
        />
        <div className={`runtime-pill is-${snapshot.status}`}>
          <span className="status-dot" />
          {snapshot.status === "running" ? translate(language, "Running") : translate(language, "Ready")}
        </div>
        <Tooltip title={translate(language, "Refresh")}>
          <Button icon={<ReloadOutlined />} onClick={refresh} />
        </Tooltip>
        {view === "chat" ? (
          <>
            <Tooltip title={translate(language, "Toggle left panel")}>
              <Button icon={leftCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setLeftCollapsed((value) => !value)} />
            </Tooltip>
            <Tooltip title={translate(language, "Toggle right panel")}>
              <Button icon={rightCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setRightCollapsed((value) => !value)} />
            </Tooltip>
          </>
        ) : null}
      </div>
    </header>
  );
}

function LeftPanel({
  snapshot,
  activeConversationId,
  setActiveConversationId,
  collapsed,
  refresh,
  startNewConversation,
  t
}: {
  snapshot: RuntimeSnapshot;
  activeConversationId: string;
  setActiveConversationId: (id: string) => void;
  collapsed: boolean;
  refresh: () => void;
  startNewConversation: () => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [creatingConversation, setCreatingConversation] = useState(false);
  const createConversation = async () => {
    setCreatingConversation(true);
    try {
      await startNewConversation();
    } finally {
      setCreatingConversation(false);
    }
  };
  return (
    <aside className={`side-panel ${collapsed ? "is-collapsed" : ""}`}>
      <div className="panel-scroll">
        <section className="panel-section">
          <div className="panel-heading">
            <div className="section-title"><ClockCircleOutlined /> {t("Conversation history")}</div>
            <Tooltip title={t("New conversation")}>
              <Button
                size="small"
                type="primary"
                icon={<PlusOutlined />}
                aria-label={t("New conversation")}
                loading={creatingConversation}
                onClick={() => void createConversation()}
              />
            </Tooltip>
          </div>
          <HistoryPanel
            conversations={snapshot.conversations}
            activeConversationId={activeConversationId}
            setActiveConversationId={setActiveConversationId}
            refresh={refresh}
            t={t}
            embedded
          />
        </section>
      </div>
      <ServerAgentConnectionButton snapshot={snapshot} refresh={refresh} t={t} />
    </aside>
  );
}

function ServerAgentConnectionButton({
  snapshot,
  refresh,
  t
}: {
  snapshot: RuntimeSnapshot;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [messageApi, contextHolder] = message.useMessage();
  const [busy, setBusy] = useState(false);
  const config = snapshot.servstationA2A.config;
  const identity = snapshot.identityContext;
  const reverseStatus = config.reverse?.status || "disconnected";
  const isConnected = reverseStatus === "connected";
  const isConnecting = reverseStatus === "connecting";

  if (!config.staffAgentAccount) {
    return null;
  }

  const toggleConnection = async () => {
    setBusy(true);
    try {
      if (isConnected) {
        await window.supbot.disconnectServstationReverseBridge();
      } else {
        await ensureServstationOidcSession(config, identity, config.staffAgentAccount);
        await window.supbot.connectServstationReverseBridge();
      }
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="server-agent-connect">
      {contextHolder}
      <Button
        block
        type={isConnected ? "default" : "primary"}
        className={`server-agent-button ${isConnected ? "is-connected" : ""}`}
        icon={isConnected ? <CheckCircleOutlined /> : <ApiOutlined />}
        loading={busy || isConnecting}
        onClick={() => void toggleConnection()}
      >
        {isConnected ? t("Server connected") : t("Connect server Agent")}
      </Button>
    </section>
  );
}

function hasUsableServstationOidcSession(config: RuntimeSnapshot["servstationA2A"]["config"]): boolean {
  if (config.oidc?.refreshTokenSaved) {
    return true;
  }
  if (!config.oidc?.accessTokenExpiresAt) {
    return false;
  }
  return new Date(config.oidc.accessTokenExpiresAt).getTime() > Date.now() + 60_000;
}

async function ensureServstationOidcSession(
  config: RuntimeSnapshot["servstationA2A"]["config"],
  identity: RuntimeSnapshot["identityContext"],
  loginHint?: string
): Promise<void> {
  if (config.authMode !== "oidc") {
    return;
  }
  const login = () => window.supbot.loginServstationOidc({
    baseUrl: config.baseUrl || identity?.servstationUrl || defaultBotstationBaseUrl,
    issuerUrl: config.oidc?.issuerUrl || defaultBotstationIssuerUrl,
    clientId: config.oidc?.clientId || defaultBotstationClientId,
    scope: config.oidc?.scope || defaultBotstationScope,
    redirectUri: config.oidc?.redirectUri || defaultBotstationRedirectUri,
    loginHint: loginHint || defaultBotstationUser
  });
  if (!hasUsableServstationOidcSession(config)) {
    await login();
    return;
  }
  try {
    await window.supbot.refreshServstationOidc();
  } catch {
    await login();
  }
}

function ServerAgentWorkspace({
  snapshot,
  refreshRuntime,
  t
}: {
  snapshot: RuntimeSnapshot;
  refreshRuntime: () => Promise<void>;
  t: Translator;
}) {
  const [remote, setRemote] = useState<ServstationClientSnapshot | null>(null);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [autopilotPrompt, setAutopilotPrompt] = useState("");
  const [flowPendingCount, setFlowPendingCount] = useState(0);
  const [messageApi, contextHolder] = message.useMessage();
  const reverseStatus = snapshot.servstationA2A.config.reverse?.status || "disconnected";
  const connected = reverseStatus === "connected";
  const activeConversation = remote?.conversations.find((item) => item.id === activeConversationId) || remote?.conversations[0];
  const messages = useMemo(() => servstationMessagesFromJobs(remote?.jobs || []), [remote?.jobs]);
  const runningJob = useMemo(() => [...(remote?.jobs || [])].reverse().find((job) => !servstationJobIsTerminal(job)), [remote?.jobs]);

  const loadRemote = useCallback(async (conversationId?: string) => {
    setLoading(true);
    try {
      const next = await window.supbot.getServstationClientSnapshot({ conversationId });
      setRemote(next);
      const selected = next.activeConversationId || next.conversations[0]?.id || "";
      setActiveConversationId(selected);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [messageApi]);

  useEffect(() => {
    void loadRemote(activeConversationId || undefined);
  }, [loadRemote, reverseStatus]);

  useEffect(() => {
    if (!remote?.connected) {
      return;
    }
    const intervalMs = (remote.jobs || []).some((job) => !servstationJobIsTerminal(job)) ? 2_000 : 15_000;
    const timer = window.setInterval(() => {
      void loadRemote(activeConversationId || undefined);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [activeConversationId, loadRemote, remote?.connected, remote?.jobs]);

  const connectRemote = async () => {
    setConnecting(true);
    try {
      await ensureServstationOidcSession(snapshot.servstationA2A.config, snapshot.identityContext, snapshot.servstationA2A.config.staffAgentAccount);
      await window.supbot.connectServstationReverseBridge();
      await refreshRuntime();
      await loadRemote(activeConversationId || undefined);
      messageApi.success(t("Connected to remote staff-agent."));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setConnecting(false);
    }
  };

  const selectConversation = async (conversation: ServstationConversation) => {
    setActiveConversationId(conversation.id);
    await loadRemote(conversation.id);
  };

  const createConversation = async () => {
    setBusyId("conversation:create");
    try {
      const conversation = await window.supbot.createServstationConversation();
      await loadRemote(conversation.id);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setBusyId("");
    }
  };

  const deleteConversation = async (conversation: ServstationConversation) => {
    setBusyId(`conversation:${conversation.id}`);
    try {
      await window.supbot.deleteServstationConversation(conversation.id);
      await loadRemote("");
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setBusyId("");
    }
  };

  const sendRemotePrompt = async () => {
    const text = prompt.trim();
    if (!text || sending || !connected) {
      return;
    }
    setSending(true);
    setPrompt("");
    setAttachments([]);
    try {
      const result = await window.supbot.sendServstationPrompt({
        conversationId: activeConversation?.id,
        prompt: text,
        attachments
      });
      setRemote(result.snapshot);
      setActiveConversationId(result.conversation.id);
    } catch (error) {
      setPrompt(text);
      messageApi.error((error as Error).message);
    } finally {
      setSending(false);
    }
  };

  const cancelRemoteJob = async (job: ServstationSessionJob) => {
    setBusyId(`job:${job.id}`);
    try {
      await window.supbot.cancelServstationJob(job.id);
      await loadRemote(activeConversation?.id);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setBusyId("");
    }
  };

  const cancelRunningJob = async () => {
    if (runningJob) {
      await cancelRemoteJob(runningJob);
    }
  };

  const pickRemoteAttachments = async () => {
    const picked = await window.supbot.pickAttachments();
    setAttachments((items) => [...items, ...picked]);
  };

  const saveSchedule = async (input: { title?: string; prompt: string; scheduleKind: string; runAt?: string; cronExpr?: string }) => {
    await window.supbot.createServstationScheduledJob({
      ...input,
      conversationId: activeConversation?.id,
      enabled: true
    });
    setScheduleOpen(false);
    await loadRemote(activeConversation?.id);
  };

  const toggleSchedule = async (job: ServstationScheduledJob) => {
    setBusyId(`schedule:${job.id}`);
    try {
      await window.supbot.updateServstationScheduledJob(job.id, { enabled: !job.enabled });
      await loadRemote(activeConversation?.id);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setBusyId("");
    }
  };

  const deleteSchedule = async (job: ServstationScheduledJob) => {
    setBusyId(`schedule:${job.id}`);
    try {
      await window.supbot.deleteServstationScheduledJob(job.id);
      await loadRemote(activeConversation?.id);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setBusyId("");
    }
  };

  const startAutopilot = async () => {
    const text = autopilotPrompt.trim();
    if (!text || !connected) {
      return;
    }
    setBusyId("autopilot:start");
    try {
      await window.supbot.startServstationAutopilotRun({
        conversationId: activeConversation?.id,
        goal: text,
        prompt: text
      });
      setAutopilotPrompt("");
      await loadRemote(activeConversation?.id);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setBusyId("");
    }
  };

  const updateAutopilot = async (status: "paused" | "watching" | "stopped") => {
    if (!remote?.autopilotRun) {
      return;
    }
    setBusyId(`autopilot:${status}`);
    try {
      await window.supbot.updateServstationAutopilotRun({ runId: remote.autopilotRun.id, status });
      await loadRemote(activeConversation?.id);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setBusyId("");
    }
  };

  const disabled = !connected || loading;

  return (
    <section className="server-agent-workspace">
      {contextHolder}
      <div className="server-agent-header">
        <div>
          <div className="tag-row">
            <Tag color={connected ? "green" : reverseStatus === "error" ? "red" : "default"}>{t(`reverse:${reverseStatus}`)}</Tag>
            <Tag>{remote?.baseUrl || snapshot.servstationA2A.config.baseUrl || snapshot.identityContext?.servstationUrl || t("No Servstation URL")}</Tag>
            {remote?.identity?.userId ? <Tag>{remote.identity.userId}</Tag> : null}
          </div>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadRemote(activeConversation?.id)}>{t("Refresh")}</Button>
          {connected ? null : <Button type="primary" icon={<ApiOutlined />} loading={connecting} onClick={() => void connectRemote()}>{t("Connect server Agent")}</Button>}
        </Space>
      </div>
      {!connected ? (
        <Alert
          type={reverseStatus === "error" ? "error" : "warning"}
          showIcon
          message={snapshot.servstationA2A.config.reverse?.lastError || t("Servstation reverse A2A is not connected.")}
        />
      ) : null}
      <Tabs
        className="server-agent-tabs"
        items={[
          {
            key: "messages",
            label: <span><MessageOutlined /> {t("Conversations")}</span>,
            children: (
              <ServerAgentMessages
                activeConversation={activeConversation}
                conversations={remote?.conversations || []}
                messages={messages}
                prompt={prompt}
                attachments={attachments}
                disabled={disabled}
                sending={sending}
                runningJob={runningJob}
                busyId={busyId}
                setPrompt={setPrompt}
                setAttachments={setAttachments}
                onSelectConversation={selectConversation}
                onCreateConversation={createConversation}
                onDeleteConversation={deleteConversation}
                onPickAttachments={pickRemoteAttachments}
                onSend={sendRemotePrompt}
                onCancelRunning={cancelRunningJob}
                t={t}
              />
            )
          },
          {
            key: "flow",
            label: (
              <Badge count={flowPendingCount} size="small" offset={[8, -4]}>
                <span><OrderedListOutlined /> {t("Flows")}</span>
              </Badge>
            ),
            children: (
              <ServerAgentFlowWorkspace
                connected={connected}
                disabled={disabled}
                identity={remote?.identity || snapshot.identityContext}
                onPendingCountChange={setFlowPendingCount}
                t={t}
              />
            )
          },
          {
            key: "schedule",
            label: <span><CalendarOutlined /> {t("Schedule")}</span>,
            children: (
              <ServerAgentFlows
                scheduledJobs={remote?.scheduledJobs || []}
                autopilotRun={remote?.autopilotRun || null}
                autopilotEvents={remote?.autopilotEvents || []}
                autopilotPrompt={autopilotPrompt}
                disabled={disabled}
                busyId={busyId}
                setAutopilotPrompt={setAutopilotPrompt}
                onCreateSchedule={() => setScheduleOpen(true)}
                onToggleSchedule={toggleSchedule}
                onDeleteSchedule={deleteSchedule}
                onStartAutopilot={startAutopilot}
                onUpdateAutopilot={updateAutopilot}
                t={t}
              />
            )
          },
          {
            key: "mail",
            label: <span><MailOutlined /> {t("Messages/Mail")}</span>,
            children: (
              <ServerAgentMailWorkspace
                connected={connected}
                disabled={disabled}
                identity={remote?.identity || snapshot.identityContext}
                t={t}
              />
            )
          }
        ]}
      />
      <RemoteScheduleModal
        open={scheduleOpen}
        disabled={disabled}
        onCancel={() => setScheduleOpen(false)}
        onSave={saveSchedule}
        t={t}
      />
    </section>
  );
}

function ServerAgentMessages({
  activeConversation,
  conversations,
  messages,
  prompt,
  attachments,
  disabled,
  sending,
  runningJob,
  busyId,
  setPrompt,
  setAttachments,
  onSelectConversation,
  onCreateConversation,
  onDeleteConversation,
  onPickAttachments,
  onSend,
  onCancelRunning,
  t
}: {
  activeConversation?: ServstationConversation;
  conversations: ServstationConversation[];
  messages: ServstationChatMessage[];
  prompt: string;
  attachments: Attachment[];
  disabled: boolean;
  sending: boolean;
  runningJob?: ServstationSessionJob;
  busyId: string;
  setPrompt: (value: string) => void;
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  onSelectConversation: (conversation: ServstationConversation) => Promise<void>;
  onCreateConversation: () => Promise<void>;
  onDeleteConversation: (conversation: ServstationConversation) => Promise<void>;
  onPickAttachments: () => Promise<void>;
  onSend: () => Promise<void>;
  onCancelRunning: () => Promise<void>;
  t: Translator;
}) {
  return (
    <div className="server-agent-message-grid">
      <aside className="server-agent-conversations">
        <div className="panel-heading">
          <div className="section-title"><ClockCircleOutlined /> {t("Conversation history")}</div>
          <Tooltip title={t("New conversation")}>
            <Button size="small" type="primary" icon={<PlusOutlined />} disabled={disabled} loading={busyId === "conversation:create"} onClick={() => void onCreateConversation()} />
          </Tooltip>
        </div>
        <div className="server-agent-conversation-list">
          {conversations.map((conversation) => (
            <div className={`server-agent-conversation ${conversation.id === activeConversation?.id ? "is-active" : ""}`} key={conversation.id}>
              <button type="button" onClick={() => void onSelectConversation(conversation)}>
                <strong>{servstationConversationTitle(conversation, t("New conversation"))}</strong>
                <span>{conversation.jobCount} {t(conversation.jobCount === 1 ? "Task" : "Tasks")}</span>
                <small>{formatDateTime(conversation.lastMessageAt || conversation.updatedAt)}</small>
              </button>
              <Popconfirm title={t("Delete conversation?")} onConfirm={() => void onDeleteConversation(conversation)}>
                <Button size="small" danger icon={<DeleteOutlined />} loading={busyId === `conversation:${conversation.id}`} />
              </Popconfirm>
            </div>
          ))}
          {!conversations.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No conversations yet")} /> : null}
        </div>
      </aside>
      <section className="server-agent-chat">
        <div className="server-agent-chat-title">
          <div>
            <div className="chat-banner-label">{t("Messages")}</div>
            <strong>{activeConversation ? servstationConversationTitle(activeConversation, t("New conversation")) : t("No conversation yet")}</strong>
          </div>
          {runningJob ? <Button danger size="small" icon={<StopOutlined />} loading={busyId === `job:${runningJob.id}`} onClick={() => void onCancelRunning()}>{t("Stop")}</Button> : null}
        </div>
        <div className="server-agent-message-stream">
          {messages.map((item) => (
            <div className={`message-row ${item.role === "agent" ? "assistant" : item.role}`} key={item.id}>
              <div className="message-bubble">
                <div className="message-meta">
                  <span>{item.role === "user" ? t("You") : t("Agent")}</span>
                  {item.status ? <Tag color={servstationStatusColor(item.status)}>{t(item.status)}</Tag> : null}
                </div>
                <div className="message-text">{item.text || t("Waiting for model response...")}</div>
                {item.attachments?.length ? (
                  <div className="message-attachments">
                    {item.attachments.map((attachment) => (
                      <div className="message-attachment-chip" key={`${item.id}-${attachment.name}`}>
                        <PaperClipOutlined />
                        <span className="message-attachment-name">{attachment.name}</span>
                        <span className="message-attachment-size">{attachment.size} bytes</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          {!messages.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No messages yet")} /> : null}
        </div>
        {attachments.length ? (
          <div className="attachment-strip">
            {attachments.map((attachment) => (
              <Tag closable key={attachment.id} onClose={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))}>
                {attachment.name}
              </Tag>
            ))}
          </div>
        ) : null}
        <div className="server-agent-composer">
          <Tooltip title={t("Attach files")}>
            <Button icon={<PaperClipOutlined />} disabled={disabled || sending} onClick={() => void onPickAttachments()} />
          </Tooltip>
          <Input.TextArea
            value={prompt}
            disabled={disabled || sending}
            autoSize={{ minRows: 2, maxRows: 6 }}
            placeholder={t("Message remote staff-agent...")}
            onChange={(event) => setPrompt(event.target.value)}
            onPressEnter={(event) => {
              if (!event.shiftKey) {
                event.preventDefault();
                void onSend();
              }
            }}
          />
          <Button type="primary" icon={<SendOutlined />} loading={sending} disabled={disabled || !prompt.trim()} onClick={() => void onSend()}>{t("Send")}</Button>
        </div>
      </section>
    </div>
  );
}

function ServerAgentFlows({
  scheduledJobs,
  autopilotRun,
  autopilotEvents,
  autopilotPrompt,
  disabled,
  busyId,
  setAutopilotPrompt,
  onCreateSchedule,
  onToggleSchedule,
  onDeleteSchedule,
  onStartAutopilot,
  onUpdateAutopilot,
  t
}: {
  scheduledJobs: ServstationScheduledJob[];
  autopilotRun: ServstationAutopilotRun | null;
  autopilotEvents: NonNullable<ServstationClientSnapshot["autopilotEvents"]>;
  autopilotPrompt: string;
  disabled: boolean;
  busyId: string;
  setAutopilotPrompt: (value: string) => void;
  onCreateSchedule: () => void;
  onToggleSchedule: (job: ServstationScheduledJob) => Promise<void>;
  onDeleteSchedule: (job: ServstationScheduledJob) => Promise<void>;
  onStartAutopilot: () => Promise<void>;
  onUpdateAutopilot: (status: "paused" | "watching" | "stopped") => Promise<void>;
  t: Translator;
}) {
  return (
    <div className="server-agent-flow-grid">
      <section className="server-agent-flow-column">
        <div className="panel-heading">
          <div className="section-title"><CalendarOutlined /> {t("Schedule")}</div>
          <Button size="small" type="primary" icon={<PlusOutlined />} disabled={disabled} onClick={onCreateSchedule}>{t("New scheduled prompt")}</Button>
        </div>
        <div className="server-agent-schedule-list">
          {scheduledJobs.map((job) => (
            <div className="server-agent-job" key={job.id}>
              <div className="activity-head">
                <div>
                  <strong>{job.title || job.prompt.slice(0, 60)}</strong>
                  <div className="muted">{servstationScheduleLabel(job, t)}</div>
                </div>
                <Tag color={job.enabled ? "green" : "default"}>{job.enabled ? t("Enabled") : t("Off")}</Tag>
              </div>
              {job.lastError ? <small className="danger-text">{job.lastError}</small> : null}
              <Space wrap size="small">
                <Button size="small" loading={busyId === `schedule:${job.id}`} onClick={() => void onToggleSchedule(job)}>{job.enabled ? t("Disable") : t("Enable")}</Button>
                <Popconfirm title={t("Delete scheduled prompt?")} onConfirm={() => void onDeleteSchedule(job)}>
                  <Button size="small" danger icon={<DeleteOutlined />} loading={busyId === `schedule:${job.id}`}>{t("Delete")}</Button>
                </Popconfirm>
              </Space>
            </div>
          ))}
          {!scheduledJobs.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No scheduled prompts")} /> : null}
        </div>
      </section>
      <section className="server-agent-flow-column">
        <div className="panel-heading">
          <div className="section-title"><RobotOutlined /> {t("Autopilot")}</div>
          {autopilotRun ? <Tag color={servstationStatusColor(autopilotRun.status)}>{t(autopilotRun.status)}</Tag> : null}
        </div>
        <div className="server-agent-autopilot">
          <Input.TextArea
            value={autopilotPrompt}
            disabled={disabled || Boolean(autopilotRun && !["completed", "failed", "stopped", "needs_user"].includes(autopilotRun.status))}
            autoSize={{ minRows: 3, maxRows: 6 }}
            placeholder={t("Autopilot goal")}
            onChange={(event) => setAutopilotPrompt(event.target.value)}
          />
          <Space wrap>
            <Button type="primary" icon={<ThunderboltOutlined />} disabled={disabled || !autopilotPrompt.trim()} loading={busyId === "autopilot:start"} onClick={() => void onStartAutopilot()}>{t("Start run")}</Button>
            <Button disabled={!autopilotRun || disabled} loading={busyId === "autopilot:paused"} onClick={() => void onUpdateAutopilot("paused")}>{t("Pause")}</Button>
            <Button disabled={!autopilotRun || disabled} loading={busyId === "autopilot:watching"} onClick={() => void onUpdateAutopilot("watching")}>{t("Resume")}</Button>
            <Button danger disabled={!autopilotRun || disabled} loading={busyId === "autopilot:stopped"} onClick={() => void onUpdateAutopilot("stopped")}>{t("Stop")}</Button>
          </Space>
          {autopilotRun ? (
            <div className="server-agent-job">
              <strong>{autopilotRun.goal || t("Autopilot")}</strong>
              <div className="muted">{autopilotRun.currentJobId || autopilotRun.failureMessage || formatDateTime(autopilotRun.updatedAt)}</div>
            </div>
          ) : null}
          <div className="server-agent-event-list">
            {autopilotEvents.slice(0, 8).map((event) => (
              <div className="runtime-event" key={event.id}>
                <span>{formatDateTime(event.createdAt)}</span>
                <small>{event.message || event.eventType}</small>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

type FlowJsonSchema = Record<string, unknown>;
type FlowLaunchFormValues = Record<string, unknown>;
type FlowFilePayload = { fileName: string; contentType: string; contentBase64: string };

type FlowInputField = {
  name: string;
  label: string;
  description?: string;
  required: boolean;
  schema: FlowJsonSchema;
  kind: "string" | "number" | "integer" | "boolean" | "file";
  enumValues?: Array<string | number | boolean | null>;
};

function ServerAgentFlowWorkspace({
  connected,
  disabled,
  identity,
  onPendingCountChange,
  t
}: {
  connected: boolean;
  disabled: boolean;
  identity?: IdentityContext;
  onPendingCountChange: (count: number) => void;
  t: Translator;
}) {
  const [snapshot, setSnapshot] = useState<ServstationFlowEngineSnapshot | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [selectedExecution, setSelectedExecution] = useState<ServstationFlowEngineInitiatedExecution | null>(null);
  const [events, setEvents] = useState<ServstationFlowEngineExecutionEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [launchJson, setLaunchJson] = useState("{}");
  const [launchJsonError, setLaunchJsonError] = useState("");
  const [approvalComment, setApprovalComment] = useState("");
  const [messageApi, contextHolder] = message.useMessage();
  const [launchForm] = Form.useForm<FlowLaunchFormValues>();

  const launchable = snapshot?.launchableWorkflows || [];
  const tasks = snapshot?.pendingTasks || [];
  const executions = snapshot?.executions || [];
  const selectedWorkflow = useMemo(
    () => launchable.find((workflow) => workflow.id === selectedWorkflowId) || null,
    [launchable, selectedWorkflowId]
  );
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) || tasks[0] || null,
    [tasks, selectedTaskId]
  );
  const selectedExecutionSummary = useMemo(
    () => executions.find((execution) => execution.id === selectedExecutionId) || executions[0] || null,
    [executions, selectedExecutionId]
  );

  const refresh = useCallback(async (notify = false) => {
    if (!connected) {
      setSnapshot(null);
      setSelectedWorkflowId("");
      setSelectedTaskId(null);
      setSelectedExecutionId(null);
      setSelectedExecution(null);
      setEvents([]);
      onPendingCountChange(0);
      return;
    }
    setLoading(true);
    try {
      const next = await window.supbot.getServstationFlowEngineSnapshot();
      setSnapshot(next);
      onPendingCountChange(next.pendingTasks.length);
      setSelectedWorkflowId((current) => current && next.launchableWorkflows.some((item) => item.id === current) ? current : next.launchableWorkflows[0]?.id || "");
      setSelectedTaskId((current) => current && next.pendingTasks.some((item) => item.id === current) ? current : next.pendingTasks[0]?.id || null);
      setSelectedExecutionId((current) => current && next.executions.some((item) => item.id === current) ? current : next.executions[0]?.id || null);
      if (notify) {
        messageApi.success(t("Flow refreshed."));
      }
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [connected, messageApi, onPendingCountChange, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const executionId = selectedExecutionSummary?.id;
    if (!connected || !executionId) {
      setSelectedExecution(null);
      setEvents([]);
      return;
    }
    setDetailLoading(true);
    Promise.all([
      window.supbot.getServstationFlowEngineExecution(executionId),
      window.supbot.getServstationFlowEngineExecutionEvents(executionId)
    ])
      .then(([execution, nextEvents]) => {
        setSelectedExecution(execution);
        setEvents(nextEvents);
      })
      .catch((error: Error) => messageApi.error(error.message))
      .finally(() => setDetailLoading(false));
  }, [connected, messageApi, selectedExecutionSummary?.id]);

  const openSelectedLaunchForm = () => {
    if (!selectedWorkflow || disabled || actionLoading) {
      return;
    }
    const defaultInput = buildDefaultFlowInput(selectedWorkflow.inputSchema);
    if (!shouldUseJsonFlowInput(selectedWorkflow.inputSchema)) {
      launchForm.setFieldsValue(defaultInput);
    }
    setLaunchJson(JSON.stringify(defaultInput, null, 2));
    setLaunchJsonError("");
    setLaunchOpen(true);
  };

  const launchSelectedFlow = async () => {
    if (!selectedWorkflow || disabled || actionLoading) {
      return;
    }
    try {
      const input = shouldUseJsonFlowInput(selectedWorkflow.inputSchema)
        ? parseFlowInputJson(launchJson, t("Flow launch input JSON is invalid."))
        : await launchForm.validateFields().then((values) => coerceFlowInputValues(values, selectedWorkflow.inputSchema));
      setActionLoading(true);
      const execution = await window.supbot.launchServstationFlowEngineWorkflow({
        workflowId: selectedWorkflow.id,
        input
      });
      messageApi.success(t("Flow launched."));
      setLaunchOpen(false);
      launchForm.resetFields();
      setLaunchJson("{}");
      setLaunchJsonError("");
      setSelectedExecutionId(execution.id);
      await refresh();
    } catch (error) {
      const messageText = (error as Error).message;
      if (messageText === t("Flow launch input JSON is invalid.")) {
        setLaunchJsonError(messageText);
      } else if (messageText) {
        messageApi.error(messageText);
      }
    } finally {
      setActionLoading(false);
    }
  };

  const decideSelectedTask = async (decision: "approved" | "rejected") => {
    if (!selectedTask || disabled || actionLoading) {
      return;
    }
    setActionLoading(true);
    try {
      await window.supbot.decideServstationFlowEngineApproval({
        approvalId: selectedTask.id,
        decision,
        comment: approvalComment
      });
      messageApi.success(decision === "approved" ? t("Flow approved.") : t("Flow rejected."));
      setApprovalComment("");
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <section className="server-agent-engine-workspace">
      {contextHolder}
      <div className="server-agent-mail-toolbar">
        <div>
          <Typography.Title level={3}>{t("Flows")}</Typography.Title>
          <div className="muted">{identity ? `${identity.userId} / ${identity.organizationId}/${identity.departmentId}` : t("Servstation identity is missing.")}</div>
        </div>
        <Space wrap>
          <Tag color="gold">{t("Pending approvals")}: {tasks.length}</Tag>
        </Space>
      </div>

      {!connected ? (
        <Alert type="warning" showIcon message={t("Servstation reverse A2A is not connected.")} />
      ) : null}

      <div className="server-agent-engine-grid">
        <aside className="server-agent-engine-list-panel">
          <section className="server-agent-engine-panel-section">
            <div className="server-agent-engine-section-head">
              <strong>{t("Launch flow")}</strong>
            </div>
            {launchable.length ? (
              <>
                <Select
                  value={selectedWorkflowId || undefined}
                  disabled={disabled || loading}
                  onChange={(value) => {
                    setSelectedWorkflowId(value);
                    setLaunchJsonError("");
                  }}
                  options={launchable.map((workflow) => ({ label: workflow.name, value: workflow.id }))}
                  placeholder={t("Select workflow")}
                />
                <div className="muted">{selectedWorkflow?.description || t("Select a workflow to launch.")}</div>
                <Button type="primary" icon={<PlayCircleOutlined />} disabled={disabled || !selectedWorkflowId} onClick={openSelectedLaunchForm}>
                  {t("Launch")}
                </Button>
              </>
            ) : (
              <div className="server-agent-mail-empty">{connected ? t("No launchable workflows") : t("Servstation reverse A2A is not connected.")}</div>
            )}
          </section>

          <section className="server-agent-engine-panel-section">
            <div className="server-agent-engine-section-head">
              <strong>{t("Pending approvals")}</strong>
              {tasks.length ? <Tag color="gold">{tasks.length}</Tag> : null}
            </div>
            <div className="server-agent-engine-list">
              {tasks.length ? tasks.map((task) => (
                <button
                  className={`server-agent-mail-list-item${selectedTask?.id === task.id ? " is-selected" : ""}`}
                  key={task.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => setSelectedTaskId(task.id)}
                >
                  <span className="server-agent-mail-list-line">
                    <strong>{task.title}</strong>
                    {flowEngineStatusTag(task.status, t)}
                  </span>
                  <span className="server-agent-mail-preview mono">{task.workflowId}</span>
                  <span className="server-agent-mail-preview">{task.instructions || task.approverRoles.join(", ")}</span>
                </button>
              )) : <div className="server-agent-mail-empty">{t("No pending approvals")}</div>}
            </div>
          </section>

          <section className="server-agent-engine-panel-section">
            <div className="server-agent-engine-section-head">
              <strong>{t("My flow executions")}</strong>
            </div>
            <div className="server-agent-engine-list">
              {executions.length ? executions.map((execution) => (
                <button
                  className={`server-agent-mail-list-item${selectedExecutionSummary?.id === execution.id ? " is-selected" : ""}`}
                  key={execution.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => setSelectedExecutionId(execution.id)}
                >
                  <span className="server-agent-mail-list-line">
                    <strong>{execution.workflowName || execution.workflowId}</strong>
                    {flowEngineStatusTag(execution.status, t)}
                  </span>
                  <span className="server-agent-mail-preview mono">{execution.id}</span>
                  <span className="server-agent-mail-preview">{formatMessageTime(execution.createdAt)}</span>
                </button>
              )) : <div className="server-agent-mail-empty">{t("No flow executions")}</div>}
            </div>
          </section>
        </aside>

        <section className="server-agent-engine-detail-panel">
          <article className="server-agent-engine-card">
            <div className="server-agent-mail-detail-head">
              <div>
                <Typography.Title level={4}>{t("Pending approvals")}</Typography.Title>
                <div className="muted">{selectedTask ? selectedTask.workflowId : t("No pending approvals")}</div>
              </div>
              {selectedTask?.openUrl ? (
                <Button icon={<ApiOutlined />} disabled={disabled} onClick={() => window.open(selectedTask.openUrl, "_blank", "noopener,noreferrer")}>
                  {t("Open task")}
                </Button>
              ) : null}
            </div>
            {selectedTask ? (
              <>
                <div className="server-agent-engine-body">{selectedTask.instructions || selectedTask.approverRoles.join(", ")}</div>
                <div className="server-agent-engine-input-section">
                  <strong>{t("Approval input")}</strong>
                  <FlowExecutionInputView input={selectedTask.executionInput} t={t} />
                </div>
                <Input.TextArea
                  value={approvalComment}
                  disabled={disabled || actionLoading}
                  onChange={(event) => setApprovalComment(event.target.value)}
                  autoSize={{ minRows: 3, maxRows: 6 }}
                  placeholder={t("Approval comment")}
                />
                <Space wrap>
                  <Button type="primary" icon={<CheckCircleOutlined />} loading={actionLoading} disabled={disabled} onClick={() => void decideSelectedTask("approved")}>
                    {t("Approve")}
                  </Button>
                  <Button danger icon={<CloseCircleOutlined />} loading={actionLoading} disabled={disabled} onClick={() => void decideSelectedTask("rejected")}>
                    {t("Reject")}
                  </Button>
                </Space>
              </>
            ) : (
              <div className="server-agent-mail-empty">{t("No pending approvals")}</div>
            )}
          </article>

          <article className="server-agent-engine-card">
            <div className="server-agent-mail-detail-head">
              <div>
                <Typography.Title level={4}>{t("My flow executions")}</Typography.Title>
                <div className="muted">{identity?.userId || "-"}</div>
              </div>
              {detailLoading ? <Spin size="small" /> : null}
            </div>
            <div className="server-agent-engine-body">
              {selectedExecution ? (
                <>
                  <div className="server-agent-engine-execution-title">
                    <strong>{selectedExecution.workflowName || selectedExecution.workflowId}</strong>
                    {flowEngineStatusTag(selectedExecution.status, t)}
                  </div>
                  <Descriptions size="small" column={1}>
                    <Descriptions.Item label={t("Created at")}>{formatMessageTime(selectedExecution.createdAt)}</Descriptions.Item>
                    <Descriptions.Item label={t("Started at")}>{formatMessageTime(selectedExecution.startedAt)}</Descriptions.Item>
                    <Descriptions.Item label={t("Finished at")}>{formatMessageTime(selectedExecution.finishedAt)}</Descriptions.Item>
                  </Descriptions>
                  <pre className="server-agent-engine-json">{JSON.stringify(selectedExecution.output ?? selectedExecution.error ?? selectedExecution.input, null, 2)}</pre>
                  <div className="server-agent-engine-timeline">
                    {events.map((event) => (
                      <div key={event.id} className="server-agent-engine-timeline-event">
                        <span>{formatMessageTime(event.createdAt)}</span>
                        <Tag>{event.type}</Tag>
                      </div>
                    ))}
                  </div>
                </>
              ) : t("No flow executions")}
            </div>
          </article>
        </section>
      </div>

      <Modal
        open={launchOpen}
        title={`${t("Launch flow")}${selectedWorkflow ? `: ${selectedWorkflow.name}` : ""}`}
        onCancel={() => {
          setLaunchOpen(false);
          setLaunchJsonError("");
        }}
        onOk={() => void launchSelectedFlow()}
        okText={t("Launch")}
        cancelText={t("Cancel")}
        confirmLoading={actionLoading}
        destroyOnClose
      >
        {selectedWorkflow ? (
          <FlowLaunchInputForm
            disabled={disabled || actionLoading}
            form={launchForm}
            schema={selectedWorkflow.inputSchema}
            t={t}
            jsonValue={launchJson}
            jsonError={launchJsonError}
            onJsonChange={(value) => {
              setLaunchJson(value);
              setLaunchJsonError("");
            }}
          />
        ) : null}
      </Modal>
    </section>
  );
}

function FlowLaunchInputForm({
  disabled,
  form,
  schema,
  t,
  jsonValue,
  jsonError,
  onJsonChange
}: {
  disabled: boolean;
  form: FormInstance<FlowLaunchFormValues>;
  schema?: FlowJsonSchema;
  t: Translator;
  jsonValue: string;
  jsonError: string;
  onJsonChange: (value: string) => void;
}) {
  if (shouldUseJsonFlowInput(schema)) {
    return (
      <Form form={form} component={false}>
        <Space direction="vertical" style={{ width: "100%" }} size={8}>
          <Input.TextArea
            rows={8}
            value={jsonValue}
            disabled={disabled}
            onChange={(event) => onJsonChange(event.target.value)}
            className="mono"
            placeholder="{ }"
            status={jsonError ? "error" : undefined}
          />
          {jsonError ? <Alert type="error" showIcon message={jsonError} /> : null}
        </Space>
      </Form>
    );
  }

  const fields = getFlowInputFields(schema);
  if (!fields.length) {
    return <div className="muted">{t("This workflow does not require input.")}</div>;
  }

  return (
    <Form form={form} layout="vertical" preserve={false}>
      {fields.map((field) => (
        <Form.Item
          key={field.name}
          label={field.label}
          name={field.name}
          extra={field.description}
          rules={field.required ? [{ required: true, message: `${field.label} ${t("Required")}` }] : undefined}
        >
          {renderFlowInputControl(field, disabled, t)}
        </Form.Item>
      ))}
    </Form>
  );
}

function renderFlowInputControl(field: FlowInputField, disabled: boolean, t: Translator) {
  if (field.enumValues?.length) {
    return <Select disabled={disabled} options={field.enumValues.map((value) => ({ label: String(value), value }))} />;
  }
  if (field.kind === "boolean") {
    return (
      <Select
        disabled={disabled}
        options={[
          { label: "true", value: true },
          { label: "false", value: false }
        ]}
      />
    );
  }
  if (field.kind === "number" || field.kind === "integer") {
    return <InputNumber style={{ width: "100%" }} precision={field.kind === "integer" ? 0 : undefined} disabled={disabled} />;
  }
  if (field.kind === "file") {
    return <FlowFileInput disabled={disabled} t={t} />;
  }
  return <Input disabled={disabled} />;
}

function FlowFileInput({
  value,
  onChange,
  disabled
}: {
  value?: string | FlowFilePayload;
  onChange?: (value: FlowFilePayload | null) => void;
  disabled?: boolean;
  t: Translator;
}) {
  const display = typeof value === "string" ? value : value?.fileName || "";
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState(false);
  return (
    <Space.Compact style={{ width: "100%" }}>
      <Input readOnly value={display} placeholder={disabled ? "" : t("No file selected")} style={{ width: "60%" }} disabled={disabled} />
      <input
        ref={inputRef}
        type="file"
        className="hidden-file-input"
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) {
            return;
          }
          setLoading(true);
          fileToFlowFilePayload(file)
            .then((attachment) => onChange?.(attachment))
            .catch((error: Error) => message.error(`File read failed: ${error.message}`))
            .finally(() => {
              setLoading(false);
              event.target.value = "";
            });
        }}
      />
      <Button icon={<PaperClipOutlined />} loading={loading} disabled={disabled} onClick={() => inputRef.current?.click()}>
        {loading ? "" : t("Select file")}
      </Button>
    </Space.Compact>
  );
}

function FlowExecutionInputView({ input, t }: { input?: Record<string, unknown>; t: Translator }) {
  const entries = input ? Object.entries(input) : [];
  if (!entries.length) {
    return <div className="muted">{t("No approval input")}</div>;
  }
  return (
    <div className="server-agent-engine-input-view">
      {entries.map(([key, value]) => (
        <div className="server-agent-engine-input-row" key={key}>
          <div className="server-agent-engine-input-label">{key}</div>
          <div className="server-agent-engine-input-value">
            {isFlowFilePayload(value) ? (
              <Space size="small" wrap>
                <PaperClipOutlined />
                <span>{value.fileName}</span>
                <span className="muted">({t("File size")} {formatBytesFromBase64(value.contentBase64)})</span>
                <Button size="small" type="link" icon={<DownloadOutlined />} onClick={() => downloadFlowFilePayload(value)}>
                  {t("Download")}
                </Button>
              </Space>
            ) : typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? (
              <span>{String(value)}</span>
            ) : (
              <pre className="server-agent-engine-input-json">{JSON.stringify(value, null, 2)}</pre>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function flowEngineStatusTag(status: string | undefined, t: Translator) {
  const normalized = String(status || "").toLowerCase();
  const color =
    normalized === "succeeded" || normalized === "approved"
      ? "green"
      : normalized === "failed" || normalized === "cancelled" || normalized === "rejected"
        ? "red"
        : normalized === "waiting_approval" || normalized === "pending"
          ? "gold"
          : "blue";
  return <Tag color={color}>{flowEngineStatusLabel(status, t)}</Tag>;
}

function flowEngineStatusLabel(status: string | undefined, t: Translator): string {
  const normalized = String(status || "").toLowerCase();
  const labels: Record<string, string> = {
    queued: "Queued",
    running: "Running",
    waiting_approval: "Waiting approval",
    waiting_timer: "Waiting timer",
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Canceled",
    canceled: "Canceled",
    pending: "Pending",
    approved: "Approved",
    rejected: "Rejected"
  };
  return t(labels[normalized] || status || "Unknown");
}

function shouldUseJsonFlowInput(schema?: FlowJsonSchema) {
  if (!schema || Object.keys(schema).length === 0) {
    return false;
  }
  const type = getJsonSchemaType(schema);
  if (type && type !== "object") {
    return true;
  }
  const properties = getSchemaProperties(schema);
  return Object.values(properties).some((fieldSchema) => !isRenderableFlowField(fieldSchema));
}

function getFlowInputFields(schema?: FlowJsonSchema): FlowInputField[] {
  const properties = getSchemaProperties(schema);
  const required = Array.isArray(schema?.required) ? schema.required.map(String) : [];
  return Object.entries(properties)
    .filter(([, fieldSchema]) => isRenderableFlowField(fieldSchema))
    .map(([name, fieldSchema]) => {
      const type = getJsonSchemaType(fieldSchema);
      const kind: FlowInputField["kind"] =
        type === "string" && fieldSchema.format === "file"
          ? "file"
          : type === "number" || type === "integer" || type === "boolean"
            ? type
            : "string";
      return {
        name,
        label: typeof fieldSchema.title === "string" && fieldSchema.title.trim() ? fieldSchema.title : name,
        description: typeof fieldSchema.description === "string" ? fieldSchema.description : undefined,
        required: required.includes(name),
        schema: fieldSchema,
        kind,
        enumValues: Array.isArray(fieldSchema.enum) ? fieldSchema.enum as FlowInputField["enumValues"] : undefined
      };
    });
}

function getSchemaProperties(schema?: FlowJsonSchema): Record<string, FlowJsonSchema> {
  if (!schema || typeof schema.properties !== "object" || schema.properties === null || Array.isArray(schema.properties)) {
    return {};
  }
  return schema.properties as Record<string, FlowJsonSchema>;
}

function isRenderableFlowField(schema: FlowJsonSchema) {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return true;
  }
  const type = getJsonSchemaType(schema) || "string";
  if (type === "string" && schema.format === "file") {
    return true;
  }
  return ["string", "number", "integer", "boolean"].includes(type);
}

function getJsonSchemaType(schema?: FlowJsonSchema) {
  const rawType = schema?.type;
  if (Array.isArray(rawType)) {
    return rawType.find((item): item is string => typeof item === "string" && item !== "null");
  }
  return typeof rawType === "string" ? rawType : undefined;
}

function buildDefaultFlowInput(schema?: FlowJsonSchema) {
  if (shouldUseJsonFlowInput(schema)) {
    return {};
  }
  return Object.fromEntries(
    getFlowInputFields(schema)
      .map((field) => [field.name, getSchemaDefaultValue(field.schema)])
      .filter(([, value]) => value !== undefined)
  );
}

function getSchemaDefaultValue(schema: FlowJsonSchema) {
  return "default" in schema ? schema.default : undefined;
}

function coerceFlowInputValues(values: FlowLaunchFormValues, schema?: FlowJsonSchema) {
  const fields = getFlowInputFields(schema);
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    result[field.name] = field.kind === "integer" || field.kind === "number" ? Number(value) : value;
  }
  return result;
}

function parseFlowInputJson(value: string, errorMessage: string) {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(errorMessage);
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(errorMessage);
  }
}

function isFlowFilePayload(value: unknown): value is FlowFilePayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FlowFilePayload).fileName === "string" &&
    typeof (value as FlowFilePayload).contentType === "string" &&
    typeof (value as FlowFilePayload).contentBase64 === "string"
  );
}

function fileToFlowFilePayload(file: File): Promise<FlowFilePayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const contentBase64 = result.includes(",") ? result.split(",")[1] : result;
      resolve({ fileName: file.name, contentType: file.type || "application/octet-stream", contentBase64 });
    };
    reader.onerror = () => reject(reader.error || new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

function downloadFlowFilePayload(payload: FlowFilePayload) {
  try {
    const cleanedBase64 = payload.contentBase64.replace(/[^A-Za-z0-9+/=]/g, "");
    const bytes = Uint8Array.from(atob(cleanedBase64), (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: payload.contentType || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = payload.fileName;
    link.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    message.error(`Download failed: ${reason}`);
  }
}

function formatBytesFromBase64(base64: string): string {
  const cleaned = base64.replace(/[^A-Za-z0-9+/=]/g, "");
  const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, Math.floor((cleaned.length * 3) / 4) - padding);
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

type ServerAgentMailTab = "messages" | "accounts";

type ServerAgentMailComposeValues = {
  recipients?: string;
  externalRecipients?: string;
  senderMailAccountId?: string;
  subject?: string;
  body?: string;
  attachments?: UploadFile[];
};

type ServerAgentMailAccountValues = {
  emailAddress?: string;
  displayName?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecurity?: ServstationMailSecurityMode;
  smtpUsername?: string;
  smtpPassword?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecurity?: ServstationMailSecurityMode;
  imapUsername?: string;
  imapPassword?: string;
  isDefault?: boolean;
  enabled?: boolean;
};

function ServerAgentMailWorkspace({
  connected,
  disabled,
  identity,
  t
}: {
  connected: boolean;
  disabled: boolean;
  identity?: IdentityContext;
  t: Translator;
}) {
  const [tab, setTab] = useState<ServerAgentMailTab>("messages");
  const [folder, setFolder] = useState<ServstationMessageFolder>("inbox");
  const [items, setItems] = useState<ServstationMessageListItem[]>([]);
  const [selected, setSelected] = useState<ServstationMessageDetail | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [accounts, setAccounts] = useState<ServstationMailAccount[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<ServstationMailAccount | null>(null);
  const [savingAccount, setSavingAccount] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const [composeForm] = Form.useForm<ServerAgentMailComposeValues>();
  const [accountForm] = Form.useForm<ServerAgentMailAccountValues>();

  const outboundOptions = useMemo(
    () => accounts
      .filter((account) => account.enabled)
      .map((account) => ({
        value: account.id,
        label: account.isDefault ? `${account.emailAddress} (${t("Default")})` : account.emailAddress
      })),
    [accounts, t]
  );

  const refreshMessages = useCallback(async (nextFolder: ServstationMessageFolder = folder) => {
    if (!connected) {
      setItems([]);
      setSelected(null);
      setUnreadCount(0);
      return;
    }
    setLoadingMessages(true);
    try {
      const [messageResp, unreadResp] = await Promise.all([
        window.supbot.listServstationMessages(nextFolder),
        window.supbot.getServstationUnreadMessages()
      ]);
      setItems(messageResp.messages || []);
      setUnreadCount(unreadResp.unreadCount || 0);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setLoadingMessages(false);
    }
  }, [connected, folder, messageApi]);

  const refreshAccounts = useCallback(async () => {
    if (!connected) {
      setAccounts([]);
      return;
    }
    setAccountsLoading(true);
    try {
      setAccounts(await window.supbot.listServstationMailAccounts());
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setAccountsLoading(false);
    }
  }, [connected, messageApi]);

  useEffect(() => {
    void refreshMessages(folder);
  }, [folder, refreshMessages]);

  useEffect(() => {
    void refreshAccounts();
  }, [refreshAccounts]);

  useEffect(() => {
    if (!connected) {
      return;
    }
    const unsubscribe = window.supbot.onServstationMessageEvent((event) => {
      if (event.type === "messages.unread") {
        setUnreadCount(event.data.unreadCount || 0);
        if (folder === "inbox") {
          void refreshMessages("inbox");
        }
      }
    });
    const timer = window.setInterval(() => {
      void window.supbot.getServstationUnreadMessages()
        .then((summary) => setUnreadCount(summary.unreadCount || 0))
        .catch(() => undefined);
    }, 30_000);
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [connected, folder, refreshMessages]);

  const openMessage = async (messageId: string) => {
    if (disabled) {
      return;
    }
    try {
      const detail = await window.supbot.markServstationMessageRead(messageId);
      setSelected(detail);
      await refreshMessages(folder);
    } catch {
      try {
        setSelected(await window.supbot.getServstationMessage(messageId));
      } catch (error) {
        messageApi.error((error as Error).message);
      }
    }
  };

  const openCompose = () => {
    const defaultAccount = accounts.find((account) => account.enabled && account.isDefault) || accounts.find((account) => account.enabled);
    composeForm.setFieldsValue({
      recipients: "",
      externalRecipients: "",
      senderMailAccountId: defaultAccount?.id,
      subject: "",
      body: "",
      attachments: []
    });
    setComposeOpen(true);
  };

  const submitCompose = async () => {
    if (!identity) {
      messageApi.error(t("Servstation identity is missing."));
      return;
    }
    try {
      const values = await composeForm.validateFields();
      const recipients = parseServstationMailRecipients(values.recipients || "", identity);
      const externalRecipients = parseExternalRecipients(values.externalRecipients || "");
      if (!recipients.length && !externalRecipients.length) {
        throw new Error(t("Enter at least one internal or external recipient."));
      }
      setSending(true);
      const files = ((values.attachments || []) as UploadFile[])
        .map((item) => item.originFileObj)
        .filter((file): file is NonNullable<UploadFile["originFileObj"]> => Boolean(file));
      const attachments = await Promise.all(files.map(fileToServstationMessageAttachment));
      if (externalRecipients.length) {
        await window.supbot.sendServstationDirectMessage({
          recipients,
          externalRecipients,
          senderMailAccountId: values.senderMailAccountId,
          subject: values.subject || "",
          body: values.body || "",
          attachments
        });
      } else {
        await window.supbot.sendServstationAgentMessage({
          recipients,
          subject: values.subject || "",
          body: values.body || "",
          attachments
        });
      }
      messageApi.success(t("Message queued."));
      setComposeOpen(false);
      composeForm.resetFields();
      await refreshMessages(folder);
    } catch (error) {
      const messageText = (error as Error).message;
      if (messageText) {
        messageApi.error(messageText);
      }
    } finally {
      setSending(false);
    }
  };

  const openAccountCreate = () => {
    setEditingAccount(null);
    accountForm.setFieldsValue({
      emailAddress: "",
      displayName: "",
      smtpHost: "",
      smtpPort: 587,
      smtpSecurity: "starttls",
      smtpUsername: "",
      smtpPassword: "",
      imapHost: "",
      imapPort: 993,
      imapSecurity: "tls",
      imapUsername: "",
      imapPassword: "",
      isDefault: accounts.length === 0,
      enabled: true
    });
    setAccountModalOpen(true);
  };

  const openAccountEdit = (account: ServstationMailAccount) => {
    setEditingAccount(account);
    accountForm.setFieldsValue({
      emailAddress: account.emailAddress,
      displayName: account.displayName,
      smtpHost: account.smtpHost,
      smtpPort: account.smtpPort,
      smtpSecurity: account.smtpSecurity,
      smtpUsername: account.smtpUsername,
      smtpPassword: "",
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      imapSecurity: account.imapSecurity,
      imapUsername: account.imapUsername,
      imapPassword: "",
      isDefault: account.isDefault,
      enabled: account.enabled
    });
    setAccountModalOpen(true);
  };

  const submitAccount = async () => {
    try {
      const values = await accountForm.validateFields();
      setSavingAccount(true);
      const draft = normalizeServstationMailAccountDraft(values);
      if (editingAccount) {
        await window.supbot.updateServstationMailAccount(editingAccount.id, draft);
      } else {
        await window.supbot.createServstationMailAccount(draft);
      }
      messageApi.success(editingAccount ? t("Mail account updated.") : t("Mail account created."));
      setAccountModalOpen(false);
      setEditingAccount(null);
      accountForm.resetFields();
      await refreshAccounts();
    } catch (error) {
      const messageText = (error as Error).message;
      if (messageText) {
        messageApi.error(messageText);
      }
    } finally {
      setSavingAccount(false);
    }
  };

  const renderMessages = () => (
    <div className="server-agent-mail-grid">
      <section className="server-agent-mail-list-panel">
        <div className="server-agent-mail-panel-head">
          <Segmented
            value={folder}
            disabled={disabled}
            onChange={(value) => setFolder(value as ServstationMessageFolder)}
            options={[
              { label: t("Inbox"), value: "inbox" },
              { label: t("Trash"), value: "trash" }
            ]}
          />
          <Button icon={<ReloadOutlined />} loading={loadingMessages} disabled={disabled} onClick={() => void refreshMessages()} />
        </div>
        <div className="server-agent-mail-list">
          {items.length ? items.map((item) => (
            <button
              key={item.messageId}
              type="button"
              className={`server-agent-mail-list-item${item.messageId === selected?.messageId ? " is-selected" : ""}${item.readAt ? "" : " is-unread"}`}
              disabled={disabled}
              onClick={() => void openMessage(item.messageId)}
            >
              <span className="server-agent-mail-list-line">
                <strong>{item.subject || t("No subject")}</strong>
                <span>{formatMessageTime(item.createdAt)}</span>
              </span>
              <span className="server-agent-mail-list-line">
                <span>{formatServstationAccountRef(item.sender)}</span>
                <Space size={4}>
                  {item.channel ? <Tag>{t(item.channel === "email" ? "Email" : "Internal")}</Tag> : null}
                  {item.attachmentCount ? <Tag>{item.attachmentCount}</Tag> : null}
                </Space>
              </span>
              <span className="server-agent-mail-preview">{item.preview}</span>
            </button>
          )) : (
            <div className="server-agent-mail-empty">{connected ? t("No messages") : t("Servstation reverse A2A is not connected.")}</div>
          )}
        </div>
      </section>
      <section className="server-agent-mail-detail-panel">
        {selected ? (
          <>
            <div className="server-agent-mail-detail-head">
              <div>
                <Typography.Title level={4}>{selected.subject || t("No subject")}</Typography.Title>
                <div className="muted">{formatMessageTime(selected.createdAt)}</div>
              </div>
              <Space wrap>
                <Tooltip title={selected.favorited ? t("Unfavorite") : t("Favorite")}>
                  <Button
                    disabled={disabled}
                    icon={selected.favorited ? <StarFilled /> : <StarOutlined />}
                    onClick={() => void window.supbot.setServstationMessageFavorite(selected.messageId, !selected.favorited)
                      .then((messageDetail) => {
                        setSelected(messageDetail);
                        return refreshMessages(folder);
                      })
                      .catch((error: Error) => messageApi.error(error.message))}
                  />
                </Tooltip>
                {folder === "trash" ? (
                  <>
                    <Button
                      disabled={disabled}
                      icon={<RollbackOutlined />}
                      onClick={() => void window.supbot.restoreServstationMessage(selected.messageId)
                        .then(() => {
                          setSelected(null);
                          return refreshMessages("trash");
                        })
                        .catch((error: Error) => messageApi.error(error.message))}
                    >
                      {t("Restore")}
                    </Button>
                    <Popconfirm
                      title={t("Delete this message forever?")}
                      onConfirm={() => void window.supbot.deleteServstationMessage(selected.messageId)
                        .then(() => {
                          setSelected(null);
                          return refreshMessages("trash");
                        })
                        .catch((error: Error) => messageApi.error(error.message))}
                    >
                      <Button disabled={disabled} danger icon={<DeleteOutlined />}>{t("Delete forever")}</Button>
                    </Popconfirm>
                  </>
                ) : (
                  <Button
                    disabled={disabled}
                    icon={<DeleteOutlined />}
                    onClick={() => void window.supbot.trashServstationMessage(selected.messageId)
                      .then(() => {
                        setSelected(null);
                        return refreshMessages("inbox");
                      })
                      .catch((error: Error) => messageApi.error(error.message))}
                  >
                    {t("Move to trash")}
                  </Button>
                )}
              </Space>
            </div>
            <Descriptions size="small" column={1}>
              <Descriptions.Item label={t("From")}>{formatServstationAccountRef(selected.sender)}</Descriptions.Item>
              <Descriptions.Item label={t("To")}>{(selected.recipients || []).map(formatServstationAccountRef).join(", ") || "-"}</Descriptions.Item>
            </Descriptions>
            <pre className="server-agent-mail-body">{selected.body}</pre>
            <div className="server-agent-mail-attachments">
              {(selected.attachments || []).map((attachment) => (
                <Button
                  key={attachment.attachmentId}
                  icon={<DownloadOutlined />}
                  disabled={disabled}
                  onClick={() => void window.supbot.fetchServstationMessageAttachment(selected.messageId, attachment.attachmentId)
                    .then(downloadServstationMessageAttachment)
                    .catch((error: Error) => messageApi.error(error.message))}
                >
                  {attachment.fileName}
                </Button>
              ))}
            </div>
          </>
        ) : (
          <div className="server-agent-mail-empty">{t("No messages")}</div>
        )}
      </section>
    </div>
  );

  const renderAccounts = () => (
    <section className="server-agent-mail-account-panel">
      <div className="server-agent-mail-panel-head">
        <Space wrap>
          <Button type="primary" icon={<PlusOutlined />} disabled={disabled} onClick={openAccountCreate}>{t("Add mail account")}</Button>
          <Button icon={<ReloadOutlined />} loading={accountsLoading} disabled={disabled} onClick={() => void refreshAccounts()}>{t("Refresh")}</Button>
        </Space>
      </div>
      {accounts.length ? (
        <div className="server-agent-mail-account-grid">
          {accounts.map((account) => (
            <article key={account.id} className="server-agent-mail-account-card">
              <div className="server-agent-mail-account-title">
                <div>
                  <strong>{account.emailAddress}</strong>
                  <span>{account.displayName || account.userId}</span>
                </div>
                <Space>
                  {account.isDefault ? <Tag color="cyan">{t("Default")}</Tag> : null}
                  <Tag color={account.enabled ? "green" : "default"}>{account.enabled ? t("Enabled") : t("Off")}</Tag>
                </Space>
              </div>
              <div className="server-agent-mail-account-meta">
                <span>SMTP {account.smtpHost}:{account.smtpPort}</span>
                <span>IMAP {account.imapHost}:{account.imapPort}</span>
                <span>{t("Last sync")}: {formatMessageTime(account.lastSyncAt)}</span>
                {account.lastSyncError ? <Alert type="warning" showIcon message={account.lastSyncError} /> : null}
              </div>
              <Space wrap>
                <Button icon={<EditOutlined />} disabled={disabled} onClick={() => openAccountEdit(account)}>{t("Edit")}</Button>
                <Button
                  icon={<CheckCircleOutlined />}
                  disabled={disabled || account.isDefault}
                  onClick={() => void window.supbot.setDefaultServstationMailAccount(account.id)
                    .then(() => {
                      messageApi.success(t("Default mail account updated."));
                      return refreshAccounts();
                    })
                    .catch((error: Error) => messageApi.error(error.message))}
                >
                  {t("Set default")}
                </Button>
                <Button
                  icon={<SyncOutlined />}
                  disabled={disabled}
                  onClick={() => void window.supbot.syncServstationMailAccountNow(account.id)
                    .then(() => messageApi.success(t("Mail sync started.")))
                    .catch((error: Error) => messageApi.error(error.message))}
                >
                  {t("Sync now")}
                </Button>
                <Button
                  disabled={disabled}
                  onClick={() => void window.supbot.testServstationMailAccountConnection(account.id)
                    .then((result) => {
                      const ok = result.imapOk && result.smtpOk;
                      messageApi[ok ? "success" : "warning"](ok ? t("Connection test passed.") : t("Connection test failed."));
                      Modal.info({
                        title: t("Test connection"),
                        content: (
                          <div className="server-agent-mail-test-result">
                            <div>SMTP: {String(result.smtpOk)}, IMAP: {String(result.imapOk)}</div>
                            {result.smtpError ? <div>SMTP: {result.smtpError}</div> : null}
                            {result.imapError ? <div>IMAP: {result.imapError}</div> : null}
                          </div>
                        )
                      });
                    })
                    .catch((error: Error) => messageApi.error(error.message))}
                >
                  {t("Test connection")}
                </Button>
                <Popconfirm
                  title={t("Delete this mail account?")}
                  onConfirm={() => void window.supbot.deleteServstationMailAccount(account.id)
                    .then(() => {
                      messageApi.success(t("Mail account deleted."));
                      return refreshAccounts();
                    })
                    .catch((error: Error) => messageApi.error(error.message))}
                >
                  <Button danger icon={<DeleteOutlined />} disabled={disabled}>{t("Delete")}</Button>
                </Popconfirm>
              </Space>
            </article>
          ))}
        </div>
      ) : (
        <div className="server-agent-mail-empty">{connected ? t("No mail accounts") : t("Servstation reverse A2A is not connected.")}</div>
      )}
    </section>
  );

  return (
    <section className="server-agent-mail-workspace">
      {contextHolder}
      <div className="server-agent-mail-toolbar">
        <div>
          <Typography.Title level={3}>{t("Messages/Mail")}</Typography.Title>
          <div className="muted">{identity ? `${identity.userId} / ${identity.organizationId}/${identity.departmentId}` : t("Servstation identity is missing.")}</div>
        </div>
        <Space wrap>
          <Tag color="cyan">{t("Unread")}: {unreadCount}</Tag>
          <Button type="primary" icon={<SendOutlined />} disabled={disabled || !identity} onClick={openCompose}>{t("Send")}</Button>
        </Space>
      </div>
      <Tabs
        activeKey={tab}
        onChange={(value) => setTab(value as ServerAgentMailTab)}
        items={[
          { key: "messages", label: <span><MailOutlined /> {t("Inbox")}</span>, children: renderMessages() },
          { key: "accounts", label: <span><SyncOutlined /> {t("Mail accounts")}</span>, children: renderAccounts() }
        ]}
      />
      <Modal
        open={composeOpen}
        title={t("Send message")}
        onCancel={() => setComposeOpen(false)}
        width={760}
        destroyOnClose
        footer={[
          <Button key="cancel" onClick={() => setComposeOpen(false)}>{t("Cancel")}</Button>,
          <Button key="submit" type="primary" icon={<SendOutlined />} loading={sending} onClick={() => void submitCompose()}>{t("Send")}</Button>
        ]}
      >
        <Form form={composeForm} layout="vertical">
          <Form.Item label={t("Internal recipients")} name="recipients">
            <Input placeholder="user-a, tenant/org/dept/user-b" disabled={disabled || sending} />
          </Form.Item>
          <Form.Item label={t("External email recipients")} name="externalRecipients">
            <Input placeholder="person@example.com, team@example.com" disabled={disabled || sending} />
          </Form.Item>
          <Form.Item label={t("Send as")} name="senderMailAccountId">
            <Select allowClear placeholder={t("No outbound mail account selected")} options={outboundOptions} disabled={disabled || sending} />
          </Form.Item>
          <Form.Item label={t("Subject")} name="subject" rules={[{ required: true, message: t("Subject") }]}>
            <Input disabled={disabled || sending} />
          </Form.Item>
          <Form.Item label={t("Body")} name="body" rules={[{ required: true, message: t("Body") }]}>
            <Input.TextArea rows={8} disabled={disabled || sending} />
          </Form.Item>
          <Form.Item label={t("Attached files")} name="attachments" valuePropName="fileList" getValueFromEvent={(event) => event?.fileList || []}>
            <Upload beforeUpload={() => false} multiple disabled={disabled || sending}>
              <Button icon={<PaperClipOutlined />} disabled={disabled || sending}>{t("Attach files")}</Button>
            </Upload>
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        open={accountModalOpen}
        title={editingAccount ? t("Edit mail account") : t("Add mail account")}
        onCancel={() => setAccountModalOpen(false)}
        width={820}
        destroyOnClose
        footer={[
          <Button key="cancel" onClick={() => setAccountModalOpen(false)}>{t("Cancel")}</Button>,
          <Button key="submit" type="primary" loading={savingAccount} onClick={() => void submitAccount()}>{t("Save")}</Button>
        ]}
      >
        <Form form={accountForm} layout="vertical" className="server-agent-mail-account-form">
          <Form.Item label={t("Email address")} name="emailAddress" rules={[{ required: true, type: "email", message: t("Email address") }]}>
            <Input autoComplete="email" disabled={disabled || savingAccount} />
          </Form.Item>
          <Form.Item label={t("Display name")} name="displayName">
            <Input disabled={disabled || savingAccount} />
          </Form.Item>
          <div className="server-agent-mail-form-grid">
            <Form.Item label={t("SMTP host")} name="smtpHost" rules={[{ required: true, message: t("SMTP host") }]}>
              <Input disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("SMTP port")} name="smtpPort" rules={[{ required: true, message: t("SMTP port") }]}>
              <InputNumber min={1} max={65535} disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("SMTP security")} name="smtpSecurity" rules={[{ required: true, message: t("SMTP security") }]}>
              <Select options={servstationMailSecurityOptions(t)} disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("SMTP username")} name="smtpUsername" rules={[{ required: true, message: t("SMTP username") }]}>
              <Input disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("SMTP password")} name="smtpPassword" rules={[{ required: !editingAccount, message: t("SMTP password") }]}>
              <Input.Password autoComplete="new-password" disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("IMAP host")} name="imapHost" rules={[{ required: true, message: t("IMAP host") }]}>
              <Input disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("IMAP port")} name="imapPort" rules={[{ required: true, message: t("IMAP port") }]}>
              <InputNumber min={1} max={65535} disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("IMAP security")} name="imapSecurity" rules={[{ required: true, message: t("IMAP security") }]}>
              <Select options={servstationMailSecurityOptions(t)} disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("IMAP username")} name="imapUsername" rules={[{ required: true, message: t("IMAP username") }]}>
              <Input disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("IMAP password")} name="imapPassword" rules={[{ required: !editingAccount, message: t("IMAP password") }]}>
              <Input.Password autoComplete="new-password" disabled={disabled || savingAccount} />
            </Form.Item>
          </div>
          <Space size={24}>
            <Form.Item label={t("Default")} name="isDefault" valuePropName="checked">
              <Switch disabled={disabled || savingAccount} />
            </Form.Item>
            <Form.Item label={t("Enabled")} name="enabled" valuePropName="checked">
              <Switch disabled={disabled || savingAccount} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </section>
  );
}

function servstationMailSecurityOptions(t: Translator) {
  return [
    { value: "starttls", label: t("STARTTLS") },
    { value: "tls", label: t("TLS") },
    { value: "none", label: t("None") }
  ];
}

function normalizeServstationMailAccountDraft(values: ServerAgentMailAccountValues): ServstationMailAccountDraft {
  const smtpPassword = values.smtpPassword?.trim();
  const imapPassword = values.imapPassword?.trim();
  return {
    emailAddress: values.emailAddress?.trim() || "",
    displayName: values.displayName?.trim() || "",
    smtpHost: values.smtpHost?.trim() || "",
    smtpPort: values.smtpPort || 587,
    smtpSecurity: values.smtpSecurity || "starttls",
    smtpUsername: values.smtpUsername?.trim() || "",
    ...(smtpPassword ? { smtpPassword } : {}),
    imapHost: values.imapHost?.trim() || "",
    imapPort: values.imapPort || 993,
    imapSecurity: values.imapSecurity || "tls",
    imapUsername: values.imapUsername?.trim() || "",
    ...(imapPassword ? { imapPassword } : {}),
    isDefault: values.isDefault === true,
    enabled: values.enabled !== false
  };
}

function parseServstationMailRecipients(raw: string, identity: IdentityContext): ServstationMessageAccountRef[] {
  return raw
    .split(/[,\n;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const parts = item.split("/").map((part) => part.trim()).filter(Boolean);
      if (parts.length === 4) {
        return { tenantId: parts[0], organizationId: parts[1], departmentId: parts[2], userId: parts[3] };
      }
      return {
        tenantId: identity.tenantId,
        organizationId: identity.organizationId,
        departmentId: identity.departmentId,
        userId: item
      };
    });
}

function parseExternalRecipients(raw: string): string[] {
  return raw
    .split(/[,\n;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function fileToServstationMessageAttachment(file: Blob & { name: string; type?: string }): Promise<ServstationMessageAttachmentUpload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve({
        fileName: file.name,
        contentType: file.type || "application/octet-stream",
        contentBase64: result.includes(",") ? result.split(",")[1] : result
      });
    };
    reader.onerror = () => reject(reader.error || new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

function downloadServstationMessageAttachment(attachment: ServstationMessageAttachmentContent): void {
  const bytes = Uint8Array.from(atob(attachment.contentBase64), (char) => char.charCodeAt(0));
  const blob = new Blob([bytes], { type: attachment.contentType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function formatServstationAccountRef(ref: ServstationMessageAccountRef): string {
  return `${ref.userId} (${ref.organizationId}/${ref.departmentId})`;
}

function formatMessageTime(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function RemoteScheduleModal({
  open,
  disabled,
  onCancel,
  onSave,
  t
}: {
  open: boolean;
  disabled: boolean;
  onCancel: () => void;
  onSave: (input: { title?: string; prompt: string; scheduleKind: string; runAt?: string; cronExpr?: string }) => Promise<void>;
  t: Translator;
}) {
  const [form] = Form.useForm<{ title?: string; prompt: string; scheduleKind: string; runAt?: string; cronExpr?: string }>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      form.setFieldsValue({ scheduleKind: "once" });
    }
  }, [form, open]);
  return (
    <Modal
      open={open}
      title={t("New scheduled prompt")}
      onCancel={onCancel}
      onOk={() => form.submit()}
      okText={t("Create")}
      confirmLoading={saving}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={async (values) => {
          setSaving(true);
          try {
            await onSave(values);
            form.resetFields();
          } finally {
            setSaving(false);
          }
        }}
      >
        <Form.Item label={t("Title")} name="title"><Input disabled={disabled} /></Form.Item>
        <Form.Item label={t("Prompt")} name="prompt" rules={[{ required: true }]}><Input.TextArea rows={4} disabled={disabled} /></Form.Item>
        <Form.Item label={t("Kind")} name="scheduleKind" rules={[{ required: true }]}>
          <Select disabled={disabled} options={[{ value: "once", label: t("Once") }, { value: "cron", label: t("Cron") }]} />
        </Form.Item>
        <Form.Item label={t("Run at ISO time")} name="runAt"><Input disabled={disabled} placeholder={new Date(Date.now() + 3600000).toISOString()} /></Form.Item>
        <Form.Item label={t("Cron expression")} name="cronExpr"><Input disabled={disabled} placeholder="0 9 * * 1-5" /></Form.Item>
      </Form>
    </Modal>
  );
}

interface ServstationChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  status?: string;
  jobId?: string;
  attachments?: Array<{ name: string; mimeType?: string; size: number }>;
  createdAt: number;
}

function servstationMessagesFromJobs(jobs: ServstationSessionJob[]): ServstationChatMessage[] {
  return [...jobs].sort(compareServstationJobs).flatMap((job) => {
    const createdAt = servstationJobCreatedAtMs(job);
    return [
      {
        id: `${job.id}-user`,
        role: "user" as const,
        text: servstationJobPrompt(job) || job.requestId || job.id,
        attachments: extractServstationMessageAttachments(job),
        createdAt
      },
      {
        id: `${job.id}-agent`,
        role: "agent" as const,
        text: servstationJobAssistantText(job) || servstationJobProgressText(job) || job.status,
        status: job.status,
        jobId: job.id,
        createdAt: servstationJobResponseAtMs(job) || createdAt
      }
    ];
  });
}

function servstationJobIsTerminal(job: Pick<ServstationSessionJob, "status">): boolean {
  return ["completed", "failed", "canceled", "cancelled"].includes(job.status);
}

function servstationConversationTitle(conversation: ServstationConversation, fallback: string): string {
  return conversation.title?.trim() || formatDateTime(conversation.createdAt) || fallback;
}

function servstationJobTitle(job: ServstationSessionJob): string {
  const prompt = servstationJobPrompt(job);
  if (prompt) {
    return prompt.length > 72 ? `${prompt.slice(0, 72)}...` : prompt;
  }
  return job.requestId || job.id;
}

function servstationJobPrompt(job: ServstationSessionJob): string {
  const payload = toRecord(job.payload);
  const prompt = stringField(payload, "prompt") || stringField(payload, "message") || stringField(payload, "input");
  return prompt?.trim() || "";
}

function servstationJobAssistantText(job: ServstationSessionJob): string {
  if (job.status === "completed") {
    const result = servstationResultText(job.result);
    if (result) {
      return result;
    }
  }
  if (job.terminalMessage?.trim()) {
    return job.terminalMessage.trim();
  }
  if (job.status === "failed" && job.terminalCode?.trim()) {
    return job.terminalCode.trim();
  }
  return "";
}

function servstationResultText(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  const record = toRecord(value);
  if (!record) {
    return String(value);
  }
  for (const key of ["assistantText", "text", "message", "output"]) {
    const text = stringField(record, key);
    if (text?.trim()) {
      return text.trim();
    }
  }
  const assistantMessages = record.assistantMessages;
  if (Array.isArray(assistantMessages)) {
    const text = assistantMessages.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).join("\n");
    if (text) {
      return text;
    }
  }
  const messages = record.messages;
  if (Array.isArray(messages)) {
    const text = messages
      .map((item) => {
        const message = toRecord(item);
        if (!message || message.role !== "assistant") {
          return "";
        }
        return stringField(message, "content") || stringField(message, "text") || "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) {
      return text;
    }
  }
  return formatJsonSnippet(record, 900);
}

function servstationJobProgressText(job: ServstationSessionJob): string {
  const progress = toRecord(job.progress);
  return stringField(progress, "message") || stringField(progress, "assistantPreview") || stringField(progress, "phase") || "";
}

function extractServstationMessageAttachments(job: ServstationSessionJob): ServstationChatMessage["attachments"] {
  const payload = toRecord(job.payload);
  const raw = payload?.attachments;
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const attachments = raw
    .map((item) => {
      const record = toRecord(item);
      const name = stringField(record, "name");
      if (!name) {
        return null;
      }
      return {
        name,
        mimeType: stringField(record, "mimeType"),
        size: numberField(record, "size") || 0
      };
    })
    .filter((item): item is { name: string; mimeType?: string; size: number } => Boolean(item));
  return attachments.length ? attachments : undefined;
}

function servstationScheduleLabel(job: ServstationScheduledJob, t: Translator): string {
  if (job.scheduleKind === "once") {
    return `${t("Once")} / ${formatDateTime(job.runAt || job.nextRunAt || job.createdAt)}`;
  }
  if (job.scheduleKind === "cron") {
    return `${t("Cron")} / ${job.cronExpr || t("No cron expression")}`;
  }
  return job.scheduleKind || t("Schedule");
}

function servstationStatusColor(status: string): string {
  if (["completed", "connected", "enabled", "watching"].includes(status)) {
    return "green";
  }
  if (["failed", "error", "needs_user"].includes(status)) {
    return "red";
  }
  if (["queued", "pending", "idle"].includes(status)) {
    return "gold";
  }
  if (["running", "processing", "driving"].includes(status)) {
    return "blue";
  }
  if (["paused", "canceled", "cancelled", "stopped"].includes(status)) {
    return "default";
  }
  return "cyan";
}

function compareServstationJobs(left: ServstationSessionJob, right: ServstationSessionJob): number {
  const byCreatedAt = servstationJobCreatedAtMs(left) - servstationJobCreatedAtMs(right);
  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }
  const byQueue = left.queuePosition - right.queuePosition;
  if (byQueue !== 0) {
    return byQueue;
  }
  return left.id.localeCompare(right.id);
}

function servstationJobCreatedAtMs(job: ServstationSessionJob): number {
  return Date.parse(job.createdAt) || 0;
}

function servstationJobResponseAtMs(job: ServstationSessionJob): number {
  return Date.parse(job.finishedAt || job.startedAt || job.createdAt) || servstationJobCreatedAtMs(job);
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function generatedFileExtension(file: { name: string; path: string }): string {
  const source = file.name || file.path;
  const filename = source.split(/[\\/]/).pop() || source;
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
}

function shouldShowGeneratedFileInChat(file: { name: string; path: string }): boolean {
  return !hiddenChatGeneratedFileExtensions.has(generatedFileExtension(file));
}

function nodeInside(container: HTMLElement, node: Node | null): boolean {
  return Boolean(node && (node === container || container.contains(node)));
}

function selectedTextWithin(container: HTMLElement): string {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !nodeInside(container, selection.anchorNode) || !nodeInside(container, selection.focusNode)) {
    return "";
  }
  return selection.toString().trim();
}

function selectionMemoryTitle(text: string): string {
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "Chat selection";
  const compact = firstLine.replace(/\s+/g, " ");
  return compact.length > 60 ? `${compact.slice(0, 57)}...` : compact;
}

function copyTextFallback(text: string): void {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("Copy failed.");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the textarea path for older or restricted Electron clipboard contexts.
    }
  }
  copyTextFallback(text);
}

async function readClipboardText(): Promise<string> {
  if (window.supbot?.readClipboardText) {
    return window.supbot.readClipboardText();
  }
  if (!navigator.clipboard?.readText) {
    throw new Error("Paste failed.");
  }
  return navigator.clipboard.readText();
}

function ChatPanel({
  conversation,
  prompt,
  setPrompt,
  attachments,
  setAttachments,
  sending,
  runningJob,
  pendingToolPermissions,
  approveToolPermission,
  denyToolPermission,
  send,
  stopRunning,
  pickAttachments,
  copyLatest,
  copySelectedText,
  addSelectedTextToMemory,
  compactConversation,
  loadTranscript,
  scrollRef,
  messageStackRef,
  onMessageScroll,
  t,
  slashCommands
}: {
  conversation?: Conversation;
  prompt: string;
  setPrompt: (value: string) => void;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  sending: boolean;
  runningJob?: AgentJob;
  pendingToolPermissions: PendingToolPermission[];
  approveToolPermission: (id: string) => Promise<void>;
  denyToolPermission: (id: string) => Promise<void>;
  send: () => void;
  stopRunning: () => void;
  pickAttachments: () => void;
  copyLatest: () => void;
  copySelectedText: (text: string) => Promise<void>;
  addSelectedTextToMemory: (text: string) => Promise<void>;
  compactConversation: () => void;
  loadTranscript: () => void;
  scrollRef: React.RefObject<HTMLDivElement>;
  messageStackRef: React.RefObject<HTMLDivElement>;
  onMessageScroll: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  slashCommands: ReturnType<typeof buildSlashCommands>;
}) {
  const selectionMenuRef = useRef<HTMLDivElement | null>(null);
  const promptMenuRef = useRef<HTMLDivElement | null>(null);
  const promptInputRef = useRef<TextAreaRef | null>(null);
  const [selectionMenu, setSelectionMenu] = useState<SelectionContextMenu | null>(null);
  const [selectionAction, setSelectionAction] = useState<"copy" | "memory" | null>(null);
  const [promptMenu, setPromptMenu] = useState<PromptContextMenu | null>(null);
  const [promptAction, setPromptAction] = useState<"copy" | "paste" | null>(null);
  const filteredCommands = useMemo(() => {
    if (!prompt.startsWith("/")) {
      return [];
    }
    const query = prompt.trim().toLowerCase();
    return slashCommands.filter((item) => item.command.startsWith(query));
  }, [prompt, slashCommands]);
  const composerPermissions = useMemo(() => {
    const conversationId = conversation?.id || "";
    return pendingToolPermissions.filter((permission) => {
      if (conversationId && permission.conversationId === conversationId) {
        return true;
      }
      if (runningJob && (permission.jobId === runningJob.id || permission.jobId.startsWith(`${runningJob.id}:`))) {
        return true;
      }
      return !conversationId;
    });
  }, [conversation?.id, pendingToolPermissions, runningJob]);

  const closeSelectionMenu = useCallback(() => setSelectionMenu(null), []);
  const closePromptMenu = useCallback(() => setPromptMenu(null), []);

  const openSelectionMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const text = selectedTextWithin(event.currentTarget);
    if (!text) {
      setSelectionMenu(null);
      return;
    }
    event.preventDefault();
    const menuWidth = 176;
    const menuHeight = 92;
    setSelectionMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      text
    });
  }, []);

  const openPromptMenu = useCallback((event: React.MouseEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    closeSelectionMenu();
    const target = event.currentTarget;
    const selectionStart = target.selectionStart ?? prompt.length;
    const selectionEnd = target.selectionEnd ?? selectionStart;
    const start = Math.min(selectionStart, selectionEnd);
    const end = Math.max(selectionStart, selectionEnd);
    const menuWidth = 176;
    const menuHeight = 92;
    setPromptMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      selectionStart: start,
      selectionEnd: end,
      selectedText: prompt.slice(start, end)
    });
  }, [closeSelectionMenu, prompt]);

  const handleMessageScroll = useCallback(() => {
    closeSelectionMenu();
    onMessageScroll();
  }, [closeSelectionMenu, onMessageScroll]);

  const runSelectionAction = useCallback(async (action: "copy" | "memory") => {
    if (!selectionMenu) {
      return;
    }
    setSelectionAction(action);
    try {
      if (action === "copy") {
        await copySelectedText(selectionMenu.text);
      } else {
        await addSelectedTextToMemory(selectionMenu.text);
      }
      closeSelectionMenu();
    } finally {
      setSelectionAction(null);
    }
  }, [addSelectedTextToMemory, closeSelectionMenu, copySelectedText, selectionMenu]);

  const runPromptAction = useCallback(async (action: "copy" | "paste") => {
    if (!promptMenu) {
      return;
    }
    setPromptAction(action);
    try {
      if (action === "copy") {
        if (promptMenu.selectedText) {
          await copySelectedText(promptMenu.selectedText);
        }
        closePromptMenu();
        return;
      }
      const clipboardText = await readClipboardText();
      const nextPrompt = `${prompt.slice(0, promptMenu.selectionStart)}${clipboardText}${prompt.slice(promptMenu.selectionEnd)}`;
      const caret = promptMenu.selectionStart + clipboardText.length;
      setPrompt(nextPrompt);
      closePromptMenu();
      window.requestAnimationFrame(() => {
        const textarea = promptInputRef.current?.resizableTextArea?.textArea;
        textarea?.focus();
        textarea?.setSelectionRange(caret, caret);
      });
      message.success(t("已粘贴剪贴板内容。"));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setPromptAction(null);
    }
  }, [closePromptMenu, copySelectedText, prompt, promptMenu, setPrompt, t]);

  useEffect(() => {
    if (!selectionMenu) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (selectionMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      closeSelectionMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeSelectionMenu();
      }
    };
    const onSelectionChange = () => {
      const stream = scrollRef.current;
      if (!stream || !selectedTextWithin(stream)) {
        closeSelectionMenu();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [closeSelectionMenu, scrollRef, selectionMenu]);

  useEffect(() => {
    if (!promptMenu) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (promptMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      closePromptMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closePromptMenu();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closePromptMenu, promptMenu]);

  useEffect(() => {
    const stream = scrollRef.current;
    if (!stream) {
      return;
    }
    const pin = () => {
      stream.scrollTop = Math.max(0, stream.scrollHeight - stream.clientHeight);
    };
    const frame = window.requestAnimationFrame(pin);
    const timer = window.setTimeout(pin, 80);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [conversation?.id, scrollRef]);

  return (
    <section className="chat-panel">
      <div className="chat-banner">
        <div>
          <div className="chat-banner-label">{t("Conversation")}</div>
          <div className="chat-banner-text">{conversation ? conversationTitle(conversation, t("New conversation")) : t("No conversation yet")}</div>
        </div>
        <Space>
          <Tooltip title={t("Compact conversation")}>
            <Button icon={<CompressOutlined />} onClick={compactConversation} disabled={!conversation?.messages.length} />
          </Tooltip>
          <Tooltip title={t("Load transcript")}>
            <Button icon={<FileTextOutlined />} onClick={loadTranscript} disabled={!conversation} />
          </Tooltip>
          <Tooltip title={t("Copy latest response")}>
            <Button icon={<CopyOutlined />} onClick={copyLatest} />
          </Tooltip>
          {runningJob ? <Tag color="cyan"><ClockCircleOutlined /> {statusLabel(runningJob.status, t)}</Tag> : <Tag color="green"><CheckCircleOutlined /> {t("Ready")}</Tag>}
        </Space>
      </div>
      <div className="message-stream" ref={scrollRef} onScroll={handleMessageScroll} onContextMenu={openSelectionMenu}>
        <div className="message-stack" ref={messageStackRef}>
          {!conversation || conversation.messages.length === 0 ? (
            <div className="chat-empty">
              <div className="brand-mark"><RobotOutlined /></div>
              <Typography.Title level={3}>{t("HBClient is ready")}</Typography.Title>
              <p className="muted">{t("Ask a question, attach local files, use /commands, or mention @research and @builder.")}</p>
            </div>
          ) : conversation.messages.map((item) => <MessageBubble key={item.id} message={item} t={t} />)}
        </div>
      </div>
      {selectionMenu ? (
        <div
          ref={selectionMenuRef}
          className="selection-context-menu"
          style={{ left: selectionMenu.x, top: selectionMenu.y }}
          role="menu"
          aria-label={t("选中文本操作")}
        >
          <button
            type="button"
            role="menuitem"
            disabled={Boolean(selectionAction)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void runSelectionAction("copy")}
          >
            <CopyOutlined />
            <span>{t("复制")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={Boolean(selectionAction)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void runSelectionAction("memory")}
          >
            <StarOutlined />
            <span>{t("加入记忆")}</span>
          </button>
        </div>
      ) : null}
      {promptMenu ? (
        <div
          ref={promptMenuRef}
          className="selection-context-menu"
          style={{ left: promptMenu.x, top: promptMenu.y }}
          role="menu"
          aria-label={t("提示词输入框操作")}
        >
          <button
            type="button"
            role="menuitem"
            disabled={!promptMenu.selectedText || Boolean(promptAction)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void runPromptAction("copy")}
          >
            <CopyOutlined />
            <span>{t("复制")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={Boolean(promptAction)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void runPromptAction("paste")}
          >
            <FileTextOutlined />
            <span>{t("粘贴")}</span>
          </button>
        </div>
      ) : null}
      <div className="composer">
        <ComposerPermissionPrompt
          permissions={composerPermissions}
          approveToolPermission={approveToolPermission}
          denyToolPermission={denyToolPermission}
          t={t}
        />
        {attachments.length ? (
          <div className="attachment-row">
            {attachments.map((attachment) => (
              <Tag
                key={attachment.id}
                closable
                onClose={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))}
              >
                <PaperClipOutlined /> {attachment.name}
              </Tag>
            ))}
          </div>
        ) : null}
        <div className="composer-body">
          <Tooltip title={t("Attach files")}>
            <Button icon={<PaperClipOutlined />} onClick={pickAttachments} />
          </Tooltip>
          <div className="composer-input-shell">
            <Input.TextArea
              ref={promptInputRef}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onContextMenu={openPromptMenu}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (runningJob) {
                    void stopRunning();
                  } else {
                    void send();
                  }
                }
              }}
              autoSize={{ minRows: 2, maxRows: 6 }}
              placeholder={t("Message HBClient, use /config, or mention @research...")}
            />
            {filteredCommands.length ? (
              <div className="slash-menu">
                {filteredCommands.map((command) => (
                  <button key={command.command} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => setPrompt(command.command)}>
                    <span className="mono">{command.command}</span>
                    <span><strong>{command.title}</strong><small>{command.description}</small></span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <Button
            type="primary"
            icon={runningJob ? <StopOutlined /> : <SendOutlined />}
            loading={sending}
            danger={Boolean(runningJob)}
            onClick={runningJob ? stopRunning : send}
          >
            {runningJob ? t("Stop") : t("Send")}
          </Button>
        </div>
      </div>
    </section>
  );
}

function ComposerPermissionPrompt({
  permissions,
  approveToolPermission,
  denyToolPermission,
  t
}: {
  permissions: PendingToolPermission[];
  approveToolPermission: (id: string) => Promise<void>;
  denyToolPermission: (id: string) => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [actingId, setActingId] = useState("");
  if (!permissions.length) {
    return null;
  }
  const run = async (id: string, action: (id: string) => Promise<void>) => {
    setActingId(id);
    try {
      await action(id);
    } finally {
      setActingId("");
    }
  };
  return (
    <div className="composer-permission-popover" role="dialog" aria-live="assertive" aria-label={t("Tool approvals")}>
      <div className="composer-permission-head">
        <div>
          <div className="eyebrow">{t("pending_permission")}</div>
          <strong>{t("Tool approvals")}</strong>
        </div>
        <Tag color="gold">{permissions.length}</Tag>
      </div>
      <div className="composer-permission-list">
        {permissions.map((permission) => (
          <div className="composer-permission-card" key={permission.id}>
            <div className="composer-permission-copy">
              <div className="composer-permission-title">
                <ToolOutlined />
                <strong>{permission.toolName}</strong>
              </div>
              <span>{permission.summary}</span>
              {permission.executionPath ? <small className="muted mono">{permission.executionPath}</small> : null}
            </div>
            <Space wrap>
              <Button
                size="small"
                type="primary"
                loading={actingId === permission.id}
                disabled={Boolean(actingId) && actingId !== permission.id}
                onClick={() => void run(permission.id, approveToolPermission)}
              >
                {t("Allow once")}
              </Button>
              <Button
                size="small"
                danger
                loading={actingId === permission.id}
                disabled={Boolean(actingId) && actingId !== permission.id}
                onClick={() => void run(permission.id, denyToolPermission)}
              >
                {t("Deny")}
              </Button>
            </Space>
          </div>
        ))}
      </div>
    </div>
  );
}

function MessageBubble({ message: item, t }: { message: ChatMessage; t: (key: string, vars?: Record<string, string | number>) => string }) {
  const visibleGeneratedFiles = item.generatedFiles?.filter(shouldShowGeneratedFileInChat) || [];
  return (
    <div className={`message-row ${item.role}`}>
      <div className="message-bubble">
        <div className="message-meta">
          <span>{item.role === "user" ? t("You") : item.role === "assistant" ? "HBClient" : item.role === "tool" ? t("Tool") : t("System")}</span>
          <span>{formatDateTime(item.createdAt)}</span>
          {item.status ? <Tag color={statusColor(item.status)}>{statusLabel(item.status, t)}</Tag> : null}
        </div>
        <MessageBlocks message={item} t={t} />
        {item.attachments?.length ? (
          <div className="attachment-row">
            {item.attachments.map((attachment) => <Tag key={attachment.id}><PaperClipOutlined /> {attachment.name}</Tag>)}
          </div>
        ) : null}
        {visibleGeneratedFiles.length ? (
          <div className="generated-files">
            {visibleGeneratedFiles.map((file) => (
              <button className="generated-file" type="button" key={file.id} onClick={() => void window.supbot.openFile(file.path)}>
                <PaperClipOutlined />
                <span>{file.name}</span>
                <small>{file.size} bytes</small>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MessageBlocks({ message, t }: { message: ChatMessage; t: (key: string, vars?: Record<string, string | number>) => string }) {
  const blocks = message.blocks?.length ? message.blocks : [{ type: "text" as const, text: message.text }];
  return (
    <>
      {blocks.map((block, index) => {
        if (block.type === "text") {
          return block.text ? <div className="message-text" key={`${message.id}-${index}`}>{block.text}</div> : null;
        }
        if (block.type === "tool_use") {
          const sourceLabel = mcpToolSourceLabel(block.toolName);
          return (
            <div className={`tool-card status-${block.status}`} key={`${message.id}-${block.toolCallId}-use`}>
              <div className="tool-card-head">
                <ToolOutlined />
                <strong>{block.toolName}</strong>
                {sourceLabel ? <span className="tool-source">{sourceLabel}</span> : null}
                <Tag>{t(block.status)}</Tag>
              </div>
              <pre>{formatToolPayload(block.input)}</pre>
            </div>
          );
        }
        if (block.type === "tool_result") {
          return (
            <div className={`tool-card result ${block.isError ? "is-error" : ""}`} key={`${message.id}-${block.toolCallId}-result`}>
              <div className="tool-card-head">
                {block.isError ? <CloseCircleOutlined /> : <CheckCircleOutlined />}
                <strong>{t("Tool result")}</strong>
                {block.outputTruncated ? <Tag color="gold">{t("truncated")}</Tag> : null}
              </div>
              {block.outputParts?.length ? (
                <div className="tool-result-parts">
                  {block.outputParts.map((part, partIndex) => (
                    <div className="tool-result-part" key={`${message.id}-${block.toolCallId}-part-${partIndex}`}>
                      <div>
                        <Tag>{part.type}</Tag>
                        {part.mimeType ? <Tag>{part.mimeType}</Tag> : null}
                      </div>
                      <span>{part.text.slice(0, 360)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              <pre>{block.output.slice(0, 2400)}</pre>
            </div>
          );
        }
        if (block.type === "thinking" || block.type === "message_delta") {
          return block.text ? <div className="message-text is-live" key={`${message.id}-${index}`}>{block.text}</div> : null;
        }
        if (block.type === "progress") {
          return <div className="progress-card" key={`${message.id}-${index}`}><ClockCircleOutlined /> {block.text}</div>;
        }
        if (block.type === "compact_summary") {
          return (
            <div className="compact-card" key={`${message.id}-${index}`}>
              <div className="tool-card-head">
                <CompressOutlined />
                <strong>{t("Compact summary")}</strong>
              </div>
              <pre>{block.summary.slice(0, 2400)}</pre>
            </div>
          );
        }
        if (block.type === "subagent_start") {
          return (
            <div className="subagent-card" key={`${message.id}-${index}`}>
              <div className="tool-card-head"><ThunderboltOutlined /><strong>@{block.agentName}</strong><Tag>{t("running")}</Tag></div>
              <pre>{block.prompt.slice(0, 1200)}</pre>
            </div>
          );
        }
        if (block.type === "subagent_done") {
          return (
            <div className={`subagent-card ${block.isError ? "is-error" : ""}`} key={`${message.id}-${index}`}>
              <div className="tool-card-head">{block.isError ? <CloseCircleOutlined /> : <CheckCircleOutlined />}<strong>@{block.agentName}</strong><Tag>{t(block.isError ? "failed" : "completed")}</Tag></div>
              <pre>{block.output.slice(0, 2400)}</pre>
            </div>
          );
        }
        return <Alert key={`${message.id}-${index}`} type="error" message={block.message} />;
      })}
    </>
  );
}

function applyMessageDelta(snapshot: RuntimeSnapshot, conversationId: string, messageId: string, delta: string): RuntimeSnapshot {
  return {
    ...snapshot,
    conversations: snapshot.conversations.map((conversation) => {
      if (conversation.id !== conversationId) {
        return conversation;
      }
      return {
        ...conversation,
        messages: conversation.messages.map((message) => {
          if (message.id !== messageId) {
            return message;
          }
          const current = message.text.endsWith("is thinking...") ? "" : message.text;
          const text = `${current}${delta}`;
          return {
            ...message,
            text,
            blocks: [{ type: "message_delta" as const, text }]
          };
        })
      };
    })
  };
}

function applyMessageEvent(snapshot: RuntimeSnapshot, conversationId: string, message: ChatMessage): RuntimeSnapshot {
  return {
    ...snapshot,
    conversations: snapshot.conversations.map((conversation) => {
      if (conversation.id !== conversationId) {
        return conversation;
      }
      const messages = conversation.messages.some((item) => item.id === message.id)
        ? conversation.messages.map((item) => item.id === message.id ? message : item)
        : [...conversation.messages, message];
      return {
        ...conversation,
        messages,
        lastMessageAt: message.createdAt,
        updatedAt: message.createdAt
      };
    })
  };
}

function applyJobEvent(snapshot: RuntimeSnapshot, job: AgentJob): RuntimeSnapshot {
  const jobs = snapshot.jobs.some((item) => item.id === job.id)
    ? snapshot.jobs.map((item) => item.id === job.id ? job : item)
    : [job, ...snapshot.jobs];
  const hasActiveJob = jobs.some((item) => item.status === "running" || item.status === "queued");
  return { ...snapshot, status: hasActiveJob ? "running" : "ready", jobs };
}

function applyToolProgress(snapshot: RuntimeSnapshot, toolCall: ToolCallRecord): RuntimeSnapshot {
  const traces = snapshot.agentLoopTraces.map((trace) => {
    if (trace.jobId !== toolCall.jobId) {
      return trace;
    }
    const toolCalls = trace.toolCalls.some((item) => item.id === toolCall.id)
      ? trace.toolCalls.map((item) => item.id === toolCall.id ? toolCall : item)
      : [...trace.toolCalls, toolCall];
    return { ...trace, toolCalls, updatedAt: toolCall.updatedAt };
  });
  const nextTraces = traces.some((trace) => trace.jobId === toolCall.jobId)
    ? traces
    : [{
      jobId: toolCall.jobId,
      conversationId: toolCall.conversationId,
      turns: 0,
      toolCalls: [toolCall],
      startedAt: toolCall.createdAt,
      updatedAt: toolCall.updatedAt
    }, ...traces];
  return {
    ...snapshot,
    agentLoopTraces: nextTraces
  };
}

function applyPendingPermission(snapshot: RuntimeSnapshot, permission: PendingToolPermission): RuntimeSnapshot {
  const pendingToolPermissions = snapshot.pendingToolPermissions.some((item) => item.id === permission.id)
    ? snapshot.pendingToolPermissions.map((item) => item.id === permission.id ? permission : item)
    : [permission, ...snapshot.pendingToolPermissions];
  return { ...snapshot, pendingToolPermissions };
}

function clearPendingPermission(snapshot: RuntimeSnapshot, permission: PendingToolPermission): RuntimeSnapshot {
  return {
    ...snapshot,
    pendingToolPermissions: snapshot.pendingToolPermissions.filter((item) => item.id !== permission.id)
  };
}

function applyCompactBoundary(snapshot: RuntimeSnapshot, boundary: CompactBoundary): RuntimeSnapshot {
  const compactBoundaries = snapshot.compactBoundaries.some((item) => item.id === boundary.id)
    ? snapshot.compactBoundaries.map((item) => item.id === boundary.id ? boundary : item)
    : [boundary, ...snapshot.compactBoundaries];
  return { ...snapshot, compactBoundaries };
}

function applyRuntimeEvent(snapshot: RuntimeSnapshot, event: RuntimeEventRecord): RuntimeSnapshot {
  const runtimeEvents = snapshot.runtimeEvents.some((item) => item.id === event.id)
    ? snapshot.runtimeEvents.map((item) => item.id === event.id ? event : item)
    : [event, ...snapshot.runtimeEvents].slice(0, 300);
  return { ...snapshot, runtimeEvents };
}

function applyMemoryCandidate(snapshot: RuntimeSnapshot, candidate: MemoryCandidate): RuntimeSnapshot {
  const candidates = snapshot.memory.candidates.some((item) => item.id === candidate.id)
    ? snapshot.memory.candidates.map((item) => item.id === candidate.id ? candidate : item)
    : [candidate, ...snapshot.memory.candidates];
  return {
    ...snapshot,
    memory: {
      ...snapshot.memory,
      candidates
    }
  };
}

function formatToolPayload(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2).slice(0, 1200);
  } catch {
    return String(value).slice(0, 1200);
  }
}

function formatToolOutput(toolCall: ToolCallRecord): string {
  const parts = toolCall.outputParts?.map((part) => [
    `${part.type}${part.mimeType ? ` (${part.mimeType})` : ""}`,
    part.text
  ].join("\n")).join("\n\n");
  return truncateText(parts || toolCall.output || "", 1200);
}

function compareCreatedAt(left: { createdAt: string }, right: { createdAt: string }): number {
  return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
}

function shouldShowJobRuntimeEvent(event: RuntimeEventRecord, traceToolIds: Set<string>): boolean {
  if (event.kind === "tool_use_start") {
    const id = runtimeEventDataId(event);
    return Boolean(id && !traceToolIds.has(id));
  }
  return jobTimelineRuntimeEventKinds.has(event.kind);
}

function runtimeEventDataId(event: RuntimeEventRecord): string {
  if (!event.data || typeof event.data !== "object") {
    return "";
  }
  const value = (event.data as { id?: unknown }).id;
  return typeof value === "string" ? value : "";
}

const jobTimelineRuntimeEventKinds = new Set<RuntimeEventRecord["kind"]>([
  "query_start",
  "compact",
  "permission_timeout",
  "memory_recall",
  "memory_candidate",
  "memory_write",
  "subagent_start",
  "subagent_done",
  "worktree_event",
  "turn_complete",
  "turn_failed"
]);

function jobRuntimeEventLabel(event: RuntimeEventRecord, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (event.kind === "tool_use_start") {
    return t("Tool call started");
  }
  return t(event.message || event.kind);
}

function jobRuntimeEventColor(kind: RuntimeEventRecord["kind"]): string {
  if (kind === "turn_failed" || kind === "permission_timeout") {
    return "red";
  }
  if (kind === "turn_complete" || kind === "memory_write") {
    return "green";
  }
  if (kind === "compact" || kind === "worktree_event") {
    return "blue";
  }
  if (kind === "memory_recall" || kind === "memory_candidate") {
    return "purple";
  }
  return "cyan";
}

function toolStatusColor(status: ToolCallRecord["status"]): string {
  switch (status) {
    case "pending_permission":
      return "gold";
    case "running":
      return "cyan";
    case "completed":
      return "green";
    case "failed":
    case "denied":
      return "red";
    default:
      return "default";
  }
}

function assistantPreviewForJob(snapshot: RuntimeSnapshot, job: AgentJob): string {
  const conversation = snapshot.conversations.find((item) => item.id === job.conversationId);
  const messages = (conversation?.messages || []).filter((message) => message.jobId === job.id && message.role === "assistant");
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messages[index]?.text.trim() || "";
    if (text && !isAssistantWaitingText(text)) {
      return text;
    }
  }
  return "";
}

function isAssistantWaitingText(text: string): boolean {
  return text === "HBClient is thinking..." || /^@.+ is thinking\.\.\.$/.test(text);
}

function recentJobProgress(progress: string[]): string[] {
  const result: string[] = [];
  for (let index = progress.length - 1; index >= 0 && result.length < 5; index -= 1) {
    const item = progress[index];
    if (item && !result.includes(item)) {
      result.push(item);
    }
  }
  return result.reverse();
}

function RightPanel({
  snapshot,
  activeConversationId,
  panel,
  setPanel,
  collapsed,
  refresh,
  t,
  openSchedule
}: {
  snapshot: RuntimeSnapshot;
  activeConversationId: string;
  panel: DetailPanel;
  setPanel: (panel: DetailPanel) => void;
  collapsed: boolean;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  openSchedule: () => void;
}) {
  return (
    <aside className={`activity-panel ${collapsed ? "is-collapsed" : ""}`}>
      <Tabs
        activeKey={panel || "memory"}
        onChange={(key) => setPanel(key as DetailPanel)}
        items={[
          { key: "memory", label: t("Memory"), children: <MemoryPanel snapshot={snapshot} activeConversationId={activeConversationId} refresh={refresh} t={t} /> },
          { key: "schedule", label: t("Schedule"), children: <SchedulePanel snapshot={snapshot} openSchedule={openSchedule} refresh={refresh} t={t} /> },
          { key: "autopilot", label: t("Autopilot"), children: <AutopilotPanel snapshot={snapshot} refresh={refresh} t={t} /> }
        ]}
      />
    </aside>
  );
}

function HistoryPanel({ conversations, activeConversationId, setActiveConversationId, refresh, t, embedded = false }: {
  conversations: Conversation[];
  activeConversationId: string;
  setActiveConversationId: (id: string) => void;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  embedded?: boolean;
}) {
  return (
    <div className={`activity-list history-list ${embedded ? "is-embedded" : ""}`}>
      {conversations.map((conversation) => (
        <div className={`activity-item history-item ${conversation.id === activeConversationId ? "is-active" : ""}`} key={conversation.id}>
          <button className="history-item-content" type="button" onClick={() => setActiveConversationId(conversation.id)}>
            <strong>{conversationTitle(conversation, t("New conversation"))}</strong>
            <span className="muted">{formatDateTime(conversation.lastMessageAt || conversation.updatedAt)} · {conversation.messages.length} {t(conversation.messages.length === 1 ? "message" : "messages")}</span>
          </button>
          <Popconfirm
            title={t("Delete conversation?")}
            onConfirm={async () => {
              await window.supbot.deleteConversation(conversation.id);
              await refresh();
            }}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </div>
      ))}
      {!conversations.length ? <Empty description={t("No conversations yet")} /> : null}
    </div>
  );
}

function TasksPanel({
  snapshot,
  cancelJob,
  approveToolPermission,
  denyToolPermission,
  t
}: {
  snapshot: RuntimeSnapshot;
  cancelJob: (id: string) => Promise<void>;
  approveToolPermission: (id: string) => Promise<void>;
  denyToolPermission: (id: string) => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const jobs = snapshot.jobs;
  return (
    <div className="activity-list">
      <RuntimeStatusPanel snapshot={snapshot} t={t} />
      <ToolApprovalsPanel snapshot={snapshot} approveToolPermission={approveToolPermission} denyToolPermission={denyToolPermission} t={t} />
      <WorktreesPanel snapshot={snapshot} t={t} />
      <RemoteBridgePanel snapshot={snapshot} t={t} />
      {jobs.map((job) => {
        const isActiveJob = job.status === "queued" || job.status === "running";
        return (
          <div className={`activity-item stacked job-item ${isActiveJob ? "is-running" : ""}`} key={job.id}>
            <div className="activity-head">
              <strong>{job.prompt.slice(0, 70)}</strong>
              <div className="job-status-group">
                {isActiveJob ? (
                  <span className="job-running-indicator" aria-label={statusLabel(job.status, t)}>
                    <span />
                    <span />
                    <span />
                  </span>
                ) : null}
                <Tag color={statusColor(job.status)}>{statusLabel(job.status, t)}</Tag>
              </div>
            </div>
            {isActiveJob ? <div className="job-running-bar" aria-hidden="true" /> : null}
            <div className="muted">{formatDateTime(job.createdAt)}</div>
            {job.workspaceMode ? (
              <div className="tag-row">
                <Tag color={job.workspaceMode === "isolated" ? "cyan" : job.workspaceMode === "readOnly" ? "purple" : "default"}>{t(job.workspaceMode)}</Tag>
                {job.diffStatus ? <Tag>{t(job.diffStatus)}</Tag> : null}
              </div>
            ) : null}
            <JobExecutionTimeline snapshot={snapshot} job={job} t={t} />
            {isActiveJob ? (
              <Button size="small" danger icon={<StopOutlined />} onClick={() => void cancelJob(job.id)}>{t("Cancel")}</Button>
            ) : null}
          </div>
        );
      })}
      {!jobs.length ? <Empty description={t("No jobs yet")} /> : null}
    </div>
  );
}

function JobExecutionTimeline({ snapshot, job, t }: {
  snapshot: RuntimeSnapshot;
  job: AgentJob;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const isActiveJob = job.status === "queued" || job.status === "running";
  const [expanded, setExpanded] = useState(isActiveJob || job.status === "failed");
  useEffect(() => {
    if (isActiveJob || job.status === "failed") {
      setExpanded(true);
    }
  }, [isActiveJob, job.status]);

  const trace = snapshot.agentLoopTraces.find((item) => item.jobId === job.id);
  const toolCalls = (trace?.toolCalls || []).slice().sort(compareCreatedAt);
  const traceToolIds = new Set(toolCalls.map((item) => item.id));
  const events = snapshot.runtimeEvents
    .filter((event) => event.jobId === job.id && shouldShowJobRuntimeEvent(event, traceToolIds))
    .slice()
    .sort(compareCreatedAt)
    .slice(-8);
  const permissions = snapshot.pendingToolPermissions.filter((permission) => permission.jobId === job.id);
  const assistantText = assistantPreviewForJob(snapshot, job);
  const progress = recentJobProgress(job.progress);
  const showWaiting = isActiveJob && !assistantText && !toolCalls.length && !permissions.length;
  const itemCount = events.length + toolCalls.length + permissions.length + (assistantText ? 1 : 0) + progress.length + (showWaiting ? 1 : 0);

  return (
    <details
      className={`job-execution ${isActiveJob ? "is-live" : ""}`}
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span>{t(isActiveJob ? "Execution log" : "Execution summary")}</span>
        <Tag>{itemCount || 1}</Tag>
      </summary>
      <div className="job-execution-list">
        {events.map((event) => (
          <div className={`job-execution-row kind-${event.kind}`} key={event.id}>
            <span className="job-execution-dot" />
            <div className="job-execution-body">
              <div className="job-execution-head">
                <strong>{jobRuntimeEventLabel(event, t)}</strong>
                <Tag color={jobRuntimeEventColor(event.kind)}>{t(event.kind)}</Tag>
              </div>
              <small>{formatDateTime(event.createdAt)}</small>
            </div>
          </div>
        ))}

        {showWaiting ? (
          <div className="job-execution-row is-waiting">
            <span className="job-execution-dot">
              <span />
            </span>
            <div className="job-execution-body">
              <div className="job-execution-head">
                <strong>{t("Waiting for model response...")}</strong>
                <Tag color="cyan">{statusLabel(job.status, t)}</Tag>
              </div>
              <div className="job-execution-skeleton" aria-hidden="true" />
            </div>
          </div>
        ) : null}

        {assistantText ? (
          <div className="job-execution-row kind-message_delta">
            <span className="job-execution-dot" />
            <div className="job-execution-body">
              <div className="job-execution-head">
                <strong>{t("Assistant output")}</strong>
                <Tag color={isActiveJob ? "cyan" : "green"}>{isActiveJob ? t("running") : t("completed")}</Tag>
              </div>
              <pre>{truncateText(assistantText, 700)}</pre>
            </div>
          </div>
        ) : null}

        {toolCalls.map((toolCall) => (
          <div className={`job-execution-row tool-status-${toolCall.status}`} key={toolCall.id}>
            <span className="job-execution-dot" />
            <div className="job-execution-body">
              <div className="job-execution-head">
                <strong>{toolCall.toolName}</strong>
                <Tag color={toolStatusColor(toolCall.status)}>{t(toolCall.status)}</Tag>
              </div>
              <small>{formatDateTime(toolCall.updatedAt)}</small>
              <details className="job-execution-payload">
                <summary>{t("Input")}</summary>
                <pre>{formatToolPayload(toolCall.input)}</pre>
              </details>
              {toolCall.output || toolCall.outputParts?.length ? (
                <details className="job-execution-payload">
                  <summary>{t("Output")}</summary>
                  <pre>{formatToolOutput(toolCall)}</pre>
                </details>
              ) : null}
              {toolCall.error ? <pre className="job-execution-error">{truncateText(toolCall.error, 700)}</pre> : null}
            </div>
          </div>
        ))}

        {permissions.map((permission) => (
          <div className="job-execution-row tool-status-pending_permission" key={permission.id}>
            <span className="job-execution-dot" />
            <div className="job-execution-body">
              <div className="job-execution-head">
                <strong>{permission.toolName}</strong>
                <Tag color="gold">{t("pending_permission")}</Tag>
              </div>
              <span>{permission.summary}</span>
              {permission.executionPath ? <small className="mono">{permission.executionPath}</small> : null}
            </div>
          </div>
        ))}

        {progress.map((item, index) => (
          <div className="job-execution-row kind-progress" key={`${job.id}-progress-${index}-${item}`}>
            <span className="job-execution-dot" />
            <div className="job-execution-body">
              <div className="job-execution-head">
                <strong>{t("Progress")}</strong>
              </div>
              <span>{t(item)}</span>
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

function WorktreesPanel({ snapshot, t }: { snapshot: RuntimeSnapshot; t: (key: string, vars?: Record<string, string | number>) => string }) {
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [messageApi, contextHolder] = message.useMessage();
  if (!snapshot.worktrees.length) {
    return null;
  }
  const run = async (id: string, action: "apply" | "discard" | "open") => {
    setLoadingId(`${action}:${id}`);
    try {
      if (action === "apply") {
        await window.supbot.applyWorktree(id);
        messageApi.success(t("Worktree applied."));
      } else if (action === "discard") {
        await window.supbot.discardWorktree(id);
        messageApi.success(t("Worktree discarded."));
      } else {
        await window.supbot.openWorktreeFolder(id);
      }
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setLoadingId(null);
    }
  };
  return (
    <div className="worktree-panel">
      {contextHolder}
      <div className="section-title"><FolderOpenOutlined /> {t("Task worktrees")}</div>
      {snapshot.worktrees.slice(0, 5).map((worktree) => (
        <div className="worktree-card" key={worktree.id}>
          <div className="activity-head">
            <strong>{worktree.branchName}</strong>
            <Tag color={worktree.status === "active" ? "cyan" : worktree.status === "failed" ? "red" : "default"}>{t(worktree.status)}</Tag>
          </div>
          <div className="muted mono">{worktree.path}</div>
          <div className="tag-row">
            <Tag>{worktree.baseRef}</Tag>
            <Tag>{t(worktree.diffStatus)}</Tag>
            {worktree.diffSummary?.changedFiles.length ? <Tag>{worktree.diffSummary.changedFiles.length} {t("files")}</Tag> : null}
          </div>
          {worktree.diffSummary?.summary ? <small>{worktree.diffSummary.summary}</small> : null}
          {worktree.diffSummary?.changedFiles.length ? (
            <div className="worktree-files">
              {worktree.diffSummary.changedFiles.slice(0, 4).map((file) => <span key={`${worktree.id}-${file}`}>{file}</span>)}
            </div>
          ) : null}
          <Space wrap>
            <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void run(worktree.id, "open")} loading={loadingId === `open:${worktree.id}`}>{t("Open folder")}</Button>
            <Popconfirm title={t("Apply worktree changes?")} onConfirm={() => void run(worktree.id, "apply")}>
              <Button size="small" type="primary" disabled={worktree.status === "applied" || worktree.status === "discarded"} loading={loadingId === `apply:${worktree.id}`}>{t("Apply")}</Button>
            </Popconfirm>
            <Popconfirm title={t("Discard worktree changes?")} onConfirm={() => void run(worktree.id, "discard")}>
              <Button size="small" danger disabled={worktree.status === "applied" || worktree.status === "discarded"} loading={loadingId === `discard:${worktree.id}`}>{t("Discard")}</Button>
            </Popconfirm>
          </Space>
        </div>
      ))}
    </div>
  );
}

function RemoteBridgePanel({ snapshot, t }: { snapshot: RuntimeSnapshot; t: (key: string, vars?: Record<string, string | number>) => string }) {
  const [saving, setSaving] = useState(false);
  const [savingA2A, setSavingA2A] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const config = snapshot.remoteBridge.config;
  const outbound = snapshot.servstationA2A.config;
  const oidc = outbound.oidc;
  const reverse = outbound.reverse;
  const identity = snapshot.identityContext;
  const update = async (patch: Partial<RemoteBridgeConfig>) => {
    setSaving(true);
    try {
      await window.supbot.updateRemoteBridgeConfig(patch);
      messageApi.success(t("Remote bridge updated."));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const updateA2A = async (patch: ServstationA2AConfigUpdate) => {
    setSavingA2A(true);
    try {
      await window.supbot.updateServstationA2AConfig({
        baseUrl: patch.baseUrl ?? outbound.baseUrl ?? identity?.servstationUrl ?? defaultBotstationBaseUrl,
        agentInstanceId: patch.agentInstanceId ?? outbound.agentInstanceId ?? identity?.agentInstanceId,
        ...patch
      });
      messageApi.success(t("Servstation A2A updated."));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSavingA2A(false);
    }
  };
  const loginOidc = async () => {
    setSavingA2A(true);
    try {
      await window.supbot.loginServstationOidc({
        baseUrl: outbound.baseUrl || identity?.servstationUrl || defaultBotstationBaseUrl,
        issuerUrl: oidc?.issuerUrl || defaultBotstationIssuerUrl,
        clientId: oidc?.clientId || defaultBotstationClientId,
        scope: oidc?.scope || defaultBotstationScope,
        redirectUri: oidc?.redirectUri || defaultBotstationRedirectUri,
        loginHint: outbound.staffAgentAccount || defaultBotstationUser
      });
      messageApi.success(t("Servstation OIDC signed in."));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSavingA2A(false);
    }
  };
  const refreshOidc = async () => {
    setSavingA2A(true);
    try {
      await window.supbot.refreshServstationOidc();
      messageApi.success(t("Servstation OIDC refreshed."));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSavingA2A(false);
    }
  };
  const logoutOidc = async () => {
    setSavingA2A(true);
    try {
      await window.supbot.logoutServstationOidc();
      messageApi.success(t("Servstation OIDC signed out."));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSavingA2A(false);
    }
  };
  const connectReverse = async () => {
    setSavingA2A(true);
    try {
      await ensureServstationOidcSession(outbound, identity, outbound.staffAgentAccount);
      await window.supbot.connectServstationReverseBridge();
      messageApi.success(t("Connected to remote staff-agent."));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSavingA2A(false);
    }
  };
  const disconnectReverse = async () => {
    setSavingA2A(true);
    try {
      await window.supbot.disconnectServstationReverseBridge();
      messageApi.success(t("Disconnected from remote staff-agent."));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSavingA2A(false);
    }
  };
  return (
    <div className="remote-bridge-panel">
      {contextHolder}
      <div className="activity-head">
        <div className="section-title"><ApiOutlined /> {t("Read-only remote bridge")}</div>
        <Switch checked={config.enabled} loading={saving} onChange={(checked) => void update({ enabled: checked })} />
      </div>
      <div className="tag-row">
        <Tag>{config.host}:{config.port}</Tag>
        <Tag color={config.tokenSaved ? "green" : "gold"}>{config.tokenSaved ? t("Token saved") : t("No token")}</Tag>
        {config.allowRemoteBind ? <Tag color="orange">{t("Remote bind opt-in")}</Tag> : null}
        {config.pairingCode ? <Tag color="blue">{config.pairingCode}</Tag> : null}
      </div>
      <small>{t("Remote bridge is read-only for tools, permissions, and worktree apply/discard.")}</small>
      {identity ? (
        <div className="remote-session">
          <span>{identity.tenantId}/{identity.organizationId}/{identity.departmentId}/{identity.userId}</span>
          <Tag color="blue">{identity.source || "identity"}</Tag>
          {identity.agentInstanceId ? <Tag>{identity.agentInstanceId}</Tag> : null}
        </div>
      ) : (
        <small>{t("No Servstation identity is paired yet.")}</small>
      )}
      <Divider />
      <div className="activity-head">
        <div className="section-title"><ApiOutlined /> {t("Servstation outbound A2A")}</div>
        <Switch checked={outbound.enabled} loading={savingA2A} onChange={(checked) => void updateA2A({ enabled: checked })} />
      </div>
      <div className="tag-row">
        <Tag color={outbound.enabled ? "green" : "default"}>{outbound.enabled ? t("enabled") : t("disabled")}</Tag>
        <Tag>{outbound.baseUrl || identity?.servstationUrl || t("No Servstation URL")}</Tag>
        <Tag>{outbound.agentInstanceId || identity?.agentInstanceId || t("No agent id")}</Tag>
        <Tag color={outbound.bearerTokenSaved ? "green" : "gold"}>{outbound.authMode}</Tag>
        <Tag color={reverse?.status === "connected" ? "green" : reverse?.status === "error" ? "red" : "default"}>{t(`reverse:${reverse?.status || "disconnected"}`)}</Tag>
        {oidc?.refreshTokenSaved ? <Tag color="green">{t("OIDC token saved")}</Tag> : null}
        {oidc?.userId ? <Tag>{oidc.userId}</Tag> : null}
        {oidc?.accessTokenExpiresAt ? <Tag>{t("Expires: {time}", { time: formatDateTime(oidc.accessTokenExpiresAt) })}</Tag> : null}
        {reverse?.peerId ? <Tag>{reverse.peerId}</Tag> : null}
      </div>
      <Space wrap size="small">
        <Button size="small" type="primary" loading={savingA2A} onClick={() => void loginOidc()}>{t("Sign in with Servstation")}</Button>
        <Button size="small" icon={<ReloadOutlined />} loading={savingA2A} disabled={!oidc?.refreshTokenSaved} onClick={() => void refreshOidc()}>{t("Refresh OIDC")}</Button>
        <Button size="small" danger disabled={!oidc?.refreshTokenSaved} onClick={() => void logoutOidc()}>{t("Sign out")}</Button>
        {reverse?.enabled ? (
          <Button size="small" danger loading={savingA2A} onClick={() => void disconnectReverse()}>{t("Disconnect remote")}</Button>
        ) : (
          <Button size="small" type="primary" loading={savingA2A} onClick={() => void connectReverse()}>{t("Connect remote")}</Button>
        )}
      </Space>
      <small>{t("Servstation A2A exposes servstation_connect, servstation_prompt, and read-only reverse prompt execution.")}</small>
      {reverse?.lastHeartbeatAt ? <small>{t("Last heartbeat: {time}", { time: formatDateTime(reverse.lastHeartbeatAt) })}</small> : null}
      {reverse?.lastError ? <small>{reverse.lastError}</small> : null}
      {snapshot.remoteBridge.sessions.slice(0, 3).map((session) => (
        <div className="remote-session" key={session.id}>
          <span>{session.name}</span>
          <Tag color={session.revokedAt ? "red" : "green"}>{session.revokedAt ? t("revoked") : t("active")}</Tag>
          {!session.revokedAt ? <Button size="small" onClick={() => void window.supbot.revokeRemoteBridgeSession(session.id)}>{t("Revoke")}</Button> : null}
        </div>
      ))}
      {snapshot.remoteBridge.audit.slice(0, 3).map((record) => (
        <div className="runtime-event" key={record.id}>
          <span>{record.statusCode}</span>
          <small>{record.method} {record.path} 路 {record.message}</small>
        </div>
      ))}
    </div>
  );
}

function RuntimeStatusPanel({ snapshot, t }: { snapshot: RuntimeSnapshot; t: (key: string, vars?: Record<string, string | number>) => string }) {
  const latestEvents = snapshot.runtimeEvents.slice(0, 5);
  const compactHistory = snapshot.compactBoundaries.slice(0, 3);
  return (
    <div className="runtime-events">
      <div className="activity-head">
        <strong>{t("Runtime")}</strong>
        <Tag>{t(snapshot.permissionMode)}</Tag>
      </div>
      {snapshot.querySessions.slice(0, 3).map((session) => (
        <div className="runtime-session" key={session.id}>
          <span>{session.subagentName ? `@${session.subagentName}` : t("Main agent")}</span>
          <Tag color={statusColor(session.status)}>{t(session.status)}</Tag>
        </div>
      ))}
      {latestEvents.length ? (
        <div className="runtime-event-list">
          {latestEvents.map((event) => (
            <div className={`runtime-event kind-${event.kind}`} key={event.id}>
              <span>{t(event.kind)}</span>
              <small>{event.message}</small>
            </div>
          ))}
        </div>
      ) : null}
      {compactHistory.length ? (
        <div className="compact-history">
          <div className="section-title"><CompressOutlined /> {t("Compact history")}</div>
          {compactHistory.map((boundary) => (
            <div className="compact-history-item" key={boundary.id}>
              <div className="activity-head">
                <strong>{formatDateTime(boundary.createdAt)}</strong>
                <Tag>{boundary.originalMessageCount} {t("messages")}</Tag>
              </div>
              <small>{boundary.summary.slice(0, 180)}</small>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ToolApprovalsPanel({
  snapshot,
  approveToolPermission,
  denyToolPermission,
  t
}: {
  snapshot: RuntimeSnapshot;
  approveToolPermission: (id: string) => Promise<void>;
  denyToolPermission: (id: string) => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  if (!snapshot.pendingToolPermissions.length) {
    return null;
  }
  return (
    <div className="tool-approvals">
      <div className="section-title"><ToolOutlined /> {t("Tool approvals")}</div>
      {snapshot.pendingToolPermissions.map((permission) => (
        <div className="tool-approval" key={permission.id}>
          <div>
            <strong>{permission.toolName}</strong>
            <span>{permission.summary}</span>
            {permission.executionPath ? <small className="muted mono">{permission.executionPath}</small> : null}
          </div>
          <Space>
            <Button size="small" type="primary" onClick={() => void approveToolPermission(permission.id)}>{t("Allow once")}</Button>
            <Button size="small" danger onClick={() => void denyToolPermission(permission.id)}>{t("Deny")}</Button>
          </Space>
        </div>
      ))}
    </div>
  );
}

function MemoryPanel({
  snapshot,
  activeConversationId,
  refresh,
  t,
  embedded = false
}: {
  snapshot: RuntimeSnapshot;
  activeConversationId: string;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  embedded?: boolean;
}) {
  const [form] = Form.useForm<MemoryAddInput & { type: "page" | "fact" }>();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<MemoryScope | "all">("all");
  const [records, setRecords] = useState<MemorySearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [transferText, setTransferText] = useState("");
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);
  const [memoryView, setMemoryView] = useState<"manage" | "debug">("manage");
  const [replayQuery, setReplayQuery] = useState("");
  const [replayResult, setReplayResult] = useState<MemoryReplayRecallResult | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const addScope = Form.useWatch("scope", form) || "global";
  const pendingCandidates = snapshot.memory.candidates.filter((candidate) => candidate.status === "pending");
  const recallHistory = (snapshot.memory.recallHistory || []).slice(0, 5);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    try {
      const next = await window.supbot.listMemory({
        query,
        scope,
        conversationId: activeConversationId || undefined,
        includeDisabled: true,
        limit: 80
      });
      setRecords(next);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [activeConversationId, messageApi, query, scope]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords, snapshot.memory.pages.length, snapshot.memory.facts.length, snapshot.memory.candidates.length]);

  const saveMemory = async (values: MemoryAddInput & { type: "page" | "fact" }) => {
    if (values.scope === "conversation" && !activeConversationId) {
      messageApi.warning(t("Choose a conversation before adding conversation memory."));
      return;
    }
    setSaving(true);
    try {
      await window.supbot.addMemory({
        ...values,
        conversationId: values.scope === "conversation" ? activeConversationId : undefined,
        source: "manual"
      });
      form.resetFields();
      messageApi.success(t("Memory saved."));
      await refresh();
      await loadRecords();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const approveCandidate = async (id: string) => {
    await window.supbot.approveMemoryCandidate(id);
    setSelectedCandidateIds((ids) => ids.filter((item) => item !== id));
    messageApi.success(t("Memory approved."));
    await refresh();
    await loadRecords();
  };

  const denyCandidate = async (id: string) => {
    await window.supbot.denyMemoryCandidate(id);
    setSelectedCandidateIds((ids) => ids.filter((item) => item !== id));
    messageApi.success(t("Memory candidate denied."));
    await refresh();
  };

  const approveSelectedCandidates = async () => {
    await Promise.all(selectedCandidateIds.map((id) => window.supbot.approveMemoryCandidate(id)));
    setSelectedCandidateIds([]);
    messageApi.success(t("Selected candidates approved."));
    await refresh();
    await loadRecords();
  };

  const denySelectedCandidates = async () => {
    await Promise.all(selectedCandidateIds.map((id) => window.supbot.denyMemoryCandidate(id)));
    setSelectedCandidateIds([]);
    messageApi.success(t("Selected candidates denied."));
    await refresh();
  };

  const toggleRecord = async (record: MemorySearchResult) => {
    await window.supbot.updateMemory(record.id, { status: record.status === "active" ? "disabled" : "active" });
    await refresh();
    await loadRecords();
  };

  const deleteRecord = async (id: string) => {
    await window.supbot.deleteMemory(id);
    setSelectedRecordIds((ids) => ids.filter((item) => item !== id));
    await refresh();
    await loadRecords();
  };

  const disableSelectedRecords = async () => {
    await Promise.all(selectedRecordIds.map((id) => window.supbot.updateMemory(id, { status: "disabled" })));
    setSelectedRecordIds([]);
    messageApi.success(t("Selected memory disabled."));
    await refresh();
    await loadRecords();
  };

  const deleteSelectedRecords = async () => {
    await Promise.all(selectedRecordIds.map((id) => window.supbot.deleteMemory(id)));
    setSelectedRecordIds([]);
    messageApi.success(t("Selected memory deleted."));
    await refresh();
    await loadRecords();
  };

  const toggleCandidateSelection = (id: string, checked: boolean) => {
    setSelectedCandidateIds((ids) => checked ? [...new Set([...ids, id])] : ids.filter((item) => item !== id));
  };

  const toggleRecordSelection = (id: string, checked: boolean) => {
    setSelectedRecordIds((ids) => checked ? [...new Set([...ids, id])] : ids.filter((item) => item !== id));
  };

  const exportMemory = async () => {
    const transfer = await window.supbot.exportMemory();
    setTransferText(JSON.stringify(transfer, null, 2));
    messageApi.success(t("Memory exported."));
  };

  const importMemory = async () => {
    if (!transferText.trim()) {
      messageApi.warning(t("Paste memory JSON first."));
      return;
    }
    const parsed = JSON.parse(transferText);
    const result = await window.supbot.importMemory({ data: parsed, mode: "merge" });
    messageApi.success(t("Memory imported: {count} items", {
      count: result.imported.pages + result.imported.facts + result.imported.candidates
    }));
    await refresh();
    await loadRecords();
  };

  const backupMemory = async () => {
    const file = await window.supbot.backupMemory();
    messageApi.success(t("Memory backup saved: {path}", { path: file.path }));
  };

  const restoreMemory = async () => {
    const result = await window.supbot.restoreMemory();
    messageApi.success(t("Memory restored: {count} items", {
      count: result.imported.pages + result.imported.facts + result.imported.candidates
    }));
    setSelectedCandidateIds([]);
    setSelectedRecordIds([]);
    await refresh();
    await loadRecords();
  };

  const replayRecall = async (queryText = replayQuery, recallId?: string) => {
    const text = queryText.trim();
    if (!text) {
      messageApi.warning(t("Enter a recall query first."));
      return;
    }
    setReplayLoading(true);
    try {
      const result = await window.supbot.replayMemoryRecall({
        query: text,
        recallId,
        scope,
        conversationId: activeConversationId || undefined,
        limit: 12,
        budgetChars: 1600
      });
      setReplayResult(result);
      setReplayQuery(text);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setReplayLoading(false);
    }
  };

  const addRecallFeedback = async (memoryId: string, kind: "useful" | "irrelevant" | "stale" | "wrong") => {
    await window.supbot.addMemoryRecallFeedback({
      memoryId,
      kind,
      query: replayResult?.query || replayQuery,
      recallId: replayResult?.recallId
    });
    messageApi.success(t("Recall feedback saved."));
    if (replayResult) {
      await replayRecall(replayResult.query, replayResult.recallId);
    }
    await refresh();
  };

  return (
    <div className={`memory-panel ${embedded ? "is-embedded" : "activity-list"}`}>
      {contextHolder}
      <div className="memory-summary">
        <div className="activity-head">
          <strong>{t("Local memory")}</strong>
          <Tag>{snapshot.memory.facts.length + snapshot.memory.pages.length} {t("items")}</Tag>
        </div>
        <div className="stat-grid">
          <div className="mini-stat"><span>{t("Pending")}</span><strong>{pendingCandidates.length}</strong></div>
          <div className="mini-stat"><span>{t("Chunks")}</span><strong>{snapshot.memory.chunks.length}</strong></div>
        </div>
        <Segmented
          value={memoryView}
          onChange={(value) => setMemoryView(value as "manage" | "debug")}
          options={[
            { label: t("Manage"), value: "manage" },
            { label: t("Recall debug"), value: "debug" }
          ]}
        />
      </div>

      {memoryView === "debug" ? (
        <MemoryRecallDebug
          activeConversationId={activeConversationId}
          recallHistory={recallHistory}
          replayQuery={replayQuery}
          setReplayQuery={setReplayQuery}
          replayResult={replayResult}
          replayLoading={replayLoading}
          replayRecall={replayRecall}
          addRecallFeedback={addRecallFeedback}
          t={t}
        />
      ) : (
        <>

      {pendingCandidates.length ? (
        <div className="memory-candidate-list">
          <div className="activity-head">
            <div className="section-title"><FileTextOutlined /> {t("Memory candidates")}</div>
            <Space>
              <Button size="small" type="primary" disabled={!selectedCandidateIds.length} onClick={() => void approveSelectedCandidates()}>{t("Approve selected")}</Button>
              <Button size="small" danger disabled={!selectedCandidateIds.length} onClick={() => void denySelectedCandidates()}>{t("Deny selected")}</Button>
            </Space>
          </div>
          {pendingCandidates.map((candidate) => (
            <div className="memory-candidate-card" key={candidate.id}>
              <div className="memory-select-row">
                <Checkbox
                  checked={selectedCandidateIds.includes(candidate.id)}
                  onChange={(event) => toggleCandidateSelection(candidate.id, event.target.checked)}
                />
                <div className="memory-card-body">
                  <div className="activity-head">
                    <strong>{candidate.title}</strong>
                    <Tag color="gold">{t(candidate.kind)}</Tag>
                  </div>
                  <div className="tag-row">
                    <Tag>{t(candidate.scope)}</Tag>
                    {candidate.subagentName ? <Tag>@{candidate.subagentName}</Tag> : null}
                    <Tag>{Math.round(candidate.confidence * 100)}%</Tag>
                  </div>
                  <p>{candidate.content}</p>
                  <Space>
                    <Button size="small" type="primary" onClick={() => void approveCandidate(candidate.id)}>{t("Approve")}</Button>
                    <Button size="small" danger onClick={() => void denyCandidate(candidate.id)}>{t("Deny")}</Button>
                  </Space>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="memory-recall-history">
        <div className="section-title"><ClockCircleOutlined /> {t("Recent recall")}</div>
        {recallHistory.map((item) => (
          <div className="memory-recall-item" key={item.id}>
            <div className="activity-head">
              <strong>{item.query || t("No query text")}</strong>
              <Tag color={item.injected ? "cyan" : "default"}>{item.injected ? t("Injected") : t("Not injected")}</Tag>
            </div>
            <small>{formatDateTime(item.createdAt)} · {item.resultCount} {t("hits")} · {item.usedChars}/{item.budgetChars} chars</small>
            {item.results.slice(0, 3).map((result) => (
              <div className="memory-recall-hit" key={`${item.id}-${result.id}`}>
                <span>{result.title}</span>
                <small>{result.reason} · {result.sourceLabel} · {result.score.toFixed(2)}</small>
              </div>
            ))}
          </div>
        ))}
        {!recallHistory.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No recall history")} /> : null}
      </div>

      <div className="memory-search-row">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} onPressEnter={() => void loadRecords()} placeholder={t("Search memory")} allowClear />
        <Select
          value={scope}
          onChange={(value) => setScope(value)}
          options={memoryScopeOptions(t, true)}
        />
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void loadRecords()}>{t("Search")}</Button>
      </div>

      <Form
        className="memory-form"
        form={form}
        layout="vertical"
        initialValues={{ type: "fact", scope: "global", kind: "fact", confidence: 0.75 }}
        onFinish={(values) => void saveMemory(values)}
      >
        <div className="memory-form-grid">
          <Form.Item name="type" label={t("Type")} rules={[{ required: true }]}>
            <Segmented options={[{ label: t("Fact"), value: "fact" }, { label: t("Page"), value: "page" }]} />
          </Form.Item>
          <Form.Item name="scope" label={t("Scope")} rules={[{ required: true }]}>
            <Select options={memoryScopeOptions(t, false)} />
          </Form.Item>
        </div>
        {addScope === "subagent" ? (
          <Form.Item name="subagentName" label={t("Subagent")} rules={[{ required: true }]}>
            <Select options={snapshot.subagents.map((subagent) => ({ label: `@${subagent.name}`, value: subagent.name }))} />
          </Form.Item>
        ) : null}
        <Form.Item name="title" label={t("Title")} rules={[{ required: true }]}>
          <Input placeholder={t("Memory title")} />
        </Form.Item>
        <Form.Item name="content" label={t("Content")} rules={[{ required: true }]}>
          <Input.TextArea rows={3} placeholder={t("What should HBClient remember?")} />
        </Form.Item>
        <div className="memory-form-grid">
          <Form.Item name="kind" label={t("Kind")}>
            <Select options={memoryKindOptions(t)} />
          </Form.Item>
          <Form.Item name="confidence" label={t("Confidence")}>
            <InputNumber min={0} max={1} step={0.05} />
          </Form.Item>
        </div>
        <Button htmlType="submit" type="primary" icon={<PlusOutlined />} loading={saving}>{t("Add memory")}</Button>
      </Form>

      <div className="memory-record-list">
        <div className="activity-head">
          <div className="section-title"><FileTextOutlined /> {t("Memory items")}</div>
          <Space>
            <Button size="small" disabled={!selectedRecordIds.length} onClick={() => void disableSelectedRecords()}>{t("Disable selected")}</Button>
            <Popconfirm title={t("Delete selected memory?")} onConfirm={() => void deleteSelectedRecords()}>
              <Button size="small" danger disabled={!selectedRecordIds.length}>{t("Delete selected")}</Button>
            </Popconfirm>
          </Space>
        </div>
        {records.map((record) => (
          <div className={`memory-record status-${record.status}`} key={record.id}>
            <div className="memory-select-row">
              <Checkbox
                checked={selectedRecordIds.includes(record.id)}
                onChange={(event) => toggleRecordSelection(record.id, event.target.checked)}
              />
              <div className="memory-card-body">
                <div className="activity-head">
                  <strong>{record.title}</strong>
                  <Tag color={record.status === "active" ? "cyan" : "default"}>{t(record.status)}</Tag>
                </div>
                <div className="tag-row">
                  <Tag>{t(record.type)}</Tag>
                  <Tag>{t(record.scope)}</Tag>
                  {record.subagentName ? <Tag>@{record.subagentName}</Tag> : null}
                  <Tag>{t("score")}: {record.score.toFixed(2)}</Tag>
                  <Tag>{record.sourceLabel}</Tag>
                </div>
                <div className="memory-reason">{record.reason}</div>
                <p>{record.content}</p>
                <div className="memory-keywords">
                  {record.matchedKeywords.map((keyword) => <Tag color="cyan" key={`${record.id}-match-${keyword}`}>{keyword}</Tag>)}
                  {record.keywords.slice(0, 6).map((keyword) => <Tag key={`${record.id}-${keyword}`}>{keyword}</Tag>)}
                </div>
                <Space>
                  <Button size="small" onClick={() => void toggleRecord(record)}>{record.status === "active" ? t("Disable") : t("Enable")}</Button>
                  <Popconfirm title={t("Delete memory?")} onConfirm={() => void deleteRecord(record.id)}>
                    <Button size="small" danger>{t("Delete")}</Button>
                  </Popconfirm>
                </Space>
              </div>
            </div>
          </div>
        ))}
        {!records.length ? <Empty description={t("No memory items")} /> : null}
      </div>

      <div className="memory-transfer">
        <div className="activity-head">
          <div className="section-title"><SaveOutlined /> {t("Import / export")}</div>
          <Space>
            <Button size="small" onClick={() => void exportMemory()}>{t("Export")}</Button>
            <Button size="small" onClick={() => void importMemory()}>{t("Import")}</Button>
            <Button size="small" onClick={() => void backupMemory()}>{t("Backup")}</Button>
            <Popconfirm title={t("Restore latest memory backup?")} onConfirm={() => void restoreMemory()}>
              <Button size="small">{t("Restore latest")}</Button>
            </Popconfirm>
          </Space>
        </div>
        <Input.TextArea
          className="memory-transfer-box"
          rows={5}
          value={transferText}
          onChange={(event) => setTransferText(event.target.value)}
          placeholder={t("Paste exported memory JSON here")}
        />
      </div>
        </>
      )}
    </div>
  );
}

function MemoryRecallDebug({
  activeConversationId,
  recallHistory,
  replayQuery,
  setReplayQuery,
  replayResult,
  replayLoading,
  replayRecall,
  addRecallFeedback,
  t
}: {
  activeConversationId: string;
  recallHistory: RuntimeSnapshot["memory"]["recallHistory"];
  replayQuery: string;
  setReplayQuery: (query: string) => void;
  replayResult: MemoryReplayRecallResult | null;
  replayLoading: boolean;
  replayRecall: (queryText?: string, recallId?: string) => Promise<void>;
  addRecallFeedback: (memoryId: string, kind: "useful" | "irrelevant" | "stale" | "wrong") => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className="memory-debug-panel">
      <div className="memory-search-row">
        <Input
          value={replayQuery}
          onChange={(event) => setReplayQuery(event.target.value)}
          onPressEnter={() => void replayRecall()}
          placeholder={t("Replay recall query")}
          allowClear
        />
        <Button type="primary" loading={replayLoading} onClick={() => void replayRecall()}>{t("Replay")}</Button>
      </div>

      <div className="memory-recall-history">
        <div className="section-title"><ClockCircleOutlined /> {t("Recall history")}</div>
        {recallHistory.map((item) => (
          <div className="memory-recall-item" key={item.id}>
            <div className="activity-head">
              <strong>{item.query || t("No query text")}</strong>
              <Button size="small" onClick={() => void replayRecall(item.query, item.id)}>{t("Replay")}</Button>
            </div>
            <small>{formatDateTime(item.createdAt)} · {item.resultCount} {t("hits")} · {item.usedChars}/{item.budgetChars} chars</small>
            {item.excludedResults?.length ? <Tag color="orange">{item.excludedResults.length} {t("excluded")}</Tag> : null}
          </div>
        ))}
        {!recallHistory.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={activeConversationId ? t("No recall history") : t("No conversation selected")} /> : null}
      </div>

      {replayResult ? (
        <div className="memory-replay-result">
          <div className="activity-head">
            <strong>{t("Replay result")}</strong>
            <Tag>{replayResult.usedChars}/{replayResult.budgetChars} chars</Tag>
          </div>
          {replayResult.comparedTo ? (
            <div className="tag-row">
              <Tag color="green">+{replayResult.comparedTo.addedIds.length}</Tag>
              <Tag color="red">-{replayResult.comparedTo.removedIds.length}</Tag>
            </div>
          ) : null}
          <RecallResultList title={t("Injected")} items={replayResult.results} addRecallFeedback={addRecallFeedback} t={t} />
          <RecallResultList title={t("Excluded by budget")} items={replayResult.excludedResults} addRecallFeedback={addRecallFeedback} t={t} />
          {replayResult.blockPreview ? <pre className="memory-block-preview">{replayResult.blockPreview}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}

function RecallResultList({
  title,
  items,
  addRecallFeedback,
  t
}: {
  title: string;
  items: MemorySearchResult[];
  addRecallFeedback: (memoryId: string, kind: "useful" | "irrelevant" | "stale" | "wrong") => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className="memory-recall-group">
      <div className="section-title">{title}</div>
      {items.map((item) => (
        <div className="memory-recall-hit is-detailed" key={`${title}-${item.id}`}>
          <div className="activity-head">
            <span>{item.title}</span>
            <Tag>{item.score.toFixed(2)}</Tag>
          </div>
          <small>{item.reason} · {item.sourceLabel}</small>
          <p>{item.content}</p>
          <div className="tag-row">
            {item.matchedKeywords.map((keyword) => <Tag color="cyan" key={`${item.id}-${keyword}`}>{keyword}</Tag>)}
            {item.feedback ? <Tag color="gold">{item.feedback}</Tag> : null}
          </div>
          <Space wrap>
            {(["useful", "irrelevant", "stale", "wrong"] as const).map((kind) => (
              <Button size="small" key={kind} onClick={() => void addRecallFeedback(item.id, kind)}>{t(kind)}</Button>
            ))}
          </Space>
        </div>
      ))}
      {!items.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No items")} /> : null}
    </div>
  );
}

function MemorySettingsCard({ snapshot, refresh, t }: {
  snapshot: RuntimeSnapshot;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className="settings-card">
      <MemoryPanel snapshot={snapshot} activeConversationId={snapshot.conversations[0]?.id || ""} refresh={refresh} t={t} embedded />
    </div>
  );
}

function memoryScopeOptions(t: (key: string) => string, includeAll: boolean) {
  const scopes: Array<{ label: string; value: MemoryScope | "all" }> = [
    ...(includeAll ? [{ label: t("All scopes"), value: "all" as const }] : []),
    { label: t("Global"), value: "global" },
    { label: t("Conversation"), value: "conversation" },
    { label: t("Subagent"), value: "subagent" }
  ];
  return scopes;
}

function memoryKindOptions(t: (key: string) => string): Array<{ label: string; value: MemoryFactKind }> {
  return [
    { label: t("Fact"), value: "fact" },
    { label: t("Preference"), value: "preference" },
    { label: t("Decision"), value: "decision" },
    { label: t("Task"), value: "task" },
    { label: t("Warning"), value: "warning" }
  ];
}

function SchedulePanel({ snapshot, openSchedule, refresh, t }: { snapshot: RuntimeSnapshot; openSchedule: () => void; refresh: () => void; t: (key: string, vars?: Record<string, string | number>) => string }) {
  return (
    <div className="activity-list">
      <Button type="primary" icon={<PlusOutlined />} onClick={openSchedule}>{t("New scheduled prompt")}</Button>
      {snapshot.scheduledJobs.map((job) => (
        <div className="activity-item stacked" key={job.id}>
          <div className="activity-head">
            <strong>{job.title}</strong>
            <Tag color={job.enabled ? "green" : "default"}>{job.enabled ? t("Enabled") : t("Off")}</Tag>
          </div>
          <div className="muted">{formatSchedule(job, t)}</div>
          <Space>
            <Button size="small" onClick={async () => {
              await window.supbot.updateScheduledJob(job.id, { enabled: !job.enabled });
              await refresh();
            }}>{job.enabled ? t("Disable") : t("Enable")}</Button>
            <Popconfirm title={t("Delete scheduled prompt?")} onConfirm={async () => {
              await window.supbot.deleteScheduledJob(job.id);
              await refresh();
            }}>
              <Button size="small" danger>{t("Delete")}</Button>
            </Popconfirm>
          </Space>
        </div>
      ))}
    </div>
  );
}

function AutopilotPanel({ snapshot, refresh, t }: { snapshot: RuntimeSnapshot; refresh: () => void; t: (key: string, vars?: Record<string, string | number>) => string }) {
  const [messageApi, contextHolder] = message.useMessage();
  const [projectForm] = Form.useForm();
  const [runForm] = Form.useForm();
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [pickingProjectFolder, setPickingProjectFolder] = useState(false);
  const [startingRun, setStartingRun] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState(snapshot.autopilotRuns[0]?.id || "");
  const selectedRun = snapshot.autopilotRuns.find((run) => run.id === selectedRunId) || snapshot.autopilotRuns[0];
  const selectedProject = selectedRun ? snapshot.projects.find((project) => project.id === selectedRun.projectId) : snapshot.projects[0];
  const runTasks = selectedRun ? snapshot.autopilotTasks.filter((task) => task.runId === selectedRun.id) : [];
  const runArtifacts = selectedRun ? snapshot.dataArtifacts.filter((artifact) => artifact.runId === selectedRun.id) : [];
  const runEvents = selectedRun ? snapshot.autopilotEvents.filter((event) => event.runId === selectedRun.id).slice(0, 8) : [];

  useEffect(() => {
    if (!selectedRunId && snapshot.autopilotRuns[0]?.id) {
      setSelectedRunId(snapshot.autopilotRuns[0].id);
    }
  }, [selectedRunId, snapshot.autopilotRuns]);

  const projectOptions = snapshot.projects.map((project) => ({ label: project.name, value: project.id }));
  const runOptions = snapshot.autopilotRuns.map((run) => ({ label: `${run.title} (${run.status})`, value: run.id }));

  const createProject = async (values: { rootPath: string; name?: string }) => {
    setCreatingProject(true);
    try {
      const project = await window.supbot.createProjectFromFolder(values);
      runForm.setFieldValue("projectId", project.id);
      await refresh();
      projectForm.resetFields();
      setProjectModalOpen(false);
      messageApi.success(t("Project registered."));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setCreatingProject(false);
    }
  };

  const pickProjectFolder = async () => {
    setPickingProjectFolder(true);
    try {
      const folder = await window.supbot.pickProjectFolder();
      if (folder) {
        projectForm.setFieldValue("rootPath", folder);
      }
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setPickingProjectFolder(false);
    }
  };

  const startRun = async (values: { projectId: string; title?: string; goal: string }) => {
    setStartingRun(true);
    try {
      const run = await window.supbot.startAutopilotDataRun({
        projectId: values.projectId,
        title: values.title,
        goal: values.goal,
        dataSources: []
      });
      setSelectedRunId(run.id);
      await refresh();
      messageApi.success(t("Autopilot data run started."));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setStartingRun(false);
    }
  };

  const controlRun = async (action: "pause" | "resume" | "cancel") => {
    if (!selectedRun) {
      return;
    }
    try {
      if (action === "pause") {
        await window.supbot.pauseAutopilotRun(selectedRun.id);
      } else if (action === "resume") {
        await window.supbot.resumeAutopilotRun(selectedRun.id);
      } else {
        await window.supbot.cancelAutopilotRun(selectedRun.id);
      }
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
    }
  };

  return (
    <div className="autopilot-workbench">
      {contextHolder}
      <div className="autopilot-hero">
        <div>
          <span className="eyebrow">{t("DATA AUTOPILOT")}</span>
          <Typography.Title level={4}>{t("Project data runs")}</Typography.Title>
        </div>
        <Tag color={snapshot.status === "running" ? "cyan" : "default"}>{t(snapshot.status)}</Tag>
      </div>

      <div className="autopilot-grid">
        <section className="autopilot-panel">
          <div className="autopilot-panel-head">
            <div className="section-title"><FolderOpenOutlined /> {t("Project")}</div>
            <Button className="autopilot-new-project-button" size="small" type="primary" icon={<PlusOutlined />} onClick={() => setProjectModalOpen(true)}>{t("New project")}</Button>
          </div>
          <div className="autopilot-project-list">
            {snapshot.projects.length ? snapshot.projects.slice(0, 4).map((project) => (
              <button className="autopilot-project-row" type="button" key={project.id} onClick={() => runForm.setFieldValue("projectId", project.id)}>
                <strong>{project.name}</strong>
                <span className="muted mono">{project.rootPath}</span>
              </button>
            )) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No projects yet")} />}
          </div>
        </section>

        <section className="autopilot-panel">
          <div className="section-title"><ThunderboltOutlined /> {t("New data run")}</div>
          <Form form={runForm} layout="vertical" onFinish={(values) => void startRun(values)} initialValues={{ projectId: selectedProject?.id }}>
            <Form.Item name="projectId" label={t("Project")} rules={[{ required: true }]}>
              <Select options={projectOptions} placeholder={t("Choose project")} />
            </Form.Item>
            <Form.Item name="title" label={t("Title")}>
              <Input />
            </Form.Item>
            <Form.Item name="goal" label={t("Goal")} rules={[{ required: true }]}>
              <Input.TextArea rows={5} />
            </Form.Item>
            <Button block type="primary" icon={<ThunderboltOutlined />} htmlType="submit" loading={startingRun} disabled={!snapshot.projects.length}>{t("Start run")}</Button>
          </Form>
        </section>
      </div>

      <section className="autopilot-panel autopilot-run-panel">
        <div className="autopilot-run-monitor-card">
          <div className="section-title"><FileTextOutlined /> {t("Run monitor")}</div>
          <Select
            className="autopilot-run-select"
            value={selectedRun?.id ?? undefined}
            onChange={setSelectedRunId}
            options={runOptions}
            placeholder={t("No runs yet")}
            disabled={!runOptions.length}
          />
        </div>
        {selectedRun ? (
          <>
            <div className="autopilot-run-header">
              <div>
                <strong>{selectedRun.title}</strong>
                <div className="muted">{selectedProject?.name || selectedRun.projectId}</div>
              </div>
              <Space>
                <Tag color={autopilotStatusColor(selectedRun.status)}>{t(selectedRun.status)}</Tag>
                <Button size="small" onClick={() => void controlRun("pause")} disabled={selectedRun.status !== "running" && selectedRun.status !== "reviewing"}>{t("Pause")}</Button>
                <Button size="small" onClick={() => void controlRun("resume")} disabled={!["paused", "blocked", "failed"].includes(selectedRun.status)}>{t("Resume")}</Button>
                <Popconfirm title={t("Cancel run?")} onConfirm={() => void controlRun("cancel")}>
                  <Button size="small" danger disabled={["completed", "canceled"].includes(selectedRun.status)}>{t("Cancel")}</Button>
                </Popconfirm>
              </Space>
            </div>
            <div className="autopilot-stage-list">
              {runTasks.map((task) => (
                <div className="autopilot-stage-row" key={task.id}>
                  <Tag color={taskStatusColor(task.status)}>{t(task.status)}</Tag>
                  <div>
                    <strong>{task.title}</strong>
                    <span className="muted">@{task.staffAgent} 路 {task.stage} 路 {task.artifactIds.length} {t("artifacts")}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="autopilot-run-columns">
              <div>
                <div className="section-title">{t("Artifacts")}</div>
                {runArtifacts.length ? runArtifacts.slice(0, 8).map((artifact) => (
                  <div className="autopilot-artifact" key={artifact.id}>
                    <Tag>{artifact.kind}</Tag>
                    <span className="mono">{artifact.path}</span>
                  </div>
                )) : <span className="muted">{t("No artifacts yet")}</span>}
              </div>
              <div>
                <div className="section-title">{t("Events")}</div>
                {runEvents.length ? runEvents.map((event) => (
                  <div className="autopilot-event" key={event.id}>
                    <Tag color={event.level === "error" ? "red" : event.level === "warning" ? "gold" : "cyan"}>{event.level}</Tag>
                    <span>{event.message}</span>
                  </div>
                )) : <span className="muted">{t("No events yet")}</span>}
              </div>
            </div>
          </>
        ) : null}
      </section>
      <Modal
        open={projectModalOpen}
        title={t("New project")}
        okText={t("Register project")}
        cancelText={t("Cancel")}
        confirmLoading={creatingProject}
        onCancel={() => {
          projectForm.resetFields();
          setProjectModalOpen(false);
        }}
        onOk={() => projectForm.submit()}
      >
        <Form form={projectForm} layout="vertical" onFinish={(values) => void createProject(values)}>
          <Form.Item label={t("Project folder")} required>
            <div className="autopilot-folder-picker">
              <Form.Item name="rootPath" noStyle rules={[{ required: true }]}>
                <Input readOnly placeholder={t("Choose project folder")} onClick={() => void pickProjectFolder()} />
              </Form.Item>
              <Tooltip title={t("Choose folder")}>
                <Button
                  aria-label={t("Choose folder")}
                  icon={<FolderOpenOutlined />}
                  onClick={() => void pickProjectFolder()}
                  loading={pickingProjectFolder}
                />
              </Tooltip>
            </div>
          </Form.Item>
          <Form.Item name="name" label={t("Name")}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

function autopilotStatusColor(status: AutopilotRun["status"]): string {
  if (status === "completed") {
    return "green";
  }
  if (status === "failed" || status === "blocked" || status === "canceled") {
    return "red";
  }
  if (status === "paused") {
    return "gold";
  }
  return "cyan";
}

function taskStatusColor(status: string): string {
  if (status === "completed") {
    return "green";
  }
  if (status === "failed" || status === "blocked") {
    return "red";
  }
  if (status === "running") {
    return "cyan";
  }
  return "default";
}

function ConfigWorkspace({
  snapshot,
  userDataPath,
  focusTab,
  setFocusTab,
  openModel,
  refresh,
  t,
  openSubagent
}: {
  snapshot: RuntimeSnapshot;
  userDataPath: string;
  focusTab: string;
  setFocusTab: (tab: string) => void;
  openModel: () => void;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  openSubagent: (subagent: SubagentConfig | null) => void;
}) {
  return (
    <section className="config-panel">
      <div className="config-header">
        <div>
          <div className="eyebrow">{t("LOCAL CONFIG")}</div>
          <Typography.Title level={3}>{t("HBClient Settings")}</Typography.Title>
          <div className="muted">{t("Model, personality, local capabilities, and subagents live on this machine.")}</div>
        </div>
        <Button icon={<ReloadOutlined />} onClick={refresh}>{t("Refresh")}</Button>
      </div>
      <Tabs
        activeKey={focusTab}
        onChange={setFocusTab}
        items={[
          { key: "model", label: t("Model"), children: <ModelConfigCard snapshot={snapshot} openModel={openModel} t={t} /> },
          { key: "server-agent", label: t("Server Agent"), children: <RemoteStaffAgentConfigCard snapshot={snapshot} refresh={refresh} t={t} /> },
          { key: "mcp", label: "MCP", children: <McpServersCard snapshot={snapshot} refresh={refresh} t={t} /> },
          { key: "personality", label: t("Personality"), children: <PersonalityCard snapshot={snapshot} refresh={refresh} t={t} /> },
          { key: "capabilities", label: t("Capabilities"), children: <CapabilitiesCard snapshot={snapshot} refresh={refresh} t={t} /> },
          { key: "storage", label: t("Storage"), children: <StorageCard userDataPath={userDataPath} t={t} /> },
          { key: "memory", label: t("Memory"), children: <MemorySettingsCard snapshot={snapshot} refresh={refresh} t={t} /> },
          { key: "subagents", label: t("Subagents"), children: <SubagentsCard snapshot={snapshot} refresh={refresh} openSubagent={openSubagent} t={t} /> }
        ]}
      />
    </section>
  );
}

function MarketWorkspace({
  refresh,
  snapshot,
  openMarketConfig,
  openMcpConfig,
  t
}: {
  refresh: () => Promise<void>;
  snapshot: RuntimeSnapshot;
  openMarketConfig: () => void;
  openMcpConfig: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [products, setProducts] = useState<ToolMarketCatalogItem[]>([]);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<ToolMarketProductType | "all">("all");
  const [loading, setLoading] = useState(false);
  const [actingId, setActingId] = useState("");
  const [error, setError] = useState("");
  const [messageApi, contextHolder] = message.useMessage();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const items = await window.supbot.listToolMarket({ query, type: typeFilter });
      setProducts(items);
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query, typeFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleInstall = async (product: ToolMarketCatalogItem) => {
    if (product.id === "local-mcp-bridge") {
      openMcpConfig();
      return;
    }
    setActingId(product.id);
    try {
      if (product.installed) {
        await window.supbot.uninstallToolMarketProduct(product.id);
        messageApi.success(t("Tool uninstalled."));
      } else {
        await window.supbot.installToolMarketProduct(product.id);
        messageApi.success(t("Tool installed."));
      }
      await load();
      await refresh();
    } catch (actionError) {
      messageApi.error((actionError as Error).message);
    } finally {
      setActingId("");
    }
  };

  return (
    <section className="market-panel">
      {contextHolder}
      <div className="market-header">
        <div>
          <div className="eyebrow">{t("LOCAL TOOL MARKET")}</div>
          <Typography.Title level={3}>{t("Tool Market")}</Typography.Title>
          <div className="muted">{t("Install local and remote capabilities into this single-user agent.")}</div>
          <div className="market-source-row">
            <Tag color="cyan">{t(`market.source.${snapshot.toolMarketConfig.source}`)}</Tag>
            {snapshot.toolMarketConfig.apiUrl ? <Tag>{snapshot.toolMarketConfig.apiUrl}</Tag> : <Tag>{t("Built-in catalog")}</Tag>}
            {snapshot.toolMarketConfig.lastSyncedAt ? <Tag>{t("Last sync: {time}", { time: formatDateTime(snapshot.toolMarketConfig.lastSyncedAt) })}</Tag> : null}
          </div>
        </div>
        <Space wrap>
          <Input
            className="market-search"
            allowClear
            value={query}
            placeholder={t("Search tool products")}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select
            className="market-type-select"
            value={typeFilter}
            onChange={(value) => setTypeFilter(value as ToolMarketProductType | "all")}
            options={[
              { label: t("All types"), value: "all" },
              { label: t("tool"), value: "tool" },
              { label: t("skill"), value: "skill" },
              { label: t("Plugin"), value: "plugin" },
              { label: "MCP", value: "mcp" }
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            {t("Refresh")}
          </Button>
          <Button icon={<SettingOutlined />} onClick={openMarketConfig}>{t("Market settings")}</Button>
        </Space>
      </div>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <div className="market-grid">
        {products.map((product) => (
          <article className={`market-product ${product.installed ? "is-installed" : ""}`} key={product.id}>
            <div className="market-product-head">
              <div className="market-product-icon">
                <ToolOutlined />
              </div>
              <div className="market-product-copy">
                <div className="market-product-title">{t(product.name)}</div>
                <div className="muted">{t(product.providerName)}</div>
              </div>
              <Tag color={marketTypeColor(product.type)}>{t(product.type)}</Tag>
            </div>
            <div className="market-product-description">{t(product.description)}</div>
            <div className="market-product-meta">
              <Tag color={product.origin === "remote" ? "blue" : "default"}>{product.origin === "remote" ? t("Remote") : t("Local")}</Tag>
              <Tag color={product.free ? "green" : "gold"}>{product.priceLabel ? t(product.priceLabel) : product.free ? t("Free") : t("Paid")}</Tag>
              {product.tags.map((tag) => <Tag key={`${product.id}-${tag}`}>{t(tag)}</Tag>)}
              {product.purchased ? <Tag color="blue">{t("Purchased")}</Tag> : null}
              {product.sourceHealth ? <Tag>{product.sourceHealth}</Tag> : null}
              {product.installed ? <Tag color="green">{t("Installed")}</Tag> : null}
            </div>
            <Button
              className="market-product-action"
              type={product.installed ? "default" : "primary"}
              icon={product.installed ? <CheckCircleOutlined /> : <AppstoreAddOutlined />}
              loading={actingId === product.id}
              disabled={Boolean(actingId) && actingId !== product.id}
              onClick={() => void toggleInstall(product)}
            >
              {product.id === "local-mcp-bridge" ? t("Configure") : product.installed ? t("Uninstall") : t("Install")}
            </Button>
          </article>
        ))}
      </div>
      {!loading && products.length === 0 ? <Empty className="market-empty" description={t("No matching tool products")} /> : null}
    </section>
  );
}

function marketTypeColor(type: ToolMarketProductType): string {
  switch (type) {
    case "mcp":
      return "purple";
    case "plugin":
      return "blue";
    case "skill":
      return "cyan";
    default:
      return "green";
  }
}

function StorageCard({ userDataPath, t }: { userDataPath: string; t: (key: string, vars?: Record<string, string | number>) => string }) {
  return (
    <div className="settings-card">
      <div className="panel-heading">
        <div>
          <div className="section-title"><PaperClipOutlined /> {t("Local storage")}</div>
          <div className="muted">{t("Conversations, encrypted model credentials, generated files, and schedules stay under this app data directory.")}</div>
        </div>
        {userDataPath ? <Button onClick={() => void window.supbot.openFile(userDataPath)}>{t("Open folder")}</Button> : null}
      </div>
      <div className="config-grid">
        <div><span>{t("User data")}</span><strong>{userDataPath || t("Loading...")}</strong></div>
        <div><span>{t("Generated files")}</span><strong>{userDataPath ? `${userDataPath}\\data\\generated-files` : t("Loading...")}</strong></div>
      </div>
      <Divider />
      <Alert
        type={userDataPath ? "info" : "warning"}
        showIcon
        message={t("Credential storage")}
        description={t("HBClient uses the operating system safe storage when available. If the app reports file storage for a credential, treat that fallback as local obfuscation rather than strong encryption.")}
      />
      <Divider />
      <Alert
        type="info"
        showIcon
        message={t("Local tool commands")}
        description={t("/read <path> reads a UTF-8 text file, /write <name-or-path> creates a generated file, and /shell <command> runs a local command with a 60-second timeout.")}
      />
    </div>
  );
}

function ToolMarketConfigCard({ snapshot, refresh, t }: {
  snapshot: RuntimeSnapshot;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [form] = Form.useForm<ToolMarketConfigUpdate>();
  const [saving, setSaving] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const config = snapshot.toolMarketConfig;

  useEffect(() => {
    form.setFieldsValue({
      source: config.source,
      apiUrl: config.apiUrl,
      accountEmail: config.accountEmail,
      accessToken: "",
      password: "",
      clearAccessToken: false,
      clearPassword: false
    });
  }, [config, form]);

  const save = async (values: ToolMarketConfigUpdate) => {
    setSaving(true);
    try {
      await window.supbot.updateToolMarketConfig(values);
      messageApi.success(t("Tool market configuration saved."));
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-card">
      {contextHolder}
      <div className="panel-heading">
        <div>
          <div className="section-title"><AppstoreOutlined /> {t("Tool market source")}</div>
          <div className="muted">{t("Use the built-in local catalog, a remote ToolsMarket-compatible API, or both.")}</div>
        </div>
        <Space wrap>
          <Tag color={config.passwordSaved ? "green" : "default"}>{config.passwordSaved ? t("Password saved") : t("No password")}</Tag>
          <Tag color={config.accessTokenSaved ? "green" : "default"}>{config.accessTokenSaved ? t("Token saved") : t("No token")}</Tag>
        </Space>
      </div>
      <Form form={form} layout="vertical" initialValues={{ source: "hybrid", apiUrl: defaultToolMarketApiUrl, accountEmail: "subscriber@toolsmarket.local" }} onFinish={(values) => void save(values as ToolMarketConfigUpdate)}>
        <Form.Item label={t("Source")} name="source">
          <Segmented
            options={[
              { label: t("Local catalog"), value: "local" },
              { label: t("Remote API"), value: "remote" },
              { label: t("Hybrid"), value: "hybrid" }
            ]}
          />
        </Form.Item>
        <Form.Item label={t("Market API URL")} name="apiUrl" tooltip={t("Use the i-shu.com tool market or a compatible catalog API returning { items: [...] }.")}>
          <Input placeholder={defaultToolMarketApiUrl} />
        </Form.Item>
        <Form.Item label={t("Market account email")} name="accountEmail">
          <Input placeholder="subscriber@toolsmarket.local" />
        </Form.Item>
        <Form.Item label={t("Market password")} name="password" extra={config.passwordSaved ? t("Leave blank to keep the existing password.") : t("Optional when the market allows anonymous catalog access.")}>
          <Input.Password autoComplete="new-password" placeholder="Password" />
        </Form.Item>
        <Form.Item name="clearPassword" valuePropName="checked">
          <Switch checkedChildren={t("Clear saved password")} unCheckedChildren={t("Keep saved password")} />
        </Form.Item>
        <Form.Item label={t("Access token")} name="accessToken" extra={config.accessTokenSaved ? t("Leave blank to keep the existing token.") : t("Optional for public local market APIs.")}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="clearAccessToken" valuePropName="checked">
          <Switch checkedChildren={t("Clear saved token")} unCheckedChildren={t("Keep saved token")} />
        </Form.Item>
        <Space wrap>
          <Button type="primary" icon={<SaveOutlined />} htmlType="submit" loading={saving}>{t("Save")}</Button>
          <Button icon={<ReloadOutlined />} onClick={async () => {
            try {
              await window.supbot.listToolMarket({});
              messageApi.success(t("Tool market refreshed."));
              await refresh();
            } catch (error) {
              messageApi.error((error as Error).message);
            }
          }}>{t("Refresh")}</Button>
          {config.lastSyncedAt ? <span className="muted">{t("Last sync: {time}", { time: formatDateTime(config.lastSyncedAt) })}</span> : null}
        </Space>
      </Form>
    </div>
  );
}

function RemoteStaffAgentConfigCard({ snapshot, refresh, t }: {
  snapshot: RuntimeSnapshot;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [form] = Form.useForm<ServstationA2AConfigUpdate>();
  const [saving, setSaving] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const config = snapshot.servstationA2A.config;
  const oidc = config.oidc;
  const reverse = config.reverse;

  useEffect(() => {
    form.setFieldsValue({
      enabled: config.enabled,
      baseUrl: config.baseUrl || snapshot.identityContext?.servstationUrl || defaultBotstationBaseUrl,
      authMode: "oidc",
      staffAgentAccount: config.staffAgentAccount || defaultBotstationUser,
      staffAgentPassword: "",
      clearStaffAgentPassword: false,
      agentInstanceId: config.agentInstanceId || snapshot.identityContext?.agentInstanceId,
      oidcIssuerUrl: oidc?.issuerUrl || defaultBotstationIssuerUrl,
      oidcClientId: oidc?.clientId || defaultBotstationClientId,
      oidcScope: oidc?.scope || defaultBotstationScope,
      oidcRedirectUri: oidc?.redirectUri || defaultBotstationRedirectUri
    });
  }, [config, form, oidc, snapshot.identityContext]);

  const save = async (values: ServstationA2AConfigUpdate) => {
    setSaving(true);
    try {
      await window.supbot.updateServstationA2AConfig({
        ...values,
        enabled: true,
        authMode: "oidc"
      });
      messageApi.success(t("Remote staff-agent configuration saved."));
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-card">
      {contextHolder}
      <div className="panel-heading">
        <div>
          <div className="section-title"><ApiOutlined /> {t("Remote staff-agent")}</div>
          <div className="muted">{t("Configure the Servstation account used to connect the server staff-agent.")}</div>
        </div>
        <Space wrap>
          <Tag color={config.staffAgentPasswordSaved ? "green" : "default"}>{config.staffAgentPasswordSaved ? t("Password saved") : t("No password")}</Tag>
          <Tag color={oidc?.refreshTokenSaved ? "green" : "default"}>{oidc?.refreshTokenSaved ? t("OIDC token saved") : t("No token")}</Tag>
          <Tag color={reverse?.status === "connected" ? "green" : reverse?.status === "error" ? "red" : "default"}>{t(`reverse:${reverse?.status || "disconnected"}`)}</Tag>
        </Space>
      </div>
      <Form form={form} layout="vertical" onFinish={(values) => void save(values as ServstationA2AConfigUpdate)}>
        <Form.Item label={t("Servstation base URL")} name="baseUrl">
          <Input placeholder={defaultBotstationBaseUrl} />
        </Form.Item>
        <Form.Item label={t("OIDC issuer URL")} name="oidcIssuerUrl">
          <Input placeholder={defaultBotstationIssuerUrl} />
        </Form.Item>
        <Form.Item label={t("OIDC client id")} name="oidcClientId">
          <Input placeholder={defaultBotstationClientId} />
        </Form.Item>
        <Form.Item label={t("OIDC scope")} name="oidcScope">
          <Input placeholder={defaultBotstationScope} />
        </Form.Item>
        <Form.Item label={t("Staff-agent account")} name="staffAgentAccount">
          <Input autoComplete="username" />
        </Form.Item>
        <Form.Item label={t("Staff-agent password")} name="staffAgentPassword" extra={config.staffAgentPasswordSaved ? t("Leave blank to keep the existing password.") : t("Required for password login.")}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="clearStaffAgentPassword" valuePropName="checked">
          <Switch checkedChildren={t("Clear saved password")} unCheckedChildren={t("Keep saved password")} />
        </Form.Item>
        <Form.Item label={t("Agent instance id")} name="agentInstanceId">
          <Input />
        </Form.Item>
        <Form.Item label={t("OIDC redirect URI")} name="oidcRedirectUri">
          <Input />
        </Form.Item>
        <Space wrap>
          <Button type="primary" icon={<SaveOutlined />} htmlType="submit" loading={saving}>{t("Save")}</Button>
          {config.staffAgentPasswordStorage ? <span className="muted">{t("Credential storage")}: {config.staffAgentPasswordStorage}</span> : null}
        </Space>
      </Form>
    </div>
  );
}

function McpServersCard({ snapshot, refresh, t }: {
  snapshot: RuntimeSnapshot;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [form] = Form.useForm<McpServerInput & { envText?: string; argsText?: string }>();
  const [editing, setEditing] = useState<McpServerSnapshot | null>(null);
  const [busyId, setBusyId] = useState("");
  const [logServer, setLogServer] = useState<McpServerSnapshot | null>(null);
  const [logs, setLogs] = useState<McpLogRecord[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [presets, setPresets] = useState<McpServerPreset[]>([]);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferText, setTransferText] = useState("");
  const [diagnostic, setDiagnostic] = useState<McpDiagnosticResult | null>(null);
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  useEffect(() => {
    void window.supbot.listMcpPresets().then(setPresets).catch(() => setPresets([]));
  }, []);
  const save = async (values: McpServerInput & { envText?: string; argsText?: string }) => {
    const input: McpServerInput = {
      name: values.name,
      command: values.command,
      args: parseArgsText(values.argsText),
      cwd: values.cwd,
      env: parseEnvText(values.envText),
      requestTimeoutMs: values.requestTimeoutMs,
      enabled: values.enabled,
      autoConnect: values.autoConnect
    };
    try {
      if (editing) {
        await window.supbot.updateMcpServer(editing.id, input);
        messageApi.success(t("MCP server updated."));
      } else {
        await window.supbot.addMcpServer(input);
        messageApi.success(t("MCP server added."));
      }
      setEditing(null);
      form.resetFields();
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
    }
  };
  const run = async (serverId: string, action: () => Promise<unknown>, success: string) => {
    setBusyId(serverId);
    try {
      await action();
      messageApi.success(t(success));
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
      await refresh();
    } finally {
      setBusyId("");
    }
  };
  const beginEdit = (server: McpServerSnapshot) => {
    setEditing(server);
    form.setFieldsValue({
      name: server.name,
      command: server.command,
      argsText: server.args.join("\n"),
      cwd: server.cwd,
      envText: formatEnvText(server.env),
      requestTimeoutMs: server.requestTimeoutMs || 30000,
      enabled: server.enabled,
      autoConnect: server.autoConnect
    });
  };
  const applyPreset = (presetId: string) => {
    const preset = presets.find((item) => item.id === presetId);
    if (!preset) {
      return;
    }
    setEditing(null);
    form.setFieldsValue({
      name: preset.serverInput.name,
      command: preset.serverInput.command,
      argsText: (preset.serverInput.args || []).join("\n"),
      cwd: preset.serverInput.cwd,
      envText: formatEnvText(preset.serverInput.env),
      requestTimeoutMs: preset.serverInput.requestTimeoutMs || 30000,
      enabled: preset.serverInput.enabled,
      autoConnect: false
    });
    messageApi.info(t("Preset loaded as a draft."));
  };
  const exportConfig = async () => {
    const transfer = await window.supbot.exportMcpConfig();
    setTransferText(JSON.stringify(transfer, null, 2));
    setTransferOpen(true);
  };
  const importConfig = async () => {
    try {
      const parsed = JSON.parse(transferText) as McpConfigTransfer;
      const result = await window.supbot.importMcpConfig(parsed);
      messageApi.success(t("Imported {count} MCP servers.", { count: result.imported }));
      setTransferOpen(false);
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
    }
  };
  const valuesToMcpInput = (values: McpServerInput & { envText?: string; argsText?: string }): McpServerInput => ({
    name: values.name || "diagnostic",
    command: values.command,
    args: parseArgsText(values.argsText),
    cwd: values.cwd,
    env: parseEnvText(values.envText),
    requestTimeoutMs: values.requestTimeoutMs,
    enabled: true,
    autoConnect: false
  });
  const diagnoseValues = async () => {
    try {
      const values = await form.validateFields();
      const result = await window.supbot.diagnoseMcpServer(valuesToMcpInput(values));
      setDiagnostic(result);
      setDiagnosticOpen(true);
    } catch (error) {
      messageApi.error((error as Error).message);
    }
  };
  const diagnoseServer = async (server: McpServerSnapshot) => {
    const result = await window.supbot.diagnoseMcpServer(server);
    setDiagnostic(result);
    setDiagnosticOpen(true);
  };
  const addMcpRule = async (toolName: string, behavior: PermissionRule["behavior"]) => {
    await window.supbot.addPermissionRule({ toolName, behavior });
    messageApi.success(t("Permission rule added."));
    await refresh();
  };
  const showLogs = async (server: McpServerSnapshot) => {
    setLogServer(server);
    setLogsLoading(true);
    try {
      setLogs(await window.supbot.getMcpLogs(server.id));
    } catch (error) {
      messageApi.error((error as Error).message);
      setLogs([]);
    } finally {
      setLogsLoading(false);
    }
  };
  const copyMcpText = async (text: string, success: string) => {
    try {
      await navigator.clipboard.writeText(text);
      messageApi.success(t(success));
    } catch (error) {
      messageApi.error((error as Error).message);
    }
  };
  return (
    <div className="settings-stack">
      {contextHolder}
      <div className="settings-card">
        <div className="panel-heading">
          <div>
            <div className="section-title"><ToolOutlined /> {t("MCP Servers")}</div>
            <div className="muted">{t("Connect local stdio MCP servers. Tools are registered through HBClient permissions.")}</div>
          </div>
          <Space wrap>
            <Tag color="cyan">{snapshot.mcpServers.length} {t("servers")}</Tag>
            <Tag color="green">{snapshot.mcpTools.length} {t("tools")}</Tag>
          </Space>
        </div>
        <div className="mcp-preset-bar">
          <Select
            className="mcp-preset-select"
            placeholder={t("Load MCP preset")}
            options={presets.map((preset) => ({ value: preset.id, label: preset.name }))}
            onChange={applyPreset}
          />
          <Button onClick={() => void exportConfig()}>{t("Export MCP")}</Button>
          <Button onClick={() => {
            setTransferText("");
            setTransferOpen(true);
          }}>{t("Import MCP")}</Button>
        </div>
        <Form
          form={form}
          layout="vertical"
          initialValues={{ enabled: true, autoConnect: false, requestTimeoutMs: 30000 }}
          onFinish={(values) => void save(values)}
        >
          <div className="mcp-form-grid">
            <Form.Item label={t("Name")} name="name" rules={[{ required: true }]}>
              <Input placeholder="local-files" />
            </Form.Item>
            <Form.Item label={t("Command")} name="command" rules={[{ required: true }]}>
              <Input placeholder="node" />
            </Form.Item>
            <Form.Item label={t("Arguments")} name="argsText">
              <Input.TextArea rows={3} placeholder="D:\\tools\\mcp-server.js" />
            </Form.Item>
            <Form.Item label={t("Working directory")} name="cwd">
              <Input placeholder="D:\\projects\\my-server" />
            </Form.Item>
            <Form.Item label={t("Request timeout (ms)")} name="requestTimeoutMs">
              <InputNumber min={1000} max={120000} step={1000} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label={t("Environment")} name="envText">
              <Input.TextArea rows={3} placeholder="API_KEY=value" />
            </Form.Item>
            <div className="mcp-switches">
              <Form.Item label={t("Enabled")} name="enabled" valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item label={t("Auto connect")} name="autoConnect" valuePropName="checked">
                <Switch />
              </Form.Item>
            </div>
          </div>
          <Space wrap>
            <Button type="primary" icon={<SaveOutlined />} htmlType="submit">{editing ? t("Save") : t("Add server")}</Button>
            <Button onClick={() => void diagnoseValues()}>{t("Diagnose draft")}</Button>
            {editing ? <Button onClick={() => {
              setEditing(null);
              form.resetFields();
            }}>{t("Cancel")}</Button> : null}
          </Space>
        </Form>
      </div>
      <div className="mcp-server-list">
        {snapshot.mcpServers.map((server) => {
          const tools = snapshot.mcpTools.filter((tool) => tool.serverId === server.id);
          return (
            <div className="mcp-server-card" key={server.id}>
              <div className="activity-head">
                <div>
                  <strong>{server.name}</strong>
                  <div className="muted mono">{server.command} {server.args.join(" ")}</div>
                </div>
                <Space wrap>
                  <Tag color={mcpStatusColor(server.status.state)}>{t(server.status.state)}</Tag>
                  <Tag>{tools.length} {t("tools")}</Tag>
                  {!server.enabled ? <Tag>{t("disabled")}</Tag> : null}
                </Space>
              </div>
              <div className="mcp-status-grid">
                <span>{t("PID")}: <strong>{server.status.pid || "-"}</strong></span>
                <span>{t("Timeout")}: <strong>{server.requestTimeoutMs || 30000}ms</strong></span>
                <span>{t("Last connected")}: <strong>{server.status.lastConnectedAt ? formatDateTime(server.status.lastConnectedAt) : "-"}</strong></span>
                <span>{t("Exit")}: <strong>{server.status.lastExitReason || "-"}</strong></span>
              </div>
              {server.status.lastError ? <Alert type="warning" showIcon message={server.status.lastError} /> : null}
              {server.status.stderrPreview ? <Alert type="info" showIcon message={t("stderr preview")} description={<pre className="mcp-log-preview">{server.status.stderrPreview}</pre>} /> : null}
              <div className="mcp-tool-list">
                {tools.length ? tools.map((tool) => (
                  <div className="mcp-tool-row" key={tool.runtimeToolName}>
                    <div>
                      <strong>{tool.runtimeToolName}</strong>
                      <span className="muted mono">{tool.modelToolName}</span>
                      <span className="muted">{tool.description || t("No description")}</span>
                    </div>
                    <Space wrap>
                      <Tag>{Object.keys(tool.inputSchema.properties || {}).length} {t("params")}</Tag>
                      {tool.schemaValid === false ? <Tag color="orange">{t("schema warning")}</Tag> : null}
                      <Select
                        size="small"
                        className="mcp-tool-rule-select"
                        placeholder={t("Rule")}
                        onChange={(behavior) => void addMcpRule(tool.runtimeToolName, behavior as PermissionRule["behavior"])}
                        options={[
                          { value: "allow", label: t("allow") },
                          { value: "ask", label: t("ask") },
                          { value: "deny", label: t("deny") }
                        ]}
                      />
                    </Space>
                    {tool.schemaWarnings?.length ? <pre className="mcp-log-preview">{tool.schemaWarnings.slice(0, 4).join("\n")}</pre> : null}
                  </div>
                )) : <span className="muted">{t("No tools discovered")}</span>}
              </div>
              <Space wrap>
                <Button size="small" onClick={() => beginEdit(server)}>{t("Edit")}</Button>
                <Button size="small" onClick={() => void showLogs(server)}>{t("Logs")}</Button>
                <Button size="small" onClick={() => void diagnoseServer(server)}>{t("Diagnose")}</Button>
                <Button size="small" icon={<CopyOutlined />} onClick={() => void copyMcpText(formatMcpDiagnosticSummary(server, tools), "Copied diagnostic summary.")}>{t("Copy diagnostic summary")}</Button>
                <Button size="small" icon={<CopyOutlined />} onClick={() => void copyMcpText(formatMcpToolList(server, tools), "Copied tool list.")}>{t("Copy tool list")}</Button>
                <Select
                  size="small"
                  className="mcp-rule-select"
                  placeholder={t("Server rule")}
                  onChange={(behavior) => void addMcpRule(`mcp.${server.id}.*`, behavior as PermissionRule["behavior"])}
                  options={[
                    { value: "allow", label: t("allow server") },
                    { value: "ask", label: t("ask server") },
                    { value: "deny", label: t("deny server") }
                  ]}
                />
                <Button
                  size="small"
                  loading={busyId === server.id}
                  onClick={() => void run(server.id, () => window.supbot.connectMcpServer(server.id), "MCP server connected.")}
                  disabled={!server.enabled || server.status.state === "connected"}
                >
                  {t("Connect")}
                </Button>
                <Button
                  size="small"
                  loading={busyId === server.id}
                  onClick={() => void run(server.id, () => window.supbot.disconnectMcpServer(server.id), "MCP server disconnected.")}
                  disabled={server.status.state !== "connected"}
                >
                  {t("Disconnect")}
                </Button>
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  loading={busyId === server.id}
                  onClick={() => void run(server.id, () => window.supbot.refreshMcpTools(server.id), "MCP tools refreshed.")}
                  disabled={server.status.state !== "connected"}
                >
                  {t("Refresh tools")}
                </Button>
                <Popconfirm title={t("Delete MCP server?")} onConfirm={() => void run(server.id, () => window.supbot.removeMcpServer(server.id), "MCP server removed.")}>
                  <Button size="small" danger icon={<DeleteOutlined />}>{t("Delete")}</Button>
                </Popconfirm>
              </Space>
            </div>
          );
        })}
        {!snapshot.mcpServers.length ? <Empty description={t("No MCP servers configured")} /> : null}
      </div>
      <Modal
        title={logServer ? t("MCP logs: {name}", { name: logServer.name }) : t("MCP logs")}
        open={Boolean(logServer)}
        onCancel={() => setLogServer(null)}
        footer={null}
      >
        {logsLoading ? <Spin /> : logs.length ? (
          <div className="mcp-log-list">
            {logs.map((log) => (
              <div className={`mcp-log-row mcp-log-${log.level}`} key={log.id}>
                <span>{formatDateTime(log.createdAt)}</span>
                <Tag>{log.level}</Tag>
                <pre>{log.message}</pre>
              </div>
            ))}
          </div>
        ) : <Empty description={t("No logs")} />}
      </Modal>
      <Modal
        title={t("MCP import / export")}
        open={transferOpen}
        onCancel={() => setTransferOpen(false)}
        onOk={() => void importConfig()}
        okText={t("Import")}
      >
        <Input.TextArea
          className="mcp-transfer-textarea"
          rows={14}
          value={transferText}
          onChange={(event) => setTransferText(event.target.value)}
          placeholder={t("Paste exported MCP JSON here")}
        />
      </Modal>
      <Modal
        title={t("MCP diagnostic")}
        open={diagnosticOpen}
        onCancel={() => setDiagnosticOpen(false)}
        footer={<Button onClick={() => setDiagnosticOpen(false)}>{t("Close")}</Button>}
        width={760}
      >
        {diagnostic ? (
          <div className="mcp-diagnostic">
            <Alert type={diagnostic.ok ? "success" : "error"} showIcon message={diagnostic.ok ? t("Diagnostic passed") : diagnostic.error || t("Diagnostic failed")} />
            <div className="config-grid">
              <div><span>{t("Server")}</span><strong>{diagnostic.serverName}</strong></div>
              <div><span>{t("Duration")}</span><strong>{diagnostic.durationMs}ms</strong></div>
              <div><span>{t("Tools")}</span><strong>{diagnostic.toolCount}</strong></div>
              <div><span>{t("Initialize")}</span><strong>{diagnostic.initializeMs ?? "-"}ms</strong></div>
              <div><span>{t("tools/list")}</span><strong>{diagnostic.toolsListMs ?? "-"}ms</strong></div>
              <div><span>{t("Protocol")}</span><strong>{diagnostic.protocolVersion || "-"}</strong></div>
              <div><span>{t("Error code")}</span><strong>{diagnostic.errorCode ?? "-"}</strong></div>
            </div>
            {diagnostic.capabilities !== undefined ? <Alert type="info" showIcon message={t("Capabilities")} description={<pre className="mcp-log-preview">{formatJsonSnippet(diagnostic.capabilities)}</pre>} /> : null}
            {diagnostic.errorData !== undefined ? <Alert type="error" showIcon message={t("Error data")} description={<pre className="mcp-log-preview">{formatJsonSnippet(diagnostic.errorData)}</pre>} /> : null}
            {diagnostic.schemaWarnings.length ? <Alert type="warning" showIcon message={t("Schema warnings")} description={<pre className="mcp-log-preview">{diagnostic.schemaWarnings.join("\n")}</pre>} /> : null}
            {diagnostic.stderrPreview ? <pre className="mcp-log-preview">{diagnostic.stderrPreview}</pre> : null}
            <div className="mcp-tool-list">
              {diagnostic.tools.map((tool) => (
                <div className="mcp-tool-row" key={tool.runtimeToolName}>
                  <div>
                    <strong>{tool.runtimeToolName}</strong>
                    <span className="muted mono">{tool.modelToolName}</span>
                    <span className="muted">{tool.description || t("No description")}</span>
                  </div>
                  <Space wrap>
                    <Tag>{Object.keys(tool.inputSchema.properties || {}).length} {t("params")}</Tag>
                    {tool.schemaValid === false ? <Tag color="orange">{t("schema warning")}</Tag> : null}
                  </Space>
                  {tool.schemaWarnings?.length ? <pre className="mcp-log-preview">{tool.schemaWarnings.slice(0, 4).join("\n")}</pre> : null}
                </div>
              ))}
            </div>
          </div>
        ) : <Empty description={t("No diagnostic result")} />}
      </Modal>
    </div>
  );
}

function ModelConfigCard({ snapshot, openModel, t }: { snapshot: RuntimeSnapshot; openModel: () => void; t: (key: string, vars?: Record<string, string | number>) => string }) {
  return (
    <div className="settings-card">
      <div className="panel-heading">
        <div>
          <div className="section-title"><SettingOutlined /> {t("Model provider")}</div>
          <div className="muted">{t("OpenAI-compatible endpoint used by the local runtime.")}</div>
        </div>
        <Button type="primary" onClick={openModel}>{t("Change model")}</Button>
      </div>
      <div className="config-grid">
        <div><span>{t("Provider")}</span><strong>{snapshot.modelConfig.providerName}</strong></div>
        <div><span>{t("Base URL")}</span><strong>{snapshot.modelConfig.baseUrl}</strong></div>
        <div><span>{t("Model")}</span><strong>{snapshot.modelConfig.model}</strong></div>
        <div><span>{t("API key")}</span><strong>{snapshot.modelConfig.apiKeySaved ? `${t("Saved")} (${snapshot.modelConfig.apiKeyStorage})` : t("Missing")}</strong></div>
      </div>
    </div>
  );
}

function PersonalityCard({ snapshot, refresh, t }: { snapshot: RuntimeSnapshot; refresh: () => void; t: (key: string, vars?: Record<string, string | number>) => string }) {
  const [form] = Form.useForm<PersonalityConfig>();
  return (
    <div className="settings-card">
      <Form form={form} layout="vertical" initialValues={{ ...snapshot.personality, traits: snapshot.personality.traits.join(", ") }}>
        <Form.Item label={t("Summary")} name="summary"><Input /></Form.Item>
        <Form.Item label={t("Traits")} name="traits"><Input placeholder={t("precise, calm, proactive")} /></Form.Item>
        <Form.Item label={t("Instructions")} name="instructions"><Input.TextArea rows={5} /></Form.Item>
        <Button type="primary" icon={<SaveOutlined />} onClick={async () => {
          const values = await form.validateFields() as unknown as { summary: string; traits: string; instructions: string };
          await window.supbot.updatePersonality({
            summary: values.summary,
            traits: values.traits.split(",").map((item) => item.trim()).filter(Boolean),
            instructions: values.instructions
          });
          await refresh();
        }}>{t("Save personality")}</Button>
      </Form>
    </div>
  );
}

function CapabilitiesCard({ snapshot, refresh, t }: { snapshot: RuntimeSnapshot; refresh: () => void; t: (key: string, vars?: Record<string, string | number>) => string }) {
  const [ruleForm] = Form.useForm<{ toolName: string; behavior: PermissionRule["behavior"] }>();
  const [capabilityForm] = Form.useForm<CapabilityUpdateInput>();
  const [ruleFilter, setRuleFilter] = useState("all");
  const [editingCapability, setEditingCapability] = useState<RuntimeSnapshot["capabilities"][number] | null>(null);
  const [savingCapability, setSavingCapability] = useState(false);
  const [deletingCapabilityId, setDeletingCapabilityId] = useState("");
  const [messageApi, contextHolder] = message.useMessage();
  const toolOptions = [
    { label: t("All tools"), value: "*" },
    { label: "ReadFile", value: "ReadFile" },
    { label: "WriteFile", value: "WriteFile" },
    { label: "Shell", value: "Shell" },
    { label: "Agent", value: "Agent" },
    ...snapshot.mcpServers.map((server) => ({ label: `mcp.${server.id}.*`, value: `mcp.${server.id}.*` })),
    ...snapshot.mcpTools.map((tool) => ({ label: tool.runtimeToolName, value: tool.runtimeToolName }))
  ];
  const filteredRules = ruleFilter === "all"
    ? snapshot.permissionRules
    : snapshot.permissionRules.filter((rule) => rule.toolName === ruleFilter);
  const addRule = async (values: { toolName: string; behavior: PermissionRule["behavior"] }) => {
    await window.supbot.addPermissionRule({
      toolName: values.toolName || "*",
      behavior: values.behavior || "ask"
    });
    ruleForm.resetFields();
    await refresh();
  };
  const beginEditCapability = (capability: RuntimeSnapshot["capabilities"][number]) => {
    setEditingCapability(capability);
    capabilityForm.setFieldsValue({
      name: capability.name,
      description: capability.description,
      enabled: capability.enabled
    });
  };
  const saveCapability = async (values: CapabilityUpdateInput) => {
    if (!editingCapability) {
      return;
    }
    setSavingCapability(true);
    try {
      await window.supbot.updateCapability(editingCapability.id, values);
      setEditingCapability(null);
      capabilityForm.resetFields();
      await refresh();
      messageApi.success(t("Capability saved."));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSavingCapability(false);
    }
  };
  const deleteCapability = async (id: string) => {
    setDeletingCapabilityId(id);
    try {
      await window.supbot.deleteCapability(id);
      await refresh();
      messageApi.success(t("Capability deleted."));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setDeletingCapabilityId("");
    }
  };
  return (
    <div className="settings-stack">
      {contextHolder}
      <div className="settings-card">
        <div className="panel-heading">
          <div className="section-title"><ToolOutlined /> {t("Permission mode")}</div>
          <Tag>{t(snapshot.permissionMode)}</Tag>
        </div>
        <Segmented
          value={snapshot.permissionMode}
          onChange={async (value) => {
            await window.supbot.setPermissionMode(value as RuntimeSnapshot["permissionMode"]);
            await refresh();
          }}
          options={[
            { label: t("default"), value: "default" },
            { label: t("acceptEdits"), value: "acceptEdits" },
            { label: t("plan"), value: "plan" }
          ]}
        />
        <Divider />
        <div className="permission-rule-builder">
          <Form
            form={ruleForm}
            layout="inline"
            initialValues={{ toolName: "Shell", behavior: "ask" }}
            onFinish={(values) => void addRule(values)}
          >
            <Form.Item name="toolName" rules={[{ required: true }]}>
              <Select className="permission-tool-select" options={toolOptions} />
            </Form.Item>
            <Form.Item name="behavior" rules={[{ required: true }]}>
              <Segmented
                options={[
                  { label: t("allow"), value: "allow" },
                  { label: t("deny"), value: "deny" },
                  { label: t("ask"), value: "ask" }
                ]}
              />
            </Form.Item>
            <Button htmlType="submit" icon={<PlusOutlined />}>{t("Add rule")}</Button>
          </Form>
          <Select
            className="permission-filter-select"
            value={ruleFilter}
            onChange={setRuleFilter}
            options={[{ label: t("All rules"), value: "all" }, ...toolOptions]}
          />
        </div>
        <div className="permission-rule-list">
          {filteredRules.length ? filteredRules.map((rule) => (
            <div className="permission-rule-row" key={rule.id}>
              <div>
                <strong>{rule.toolName}</strong>
                <span className="muted">{t(rule.behavior)} / {formatDateTime(rule.createdAt)}</span>
              </div>
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                onClick={async () => {
                  await window.supbot.removePermissionRule(rule.id);
                  await refresh();
                }}
              />
            </div>
          )) : <span className="muted">{t("No session permission rules")}</span>}
        </div>
      </div>
      <div className="capability-grid">
        {filterVisibleCapabilities(snapshot.capabilities).map((capability) => (
          <div className="capability-card" key={capability.id}>
            <div className="activity-head">
              <div>
                <strong>{t(capability.name)}</strong>
                <div className="muted mono">{capability.id}</div>
              </div>
              <Space wrap>
                <Tag color={capability.enabled ? "green" : "default"}>{t(capability.kind)}</Tag>
              </Space>
            </div>
            <p className="muted">{truncateText(t(capability.description), 50)}</p>
            <div className="capability-card-actions">
              <Button size="small" onClick={() => beginEditCapability(capability)}>{t("Edit")}</Button>
              <Popconfirm title={t("Delete capability?")} onConfirm={() => void deleteCapability(capability.id)}>
                <Button size="small" danger icon={<DeleteOutlined />} loading={deletingCapabilityId === capability.id}>{t("Delete")}</Button>
              </Popconfirm>
            </div>
          </div>
        ))}
      </div>
      <Modal
        open={Boolean(editingCapability)}
        title={t("Edit capability")}
        onCancel={() => {
          setEditingCapability(null);
          capabilityForm.resetFields();
        }}
        onOk={() => capabilityForm.submit()}
        okText={t("Save")}
        confirmLoading={savingCapability}
      >
        {editingCapability ? (
          <div className="capability-modal-meta">
            <div><span>{t("Capability ID")}</span><strong className="mono">{editingCapability.id}</strong></div>
            <div><span>{t("Kind")}</span><strong>{t(editingCapability.kind)}</strong></div>
          </div>
        ) : null}
        <Form form={capabilityForm} layout="vertical" onFinish={(values) => void saveCapability(values)}>
          <Form.Item label={t("Name")} name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t("Description")} name="description">
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item label={t("Enabled")} name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

function SubagentsCard({ snapshot, refresh, openSubagent, t }: { snapshot: RuntimeSnapshot; refresh: () => void; openSubagent: (subagent: SubagentConfig | null) => void; t: (key: string, vars?: Record<string, string | number>) => string }) {
  return (
    <div className="settings-card">
      <div className="panel-heading">
        <div className="section-title"><AppstoreOutlined /> {t("Local subagents")}</div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openSubagent(null)}>{t("New subagent")}</Button>
      </div>
      <List
        dataSource={snapshot.subagents}
        renderItem={(subagent) => (
          <List.Item
            actions={[
              <Button key="edit" onClick={() => openSubagent(subagent)}>{t("Edit")}</Button>,
              <Popconfirm key="delete" title={t("Delete subagent?")} onConfirm={async () => {
                await window.supbot.deleteSubagent(subagent.id);
                await refresh();
              }}>
                <Button danger>{t("Delete")}</Button>
              </Popconfirm>
            ]}
          >
            <List.Item.Meta title={`@${subagent.name}`} description={t(subagent.description)} />
            <Tag color={subagent.enabled ? "cyan" : "default"}>{subagent.enabled ? t("enabled") : t("disabled")}</Tag>
          </List.Item>
        )}
      />
    </div>
  );
}

function ModelModal({ open, config, onCancel, onSave, t }: {
  open: boolean;
  config: RuntimeSnapshot["modelConfig"];
  onCancel: () => void;
  onSave: (values: ModelConfigUpdate) => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [form] = Form.useForm<ModelConfigUpdate>();
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue({ ...config, apiKey: "", clearApiKey: false });
    }
  }, [open, config, form]);
  return (
    <Modal
      open={open}
      title={t("Model configuration")}
      onCancel={onCancel}
      onOk={() => form.submit()}
      okText={t("Save")}
      footer={(_, { OkBtn, CancelBtn }) => (
        <>
          <Button
            loading={testing}
            onClick={async () => {
              setTesting(true);
              try {
                const values = form.getFieldsValue();
                const result = await window.supbot.testModelConfig(values);
                if (result.ok) {
                  message.success(t("Model test succeeded: {message}", { message: result.message }));
                } else {
                  message.warning(t(result.message));
                }
              } finally {
                setTesting(false);
              }
            }}
          >
            {t("Test")}
          </Button>
          <CancelBtn />
          <OkBtn />
        </>
      )}
    >
      <Form form={form} layout="vertical" onFinish={(values) => void onSave(values)}>
        <Form.Item label={t("Provider name")} name="providerName" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item label={t("Base URL")} name="baseUrl" rules={[{ required: true }]}><Input placeholder="https://api.openai.com/v1" /></Form.Item>
        <Form.Item label={t("Model")} name="model" rules={[{ required: true }]}><Input placeholder="gpt-4.1-mini" /></Form.Item>
        <Form.Item label={t("API key")} name="apiKey" extra={config.apiKeySaved ? t("Leave blank to keep the existing key.") : t("Required for real model calls.")}><Input.Password /></Form.Item>
        <Form.Item label={t("Clear saved API key")} name="clearApiKey" valuePropName="checked"><Switch /></Form.Item>
        <Form.Item label={t("Temperature")} name="temperature"><Slider min={0} max={2} step={0.1} /></Form.Item>
        <Form.Item label={t("Max tokens")} name="maxTokens"><InputNumber min={64} max={128000} style={{ width: "100%" }} /></Form.Item>
      </Form>
    </Modal>
  );
}

function SubagentModal({ open, subagent, onCancel, onSave, t }: {
  open: boolean;
  subagent: SubagentConfig | null;
  onCancel: () => void;
  onSave: (subagent: SubagentConfig) => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [form] = Form.useForm<SubagentConfig>();
  useEffect(() => {
    if (open) {
      form.setFieldsValue(subagent || { id: "", name: "", description: "", systemPrompt: "", enabled: true });
    }
  }, [open, subagent, form]);
  return (
    <Modal open={open} title={subagent ? t("Edit subagent") : t("New subagent")} onCancel={onCancel} onOk={() => form.submit()} okText={t("Save")}>
      <Form form={form} layout="vertical" onFinish={(values) => void onSave({ ...values, id: values.id || values.name })}>
        <Form.Item label={t("ID")} name="id"><Input disabled={Boolean(subagent)} /></Form.Item>
        <Form.Item label={t("Name")} name="name" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item label={t("Description")} name="description"><Input /></Form.Item>
        <Form.Item label={t("System prompt")} name="systemPrompt"><Input.TextArea rows={5} /></Form.Item>
        <Form.Item label={t("Enabled")} name="enabled" valuePropName="checked"><Switch /></Form.Item>
      </Form>
    </Modal>
  );
}

function TranscriptModal({
  open,
  result,
  loading,
  onCancel,
  t
}: {
  open: boolean;
  result: TranscriptLoadResult | null;
  loading: boolean;
  onCancel: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <Modal
      open={open}
      title={t("Transcript recovery")}
      onCancel={onCancel}
      footer={<Button onClick={onCancel}>{t("Close")}</Button>}
      width={760}
    >
      {loading ? (
        <div className="transcript-loading">{t("Loading...")}</div>
      ) : result ? (
        <div className="transcript-summary">
          <div className="config-grid">
            <div><span>{t("Source")}</span><strong>{t(result.source)}</strong></div>
            <div><span>{t("Entries")}</span><strong>{result.entries.length}</strong></div>
            <div><span>{t("Active messages")}</span><strong>{result.activeMessages.length}</strong></div>
          </div>
          {result.compactBoundary ? (
            <div className="compact-history-item">
              <div className="activity-head">
                <strong>{t("Latest compact boundary")}</strong>
                <Tag>{formatDateTime(result.compactBoundary.createdAt)}</Tag>
              </div>
              <div className="muted">{result.compactBoundary.originalMessageCount} {t("messages before compact")}</div>
              <pre>{result.compactBoundary.summary.slice(0, 1600)}</pre>
            </div>
          ) : (
            <Alert type="info" showIcon message={t("No compact boundary found for this conversation.")} />
          )}
          {result.diagnostics.length ? (
            <div className="transcript-diagnostics">
              {result.diagnostics.map((diagnostic, index) => (
                <Alert
                  key={`${diagnostic.createdAt}-${index}`}
                  type={diagnostic.level === "error" ? "error" : "warning"}
                  showIcon
                  message={diagnostic.line ? `${diagnostic.message} (${t("line")} ${diagnostic.line})` : diagnostic.message}
                />
              ))}
            </div>
          ) : null}
          <div className="transcript-active-list">
            <div className="section-title"><FileTextOutlined /> {t("Recoverable active context")}</div>
            {result.activeMessages.slice(-8).map((item) => (
              <div className="transcript-message-preview" key={item.id}>
                <Tag>{t(item.role)}</Tag>
                <span>{item.text.slice(0, 220) || t("Empty message")}</span>
              </div>
            ))}
            {!result.activeMessages.length ? <Empty description={t("No recoverable messages")} /> : null}
          </div>
        </div>
      ) : (
        <Empty description={t("No transcript loaded")} />
      )}
    </Modal>
  );
}

function ScheduleModal({ open, onCancel, onSave, t }: {
  open: boolean;
  onCancel: () => void;
  onSave: (input: ScheduledJobInput) => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [form] = Form.useForm<ScheduledJobInput>();
  return (
    <Modal open={open} title={t("New scheduled prompt")} onCancel={onCancel} onOk={() => form.submit()} okText={t("Create")}>
      <Form form={form} layout="vertical" initialValues={{ scheduleKind: "once", enabled: true }} onFinish={(values) => void onSave(values)}>
        <Form.Item label={t("Title")} name="title" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item label={t("Prompt")} name="prompt" rules={[{ required: true }]}><Input.TextArea rows={4} /></Form.Item>
        <Form.Item label={t("Kind")} name="scheduleKind"><Select options={[{ value: "once", label: t("Once") }, { value: "daily", label: t("Daily") }, { value: "cron", label: t("Cron") }]} /></Form.Item>
        <Form.Item label={t("Run at ISO time")} name="runAt"><Input placeholder={new Date(Date.now() + 3600000).toISOString()} /></Form.Item>
        <Form.Item label={t("Cron expression")} name="cronExpr"><Input placeholder="0 9 * * 1-5" /></Form.Item>
        <Form.Item label={t("Enabled")} name="enabled" valuePropName="checked"><Switch /></Form.Item>
      </Form>
    </Modal>
  );
}

function parseArgsText(value?: string): string[] {
  return (value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseEnvText(value?: string): Record<string, string> | undefined {
  const entries = (value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): [string, string] | undefined => {
      const index = line.indexOf("=");
      if (index <= 0) {
        return undefined;
      }
      return [line.slice(0, index).trim(), line.slice(index + 1)];
    })
    .filter((entry): entry is [string, string] => Boolean(entry));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function formatEnvText(env?: Record<string, string>): string {
  return Object.entries(env || {}).map(([key, value]) => `${key}=${value}`).join("\n");
}

function formatMcpDiagnosticSummary(server: McpServerSnapshot, tools: RuntimeSnapshot["mcpTools"]): string {
  return [
    `MCP server: ${server.name} (${server.id})`,
    `State: ${server.status.state}`,
    `Command: ${server.command} ${server.args.join(" ")}`.trim(),
    `PID: ${server.status.pid || "-"}`,
    `Timeout: ${server.requestTimeoutMs || 30000}ms`,
    `Tools: ${tools.length}`,
    `Last connected: ${server.status.lastConnectedAt || "-"}`,
    `Last exit: ${server.status.lastExitReason || "-"}`,
    `Last error: ${server.status.lastError || "-"}`,
    server.status.stderrPreview ? `stderr tail:\n${server.status.stderrPreview}` : undefined
  ].filter(Boolean).join("\n");
}

function formatMcpToolList(server: McpServerSnapshot, tools: RuntimeSnapshot["mcpTools"]): string {
  if (!tools.length) {
    return `MCP server: ${server.name}\nNo tools discovered.`;
  }
  return [
    `MCP server: ${server.name} (${server.id})`,
    ...tools.map((tool) => [
      `- ${tool.runtimeToolName}`,
      `  model: ${tool.modelToolName}`,
      `  params: ${Object.keys(tool.inputSchema.properties || {}).join(", ") || "-"}`,
      `  schema: ${tool.schemaValid ? "valid" : "warning"}`,
      tool.schemaWarnings?.length ? `  warnings: ${tool.schemaWarnings.join("; ")}` : undefined
    ].filter(Boolean).join("\n"))
  ].join("\n");
}

function formatJsonSnippet(value: unknown, limit = 2400): string {
  const text = JSON.stringify(value, null, 2) || "";
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text;
}

function filterVisibleCapabilities(capabilities: RuntimeSnapshot["capabilities"] | undefined): RuntimeSnapshot["capabilities"] {
  return (capabilities || []).filter((capability) => !hiddenSlashCommandCapabilityIds.has(capability.id));
}

function truncateText(value: string, maxLength: number): string {
  const chars = Array.from(value);
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join("")}...` : value;
}

function mcpStatusColor(state: string): string {
  if (state === "connected") {
    return "green";
  }
  if (state === "connecting") {
    return "blue";
  }
  if (state === "error") {
    return "red";
  }
  return "default";
}

function mcpToolSourceLabel(toolName: string): string {
  const match = toolName.match(/^mcp\.([^.]+)\.(.+)$/);
  return match ? `MCP ${match[1]} / ${match[2]}` : "";
}

createRoot(document.getElementById("root")!).render(<App />);
