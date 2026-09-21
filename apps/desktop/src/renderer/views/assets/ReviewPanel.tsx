import { useCallback, useEffect, useState } from "react";
import { CheckOutlined, DeleteOutlined, FileSearchOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { Button, Checkbox, Empty, List, Popconfirm, Progress, Space, Spin, Tabs, Tag } from "antd";
import type { MessageInstance } from "antd/es/message/interface";
import type { KbLintReport, KbReviewItem } from "@supbot/shared";
import type { Translator } from "../../lib/types";

export function ReviewPanel({
  project,
  t,
  messageApi,
}: {
  project: string;
  t: Translator;
  messageApi: MessageInstance;
}) {
  const [reviews, setReviews] = useState<KbReviewItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolvingId, setResolvingId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [batchResolving, setBatchResolving] = useState(false);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [tab, setTab] = useState<"queue" | "resolved">("queue");
  const [lintLoading, setLintLoading] = useState(false);
  const [lint, setLint] = useState<KbLintReport | null>(null);

  const loadReviews = useCallback(async () => {
    if (!project) {
      setReviews([]);
      return;
    }
    setLoading(true);
    try {
      setReviews(await window.supbot.kbListReviews(project));
      setSelectedIds([]);
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [project, messageApi]);

  useEffect(() => {
    setLint(null);
    void loadReviews();
  }, [loadReviews]);

  const resolveReview = async (item: KbReviewItem) => {
    setResolvingId(item.id);
    try {
      const resolved = await window.supbot.kbResolveReview(project, item.id);
      if (resolved) {
        messageApi.success(t("Review resolved."));
      } else {
        messageApi.warning(t("Review item was already resolved."));
      }
      await loadReviews();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setResolvingId(null);
    }
  };

  const resolveSelected = async () => {
    setBatchResolving(true);
    try {
      const results = await Promise.all(selectedIds.map((id) => window.supbot.kbResolveReview(project, id)));
      const count = results.filter(Boolean).length;
      if (count > 0) {
        messageApi.success(t("Resolved {count} review items.", { count }));
      } else {
        messageApi.warning(t("Review item was already resolved."));
      }
      setSelectedIds([]);
      await loadReviews();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setBatchResolving(false);
    }
  };

  const toggleSelected = (id: number, checked: boolean) => {
    setSelectedIds((current) => (checked ? [...current, id] : current.filter((item) => item !== id)));
  };

  const removeDeadLink = async (item: KbReviewItem) => {
    setRemovingId(item.id);
    try {
      const removed = await window.supbot.kbRemoveDeadLink(project, item.id);
      if (removed) {
        messageApi.success(t("Dead link removed."));
      } else {
        messageApi.warning(t("Failed to remove the dead link."));
      }
      await loadReviews();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setRemovingId(null);
    }
  };

  const deleteReview = async (item: KbReviewItem) => {
    setRemovingId(item.id);
    try {
      const removed = await window.supbot.kbRemoveReview(project, item.id);
      if (removed) {
        messageApi.success(t("Review record deleted."));
      } else {
        messageApi.warning(t("Failed to delete the review record."));
      }
      await loadReviews();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setRemovingId(null);
    }
  };

  const unresolvedIds = reviews.filter((item) => item.status !== "resolved").map((item) => item.id);
  const allSelected = unresolvedIds.length > 0 && unresolvedIds.every((id) => selectedIds.includes(id));
  const queueItems = reviews.filter((item) => item.status !== "resolved");
  const resolvedItems = reviews.filter((item) => item.status === "resolved");
  const visibleItems = tab === "queue" ? queueItems : resolvedItems;

  const runLint = async () => {
    setLintLoading(true);
    try {
      setLint(await window.supbot.kbLint(project));
      messageApi.success(t("Lint finished."));
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setLintLoading(false);
    }
  };

  if (!project) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("Select a project first")} />;
  }

  const lintClean =
    lint &&
    !lint.dead_links.length &&
    !lint.orphan_pages.length &&
    !lint.index_drift.missing_in_index.length &&
    !lint.index_drift.stale_in_index.length;

  return (
    <div className="assets-review">
      <div className="assets-sub-header">
        <Tabs
          className="assets-review-tabs"
          activeKey={tab}
          onChange={(key) => setTab(key as "queue" | "resolved")}
          items={[
            { key: "queue", label: `${t("Review queue")} (${queueItems.length})` },
            { key: "resolved", label: `${t("Handled")} (${resolvedItems.length})` },
          ]}
        />
        <Space size="small">
          {tab === "queue" && unresolvedIds.length ? (
            <>
              <Checkbox
                checked={allSelected}
                indeterminate={selectedIds.length > 0 && !allSelected}
                onChange={(event) => setSelectedIds(event.target.checked ? unresolvedIds : [])}
              >
                {t("Select all")}
              </Checkbox>
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                disabled={!selectedIds.length}
                loading={batchResolving}
                onClick={() => void resolveSelected()}
              >
                {t("Resolve selected")}
              </Button>
            </>
          ) : null}
          <Button
            size="small"
            icon={<SafetyCertificateOutlined />}
            loading={lintLoading}
            onClick={() => void runLint()}
          >
            {t("Run lint")}
          </Button>
        </Space>
      </div>
      {lint ? (
        <div className="assets-lint-report">
          {lintClean ? (
            <Tag color="success">{t("Lint clean: no issues found")}</Tag>
          ) : (
            <>
              {lint.dead_links.length ? (
                <div className="assets-lint-section">
                  <div className="assets-lint-title">{t("Dead links")}</div>
                  {lint.dead_links.map((link, index) => (
                    <div className="assets-lint-line" key={index}>
                      {link.page} → {link.target}
                    </div>
                  ))}
                </div>
              ) : null}
              {lint.orphan_pages.length ? (
                <div className="assets-lint-section">
                  <div className="assets-lint-title">{t("Orphan pages")}</div>
                  {lint.orphan_pages.map((page) => (
                    <div className="assets-lint-line" key={page}>
                      {page}
                    </div>
                  ))}
                </div>
              ) : null}
              {lint.index_drift.missing_in_index.length || lint.index_drift.stale_in_index.length ? (
                <div className="assets-lint-section">
                  <div className="assets-lint-title">{t("Index drift")}</div>
                  {lint.index_drift.missing_in_index.map((page) => (
                    <div className="assets-lint-line" key={`missing-${page}`}>
                      {t("Missing in index")}: {page}
                    </div>
                  ))}
                  {lint.index_drift.stale_in_index.map((page) => (
                    <div className="assets-lint-line" key={`stale-${page}`}>
                      {t("Stale in index")}: {page}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      <Spin spinning={loading}>
        {visibleItems.length ? (
          <List
            className="assets-list"
            dataSource={visibleItems}
            renderItem={(item) => (
              <List.Item className="assets-review-item">
                {item.status !== "resolved" ? (
                  <Checkbox
                    checked={selectedIds.includes(item.id)}
                    onChange={(event) => toggleSelected(item.id, event.target.checked)}
                  />
                ) : null}
                <div className="assets-doc-main">
                  <div className="assets-doc-title-row">
                    <FileSearchOutlined className="assets-list-icon" />
                    <span className="assets-list-text" title={item.sourceFile}>
                      {item.sourceFile}
                    </span>
                    <Tag color={item.status === "resolved" ? "success" : "warning"}>
                      {item.status === "resolved" ? t("Resolved") : t("Unresolved")}
                    </Tag>
                  </div>
                  <div className="assets-review-reason">{item.reason}</div>
                  <div className="assets-review-confidence">
                    <span>{t("Confidence")}</span>
                    <Progress
                      percent={Math.round(item.confidence * 100)}
                      size="small"
                      status={item.confidence < 0.6 ? "exception" : "normal"}
                    />
                  </div>
                </div>
                {item.status !== "resolved" ? (
                  <Space size={4}>
                    {item.reason.startsWith("lint:dead_link") ? (
                      <Popconfirm
                        title={t("Remove this dead link from the source page?")}
                        onConfirm={() => void removeDeadLink(item)}
                      >
                        <Button size="small" danger icon={<DeleteOutlined />} loading={removingId === item.id}>
                          {t("Delete dead link")}
                        </Button>
                      </Popconfirm>
                    ) : null}
                    <Button
                      size="small"
                      icon={<CheckOutlined />}
                      loading={resolvingId === item.id}
                      onClick={() => void resolveReview(item)}
                    >
                      {t("Resolve")}
                    </Button>
                  </Space>
                ) : (
                  <Popconfirm title={t("Delete this review record?")} onConfirm={() => void deleteReview(item)}>
                    <Button size="small" danger icon={<DeleteOutlined />} loading={removingId === item.id}>
                      {t("Delete")}
                    </Button>
                  </Popconfirm>
                )}
              </List.Item>
            )}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={tab === "queue" ? t("No review items") : t("No handled items")}
          />
        )}
      </Spin>
    </div>
  );
}
