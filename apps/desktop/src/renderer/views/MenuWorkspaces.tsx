import { useMemo, useState } from "react";
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  PlusOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { Button, Empty, Popconfirm, Switch, Tag, Typography, message } from "antd";
import type { AgentJob, RuntimeSnapshot, ScheduledJob } from "@supbot/shared";
import { formatDateTime, formatSchedule } from "@supbot/shared";
import { AutopilotPanel } from "../components/AutopilotPanel";
import type { Translator } from "../lib/types";

export function ScheduleMenuView({
  snapshot,
  refresh,
  onCreateSchedule,
  t,
}: {
  snapshot: RuntimeSnapshot;
  refresh: () => void;
  onCreateSchedule: () => void;
  t: Translator;
}) {
  const [tab, setTab] = useState<"tasks" | "logs">("tasks");
  const [busyId, setBusyId] = useState("");
  const [messageApi, contextHolder] = message.useMessage();
  const jobs = snapshot.scheduledJobs || [];
  const recentRuns = useMemo(
    () => [...(snapshot.jobs || [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20),
    [snapshot.jobs],
  );

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
          <Typography.Title level={4}>{t("Scheduled tasks")}</Typography.Title>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={onCreateSchedule}>
          {t("Create scheduled task")}
        </Button>
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
        <div className="schedule-log-list">
          {recentRuns.map((job) => (
            <ScheduleRunRecord key={job.id} job={job} t={t} />
          ))}
          {!recentRuns.length ? (
            <Empty className="schedule-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No run records")} />
          ) : null}
        </div>
      )}
    </section>
  );
}

function ScheduleRunRecord({ job, t }: { job: AgentJob; t: Translator }) {
  const success = job.status === "completed";
  return (
    <div className="schedule-log-card">
      <div className="schedule-log-head">
        <span className={`schedule-log-status ${success ? "is-success" : job.status === "failed" ? "is-error" : ""}`}>
          {success ? (
            <CheckCircleOutlined />
          ) : job.status === "failed" ? (
            <CloseCircleOutlined />
          ) : (
            <ClockCircleOutlined />
          )}
        </span>
        <strong>{t(job.status)}</strong>
        <span className="schedule-log-time">{formatDateTime(job.createdAt)}</span>
      </div>
      <div className="schedule-log-prompt" title={job.prompt}>
        {job.prompt.slice(0, 160)}
      </div>
      {job.error ? <div className="schedule-log-error">{job.error.slice(0, 300)}</div> : null}
    </div>
  );
}

export function AutopilotMenuView({
  snapshot,
  refresh,
  t,
}: {
  snapshot: RuntimeSnapshot;
  refresh: () => void;
  t: Translator;
}) {
  return (
    <section className="menu-workspace autodrive-workspace">
      <div className="menu-workspace-header">
        <div>
          <div className="eyebrow">
            <ThunderboltOutlined /> {t("AUTOPILOT")}
          </div>
          <Typography.Title level={4}>{t("Autopilot runs")}</Typography.Title>
        </div>
        <Tag color={snapshot.autopilotRuns.some((run) => run.status === "running") ? "blue" : "default"}>
          {t(snapshot.status)}
        </Tag>
      </div>
      <AutopilotPanel snapshot={snapshot} refresh={refresh} t={t} />
    </section>
  );
}
