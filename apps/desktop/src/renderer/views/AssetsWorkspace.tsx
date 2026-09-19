import { useCallback, useEffect, useRef, useState } from "react";
import { CloseOutlined, DeploymentUnitOutlined } from "@ant-design/icons";
import { Button, Space, Tabs, message } from "antd";
import type { KbDocumentWithProgress, KbProject } from "@supbot/shared";
import type { Translator } from "../lib/types";
import { DocumentsPanel } from "./assets/DocumentsPanel";
import { GraphPanel } from "./assets/GraphPanel";
import { MarkdownPanel } from "./assets/MarkdownPanel";
import { ProjectsPanel } from "./assets/ProjectsPanel";
import { ReviewPanel } from "./assets/ReviewPanel";
import { WikiPanel } from "./assets/WikiPanel";

type AssetsTab = "markdown" | "wiki" | "graph" | "review";

export function AssetsWorkspace({ onClose, t }: { onClose: () => void; t: Translator }) {
  const [messageApi, contextHolder] = message.useMessage();
  const [projects, setProjects] = useState<KbProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [activeProject, setActiveProject] = useState("");
  const [docs, setDocs] = useState<KbDocumentWithProgress[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [tab, setTab] = useState<AssetsTab>("markdown");
  const activeProjectRef = useRef(activeProject);
  activeProjectRef.current = activeProject;

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const list = await window.supbot.kbListProjects();
      setProjects(list);
      setActiveProject((current) => (current && list.some((p) => p.name === current) ? current : list[0]?.name || ""));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setProjectsLoading(false);
    }
  }, [messageApi]);

  const loadDocs = useCallback(async (project: string) => {
    if (!project) {
      setDocs([]);
      return;
    }
    try {
      const list = await window.supbot.kbListDocuments(project);
      if (activeProjectRef.current === project) {
        setDocs(list);
      }
    } catch {
      // Transient reload failures (e.g. project deleted mid-refresh) are non-fatal.
    }
  }, []);

  const refreshDocs = useCallback(async () => {
    if (!activeProject) {
      return;
    }
    setDocsLoading(true);
    try {
      await loadDocs(activeProject);
    } finally {
      setDocsLoading(false);
    }
  }, [activeProject, loadDocs]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    setDocs([]);
    void refreshDocs();
  }, [refreshDocs]);

  // Ingest progress: event-driven refresh plus a conservative poll while tasks are active.
  useEffect(() => {
    return window.supbot.onEvent((event) => {
      if (event.type === "kb_ingest" && event.task.projectId === activeProjectRef.current) {
        void loadDocs(event.task.projectId);
      }
    });
  }, [loadDocs]);

  useEffect(() => {
    const hasActiveTask = docs.some(
      (doc) =>
        doc.task && (doc.task.status === "pending" || doc.task.status === "parsing" || doc.task.status === "ingesting"),
    );
    if (!hasActiveTask || !activeProject) {
      return;
    }
    const timer = window.setTimeout(() => void loadDocs(activeProject), 2500);
    return () => window.clearTimeout(timer);
  }, [docs, activeProject, loadDocs]);

  return (
    <section className="menu-workspace assets-workspace">
      {contextHolder}
      <div className="menu-workspace-header">
        <div>
          <div className="eyebrow">{t("RESOURCE MANAGEMENT")}</div>
        </div>
        <Space>
          <Button
            icon={<DeploymentUnitOutlined />}
            disabled={!activeProject}
            onClick={() => void window.supbot.openWikiGraphWindow(activeProject)}
          >
            {t("Knowledge Graph")}
          </Button>
          <Button onClick={() => void refreshDocs()} disabled={!activeProject}>
            {t("Refresh")}
          </Button>
          <Button icon={<CloseOutlined />} onClick={onClose}>
            {t("Close")}
          </Button>
        </Space>
      </div>
      <div className="assets-layout">
        <ProjectsPanel
          projects={projects}
          loading={projectsLoading}
          activeProject={activeProject}
          onSelect={setActiveProject}
          onChanged={() => void loadProjects()}
          t={t}
          messageApi={messageApi}
        />
        <DocumentsPanel
          project={activeProject}
          docs={docs}
          loading={docsLoading}
          refreshDocs={() => void refreshDocs()}
          t={t}
          messageApi={messageApi}
        />
        <div className="assets-col assets-detail">
          <Tabs
            activeKey={tab}
            onChange={(key) => setTab(key as AssetsTab)}
            items={[
              {
                key: "markdown",
                label: t("Markdown"),
                children: <MarkdownPanel project={activeProject} docs={docs} t={t} messageApi={messageApi} />,
              },
              {
                key: "wiki",
                label: t("Wiki"),
                children: <WikiPanel project={activeProject} t={t} messageApi={messageApi} />,
              },
              {
                key: "graph",
                label: t("Graph templates"),
                children: <GraphPanel project={activeProject} docs={docs} t={t} messageApi={messageApi} />,
              },
              {
                key: "review",
                label: t("Review"),
                children: <ReviewPanel project={activeProject} t={t} messageApi={messageApi} />,
              },
            ]}
          />
        </div>
      </div>
    </section>
  );
}
