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
  FileTextOutlined,
  FolderOpenOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  ApiOutlined,
  PaperClipOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SaveOutlined,
  SendOutlined,
  SettingOutlined,
  StopOutlined,
  ThunderboltOutlined,
  ToolOutlined
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Checkbox,
  ConfigProvider,
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
  message
} from "antd";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import type {
  AgentJob,
  Attachment,
  ChatMessage,
  CompactBoundary,
  Conversation,
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
  RemoteBridgeConfig,
  RuntimeEventRecord,
  RuntimeSnapshot,
  ScheduledJobInput,
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

type WorkspaceView = "chat" | "config" | "market";
type DetailPanel = "history" | "tasks" | "memory" | "schedule" | "autopilot" | null;

const theme = {
  token: {
    colorPrimary: "#14b8a6",
    colorBgBase: "#091018",
    colorTextBase: "#eef8f7",
    borderRadius: 8,
    fontFamily: "Aptos, Bahnschrift, Segoe UI, sans-serif"
  },
  components: {
    Button: { borderRadius: 8 },
    Input: { borderRadius: 8 },
    Card: { borderRadius: 8 }
  }
};

function App() {
  const [language, setLanguageState] = useState<Language>(() => loadLanguage());
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [view, setView] = useState<WorkspaceView>("chat");
  const [detailPanel, setDetailPanel] = useState<DetailPanel>("history");
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
    element.scrollTo({ top: element.scrollHeight, behavior });
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
      if (event.type === "error") {
        message.error(event.message);
      }
    });
  }, [refresh]);

  useEffect(() => {
    shouldStickToBottomRef.current = true;
    const frame = window.requestAnimationFrame(() => scrollMessagesToBottom("auto"));
    return () => window.cancelAnimationFrame(frame);
  }, [activeConversationId, scrollMessagesToBottom]);

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
    () => snapshot?.jobs.find((job) => job.status === "queued" || job.status === "running"),
    [snapshot?.jobs]
  );
  const capabilityCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const capability of snapshot?.capabilities || []) {
      counts.set(capability.kind, (counts.get(capability.kind) || 0) + 1);
    }
    return [...counts.entries()];
  }, [snapshot?.capabilities]);

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
      setDetailPanel("history");
      setView("chat");
    } else if (command.action === "tasks") {
      setDetailPanel("tasks");
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
    await window.supbot.approveToolPermission(id);
    await refresh();
  }, [refresh]);

  const denyToolPermission = useCallback(async (id: string) => {
    await window.supbot.denyToolPermission(id);
    await refresh();
  }, [refresh]);

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
          <Typography.Title level={3}>{t("Starting Supbot")}</Typography.Title>
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
              collapsed={leftCollapsed}
              capabilityCounts={capabilityCounts}
              openConfig={openConfig}
              t={t}
              insertToolTemplate={(template) => setPrompt(template)}
              insertSubagent={(subagent) => setPrompt((value) => `${value}${value ? " " : ""}@${subagent.name} `)}
            />
            <ChatPanel
              conversation={activeConversation}
              prompt={prompt}
              setPrompt={setPrompt}
              attachments={attachments}
              setAttachments={setAttachments}
              sending={sending}
              runningJob={runningJob}
              send={send}
              stopRunning={stopRunning}
              pickAttachments={pickAttachments}
              copyLatest={copyLatest}
              compactConversation={compactActiveConversation}
              loadTranscript={loadActiveTranscript}
              scrollRef={scrollRef}
              onMessageScroll={updateMessageStickiness}
              t={t}
              slashCommands={slashCommandList}
            />
            <RightPanel
              snapshot={snapshot}
              activeConversationId={activeConversation?.id || ""}
              setActiveConversationId={setActiveConversationId}
              panel={detailPanel}
              setPanel={setDetailPanel}
              collapsed={rightCollapsed}
              refresh={refresh}
              t={t}
              cancelJob={async (id) => {
                await window.supbot.cancelJob(id);
                await refresh();
              }}
              approveToolPermission={approveToolPermission}
              denyToolPermission={denyToolPermission}
              openSchedule={() => setScheduleOpen(true)}
            />
          </section>
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
          { label: translate(language, "Config"), value: "config" },
          { label: translate(language, "Tool Market"), value: "market" }
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
  collapsed,
  capabilityCounts,
  openConfig,
  t,
  insertToolTemplate,
  insertSubagent
}: {
  snapshot: RuntimeSnapshot;
  collapsed: boolean;
  capabilityCounts: Array<[string, number]>;
  openConfig: (tab: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  insertToolTemplate: (template: string) => void;
  insertSubagent: (subagent: SubagentConfig) => void;
}) {
  return (
    <aside className={`side-panel ${collapsed ? "is-collapsed" : ""}`}>
      <div className="panel-scroll">
        <section className="panel-section">
          <div className="panel-heading">
            <div className="section-title"><ToolOutlined /> {t("Capabilities")}</div>
            <Button size="small" onClick={() => openConfig("capabilities")}>{t("Config")}</Button>
          </div>
          <div className="tag-row">
            {capabilityCounts.map(([kind, count]) => <Tag key={kind}>{t(kind)}: {count}</Tag>)}
          </div>
          <div className="service-list">
            <button className="service-item service-button" type="button" onClick={() => insertToolTemplate("/read ")}>
              <div>
                <div className="service-name">{t("Read local file")}</div>
                <div className="muted mono">/read D:\path\file.txt</div>
              </div>
              <Tag>{t("tool")}</Tag>
            </button>
            <button className="service-item service-button" type="button" onClick={() => insertToolTemplate("/write note.txt\n")}>
              <div>
                <div className="service-name">{t("Write generated file")}</div>
                <div className="muted mono">/write note.txt</div>
              </div>
              <Tag>{t("tool")}</Tag>
            </button>
            <button className="service-item service-button" type="button" onClick={() => insertToolTemplate("/shell ")}>
              <div>
                <div className="service-name">{t("Run shell command")}</div>
                <div className="muted mono">/shell npm test</div>
              </div>
              <Tag color="gold">{t("local")}</Tag>
            </button>
            {snapshot.capabilities.slice(0, 6).map((capability) => (
              <div className="service-item" key={capability.id}>
                <div>
                  <div className="service-name">{t(capability.name)}</div>
                  <div className="muted">{t(capability.description)}</div>
                </div>
                <Tag color={capability.enabled ? "green" : "default"}>{t(capability.kind)}</Tag>
              </div>
            ))}
          </div>
        </section>
        <section className="panel-section">
          <div className="panel-heading">
            <div className="section-title"><ThunderboltOutlined /> {t("Subagents")}</div>
            <Button size="small" onClick={() => openConfig("subagents")}>{t("Edit")}</Button>
          </div>
          <div className="service-list">
            {snapshot.subagents.map((subagent) => (
              <button className="service-item service-button" key={subagent.id} type="button" onClick={() => insertSubagent(subagent)}>
                <div>
                  <div className="service-name">@{subagent.name}</div>
                  <div className="muted">{t(subagent.description)}</div>
                </div>
                <Tag color={subagent.enabled ? "cyan" : "default"}>{subagent.enabled ? t("on") : t("off")}</Tag>
              </button>
            ))}
          </div>
        </section>
      </div>
    </aside>
  );
}

function ChatPanel({
  conversation,
  prompt,
  setPrompt,
  attachments,
  setAttachments,
  sending,
  runningJob,
  send,
  stopRunning,
  pickAttachments,
  copyLatest,
  compactConversation,
  loadTranscript,
  scrollRef,
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
  send: () => void;
  stopRunning: () => void;
  pickAttachments: () => void;
  copyLatest: () => void;
  compactConversation: () => void;
  loadTranscript: () => void;
  scrollRef: React.RefObject<HTMLDivElement>;
  onMessageScroll: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  slashCommands: ReturnType<typeof buildSlashCommands>;
}) {
  const filteredCommands = useMemo(() => {
    if (!prompt.startsWith("/")) {
      return [];
    }
    const query = prompt.trim().toLowerCase();
    return slashCommands.filter((item) => item.command.startsWith(query));
  }, [prompt, slashCommands]);

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
      <div className="message-stream" ref={scrollRef} onScroll={onMessageScroll}>
        {!conversation || conversation.messages.length === 0 ? (
          <div className="chat-empty">
            <div className="brand-mark"><RobotOutlined /></div>
            <Typography.Title level={3}>{t("Supbot is ready")}</Typography.Title>
            <p className="muted">{t("Ask a question, attach local files, use /commands, or mention @research and @builder.")}</p>
          </div>
        ) : conversation.messages.map((item) => <MessageBubble key={item.id} message={item} t={t} />)}
      </div>
      <div className="composer">
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
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
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
              placeholder={t("Message Supbot, use /config, or mention @research...")}
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

function MessageBubble({ message: item, t }: { message: ChatMessage; t: (key: string, vars?: Record<string, string | number>) => string }) {
  return (
    <div className={`message-row ${item.role}`}>
      <div className="message-bubble">
        <div className="message-meta">
          <span>{item.role === "user" ? t("You") : item.role === "assistant" ? "Supbot" : item.role === "tool" ? t("Tool") : t("System")}</span>
          <span>{formatDateTime(item.createdAt)}</span>
          {item.status ? <Tag color={statusColor(item.status)}>{statusLabel(item.status, t)}</Tag> : null}
        </div>
        <MessageBlocks message={item} t={t} />
        {item.attachments?.length ? (
          <div className="attachment-row">
            {item.attachments.map((attachment) => <Tag key={attachment.id}><PaperClipOutlined /> {attachment.name}</Tag>)}
          </div>
        ) : null}
        {item.generatedFiles?.length ? (
          <div className="generated-files">
            {item.generatedFiles.map((file) => (
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

function RightPanel({
  snapshot,
  activeConversationId,
  setActiveConversationId,
  panel,
  setPanel,
  collapsed,
  refresh,
  t,
  cancelJob,
  approveToolPermission,
  denyToolPermission,
  openSchedule
}: {
  snapshot: RuntimeSnapshot;
  activeConversationId: string;
  setActiveConversationId: (id: string) => void;
  panel: DetailPanel;
  setPanel: (panel: DetailPanel) => void;
  collapsed: boolean;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  cancelJob: (id: string) => Promise<void>;
  approveToolPermission: (id: string) => Promise<void>;
  denyToolPermission: (id: string) => Promise<void>;
  openSchedule: () => void;
}) {
  return (
    <aside className={`activity-panel ${collapsed ? "is-collapsed" : ""}`}>
      <Tabs
        activeKey={panel || "history"}
        onChange={(key) => setPanel(key as DetailPanel)}
        items={[
          { key: "history", label: t("History"), children: <HistoryPanel conversations={snapshot.conversations} activeConversationId={activeConversationId} setActiveConversationId={setActiveConversationId} refresh={refresh} t={t} /> },
          { key: "tasks", label: t("Tasks"), children: <TasksPanel snapshot={snapshot} cancelJob={cancelJob} approveToolPermission={approveToolPermission} denyToolPermission={denyToolPermission} t={t} /> },
          { key: "memory", label: t("Memory"), children: <MemoryPanel snapshot={snapshot} activeConversationId={activeConversationId} refresh={refresh} t={t} /> },
          { key: "schedule", label: t("Schedule"), children: <SchedulePanel snapshot={snapshot} openSchedule={openSchedule} refresh={refresh} t={t} /> },
          { key: "autopilot", label: t("Autopilot"), children: <AutopilotPanel t={t} /> }
        ]}
      />
    </aside>
  );
}

function HistoryPanel({ conversations, activeConversationId, setActiveConversationId, refresh, t }: {
  conversations: Conversation[];
  activeConversationId: string;
  setActiveConversationId: (id: string) => void;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className="activity-list">
      {conversations.map((conversation) => (
        <div className={`activity-item ${conversation.id === activeConversationId ? "is-active" : ""}`} key={conversation.id}>
          <button type="button" onClick={() => setActiveConversationId(conversation.id)}>
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
      {jobs.map((job) => (
        <div className="activity-item stacked" key={job.id}>
          <div className="activity-head">
            <strong>{job.prompt.slice(0, 70)}</strong>
            <Tag color={statusColor(job.status)}>{statusLabel(job.status, t)}</Tag>
          </div>
          <div className="muted">{formatDateTime(job.createdAt)}</div>
          {job.workspaceMode ? (
            <div className="tag-row">
              <Tag color={job.workspaceMode === "isolated" ? "cyan" : job.workspaceMode === "readOnly" ? "purple" : "default"}>{t(job.workspaceMode)}</Tag>
              {job.diffStatus ? <Tag>{t(job.diffStatus)}</Tag> : null}
            </div>
          ) : null}
          <div className="job-progress">
            {job.progress.slice(-3).map((item, index) => <span key={`${job.id}-${index}`}>{t(item)}</span>)}
          </div>
          {job.status === "queued" || job.status === "running" ? (
            <Button size="small" danger icon={<StopOutlined />} onClick={() => void cancelJob(job.id)}>{t("Cancel")}</Button>
          ) : null}
        </div>
      ))}
      {!jobs.length ? <Empty description={t("No jobs yet")} /> : null}
    </div>
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
  const [messageApi, contextHolder] = message.useMessage();
  const config = snapshot.remoteBridge.config;
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
        {config.pairingCode ? <Tag color="blue">{config.pairingCode}</Tag> : null}
      </div>
      <small>{t("Remote bridge is read-only for tools, permissions, and worktree apply/discard.")}</small>
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
          <Input.TextArea rows={3} placeholder={t("What should Supbot remember?")} />
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

function AutopilotPanel({ t }: { t: (key: string, vars?: Record<string, string | number>) => string }) {
  return (
    <div className="autopilot-card">
      <ThunderboltOutlined />
      <Typography.Title level={4}>{t("Autopilot surface")}</Typography.Title>
      <p className="muted">{t("The local runtime has the job/event model ready. Continuous autonomous driving is intentionally left off in the first local MVP.")}</p>
      <Alert type="info" showIcon message={t("Use scheduled prompts and subagents for the first version's automation loop.")} />
    </div>
  );
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
          <Typography.Title level={3}>{t("Supbot Settings")}</Typography.Title>
          <div className="muted">{t("Model, personality, local capabilities, and subagents live on this machine.")}</div>
        </div>
        <Button icon={<ReloadOutlined />} onClick={refresh}>{t("Refresh")}</Button>
      </div>
      <Tabs
        activeKey={focusTab}
        onChange={setFocusTab}
        items={[
          { key: "model", label: t("Model"), children: <ModelConfigCard snapshot={snapshot} openModel={openModel} t={t} /> },
          { key: "market", label: t("Tool Market"), children: <ToolMarketConfigCard snapshot={snapshot} refresh={refresh} t={t} /> },
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
      <Form form={form} layout="vertical" initialValues={{ source: "hybrid", apiUrl: "http://localhost:3000/subscriber/market/api", accountEmail: "subscriber@example.com" }} onFinish={(values) => void save(values as ToolMarketConfigUpdate)}>
        <Form.Item label={t("Source")} name="source">
          <Segmented
            options={[
              { label: t("Local catalog"), value: "local" },
              { label: t("Remote API"), value: "remote" },
              { label: t("Hybrid"), value: "hybrid" }
            ]}
          />
        </Form.Item>
        <Form.Item label={t("Market API URL")} name="apiUrl" tooltip={t("Compatible with the servstation subscriber market API returning { items: [...] }.")}>
          <Input placeholder="http://localhost:3000/subscriber/market/api" />
        </Form.Item>
        <Form.Item label={t("Market account email")} name="accountEmail">
          <Input placeholder="subscriber@example.com" />
        </Form.Item>
        <Form.Item label={t("Market password")} name="password" extra={config.passwordSaved ? t("Leave blank to keep the existing password.") : t("Optional when the market allows anonymous catalog access.")}>
          <Input.Password autoComplete="new-password" placeholder="market123" />
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
            <div className="muted">{t("Connect local stdio MCP servers. Tools are registered through Supbot permissions.")}</div>
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
  const [ruleFilter, setRuleFilter] = useState("all");
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
  return (
    <div className="settings-stack">
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
            { label: t("plan"), value: "plan" },
            { label: t("bypassPermissions"), value: "bypassPermissions" }
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
        {snapshot.capabilities.map((capability) => (
          <div className="capability-card" key={capability.id}>
            <div className="activity-head">
              <strong>{t(capability.name)}</strong>
              <Tag color={capability.enabled ? "green" : "default"}>{t(capability.kind)}</Tag>
            </div>
            <p className="muted">{t(capability.description)}</p>
          </div>
        ))}
      </div>
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
      form.setFieldsValue({ ...config, apiKey: "" });
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
