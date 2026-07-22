import { useEffect, useState } from "react";
import { FileTextOutlined, FolderOpenOutlined, PlusOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Button, Empty, Form, Input, Modal, Popconfirm, Select, Space, Tag, Tooltip, Typography, message } from "antd";
import type { AutopilotRun, Project, RuntimeSnapshot } from "@supbot/shared";

export function AutopilotPanel({ snapshot, refresh, t }: { snapshot: RuntimeSnapshot; refresh: () => void; t: (key: string, vars?: Record<string, string | number>) => string }) {
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

export function autopilotStatusColor(status: AutopilotRun["status"]): string {
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

export function taskStatusColor(status: string): string {
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
