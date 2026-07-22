import { useMemo, useState } from "react";
import {
  DeleteOutlined,
  DownOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  PlusOutlined,
  RightOutlined,
} from "@ant-design/icons";
import { Button, Form, Input, Modal, Popconfirm, Tooltip, message } from "antd";
import type { Conversation, Project, RuntimeSnapshot } from "@supbot/shared";
import { conversationTitle, formatDateTime } from "@supbot/shared";

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
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [creatingConversation, setCreatingConversation] = useState(false);
  const createConversation = async () => {
    setCreatingConversation(true);
    try {
      const name = projectName.trim();
      if (!name) {
        await startNewConversation(null);
      } else {
        const project = await window.supbot.createProjectFromName({ name });
        await startNewConversation(project.id);
      }
      setNewConversationOpen(false);
      setProjectName("");
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setCreatingConversation(false);
    }
  };
  return (
    <>
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
              t={t}
              embedded
            />
          </section>
        </div>
      </aside>
      <Modal
        open={newConversationOpen}
        title={t("New conversation")}
        width={420}
        okText={t(projectName.trim() ? "Create project and start conversation" : "Create unfiled conversation")}
        confirmLoading={creatingConversation}
        onOk={() => void createConversation()}
        onCancel={() => {
          if (!creatingConversation) {
            setNewConversationOpen(false);
            setProjectName("");
          }
        }}
      >
        <Form layout="vertical" onFinish={() => void createConversation()}>
          <Form.Item label={t("Project name")} style={{ marginBottom: 0 }}>
            <Input
              autoFocus
              maxLength={80}
              value={projectName}
              placeholder={t("Leave blank to create an unfiled conversation")}
              onChange={(event) => setProjectName(event.target.value)}
            />
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
      <div className="project-history-heading">
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
