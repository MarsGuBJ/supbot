import { useState } from "react";
import { ToolOutlined } from "@ant-design/icons";
import { Button, Space, Tag } from "antd";
import type { PendingToolPermission } from "@supbot/shared";

export function ComposerPermissionPrompt({
  permissions,
  approveToolPermission,
  denyToolPermission,
  t,
}: {
  permissions: PendingToolPermission[];
  approveToolPermission: (id: string) => Promise<void>;
  denyToolPermission: (id: string) => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [actingId, setActingId] = useState("");
  if (!permissions.length) {
    return null;
  }
  const run = async (id: string, action: (id: string) => Promise<void>) => {
    setActingId(id);
    try {
      await action(id);
    } finally {
      setActingId("");
    }
  };
  return (
    <div className="composer-permission-popover" role="dialog" aria-live="assertive" aria-label={t("Tool approvals")}>
      <div className="composer-permission-head">
        <div>
          <div className="eyebrow">{t("pending_permission")}</div>
          <strong>{t("Tool approvals")}</strong>
        </div>
        <Tag color="gold">{permissions.length}</Tag>
      </div>
      <div className="composer-permission-list">
        {permissions.map((permission) => (
          <div className="composer-permission-card" key={permission.id}>
            <div className="composer-permission-copy">
              <div className="composer-permission-title">
                <ToolOutlined />
                <strong>{permission.toolName}</strong>
              </div>
              <span>{permission.summary}</span>
              {permission.executionPath ? <small className="muted mono">{permission.executionPath}</small> : null}
            </div>
            <Space wrap>
              <Button
                size="small"
                type="primary"
                loading={actingId === permission.id}
                disabled={Boolean(actingId) && actingId !== permission.id}
                onClick={() => void run(permission.id, approveToolPermission)}
              >
                {t("Allow once")}
              </Button>
              <Button
                size="small"
                danger
                loading={actingId === permission.id}
                disabled={Boolean(actingId) && actingId !== permission.id}
                onClick={() => void run(permission.id, denyToolPermission)}
              >
                {t("Deny")}
              </Button>
            </Space>
          </div>
        ))}
      </div>
    </div>
  );
}
