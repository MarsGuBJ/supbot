import { useCallback, useEffect, useState } from "react";
import {
  AppstoreAddOutlined,
  CheckCircleOutlined,
  LoginOutlined,
  ReloadOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { Alert, Button, Empty, Form, Input, Modal, Pagination, Select, Space, Tag, Typography, message } from "antd";
import type { RuntimeSnapshot, ToolMarketCatalogItem, ToolMarketProductType } from "@supbot/shared";
import { defaultToolMarketApiUrl, formatDateTime } from "@supbot/shared";

const marketPageSize = 15;

export function MarketWorkspace({
  refresh,
  snapshot,
  openMcpConfig,
  t,
}: {
  refresh: () => Promise<void>;
  snapshot: RuntimeSnapshot;
  openMcpConfig: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [pinned, setPinned] = useState<ToolMarketCatalogItem[]>([]);
  const [products, setProducts] = useState<ToolMarketCatalogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<ToolMarketProductType | "all">("all");
  const [loading, setLoading] = useState(false);
  const [actingId, setActingId] = useState("");
  const [error, setError] = useState("");
  const [loginOpen, setLoginOpen] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginForm] = Form.useForm<{ accountEmail: string; password: string }>();
  const [messageApi, contextHolder] = message.useMessage();
  const marketConfig = snapshot.toolMarketConfig;
  const remoteEnabled = marketConfig.source !== "local";
  const loggedIn = marketConfig.passwordSaved || marketConfig.accessTokenSaved;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await window.supbot.listToolMarket({ query, type: typeFilter, page, pageSize: marketPageSize });
      setPinned(result.pinned);
      setProducts(result.items);
      setTotal(result.total);
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query, typeFilter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitLogin = async (values: { accountEmail: string; password: string }) => {
    setLoggingIn(true);
    try {
      await window.supbot.updateToolMarketConfig({
        source: remoteEnabled ? marketConfig.source : "hybrid",
        apiUrl: marketConfig.apiUrl.trim() || defaultToolMarketApiUrl,
        accountEmail: values.accountEmail,
        password: values.password,
      });
      messageApi.success(t("Tool market configuration saved."));
      setLoginOpen(false);
      loginForm.resetFields();
      await refresh();
      await load();
    } catch (loginError) {
      messageApi.error((loginError as Error).message);
    } finally {
      setLoggingIn(false);
    }
  };

  const toggleInstall = async (product: ToolMarketCatalogItem) => {
    if (product.id === "local-mcp-bridge") {
      openMcpConfig();
      return;
    }
    setActingId(product.id);
    try {
      if (product.installed) {
        await window.supbot.uninstallToolMarketProduct(product.id);
        messageApi.success(t("Tool uninstalled."));
      } else {
        await window.supbot.installToolMarketProduct(product.id);
        messageApi.success(t("Tool installed."));
      }
      await load();
      await refresh();
    } catch (actionError) {
      messageApi.error((actionError as Error).message);
    } finally {
      setActingId("");
    }
  };

  return (
    <section className="market-panel">
      {contextHolder}
      <div className="market-header">
        <div>
          <div className="eyebrow">{t("LOCAL TOOL MARKET")}</div>
          <Typography.Title level={3}>{t("Tool Market")}</Typography.Title>
          <div className="muted">{t("Install local and remote capabilities into this single-user agent.")}</div>
          <div className="market-source-row">
            <Tag color="cyan">{t(`market.source.${snapshot.toolMarketConfig.source}`)}</Tag>
            {snapshot.toolMarketConfig.apiUrl ? (
              <Tag>{snapshot.toolMarketConfig.apiUrl}</Tag>
            ) : (
              <Tag>{t("Built-in catalog")}</Tag>
            )}
            {snapshot.toolMarketConfig.lastSyncedAt ? (
              <Tag>{t("Last sync: {time}", { time: formatDateTime(snapshot.toolMarketConfig.lastSyncedAt) })}</Tag>
            ) : null}
          </div>
        </div>
        <Space wrap>
          <Input
            className="market-search"
            allowClear
            value={query}
            placeholder={t("Search tool products")}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
          />
          <Select
            className="market-type-select"
            value={typeFilter}
            onChange={(value) => {
              setTypeFilter(value as ToolMarketProductType | "all");
              setPage(1);
            }}
            options={[
              { label: t("All types"), value: "all" },
              { label: t("tool"), value: "tool" },
              { label: t("skill"), value: "skill" },
              { label: t("Plugin"), value: "plugin" },
              { label: "MCP", value: "mcp" },
            ]}
          />
          {remoteEnabled && !loggedIn ? (
            <Button icon={<LoginOutlined />} onClick={() => setLoginOpen(true)}>
              {t("Log in")}
            </Button>
          ) : null}
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            {t("Refresh")}
          </Button>
        </Space>
      </div>
      <Modal
        title={t("Tool market login")}
        open={loginOpen}
        onCancel={() => setLoginOpen(false)}
        onOk={() => loginForm.submit()}
        confirmLoading={loggingIn}
        okText={t("Log in")}
        cancelText={t("Cancel")}
        destroyOnHidden
      >
        <div className="muted">{t("Log in with your market account to load the remote catalog.")}</div>
        <Form
          form={loginForm}
          layout="vertical"
          initialValues={{ accountEmail: marketConfig.accountEmail }}
          onFinish={(values) => void submitLogin(values)}
        >
          <Form.Item
            label={t("Market account email")}
            name="accountEmail"
            rules={[{ required: true, message: t("Required") }]}
          >
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item label={t("Market password")} name="password" rules={[{ required: true, message: t("Required") }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
        </Form>
      </Modal>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      {!error && snapshot.toolMarketConfig.lastSyncError ? (
        <Alert
          type="warning"
          showIcon
          message={t("Remote market sync failed; showing local catalog only.")}
          description={snapshot.toolMarketConfig.lastSyncError}
        />
      ) : null}
      {pinned.length > 0 ? (
        <>
          <div className="eyebrow">{t("Local and installed")}</div>
          <div className="market-grid">{pinned.map(renderProduct)}</div>
        </>
      ) : null}
      {remoteEnabled && pinned.length > 0 ? <div className="eyebrow">{t("Remote")}</div> : null}
      <div className="market-grid">{products.map(renderProduct)}</div>
      {total > marketPageSize ? (
        <Pagination
          current={page}
          pageSize={marketPageSize}
          total={total}
          showSizeChanger={false}
          onChange={(nextPage) => setPage(nextPage)}
        />
      ) : null}
      {!loading && pinned.length === 0 && products.length === 0 ? (
        <Empty className="market-empty" description={t("No matching tool products")} />
      ) : null}
    </section>
  );

  function renderProduct(product: ToolMarketCatalogItem) {
    return (
      <article className={`market-product ${product.installed ? "is-installed" : ""}`} key={product.id}>
        <div className="market-product-head">
          <div className="market-product-icon">
            <ToolOutlined />
          </div>
          <div className="market-product-copy">
            <div className="market-product-title">{t(product.name)}</div>
            <div className="muted">{t(product.providerName)}</div>
          </div>
          <Tag color={marketTypeColor(product.type)}>{t(product.type)}</Tag>
        </div>
        <div className="market-product-description">{t(product.description)}</div>
        <div className="market-product-meta">
          <Tag color={product.origin === "remote" ? "blue" : "default"}>
            {product.origin === "remote" ? t("Remote") : t("Local")}
          </Tag>
          <Tag color={product.free ? "green" : "gold"}>
            {product.priceLabel ? t(product.priceLabel) : product.free ? t("Free") : t("Paid")}
          </Tag>
          {product.tags.map((tag) => (
            <Tag key={`${product.id}-${tag}`}>{t(tag)}</Tag>
          ))}
          {product.purchased ? <Tag color="blue">{t("Purchased")}</Tag> : null}
          {product.sourceHealth ? <Tag>{product.sourceHealth}</Tag> : null}
          {product.installed ? <Tag color="green">{t("Installed")}</Tag> : null}
        </div>
        <Button
          className="market-product-action"
          type={product.installed ? "default" : "primary"}
          icon={product.installed ? <CheckCircleOutlined /> : <AppstoreAddOutlined />}
          loading={actingId === product.id}
          disabled={Boolean(actingId) && actingId !== product.id}
          onClick={() => void toggleInstall(product)}
        >
          {product.id === "local-mcp-bridge" ? t("Configure") : product.installed ? t("Uninstall") : t("Install")}
        </Button>
      </article>
    );
  }
}

export function marketTypeColor(type: ToolMarketProductType): string {
  switch (type) {
    case "mcp":
      return "purple";
    case "plugin":
      return "blue";
    case "skill":
      return "cyan";
    default:
      return "green";
  }
}
