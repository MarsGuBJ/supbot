import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BellOutlined,
  CheckOutlined,
  DownOutlined,
  GlobalOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SettingOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Tooltip } from "antd";
import type { HBClientUpdateState, RuntimeSnapshot } from "@supbot/shared";
import { formatDateTime } from "@supbot/shared";
import { translate, type Language } from "../i18n";
import type { WorkspaceView } from "../lib/types";

const notifyReadAtKey = "hbclient.notifications.readAt";

function loadNotifyReadAt(): number {
  try {
    return Number(window.localStorage.getItem(notifyReadAtKey) || Date.now());
  } catch {
    return Date.now();
  }
}

function saveNotifyReadAt(value: number): void {
  try {
    window.localStorage.setItem(notifyReadAtKey, String(value));
  } catch {
    // In-memory unread state still works.
  }
}

type NotifyKind = "update" | "task" | "alert";

interface NotifyItem {
  id: string;
  kind: NotifyKind;
  title: string;
  desc: string;
  time: string;
  actionLabel?: string;
  onAction?: () => void;
}

function useClickOutside(ref: React.RefObject<HTMLElement | null>, onOutside: () => void): void {
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onOutside();
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [ref, onOutside]);
}

function VersionDropdown({
  view,
  setView,
  chinese,
}: {
  view: WorkspaceView;
  setView: (view: WorkspaceView) => void;
  chinese: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useClickOutside(ref, () => setOpen(false));
  const label =
    view === "server"
      ? chinese
        ? "HyBot 企业工作区"
        : "HyBot Enterprise"
      : chinese
        ? "HyBot 个人空间"
        : "HyBot Personal";
  return (
    <div className={`hb-version-dropdown ${open ? "open" : ""}`} ref={ref}>
      <button
        type="button"
        className="hb-version-btn"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{label}</span>
        <DownOutlined className="hb-version-caret" />
      </button>
      <div className="hb-version-menu" role="listbox">
        <div
          className={`hb-version-item ${view !== "server" ? "active" : ""}`}
          role="option"
          aria-selected={view !== "server"}
          onClick={() => {
            setView("chat");
            setOpen(false);
          }}
        >
          <UserOutlined className="hb-version-item-icon" />
          <div className="hb-version-item-body">
            <div className="hb-version-item-title">{chinese ? "HyBot 个人空间" : "HyBot Personal"}</div>
            <div className="hb-version-item-desc">
              {chinese ? "面向个人工作与日常学习智能体" : "Agent for personal work and study"}
            </div>
          </div>
          {view !== "server" ? <CheckOutlined className="hb-version-item-check" /> : null}
        </div>
        <div
          className={`hb-version-item ${view === "server" ? "active" : ""}`}
          role="option"
          aria-selected={view === "server"}
          onClick={() => {
            setView("server");
            setOpen(false);
          }}
        >
          <GlobalOutlined className="hb-version-item-icon" />
          <div className="hb-version-item-body">
            <div className="hb-version-item-title">{chinese ? "HyBot 企业工作区" : "HyBot Enterprise"}</div>
            <div className="hb-version-item-desc">
              {chinese ? "面向团队与企业的智能工作平台" : "Agent workspace for teams and enterprises"}
            </div>
          </div>
          {view === "server" ? <CheckOutlined className="hb-version-item-check" /> : null}
        </div>
      </div>
    </div>
  );
}

export function Topbar({
  snapshot,
  view,
  setView,
  language,
  setLanguage,
  rightCollapsed,
  setRightCollapsed,
  updateState,
  startUpdate,
  showVersionInfo,
  openManage,
  onCompact,
}: {
  snapshot: RuntimeSnapshot;
  view: WorkspaceView;
  setView: (view: WorkspaceView) => void;
  language: Language;
  setLanguage: (language: Language) => void;
  rightCollapsed: boolean;
  setRightCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  updateState: HBClientUpdateState;
  startUpdate: () => void | Promise<void>;
  showVersionInfo: () => void | Promise<void>;
  openManage: () => void;
  onCompact: () => void | Promise<void>;
}) {
  const chinese = language === "zh";
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [readAt, setReadAt] = useState(loadNotifyReadAt);
  const notifyRef = useRef<HTMLDivElement | null>(null);
  const contextRef = useRef<HTMLDivElement | null>(null);
  useClickOutside(notifyRef, () => setNotifyOpen(false));
  useClickOutside(contextRef, () => setContextOpen(false));

  const activeConversation =
    snapshot.conversations.find(
      (item) => item.id === (snapshot.activeConversationId || snapshot.conversations[0]?.id),
    ) || snapshot.conversations[0];
  const compactBoundary = activeConversation
    ? [...snapshot.compactBoundaries]
        .filter((item) => item.conversationId === activeConversation.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    : undefined;

  const notifications = useMemo<NotifyItem[]>(() => {
    const items: NotifyItem[] = [];
    if (["available", "downloading", "downloaded", "installing"].includes(updateState.status)) {
      const version = updateState.availableVersion ? ` v${updateState.availableVersion}` : "";
      const downloading = updateState.status === "downloading";
      items.push({
        id: "hbclient-update",
        kind: "update",
        title: chinese ? `HyBot 新版本${version}` : `New HyBot version${version}`,
        desc: downloading
          ? chinese
            ? "正在下载更新…"
            : "Downloading update…"
          : updateState.status === "downloaded"
            ? chinese
              ? "更新已就绪，点击安装"
              : "Update ready, click to install"
            : chinese
              ? "点击升级到最新版本"
              : "Click to upgrade to the latest version",
        time: updateState.checkedAt || new Date().toISOString(),
        actionLabel: downloading
          ? chinese
            ? "下载中"
            : "Downloading"
          : updateState.status === "downloaded" || updateState.status === "installing"
            ? chinese
              ? "安装"
              : "Install"
            : chinese
              ? "升级"
              : "Upgrade",
        onAction: () => void startUpdate(),
      });
    }
    const terminalJobs = snapshot.jobs
      .filter((job) => job.status === "completed" || job.status === "failed")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 5);
    for (const job of terminalJobs) {
      items.push({
        id: `job-${job.id}`,
        kind: "task",
        title:
          job.status === "completed" ? (chinese ? "任务完成" : "Task completed") : chinese ? "任务失败" : "Task failed",
        desc: job.prompt.slice(0, 80),
        time: job.createdAt,
      });
    }
    for (const event of snapshot.autopilotEvents.slice(0, 3)) {
      items.push({
        id: `autopilot-${event.id}`,
        kind: "alert",
        title: chinese ? "自动驾驶事件" : "Autopilot event",
        desc: event.message.slice(0, 80),
        time: event.createdAt,
      });
    }
    return items.sort((a, b) => b.time.localeCompare(a.time)).slice(0, 20);
  }, [chinese, snapshot.autopilotEvents, snapshot.jobs, updateState]);

  const unreadCount = notifications.filter((item) => Date.parse(item.time) > readAt).length;

  const markAllRead = () => {
    const next = Date.now();
    setReadAt(next);
    saveNotifyReadAt(next);
  };

  const notifyIcon = (kind: NotifyKind) => {
    if (kind === "update") {
      return "update";
    }
    if (kind === "alert") {
      return "alert";
    }
    return "task";
  };

  return (
    <header className="app-topbar">
      <div className={`app-topbar-left ${view === "server" ? "standalone" : ""}`}>
        <VersionDropdown view={view} setView={setView} chinese={chinese} />
      </div>
      <div className="app-topbar-center" />
      <div className="app-topbar-actions">
        <div className={`topbar-context-dropdown ${contextOpen ? "open" : ""}`} ref={contextRef}>
          <button
            type="button"
            className="topbar-context-trigger"
            onClick={() => setContextOpen((value) => !value)}
            aria-expanded={contextOpen}
            title={chinese ? "上下文用量" : "Context usage"}
          >
            <span>{chinese ? "上下文用量" : "Context"}</span>
            <DownOutlined />
          </button>
          <div className="topbar-context-menu">
            <div className="topbar-context-usage">
              <div className="topbar-context-usage-text">
                <span>{chinese ? "当前会话" : "Current conversation"}</span>
                <span>
                  {activeConversation
                    ? `${activeConversation.messageCount || activeConversation.messages.length} ${chinese ? "条消息" : "messages"}`
                    : chinese
                      ? "暂无会话"
                      : "No conversation"}
                </span>
              </div>
              {compactBoundary ? (
                <div className="topbar-context-usage-note">
                  {chinese ? "最近压缩" : "Last compacted"}: {formatDateTime(compactBoundary.createdAt)} ·{" "}
                  {compactBoundary.originalMessageCount} {chinese ? "条消息前" : "messages"}
                </div>
              ) : (
                <div className="topbar-context-usage-note">
                  {chinese ? "尚未压缩过上下文" : "Context has not been compacted yet"}
                </div>
              )}
            </div>
            <div className="topbar-context-divider" />
            <button
              type="button"
              className="topbar-context-action"
              disabled={!activeConversation}
              onClick={() => {
                setContextOpen(false);
                void onCompact();
              }}
            >
              {chinese ? "立即压缩上下文" : "Compact context now"}
            </button>
            <div className="topbar-context-hint">
              {chinese
                ? "长对话会自动压缩历史，节省 token。"
                : "Long conversations are compacted automatically to save tokens."}
            </div>
          </div>
        </div>
        <button
          type="button"
          className="topbar-text-btn"
          onClick={() => {
            setNotifyOpen(false);
            openManage();
          }}
          title={chinese ? "管理" : "Manage"}
        >
          {chinese ? "管理" : "Manage"}
          <SettingOutlined />
        </button>
        <div className={`topbar-notify-dropdown ${notifyOpen ? "open" : ""}`} ref={notifyRef}>
          <button
            type="button"
            className="topbar-icon-btn"
            onClick={() => setNotifyOpen((value) => !value)}
            aria-expanded={notifyOpen}
            title={chinese ? "消息通知" : "Notifications"}
            aria-label={chinese ? "消息通知" : "Notifications"}
          >
            <BellOutlined />
            {unreadCount ? <span className="topbar-icon-badge" /> : null}
          </button>
          <div className="topbar-notify-panel">
            <div className="topbar-notify-header">
              <span className="topbar-notify-title">{chinese ? "消息通知" : "Notifications"}</span>
              <button type="button" className="topbar-notify-action" onClick={markAllRead}>
                {chinese ? "全部已读" : "Mark all read"}
              </button>
            </div>
            <div className="topbar-notify-list">
              {notifications.map((item) => (
                <div
                  className={`topbar-notify-item ${Date.parse(item.time) > readAt ? "unread" : ""}`}
                  key={item.id}
                  onClick={item.onAction ? item.onAction : undefined}
                >
                  <span className={`topbar-notify-icon ${notifyIcon(item.kind)}`}>
                    {item.kind === "update" ? (
                      <GlobalOutlined />
                    ) : item.kind === "alert" ? (
                      <BellOutlined />
                    ) : (
                      <CheckOutlined />
                    )}
                  </span>
                  <div className="topbar-notify-body">
                    <div className="topbar-notify-row">
                      <strong>{item.title}</strong>
                      <span className="topbar-notify-time">{formatDateTime(item.time)}</span>
                    </div>
                    <div className="topbar-notify-desc">{item.desc}</div>
                    {item.actionLabel ? (
                      <button
                        type="button"
                        className="topbar-notify-item-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          item.onAction?.();
                        }}
                      >
                        {item.actionLabel}
                      </button>
                    ) : null}
                  </div>
                  {Date.parse(item.time) > readAt ? <span className="topbar-notify-dot" /> : null}
                </div>
              ))}
              {!notifications.length ? (
                <div className="topbar-notify-empty">{chinese ? "暂无通知" : "No notifications"}</div>
              ) : null}
            </div>
            <div className="topbar-notify-footer">
              <span className="topbar-notify-count">
                {chinese
                  ? `共 ${notifications.length} 条通知，${unreadCount} 条未读`
                  : `${notifications.length} notifications, ${unreadCount} unread`}
              </span>
            </div>
          </div>
        </div>
        <div className="topbar-lang-toggle" role="group" aria-label={chinese ? "语言" : "Language"}>
          <button
            type="button"
            className={language === "zh" ? "active" : ""}
            aria-pressed={language === "zh"}
            onClick={() => setLanguage("zh")}
          >
            中文
          </button>
          <button
            type="button"
            className={language === "en" ? "active" : ""}
            aria-pressed={language === "en"}
            onClick={() => setLanguage("en")}
          >
            EN
          </button>
        </div>
        <Tooltip title={chinese ? "版本信息" : "Version information"}>
          <button
            type="button"
            className="topbar-icon-btn"
            onClick={() => void showVersionInfo()}
            aria-label={chinese ? "版本信息" : "Version information"}
          >
            <span className="topbar-version-glyph">HyBot</span>
          </button>
        </Tooltip>
        <Tooltip title={translate(language, rightCollapsed ? "Open right panel" : "Close right panel")}>
          <button
            type="button"
            className="topbar-icon-btn"
            onClick={() => setRightCollapsed((value) => !value)}
            aria-label={translate(language, "Toggle right panel")}
          >
            {rightCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </button>
        </Tooltip>
      </div>
    </header>
  );
}
