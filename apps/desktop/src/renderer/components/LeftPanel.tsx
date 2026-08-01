import { useMemo, useState } from "react";
import {
  CloseOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  EllipsisOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  InboxOutlined,
  PlusOutlined,
  PushpinOutlined,
  RightOutlined,
} from "@ant-design/icons";
import { Button, Dropdown, Form, Input, Modal, Popconfirm, Tooltip, message } from "antd";
import type { Conversation, Project, ProjectUpdateInput, RuntimeSnapshot } from "@supbot/shared";
import { conversationTitle, formatDateTime } from "@supbot/shared";
import type { Language } from "../i18n";
import { SettingsMenu } from "./SettingsMenu";

export const projectConversationPreviewLimit = 5;

export function LeftPanel({
  snapshot,
  activeConversationId,
  setActiveConversationId,
  activeProjectId,
  setActiveProjectId,
  collapsed,
  refresh,
  startNewConversation,
  language,
  setLanguage,
  openConfig,
  t,
}: {
  snapshot: RuntimeSnapshot;
  activeConversationId: string;
  setActiveConversationId: (id: string) => void;
  activeProjectId: string;
  setActiveProjectId: (id: string) => void;
  collapsed: boolean;
  refresh: () => void;
  startNewConversation: (projectId?: string | null) => Promise<void>;
  language: Language;
  setLanguage: (language: Language) => void;
  openConfig: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectFolder, setProjectFolder] = useState("");
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [pickingProjectFolder, setPickingProjectFolder] = useState(false);
  const [editingProject, setEditingProject] = useState<Project>();
  const [savingProject, setSavingProject] = useState(false);
  const [projectAction, setProjectAction] = useState("");
  const [editProjectForm] = Form.useForm<{ name: string }>();
  const [messageApi, messageContextHolder] = message.useMessage();
  const [modalApi, modalContextHolder] = Modal.useModal();

  const resetNewConversationForm = () => {
    setProjectName("");
    setProjectFolder("");
  };

  const pickProjectFolder = async () => {
    setPickingProjectFolder(true);
    try {
      const folder = await window.supbot.pickProjectFolder();
      if (folder) {
        setProjectFolder(folder);
      }
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setPickingProjectFolder(false);
    }
  };

  const createConversation = async () => {
    if (creatingConversation || pickingProjectFolder) {
      return;
    }
    setCreatingConversation(true);
    try {
      const name = projectName.trim();
      const rootPath = projectFolder.trim();
      if (rootPath) {
        const project = await window.supbot.createProjectFromFolder({
          rootPath,
          name: name || undefined,
        });
        await startNewConversation(project.id);
      } else if (!name) {
        await startNewConversation(null);
      } else {
        const project = await window.supbot.createProjectFromName({ name });
        await startNewConversation(project.id);
      }
      setNewConversationOpen(false);
      resetNewConversationForm();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setCreatingConversation(false);
    }
  };

  const updateProject = async (project: Project, input: ProjectUpdateInput, action: string, successMessage: string) => {
    if (projectAction) {
      return;
    }
    setProjectAction(`${action}:${project.id}`);
    try {
      await window.supbot.updateProject(project.id, input);
      await refresh();
      messageApi.success(t(successMessage));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setProjectAction("");
    }
  };

  const openProjectFolder = async (project: Project) => {
    if (projectAction) {
      return;
    }
    setProjectAction(`open:${project.id}`);
    try {
      await window.supbot.openProject(project.id);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setProjectAction("");
    }
  };

  const openProjectEditor = (project: Project) => {
    editProjectForm.setFieldsValue({ name: project.name });
    setEditingProject(project);
  };

  const saveProject = async () => {
    if (!editingProject || savingProject) {
      return;
    }
    const values = await editProjectForm.validateFields();
    setSavingProject(true);
    try {
      await window.supbot.updateProject(editingProject.id, { name: values.name.trim() });
      await refresh();
      setEditingProject(undefined);
      messageApi.success(t("Project updated."));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSavingProject(false);
    }
  };

  const confirmRemoveProject = (project: Project) => {
    modalApi.confirm({
      title: t("Remove project?"),
      content: t(
        "This removes the project, its conversations, and related HBClient records. The project folder and its files will not be deleted.",
      ),
      okText: t("Remove"),
      cancelText: t("Cancel"),
      okButtonProps: { danger: true },
      onOk: async () => {
        if (projectAction) {
          return;
        }
        setProjectAction(`remove:${project.id}`);
        try {
          await window.supbot.removeProject(project.id);
          if (activeProjectId === project.id) {
            setActiveProjectId("");
          }
          if (
            snapshot.conversations.some(
              (conversation) => conversation.id === activeConversationId && conversation.projectId === project.id,
            )
          ) {
            setActiveConversationId("");
          }
          await refresh();
          messageApi.success(t("Project removed."));
        } catch (error) {
          messageApi.error((error as Error).message);
          throw error;
        } finally {
          setProjectAction("");
        }
      },
    });
  };

  return (
    <>
      {messageContextHolder}
      {modalContextHolder}
      <aside className={`side-panel ${collapsed ? "is-collapsed" : ""}`}>
        <div className="panel-scroll">
          <section className="panel-section">
            <div className="panel-heading">
              <div className="section-title">
                <FolderOpenOutlined /> {t("Projects")}
              </div>
              <Tooltip title={t("New conversation")}>
                <Button
                  size="small"
                  type="primary"
                  icon={<PlusOutlined />}
                  aria-label={t("New conversation")}
                  onClick={() => setNewConversationOpen(true)}
                />
              </Tooltip>
            </div>
            <HistoryPanel
              conversations={snapshot.conversations}
              projects={snapshot.projects}
              activeConversationId={activeConversationId}
              setActiveConversationId={setActiveConversationId}
              activeProjectId={activeProjectId}
              setActiveProjectId={setActiveProjectId}
              refresh={refresh}
              startNewConversation={startNewConversation}
              projectAction={projectAction}
              onPinProject={(project) =>
                updateProject(
                  project,
                  { pinned: !project.pinnedAt },
                  "pin",
                  project.pinnedAt ? "Project unpinned." : "Project pinned.",
                )
              }
              onOpenProject={(project) => void openProjectFolder(project)}
              onEditProject={openProjectEditor}
              onArchiveProject={(project) =>
                updateProject(
                  project,
                  { status: project.status === "archived" ? "active" : "archived" },
                  "archive",
                  project.status === "archived" ? "Project restored." : "Project archived.",
                )
              }
              onRemoveProject={confirmRemoveProject}
              t={t}
              embedded
            />
          </section>
        </div>
        <footer className="side-panel-footer">
          <SettingsMenu
            snapshot={snapshot}
            language={language}
            setLanguage={setLanguage}
            openConfig={openConfig}
            collapsed={collapsed}
            t={t}
          />
        </footer>
      </aside>
      <Modal
        open={newConversationOpen}
        title={t("New conversation")}
        width={420}
        okText={t(
          projectName.trim() || projectFolder.trim()
            ? "Create project and start conversation"
            : "Create unfiled conversation",
        )}
        confirmLoading={creatingConversation}
        onOk={() => void createConversation()}
        onCancel={() => {
          if (!creatingConversation && !pickingProjectFolder) {
            setNewConversationOpen(false);
            resetNewConversationForm();
          }
        }}
      >
        <Form layout="vertical" onFinish={() => void createConversation()}>
          <Form.Item label={t("Project name")}>
            <Input
              autoFocus
              maxLength={80}
              value={projectName}
              placeholder={t(
                projectFolder.trim()
                  ? "Leave blank to use the folder name"
                  : "Leave blank to create an unfiled conversation",
              )}
              onChange={(event) => setProjectName(event.target.value)}
            />
          </Form.Item>
          <Form.Item label={t("Project folder")} style={{ marginBottom: 0 }}>
            <div className="project-folder-picker">
              <Input
                value={projectFolder}
                allowClear
                readOnly
                placeholder={t("Optional: choose a project folder")}
                onChange={(event) => setProjectFolder(event.target.value)}
              />
              <Tooltip title={t("Choose project folder")}>
                <Button
                  icon={<FolderOpenOutlined />}
                  aria-label={t("Choose project folder")}
                  loading={pickingProjectFolder}
                  disabled={creatingConversation}
                  onClick={() => void pickProjectFolder()}
                />
              </Tooltip>
            </div>
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        open={Boolean(editingProject)}
        title={t("Edit project")}
        width={420}
        okText={t("Save")}
        cancelText={t("Cancel")}
        confirmLoading={savingProject}
        onOk={() => void saveProject()}
        onCancel={() => {
          if (!savingProject) {
            setEditingProject(undefined);
            editProjectForm.resetFields();
          }
        }}
      >
        <Form form={editProjectForm} layout="vertical" onFinish={() => void saveProject()}>
          <Form.Item
            name="name"
            label={t("Project name")}
            rules={[
              { required: true, whitespace: true, message: t("Project name is required.") },
              { max: 80, message: t("Project name must be 80 characters or fewer.") },
            ]}
          >
            <Input autoFocus maxLength={80} />
          </Form.Item>
          <Form.Item label={t("Project folder")} style={{ marginBottom: 0 }}>
            <Input value={editingProject?.rootPath || ""} readOnly />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

export function HistoryPanel({
  conversations,
  projects,
  activeConversationId,
  setActiveConversationId,
  activeProjectId,
  setActiveProjectId,
  refresh,
  startNewConversation,
  projectAction = "",
  onPinProject,
  onOpenProject,
  onEditProject,
  onArchiveProject,
  onRemoveProject,
  t,
  embedded = false,
}: {
  conversations: Conversation[];
  projects: Project[];
  activeConversationId: string;
  setActiveConversationId: (id: string) => void;
  activeProjectId: string;
  setActiveProjectId: (id: string) => void;
  refresh: () => void;
  startNewConversation: (projectId?: string | null) => Promise<void>;
  projectAction?: string;
  onPinProject?: (project: Project) => Promise<void> | void;
  onOpenProject?: (project: Project) => void;
  onEditProject?: (project: Project) => void;
  onArchiveProject?: (project: Project) => Promise<void> | void;
  onRemoveProject?: (project: Project) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  embedded?: boolean;
}) {
  const conversationsByProject = useMemo(() => {
    const projectIds = new Set(projects.map((project) => project.id));
    const grouped = new Map<string, Conversation[]>();
    for (const conversation of conversations) {
      const projectId = conversation.projectId && projectIds.has(conversation.projectId) ? conversation.projectId : "";
      const group = grouped.get(projectId) || [];
      group.push(conversation);
      grouped.set(projectId, group);
    }
    return grouped;
  }, [conversations, projects]);

  const selectConversation = (conversation: Conversation) => {
    setActiveProjectId(conversation.projectId || "");
    setActiveConversationId(conversation.id);
  };

  return (
    <div className={`history-list ${embedded ? "is-embedded" : ""}`}>
      {projects.map((project) => (
        <ProjectConversationGroup
          key={project.id}
          project={project}
          conversations={conversationsByProject.get(project.id) || []}
          activeConversationId={activeConversationId}
          activeProjectId={activeProjectId}
          onSelectProject={setActiveProjectId}
          onSelectConversation={selectConversation}
          onCreateConversation={startNewConversation}
          projectAction={projectAction}
          onPinProject={onPinProject}
          onOpenProject={onOpenProject}
          onEditProject={onEditProject}
          onArchiveProject={onArchiveProject}
          onRemoveProject={onRemoveProject}
          refresh={refresh}
          t={t}
        />
      ))}
      <ProjectConversationGroup
        conversations={conversationsByProject.get("") || []}
        activeConversationId={activeConversationId}
        activeProjectId={activeProjectId}
        onSelectProject={setActiveProjectId}
        onSelectConversation={selectConversation}
        onCreateConversation={startNewConversation}
        refresh={refresh}
        t={t}
      />
    </div>
  );
}

export function ProjectConversationGroup({
  project,
  conversations,
  activeConversationId,
  activeProjectId,
  onSelectProject,
  onSelectConversation,
  onCreateConversation,
  projectAction = "",
  onPinProject,
  onOpenProject,
  onEditProject,
  onArchiveProject,
  onRemoveProject,
  refresh,
  t,
}: {
  project?: Project;
  conversations: Conversation[];
  activeConversationId: string;
  activeProjectId: string;
  onSelectProject: (id: string) => void;
  onSelectConversation: (conversation: Conversation) => void;
  onCreateConversation: (projectId?: string | null) => Promise<void>;
  projectAction?: string;
  onPinProject?: (project: Project) => Promise<void> | void;
  onOpenProject?: (project: Project) => void;
  onEditProject?: (project: Project) => void;
  onArchiveProject?: (project: Project) => Promise<void> | void;
  onRemoveProject?: (project: Project) => void;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [creating, setCreating] = useState(false);
  const projectId = project?.id || "";
  const title = project?.name || t("Unfiled");
  const archived = project?.status === "archived";
  const hasHiddenConversations = conversations.length > projectConversationPreviewLimit;
  const visibleConversations = showAll ? conversations : conversations.slice(0, projectConversationPreviewLimit);
  const projectBusy = Boolean(project && projectAction.endsWith(`:${project.id}`));
  const projectMenuItems = project
    ? [
        {
          key: "pin",
          icon: <PushpinOutlined />,
          label: t(project.pinnedAt ? "Unpin project" : "Pin project"),
        },
        {
          key: "open",
          icon: <FolderOpenOutlined />,
          label: t("Open in File Explorer"),
        },
        {
          key: "edit",
          icon: <EditOutlined />,
          label: t("Edit project"),
        },
        {
          key: "archive",
          icon: <InboxOutlined />,
          label: t(archived ? "Restore project" : "Archive project"),
        },
        { type: "divider" as const },
        {
          key: "remove",
          danger: true,
          icon: <CloseOutlined />,
          label: t("Remove"),
        },
      ]
    : [];

  const selectProjectAction = (key: string) => {
    if (!project || projectBusy) {
      return;
    }
    if (key === "pin") {
      void onPinProject?.(project);
    } else if (key === "open") {
      onOpenProject?.(project);
    } else if (key === "edit") {
      onEditProject?.(project);
    } else if (key === "archive") {
      void onArchiveProject?.(project);
    } else if (key === "remove") {
      onRemoveProject?.(project);
    }
  };

  const createConversation = async () => {
    setCreating(true);
    try {
      await onCreateConversation(project?.id || null);
    } finally {
      setCreating(false);
    }
  };

  return (
    <section
      className={`project-history-group ${activeProjectId === projectId ? "is-active" : ""} ${archived ? "is-archived" : ""}`}
    >
      <div className={`project-history-heading ${project ? "has-menu" : ""}`}>
        <Tooltip title={t(collapsed ? "Expand project" : "Collapse project")}>
          <Button
            type="text"
            size="small"
            className="project-history-toggle"
            icon={collapsed ? <RightOutlined /> : <DownOutlined />}
            aria-label={t(collapsed ? "Expand project" : "Collapse project")}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          />
        </Tooltip>
        <button className="project-history-title" type="button" onClick={() => onSelectProject(projectId)}>
          {collapsed ? <FolderOutlined /> : <FolderOpenOutlined />}
          <strong title={title}>{title}</strong>
          <span>{conversations.length}</span>
        </button>
        <Tooltip
          title={archived ? t("Archived project") : t(project ? "New project conversation" : "New conversation")}
        >
          <Button
            type="text"
            size="small"
            className="project-history-add"
            icon={<PlusOutlined />}
            aria-label={t(project ? "New project conversation" : "New conversation")}
            disabled={archived}
            loading={creating}
            onClick={() => void createConversation()}
          />
        </Tooltip>
        {project ? (
          <Dropdown
            trigger={["click"]}
            placement="bottomRight"
            menu={{ items: projectMenuItems, onClick: ({ key }) => selectProjectAction(key) }}
            disabled={projectBusy}
          >
            <Tooltip title={t("Project actions")}>
              <Button
                type="text"
                size="small"
                className="project-history-menu"
                icon={<EllipsisOutlined />}
                aria-label={t("Project actions")}
                data-testid={`project-actions-${project.id}`}
                loading={projectBusy}
              />
            </Tooltip>
          </Dropdown>
        ) : null}
      </div>
      {collapsed ? null : (
        <div className="project-conversation-list">
          {visibleConversations.map((conversation) => (
            <div
              className={`activity-item history-item ${conversation.id === activeConversationId ? "is-active" : ""}`}
              key={conversation.id}
            >
              <button className="history-item-content" type="button" onClick={() => onSelectConversation(conversation)}>
                <strong>{conversationTitle(conversation, t("New conversation"))}</strong>
                <span className="muted">
                  {formatDateTime(conversation.lastMessageAt || conversation.updatedAt)} ·{" "}
                  {conversation.messageCount || 0} {t((conversation.messageCount || 0) === 1 ? "message" : "messages")}
                </span>
              </button>
              <Popconfirm
                title={t("Delete conversation?")}
                onConfirm={async () => {
                  await window.supbot.deleteConversation(conversation.id);
                  await refresh();
                }}
              >
                <Button
                  size="small"
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label={t("Delete conversation?")}
                />
              </Popconfirm>
            </div>
          ))}
          {!conversations.length ? (
            <div className="project-history-empty">{t("No conversations in this project")}</div>
          ) : null}
          {hasHiddenConversations ? (
            <button className="project-history-more" type="button" onClick={() => setShowAll((value) => !value)}>
              {showAll ? t("Collapse display") : t("Expand display")}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
