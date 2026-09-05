import { useEffect, useMemo, useState } from "react";
import {
  ApiOutlined,
  CloseOutlined,
  CompressOutlined,
  DownloadOutlined,
  FileImageOutlined,
  FilePdfOutlined,
  FileTextOutlined,
  FileUnknownOutlined,
  FileWordOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  StopOutlined,
  ToolOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Divider,
  Dropdown,
  Empty,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  message,
} from "antd";
import {
  defaultServstationBaseUrl,
  defaultServstationClientId,
  defaultServstationIssuerUrl,
  defaultServstationRedirectUri,
  defaultServstationScope,
  defaultServstationUser,
  type AgentJob,
  type FilePreviewResult,
  type LocalFileReference,
  type RemoteBridgeConfig,
  type RuntimeSnapshot,
  type ServstationA2AConfigUpdate,
} from "@supbot/shared";
import { formatDateTime, statusColor, statusLabel } from "@supbot/shared";
import {
  assistantPreviewForJob,
  formatToolOutput,
  formatToolPayload,
  jobRuntimeEventColor,
  jobRuntimeEventLabel,
  toolStatusColor,
  truncateText,
} from "../lib/chatFormat";
import { compareCreatedAt, shouldShowJobRuntimeEvent } from "../lib/snapshotApply";
import { decodeBase64Utf8, formatJsonPreview } from "../lib/filePreview";
import type { DetailPanel } from "../lib/types";
import { connectServstationAgent } from "../servstationConnection";

export function recentJobProgress(progress: string[]): string[] {
  const result: string[] = [];
  for (let index = progress.length - 1; index >= 0 && result.length < 5; index -= 1) {
    const item = progress[index];
    if (item && !result.includes(item)) {
      result.push(item);
    }
  }
  return result.reverse();
}

export function RightPanel({
  snapshot,
  activeConversationId,
  panel,
  setPanel,
  collapsed,
  t,
  onLocateJob,
  activeFile,
  onOpenDefaultApp,
  onShowInFolder,
  onSaveAs,
  onCloseFile,
}: {
  snapshot: RuntimeSnapshot;
  activeConversationId: string;
  panel: DetailPanel;
  setPanel: (panel: DetailPanel) => void;
  collapsed: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onLocateJob: (job: AgentJob) => void;
  activeFile: LocalFileReference | null;
  onOpenDefaultApp: (file: LocalFileReference) => Promise<void>;
  onShowInFolder: (file: LocalFileReference) => Promise<void>;
  onSaveAs: (file: LocalFileReference) => Promise<void>;
  onCloseFile: () => void;
}) {
  const conversationJobs = snapshot.jobs.filter((job) => job.conversationId === activeConversationId);
  const activeKey = panel === "file" && activeFile ? "file" : "tasks";
  return (
    <aside className={`activity-panel ${collapsed ? "is-collapsed" : ""}`}>
      <Tabs
        activeKey={activeKey}
        onChange={(key) => setPanel(key as DetailPanel)}
        items={[
          {
            key: "tasks",
            label: t("Tasks"),
            children: <ConversationTasksPanel jobs={conversationJobs} onLocateJob={onLocateJob} t={t} />,
          },
          ...(activeFile
            ? [
                {
                  key: "file",
                  label: (
                    <span className="file-tab-label" title={activeFile.name}>
                      <FileTextOutlined /> {activeFile.name}
                    </span>
                  ),
                  children: (
                    <FilePreviewPanel
                      file={activeFile}
                      t={t}
                      onOpenDefaultApp={onOpenDefaultApp}
                      onShowInFolder={onShowInFolder}
                      onSaveAs={onSaveAs}
                      onClose={onCloseFile}
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
    </aside>
  );
}

function fileKindIcon(kind: FilePreviewResult["kind"] | undefined) {
  switch (kind) {
    case "image":
      return <FileImageOutlined />;
    case "pdf":
      return <FilePdfOutlined />;
    case "office":
      return <FileWordOutlined />;
    case "binary":
      return <FileUnknownOutlined />;
    default:
      return <FileTextOutlined />;
  }
}

function fileKindLabel(kind: FilePreviewResult["kind"], t: (key: string) => string): string {
  return t(
    {
      text: "Text file",
      json: "JSON file",
      html: "HTML file",
      pdf: "PDF file",
      image: "Image file",
      office: "Office file",
      binary: "Binary file",
    }[kind],
  );
}

function FilePreviewPanel({
  file,
  t,
  onOpenDefaultApp,
  onShowInFolder,
  onSaveAs,
  onClose,
}: {
  file: LocalFileReference;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onOpenDefaultApp: (file: LocalFileReference) => Promise<void>;
  onShowInFolder: (file: LocalFileReference) => Promise<void>;
  onSaveAs: (file: LocalFileReference) => Promise<void>;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<FilePreviewResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(100);
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError("");
    setPreview(null);
    setZoom(100);
    void window.supbot
      .previewFile(file.path)
      .then((result) => {
        if (!canceled) {
          setPreview(result);
        }
      })
      .catch((reason) => {
        if (!canceled) {
          setError(reason instanceof Error ? reason.message : t("Preview failed."));
        }
      })
      .finally(() => {
        if (!canceled) {
          setLoading(false);
        }
      });
    return () => {
      canceled = true;
    };
  }, [file.path, t]);

  const menuItems = useMemo(
    () => [
      {
        key: "default",
        icon: fileKindIcon(preview?.kind),
        label: t("Default app"),
        onClick: () => void onOpenDefaultApp(file),
      },
      {
        key: "folder",
        icon: <FolderOpenOutlined />,
        label: t("Open containing folder"),
        onClick: () => void onShowInFolder(file),
      },
      { type: "divider" as const },
      {
        key: "save",
        icon: <DownloadOutlined />,
        label: t("Save as..."),
        onClick: () => void onSaveAs(file),
      },
    ],
    [file, onOpenDefaultApp, onSaveAs, onShowInFolder, preview?.kind, t],
  );

  const displayText =
    preview?.contentBase64 && (preview.kind === "text" || preview.kind === "json" || preview.kind === "html")
      ? decodeBase64Utf8(preview.contentBase64)
      : "";
  const jsonPreview = preview?.kind === "json" ? formatJsonPreview(displayText) : undefined;
  const dataUrl = preview?.contentBase64 ? `data:${preview.mimeType};base64,${preview.contentBase64}` : undefined;

  const runAction = async (action: () => Promise<void>, successKey?: string) => {
    try {
      await action();
      if (successKey) {
        messageApi.success(t(successKey));
      }
    } catch (reason) {
      messageApi.error(reason instanceof Error ? reason.message : t("File action failed."));
    }
  };

  return (
    <div className="file-preview-panel">
      {contextHolder}
      <div className="file-preview-toolbar">
        <div className="file-preview-title" title={file.name}>
          <span className="file-preview-icon">{fileKindIcon(preview?.kind)}</span>
          <span>
            <strong>{file.name}</strong>
            <small>
              {preview ? `${fileKindLabel(preview.kind, t)} · ${formatBytes(preview.size)}` : t("Loading...")}
            </small>
          </span>
        </div>
        <div className="file-preview-actions">
          {preview && preview.kind !== "office" && preview.kind !== "binary" ? (
            <Space.Compact size="small">
              <Button
                icon={<ZoomOutOutlined />}
                aria-label={t("Zoom out")}
                disabled={zoom <= 50}
                onClick={() => setZoom((value) => Math.max(50, value - 10))}
              />
              <Select
                aria-label={t("Zoom")}
                value={zoom}
                onChange={setZoom}
                options={[50, 75, 100, 125, 150, 200].map((value) => ({ value, label: `${value}%` }))}
                popupMatchSelectWidth={false}
                style={{ width: 72 }}
              />
              <Button
                icon={<ZoomInOutlined />}
                aria-label={t("Zoom in")}
                disabled={zoom >= 200}
                onClick={() => setZoom((value) => Math.min(200, value + 10))}
              />
            </Space.Compact>
          ) : null}
          <Button
            type="text"
            icon={<DownloadOutlined />}
            aria-label={t("Save as...")}
            onClick={() => void runAction(() => onSaveAs(file), "File saved.")}
          />
          <Dropdown menu={{ items: menuItems }} trigger={["click"]} placement="bottomRight">
            <Button type="text" className="file-open-button">
              {t("Open")} <span aria-hidden="true">⌄</span>
            </Button>
          </Dropdown>
          <Button type="text" icon={<CloseOutlined />} aria-label={t("Close")} onClick={onClose} />
        </div>
      </div>
      <div className="file-preview-content">
        {loading ? (
          <div className="file-preview-state">
            <Spin />
            <span>{t("Loading file...")}</span>
          </div>
        ) : error ? (
          <Alert type="error" showIcon message={t("Preview failed.")} description={error} />
        ) : !preview ? (
          <Empty description={t("No file selected")} />
        ) : preview.tooLarge ? (
          <FileFallbackCard preview={preview} file={file} t={t} onOpenDefaultApp={onOpenDefaultApp} />
        ) : preview.kind === "office" || preview.kind === "binary" ? (
          <FileFallbackCard preview={preview} file={file} t={t} onOpenDefaultApp={onOpenDefaultApp} />
        ) : preview.kind === "image" && dataUrl ? (
          <div className="file-image-viewport">
            <img src={dataUrl} alt={file.name} style={{ maxWidth: `${zoom}%`, maxHeight: `${zoom}%` }} />
          </div>
        ) : preview.kind === "pdf" && dataUrl ? (
          <iframe className="file-pdf-frame" src={dataUrl} title={file.name} />
        ) : preview.kind === "html" ? (
          <iframe className="file-html-frame" srcDoc={displayText} sandbox="" title={file.name} />
        ) : (
          <div className="file-text-viewport" style={{ fontSize: `${zoom}%` }}>
            <pre>{jsonPreview?.text || displayText}</pre>
            {jsonPreview && !jsonPreview.valid ? (
              <Tag color="warning">{t("Invalid JSON; showing raw text")}</Tag>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function FileFallbackCard({
  preview,
  file,
  t,
  onOpenDefaultApp,
}: {
  preview: FilePreviewResult;
  file: LocalFileReference;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onOpenDefaultApp: (file: LocalFileReference) => Promise<void>;
}) {
  return (
    <div className="file-fallback-card">
      <span className="file-fallback-icon">{fileKindIcon(preview.kind)}</span>
      <strong>{file.name}</strong>
      <span>
        {preview.tooLarge ? t("This file is too large to preview.") : t("Use the default app to view this file.")}
      </span>
      <Button type="primary" icon={<FolderOpenOutlined />} onClick={() => void onOpenDefaultApp(file)}>
        {t("Open in default app")}
      </Button>
    </div>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function ConversationTasksPanel({
  jobs,
  onLocateJob,
  t,
}: {
  jobs: AgentJob[];
  onLocateJob: (job: AgentJob) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  if (!jobs.length) {
    return (
      <div className="activity-list">
        <Empty description={t("No jobs yet")} />
      </div>
    );
  }
  return (
    <div className="activity-list">
      {jobs.map((job) => {
        const isActiveJob = job.status === "queued" || job.status === "running";
        return (
          <div className={`activity-item stacked job-item ${isActiveJob ? "is-running" : ""}`} key={job.id}>
            <button type="button" onClick={() => onLocateJob(job)} aria-label={t("Locate task message")}>
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
              <div className="muted">{formatDateTime(job.createdAt)}</div>
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function TasksPanel({
  snapshot,
  cancelJob,
  approveToolPermission,
  denyToolPermission,
  t,
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
      <ToolApprovalsPanel
        snapshot={snapshot}
        approveToolPermission={approveToolPermission}
        denyToolPermission={denyToolPermission}
        t={t}
      />
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
                <Tag
                  color={
                    job.workspaceMode === "isolated" ? "cyan" : job.workspaceMode === "readOnly" ? "purple" : "default"
                  }
                >
                  {t(job.workspaceMode)}
                </Tag>
                {job.diffStatus ? <Tag>{t(job.diffStatus)}</Tag> : null}
              </div>
            ) : null}
            <JobExecutionTimeline snapshot={snapshot} job={job} t={t} />
            {isActiveJob ? (
              <Button size="small" danger icon={<StopOutlined />} onClick={() => void cancelJob(job.id)}>
                {t("Cancel")}
              </Button>
            ) : null}
          </div>
        );
      })}
      {!jobs.length ? <Empty description={t("No jobs yet")} /> : null}
    </div>
  );
}

export function JobExecutionTimeline({
  snapshot,
  job,
  t,
}: {
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
  const itemCount =
    events.length +
    toolCalls.length +
    permissions.length +
    (assistantText ? 1 : 0) +
    progress.length +
    (showWaiting ? 1 : 0);

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

export function WorktreesPanel({
  snapshot,
  t,
}: {
  snapshot: RuntimeSnapshot;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
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
      <div className="section-title">
        <FolderOpenOutlined /> {t("Task worktrees")}
      </div>
      {snapshot.worktrees.slice(0, 5).map((worktree) => (
        <div className="worktree-card" key={worktree.id}>
          <div className="activity-head">
            <strong>{worktree.branchName}</strong>
            <Tag color={worktree.status === "active" ? "cyan" : worktree.status === "failed" ? "red" : "default"}>
              {t(worktree.status)}
            </Tag>
          </div>
          <div className="muted mono">{worktree.path}</div>
          <div className="tag-row">
            <Tag>{worktree.baseRef}</Tag>
            <Tag>{t(worktree.diffStatus)}</Tag>
            {worktree.diffSummary?.changedFiles.length ? (
              <Tag>
                {worktree.diffSummary.changedFiles.length} {t("files")}
              </Tag>
            ) : null}
          </div>
          {worktree.diffSummary?.summary ? <small>{worktree.diffSummary.summary}</small> : null}
          {worktree.diffSummary?.changedFiles.length ? (
            <div className="worktree-files">
              {worktree.diffSummary.changedFiles.slice(0, 4).map((file) => (
                <span key={`${worktree.id}-${file}`}>{file}</span>
              ))}
            </div>
          ) : null}
          <Space wrap>
            <Button
              size="small"
              icon={<FolderOpenOutlined />}
              onClick={() => void run(worktree.id, "open")}
              loading={loadingId === `open:${worktree.id}`}
            >
              {t("Open folder")}
            </Button>
            <Popconfirm title={t("Apply worktree changes?")} onConfirm={() => void run(worktree.id, "apply")}>
              <Button
                size="small"
                type="primary"
                disabled={worktree.status === "applied" || worktree.status === "discarded"}
                loading={loadingId === `apply:${worktree.id}`}
              >
                {t("Apply")}
              </Button>
            </Popconfirm>
            <Popconfirm title={t("Discard worktree changes?")} onConfirm={() => void run(worktree.id, "discard")}>
              <Button
                size="small"
                danger
                disabled={worktree.status === "applied" || worktree.status === "discarded"}
                loading={loadingId === `discard:${worktree.id}`}
              >
                {t("Discard")}
              </Button>
            </Popconfirm>
          </Space>
        </div>
      ))}
    </div>
  );
}

export function RemoteBridgePanel({
  snapshot,
  t,
}: {
  snapshot: RuntimeSnapshot;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
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
        baseUrl: patch.baseUrl ?? outbound.baseUrl ?? identity?.servstationUrl ?? defaultServstationBaseUrl,
        agentInstanceId: patch.agentInstanceId ?? outbound.agentInstanceId ?? identity?.agentInstanceId,
        ...patch,
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
      const result = await window.supbot.loginServstationOidc({
        baseUrl: outbound.baseUrl || identity?.servstationUrl || defaultServstationBaseUrl,
        issuerUrl: oidc?.issuerUrl || defaultServstationIssuerUrl,
        clientId: oidc?.clientId || defaultServstationClientId,
        scope: oidc?.scope || defaultServstationScope,
        redirectUri: oidc?.redirectUri || defaultServstationRedirectUri,
        loginHint: outbound.staffAgentAccount || defaultServstationUser,
      });
      if (result.status === "canceled") {
        return;
      }
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
      const connected = await connectServstationAgent(outbound, identity, outbound.staffAgentAccount);
      if (!connected) {
        return;
      }
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
        <div className="section-title">
          <ApiOutlined /> {t("Read-only remote bridge")}
        </div>
        <Switch checked={config.enabled} loading={saving} onChange={(checked) => void update({ enabled: checked })} />
      </div>
      <div className="tag-row">
        <Tag>
          {config.host}:{config.port}
        </Tag>
        <Tag color={config.tokenSaved ? "green" : "gold"}>{config.tokenSaved ? t("Token saved") : t("No token")}</Tag>
        {config.allowRemoteBind ? <Tag color="orange">{t("Remote bind opt-in")}</Tag> : null}
        {config.pairingCode ? <Tag color="blue">{config.pairingCode}</Tag> : null}
      </div>
      <small>{t("Remote bridge is read-only for tools, permissions, and worktree apply/discard.")}</small>
      {identity ? (
        <div className="remote-session">
          <span>
            {identity.tenantId}/{identity.organizationId}/{identity.departmentId}/{identity.userId}
          </span>
          <Tag color="blue">{identity.source || "identity"}</Tag>
          {identity.agentInstanceId ? <Tag>{identity.agentInstanceId}</Tag> : null}
        </div>
      ) : (
        <small>{t("No Servstation identity is paired yet.")}</small>
      )}
      <Divider />
      <div className="activity-head">
        <div className="section-title">
          <ApiOutlined /> {t("Servstation outbound A2A")}
        </div>
        <Switch
          checked={outbound.enabled}
          loading={savingA2A}
          onChange={(checked) => void updateA2A({ enabled: checked })}
        />
      </div>
      <div className="tag-row">
        <Tag color={outbound.enabled ? "green" : "default"}>{outbound.enabled ? t("enabled") : t("disabled")}</Tag>
        <Tag>{outbound.baseUrl || identity?.servstationUrl || t("No Servstation URL")}</Tag>
        <Tag>{outbound.agentInstanceId || identity?.agentInstanceId || t("No agent id")}</Tag>
        <Tag color={outbound.bearerTokenSaved ? "green" : "gold"}>{outbound.authMode}</Tag>
        <Tag color={reverse?.status === "connected" ? "green" : reverse?.status === "error" ? "red" : "default"}>
          {t(`reverse:${reverse?.status || "disconnected"}`)}
        </Tag>
        {oidc?.refreshTokenSaved ? <Tag color="green">{t("OIDC token saved")}</Tag> : null}
        {oidc?.userId ? <Tag>{oidc.userId}</Tag> : null}
        {oidc?.accessTokenExpiresAt ? (
          <Tag>{t("Expires: {time}", { time: formatDateTime(oidc.accessTokenExpiresAt) })}</Tag>
        ) : null}
        {reverse?.peerId ? <Tag>{reverse.peerId}</Tag> : null}
      </div>
      <Space wrap size="small">
        <Button size="small" type="primary" loading={savingA2A} onClick={() => void loginOidc()}>
          {t("Sign in with Servstation")}
        </Button>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={savingA2A}
          disabled={!oidc?.refreshTokenSaved}
          onClick={() => void refreshOidc()}
        >
          {t("Refresh OIDC")}
        </Button>
        <Button size="small" danger disabled={!oidc?.refreshTokenSaved} onClick={() => void logoutOidc()}>
          {t("Sign out")}
        </Button>
        {reverse?.enabled ? (
          <Button size="small" danger loading={savingA2A} onClick={() => void disconnectReverse()}>
            {t("Disconnect remote")}
          </Button>
        ) : (
          <Button size="small" type="primary" loading={savingA2A} onClick={() => void connectReverse()}>
            {t("Connect remote")}
          </Button>
        )}
      </Space>
      <small>
        {t("Servstation A2A exposes servstation_connect, servstation_prompt, and read-only reverse prompt execution.")}
      </small>
      {reverse?.lastHeartbeatAt ? (
        <small>{t("Last heartbeat: {time}", { time: formatDateTime(reverse.lastHeartbeatAt) })}</small>
      ) : null}
      {reverse?.lastError ? <small>{reverse.lastError}</small> : null}
      {snapshot.remoteBridge.sessions.slice(0, 3).map((session) => (
        <div className="remote-session" key={session.id}>
          <span>{session.name}</span>
          <Tag color={session.revokedAt ? "red" : "green"}>{session.revokedAt ? t("revoked") : t("active")}</Tag>
          {!session.revokedAt ? (
            <Button size="small" onClick={() => void window.supbot.revokeRemoteBridgeSession(session.id)}>
              {t("Revoke")}
            </Button>
          ) : null}
        </div>
      ))}
      {snapshot.remoteBridge.audit.slice(0, 3).map((record) => (
        <div className="runtime-event" key={record.id}>
          <span>{record.statusCode}</span>
          <small>
            {record.method} {record.path} 路 {record.message}
          </small>
        </div>
      ))}
    </div>
  );
}

export function RuntimeStatusPanel({
  snapshot,
  t,
}: {
  snapshot: RuntimeSnapshot;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
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
          <div className="section-title">
            <CompressOutlined /> {t("Compact history")}
          </div>
          {compactHistory.map((boundary) => (
            <div className="compact-history-item" key={boundary.id}>
              <div className="activity-head">
                <strong>{formatDateTime(boundary.createdAt)}</strong>
                <Tag>
                  {boundary.originalMessageCount} {t("messages")}
                </Tag>
              </div>
              <small>{boundary.summary.slice(0, 180)}</small>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ToolApprovalsPanel({
  snapshot,
  approveToolPermission,
  denyToolPermission,
  t,
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
      <div className="section-title">
        <ToolOutlined /> {t("Tool approvals")}
      </div>
      {snapshot.pendingToolPermissions.map((permission) => (
        <div className="tool-approval" key={permission.id}>
          <div>
            <strong>{permission.toolName}</strong>
            <span>{permission.summary}</span>
            {permission.executionPath ? <small className="muted mono">{permission.executionPath}</small> : null}
          </div>
          <Space>
            <Button size="small" type="primary" onClick={() => void approveToolPermission(permission.id)}>
              {t("Allow once")}
            </Button>
            <Button size="small" danger onClick={() => void denyToolPermission(permission.id)}>
              {t("Deny")}
            </Button>
          </Space>
        </div>
      ))}
    </div>
  );
}
