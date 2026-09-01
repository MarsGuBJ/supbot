import { Empty, Tabs, Tag, Typography } from "antd";
import type { CapabilityDefinition, RuntimeSnapshot, SubagentConfig } from "@supbot/shared";
import { MarketWorkspace } from "./MarketWorkspace";

function CapabilityCard({
  title,
  description,
  enabled,
  onClick,
  t,
}: {
  title: string;
  description: string;
  enabled: boolean;
  onClick?: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <article
      className={`skill-hub-card ${onClick ? "skill-hub-card-clickable" : ""}`}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
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
        <div className="skill-hub-card-title">{title}</div>
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
  openMarketConfig,
  openMcpConfig,
  t,
}: {
  refresh: () => Promise<void>;
  snapshot: RuntimeSnapshot;
  onInsertSkill: (name: string) => void;
  openMarketConfig: () => void;
  openMcpConfig: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const skills: CapabilityDefinition[] = snapshot.capabilities
    .filter((capability) => capability.kind === "skill")
    .sort((left, right) => left.name.localeCompare(right.name));
  const subagents: SubagentConfig[] = [...snapshot.subagents].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  return (
    <section className="skill-hub-panel">
      <Typography.Title level={3}>{t("Experts, skills & plugins")}</Typography.Title>
      <Tabs
        defaultActiveKey="skills"
        items={[
          {
            key: "skills",
            label: t("Skills"),
            children: (
              <>
                <div className="muted skill-hub-hint">{t("Click a skill to insert it into the prompt.")}</div>
                {skills.length ? (
                  <div className="skill-hub-grid">
                    {skills.map((skill) => (
                      <CapabilityCard
                        key={skill.id}
                        title={skill.name}
                        description={skill.description}
                        enabled={skill.enabled}
                        onClick={() => onInsertSkill(skill.name)}
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
                <div className="muted skill-hub-hint">{t("Subagents are triggered with @name in chat.")}</div>
                {subagents.length ? (
                  <div className="skill-hub-grid">
                    {subagents.map((subagent) => (
                      <CapabilityCard
                        key={subagent.id}
                        title={`@${subagent.name}`}
                        description={subagent.description}
                        enabled={subagent.enabled}
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
            children: (
              <MarketWorkspace
                refresh={refresh}
                snapshot={snapshot}
                openMarketConfig={openMarketConfig}
                openMcpConfig={openMcpConfig}
                t={t}
              />
            ),
          },
        ]}
      />
    </section>
  );
}
