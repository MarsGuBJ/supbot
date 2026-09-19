import { useEffect, useMemo, useState } from "react";
import { FileTextOutlined } from "@ant-design/icons";
import { Empty, List, Spin } from "antd";
import type { MessageInstance } from "antd/es/message/interface";
import type { KbDocumentWithProgress, KbMarkdownDocument } from "@supbot/shared";
import { docStem } from "../../lib/assetsFormat";
import type { Translator } from "../../lib/types";
import { MarkdownPreview } from "./MarkdownPreview";

export function MarkdownPanel({
  project,
  docs,
  t,
  messageApi,
}: {
  project: string;
  docs: KbDocumentWithProgress[];
  t: Translator;
  messageApi: MessageInstance;
}) {
  const [selected, setSelected] = useState("");
  const [markdown, setMarkdown] = useState<KbMarkdownDocument | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const converted = useMemo(() => docs.filter((doc) => doc.task?.status === "done"), [docs]);

  useEffect(() => {
    setSelected("");
    setMarkdown(null);
  }, [project]);

  const openMarkdown = async (doc: KbDocumentWithProgress) => {
    const stem = docStem(doc.fileName);
    setSelected(stem);
    setPreviewLoading(true);
    try {
      setMarkdown(await window.supbot.kbReadMarkdown(project, stem));
    } catch (error) {
      messageApi.error((error as Error).message);
      setMarkdown(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  if (!project) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("Select a project first")} />;
  }

  return (
    <div className="assets-tab-body">
      <div className="assets-tab-list">
        {converted.length ? (
          <List
            className="assets-list"
            dataSource={converted}
            renderItem={(doc) => {
              const stem = docStem(doc.fileName);
              return (
                <List.Item
                  className={`assets-list-item ${stem === selected ? "active" : ""}`}
                  onClick={() => void openMarkdown(doc)}
                >
                  <FileTextOutlined className="assets-list-icon" />
                  <span className="assets-list-text" title={stem}>
                    {stem}
                  </span>
                </List.Item>
              );
            }}
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No converted Markdown yet")} />
        )}
      </div>
      <div className="assets-tab-preview">
        <Spin spinning={previewLoading}>
          {markdown ? (
            <MarkdownPreview text={markdown.markdown} />
          ) : (
            <p className="assets-placeholder">{t("Click a file to preview")}</p>
          )}
        </Spin>
      </div>
    </div>
  );
}
