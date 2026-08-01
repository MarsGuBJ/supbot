import { useState } from "react";
import { GlobalOutlined, InfoCircleOutlined, RightOutlined, SettingOutlined } from "@ant-design/icons";
import { Button, Popover, Segmented, Tag } from "antd";
import type { RuntimeSnapshot } from "@supbot/shared";
import type { Language } from "../i18n";
import { formatModelSummary, runtimeStatusColor, runtimeStatusTranslationKey } from "../lib/settings";

export function SettingsMenu({
  snapshot,
  language,
  setLanguage,
  openConfig,
  collapsed,
  t,
}: {
  snapshot: RuntimeSnapshot;
  language: Language;
  setLanguage: (language: Language) => void;
  openConfig: () => void;
  collapsed: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [open, setOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const modelSummary = formatModelSummary(snapshot.modelConfig);
  const statusLabel = t(runtimeStatusTranslationKey(snapshot.status));

  const closeMenu = () => {
    setOpen(false);
    setStatusOpen(false);
  };

  const content = (
    <div className="settings-menu">
      <button
        className="settings-menu-item"
        type="button"
        data-testid="settings-config"
        onClick={() => {
          closeMenu();
          openConfig();
        }}
      >
        <span>
          <SettingOutlined />
          {t("Config")}
        </span>
        <RightOutlined />
      </button>
      <div className="settings-menu-language" data-testid="settings-language">
        <span>
          <GlobalOutlined />
          {t("Language")}
        </span>
        <Segmented
          size="small"
          value={language}
          aria-label={t("Language")}
          onChange={(value) => setLanguage(value as Language)}
          options={[
            { label: "中文", value: "zh" },
            { label: "EN", value: "en" },
          ]}
        />
      </div>
      <button
        className="settings-menu-item"
        type="button"
        data-testid="settings-status"
        aria-expanded={statusOpen}
        onClick={() => setStatusOpen((value) => !value)}
      >
        <span>
          <InfoCircleOutlined />
          {t("Status")}
        </span>
        <RightOutlined className={statusOpen ? "is-expanded" : ""} />
      </button>
      {statusOpen ? (
        <div className="settings-status-detail" data-testid="settings-status-detail">
          <div>
            <span>{t("Model")}</span>
            <strong className="mono">{modelSummary}</strong>
          </div>
          <Tag color={runtimeStatusColor(snapshot.status)}>{statusLabel}</Tag>
        </div>
      ) : null}
    </div>
  );

  return (
    <Popover
      content={content}
      trigger="click"
      placement="topLeft"
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setStatusOpen(false);
        }
      }}
      overlayClassName="settings-menu-overlay"
      destroyOnHidden
    >
      <Button
        className="settings-menu-trigger"
        type="text"
        icon={<SettingOutlined />}
        aria-label={t("Settings")}
        data-testid="settings-menu-trigger"
      >
        {collapsed ? null : t("Settings")}
      </Button>
    </Popover>
  );
}
