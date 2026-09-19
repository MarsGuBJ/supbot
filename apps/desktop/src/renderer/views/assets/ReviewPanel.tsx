import { useCallback, useEffect, useState } from "react";
import { CheckOutlined, FileSearchOutlined, SafetyCertificateOutlined } from "@ant-design/icons";
import { Button, Empty, List, Progress, Spin, Tag } from "antd";
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
      await window.supbot.kbResolveReview(project, item.id);
      messageApi.success(t("Review resolved."));
      await loadReviews();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setResolvingId(null);
    }
  };

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
        <span>{t("Review queue")}</span>
        <Button size="small" icon={<SafetyCertificateOutlined />} loading={lintLoading} onClick={() => void runLint()}>
          {t("Run lint")}
        </Button>
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
        {reviews.length ? (
          <List
            className="assets-list"
            dataSource={reviews}
            renderItem={(item) => (
              <List.Item className="assets-review-item">
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
                  <Button
                    size="small"
                    icon={<CheckOutlined />}
                    loading={resolvingId === item.id}
                    onClick={() => void resolveReview(item)}
                  >
                    {t("Resolve")}
                  </Button>
                ) : null}
              </List.Item>
            )}
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No review items")} />
        )}
      </Spin>
    </div>
  );
}
