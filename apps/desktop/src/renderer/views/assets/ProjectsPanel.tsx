import { useState } from "react";
import { FolderOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Empty, Input, List, Modal, Spin } from "antd";
import type { MessageInstance } from "antd/es/message/interface";
import type { KbProject } from "@supbot/shared";
import type { Translator } from "../../lib/types";

export function ProjectsPanel({
  projects,
  loading,
  activeProject,
  onSelect,
  onChanged,
  t,
  messageApi,
}: {
  projects: KbProject[];
  loading: boolean;
  activeProject: string;
  onSelect: (name: string) => void;
  onChanged: () => void;
  t: Translator;
  messageApi: MessageInstance;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const createProject = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      messageApi.warning(t("Please enter a project name."));
      return;
    }
    setCreating(true);
    try {
      const project = await window.supbot.kbCreateProject(trimmed);
      messageApi.success(t("Project created."));
      setCreateOpen(false);
      setName("");
      onChanged();
      onSelect(project.name);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="assets-col assets-projects">
      <div className="assets-col-header">
        <span className="assets-col-title">{t("Projects")}</span>
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          {t("New project")}
        </Button>
      </div>
      <Spin spinning={loading}>
        {projects.length ? (
          <List
            className="assets-list"
            dataSource={projects}
            renderItem={(project) => (
              <List.Item
                className={`assets-list-item ${project.name === activeProject ? "active" : ""}`}
                onClick={() => onSelect(project.name)}
              >
                <FolderOutlined className="assets-list-icon" />
                <span className="assets-list-text" title={project.name}>
                  {project.name}
                </span>
              </List.Item>
            )}
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No projects yet")} />
        )}
      </Spin>
      <Modal
        title={t("New project")}
        open={createOpen}
        onOk={() => void createProject()}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={creating}
        okText={t("Create")}
        cancelText={t("Cancel")}
        destroyOnHidden
      >
        <Input
          placeholder={t("Project name")}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onPressEnter={() => void createProject()}
          maxLength={64}
        />
      </Modal>
    </div>
  );
}
