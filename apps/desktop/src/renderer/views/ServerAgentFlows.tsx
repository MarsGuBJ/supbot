import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  DownloadOutlined,
  OrderedListOutlined,
  PaperClipOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  RobotOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from "antd";
import type { FormInstance } from "antd/es/form";
import type {
  IdentityContext,
  ServstationAutopilotRun,
  ServstationClientSnapshot,
  ServstationFlowEngineExecutionEvent,
  ServstationFlowEngineInitiatedExecution,
  ServstationFlowEngineSnapshot,
  ServstationScheduledJob,
} from "@supbot/shared";
import { formatDateTime } from "@supbot/shared";
import {
  servstationAutopilotControls,
  servstationAutopilotDecisionReason,
  servstationAutopilotEvidenceCount,
  servstationAutopilotLatestStep,
} from "../servstationAutopilot";
import {
  buildDefaultFlowInput,
  coerceFlowInputValues,
  downloadFlowFilePayload,
  fileToFlowFilePayload,
  formatBytesFromBase64,
  getFlowInputFields,
  isFlowFilePayload,
  parseFlowInputJson,
  shouldUseJsonFlowInput,
  type FlowFilePayload,
  type FlowInputField,
  type FlowJsonSchema,
  type FlowLaunchFormValues,
} from "../lib/flowSchema";
import { formatMessageTime, servstationScheduleLabel, servstationStatusColor } from "../lib/servstationFormat";
import type { Translator } from "../lib/types";

export function ServerAgentFlows({
  scheduledJobs,
  autopilotRun,
  autopilotEvents,
  autopilotSteps,
  autopilotPrompt,
  disabled,
  busyId,
  setAutopilotPrompt,
  onCreateSchedule,
  onToggleSchedule,
  onDeleteSchedule,
  onStartAutopilot,
  onUpdateAutopilot,
  t,
}: {
  scheduledJobs: ServstationScheduledJob[];
  autopilotRun: ServstationAutopilotRun | null;
  autopilotEvents: NonNullable<ServstationClientSnapshot["autopilotEvents"]>;
  autopilotSteps: NonNullable<ServstationClientSnapshot["autopilotSteps"]>;
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
  const controls = servstationAutopilotControls(autopilotRun);
  const latestStep = servstationAutopilotLatestStep(autopilotSteps);
  const evidence = servstationAutopilotEvidenceCount(autopilotRun);
  const activeTarget = autopilotRun?.activeTargetId || "-";
  const currentJob = autopilotRun?.currentJobId || latestStep?.jobId || "-";
  const latestEvent = autopilotEvents[0];
  const latestDecision = latestStep
    ? servstationAutopilotDecisionReason(latestStep)
    : autopilotRun?.lastDecision?.reason;
  const submitDisabled = disabled || controls.promptLocked || !autopilotPrompt.trim();

  return (
    <div className="server-agent-flow-grid">
      <section className="server-agent-flow-column">
        <div className="panel-heading">
          <div className="section-title">
            <CalendarOutlined /> {t("Schedule")}
          </div>
          <Button size="small" type="primary" icon={<PlusOutlined />} disabled={disabled} onClick={onCreateSchedule}>
            {t("New scheduled prompt")}
          </Button>
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
                <Button
                  size="small"
                  loading={busyId === `schedule:${job.id}`}
                  onClick={() => void onToggleSchedule(job)}
                >
                  {job.enabled ? t("Disable") : t("Enable")}
                </Button>
                <Popconfirm title={t("Delete scheduled prompt?")} onConfirm={() => void onDeleteSchedule(job)}>
                  <Button size="small" danger icon={<DeleteOutlined />} loading={busyId === `schedule:${job.id}`}>
                    {t("Delete")}
                  </Button>
                </Popconfirm>
              </Space>
            </div>
          ))}
          {!scheduledJobs.length ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No scheduled prompts")} />
          ) : null}
        </div>
      </section>
      <section className="server-agent-flow-column">
        <div className="panel-heading">
          <div className="section-title">
            <RobotOutlined /> {t("Autopilot")}
          </div>
          {autopilotRun ? (
            <Tag color={servstationStatusColor(autopilotRun.status)}>{t(autopilotRun.status)}</Tag>
          ) : null}
        </div>
        <div className="server-agent-autopilot">
          <div className="server-agent-autopilot-composer">
            <Input.TextArea
              value={autopilotPrompt}
              disabled={disabled || controls.promptLocked}
              autoSize={{ minRows: 3, maxRows: 6 }}
              placeholder={t("Describe the outcome for the server Agent...")}
              onChange={(event) => setAutopilotPrompt(event.target.value)}
              onPressEnter={(event) => {
                if (!event.shiftKey && !submitDisabled) {
                  event.preventDefault();
                  void onStartAutopilot();
                }
              }}
            />
            <Space wrap>
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                disabled={submitDisabled}
                loading={busyId === "autopilot:start"}
                onClick={() => void onStartAutopilot()}
              >
                {t("Submit prompt")}
              </Button>
              {controls.canResume ? (
                <Button
                  icon={<PlayCircleOutlined />}
                  disabled={disabled || !controls.canResume}
                  loading={busyId === "autopilot:watching"}
                  onClick={() => void onUpdateAutopilot("watching")}
                >
                  {t("Resume")}
                </Button>
              ) : (
                <Button
                  icon={<PauseCircleOutlined />}
                  disabled={disabled || !controls.canPause}
                  loading={busyId === "autopilot:paused"}
                  onClick={() => void onUpdateAutopilot("paused")}
                >
                  {t("Pause")}
                </Button>
              )}
              <Button
                danger
                icon={<StopOutlined />}
                disabled={disabled || !controls.canStop}
                loading={busyId === "autopilot:stopped"}
                onClick={() => void onUpdateAutopilot("stopped")}
              >
                {t("Stop")}
              </Button>
            </Space>
          </div>
          {autopilotRun ? (
            <div className="server-agent-autopilot-run">
              <div className="server-agent-autopilot-goal">
                <span>{t("Goal")}</span>
                <strong>{autopilotRun.goal || t("Waiting for the server Agent to derive a goal")}</strong>
              </div>
              <div className="server-agent-autopilot-stats">
                <div>
                  <span>{t("Phase")}</span>
                  <strong>{t(autopilotRun.phase || autopilotRun.status)}</strong>
                </div>
                <div>
                  <span>{t("Steps")}</span>
                  <strong>
                    {autopilotRun.stepCount ?? autopilotSteps.length}/{autopilotRun.maxSteps ?? "-"}
                  </strong>
                </div>
                <div>
                  <span>{t("Evidence")}</span>
                  <strong>
                    {evidence.met}/{evidence.total}
                  </strong>
                </div>
                <div>
                  <span>{t("Retries")}</span>
                  <strong>{autopilotRun.totalRetries || 0}</strong>
                </div>
              </div>
              <div className="server-agent-autopilot-targets">
                <div>
                  <span>{t("Active target")}</span>
                  <code>{activeTarget}</code>
                </div>
                <div>
                  <span>{t("Current job")}</span>
                  <code>{currentJob}</code>
                </div>
              </div>
              {latestStep ? (
                <div className="server-agent-autopilot-highlight">
                  <span>{t("Latest step")}</span>
                  <strong>
                    #{latestStep.sequence} {latestStep.kind} / {t(latestStep.status)}
                  </strong>
                </div>
              ) : null}
              <div className="server-agent-autopilot-highlight">
                <span>{t("Latest event")}</span>
                <strong>{latestEvent?.message || autopilotRun.failureMessage || "-"}</strong>
              </div>
              {latestDecision ? (
                <div className="server-agent-autopilot-highlight">
                  <span>{t("Decision")}</span>
                  <strong>{latestDecision}</strong>
                </div>
              ) : null}
              {autopilotRun.failureMessage ? (
                <Alert type="error" showIcon message={autopilotRun.failureMessage} />
              ) : null}
            </div>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("Waiting for an Autopilot prompt")} />
          )}
          <div className="server-agent-autopilot-details">
            <section>
              <div className="section-title">
                <OrderedListOutlined /> {t("Steps")}
              </div>
              <div className="server-agent-autopilot-step-list">
                {autopilotSteps.slice(0, 10).map((step) => {
                  const reason = servstationAutopilotDecisionReason(step);
                  return (
                    <div className="server-agent-autopilot-step" key={step.id}>
                      <div className="activity-head">
                        <strong>
                          #{step.sequence} {step.kind}
                        </strong>
                        <Tag color={servstationStatusColor(step.status)}>{t(step.status)}</Tag>
                      </div>
                      <div className="server-agent-autopilot-step-meta">
                        <span>
                          {t("Attempt")} {step.attempt}
                        </span>
                        {step.jobId ? <code>{step.jobId}</code> : null}
                        <span>{formatDateTime(step.updatedAt)}</span>
                      </div>
                      {reason ? <small>{reason}</small> : null}
                      {step.errorClass ? <small className="danger-text">{step.errorClass}</small> : null}
                    </div>
                  );
                })}
                {!autopilotSteps.length ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No Autopilot steps yet")} />
                ) : null}
              </div>
            </section>
            <section>
              <div className="section-title">
                <ClockCircleOutlined /> {t("Events")}
              </div>
              <div className="server-agent-event-list">
                {autopilotEvents.slice(0, 10).map((event) => (
                  <div className="runtime-event" key={event.id}>
                    <span>{formatDateTime(event.createdAt)}</span>
                    <small>{event.message || event.eventType}</small>
                  </div>
                ))}
                {!autopilotEvents.length ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No Autopilot events yet")} />
                ) : null}
              </div>
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}

export function ServerAgentFlowWorkspace({
  connected,
  disabled,
  identity,
  onPendingCountChange,
  t,
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
    [launchable, selectedWorkflowId],
  );
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) || tasks[0] || null,
    [tasks, selectedTaskId],
  );
  const selectedExecutionSummary = useMemo(
    () => executions.find((execution) => execution.id === selectedExecutionId) || executions[0] || null,
    [executions, selectedExecutionId],
  );

  const refresh = useCallback(
    async (notify = false) => {
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
        setSelectedWorkflowId((current) =>
          current && next.launchableWorkflows.some((item) => item.id === current)
            ? current
            : next.launchableWorkflows[0]?.id || "",
        );
        setSelectedTaskId((current) =>
          current && next.pendingTasks.some((item) => item.id === current) ? current : next.pendingTasks[0]?.id || null,
        );
        setSelectedExecutionId((current) =>
          current && next.executions.some((item) => item.id === current) ? current : next.executions[0]?.id || null,
        );
        if (notify) {
          messageApi.success(t("Flow refreshed."));
        }
      } catch (error) {
        messageApi.error((error as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [connected, messageApi, onPendingCountChange, t],
  );

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
      window.supbot.getServstationFlowEngineExecutionEvents(executionId),
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
        : await launchForm
            .validateFields()
            .then((values) => coerceFlowInputValues(values, selectedWorkflow.inputSchema));
      setActionLoading(true);
      const execution = await window.supbot.launchServstationFlowEngineWorkflow({
        workflowId: selectedWorkflow.id,
        input,
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
        comment: approvalComment,
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
          <div className="muted">
            {identity
              ? `${identity.userId} / ${identity.organizationId}/${identity.departmentId}`
              : t("Servstation identity is missing.")}
          </div>
        </div>
        <Space wrap>
          <Tag color="gold">
            {t("Pending approvals")}: {tasks.length}
          </Tag>
        </Space>
      </div>

      {!connected ? <Alert type="warning" showIcon message={t("Servstation reverse A2A is not connected.")} /> : null}

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
                <Button
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  disabled={disabled || !selectedWorkflowId}
                  onClick={openSelectedLaunchForm}
                >
                  {t("Launch")}
                </Button>
              </>
            ) : (
              <div className="server-agent-mail-empty">
                {connected ? t("No launchable workflows") : t("Servstation reverse A2A is not connected.")}
              </div>
            )}
          </section>

          <section className="server-agent-engine-panel-section">
            <div className="server-agent-engine-section-head">
              <strong>{t("Pending approvals")}</strong>
              {tasks.length ? <Tag color="gold">{tasks.length}</Tag> : null}
            </div>
            <div className="server-agent-engine-list">
              {tasks.length ? (
                tasks.map((task) => (
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
                    <span className="server-agent-mail-preview">
                      {task.instructions || task.approverRoles.join(", ")}
                    </span>
                  </button>
                ))
              ) : (
                <div className="server-agent-mail-empty">{t("No pending approvals")}</div>
              )}
            </div>
          </section>

          <section className="server-agent-engine-panel-section">
            <div className="server-agent-engine-section-head">
              <strong>{t("My flow executions")}</strong>
            </div>
            <div className="server-agent-engine-list">
              {executions.length ? (
                executions.map((execution) => (
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
                ))
              ) : (
                <div className="server-agent-mail-empty">{t("No flow executions")}</div>
              )}
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
                <Button
                  icon={<ApiOutlined />}
                  disabled={disabled}
                  onClick={() => window.open(selectedTask.openUrl, "_blank", "noopener,noreferrer")}
                >
                  {t("Open task")}
                </Button>
              ) : null}
            </div>
            {selectedTask ? (
              <>
                <div className="server-agent-engine-body">
                  {selectedTask.instructions || selectedTask.approverRoles.join(", ")}
                </div>
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
                  <Button
                    type="primary"
                    icon={<CheckCircleOutlined />}
                    loading={actionLoading}
                    disabled={disabled}
                    onClick={() => void decideSelectedTask("approved")}
                  >
                    {t("Approve")}
                  </Button>
                  <Button
                    danger
                    icon={<CloseCircleOutlined />}
                    loading={actionLoading}
                    disabled={disabled}
                    onClick={() => void decideSelectedTask("rejected")}
                  >
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
                    <Descriptions.Item label={t("Created at")}>
                      {formatMessageTime(selectedExecution.createdAt)}
                    </Descriptions.Item>
                    <Descriptions.Item label={t("Started at")}>
                      {formatMessageTime(selectedExecution.startedAt)}
                    </Descriptions.Item>
                    <Descriptions.Item label={t("Finished at")}>
                      {formatMessageTime(selectedExecution.finishedAt)}
                    </Descriptions.Item>
                  </Descriptions>
                  <pre className="server-agent-engine-json">
                    {JSON.stringify(
                      selectedExecution.output ?? selectedExecution.error ?? selectedExecution.input,
                      null,
                      2,
                    )}
                  </pre>
                  <div className="server-agent-engine-timeline">
                    {events.map((event) => (
                      <div key={event.id} className="server-agent-engine-timeline-event">
                        <span>{formatMessageTime(event.createdAt)}</span>
                        <Tag>{event.type}</Tag>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                t("No flow executions")
              )}
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

export function FlowLaunchInputForm({
  disabled,
  form,
  schema,
  t,
  jsonValue,
  jsonError,
  onJsonChange,
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

export function renderFlowInputControl(field: FlowInputField, disabled: boolean, t: Translator) {
  if (field.enumValues?.length) {
    return <Select disabled={disabled} options={field.enumValues.map((value) => ({ label: String(value), value }))} />;
  }
  if (field.kind === "boolean") {
    return (
      <Select
        disabled={disabled}
        options={[
          { label: "true", value: true },
          { label: "false", value: false },
        ]}
      />
    );
  }
  if (field.kind === "number" || field.kind === "integer") {
    return (
      <InputNumber style={{ width: "100%" }} precision={field.kind === "integer" ? 0 : undefined} disabled={disabled} />
    );
  }
  if (field.kind === "file") {
    return <FlowFileInput disabled={disabled} t={t} />;
  }
  return <Input disabled={disabled} />;
}

export function FlowFileInput({
  value,
  onChange,
  disabled,
  t,
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
      <Input
        readOnly
        value={display}
        placeholder={disabled ? "" : t("No file selected")}
        style={{ width: "60%" }}
        disabled={disabled}
      />
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
      <Button
        icon={<PaperClipOutlined />}
        loading={loading}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {loading ? "" : t("Select file")}
      </Button>
    </Space.Compact>
  );
}

export function FlowExecutionInputView({ input, t }: { input?: Record<string, unknown>; t: Translator }) {
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
                <span className="muted">
                  ({t("File size")} {formatBytesFromBase64(value.contentBase64)})
                </span>
                <Button
                  size="small"
                  type="link"
                  icon={<DownloadOutlined />}
                  onClick={() => downloadFlowFilePayload(value)}
                >
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

export function flowEngineStatusTag(status: string | undefined, t: Translator) {
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

export function flowEngineStatusLabel(status: string | undefined, t: Translator): string {
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
    rejected: "Rejected",
  };
  return t(labels[normalized] || status || "Unknown");
}
