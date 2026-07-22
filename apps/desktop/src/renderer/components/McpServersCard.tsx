import { useEffect, useState } from "react";
import { CopyOutlined, DeleteOutlined, ReloadOutlined, SaveOutlined, ToolOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  message,
} from "antd";
import type {
  McpConfigTransfer,
  McpDiagnosticResult,
  McpLogRecord,
  McpServerInput,
  McpServerPreset,
  McpServerSnapshot,
  PermissionRule,
  RuntimeSnapshot,
} from "@supbot/shared";
import { formatDateTime } from "@supbot/shared";
import { formatJsonSnippet } from "../lib/chatFormat";

export function McpServersCard({
  snapshot,
  refresh,
  t,
}: {
  snapshot: RuntimeSnapshot;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [form] = Form.useForm<McpServerInput & { envText?: string; argsText?: string }>();
  const [editing, setEditing] = useState<McpServerSnapshot | null>(null);
  const [busyId, setBusyId] = useState("");
  const [logServer, setLogServer] = useState<McpServerSnapshot | null>(null);
  const [logs, setLogs] = useState<McpLogRecord[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [presets, setPresets] = useState<McpServerPreset[]>([]);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferText, setTransferText] = useState("");
  const [diagnostic, setDiagnostic] = useState<McpDiagnosticResult | null>(null);
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  useEffect(() => {
    void window.supbot
      .listMcpPresets()
      .then(setPresets)
      .catch(() => setPresets([]));
  }, []);
  const save = async (values: McpServerInput & { envText?: string; argsText?: string }) => {
    const input: McpServerInput = {
      name: values.name,
      command: values.command,
      args: parseArgsText(values.argsText),
      cwd: values.cwd,
      env: parseEnvText(values.envText),
      requestTimeoutMs: values.requestTimeoutMs,
      enabled: values.enabled,
      autoConnect: values.autoConnect,
    };
    try {
      if (editing) {
        await window.supbot.updateMcpServer(editing.id, input);
        messageApi.success(t("MCP server updated."));
      } else {
        await window.supbot.addMcpServer(input);
        messageApi.success(t("MCP server added."));
      }
      setEditing(null);
      form.resetFields();
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
    }
  };
  const run = async (serverId: string, action: () => Promise<unknown>, success: string) => {
    setBusyId(serverId);
    try {
      await action();
      messageApi.success(t(success));
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
      await refresh();
    } finally {
      setBusyId("");
    }
  };
  const beginEdit = (server: McpServerSnapshot) => {
    setEditing(server);
    form.setFieldsValue({
      name: server.name,
      command: server.command,
      argsText: server.args.join("\n"),
      cwd: server.cwd,
      envText: formatEnvText(server.env),
      requestTimeoutMs: server.requestTimeoutMs || 30000,
      enabled: server.enabled,
      autoConnect: server.autoConnect,
    });
  };
  const applyPreset = (presetId: string) => {
    const preset = presets.find((item) => item.id === presetId);
    if (!preset) {
      return;
    }
    setEditing(null);
    form.setFieldsValue({
      name: preset.serverInput.name,
      command: preset.serverInput.command,
      argsText: (preset.serverInput.args || []).join("\n"),
      cwd: preset.serverInput.cwd,
      envText: formatEnvText(preset.serverInput.env),
      requestTimeoutMs: preset.serverInput.requestTimeoutMs || 30000,
      enabled: preset.serverInput.enabled,
      autoConnect: false,
    });
    messageApi.info(t("Preset loaded as a draft."));
  };
  const exportConfig = async () => {
    const transfer = await window.supbot.exportMcpConfig();
    setTransferText(JSON.stringify(transfer, null, 2));
    setTransferOpen(true);
  };
  const importConfig = async () => {
    try {
      const parsed = JSON.parse(transferText) as McpConfigTransfer;
      const result = await window.supbot.importMcpConfig(parsed);
      messageApi.success(t("Imported {count} MCP servers.", { count: result.imported }));
      setTransferOpen(false);
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
    }
  };
  const valuesToMcpInput = (values: McpServerInput & { envText?: string; argsText?: string }): McpServerInput => ({
    name: values.name || "diagnostic",
    command: values.command,
    args: parseArgsText(values.argsText),
    cwd: values.cwd,
    env: parseEnvText(values.envText),
    requestTimeoutMs: values.requestTimeoutMs,
    enabled: true,
    autoConnect: false,
  });
  const diagnoseValues = async () => {
    try {
      const values = await form.validateFields();
      const result = await window.supbot.diagnoseMcpServer(valuesToMcpInput(values));
      setDiagnostic(result);
      setDiagnosticOpen(true);
    } catch (error) {
      messageApi.error((error as Error).message);
    }
  };
  const diagnoseServer = async (server: McpServerSnapshot) => {
    const result = await window.supbot.diagnoseMcpServer(server);
    setDiagnostic(result);
    setDiagnosticOpen(true);
  };
  const addMcpRule = async (toolName: string, behavior: PermissionRule["behavior"]) => {
    await window.supbot.addPermissionRule({ toolName, behavior });
    messageApi.success(t("Permission rule added."));
    await refresh();
  };
  const showLogs = async (server: McpServerSnapshot) => {
    setLogServer(server);
    setLogsLoading(true);
    try {
      setLogs(await window.supbot.getMcpLogs(server.id));
    } catch (error) {
      messageApi.error((error as Error).message);
      setLogs([]);
    } finally {
      setLogsLoading(false);
    }
  };
  const copyMcpText = async (text: string, success: string) => {
    try {
      await navigator.clipboard.writeText(text);
      messageApi.success(t(success));
    } catch (error) {
      messageApi.error((error as Error).message);
    }
  };
  return (
    <div className="settings-stack">
      {contextHolder}
      <div className="settings-card">
        <div className="panel-heading">
          <div>
            <div className="section-title">
              <ToolOutlined /> {t("MCP Servers")}
            </div>
            <div className="muted">
              {t("Connect local stdio MCP servers. Tools are registered through HBClient permissions.")}
            </div>
          </div>
          <Space wrap>
            <Tag color="cyan">
              {snapshot.mcpServers.length} {t("servers")}
            </Tag>
            <Tag color="green">
              {snapshot.mcpTools.length} {t("tools")}
            </Tag>
          </Space>
        </div>
        <div className="mcp-preset-bar">
          <Select
            className="mcp-preset-select"
            placeholder={t("Load MCP preset")}
            options={presets.map((preset) => ({ value: preset.id, label: preset.name }))}
            onChange={applyPreset}
          />
          <Button onClick={() => void exportConfig()}>{t("Export MCP")}</Button>
          <Button
            onClick={() => {
              setTransferText("");
              setTransferOpen(true);
            }}
          >
            {t("Import MCP")}
          </Button>
        </div>
        <Form
          form={form}
          layout="vertical"
          initialValues={{ enabled: true, autoConnect: false, requestTimeoutMs: 30000 }}
          onFinish={(values) => void save(values)}
        >
          <div className="mcp-form-grid">
            <Form.Item label={t("Name")} name="name" rules={[{ required: true }]}>
              <Input placeholder="local-files" />
            </Form.Item>
            <Form.Item label={t("Command")} name="command" rules={[{ required: true }]}>
              <Input placeholder="node" />
            </Form.Item>
            <Form.Item label={t("Arguments")} name="argsText">
              <Input.TextArea rows={3} placeholder="D:\\tools\\mcp-server.js" />
            </Form.Item>
            <Form.Item label={t("Working directory")} name="cwd">
              <Input placeholder="D:\\projects\\my-server" />
            </Form.Item>
            <Form.Item label={t("Request timeout (ms)")} name="requestTimeoutMs">
              <InputNumber min={1000} max={120000} step={1000} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item label={t("Environment")} name="envText">
              <Input.TextArea rows={3} placeholder="API_KEY=value" />
            </Form.Item>
            <div className="mcp-switches">
              <Form.Item label={t("Enabled")} name="enabled" valuePropName="checked">
                <Switch />
              </Form.Item>
              <Form.Item label={t("Auto connect")} name="autoConnect" valuePropName="checked">
                <Switch />
              </Form.Item>
            </div>
          </div>
          <Space wrap>
            <Button type="primary" icon={<SaveOutlined />} htmlType="submit">
              {editing ? t("Save") : t("Add server")}
            </Button>
            <Button onClick={() => void diagnoseValues()}>{t("Diagnose draft")}</Button>
            {editing ? (
              <Button
                onClick={() => {
                  setEditing(null);
                  form.resetFields();
                }}
              >
                {t("Cancel")}
              </Button>
            ) : null}
          </Space>
        </Form>
      </div>
      <div className="mcp-server-list">
        {snapshot.mcpServers.map((server) => {
          const tools = snapshot.mcpTools.filter((tool) => tool.serverId === server.id);
          return (
            <div className="mcp-server-card" key={server.id}>
              <div className="activity-head">
                <div>
                  <strong>{server.name}</strong>
                  <div className="muted mono">
                    {server.command} {server.args.join(" ")}
                  </div>
                </div>
                <Space wrap>
                  <Tag color={mcpStatusColor(server.status.state)}>{t(server.status.state)}</Tag>
                  <Tag>
                    {tools.length} {t("tools")}
                  </Tag>
                  {!server.enabled ? <Tag>{t("disabled")}</Tag> : null}
                </Space>
              </div>
              <div className="mcp-status-grid">
                <span>
                  {t("PID")}: <strong>{server.status.pid || "-"}</strong>
                </span>
                <span>
                  {t("Timeout")}: <strong>{server.requestTimeoutMs || 30000}ms</strong>
                </span>
                <span>
                  {t("Last connected")}:{" "}
                  <strong>{server.status.lastConnectedAt ? formatDateTime(server.status.lastConnectedAt) : "-"}</strong>
                </span>
                <span>
                  {t("Exit")}: <strong>{server.status.lastExitReason || "-"}</strong>
                </span>
              </div>
              {server.status.lastError ? <Alert type="warning" showIcon message={server.status.lastError} /> : null}
              {server.status.stderrPreview ? (
                <Alert
                  type="info"
                  showIcon
                  message={t("stderr preview")}
                  description={<pre className="mcp-log-preview">{server.status.stderrPreview}</pre>}
                />
              ) : null}
              <div className="mcp-tool-list">
                {tools.length ? (
                  tools.map((tool) => (
                    <div className="mcp-tool-row" key={tool.runtimeToolName}>
                      <div>
                        <strong>{tool.runtimeToolName}</strong>
                        <span className="muted mono">{tool.modelToolName}</span>
                        <span className="muted">{tool.description || t("No description")}</span>
                      </div>
                      <Space wrap>
                        <Tag>
                          {Object.keys(tool.inputSchema.properties || {}).length} {t("params")}
                        </Tag>
                        {tool.schemaValid === false ? <Tag color="orange">{t("schema warning")}</Tag> : null}
                        <Select
                          size="small"
                          className="mcp-tool-rule-select"
                          placeholder={t("Rule")}
                          onChange={(behavior) =>
                            void addMcpRule(tool.runtimeToolName, behavior as PermissionRule["behavior"])
                          }
                          options={[
                            { value: "allow", label: t("allow") },
                            { value: "ask", label: t("ask") },
                            { value: "deny", label: t("deny") },
                          ]}
                        />
                      </Space>
                      {tool.schemaWarnings?.length ? (
                        <pre className="mcp-log-preview">{tool.schemaWarnings.slice(0, 4).join("\n")}</pre>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <span className="muted">{t("No tools discovered")}</span>
                )}
              </div>
              <Space wrap>
                <Button size="small" onClick={() => beginEdit(server)}>
                  {t("Edit")}
                </Button>
                <Button size="small" onClick={() => void showLogs(server)}>
                  {t("Logs")}
                </Button>
                <Button size="small" onClick={() => void diagnoseServer(server)}>
                  {t("Diagnose")}
                </Button>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() =>
                    void copyMcpText(formatMcpDiagnosticSummary(server, tools), "Copied diagnostic summary.")
                  }
                >
                  {t("Copy diagnostic summary")}
                </Button>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => void copyMcpText(formatMcpToolList(server, tools), "Copied tool list.")}
                >
                  {t("Copy tool list")}
                </Button>
                <Select
                  size="small"
                  className="mcp-rule-select"
                  placeholder={t("Server rule")}
                  onChange={(behavior) => void addMcpRule(`mcp.${server.id}.*`, behavior as PermissionRule["behavior"])}
                  options={[
                    { value: "allow", label: t("allow server") },
                    { value: "ask", label: t("ask server") },
                    { value: "deny", label: t("deny server") },
                  ]}
                />
                <Button
                  size="small"
                  loading={busyId === server.id}
                  onClick={() =>
                    void run(server.id, () => window.supbot.connectMcpServer(server.id), "MCP server connected.")
                  }
                  disabled={!server.enabled || server.status.state === "connected"}
                >
                  {t("Connect")}
                </Button>
                <Button
                  size="small"
                  loading={busyId === server.id}
                  onClick={() =>
                    void run(server.id, () => window.supbot.disconnectMcpServer(server.id), "MCP server disconnected.")
                  }
                  disabled={server.status.state !== "connected"}
                >
                  {t("Disconnect")}
                </Button>
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  loading={busyId === server.id}
                  onClick={() =>
                    void run(server.id, () => window.supbot.refreshMcpTools(server.id), "MCP tools refreshed.")
                  }
                  disabled={server.status.state !== "connected"}
                >
                  {t("Refresh tools")}
                </Button>
                <Popconfirm
                  title={t("Delete MCP server?")}
                  onConfirm={() =>
                    void run(server.id, () => window.supbot.removeMcpServer(server.id), "MCP server removed.")
                  }
                >
                  <Button size="small" danger icon={<DeleteOutlined />}>
                    {t("Delete")}
                  </Button>
                </Popconfirm>
              </Space>
            </div>
          );
        })}
        {!snapshot.mcpServers.length ? <Empty description={t("No MCP servers configured")} /> : null}
      </div>
      <Modal
        title={logServer ? t("MCP logs: {name}", { name: logServer.name }) : t("MCP logs")}
        open={Boolean(logServer)}
        onCancel={() => setLogServer(null)}
        footer={null}
      >
        {logsLoading ? (
          <Spin />
        ) : logs.length ? (
          <div className="mcp-log-list">
            {logs.map((log) => (
              <div className={`mcp-log-row mcp-log-${log.level}`} key={log.id}>
                <span>{formatDateTime(log.createdAt)}</span>
                <Tag>{log.level}</Tag>
                <pre>{log.message}</pre>
              </div>
            ))}
          </div>
        ) : (
          <Empty description={t("No logs")} />
        )}
      </Modal>
      <Modal
        title={t("MCP import / export")}
        open={transferOpen}
        onCancel={() => setTransferOpen(false)}
        onOk={() => void importConfig()}
        okText={t("Import")}
      >
        <Input.TextArea
          className="mcp-transfer-textarea"
          rows={14}
          value={transferText}
          onChange={(event) => setTransferText(event.target.value)}
          placeholder={t("Paste exported MCP JSON here")}
        />
      </Modal>
      <Modal
        title={t("MCP diagnostic")}
        open={diagnosticOpen}
        onCancel={() => setDiagnosticOpen(false)}
        footer={<Button onClick={() => setDiagnosticOpen(false)}>{t("Close")}</Button>}
        width={760}
      >
        {diagnostic ? (
          <div className="mcp-diagnostic">
            <Alert
              type={diagnostic.ok ? "success" : "error"}
              showIcon
              message={diagnostic.ok ? t("Diagnostic passed") : diagnostic.error || t("Diagnostic failed")}
            />
            <div className="config-grid">
              <div>
                <span>{t("Server")}</span>
                <strong>{diagnostic.serverName}</strong>
              </div>
              <div>
                <span>{t("Duration")}</span>
                <strong>{diagnostic.durationMs}ms</strong>
              </div>
              <div>
                <span>{t("Tools")}</span>
                <strong>{diagnostic.toolCount}</strong>
              </div>
              <div>
                <span>{t("Initialize")}</span>
                <strong>{diagnostic.initializeMs ?? "-"}ms</strong>
              </div>
              <div>
                <span>{t("tools/list")}</span>
                <strong>{diagnostic.toolsListMs ?? "-"}ms</strong>
              </div>
              <div>
                <span>{t("Protocol")}</span>
                <strong>{diagnostic.protocolVersion || "-"}</strong>
              </div>
              <div>
                <span>{t("Error code")}</span>
                <strong>{diagnostic.errorCode ?? "-"}</strong>
              </div>
            </div>
            {diagnostic.capabilities !== undefined ? (
              <Alert
                type="info"
                showIcon
                message={t("Capabilities")}
                description={<pre className="mcp-log-preview">{formatJsonSnippet(diagnostic.capabilities)}</pre>}
              />
            ) : null}
            {diagnostic.errorData !== undefined ? (
              <Alert
                type="error"
                showIcon
                message={t("Error data")}
                description={<pre className="mcp-log-preview">{formatJsonSnippet(diagnostic.errorData)}</pre>}
              />
            ) : null}
            {diagnostic.schemaWarnings.length ? (
              <Alert
                type="warning"
                showIcon
                message={t("Schema warnings")}
                description={<pre className="mcp-log-preview">{diagnostic.schemaWarnings.join("\n")}</pre>}
              />
            ) : null}
            {diagnostic.stderrPreview ? <pre className="mcp-log-preview">{diagnostic.stderrPreview}</pre> : null}
            <div className="mcp-tool-list">
              {diagnostic.tools.map((tool) => (
                <div className="mcp-tool-row" key={tool.runtimeToolName}>
                  <div>
                    <strong>{tool.runtimeToolName}</strong>
                    <span className="muted mono">{tool.modelToolName}</span>
                    <span className="muted">{tool.description || t("No description")}</span>
                  </div>
                  <Space wrap>
                    <Tag>
                      {Object.keys(tool.inputSchema.properties || {}).length} {t("params")}
                    </Tag>
                    {tool.schemaValid === false ? <Tag color="orange">{t("schema warning")}</Tag> : null}
                  </Space>
                  {tool.schemaWarnings?.length ? (
                    <pre className="mcp-log-preview">{tool.schemaWarnings.slice(0, 4).join("\n")}</pre>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <Empty description={t("No diagnostic result")} />
        )}
      </Modal>
    </div>
  );
}

export function parseArgsText(value?: string): string[] {
  return (value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseEnvText(value?: string): Record<string, string> | undefined {
  const entries = (value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): [string, string] | undefined => {
      const index = line.indexOf("=");
      if (index <= 0) {
        return undefined;
      }
      return [line.slice(0, index).trim(), line.slice(index + 1)];
    })
    .filter((entry): entry is [string, string] => Boolean(entry));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function formatEnvText(env?: Record<string, string>): string {
  return Object.entries(env || {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function formatMcpDiagnosticSummary(server: McpServerSnapshot, tools: RuntimeSnapshot["mcpTools"]): string {
  return [
    `MCP server: ${server.name} (${server.id})`,
    `State: ${server.status.state}`,
    `Command: ${server.command} ${server.args.join(" ")}`.trim(),
    `PID: ${server.status.pid || "-"}`,
    `Timeout: ${server.requestTimeoutMs || 30000}ms`,
    `Tools: ${tools.length}`,
    `Last connected: ${server.status.lastConnectedAt || "-"}`,
    `Last exit: ${server.status.lastExitReason || "-"}`,
    `Last error: ${server.status.lastError || "-"}`,
    server.status.stderrPreview ? `stderr tail:\n${server.status.stderrPreview}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatMcpToolList(server: McpServerSnapshot, tools: RuntimeSnapshot["mcpTools"]): string {
  if (!tools.length) {
    return `MCP server: ${server.name}\nNo tools discovered.`;
  }
  return [
    `MCP server: ${server.name} (${server.id})`,
    ...tools.map((tool) =>
      [
        `- ${tool.runtimeToolName}`,
        `  model: ${tool.modelToolName}`,
        `  params: ${Object.keys(tool.inputSchema.properties || {}).join(", ") || "-"}`,
        `  schema: ${tool.schemaValid ? "valid" : "warning"}`,
        tool.schemaWarnings?.length ? `  warnings: ${tool.schemaWarnings.join("; ")}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n");
}

export function mcpStatusColor(state: string): string {
  if (state === "connected") {
    return "green";
  }
  if (state === "connecting") {
    return "blue";
  }
  if (state === "error") {
    return "red";
  }
  return "default";
}
