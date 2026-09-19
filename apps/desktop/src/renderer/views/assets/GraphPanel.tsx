import { useCallback, useEffect, useState } from "react";
import { DeleteOutlined, PlusOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { Button, Empty, Form, Input, List, Popconfirm, Select, Tag } from "antd";
import type { MessageInstance } from "antd/es/message/interface";
import type { GraphExtraction, GraphTemplate, KbDocumentWithProgress, KbGraphStatus } from "@supbot/shared";
import { docStem } from "../../lib/assetsFormat";
import type { Translator } from "../../lib/types";
import { GraphViewModal } from "./GraphViewModal";

const splitTypes = (value: string): string[] =>
  value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);

export function GraphPanel({
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
  const [form] = Form.useForm();
  const [templates, setTemplates] = useState<GraphTemplate[]>([]);
  const [editing, setEditing] = useState("");
  const [saving, setSaving] = useState(false);
  const [extractDoc, setExtractDoc] = useState("");
  const [extracting, setExtracting] = useState("");
  const [statuses, setStatuses] = useState<KbGraphStatus[]>([]);
  const [viewGraph, setViewGraph] = useState<{ title: string; extraction: GraphExtraction } | null>(null);

  const convertedDocs = docs.filter((doc) => doc.task?.status === "done");

  const loadTemplates = useCallback(async () => {
    try {
      setTemplates(await window.supbot.kbListGraphTemplates());
    } catch (error) {
      messageApi.error((error as Error).message);
    }
  }, [messageApi]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  const loadStatuses = useCallback(async () => {
    if (!project || !extractDoc) {
      setStatuses([]);
      return;
    }
    try {
      setStatuses(await window.supbot.kbGraphStatus(project, extractDoc));
    } catch (error) {
      messageApi.error((error as Error).message);
    }
  }, [project, extractDoc, messageApi]);

  useEffect(() => {
    setExtractDoc("");
    setStatuses([]);
  }, [project]);

  useEffect(() => {
    void loadStatuses();
  }, [loadStatuses]);

  const editTemplate = (template: GraphTemplate) => {
    setEditing(template.name);
    form.setFieldsValue({
      name: template.name,
      description: template.description || "",
      entityTypes: template.entityTypes.join(", "),
      relationTypes: template.relationTypes.join(", "),
      instructions: template.instructions || "",
    });
  };

  const resetForm = () => {
    setEditing("");
    form.resetFields();
  };

  const saveTemplate = async (values: {
    name: string;
    description?: string;
    entityTypes?: string;
    relationTypes?: string;
    instructions?: string;
  }) => {
    const name = values.name.trim();
    if (!name) {
      messageApi.warning(t("Please enter a template name."));
      return;
    }
    setSaving(true);
    try {
      await window.supbot.kbSaveGraphTemplate({
        name,
        description: values.description?.trim() || undefined,
        entityTypes: splitTypes(values.entityTypes || ""),
        relationTypes: splitTypes(values.relationTypes || ""),
        instructions: values.instructions?.trim() || undefined,
      });
      messageApi.success(t("Template saved."));
      resetForm();
      await loadTemplates();
      await loadStatuses();
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const deleteTemplate = async (name: string) => {
    try {
      await window.supbot.kbDeleteGraphTemplate(name);
      messageApi.success(t("Template deleted."));
      if (editing === name) {
        resetForm();
      }
      await loadTemplates();
      await loadStatuses();
    } catch (error) {
      messageApi.error((error as Error).message);
    }
  };

  const extract = async (templateName: string) => {
    if (!project || !extractDoc || extracting) {
      return;
    }
    setExtracting(templateName);
    try {
      const extraction = await window.supbot.kbGraphExtract(project, extractDoc, templateName);
      messageApi.success(extraction.match ? t("Extraction done.") : t("No extraction matched."));
      await loadStatuses();
      setViewGraph({ title: `${extractDoc} — ${templateName}`, extraction });
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setExtracting("");
    }
  };

  const viewExtraction = async (templateName: string) => {
    if (!project || !extractDoc) {
      return;
    }
    try {
      const extraction = await window.supbot.kbGraphView(project, extractDoc, templateName);
      setViewGraph({ title: `${extractDoc} — ${templateName}`, extraction });
    } catch (error) {
      messageApi.error((error as Error).message);
    }
  };

  if (!project) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("Select a project first")} />;
  }

  return (
    <div className="assets-graph">
      <div className="assets-graph-top">
        <div className="assets-graph-tpl-list">
          <div className="assets-sub-header">
            <span>{t("Graph templates")}</span>
            <Button size="small" icon={<PlusOutlined />} onClick={resetForm}>
              {t("New template")}
            </Button>
          </div>
          {templates.length ? (
            <List
              className="assets-list"
              dataSource={templates}
              renderItem={(template) => (
                <List.Item
                  className={`assets-list-item ${template.name === editing ? "active" : ""}`}
                  onClick={() => editTemplate(template)}
                >
                  <div className="assets-tpl-main">
                    <span className="assets-list-text">{template.name}</span>
                    {template.description ? <span className="assets-tpl-desc">{template.description}</span> : null}
                  </div>
                  <Popconfirm
                    title={t("Delete this template?")}
                    okText={t("Delete")}
                    cancelText={t("Cancel")}
                    onConfirm={() => void deleteTemplate(template.name)}
                  >
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={(event) => event.stopPropagation()}
                    />
                  </Popconfirm>
                </List.Item>
              )}
            />
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No templates yet")} />
          )}
        </div>
        <Form
          form={form}
          layout="vertical"
          className="assets-tpl-form"
          onFinish={(values) => void saveTemplate(values)}
        >
          <Form.Item
            name="name"
            label={t("Template name")}
            rules={[{ required: true, message: t("Please enter a template name.") }]}
          >
            <Input placeholder={t("e.g. People relations")} maxLength={64} />
          </Form.Item>
          <Form.Item name="description" label={t("Description")}>
            <Input placeholder={t("What knowledge this template extracts")} />
          </Form.Item>
          <Form.Item name="entityTypes" label={t("Entity types (comma separated)")}>
            <Input placeholder={t("Person, Organization, Location")} />
          </Form.Item>
          <Form.Item name="relationTypes" label={t("Relation types (comma separated)")}>
            <Input placeholder={t("belongs to, cooperates with, located in")} />
          </Form.Item>
          <Form.Item name="instructions" label={t("Extra instructions")}>
            <Input.TextArea rows={3} placeholder={t("Extra requirements for the extraction model (optional)")} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={saving} block>
            {t("Save template")}
          </Button>
        </Form>
      </div>
      <div className="assets-graph-extract">
        <div className="assets-sub-header">
          <span>{t("Extract by document")}</span>
        </div>
        <div className="assets-extract-row">
          <Select
            className="assets-extract-doc"
            placeholder={t("Select a document")}
            value={extractDoc || undefined}
            onChange={setExtractDoc}
            options={convertedDocs.map((doc) => ({ value: docStem(doc.fileName), label: docStem(doc.fileName) }))}
            showSearch
          />
        </div>
        {extractDoc ? (
          <List
            className="assets-list assets-graph-status-list"
            dataSource={templates}
            renderItem={(template) => {
              const status = statuses.find((item) => item.templateName === template.name);
              return (
                <List.Item className="assets-graph-status-item">
                  <span className="assets-list-text">{template.name}</span>
                  <span className="assets-graph-status-actions">
                    <Tag color={status?.extracted ? "success" : "default"}>
                      {status?.extracted ? t("Extracted") : t("Not extracted")}
                    </Tag>
                    {status?.extracted ? (
                      <Button size="small" onClick={() => void viewExtraction(template.name)}>
                        {t("View graph")}
                      </Button>
                    ) : null}
                    <Button
                      size="small"
                      type="primary"
                      ghost
                      icon={<ThunderboltOutlined />}
                      loading={extracting === template.name}
                      disabled={Boolean(extracting) && extracting !== template.name}
                      onClick={() => void extract(template.name)}
                    >
                      {t("Extract")}
                    </Button>
                  </span>
                </List.Item>
              );
            }}
          />
        ) : (
          <p className="assets-placeholder">{t("Select a document to see extraction status")}</p>
        )}
      </div>
      <GraphViewModal
        extraction={viewGraph?.extraction || null}
        title={viewGraph ? `${t("Graph")} — ${viewGraph.title}` : ""}
        open={Boolean(viewGraph)}
        onClose={() => setViewGraph(null)}
        t={t}
      />
    </div>
  );
}
