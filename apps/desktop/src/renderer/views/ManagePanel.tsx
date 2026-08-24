import { useEffect } from "react";
import { CloseOutlined } from "@ant-design/icons";
import type { RuntimeSnapshot, SubagentConfig } from "@supbot/shared";
import { McpServersCard } from "../components/McpServersCard";
import type { Translator } from "../lib/types";
import { ModelConfigCard, SubagentsCard } from "./ConfigWorkspace";

export type ManagePanelTab = "model" | "mcp" | "subagents";

export function ManagePanel({
  open,
  tab,
  setTab,
  snapshot,
  refresh,
  openSubagent,
  onClose,
  t,
}: {
  open: boolean;
  tab: ManagePanelTab;
  setTab: (tab: ManagePanelTab) => void;
  snapshot: RuntimeSnapshot;
  refresh: () => void;
  openSubagent: (subagent: SubagentConfig | null) => void;
  onClose: () => void;
  t: Translator;
}) {
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={`manage-panel-backdrop ${open ? "open" : ""}`} aria-hidden="true" onClick={onClose} />
      <aside className={`manage-panel ${open ? "open" : ""}`} aria-label={t("Manage")}>
        <div className="manage-panel-header">
          <div className="manage-panel-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              className={`manage-panel-tab ${tab === "model" ? "active" : ""}`}
              aria-selected={tab === "model"}
              onClick={() => setTab("model")}
            >
              {t("Model management")}
            </button>
            <button
              type="button"
              role="tab"
              className={`manage-panel-tab ${tab === "mcp" ? "active" : ""}`}
              aria-selected={tab === "mcp"}
              onClick={() => setTab("mcp")}
            >
              {t("MCP management")}
            </button>
            <button
              type="button"
              role="tab"
              className={`manage-panel-tab ${tab === "subagents" ? "active" : ""}`}
              aria-selected={tab === "subagents"}
              onClick={() => setTab("subagents")}
            >
              {t("Subagents")}
            </button>
          </div>
          <button type="button" className="manage-panel-close" onClick={onClose} aria-label={t("Close")}>
            <CloseOutlined />
          </button>
        </div>
        <div className="manage-panel-body">
          {tab === "model" ? <ModelConfigCard snapshot={snapshot} refresh={refresh} t={t} /> : null}
          {tab === "mcp" ? <McpServersCard snapshot={snapshot} refresh={refresh} t={t} /> : null}
          {tab === "subagents" ? (
            <SubagentsCard snapshot={snapshot} refresh={refresh} openSubagent={openSubagent} t={t} />
          ) : null}
        </div>
      </aside>
    </>
  );
}
