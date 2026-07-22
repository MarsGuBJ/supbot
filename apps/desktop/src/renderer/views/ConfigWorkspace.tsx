import { useEffect, useState } from "react";
import {
  ApiOutlined,
  AppstoreOutlined,
  CheckCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  PaperClipOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Divider,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Slider,
  Space,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import {
  defaultServstationUser,
  defaultToolMarketApiUrl,
  type CapabilityUpdateInput,
  type ModelProviderConfig,
  type ModelProviderUpdate,
  type PermissionRule,
  type PersonalityConfig,
  type RuntimeSnapshot,
  type ServstationA2AConfigUpdate,
  type SubagentConfig,
  type ToolMarketConfigUpdate,
} from "@supbot/shared";
import { formatDateTime } from "@supbot/shared";
import { McpServersCard } from "../components/McpServersCard";
import { MemoryPanel } from "../components/MemoryPanel";
import { truncateText } from "../lib/chatFormat";

export const hiddenSlashCommandCapabilityIds = new Set(["tool.file", "tool.shell"]);

export function MemorySettingsCard({
  snapshot,
  refresh,
  t,
}: {
  snapshot: RuntimeSnapshot;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className="settings-card">
      <MemoryPanel
        snapshot={snapshot}
        activeConversationId={snapshot.conversations[0]?.id || ""}
        refresh={refresh}
        t={t}
        embedded
      />
    </div>
  );
}

export function ConfigWorkspace({
  snapshot,
  userDataPath,
  focusTab,
  setFocusTab,
  refresh,
  t,
  openSubagent,
}: {
  snapshot: RuntimeSnapshot;
  userDataPath: string;
  focusTab: string;
  setFocusTab: (tab: string) => void;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  openSubagent: (subagent: SubagentConfig | null) => void;
}) {
  return (
    <section className="config-panel">
      <div className="config-header">
        <div>
          <div className="eyebrow">{t("LOCAL CONFIG")}</div>
          <Typography.Title level={3}>{t("HBClient Settings")}</Typography.Title>
          <div className="muted">
            {t("Model, personality, local capabilities, and subagents live on this machine.")}
          </div>
        </div>
        <Button icon={<ReloadOutlined />} onClick={refresh}>
          {t("Refresh")}
        </Button>
      </div>
      <Tabs
        activeKey={focusTab}
        onChange={setFocusTab}
        items={[
          {
            key: "model",
            label: t("Model"),
            children: <ModelConfigCard snapshot={snapshot} refresh={refresh} t={t} />,
          },
          {
            key: "server-agent",
            label: t("Server Agent"),
            children: <RemoteStaffAgentConfigCard snapshot={snapshot} refresh={refresh} t={t} />,
          },
          { key: "mcp", label: "MCP", children: <McpServersCard snapshot={snapshot} refresh={refresh} t={t} /> },
          {
            key: "personality",
            label: t("Personality"),
            children: <PersonalityCard snapshot={snapshot} refresh={refresh} t={t} />,
          },
          {
            key: "capabilities",
            label: t("Capabilities"),
            children: <CapabilitiesCard snapshot={snapshot} refresh={refresh} t={t} />,
          },
          { key: "storage", label: t("Storage"), children: <StorageCard userDataPath={userDataPath} t={t} /> },
          {
            key: "memory",
            label: t("Memory"),
            children: <MemorySettingsCard snapshot={snapshot} refresh={refresh} t={t} />,
          },
          {
            key: "subagents",
            label: t("Subagents"),
            children: <SubagentsCard snapshot={snapshot} refresh={refresh} openSubagent={openSubagent} t={t} />,
          },
        ]}
      />
    </section>
  );
}

export function StorageCard({
  userDataPath,
  t,
}: {
  userDataPath: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className="settings-card">
      <div className="panel-heading">
        <div>
          <div className="section-title">
            <PaperClipOutlined /> {t("Local storage")}
          </div>
          <div className="muted">
            {t(
              "Conversations, encrypted model credentials, generated files, and schedules stay under this app data directory.",
            )}
          </div>
        </div>
        {userDataPath ? (
          <Button onClick={() => void window.supbot.openFile(userDataPath)}>{t("Open folder")}</Button>
        ) : null}
      </div>
      <div className="config-grid">
        <div>
          <span>{t("User data")}</span>
          <strong>{userDataPath || t("Loading...")}</strong>
        </div>
        <div>
          <span>{t("Generated files")}</span>
          <strong>{userDataPath ? `${userDataPath}\\data\\generated-files` : t("Loading...")}</strong>
        </div>
      </div>
      <Divider />
      <Alert
        type={userDataPath ? "info" : "warning"}
        showIcon
        message={t("Credential storage")}
        description={t(
          "HBClient uses the operating system safe storage when available. If the app reports file storage for a credential, treat that fallback as local obfuscation rather than strong encryption.",
        )}
      />
      <Divider />
      <Alert
        type="info"
        showIcon
        message={t("Local tool commands")}
        description={t(
          "/read <path> reads a UTF-8 text file, /write <name-or-path> creates a generated file, and /shell <command> runs a local command with a 60-second timeout.",
        )}
      />
    </div>
  );
}

export function ToolMarketConfigCard({
  snapshot,
  refresh,
  t,
}: {
  snapshot: RuntimeSnapshot;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [form] = Form.useForm<ToolMarketConfigUpdate>();
  const [saving, setSaving] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const config = snapshot.toolMarketConfig;

  useEffect(() => {
    form.setFieldsValue({
      source: config.source,
      apiUrl: config.apiUrl,
      accountEmail: config.accountEmail,
      accessToken: "",
      password: "",
      clearAccessToken: false,
      clearPassword: false,
    });
  }, [config, form]);

  const save = async (values: ToolMarketConfigUpdate) => {
    setSaving(true);
    try {
      await window.supbot.updateToolMarketConfig(values);
      messageApi.success(t("Tool market configuration saved."));
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-card">
      {contextHolder}
      <div className="panel-heading">
        <div>
          <div className="section-title">
            <AppstoreOutlined /> {t("Tool market source")}
          </div>
          <div className="muted">
            {t("Use the built-in local catalog, a remote ToolsMarket-compatible API, or both.")}
          </div>
        </div>
        <Space wrap>
          <Tag color={config.passwordSaved ? "green" : "default"}>
            {config.passwordSaved ? t("Password saved") : t("No password")}
          </Tag>
          <Tag color={config.accessTokenSaved ? "green" : "default"}>
            {config.accessTokenSaved ? t("Token saved") : t("No token")}
          </Tag>
        </Space>
      </div>
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          source: "hybrid",
          apiUrl: defaultToolMarketApiUrl,
          accountEmail: "subscriber@toolsmarket.local",
        }}
        onFinish={(values) => void save(values as ToolMarketConfigUpdate)}
      >
        <Form.Item label={t("Source")} name="source">
          <Segmented
            options={[
              { label: t("Local catalog"), value: "local" },
              { label: t("Remote API"), value: "remote" },
              { label: t("Hybrid"), value: "hybrid" },
            ]}
          />
        </Form.Item>
        <Form.Item
          label={t("Market API URL")}
          name="apiUrl"
          tooltip={t("Use the i-shu.com tool market or a compatible catalog API returning { items: [...] }.")}
        >
          <Input placeholder={defaultToolMarketApiUrl} />
        </Form.Item>
        <Form.Item label={t("Market account email")} name="accountEmail">
          <Input placeholder="subscriber@toolsmarket.local" />
        </Form.Item>
        <Form.Item
          label={t("Market password")}
          name="password"
          extra={
            config.passwordSaved
              ? t("Leave blank to keep the existing password.")
              : t("Optional when the market allows anonymous catalog access.")
          }
        >
          <Input.Password autoComplete="new-password" placeholder="Password" />
        </Form.Item>
        <Form.Item name="clearPassword" valuePropName="checked">
          <Switch checkedChildren={t("Clear saved password")} unCheckedChildren={t("Keep saved password")} />
        </Form.Item>
        <Form.Item
          label={t("Access token")}
          name="accessToken"
          extra={
            config.accessTokenSaved
              ? t("Leave blank to keep the existing token.")
              : t("Optional for public local market APIs.")
          }
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="clearAccessToken" valuePropName="checked">
          <Switch checkedChildren={t("Clear saved token")} unCheckedChildren={t("Keep saved token")} />
        </Form.Item>
        <Space wrap>
          <Button type="primary" icon={<SaveOutlined />} htmlType="submit" loading={saving}>
            {t("Save")}
          </Button>
          <Button
            icon={<ReloadOutlined />}
            onClick={async () => {
              try {
                await window.supbot.listToolMarket({});
                messageApi.success(t("Tool market refreshed."));
                await refresh();
              } catch (error) {
                messageApi.error((error as Error).message);
              }
            }}
          >
            {t("Refresh")}
          </Button>
          {config.lastSyncedAt ? (
            <span className="muted">{t("Last sync: {time}", { time: formatDateTime(config.lastSyncedAt) })}</span>
          ) : null}
        </Space>
      </Form>
    </div>
  );
}

export function RemoteStaffAgentConfigCard({
  snapshot,
  refresh,
  t,
}: {
  snapshot: RuntimeSnapshot;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [form] = Form.useForm<ServstationA2AConfigUpdate>();
  const [saving, setSaving] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const config = snapshot.servstationA2A.config;
  const identity = snapshot.identityContext;

  useEffect(() => {
    form.setFieldsValue({
      staffAgentAccount: config.staffAgentAccount || defaultServstationUser,
      staffAgentPassword: "",
    });
  }, [config, form]);

  const save = async (values: ServstationA2AConfigUpdate) => {
    setSaving(true);
    try {
      await window.supbot.updateServstationA2AConfig(values);
      messageApi.success(t("Remote staff-agent configuration saved."));
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-card">
      {contextHolder}
      <div className="panel-heading">
        <div>
          <div className="section-title">
            <ApiOutlined /> {t("Remote staff-agent")}
          </div>
          <div className="muted">{t("Configure the Servstation account used to connect the server staff-agent.")}</div>
        </div>
        <Space wrap>
          <Tag color={config.staffAgentPasswordSaved ? "green" : "default"}>
            {config.staffAgentPasswordSaved ? t("Password saved") : t("No password")}
          </Tag>
          <Tag color="blue">
            {t("Agent instance id")}: {identity?.agentInstanceId || t("No agent id")}
          </Tag>
        </Space>
      </div>
      <Form form={form} layout="vertical" onFinish={(values) => void save(values as ServstationA2AConfigUpdate)}>
        <Form.Item label={t("Staff-agent account")} name="staffAgentAccount">
          <Input autoComplete="username" />
        </Form.Item>
        <Form.Item
          label={t("Staff-agent password")}
          name="staffAgentPassword"
          extra={
            config.staffAgentPasswordSaved
              ? t("Leave blank to keep the existing password.")
              : t("Required for password login.")
          }
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Space wrap>
          <Button type="primary" icon={<SaveOutlined />} htmlType="submit" loading={saving}>
            {t("Save")}
          </Button>
        </Space>
      </Form>
    </div>
  );
}

export function ModelConfigCard({
  snapshot,
  refresh,
  t,
}: {
  snapshot: RuntimeSnapshot;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [form] = Form.useForm<ModelProviderUpdate>();
  const [messageApi, contextHolder] = message.useMessage();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ModelProviderConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState("");
  const [activatingId, setActivatingId] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const providers = snapshot.modelProviders.length ? snapshot.modelProviders : [snapshotProviderFallback(snapshot)];
  const activeProviderId = snapshot.activeModelProviderId || providers[0]?.id || "";
  const openProviderForm = (provider?: ModelProviderConfig) => {
    setEditingProvider(provider || null);
    form.setFieldsValue(provider ? modelProviderFormValues(provider) : newModelProviderValues(snapshot));
    setModalOpen(true);
  };
  const closeProviderForm = () => {
    setModalOpen(false);
    setEditingProvider(null);
    form.resetFields();
  };
  const saveProvider = async (values: ModelProviderUpdate) => {
    setSaving(true);
    try {
      if (editingProvider) {
        await window.supbot.updateModelProvider(editingProvider.id, values);
      } else {
        await window.supbot.createModelProvider(values);
      }
      closeProviderForm();
      messageApi.success(t("Model provider saved."));
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const testProvider = async (provider?: ModelProviderConfig, values?: Partial<ModelProviderUpdate>) => {
    const testKey = provider?.id || "__draft__";
    setTestingId(testKey);
    try {
      const result = await window.supbot.testModelProvider(provider?.id, values);
      if (result.ok) {
        messageApi.success(t("Model test succeeded: {message}", { message: result.message }));
      } else {
        messageApi.warning(t(result.message));
      }
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setTestingId("");
    }
  };
  const activateProvider = async (provider: ModelProviderConfig) => {
    setActivatingId(provider.id);
    try {
      await window.supbot.setActiveModelProvider(provider.id);
      messageApi.success(t("Current model provider updated."));
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setActivatingId("");
    }
  };
  const deleteProvider = async (provider: ModelProviderConfig) => {
    setDeletingId(provider.id);
    try {
      await window.supbot.deleteModelProvider(provider.id);
      messageApi.success(t("Model provider deleted."));
      await refresh();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setDeletingId("");
    }
  };
  return (
    <div className="settings-card">
      {contextHolder}
      <div className="panel-heading">
        <div>
          <div className="section-title">
            <SettingOutlined /> {t("Model providers")}
          </div>
          <div className="muted">
            {t("Active provider")}: {snapshot.modelConfig.providerName} / {snapshot.modelConfig.model}
          </div>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openProviderForm()}>
          {t("New provider")}
        </Button>
      </div>
      <List
        className="model-provider-list"
        dataSource={providers}
        renderItem={(provider) => {
          const isActive = provider.id === activeProviderId;
          const deleteDisabled = providers.length <= 1;
          return (
            <List.Item
              actions={[
                <Tooltip key="test" title={t("Test")}>
                  <Button
                    size="small"
                    icon={<ThunderboltOutlined />}
                    loading={testingId === provider.id}
                    onClick={() => void testProvider(provider)}
                  />
                </Tooltip>,
                <Tooltip key="activate" title={isActive ? t("Current provider") : t("Set current")}>
                  <Button
                    size="small"
                    icon={<CheckCircleOutlined />}
                    disabled={isActive}
                    loading={activatingId === provider.id}
                    onClick={() => void activateProvider(provider)}
                  />
                </Tooltip>,
                <Tooltip key="edit" title={t("Edit")}>
                  <Button size="small" icon={<EditOutlined />} onClick={() => openProviderForm(provider)} />
                </Tooltip>,
                <Popconfirm
                  key="delete"
                  title={t("Delete model provider?")}
                  disabled={deleteDisabled}
                  onConfirm={() => void deleteProvider(provider)}
                >
                  <Tooltip title={deleteDisabled ? t("At least one provider is required.") : t("Delete")}>
                    <Button
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      disabled={deleteDisabled}
                      loading={deletingId === provider.id}
                    />
                  </Tooltip>
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space wrap>
                    <span>{provider.providerName}</span>
                    {isActive ? <Tag color="green">{t("Current")}</Tag> : null}
                    <Tag
                      color={provider.apiKeySaved ? (provider.apiKeyStorage === "file" ? "orange" : "blue") : "default"}
                    >
                      {provider.apiKeySaved ? `${t("Saved")} (${provider.apiKeyStorage || "file"})` : t("Missing")}
                    </Tag>
                    {provider.apiKeySaved && provider.apiKeyStorage === "file" ? (
                      <Tooltip title={t("System secure storage is unavailable; the API key is stored unencrypted.")}>
                        <span className="muted">⚠</span>
                      </Tooltip>
                    ) : null}
                  </Space>
                }
                description={
                  <Space direction="vertical" size={2}>
                    <span className="mono">{provider.baseUrl}</span>
                    <span>
                      {provider.model} / temp {provider.temperature} / {provider.maxTokens}
                    </span>
                  </Space>
                }
              />
            </List.Item>
          );
        }}
      />
      <Modal
        open={modalOpen}
        title={editingProvider ? t("Edit model provider") : t("New model provider")}
        onCancel={closeProviderForm}
        onOk={() => form.submit()}
        okText={t("Save")}
        confirmLoading={saving}
        footer={(_, { OkBtn, CancelBtn }) => (
          <>
            <Button
              icon={<ThunderboltOutlined />}
              loading={testingId === "__draft__"}
              onClick={async () => {
                const values = await form.validateFields();
                await testProvider(editingProvider || undefined, values);
              }}
            >
              {t("Test")}
            </Button>
            <CancelBtn />
            <OkBtn />
          </>
        )}
      >
        <Form form={form} layout="vertical" onFinish={(values) => void saveProvider(values)}>
          <Form.Item label={t("Provider name")} name="providerName" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t("Base URL")} name="baseUrl" rules={[{ required: true }]}>
            <Input placeholder="https://api.openai.com/v1" />
          </Form.Item>
          <Form.Item label={t("Model")} name="model" rules={[{ required: true }]}>
            <Input placeholder="gpt-4.1-mini" />
          </Form.Item>
          <Form.Item
            label={t("API key")}
            name="apiKey"
            extra={
              editingProvider?.apiKeySaved
                ? t("Leave blank to keep the existing key.")
                : t("Required for real model calls.")
            }
          >
            <Input.Password />
          </Form.Item>
          {editingProvider?.apiKeySaved ? (
            <Form.Item label={t("Clear saved API key")} name="clearApiKey" valuePropName="checked">
              <Switch />
            </Form.Item>
          ) : null}
          <Form.Item label={t("Temperature")} name="temperature">
            <Slider min={0} max={2} step={0.1} />
          </Form.Item>
          <Form.Item label={t("Max tokens")} name="maxTokens">
            <InputNumber min={64} max={128000} style={{ width: "100%" }} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

export function snapshotProviderFallback(snapshot: RuntimeSnapshot): ModelProviderConfig {
  const now = new Date().toISOString();
  return {
    id: snapshot.activeModelProviderId || "default",
    providerName: snapshot.modelConfig.providerName,
    baseUrl: snapshot.modelConfig.baseUrl,
    model: snapshot.modelConfig.model,
    temperature: snapshot.modelConfig.temperature,
    maxTokens: snapshot.modelConfig.maxTokens,
    apiKeySaved: snapshot.modelConfig.apiKeySaved,
    apiKeyStorage: snapshot.modelConfig.apiKeyStorage,
    createdAt: now,
    updatedAt: now,
  };
}

export function modelProviderFormValues(provider: ModelProviderConfig): ModelProviderUpdate {
  return {
    providerName: provider.providerName,
    baseUrl: provider.baseUrl,
    model: provider.model,
    temperature: provider.temperature,
    maxTokens: provider.maxTokens,
    apiKey: "",
    clearApiKey: false,
  };
}

export function newModelProviderValues(snapshot: RuntimeSnapshot): ModelProviderUpdate {
  return {
    providerName: `${snapshot.modelConfig.providerName} copy`,
    baseUrl: snapshot.modelConfig.baseUrl,
    model: snapshot.modelConfig.model,
    temperature: snapshot.modelConfig.temperature,
    maxTokens: snapshot.modelConfig.maxTokens,
    apiKey: "",
    clearApiKey: false,
  };
}

export function PersonalityCard({
  snapshot,
  refresh,
  t,
}: {
  snapshot: RuntimeSnapshot;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [form] = Form.useForm<PersonalityConfig>();
  return (
    <div className="settings-card">
      <Form
        form={form}
        layout="vertical"
        initialValues={{ ...snapshot.personality, traits: snapshot.personality.traits.join(", ") }}
      >
        <Form.Item label={t("Summary")} name="summary">
          <Input />
        </Form.Item>
        <Form.Item label={t("Traits")} name="traits">
          <Input placeholder={t("precise, calm, proactive")} />
        </Form.Item>
        <Form.Item label={t("Instructions")} name="instructions">
          <Input.TextArea rows={5} />
        </Form.Item>
        <Button
          type="primary"
          icon={<SaveOutlined />}
          onClick={async () => {
            const values = (await form.validateFields()) as unknown as {
              summary: string;
              traits: string;
              instructions: string;
            };
            await window.supbot.updatePersonality({
              summary: values.summary,
              traits: values.traits
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
              instructions: values.instructions,
            });
            await refresh();
          }}
        >
          {t("Save personality")}
        </Button>
      </Form>
    </div>
  );
}

export function CapabilitiesCard({
  snapshot,
  refresh,
  t,
}: {
  snapshot: RuntimeSnapshot;
  refresh: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [ruleForm] = Form.useForm<{ toolName: string; behavior: PermissionRule["behavior"] }>();
  const [capabilityForm] = Form.useForm<CapabilityUpdateInput>();
  const [ruleFilter, setRuleFilter] = useState("all");
  const [editingCapability, setEditingCapability] = useState<RuntimeSnapshot["capabilities"][number] | null>(null);
  const [savingCapability, setSavingCapability] = useState(false);
  const [deletingCapabilityId, setDeletingCapabilityId] = useState("");
  const [messageApi, contextHolder] = message.useMessage();
  const toolOptions = [
    { label: t("All tools"), value: "*" },
    { label: "ReadFile", value: "ReadFile" },
    { label: "WriteFile", value: "WriteFile" },
    { label: "Shell", value: "Shell" },
    { label: "Agent", value: "Agent" },
    ...snapshot.mcpServers.map((server) => ({ label: `mcp.${server.id}.*`, value: `mcp.${server.id}.*` })),
    ...snapshot.mcpTools.map((tool) => ({ label: tool.runtimeToolName, value: tool.runtimeToolName })),
  ];
  const filteredRules =
    ruleFilter === "all"
      ? snapshot.permissionRules
      : snapshot.permissionRules.filter((rule) => rule.toolName === ruleFilter);
  const addRule = async (values: { toolName: string; behavior: PermissionRule["behavior"] }) => {
    await window.supbot.addPermissionRule({
      toolName: values.toolName || "*",
      behavior: values.behavior || "ask",
    });
    ruleForm.resetFields();
    await refresh();
  };
  const beginEditCapability = (capability: RuntimeSnapshot["capabilities"][number]) => {
    setEditingCapability(capability);
    capabilityForm.setFieldsValue({
      name: capability.name,
      description: capability.description,
      enabled: capability.enabled,
    });
  };
  const saveCapability = async (values: CapabilityUpdateInput) => {
    if (!editingCapability) {
      return;
    }
    setSavingCapability(true);
    try {
      await window.supbot.updateCapability(editingCapability.id, values);
      setEditingCapability(null);
      capabilityForm.resetFields();
      await refresh();
      messageApi.success(t("Capability saved."));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSavingCapability(false);
    }
  };
  const deleteCapability = async (id: string) => {
    setDeletingCapabilityId(id);
    try {
      await window.supbot.deleteCapability(id);
      await refresh();
      messageApi.success(t("Capability deleted."));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setDeletingCapabilityId("");
    }
  };
  return (
    <div className="settings-stack">
      {contextHolder}
      <div className="settings-card">
        <div className="panel-heading">
          <div className="section-title">
            <ToolOutlined /> {t("Permission mode")}
          </div>
          <Tag>{t(snapshot.permissionMode)}</Tag>
        </div>
        <Segmented
          value={snapshot.permissionMode}
          onChange={async (value) => {
            await window.supbot.setPermissionMode(value as RuntimeSnapshot["permissionMode"]);
            await refresh();
          }}
          options={[
            { label: t("default"), value: "default" },
            { label: t("acceptEdits"), value: "acceptEdits" },
            { label: t("plan"), value: "plan" },
          ]}
        />
        <Divider />
        <div className="permission-rule-builder">
          <Form
            form={ruleForm}
            layout="inline"
            initialValues={{ toolName: "Shell", behavior: "ask" }}
            onFinish={(values) => void addRule(values)}
          >
            <Form.Item name="toolName" rules={[{ required: true }]}>
              <Select className="permission-tool-select" options={toolOptions} />
            </Form.Item>
            <Form.Item name="behavior" rules={[{ required: true }]}>
              <Segmented
                options={[
                  { label: t("allow"), value: "allow" },
                  { label: t("deny"), value: "deny" },
                  { label: t("ask"), value: "ask" },
                ]}
              />
            </Form.Item>
            <Button htmlType="submit" icon={<PlusOutlined />}>
              {t("Add rule")}
            </Button>
          </Form>
          <Select
            className="permission-filter-select"
            value={ruleFilter}
            onChange={setRuleFilter}
            options={[{ label: t("All rules"), value: "all" }, ...toolOptions]}
          />
        </div>
        <div className="permission-rule-list">
          {filteredRules.length ? (
            filteredRules.map((rule) => (
              <div className="permission-rule-row" key={rule.id}>
                <div>
                  <strong>{rule.toolName}</strong>
                  <span className="muted">
                    {t(rule.behavior)} / {formatDateTime(rule.createdAt)}
                  </span>
                </div>
                <Button
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={async () => {
                    await window.supbot.removePermissionRule(rule.id);
                    await refresh();
                  }}
                />
              </div>
            ))
          ) : (
            <span className="muted">{t("No session permission rules")}</span>
          )}
        </div>
      </div>
      <div className="capability-grid">
        {filterVisibleCapabilities(snapshot.capabilities).map((capability) => (
          <div className="capability-card" key={capability.id}>
            <div className="activity-head">
              <div>
                <strong>{t(capability.name)}</strong>
                <div className="muted mono">{capability.id}</div>
              </div>
              <Space wrap>
                <Tag color={capability.enabled ? "green" : "default"}>{t(capability.kind)}</Tag>
              </Space>
            </div>
            <p className="muted">{truncateText(t(capability.description), 50)}</p>
            <div className="capability-card-actions">
              <Button size="small" onClick={() => beginEditCapability(capability)}>
                {t("Edit")}
              </Button>
              <Popconfirm title={t("Delete capability?")} onConfirm={() => void deleteCapability(capability.id)}>
                <Button size="small" danger icon={<DeleteOutlined />} loading={deletingCapabilityId === capability.id}>
                  {t("Delete")}
                </Button>
              </Popconfirm>
            </div>
          </div>
        ))}
      </div>
      <Modal
        open={Boolean(editingCapability)}
        title={t("Edit capability")}
        onCancel={() => {
          setEditingCapability(null);
          capabilityForm.resetFields();
        }}
        onOk={() => capabilityForm.submit()}
        okText={t("Save")}
        confirmLoading={savingCapability}
      >
        {editingCapability ? (
          <div className="capability-modal-meta">
            <div>
              <span>{t("Capability ID")}</span>
              <strong className="mono">{editingCapability.id}</strong>
            </div>
            <div>
              <span>{t("Kind")}</span>
              <strong>{t(editingCapability.kind)}</strong>
            </div>
          </div>
        ) : null}
        <Form form={capabilityForm} layout="vertical" onFinish={(values) => void saveCapability(values)}>
          <Form.Item label={t("Name")} name="name" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label={t("Description")} name="description">
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item label={t("Enabled")} name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

export function SubagentsCard({
  snapshot,
  refresh,
  openSubagent,
  t,
}: {
  snapshot: RuntimeSnapshot;
  refresh: () => void;
  openSubagent: (subagent: SubagentConfig | null) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className="settings-card">
      <div className="panel-heading">
        <div className="section-title">
          <AppstoreOutlined /> {t("Local subagents")}
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => openSubagent(null)}>
          {t("New subagent")}
        </Button>
      </div>
      <List
        dataSource={snapshot.subagents}
        renderItem={(subagent) => (
          <List.Item
            actions={[
              <Button key="edit" onClick={() => openSubagent(subagent)}>
                {t("Edit")}
              </Button>,
              <Popconfirm
                key="delete"
                title={t("Delete subagent?")}
                onConfirm={async () => {
                  await window.supbot.deleteSubagent(subagent.id);
                  await refresh();
                }}
              >
                <Button danger>{t("Delete")}</Button>
              </Popconfirm>,
            ]}
          >
            <List.Item.Meta title={`@${subagent.name}`} description={t(subagent.description)} />
            <Tag color={subagent.enabled ? "cyan" : "default"}>{subagent.enabled ? t("enabled") : t("disabled")}</Tag>
          </List.Item>
        )}
      />
    </div>
  );
}

export function filterVisibleCapabilities(
  capabilities: RuntimeSnapshot["capabilities"] | undefined,
): RuntimeSnapshot["capabilities"] {
  return (capabilities || []).filter((capability) => !hiddenSlashCommandCapabilityIds.has(capability.id));
}
