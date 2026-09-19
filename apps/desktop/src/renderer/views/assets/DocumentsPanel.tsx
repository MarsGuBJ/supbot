import { useRef, useState } from "react";
import type { DragEvent } from "react";
import { CloudUploadOutlined, DeleteOutlined, FileOutlined, SyncOutlined } from "@ant-design/icons";
import { Button, Empty, List, Popconfirm, Progress, Spin, Tag, Tooltip } from "antd";
import type { MessageInstance } from "antd/es/message/interface";
import type { KbDocumentWithProgress, KbUploadFileInput } from "@supbot/shared";
import { docStem, formatKbBytes, kbDocStatus, kbDocStatusColor } from "../../lib/assetsFormat";
import type { Translator } from "../../lib/types";

const STATUS_LABEL_KEYS: Record<string, string> = {
  pending: "Pending",
  parsing: "Parsing",
  ingesting: "Ingesting",
  done: "Done",
  failed: "Failed",
  none: "Not ingested",
};

export function DocumentsPanel({
  project,
  docs,
  loading,
  refreshDocs,
  t,
  messageApi,
}: {
  project: string;
  docs: KbDocumentWithProgress[];
  loading: boolean;
  refreshDocs: () => void;
  t: Translator;
  messageApi: MessageInstance;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyAction, setBusyAction] = useState("");

  const uploadFiles = async (files: File[]) => {
    if (!project || !files.length) {
      return;
    }
    setUploading(true);
    try {
      const payload: KbUploadFileInput[] = [];
      for (const file of files) {
        payload.push({ name: file.name, data: await file.arrayBuffer() });
      }
      await window.supbot.kbUploadDocuments(project, payload);
      messageApi.success(t("Uploaded {count} file(s).", { count: payload.length }));
      refreshDocs();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    void uploadFiles(Array.from(event.dataTransfer.files));
  };

  const rescan = async () => {
    if (!project || busyAction) {
      return;
    }
    setBusyAction("rescan");
    try {
      const result = await window.supbot.kbRescan(project);
      messageApi.success(
        t("Rescan finished: {enqueued} enqueued, {skipped} skipped.", {
          enqueued: result.enqueued.length,
          skipped: result.skipped.length,
        }),
      );
      refreshDocs();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setBusyAction("");
    }
  };

  const deleteDoc = async (doc: KbDocumentWithProgress) => {
    if (busyAction) {
      return;
    }
    setBusyAction(`delete:${doc.id}`);
    try {
      await window.supbot.kbDeleteSource(project, docStem(doc.fileName));
      messageApi.success(t("Document deleted."));
      refreshDocs();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setBusyAction("");
    }
  };

  if (!project) {
    return (
      <div className="assets-col assets-docs">
        <div className="assets-col-header">
          <span className="assets-col-title">{t("Files")}</span>
        </div>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("Select a project first")} />
      </div>
    );
  }

  return (
    <div className="assets-col assets-docs">
      <div className="assets-col-header">
        <span className="assets-col-title">{t("Files")}</span>
        <Button size="small" icon={<SyncOutlined />} loading={busyAction === "rescan"} onClick={() => void rescan()}>
          {t("Rescan")}
        </Button>
      </div>
      <div
        className={`assets-dropzone ${dragOver ? "drag-over" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            fileInputRef.current?.click();
          }
        }}
      >
        <CloudUploadOutlined className="assets-dropzone-icon" />
        <span>{t("Drag files here, or click to select files")}</span>
        <span className="assets-dropzone-hint">{t("Uploads enter the ingest queue automatically")}</span>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            void uploadFiles(Array.from(event.target.files || []));
            event.target.value = "";
          }}
        />
      </div>
      <Spin spinning={loading || uploading}>
        {docs.length ? (
          <List
            className="assets-list assets-doc-list"
            dataSource={docs}
            renderItem={(doc) => {
              const status = kbDocStatus(doc);
              const active =
                status.status === "pending" || status.status === "parsing" || status.status === "ingesting";
              return (
                <List.Item className="assets-doc-item">
                  <div className="assets-doc-main">
                    <div className="assets-doc-title-row">
                      <FileOutlined className="assets-list-icon" />
                      <span className="assets-list-text" title={doc.fileName}>
                        {doc.fileName}
                      </span>
                      <Tag color={kbDocStatusColor(status.status)}>{t(STATUS_LABEL_KEYS[status.status])}</Tag>
                    </div>
                    <div className="assets-doc-meta">
                      <span>{doc.format.toUpperCase()}</span>
                      <span>{formatKbBytes(doc.sizeBytes)}</span>
                    </div>
                    {active ? <Progress percent={Math.round(status.progress * 100)} size="small" /> : null}
                    {status.status === "failed" && status.error ? (
                      <div className="assets-doc-error" title={status.error}>
                        {status.error}
                      </div>
                    ) : null}
                  </div>
                  <Popconfirm
                    title={t("Delete this document and its derived pages?")}
                    okText={t("Delete")}
                    cancelText={t("Cancel")}
                    onConfirm={() => void deleteDoc(doc)}
                  >
                    <Tooltip title={t("Delete")}>
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        loading={busyAction === `delete:${doc.id}`}
                      />
                    </Tooltip>
                  </Popconfirm>
                </List.Item>
              );
            }}
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No files yet")} />
        )}
      </Spin>
    </div>
  );
}
