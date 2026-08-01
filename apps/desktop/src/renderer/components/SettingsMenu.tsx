import { useEffect, useRef, useState } from "react";
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const configItemRef = useRef<HTMLButtonElement>(null);
  const modelSummary = formatModelSummary(snapshot.modelConfig);
  const statusLabel = t(runtimeStatusTranslationKey(snapshot.status));

  useEffect(() => {
    if (!open) {
      return;
    }
    const frame = window.requestAnimationFrame(() => configItemRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const closeMenu = () => {
    setOpen(false);
    setStatusOpen(false);
  };

  const content = (
    <div id="settings-menu-dialog" className="settings-menu" role="dialog" aria-label={t("Settings")}>
      <button
        ref={configItemRef}
        className="settings-menu-item"
        type="button"
        data-testid="settings-config"
        onClick={() => {
          triggerRef.current?.focus();
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
        aria-controls="settings-status-detail"
        onClick={() => setStatusOpen((value) => !value)}
      >
        <span>
          <InfoCircleOutlined />
          {t("Status")}
        </span>
        <RightOutlined className={statusOpen ? "is-expanded" : ""} />
      </button>
      {statusOpen ? (
        <div id="settings-status-detail" className="settings-status-detail" data-testid="settings-status-detail">
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
        ref={triggerRef}
        className="settings-menu-trigger"
        type="text"
        icon={<SettingOutlined />}
        aria-label={t("Settings")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="settings-menu-dialog"
        data-testid="settings-menu-trigger"
      >
        {collapsed ? null : t("Settings")}
      </Button>
    </Popover>
  );
}
