import { useEffect, useMemo, useState } from "react";
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  PlusOutlined,
  RightOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { Button, Empty, Popconfirm, Space, Switch, Tag, message } from "antd";
import type { AgentJob, ChatMessage, RuntimeSnapshot, ScheduledJob } from "@supbot/shared";
import { formatDateTime, formatSchedule, statusColor, statusLabel } from "@supbot/shared";
import { AutopilotPanel } from "../components/AutopilotPanel";
import { MessageBubble } from "../components/MessageBubble";
import { groupScheduleRuns, scheduleRunTime } from "../lib/scheduleRecords";
import type { Translator } from "../lib/types";

export function ScheduleMenuView({
  snapshot,
  refresh,
  onCreateSchedule,
  onEditSchedule,
  onClose,
  t,
}: {
  snapshot: RuntimeSnapshot;
  refresh: () => void;
  onCreateSchedule: () => void;
  onEditSchedule: (job: ScheduledJob) => void;
  onClose: () => void;
  t: Translator;
}) {
  const [tab, setTab] = useState<"tasks" | "logs">("tasks");
  const [busyId, setBusyId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [messageApi, contextHolder] = message.useMessage();
  const jobs = snapshot.scheduledJobs || [];
  const runGroups = useMemo(
    () => groupScheduleRuns(snapshot.jobs || [], jobs, t("Deleted task")),
    [snapshot.jobs, jobs, t],
  );

  useEffect(() => {
    const runs = runGroups.flatMap((group) => group.runs);
    if (!runs.length) {
      if (selectedRunId) {
        setSelectedRunId("");
      }
      return;
    }
    if (!runs.some((job) => job.id === selectedRunId)) {
      setSelectedRunId(runs[0].id);
    }
  }, [runGroups, selectedRunId]);

  const toggleGroup = (scheduledJobId: string) => {
    setCollapsedGroups((current) => ({ ...current, [scheduledJobId]: !current[scheduledJobId] }));
  };

  const selectedRun = runGroups.flatMap((group) => group.runs).find((job) => job.id === selectedRunId);

  const toggleJob = async (job: ScheduledJob) => {
    if (busyId) {
      return;
    }
    setBusyId(`toggle:${job.id}`);
    try {
      await window.supbot.updateScheduledJob(job.id, { enabled: !job.enabled });
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setBusyId("");
    }
  };

  const deleteJob = async (job: ScheduledJob) => {
    if (busyId) {
      return;
    }
    setBusyId(`delete:${job.id}`);
    try {
      await window.supbot.deleteScheduledJob(job.id);
      await refresh();
      messageApi.success(t("Scheduled task deleted."));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setBusyId("");
    }
  };

  return (
    <section className="menu-workspace schedule-workspace">
      {contextHolder}
      <div className="menu-workspace-header">
        <div>
          <div className="eyebrow">{t("SCHEDULED TASKS")}</div>
        </div>
        <Space>
          <Button type="primary" icon={<PlusOutlined />} onClick={onCreateSchedule}>
            {t("Create scheduled task")}
          </Button>
          <Button icon={<CloseOutlined />} onClick={onClose}>
            {t("Close")}
          </Button>
        </Space>
      </div>
      <div className="schedule-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={`schedule-tab ${tab === "tasks" ? "active" : ""}`}
          aria-selected={tab === "tasks"}
          onClick={() => setTab("tasks")}
        >
          {t("Scheduled tasks")}
        </button>
        <button
          type="button"
          role="tab"
          className={`schedule-tab ${tab === "logs" ? "active" : ""}`}
          aria-selected={tab === "logs"}
          onClick={() => setTab("logs")}
        >
          {t("Run records")}
        </button>
      </div>
      {tab === "tasks" ? (
        <div className="schedule-job-list">
          {jobs.map((job) => (
            <div className={`schedule-job-card ${job.enabled ? "" : "is-disabled"}`} key={job.id}>
              <div className="schedule-job-main">
                <div className="schedule-job-title-row">
                  <ClockCircleOutlined className="schedule-job-icon" />
                  <strong>{job.title || t("Untitled task")}</strong>
                  <Tag color={job.enabled ? "blue" : "default"}>{job.enabled ? t("Enabled") : t("Disabled")}</Tag>
                </div>
                <div className="schedule-job-schedule">{formatSchedule(job, t)}</div>
                <div className="schedule-job-meta">
                  {job.lastRunAt ? (
                    <span>{t("Last run: {time}", { time: formatDateTime(job.lastRunAt) })}</span>
                  ) : (
                    <span>{t("Never run")}</span>
                  )}
                  {job.nextRunAt ? <span>{t("Next run: {time}", { time: formatDateTime(job.nextRunAt) })}</span> : null}
                </div>
              </div>
              <div className="schedule-job-actions">
                <Button
                  type="text"
                  icon={<EditOutlined />}
                  onClick={() => onEditSchedule(job)}
                  aria-label={t("Edit scheduled task")}
                />
                <Switch
                  checked={job.enabled}
                  loading={busyId === `toggle:${job.id}`}
                  onChange={() => void toggleJob(job)}
                  aria-label={t("Toggle scheduled task")}
                />
                <Popconfirm title={t("Delete scheduled task?")} onConfirm={() => void deleteJob(job)}>
                  <Button
                    danger
                    type="text"
                    icon={<DeleteOutlined />}
                    loading={busyId === `delete:${job.id}`}
                    aria-label={t("Delete scheduled task?")}
                  />
                </Popconfirm>
              </div>
            </div>
          ))}
          {!jobs.length ? (
            <Empty
              className="schedule-empty"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t("No scheduled tasks yet")}
            />
          ) : null}
        </div>
      ) : (
        <div className="schedule-records">
          {runGroups.length ? (
            <>
              <div className="schedule-record-tree">
                {runGroups.map((group) => {
                  const collapsed = !!collapsedGroups[group.scheduledJobId];
                  return (
                    <div className="schedule-record-group" key={group.scheduledJobId}>
                      <button
                        type="button"
                        className="schedule-record-group-header"
                        onClick={() => toggleGroup(group.scheduledJobId)}
                        aria-expanded={!collapsed}
                      >
                        {collapsed ? <RightOutlined /> : <DownOutlined />}
                        <span className="schedule-record-group-title">{group.title}</span>
                        <span className="schedule-record-group-count">{group.runs.length}</span>
                      </button>
                      {!collapsed
                        ? group.runs.map((run) => (
                            <button
                              type="button"
                              key={run.id}
                              className={`schedule-record-leaf ${run.id === selectedRunId ? "is-active" : ""}`}
                              onClick={() => setSelectedRunId(run.id)}
                            >
                              <ScheduleRunStatusIcon status={run.status} />
                              <span className="schedule-record-leaf-time">{formatDateTime(scheduleRunTime(run))}</span>
                            </button>
                          ))
                        : null}
                    </div>
                  );
                })}
              </div>
              {selectedRun ? (
                <ScheduleRunDetail
                  key={selectedRun.id}
                  job={selectedRun}
                  preview={
                    snapshot.conversations.find((conversation) => conversation.id === selectedRun.conversationId)
                      ?.lastMessagePreview
                  }
                  t={t}
                />
              ) : null}
            </>
          ) : (
            <Empty className="schedule-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No run records")} />
          )}
        </div>
      )}
    </section>
  );
}

function ScheduleRunStatusIcon({ status }: { status: AgentJob["status"] }) {
  const success = status === "completed";
  return (
    <span className={`schedule-log-status ${success ? "is-success" : status === "failed" ? "is-error" : ""}`}>
      {success ? <CheckCircleOutlined /> : status === "failed" ? <CloseCircleOutlined /> : <ClockCircleOutlined />}
    </span>
  );
}

function ScheduleRunDetail({ job, preview, t }: { job: AgentJob; preview?: string; t: Translator }) {
  const [reply, setReply] = useState<{ loading: boolean; message?: ChatMessage }>({ loading: true });

  useEffect(() => {
    const previewMessage: ChatMessage | undefined = preview
      ? {
          id: `preview-${job.id}`,
          conversationId: job.conversationId,
          role: "assistant",
          text: preview,
          createdAt: job.finishedAt || job.createdAt,
        }
      : undefined;
    let cancelled = false;
    setReply({ loading: true });
    window.supbot
      .loadConversationHistory(job.conversationId, undefined, 50)
      .then((page) => {
        if (cancelled) {
          return;
        }
        const message = [...page.messages].reverse().find((item) => item.jobId === job.id && item.role === "assistant");
        setReply({ loading: false, message: message || previewMessage });
      })
      .catch(() => {
        if (!cancelled) {
          setReply({ loading: false, message: previewMessage });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [job.id, job.conversationId, job.status, job.createdAt, job.finishedAt, preview]);

  const finished = job.status === "completed" || job.status === "failed" || job.status === "canceled";
  return (
    <div className="schedule-record-detail">
      <div className="schedule-record-detail-head">
        <Tag color={statusColor(job.status)}>{statusLabel(job.status, t)}</Tag>
        <span className="schedule-record-detail-time">
          {finished
            ? `${t("Finished at")}: ${formatDateTime(job.finishedAt)}`
            : `${t("Started at")}: ${formatDateTime(job.startedAt || job.createdAt)}`}
        </span>
      </div>
      <div className="schedule-log-prompt" title={job.prompt}>
        {job.prompt.slice(0, 160)}
      </div>
      {job.error ? <div className="schedule-log-error">{job.error.slice(0, 300)}</div> : null}
      <div className="schedule-record-detail-label">{t("Final reply")}</div>
      {reply.loading ? (
        <div className="schedule-record-detail-muted">{t("Loading...")}</div>
      ) : reply.message ? (
        <div className="schedule-record-reply">
          <MessageBubble message={reply.message} t={t} />
        </div>
      ) : (
        <div className="schedule-record-detail-muted">{t("No final reply")}</div>
      )}
    </div>
  );
}

export function AutopilotMenuView({
  snapshot,
  refresh,
  onClose,
  t,
}: {
  snapshot: RuntimeSnapshot;
  refresh: () => void;
  onClose: () => void;
  t: Translator;
}) {
  return (
    <section className="menu-workspace autodrive-workspace">
      <div className="menu-workspace-header">
        <div>
          <div className="eyebrow">
            <ThunderboltOutlined /> {t("AUTOPILOT")}
          </div>
        </div>
        <Space>
          <Tag color={snapshot.autopilotRuns.some((run) => run.status === "running") ? "blue" : "default"}>
            {t(snapshot.status)}
          </Tag>
          <Button icon={<CloseOutlined />} onClick={onClose}>
            {t("Close")}
          </Button>
        </Space>
      </div>
      <AutopilotPanel snapshot={snapshot} refresh={refresh} t={t} />
    </section>
  );
}
