import React from "react";
import { DownloadOutlined, MenuFoldOutlined, MenuUnfoldOutlined, RobotOutlined, SyncOutlined } from "@ant-design/icons";
import { Badge, Button, Segmented, Tooltip } from "antd";
import type { HBClientUpdateState, RuntimeSnapshot } from "@supbot/shared";
import { translate, type Language } from "../i18n";
import type { WorkspaceView } from "../lib/types";
import { ServerAgentConnectionButton } from "../views/ServerAgentWorkspace";

export function Topbar({
  snapshot,
  view,
  setView,
  refresh,
  language,
  setLanguage,
  leftCollapsed,
  rightCollapsed,
  setLeftCollapsed,
  setRightCollapsed,
  updateState,
  startUpdate,
  showVersionInfo,
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
  updateState: HBClientUpdateState;
  startUpdate: () => void | Promise<void>;
  showVersionInfo: () => void | Promise<void>;
}) {
  return (
    <header className="topbar">
      <div className="identity">
        <Tooltip title={language === "zh" ? "查看版本信息" : "View version information"}>
          <button
            className="brand-mark brand-mark-button small"
            type="button"
            aria-label={language === "zh" ? "查看 HBClient 版本信息" : "View HBClient version information"}
            onClick={() => void showVersionInfo()}
          >
            <RobotOutlined />
          </button>
        </Tooltip>
        <div>
          <div className="eyebrow">{translate(language, "LOCAL AGENT CONSOLE")}</div>
          <div className="agent-title">{snapshot.agentName}</div>
          <div className="muted mono">
            {snapshot.modelConfig.providerName} / {snapshot.modelConfig.model}
          </div>
        </div>
      </div>
      <Segmented
        value={view}
        onChange={(value) => setView(value as WorkspaceView)}
        options={[
          { label: translate(language, "Chat"), value: "chat" },
          { label: translate(language, "Server Agent"), value: "server" },
          { label: translate(language, "Config"), value: "config" },
        ]}
      />
      <div className="topbar-actions">
        <HBClientUpdateButton state={updateState} language={language} startUpdate={startUpdate} />
        <ServerAgentConnectionButton
          snapshot={snapshot}
          refresh={refresh}
          t={(key, vars) => translate(language, key, vars)}
          compact
        />
        <Segmented
          size="small"
          value={language}
          onChange={(value) => setLanguage(value as Language)}
          options={[
            { label: "中文", value: "zh" },
            { label: "EN", value: "en" },
          ]}
        />
        <div className={`runtime-pill is-${snapshot.status}`}>
          <span className="status-dot" />
          {snapshot.status === "running" ? translate(language, "Running") : translate(language, "Ready")}
        </div>
        {view === "chat" ? (
          <>
            <Tooltip title={translate(language, "Toggle left panel")}>
              <Button
                icon={leftCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                onClick={() => setLeftCollapsed((value) => !value)}
              />
            </Tooltip>
            <Tooltip title={translate(language, "Toggle right panel")}>
              <Button
                icon={rightCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                onClick={() => setRightCollapsed((value) => !value)}
              />
            </Tooltip>
          </>
        ) : null}
      </div>
    </header>
  );
}

export function HBClientUpdateButton({
  state,
  language,
  startUpdate,
}: {
  state: HBClientUpdateState;
  language: Language;
  startUpdate: () => void | Promise<void>;
}) {
  const chinese = language === "zh";
  if (!["available", "downloading", "downloaded", "installing"].includes(state.status)) {
    return null;
  }

  const withUpdateBadge = (button: React.ReactNode) => (
    <Tooltip title="有新版本">
      <Badge className="hbclient-update-badge" dot color="#ef4444" offset={[-2, 2]}>
        {button}
      </Badge>
    </Tooltip>
  );

  if (state.status === "available" || state.status === "downloaded") {
    const version = state.availableVersion ? " v" + state.availableVersion : "";
    const label =
      state.status === "downloaded"
        ? chinese
          ? "安装更新" + version
          : "Install update" + version
        : chinese
          ? "升级" + version
          : "Upgrade" + version;
    return withUpdateBadge(
      <Button
        className="hbclient-update-button"
        type="primary"
        size="small"
        icon={<DownloadOutlined />}
        onClick={() => void startUpdate()}
      >
        {label}
      </Button>,
    );
  }

  if (state.status === "downloading") {
    const percent = Math.round(state.progress?.percent || 0);
    const progressTitle = state.progress
      ? formatUpdateBytes(state.progress.transferred) +
        " / " +
        formatUpdateBytes(state.progress.total) +
        " · " +
        formatUpdateBytes(state.progress.bytesPerSecond) +
        "/s"
      : chinese
        ? "正在下载更新"
        : "Downloading update";
    return (
      <Tooltip title={progressTitle}>
        <Badge className="hbclient-update-badge" dot color="#ef4444" offset={[-2, 2]}>
          <Button className="hbclient-update-button" size="small" loading disabled>
            {percent}%
          </Button>
        </Badge>
      </Tooltip>
    );
  }

  return withUpdateBadge(
    <Button className="hbclient-update-button" size="small" icon={<SyncOutlined spin />} disabled>
      {chinese ? "安装中" : "Installing"}
    </Button>,
  );
}
export function formatUpdateBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KiB", "MiB", "GiB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
