import { useEffect, useState } from "react";
import { ApiOutlined, CheckCircleOutlined } from "@ant-design/icons";
import { Button, Form, Input, Modal, Select, message } from "antd";
import type { RuntimeSnapshot } from "@supbot/shared";
import { connectServstationAgent } from "../servstationConnection";
import type { Translator } from "../lib/types";

export function ServerAgentConnectionButton({
  snapshot,
  refresh,
  t,
  compact = false,
}: {
  snapshot: RuntimeSnapshot;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  compact?: boolean;
}) {
  const [messageApi, contextHolder] = message.useMessage();
  const [busy, setBusy] = useState(false);
  const config = snapshot.servstationA2A.config;
  const identity = snapshot.identityContext;
  const reverseStatus = config.reverse?.status || "disconnected";
  const isConnected = reverseStatus === "connected";
  const isConnecting = reverseStatus === "connecting";

  if (!config.staffAgentAccount) {
    return null;
  }

  const toggleConnection = async () => {
    setBusy(true);
    try {
      if (isConnected) {
        await window.supbot.disconnectServstationReverseBridge();
      } else {
        const connected = await connectServstationAgent(config, identity, config.staffAgentAccount);
        if (!connected) {
          return;
        }
      }
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={compact ? "server-agent-connect-topbar" : "server-agent-connect"}>
      {contextHolder}
      <Button
        block={!compact}
        size={compact ? "small" : undefined}
        type={isConnected ? "default" : "primary"}
        className={`server-agent-button ${isConnected ? "is-connected" : ""}`}
        icon={isConnected ? <CheckCircleOutlined /> : <ApiOutlined />}
        loading={busy || isConnecting}
        onClick={() => void toggleConnection()}
      >
        {isConnected ? t("Server connected") : t("Connect server Agent")}
      </Button>
    </section>
  );
}

export function RemoteScheduleModal({
  open,
  disabled,
  onCancel,
  onSave,
  t,
}: {
  open: boolean;
  disabled: boolean;
  onCancel: () => void;
  onSave: (input: {
    title?: string;
    prompt: string;
    scheduleKind: string;
    runAt?: string;
    cronExpr?: string;
  }) => Promise<void>;
  t: Translator;
}) {
  const [form] = Form.useForm<{
    title?: string;
    prompt: string;
    scheduleKind: string;
    runAt?: string;
    cronExpr?: string;
  }>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      form.setFieldsValue({ scheduleKind: "once" });
    }
  }, [form, open]);
  return (
    <Modal
      open={open}
      title={t("New scheduled prompt")}
      onCancel={onCancel}
      onOk={() => form.submit()}
      okText={t("Create")}
      confirmLoading={saving}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={async (values) => {
          setSaving(true);
          try {
            await onSave(values);
            form.resetFields();
          } finally {
            setSaving(false);
          }
        }}
      >
        <Form.Item label={t("Title")} name="title">
          <Input disabled={disabled} />
        </Form.Item>
        <Form.Item label={t("Prompt")} name="prompt" rules={[{ required: true }]}>
          <Input.TextArea rows={4} disabled={disabled} />
        </Form.Item>
        <Form.Item label={t("Kind")} name="scheduleKind" rules={[{ required: true }]}>
          <Select
            disabled={disabled}
            options={[
              { value: "once", label: t("Once") },
              { value: "cron", label: t("Cron") },
            ]}
          />
        </Form.Item>
        <Form.Item label={t("Run at ISO time")} name="runAt">
          <Input disabled={disabled} placeholder={new Date(Date.now() + 3600000).toISOString()} />
        </Form.Item>
        <Form.Item label={t("Cron expression")} name="cronExpr">
          <Input disabled={disabled} placeholder="0 9 * * 1-5" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
