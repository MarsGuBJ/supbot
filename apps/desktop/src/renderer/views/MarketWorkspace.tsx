import { useCallback, useEffect, useState } from "react";
import {
  AppstoreAddOutlined,
  CheckCircleOutlined,
  ReloadOutlined,
  SettingOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { Alert, Button, Empty, Input, Select, Space, Tag, Typography, message } from "antd";
import type { RuntimeSnapshot, ToolMarketCatalogItem, ToolMarketProductType } from "@supbot/shared";
import { formatDateTime } from "@supbot/shared";

export function MarketWorkspace({
  refresh,
  snapshot,
  openMarketConfig,
  openMcpConfig,
  t,
}: {
  refresh: () => Promise<void>;
  snapshot: RuntimeSnapshot;
  openMarketConfig: () => void;
  openMcpConfig: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [products, setProducts] = useState<ToolMarketCatalogItem[]>([]);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<ToolMarketProductType | "all">("all");
  const [loading, setLoading] = useState(false);
  const [actingId, setActingId] = useState("");
  const [error, setError] = useState("");
  const [messageApi, contextHolder] = message.useMessage();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const items = await window.supbot.listToolMarket({ query, type: typeFilter });
      setProducts(items);
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query, typeFilter]);

  useEffect(() => {
    void load();
  }, [load]);

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
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select
            className="market-type-select"
            value={typeFilter}
            onChange={(value) => setTypeFilter(value as ToolMarketProductType | "all")}
            options={[
              { label: t("All types"), value: "all" },
              { label: t("tool"), value: "tool" },
              { label: t("skill"), value: "skill" },
              { label: t("Plugin"), value: "plugin" },
              { label: "MCP", value: "mcp" },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            {t("Refresh")}
          </Button>
          <Button icon={<SettingOutlined />} onClick={openMarketConfig}>
            {t("Market settings")}
          </Button>
        </Space>
      </div>
      {error ? <Alert type="error" showIcon message={error} /> : null}
      <div className="market-grid">
        {products.map((product) => (
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
        ))}
      </div>
      {!loading && products.length === 0 ? (
        <Empty className="market-empty" description={t("No matching tool products")} />
      ) : null}
    </section>
  );
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
