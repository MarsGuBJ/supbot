import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ApiOutlined,
  CalendarOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  DownOutlined,
  DownloadOutlined,
  EditOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  MailOutlined,
  MessageOutlined,
  OrderedListOutlined,
  PaperClipOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  RobotOutlined,
  SaveOutlined,
  SearchOutlined,
  SendOutlined,
  StopOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Badge,
  Button,
  ConfigProvider,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Popover,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import type { TextAreaRef } from "antd/es/input/TextArea";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import type {
  Attachment,
  ChatMessage,
  HBClientUpdateState,
  Project,
  RuntimeSnapshot,
  ScheduledJobInput,
  ServstationClientSnapshot,
  ServstationConversation,
  ServstationJobFileContent,
  ServstationLocalCapabilityAsset,
  ServstationProject,
  ServstationProjectResource,
  ServstationScheduledJob,
  ServstationServiceDefinition,
  ServstationSessionJob,
  SubagentConfig,
  TranscriptLoadResult,
} from "@supbot/shared";
import { buildSlashCommands, formatDateTime, latestAssistantMessage, resolveSlashCommand } from "@supbot/shared";
import { loadLanguage, saveLanguage, translate, type Language } from "./i18n";
import { mergeServstationAutopilotEvent, servstationAutopilotIsActive } from "./servstationAutopilot";
import {
  buildEffectiveServstationServices,
  buildVisibleServstationCapabilities,
  filterVisibleServstationCapabilities,
  formatServstationCapabilityPromptDirective,
  type ServstationVisibleCapability,
} from "./servstationCapabilities";
import {
  groupServstationConversations,
  servstationJobsForConversation,
  servstationMessagesForConversation,
  servstationPromptTarget,
  type ServstationConversationGroup,
} from "./servstationProjects";
import "./styles.css";
import { ChatPanel } from "./components/ChatPanel";
import { LeftPanel } from "./components/LeftPanel";
import { RightPanel } from "./components/RightPanel";
import { Topbar } from "./components/Topbar";
import { readClipboardText, selectedTextWithin, selectionMemoryTitle, writeClipboardText } from "./lib/clipboard";
import { formatFileSize } from "./lib/flowSchema";
import {
  servstationConversationTitle,
  servstationJobIsTerminal,
  servstationMessagesFromTranscript,
  servstationStatusColor,
  type ServstationChatMessage,
  type ServstationGeneratedFile,
} from "./lib/servstationFormat";
import {
  applyCompactBoundary,
  applyJobEvent,
  applyMemoryCandidate,
  applyMessageDelta,
  applyMessageEvent,
  applyPendingPermission,
  applyRuntimeEvent,
  applyToolProgress,
  clearPendingPermission,
} from "./lib/snapshotApply";
import type { DetailPanel, PromptContextMenu, SelectionContextMenu, Translator, WorkspaceView } from "./lib/types";
import { connectServstationAgent } from "./servstationConnection";
import { ConfigWorkspace } from "./views/ConfigWorkspace";
import { MarketWorkspace } from "./views/MarketWorkspace";
import { ServerAgentFlowWorkspace, ServerAgentFlows } from "./views/ServerAgentFlows";
import { ServerAgentMailWorkspace } from "./views/ServerAgentMailWorkspace";
import { RemoteScheduleModal } from "./views/ServerAgentWorkspace";

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
    fontFamily: "Aptos, Bahnschrift, Segoe UI, sans-serif",
  },
  components: {
    Button: { borderRadius: 8, primaryShadow: "0 8px 22px rgba(212, 117, 10, 0.16)" },
    Input: { borderRadius: 8, activeBorderColor: "#D4750A", hoverBorderColor: "#FFD6A8" },
    Select: { optionSelectedBg: "#FFEFE0" },
    Segmented: { itemSelectedBg: "#FFEFE0", itemSelectedColor: "#B8650A" },
    Tag: { borderRadiusSM: 6 },
    Card: { borderRadius: 8 },
  },
};

function mergeRuntimeSnapshot(
  current: RuntimeSnapshot | null,
  next: RuntimeSnapshot,
  activeConversationId: string,
): RuntimeSnapshot {
  if (!current) {
    return next;
  }
  const activeId = activeConversationId || next.activeConversationId || next.conversations[0]?.id || "";
  return {
    ...next,
    activeConversationId: activeId || undefined,
    conversations: next.conversations.map((conversation) => {
      if (conversation.id !== activeId) {
        return { ...conversation, messages: [] };
      }
      const previous = current.conversations.find((item) => item.id === conversation.id);
      if (!previous?.messages.length) {
        return conversation;
      }
      const messages = mergeMessages(previous.messages, conversation.messages);
      return {
        ...conversation,
        messages,
        messageCount: Math.max(conversation.messageCount || 0, previous.messageCount || 0, messages.length),
      };
    }),
  };
}

function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const incomingById = new Map(incoming.map((message) => [message.id, message]));
  const existingIds = new Set(existing.map((message) => message.id));
  return [
    ...existing.map((message) => incomingById.get(message.id) || message),
    ...incoming.filter((message) => !existingIds.has(message.id)),
  ];
}

function App() {
  const [language, setLanguageState] = useState<Language>(() => loadLanguage());
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [view, setView] = useState<WorkspaceView>("chat");
  const [detailPanel, setDetailPanel] = useState<DetailPanel>("memory");
  const [activeConversationId, setActiveConversationId] = useState("");
  const [activeProjectId, setActiveProjectId] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [subagentOpen, setSubagentOpen] = useState(false);
  const [editingSubagent, setEditingSubagent] = useState<SubagentConfig | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [transcriptResult, setTranscriptResult] = useState<TranscriptLoadResult | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [focusConfigTab, setFocusConfigTab] = useState("model");
  const [userDataPath, setUserDataPath] = useState("");
  const [updateState, setUpdateState] = useState<HBClientUpdateState>({ status: "idle", currentVersion: "" });
  const [messageApi, contextHolder] = message.useMessage();
  const [modalApi, modalContextHolder] = Modal.useModal();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeConversationIdRef = useRef("");
  const shouldStickToBottomRef = useRef(true);
  const promptedUpdateRef = useRef("");
  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(language, key, vars),
    [language],
  );
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

  const applySnapshot = useCallback((next: RuntimeSnapshot) => {
    const selectedId = activeConversationIdRef.current || next.activeConversationId || next.conversations[0]?.id || "";
    activeConversationIdRef.current = selectedId;
    setSnapshot((current) => mergeRuntimeSnapshot(current, next, selectedId));
    setActiveConversationId(selectedId);
  }, []);

  const refresh = useCallback(async () => {
    applySnapshot(await window.supbot.snapshot(activeConversationIdRef.current || undefined));
  }, [applySnapshot]);

  const startHBClientUpdate = useCallback(async () => {
    try {
      if (updateState.status === "downloaded") {
        setUpdateState(await window.supbot.installHBClientUpdate());
        return;
      }
      const downloaded = await window.supbot.downloadHBClientUpdate();
      setUpdateState(downloaded);
      if (downloaded.status === "downloaded") {
        setUpdateState(await window.supbot.installHBClientUpdate());
      }
    } catch (error) {
      messageApi.error((error as Error).message);
    }
  }, [messageApi, updateState.status]);

  const showHBClientVersion = useCallback(async () => {
    let currentVersion = updateState.currentVersion;
    if (!currentVersion) {
      try {
        const state = await window.supbot.getHBClientUpdateState();
        if (state) {
          currentVersion = state.currentVersion;
          setUpdateState(state);
        }
      } catch {
        // The dialog still provides useful product information if version lookup fails.
      }
    }
    const chinese = language === "zh";
    modalApi.info({
      title: chinese ? "关于 HBClient" : "About HBClient",
      content: (
        <div className="version-info">
          <div className="version-info-product">HBClient</div>
          <div className="version-info-number">
            <span>{chinese ? "版本号" : "Version"}</span>
            <strong>{currentVersion ? `v${currentVersion}` : chinese ? "未知" : "Unknown"}</strong>
          </div>
        </div>
      ),
      okText: chinese ? "关闭" : "Close",
      icon: <RobotOutlined />,
    });
  }, [language, modalApi, updateState.currentVersion]);

  useEffect(() => {
    void refresh();
    void window.supbot.userDataPath().then(setUserDataPath);
    return window.supbot.onEvent((event) => {
      if (event.type === "snapshot") {
        applySnapshot(event.snapshot);
      }
      if (event.type === "message_delta") {
        setSnapshot((current) =>
          current ? applyMessageDelta(current, event.conversationId, event.messageId, event.delta) : current,
        );
      }
      if (event.type === "message") {
        setSnapshot((current) => (current ? applyMessageEvent(current, event.conversationId, event.message) : current));
      }
      if (event.type === "job") {
        setSnapshot((current) => (current ? applyJobEvent(current, event.job) : current));
      }
      if (event.type === "tool_progress") {
        setSnapshot((current) => (current ? applyToolProgress(current, event.toolCall) : current));
      }
      if (event.type === "tool_permission") {
        setSnapshot((current) => (current ? applyPendingPermission(current, event.permission) : current));
      }
      if (event.type === "permission_timeout") {
        setSnapshot((current) => (current ? clearPendingPermission(current, event.permission) : current));
      }
      if (event.type === "compact") {
        setSnapshot((current) => (current ? applyCompactBoundary(current, event.boundary) : current));
      }
      if (event.type === "memory_changed") {
        setSnapshot((current) => (current ? { ...current, memory: event.memory } : current));
      }
      if (event.type === "memory_candidate") {
        setSnapshot((current) => (current ? applyMemoryCandidate(current, event.candidate) : current));
      }
      if (event.type === "query_event" || event.type === "subagent_event") {
        setSnapshot((current) => (current ? applyRuntimeEvent(current, event.event) : current));
      }
      if (event.type === "servstation_a2a") {
        setSnapshot((current) =>
          current
            ? {
                ...applyRuntimeEvent(current, event.event!),
                servstationA2A: { config: event.config },
              }
            : current,
        );
      }
      if (event.type === "error") {
        message.error(event.message);
      }
    });
  }, [applySnapshot, refresh]);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
    setHistoryLoading(false);
    if (!activeConversationId || snapshot?.activeConversationId === activeConversationId) {
      return;
    }
    let canceled = false;
    void window.supbot.snapshot(activeConversationId).then((next) => {
      if (!canceled) {
        applySnapshot(next);
      }
    });
    return () => {
      canceled = true;
    };
  }, [activeConversationId, applySnapshot, snapshot?.activeConversationId]);

  useEffect(() => {
    let mounted = true;
    void window.supbot.getHBClientUpdateState().then((state) => {
      if (mounted && state) {
        setUpdateState(state);
      }
    });
    const unsubscribe = window.supbot.onHBClientUpdate((state) => setUpdateState(state));
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (updateState.status !== "available") {
      return;
    }
    const promptKey = `${updateState.status}:${updateState.availableVersion || "unknown"}`;
    if (promptedUpdateRef.current === promptKey) {
      return;
    }
    promptedUpdateRef.current = promptKey;
    const chinese = language === "zh";
    const version = updateState.availableVersion ? ` v${updateState.availableVersion}` : "";
    const currentVersion = updateState.currentVersion ? ` v${updateState.currentVersion}` : "";
    modalApi.confirm({
      title: chinese ? `发现 HBClient 新版本${version}` : `HBClient update${version} is available`,
      content: chinese
        ? `当前版本${currentVersion || "未知"}。是否立即升级？`
        : `Current version${currentVersion || " unknown"}. Upgrade now?`,
      okText: chinese ? "立即升级" : "Upgrade now",
      cancelText: chinese ? "稍后" : "Later",
      icon: <DownloadOutlined />,
      onOk: () => startHBClientUpdate(),
    });
  }, [
    language,
    modalApi,
    startHBClientUpdate,
    updateState.availableVersion,
    updateState.currentVersion,
    updateState.status,
  ]);

  useEffect(() => {
    if (view !== "chat") {
      return;
    }
    shouldStickToBottomRef.current = true;
    const frame = window.requestAnimationFrame(() => scrollMessagesToBottom("auto"));
    return () => window.cancelAnimationFrame(frame);
  }, [activeConversationId, scrollMessagesToBottom, view]);

  useEffect(() => {
    if (!shouldStickToBottomRef.current) {
      return;
    }
    const frame = window.requestAnimationFrame(() => scrollMessagesToBottom("smooth"));
    return () => window.cancelAnimationFrame(frame);
  }, [snapshot?.conversations, scrollMessagesToBottom]);

  const activeConversation = useMemo(
    () => snapshot?.conversations.find((item) => item.id === activeConversationId) || snapshot?.conversations[0],
    [snapshot?.conversations, activeConversationId],
  );
  const hasOlderMessages = Boolean(
    activeConversation && activeConversation.messages.length < (activeConversation.messageCount || 0),
  );
  const loadOlderMessages = useCallback(async () => {
    if (!activeConversation || historyLoading || !hasOlderMessages) {
      return;
    }
    setHistoryLoading(true);
    try {
      const page = await window.supbot.loadConversationHistory(
        activeConversation.id,
        activeConversation.messages[0]?.id,
        50,
      );
      setSnapshot((current) => {
        if (!current) {
          return current;
        }
        return {
          ...current,
          conversations: current.conversations.map((conversation) => {
            if (conversation.id !== page.conversationId) {
              return conversation;
            }
            const messages = mergeMessages(page.messages, conversation.messages);
            return { ...conversation, messages, messageCount: Math.max(page.total, messages.length) };
          }),
        };
      });
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setHistoryLoading(false);
    }
  }, [activeConversation, hasOlderMessages, historyLoading, messageApi]);
  useEffect(() => {
    if (activeConversation) {
      setActiveProjectId(activeConversation.projectId || "");
    }
  }, [activeConversation?.id, activeConversation?.projectId]);
  const runningJob = useMemo(() => {
    const conversationId = activeConversation?.id || activeConversationId;
    if (!conversationId) {
      return undefined;
    }
    return snapshot?.jobs.find(
      (job) => job.conversationId === conversationId && (job.status === "queued" || job.status === "running"),
    );
  }, [activeConversation?.id, activeConversationId, snapshot?.jobs]);
  const startNewConversation = async (projectId?: string | null) => {
    const targetProjectId = projectId === undefined ? activeProjectId || undefined : projectId || undefined;
    const conversation = await window.supbot.createConversation({ projectId: targetProjectId });
    setActiveConversationId(conversation.id);
    setActiveProjectId(conversation.projectId || "");
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
    if (command.action === "new" || command.action === "clear") {
      await startNewConversation();
    } else if (command.action === "history") {
      setLeftCollapsed(false);
      setView("chat");
    } else if (command.action === "config") {
      openConfig("model");
    } else if (command.action === "model") {
      openConfig("model");
    } else if (command.action === "copy") {
      await copyLatest();
    }
    return true;
  };

  const send = async (text: string): Promise<boolean> => {
    if (!text || sending) {
      return false;
    }
    if (text.startsWith("/") && (await runSlashAction(text))) {
      return true;
    }
    setSending(true);
    setAttachments([]);
    try {
      const result = await window.supbot.sendPrompt({
        conversationId: activeConversation?.id,
        projectId: activeProjectId || undefined,
        prompt: text,
        attachments,
      });
      setActiveConversationId(result.conversation.id);
      await refresh();
      return true;
    } catch (error) {
      messageApi.error((error as Error).message);
      return false;
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

  const approveToolPermission = useCallback(
    async (id: string) => {
      try {
        await window.supbot.approveToolPermission(id);
        await refresh();
      } catch (error) {
        messageApi.error((error as Error).message);
      }
    },
    [messageApi, refresh],
  );

  const denyToolPermission = useCallback(
    async (id: string) => {
      try {
        await window.supbot.denyToolPermission(id);
        await refresh();
      } catch (error) {
        messageApi.error((error as Error).message);
      }
    },
    [messageApi, refresh],
  );

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

  const copySelectedText = useCallback(
    async (text: string) => {
      try {
        await writeClipboardText(text);
        messageApi.success(t("已复制选中文本。"));
      } catch (error) {
        messageApi.error((error as Error).message);
      }
    },
    [messageApi, t],
  );

  const addSelectedTextToMemory = useCallback(
    async (text: string) => {
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
          kind: "fact",
        });
        messageApi.success(t("Memory saved."));
        await refresh();
      } catch (error) {
        messageApi.error((error as Error).message);
      }
    },
    [messageApi, refresh, t],
  );

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

  if (!snapshot) {
    return (
      <ConfigProvider theme={theme}>
        {contextHolder}
        {modalContextHolder}
        <div className="boot-screen">
          <div className="brand-mark">
            <RobotOutlined />
          </div>
          <Typography.Title level={3}>{t("Starting HBClient")}</Typography.Title>
        </div>
      </ConfigProvider>
    );
  }

  return (
    <ConfigProvider theme={theme} locale={language === "zh" ? zhCN : enUS}>
      {contextHolder}
      {modalContextHolder}
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
          updateState={updateState}
          startUpdate={startHBClientUpdate}
          showVersionInfo={showHBClientVersion}
        />
        {view === "chat" ? (
          <section
            className={`workspace-grid ${leftCollapsed ? "left-collapsed" : ""} ${rightCollapsed ? "right-collapsed" : ""}`}
          >
            <LeftPanel
              snapshot={snapshot}
              activeConversationId={activeConversation?.id || ""}
              setActiveConversationId={setActiveConversationId}
              activeProjectId={activeProjectId}
              setActiveProjectId={setActiveProjectId}
              collapsed={leftCollapsed}
              refresh={refresh}
              startNewConversation={startNewConversation}
              t={t}
            />
            <ChatPanel
              conversation={activeConversation}
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
              loadOlderMessages={loadOlderMessages}
              hasOlderMessages={hasOlderMessages}
              historyLoading={historyLoading}
              scrollRef={scrollRef}
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
            copySelectedText={copySelectedText}
            t={t}
          />
        ) : view === "config" ? (
          <ConfigWorkspace
            snapshot={snapshot}
            userDataPath={userDataPath}
            focusTab={focusConfigTab}
            setFocusTab={setFocusConfigTab}
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
        projects={snapshot.projects}
        defaultProjectId={activeProjectId || undefined}
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

function ServerAgentWorkspace({
  snapshot,
  refreshRuntime,
  copySelectedText,
  t,
}: {
  snapshot: RuntimeSnapshot;
  refreshRuntime: () => Promise<void>;
  copySelectedText: (text: string) => Promise<void>;
  t: Translator;
}) {
  const [remote, setRemote] = useState<ServstationClientSnapshot | null>(null);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [draftConversation, setDraftConversation] = useState(false);
  const [draftProjectId, setDraftProjectId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [projectResourcesOpen, setProjectResourcesOpen] = useState(false);
  const [projectResourcesLoading, setProjectResourcesLoading] = useState(false);
  const [selectedProject, setSelectedProject] = useState<ServstationProject | null>(null);
  const [projectResources, setProjectResources] = useState<ServstationProjectResource[]>([]);
  const [autopilotPrompt, setAutopilotPrompt] = useState("");
  const [flowPendingCount, setFlowPendingCount] = useState(0);
  const remoteRequestRef = useRef(0);
  const selectedConversationRef = useRef("");
  const [messageApi, contextHolder] = message.useMessage();
  const reverseStatus = snapshot.servstationA2A.config.reverse?.status || "disconnected";
  const connected = reverseStatus === "connected";
  const activeConversation = draftConversation
    ? undefined
    : remote?.conversations.find((item) => item.id === activeConversationId) || remote?.conversations[0];
  const activeProjectId = draftConversation ? draftProjectId : activeConversation?.projectId || "";
  const activeProject = remote?.projects.find((project) => project.id === activeProjectId);
  const activeConversationJobs = useMemo(
    () => (draftConversation ? [] : servstationJobsForConversation(remote?.jobs || [], activeConversation?.id)),
    [activeConversation?.id, draftConversation, remote?.jobs],
  );
  const activeConversationMessages = useMemo(
    () =>
      draftConversation ? [] : servstationMessagesForConversation(remote?.conversations || [], activeConversation?.id),
    [activeConversation?.id, draftConversation, remote?.conversations],
  );
  const messages = useMemo(
    () => servstationMessagesFromTranscript(activeConversationMessages, activeConversationJobs),
    [activeConversationJobs, activeConversationMessages],
  );
  const runningJob = useMemo(
    () => [...activeConversationJobs].reverse().find((job) => !servstationJobIsTerminal(job)),
    [activeConversationJobs],
  );
  const autopilotRunId = remote?.autopilotRun?.id || "";
  const autopilotActive = servstationAutopilotIsActive(remote?.autopilotRun);
  const hasRunningJob = Boolean(runningJob);

  const loadRemote = useCallback(
    async (conversationId?: string, silent = false, preserveDraft = false) => {
      const requestedConversationId = conversationId || "";
      if (requestedConversationId !== selectedConversationRef.current) {
        return;
      }
      const requestId = ++remoteRequestRef.current;
      if (!silent) {
        setLoading(true);
      }
      try {
        const next = await window.supbot.getServstationClientSnapshot({ conversationId });
        if (requestId !== remoteRequestRef.current || requestedConversationId !== selectedConversationRef.current) {
          return;
        }
        setRemote(next);
        if (!preserveDraft) {
          const selected = next.activeConversationId || next.conversations[0]?.id || "";
          selectedConversationRef.current = selected;
          setActiveConversationId(selected);
          setDraftConversation(false);
          setDraftProjectId("");
        }
      } catch (error) {
        if (requestId === remoteRequestRef.current) {
          messageApi.error((error as Error).message);
        }
      } finally {
        if (!silent && requestId === remoteRequestRef.current) {
          setLoading(false);
        }
      }
    },
    [messageApi],
  );

  useEffect(() => {
    void loadRemote(activeConversationId || undefined);
  }, [loadRemote, reverseStatus]);

  useEffect(() => {
    if (!remote?.connected || draftConversation) {
      return;
    }
    const intervalMs = hasRunningJob || autopilotActive ? 2_000 : 15_000;
    const timer = window.setInterval(() => {
      void loadRemote(activeConversationId || undefined, true);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [activeConversationId, autopilotActive, draftConversation, hasRunningJob, loadRemote, remote?.connected]);

  useEffect(() => {
    if (!remote?.connected || !autopilotRunId || !autopilotActive || draftConversation) {
      return;
    }
    let refreshTimer: number | undefined;
    const unsubscribe = window.supbot.onServstationAutopilotEvent(autopilotRunId, (event) => {
      setRemote((current) =>
        current?.autopilotRun?.id === autopilotRunId
          ? { ...current, autopilotEvents: mergeServstationAutopilotEvent(current.autopilotEvents, event) }
          : current,
      );
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        void loadRemote(activeConversationId || undefined, true);
      }, 150);
    });
    return () => {
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
      }
      unsubscribe();
    };
  }, [activeConversationId, autopilotActive, autopilotRunId, draftConversation, loadRemote, remote?.connected]);

  const connectRemote = async () => {
    setConnecting(true);
    try {
      const connected = await connectServstationAgent(
        snapshot.servstationA2A.config,
        snapshot.identityContext,
        snapshot.servstationA2A.config.staffAgentAccount,
      );
      if (!connected) {
        return;
      }
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
    selectedConversationRef.current = conversation.id;
    setDraftConversation(false);
    setDraftProjectId("");
    setActiveConversationId(conversation.id);
    await loadRemote(conversation.id);
  };

  const createConversation = async () => {
    setBusyId("conversation:create");
    try {
      remoteRequestRef.current += 1;
      selectedConversationRef.current = "";
      setDraftConversation(false);
      setDraftProjectId("");
      const conversation = await window.supbot.createServstationConversation();
      selectedConversationRef.current = conversation.id;
      await loadRemote(conversation.id);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setBusyId("");
    }
  };

  const startProjectConversation = (project: ServstationProject) => {
    remoteRequestRef.current += 1;
    selectedConversationRef.current = "";
    setDraftConversation(true);
    setDraftProjectId(project.id);
    setActiveConversationId("");
    setPrompt("");
    setAttachments([]);
  };

  const createProject = async (name: string): Promise<boolean> => {
    setBusyId("project:create");
    try {
      const project = await window.supbot.createServstationProject(name);
      setRemote((current) =>
        current
          ? { ...current, projects: [project, ...current.projects.filter((item) => item.id !== project.id)] }
          : current,
      );
      messageApi.success(t("Project created."));
      return true;
    } catch (error) {
      messageApi.error((error as Error).message);
      return false;
    } finally {
      setBusyId("");
    }
  };

  const updateProject = async (project: ServstationProject, name: string): Promise<boolean> => {
    setBusyId(`project:rename:${project.id}`);
    try {
      const updated = await window.supbot.updateServstationProject(project.id, name);
      setRemote((current) =>
        current
          ? {
              ...current,
              projects: current.projects.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)),
              conversations: current.conversations.map((conversation) =>
                conversation.projectId === updated.id ? { ...conversation, projectName: updated.name } : conversation,
              ),
            }
          : current,
      );
      setSelectedProject((current) => (current?.id === updated.id ? { ...current, ...updated } : current));
      messageApi.success(t("Project renamed."));
      return true;
    } catch (error) {
      messageApi.error((error as Error).message);
      return false;
    } finally {
      setBusyId("");
    }
  };

  const deleteProject = async (project: ServstationProject) => {
    setBusyId(`project:delete:${project.id}`);
    try {
      await window.supbot.deleteServstationProject(project.id);
      setRemote((current) =>
        current
          ? {
              ...current,
              projects: current.projects.filter((item) => item.id !== project.id),
              conversations: current.conversations.map((conversation) =>
                conversation.projectId === project.id
                  ? { ...conversation, projectId: undefined, projectName: undefined }
                  : conversation,
              ),
            }
          : current,
      );
      setDraftProjectId((current) => (current === project.id ? "" : current));
      if (selectedProject?.id === project.id) {
        setProjectResourcesOpen(false);
        setSelectedProject(null);
        setProjectResources([]);
      }
      messageApi.success(t("Project deleted."));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setBusyId("");
    }
  };

  const loadProjectResources = async (project: ServstationProject) => {
    setSelectedProject(project);
    setProjectResourcesOpen(true);
    setProjectResourcesLoading(true);
    try {
      setProjectResources(await window.supbot.listServstationProjectResources(project.id));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setProjectResourcesLoading(false);
    }
  };

  const deleteProjectResource = async (resource: ServstationProjectResource) => {
    if (!selectedProject) {
      return;
    }
    setBusyId(`resource:delete:${resource.id}`);
    try {
      await window.supbot.deleteServstationProjectResource(selectedProject.id, resource.id);
      setProjectResources((items) => items.filter((item) => item.id !== resource.id));
      setRemote((current) =>
        current
          ? {
              ...current,
              projects: current.projects.map((project) =>
                project.id === selectedProject.id
                  ? { ...project, resourceCount: Math.max((project.resourceCount || 0) - 1, 0) }
                  : project,
              ),
            }
          : current,
      );
      messageApi.success(t("Resource deleted."));
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
        ...servstationPromptTarget(activeConversation?.id, draftConversation ? draftProjectId : undefined),
        prompt: text,
        attachments,
      });
      remoteRequestRef.current += 1;
      selectedConversationRef.current = result.conversation.id;
      setRemote(result.snapshot);
      setActiveConversationId(result.conversation.id);
      setDraftConversation(false);
      setDraftProjectId("");
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

  const downloadGeneratedFile = async (jobId: string, file: ServstationGeneratedFile) => {
    try {
      const content = await window.supbot.fetchServstationJobFile(jobId, file.fileId);
      downloadServstationJobFile(content, file.fileName);
    } catch {
      messageApi.error(t("Download failed."));
    }
  };

  const saveSchedule = async (input: {
    title?: string;
    prompt: string;
    scheduleKind: string;
    runAt?: string;
    cronExpr?: string;
  }) => {
    await window.supbot.createServstationScheduledJob({
      ...input,
      conversationId: activeConversation?.id,
      enabled: true,
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
        prompt: text,
        requestId: `hbclient-autopilot-${Date.now().toString(36)}`,
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
  const tabBarExtra = (
    <div className="server-agent-tab-extra">
      <div className="tag-row">
        <Tag color={connected ? "green" : reverseStatus === "error" ? "red" : "default"}>
          {t(`reverse:${reverseStatus}`)}
        </Tag>
        <Tag>
          {remote?.baseUrl ||
            snapshot.servstationA2A.config.baseUrl ||
            snapshot.identityContext?.servstationUrl ||
            t("No Servstation URL")}
        </Tag>
        {remote?.identity?.userId ? <Tag>{remote.identity.userId}</Tag> : null}
      </div>
      <Button
        size="small"
        icon={<ReloadOutlined />}
        loading={loading}
        onClick={() => void loadRemote(activeConversation?.id, false, draftConversation)}
      >
        {t("Refresh")}
      </Button>
      {connected ? null : (
        <Button
          size="small"
          type="primary"
          icon={<ApiOutlined />}
          loading={connecting}
          onClick={() => void connectRemote()}
        >
          {t("Connect server Agent")}
        </Button>
      )}
    </div>
  );

  return (
    <section className="server-agent-workspace">
      {contextHolder}
      {!connected ? (
        <Alert
          type={reverseStatus === "error" ? "error" : "warning"}
          showIcon
          message={snapshot.servstationA2A.config.reverse?.lastError || t("Servstation reverse A2A is not connected.")}
        />
      ) : null}
      <Tabs
        className="server-agent-tabs"
        tabBarExtraContent={{ right: tabBarExtra }}
        items={[
          {
            key: "messages",
            label: (
              <span>
                <MessageOutlined /> {t("Conversations")}
              </span>
            ),
            children: (
              <ServerAgentMessages
                activeConversation={activeConversation}
                activeProject={activeProject}
                activeProjectId={activeProjectId}
                draftConversation={draftConversation}
                projects={remote?.projects || []}
                conversations={remote?.conversations || []}
                messages={messages}
                services={remote?.services || []}
                localCapabilities={remote?.localCapabilities || []}
                capabilityLoadError={remote?.capabilityLoadError}
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
                onRefresh={() => loadRemote(activeConversation?.id, false, draftConversation)}
                onCreateProject={createProject}
                onUpdateProject={updateProject}
                onDeleteProject={deleteProject}
                onOpenProjectResources={loadProjectResources}
                onStartProjectConversation={startProjectConversation}
                onPickAttachments={pickRemoteAttachments}
                onSend={sendRemotePrompt}
                onCancelRunning={cancelRunningJob}
                onDownloadGeneratedFile={downloadGeneratedFile}
                copySelectedText={copySelectedText}
                t={t}
              />
            ),
          },
          {
            key: "flow",
            label: (
              <Badge count={flowPendingCount} size="small" offset={[8, -4]}>
                <span>
                  <OrderedListOutlined /> {t("Flows")}
                </span>
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
            ),
          },
          {
            key: "schedule",
            label: (
              <span>
                <CalendarOutlined /> {t("Schedule")}
              </span>
            ),
            children: (
              <ServerAgentFlows
                scheduledJobs={remote?.scheduledJobs || []}
                autopilotRun={remote?.autopilotRun || null}
                autopilotEvents={remote?.autopilotEvents || []}
                autopilotSteps={remote?.autopilotSteps || []}
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
            ),
          },
          {
            key: "mail",
            label: (
              <span>
                <MailOutlined /> {t("Messages/Mail")}
              </span>
            ),
            children: (
              <ServerAgentMailWorkspace
                connected={connected}
                disabled={disabled}
                identity={remote?.identity || snapshot.identityContext}
                t={t}
              />
            ),
          },
        ]}
      />
      <RemoteScheduleModal
        open={scheduleOpen}
        disabled={disabled}
        onCancel={() => setScheduleOpen(false)}
        onSave={saveSchedule}
        t={t}
      />
      <Modal
        open={projectResourcesOpen}
        title={selectedProject ? `${t("Project resources")}: ${selectedProject.name}` : t("Project resources")}
        width={720}
        onCancel={() => {
          setProjectResourcesOpen(false);
          setSelectedProject(null);
          setProjectResources([]);
        }}
        footer={
          <Button
            icon={<ReloadOutlined />}
            loading={projectResourcesLoading}
            onClick={() => {
              if (selectedProject) {
                void loadProjectResources(selectedProject);
              }
            }}
          >
            {t("Refresh")}
          </Button>
        }
      >
        <div className="server-agent-resource-list" data-testid="server-agent-project-resource-list">
          {projectResources.map((resource) => (
            <div className="server-agent-resource-item" key={resource.id}>
              <div className="server-agent-resource-main">
                <div className="server-agent-resource-title">
                  <FileTextOutlined />
                  <strong title={resource.fileName}>{resource.fileName}</strong>
                  <Tag>{resource.resourceType}</Tag>
                  <Tag>{resource.contentType}</Tag>
                </div>
                <div className="server-agent-resource-meta">
                  <span>{formatFileSize(resource.sizeBytes)}</span>
                  <span>{formatDateTime(resource.createdAt)}</span>
                </div>
                {resource.summary ? <p className="server-agent-resource-summary">{resource.summary}</p> : null}
                {resource.relativePath ? (
                  <code className="server-agent-resource-path">{resource.relativePath}</code>
                ) : null}
              </div>
              <Popconfirm title={t("Delete project resource?")} onConfirm={() => void deleteProjectResource(resource)}>
                <Button
                  data-testid={`server-agent-project-resource-delete-${resource.id}`}
                  size="small"
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  loading={busyId === `resource:delete:${resource.id}`}
                  aria-label={t("Delete project resource?")}
                />
              </Popconfirm>
            </div>
          ))}
          {!projectResources.length ? (
            projectResourcesLoading ? (
              <div className="server-agent-resource-empty">{t("Loading...")}</div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No project resources")} />
            )
          ) : null}
        </div>
      </Modal>
    </section>
  );
}

function ServerAgentMessages({
  activeConversation,
  activeProject,
  activeProjectId,
  draftConversation,
  projects,
  conversations,
  messages,
  services,
  localCapabilities,
  capabilityLoadError,
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
  onRefresh,
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
  onOpenProjectResources,
  onStartProjectConversation,
  onPickAttachments,
  onSend,
  onCancelRunning,
  onDownloadGeneratedFile,
  copySelectedText,
  t,
}: {
  activeConversation?: ServstationConversation;
  activeProject?: ServstationProject;
  activeProjectId: string;
  draftConversation: boolean;
  projects: ServstationProject[];
  conversations: ServstationConversation[];
  messages: ServstationChatMessage[];
  services: ServstationServiceDefinition[];
  localCapabilities: ServstationLocalCapabilityAsset[];
  capabilityLoadError?: string;
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
  onRefresh: () => Promise<void>;
  onCreateProject: (name: string) => Promise<boolean>;
  onUpdateProject: (project: ServstationProject, name: string) => Promise<boolean>;
  onDeleteProject: (project: ServstationProject) => Promise<void>;
  onOpenProjectResources: (project: ServstationProject) => Promise<void>;
  onStartProjectConversation: (project: ServstationProject) => void;
  onPickAttachments: () => Promise<void>;
  onSend: () => Promise<void>;
  onCancelRunning: () => Promise<void>;
  onDownloadGeneratedFile: (jobId: string, file: ServstationGeneratedFile) => Promise<void>;
  copySelectedText: (text: string) => Promise<void>;
  t: Translator;
}) {
  const messageStreamRef = useRef<HTMLDivElement | null>(null);
  const selectionMenuRef = useRef<HTMLDivElement | null>(null);
  const promptMenuRef = useRef<HTMLDivElement | null>(null);
  const promptInputRef = useRef<TextAreaRef | null>(null);
  const [capabilityOpen, setCapabilityOpen] = useState(false);
  const [capabilitySearch, setCapabilitySearch] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [selectionMenu, setSelectionMenu] = useState<SelectionContextMenu | null>(null);
  const [selectionAction, setSelectionAction] = useState<"copy" | null>(null);
  const [promptMenu, setPromptMenu] = useState<PromptContextMenu | null>(null);
  const [promptAction, setPromptAction] = useState<"copy" | "paste" | null>(null);
  const [downloadingFileKeys, setDownloadingFileKeys] = useState<Set<string>>(() => new Set());
  const projectGroups = useMemo(
    () => groupServstationConversations(projects, conversations),
    [conversations, projects],
  );
  const effectiveServices = useMemo(
    () => buildEffectiveServstationServices(services, localCapabilities),
    [localCapabilities, services],
  );
  const visibleCapabilities = useMemo(
    () => buildVisibleServstationCapabilities(effectiveServices),
    [effectiveServices],
  );
  const filteredCapabilities = useMemo(
    () => filterVisibleServstationCapabilities(visibleCapabilities, capabilitySearch),
    [capabilitySearch, visibleCapabilities],
  );
  const capabilityCounts = useMemo(() => {
    let skills = 0;
    let mcps = 0;
    for (const item of visibleCapabilities) {
      if (item.capabilityType === "mcp") {
        mcps += 1;
      } else {
        skills += 1;
      }
    }
    return { skills, mcps };
  }, [visibleCapabilities]);

  const insertCapability = useCallback(
    (item: ServstationVisibleCapability) => {
      const directive = formatServstationCapabilityPromptDirective(item);
      const textArea = promptInputRef.current?.resizableTextArea?.textArea;
      const currentValue = textArea?.value ?? prompt;
      const fallbackPosition = currentValue.length;
      const start = Math.max(0, Math.min(textArea?.selectionStart ?? fallbackPosition, currentValue.length));
      const end = Math.max(start, Math.min(textArea?.selectionEnd ?? start, currentValue.length));
      const nextPrompt = `${currentValue.slice(0, start)}${directive}${currentValue.slice(end)}`;
      const caret = start + directive.length;
      setPrompt(nextPrompt);
      setCapabilityOpen(false);
      window.requestAnimationFrame(() => {
        const nextTextArea = promptInputRef.current?.resizableTextArea?.textArea;
        nextTextArea?.focus();
        nextTextArea?.setSelectionRange(caret, caret);
      });
    },
    [prompt, setPrompt],
  );

  const closeSelectionMenu = useCallback(() => setSelectionMenu(null), []);
  const closePromptMenu = useCallback(() => setPromptMenu(null), []);

  const openSelectionMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const text = selectedTextWithin(event.currentTarget);
      if (!text) {
        setSelectionMenu(null);
        return;
      }
      event.preventDefault();
      closePromptMenu();
      const menuWidth = 176;
      const menuHeight = 52;
      setSelectionMenu({
        x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
        y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
        text,
      });
    },
    [closePromptMenu],
  );

  const openPromptMenu = useCallback(
    (event: React.MouseEvent<HTMLTextAreaElement>) => {
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
        selectedText: prompt.slice(start, end),
      });
    },
    [closeSelectionMenu, prompt],
  );

  const runSelectionAction = useCallback(
    async (action: "copy") => {
      if (!selectionMenu) {
        return;
      }
      setSelectionAction(action);
      try {
        await copySelectedText(selectionMenu.text);
        closeSelectionMenu();
      } finally {
        setSelectionAction(null);
      }
    },
    [closeSelectionMenu, copySelectedText, selectionMenu],
  );

  const runPromptAction = useCallback(
    async (action: "copy" | "paste") => {
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
    },
    [closePromptMenu, copySelectedText, prompt, promptMenu, setPrompt, t],
  );

  const runGeneratedFileDownload = useCallback(
    async (jobId: string, file: ServstationGeneratedFile) => {
      const key = `${jobId}:${file.fileId}`;
      setDownloadingFileKeys((current) => new Set(current).add(key));
      try {
        await onDownloadGeneratedFile(jobId, file);
      } finally {
        setDownloadingFileKeys((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [onDownloadGeneratedFile],
  );

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
      const stream = messageStreamRef.current;
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
  }, [closeSelectionMenu, selectionMenu]);

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

  const submitProject = async () => {
    const name = newProjectName.trim();
    if (!name || busyId === "project:create") {
      return;
    }
    if (await onCreateProject(name)) {
      setNewProjectName("");
    }
  };

  const capabilityContent = (
    <div className="server-agent-capability-popover">
      <Input
        allowClear
        prefix={<SearchOutlined />}
        placeholder={t("Search skills and MCPs")}
        value={capabilitySearch}
        onChange={(event) => setCapabilitySearch(event.target.value)}
      />
      <div className="server-agent-capability-counts">
        <Tag>
          {t("skill")}: {capabilityCounts.skills}
        </Tag>
        <Tag>MCP: {capabilityCounts.mcps}</Tag>
      </div>
      {capabilityLoadError ? (
        <Alert type="warning" showIcon message={t("Capabilities failed to load")} description={capabilityLoadError} />
      ) : null}
      <div className="server-agent-capability-list" role="list">
        {filteredCapabilities.map((item) => (
          <button
            className="server-agent-capability-item"
            key={item.key}
            type="button"
            role="listitem"
            onClick={() => insertCapability(item)}
          >
            <span className="server-agent-capability-copy">
              <strong>{item.name}</strong>
              <small>{item.description || item.idLabel}</small>
              {item.description ? <code>{item.idLabel}</code> : null}
            </span>
            <Tag>{item.capabilityType === "mcp" ? "MCP" : t("skill")}</Tag>
          </button>
        ))}
        {!filteredCapabilities.length ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No matching capabilities")} />
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="server-agent-message-grid">
      <aside className="server-agent-conversations">
        <div className="server-agent-project-toolbar">
          <div className="section-title">
            <FolderOpenOutlined /> {t("Projects")}
          </div>
          <Space size={4}>
            <Tooltip title={t("Refresh")}>
              <Button
                data-testid="server-agent-project-refresh"
                size="small"
                type="text"
                icon={<ReloadOutlined />}
                disabled={disabled}
                aria-label={t("Refresh")}
                onClick={() => void onRefresh()}
              />
            </Tooltip>
            <Tooltip title={t("New conversation")}>
              <Button
                data-testid="server-agent-new-conversation"
                size="small"
                type="primary"
                icon={<PlusOutlined />}
                disabled={disabled}
                loading={busyId === "conversation:create"}
                aria-label={t("New conversation")}
                onClick={() => void onCreateConversation()}
              />
            </Tooltip>
          </Space>
        </div>
        <div className="server-agent-project-create" data-testid="server-agent-project-list">
          <Input
            size="small"
            value={newProjectName}
            placeholder={t("New project")}
            disabled={disabled || busyId === "project:create"}
            onChange={(event) => setNewProjectName(event.target.value)}
            onPressEnter={() => void submitProject()}
          />
          <Tooltip title={t("Create")}>
            <Button
              data-testid="server-agent-project-create"
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              loading={busyId === "project:create"}
              disabled={disabled || !newProjectName.trim()}
              aria-label={t("Create")}
              onClick={() => void submitProject()}
            />
          </Tooltip>
        </div>
        <div className="server-agent-project-list">
          {projectGroups.map((group) => (
            <ServerAgentProjectGroup
              key={group.key || "unfiled"}
              group={group}
              activeConversationId={activeConversation?.id || ""}
              activeProjectId={activeProjectId}
              draftConversation={draftConversation}
              disabled={disabled}
              busyId={busyId}
              onSelectConversation={onSelectConversation}
              onUpdateProject={onUpdateProject}
              onDeleteProject={onDeleteProject}
              onOpenProjectResources={onOpenProjectResources}
              onStartProjectConversation={onStartProjectConversation}
              t={t}
            />
          ))}
        </div>
      </aside>
      <section className="server-agent-chat">
        <div className="server-agent-chat-title">
          <div className="server-agent-chat-title-copy">
            <div className="chat-banner-label">{t("Messages")}</div>
            <strong>
              {draftConversation
                ? activeProject?.name || t("Unfiled")
                : activeConversation
                  ? servstationConversationTitle(activeConversation, t("New conversation"))
                  : t("No conversation yet")}
            </strong>
            {activeProject ? (
              <small>
                {t("Project")}: {activeProject.name}
              </small>
            ) : null}
          </div>
          <div className="server-agent-chat-actions">
            <Popover
              content={capabilityContent}
              trigger="click"
              placement="bottomRight"
              open={capabilityOpen}
              overlayClassName="server-agent-capability-overlay"
              destroyOnHidden
              onOpenChange={setCapabilityOpen}
            >
              <Button size="small" icon={<ToolOutlined />} disabled={sending}>
                {t("Skills")}
              </Button>
            </Popover>
            {runningJob ? (
              <Button
                danger
                size="small"
                icon={<StopOutlined />}
                loading={busyId === `job:${runningJob.id}`}
                onClick={() => void onCancelRunning()}
              >
                {t("Stop")}
              </Button>
            ) : null}
          </div>
        </div>
        <div
          className="server-agent-message-stream"
          ref={messageStreamRef}
          onScroll={closeSelectionMenu}
          onContextMenu={openSelectionMenu}
        >
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
                {item.jobId && item.generatedFiles?.length ? (
                  <div className="server-agent-result-files">
                    {item.generatedFiles.map((file) => {
                      const downloadKey = `${item.jobId}:${file.fileId}`;
                      return (
                        <Button
                          className="server-agent-result-file"
                          data-testid={`server-agent-result-file-${item.jobId}-${file.fileId}`}
                          key={downloadKey}
                          type="link"
                          size="small"
                          icon={<DownloadOutlined />}
                          loading={downloadingFileKeys.has(downloadKey)}
                          disabled={disabled}
                          aria-label={`${t("Download")} ${file.fileName}`}
                          onClick={() => void runGeneratedFileDownload(item.jobId!, file)}
                        >
                          <span className="server-agent-result-file-name">{file.fileName}</span>
                          {file.sizeBytes > 0 ? (
                            <span className="server-agent-result-file-size">{formatFileSize(file.sizeBytes)}</span>
                          ) : null}
                        </Button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          {!messages.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No messages yet")} /> : null}
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
        {attachments.length ? (
          <div className="attachment-strip">
            {attachments.map((attachment) => (
              <Tag
                closable
                key={attachment.id}
                onClose={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))}
              >
                {attachment.name}
              </Tag>
            ))}
          </div>
        ) : null}
        <div className="server-agent-composer">
          <Tooltip title={t("Attach files")}>
            <Button
              icon={<PaperClipOutlined />}
              disabled={disabled || sending}
              onClick={() => void onPickAttachments()}
            />
          </Tooltip>
          <Input.TextArea
            ref={promptInputRef}
            value={prompt}
            disabled={disabled || sending}
            autoSize={{ minRows: 2, maxRows: 6 }}
            placeholder={t("Message remote staff-agent...")}
            onChange={(event) => setPrompt(event.target.value)}
            onContextMenu={openPromptMenu}
            onPressEnter={(event) => {
              if (!event.shiftKey) {
                event.preventDefault();
                void onSend();
              }
            }}
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            loading={sending}
            disabled={disabled || !prompt.trim()}
            onClick={() => void onSend()}
          >
            {t("Send")}
          </Button>
        </div>
      </section>
    </div>
  );
}

function downloadServstationJobFile(content: ServstationJobFileContent, fallbackFileName: string): void {
  const bytes = Uint8Array.from(atob(content.contentBase64), (char) => char.charCodeAt(0));
  const blob = new Blob([bytes], { type: content.contentType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = servstationDownloadBaseName(content.fileName || fallbackFileName);
  link.click();
  URL.revokeObjectURL(url);
}

function servstationDownloadBaseName(value: string | undefined): string {
  return value?.split(/[\\/]/).pop()?.trim() || "download";
}

function ServerAgentProjectGroup({
  group,
  activeConversationId,
  activeProjectId,
  draftConversation,
  disabled,
  busyId,
  onSelectConversation,
  onUpdateProject,
  onDeleteProject,
  onOpenProjectResources,
  onStartProjectConversation,
  t,
}: {
  group: ServstationConversationGroup;
  activeConversationId: string;
  activeProjectId: string;
  draftConversation: boolean;
  disabled: boolean;
  busyId: string;
  onSelectConversation: (conversation: ServstationConversation) => Promise<void>;
  onUpdateProject: (project: ServstationProject, name: string) => Promise<boolean>;
  onDeleteProject: (project: ServstationProject) => Promise<void>;
  onOpenProjectResources: (project: ServstationProject) => Promise<void>;
  onStartProjectConversation: (project: ServstationProject) => void;
  t: Translator;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const project = group.project;
  const projectId = project?.id || "";
  const title = project?.name || t("Unfiled");
  const projectActive = activeProjectId === projectId;

  const submitRename = async () => {
    const name = renameValue.trim();
    if (!project || !name || busyId === `project:rename:${project.id}`) {
      return;
    }
    if (await onUpdateProject(project, name)) {
      setRenaming(false);
      setRenameValue("");
    }
  };

  return (
    <section
      className={`server-agent-project-group ${projectActive ? "is-active" : ""} ${draftConversation && projectActive ? "is-draft" : ""}`}
    >
      <div className="server-agent-project-heading">
        <Tooltip title={t(collapsed ? "Expand project" : "Collapse project")}>
          <Button
            className="server-agent-project-toggle"
            size="small"
            type="text"
            icon={collapsed ? <RightOutlined /> : <DownOutlined />}
            aria-label={t(collapsed ? "Expand project" : "Collapse project")}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          />
        </Tooltip>
        {renaming && project ? (
          <div className="server-agent-project-rename">
            <Input
              data-testid={`server-agent-project-rename-input-${project.id}`}
              size="small"
              value={renameValue}
              autoFocus
              disabled={busyId === `project:rename:${project.id}`}
              onChange={(event) => setRenameValue(event.target.value)}
              onPressEnter={() => void submitRename()}
            />
            <Tooltip title={t("Save")}>
              <Button
                size="small"
                type="text"
                icon={<SaveOutlined />}
                loading={busyId === `project:rename:${project.id}`}
                disabled={!renameValue.trim()}
                aria-label={t("Save")}
                onClick={() => void submitRename()}
              />
            </Tooltip>
            <Tooltip title={t("Cancel")}>
              <Button
                size="small"
                type="text"
                icon={<CloseCircleOutlined />}
                disabled={busyId === `project:rename:${project.id}`}
                aria-label={t("Cancel")}
                onClick={() => {
                  setRenaming(false);
                  setRenameValue("");
                }}
              />
            </Tooltip>
          </div>
        ) : (
          <div className="server-agent-project-name">
            {collapsed ? <FolderOutlined /> : <FolderOpenOutlined />}
            <strong title={title}>{title}</strong>
            <span>{group.conversations.length}</span>
          </div>
        )}
        {project && !renaming ? (
          <div className="server-agent-project-actions">
            <Tooltip title={t("Project resources")}>
              <Button
                data-testid={`server-agent-project-resources-${project.id}`}
                size="small"
                type="text"
                icon={<DatabaseOutlined />}
                disabled={disabled}
                aria-label={t("Project resources")}
                onClick={() => void onOpenProjectResources(project)}
              />
            </Tooltip>
            <Tooltip title={t("Rename project")}>
              <Button
                data-testid={`server-agent-project-rename-${project.id}`}
                size="small"
                type="text"
                icon={<EditOutlined />}
                disabled={disabled}
                aria-label={t("Rename project")}
                onClick={() => {
                  setRenaming(true);
                  setRenameValue(project.name);
                }}
              />
            </Tooltip>
            <Tooltip title={t("New project conversation")}>
              <Button
                data-testid={`server-agent-project-new-conversation-${project.id}`}
                size="small"
                type="text"
                icon={<PlusOutlined />}
                disabled={disabled}
                aria-label={t("New project conversation")}
                onClick={() => onStartProjectConversation(project)}
              />
            </Tooltip>
            <Popconfirm title={t("Delete project?")} onConfirm={() => void onDeleteProject(project)}>
              <Button
                data-testid={`server-agent-project-delete-${project.id}`}
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                loading={busyId === `project:delete:${project.id}`}
                disabled={disabled}
                aria-label={t("Delete project?")}
              />
            </Popconfirm>
          </div>
        ) : null}
      </div>
      {project && !collapsed ? (
        <div className="server-agent-project-meta">
          <span>{formatDateTime(project.updatedAt)}</span>
          <span>
            {t("Resource count")}: {project.resourceCount || 0}
          </span>
        </div>
      ) : null}
      {collapsed ? null : (
        <div className="server-agent-project-conversations">
          {group.conversations.map((conversation) => (
            <div
              className={`server-agent-project-conversation ${conversation.id === activeConversationId ? "is-active" : ""}`}
              key={conversation.id}
            >
              <button
                type="button"
                data-conversation-id={conversation.id}
                onClick={() => void onSelectConversation(conversation)}
              >
                <strong>{servstationConversationTitle(conversation, t("New conversation"))}</strong>
                <small>{formatDateTime(conversation.lastMessageAt || conversation.updatedAt)}</small>
              </button>
            </div>
          ))}
          {!group.conversations.length ? (
            <div className="server-agent-project-empty">{t("No conversations in this project")}</div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function SubagentModal({
  open,
  subagent,
  onCancel,
  onSave,
  t,
}: {
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
    <Modal
      open={open}
      title={subagent ? t("Edit subagent") : t("New subagent")}
      onCancel={onCancel}
      onOk={() => form.submit()}
      okText={t("Save")}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={(values) => void onSave({ ...values, id: values.id || values.name })}
      >
        <Form.Item label={t("ID")} name="id">
          <Input disabled={Boolean(subagent)} />
        </Form.Item>
        <Form.Item label={t("Name")} name="name" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item label={t("Description")} name="description">
          <Input />
        </Form.Item>
        <Form.Item label={t("System prompt")} name="systemPrompt">
          <Input.TextArea rows={5} />
        </Form.Item>
        <Form.Item label={t("Enabled")} name="enabled" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function TranscriptModal({
  open,
  result,
  loading,
  onCancel,
  t,
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
            <div>
              <span>{t("Source")}</span>
              <strong>{t(result.source)}</strong>
            </div>
            <div>
              <span>{t("Entries")}</span>
              <strong>{result.entries.length}</strong>
            </div>
            <div>
              <span>{t("Active messages")}</span>
              <strong>{result.activeMessages.length}</strong>
            </div>
          </div>
          {result.compactBoundary ? (
            <div className="compact-history-item">
              <div className="activity-head">
                <strong>{t("Latest compact boundary")}</strong>
                <Tag>{formatDateTime(result.compactBoundary.createdAt)}</Tag>
              </div>
              <div className="muted">
                {result.compactBoundary.originalMessageCount} {t("messages before compact")}
              </div>
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
                  message={
                    diagnostic.line ? `${diagnostic.message} (${t("line")} ${diagnostic.line})` : diagnostic.message
                  }
                />
              ))}
            </div>
          ) : null}
          <div className="transcript-active-list">
            <div className="section-title">
              <FileTextOutlined /> {t("Recoverable active context")}
            </div>
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

function ScheduleModal({
  open,
  projects,
  defaultProjectId,
  onCancel,
  onSave,
  t,
}: {
  open: boolean;
  projects: Project[];
  defaultProjectId?: string;
  onCancel: () => void;
  onSave: (input: ScheduledJobInput) => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [form] = Form.useForm<ScheduledJobInput>();
  useEffect(() => {
    if (open) {
      form.setFieldValue("projectId", defaultProjectId);
    }
  }, [defaultProjectId, form, open]);
  return (
    <Modal
      open={open}
      title={t("New scheduled prompt")}
      onCancel={onCancel}
      onOk={() => form.submit()}
      okText={t("Create")}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ scheduleKind: "once", enabled: true }}
        onFinish={(values) => void onSave(values)}
      >
        <Form.Item label={t("Title")} name="title" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item label={t("Prompt")} name="prompt" rules={[{ required: true }]}>
          <Input.TextArea rows={4} />
        </Form.Item>
        <Form.Item label={t("Project")} name="projectId">
          <Select
            allowClear
            placeholder={t("Unfiled")}
            options={projects.map((project) => ({
              value: project.id,
              label: project.name,
              disabled: project.status === "archived",
            }))}
          />
        </Form.Item>
        <Form.Item label={t("Kind")} name="scheduleKind">
          <Select
            options={[
              { value: "once", label: t("Once") },
              { value: "daily", label: t("Daily") },
              { value: "cron", label: t("Cron") },
            ]}
          />
        </Form.Item>
        <Form.Item label={t("Run at ISO time")} name="runAt">
          <Input placeholder={new Date(Date.now() + 3600000).toISOString()} />
        </Form.Item>
        <Form.Item label={t("Cron expression")} name="cronExpr">
          <Input placeholder="0 9 * * 1-5" />
        </Form.Item>
        <Form.Item label={t("Enabled")} name="enabled" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
