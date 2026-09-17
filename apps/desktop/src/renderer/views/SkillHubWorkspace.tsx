import { CloseOutlined, HolderOutlined } from "@ant-design/icons";
import { Button, Empty, Tabs, Tag } from "antd";
import { useRef, useState } from "react";
import type { DragEvent } from "react";
import type { CapabilityDefinition, RuntimeSnapshot, SubagentConfig } from "@supbot/shared";
import { loadSkillOrder, orderSkillsByPreference, saveSkillOrder } from "../lib/skills";
import { MarketWorkspace } from "./MarketWorkspace";

function CapabilityCard({
  title,
  description,
  enabled,
  onClick,
  sortable,
  dragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  t,
}: {
  title: string;
  description: string;
  enabled: boolean;
  onClick?: () => void;
  sortable?: boolean;
  dragging?: boolean;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  onDragOver?: (event: DragEvent<HTMLElement>) => void;
  onDrop?: (event: DragEvent<HTMLElement>) => void;
  onDragEnd?: (event: DragEvent<HTMLElement>) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <article
      className={`skill-hub-card ${onClick ? "skill-hub-card-clickable" : ""} ${
        sortable ? "skill-hub-card-sortable" : ""
      } ${dragging ? "skill-hub-card-dragging" : ""}`}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      draggable={sortable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onKeyDown={
        onClick
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      <div className="skill-hub-card-head">
        <div className="skill-hub-card-heading">
          {sortable ? <HolderOutlined className="skill-hub-card-grip" aria-hidden /> : null}
          <div className="skill-hub-card-title">{title}</div>
        </div>
        <Tag color={enabled ? "green" : "default"}>{enabled ? t("Enabled") : t("Disabled")}</Tag>
      </div>
      <div className="skill-hub-card-description">{description.trim() || t("No description")}</div>
    </article>
  );
}

export function SkillHubWorkspace({
  refresh,
  snapshot,
  onInsertSkill,
  onInsertSubagent,
  openMcpConfig,
  onClose,
  t,
}: {
  refresh: () => Promise<void>;
  snapshot: RuntimeSnapshot;
  onInsertSkill: (name: string) => void;
  onInsertSubagent: (name: string) => void;
  openMcpConfig: () => void;
  onClose: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const skills: CapabilityDefinition[] = snapshot.capabilities
    .filter((capability) => capability.kind === "skill")
    .sort((left, right) => left.name.localeCompare(right.name));
  const subagents: SubagentConfig[] = [...snapshot.subagents].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  const [skillOrder, setSkillOrder] = useState<string[]>(() => loadSkillOrder());
  const [draggingSkillId, setDraggingSkillId] = useState<string | null>(null);
  const dragSkillIdRef = useRef<string | null>(null);
  const orderedSkills = orderSkillsByPreference(skills, skillOrder);

  const reorderSkill = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) {
      return;
    }
    const next = orderedSkills.map((skill) => skill.id);
    const from = next.indexOf(sourceId);
    const to = next.indexOf(targetId);
    if (from < 0 || to < 0) {
      return;
    }
    next.splice(to, 0, next.splice(from, 1)[0]);
    setSkillOrder(next);
    saveSkillOrder(next);
  };

  const skillDragProps = (skill: CapabilityDefinition) => ({
    onDragStart: (event: DragEvent<HTMLElement>) => {
      dragSkillIdRef.current = skill.id;
      setDraggingSkillId(skill.id);
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", skill.id);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const sourceId = dragSkillIdRef.current;
      if (sourceId) {
        reorderSkill(sourceId, skill.id);
      }
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const sourceId = dragSkillIdRef.current || event.dataTransfer.getData("text/plain");
      if (sourceId) {
        reorderSkill(sourceId, skill.id);
      }
    },
    onDragEnd: () => {
      dragSkillIdRef.current = null;
      setDraggingSkillId(null);
    },
  });

  return (
    <section className="skill-hub-panel">
      <Tabs
        defaultActiveKey="skills"
        tabBarExtraContent={
          <Button icon={<CloseOutlined />} onClick={onClose}>
            {t("Close")}
          </Button>
        }
        items={[
          {
            key: "skills",
            label: t("Skills"),
            children: (
              <>
                <div className="muted skill-hub-hint">
                  {t("Click a skill to insert it into the prompt. Drag cards to reorder.")}
                </div>
                {orderedSkills.length ? (
                  <div className="skill-hub-grid">
                    {orderedSkills.map((skill) => (
                      <CapabilityCard
                        key={skill.id}
                        title={skill.name}
                        description={skill.description}
                        enabled={skill.enabled}
                        onClick={() => onInsertSkill(skill.name)}
                        sortable
                        dragging={draggingSkillId === skill.id}
                        {...skillDragProps(skill)}
                        t={t}
                      />
                    ))}
                  </div>
                ) : (
                  <Empty className="market-empty" description={t("No skills installed")} />
                )}
              </>
            ),
          },
          {
            key: "experts",
            label: t("Experts"),
            children: (
              <>
                <div className="muted skill-hub-hint">{t("Click an expert to insert @name into the prompt.")}</div>
                {subagents.length ? (
                  <div className="skill-hub-grid">
                    {subagents.map((subagent) => (
                      <CapabilityCard
                        key={subagent.id}
                        title={`@${subagent.name}`}
                        description={subagent.description}
                        enabled={subagent.enabled}
                        onClick={() => onInsertSubagent(subagent.name)}
                        t={t}
                      />
                    ))}
                  </div>
                ) : (
                  <Empty className="market-empty" description={t("No subagents")} />
                )}
              </>
            ),
          },
          {
            key: "market",
            label: t("Tool Market"),
            children: <MarketWorkspace refresh={refresh} snapshot={snapshot} openMcpConfig={openMcpConfig} t={t} />,
          },
        ]}
      />
    </section>
  );
}
