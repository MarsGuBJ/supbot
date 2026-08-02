import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import {
  Archive,
  Calculator,
  CheckCircle2,
  Database,
  Download,
  FileClock,
  FileJson,
  GitBranch,
  ListTree,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Scale,
  Send,
  Settings2,
  ShieldCheck,
  Trash2,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import { newIdempotencyKey, requestJSON } from "../api";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "../components/Workspace";
import type { Session } from "../types";

interface RatingEnvelope<T> {
  success: boolean;
  data: T;
  error?: string | null;
}

interface RatingModel {
  id: string;
  name: string;
  category: string;
  property: string;
  version: number;
  artifact_hash: string;
  lifecycle_status: "draft" | "in_review" | "approved" | "rejected" | "published" | "retired";
  revision_of?: string;
  submitted_by?: string;
  reviewed_by?: string;
  published_by?: string;
  review_comment?: string;
  update_time?: string;
}

interface RatingIndicator {
  id: string;
  icode: string;
  name: string;
  level: number;
  formula: number;
  function: number;
  weight?: number;
  parent_id?: string;
  description?: string;
  ranges: unknown[];
  sources: unknown[];
}

interface RatingSource {
  id: string;
  src_name: string;
  src_type: number;
  db_link: string;
  sql_str: string;
  fields: unknown[];
  update_time?: string;
}

interface RatingDictionary {
  id: string;
  name: string;
  mainaccount?: number;
  dict_function?: string;
  items: unknown[];
}

interface RatingScale {
  id: string;
  name: string;
  description?: string;
  items: unknown[];
  update_time?: string;
}

interface RatingBatch {
  id: string;
  model_id: string;
  unit_id: string;
  score?: number;
  level?: string;
  model_version: number;
  create_time: string;
}

interface EditorState {
  title: string;
  method: "POST" | "PUT";
  path: string;
  value: string;
}

type View = "governance" | "configuration" | "run" | "executions";
type ConfigView = "indicators" | "sources" | "dictionaries" | "scales" | "format";

const statusLabels: Record<RatingModel["lifecycle_status"], string> = {
  draft: "草稿",
  in_review: "待复核",
  approved: "已复核",
  rejected: "已退回",
  published: "已发布",
  retired: "已停用",
};

const statusTone: Record<RatingModel["lifecycle_status"], string> = {
  draft: "info",
  in_review: "warning",
  approved: "success",
  rejected: "danger",
  published: "success",
  retired: "",
};

export default function RiskRatingPage({ session }: { session: Session }) {
  const [view, setView] = useState<View>("governance");
  const [configView, setConfigView] = useState<ConfigView>("indicators");
  const [models, setModels] = useState<RatingModel[]>([]);
  const [batches, setBatches] = useState<RatingBatch[]>([]);
  const [indicators, setIndicators] = useState<RatingIndicator[]>([]);
  const [sources, setSources] = useState<RatingSource[]>([]);
  const [dictionaries, setDictionaries] = useState<RatingDictionary[]>([]);
  const [scales, setScales] = useState<RatingScale[]>([]);
  const [formatMeta, setFormatMeta] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [configLoading, setConfigLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [creditCode, setCreditCode] = useState("");
  const [reportDate, setReportDate] = useState(new Date().toISOString().slice(0, 10));
  const [formValues, setFormValues] = useState("{}");
  const [runResult, setRunResult] = useState<Record<string, unknown> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const selected = useMemo(() => models.find((model) => model.id === selectedModel), [models, selectedModel]);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [modelResponse, batchResponse] = await Promise.all([
        requestJSON<RatingEnvelope<RatingModel[]>>("/rating/models", { method: "GET" }, session),
        requestJSON<RatingEnvelope<RatingBatch[]>>("/rating/batches?limit=100", { method: "GET" }, session),
      ]);
      setModels(modelResponse.data || []);
      setBatches(batchResponse.data || []);
      setSelectedModel((current) =>
        modelResponse.data?.some((model) => model.id === current) ? current : modelResponse.data?.[0]?.id || "",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("评级数据读取失败"));
    } finally {
      setLoading(false);
    }
  };

  const refreshConfiguration = async (modelId = selectedModel) => {
    if (!modelId) return;
    setConfigLoading(true);
    setError(null);
    try {
      const [indicatorResponse, sourceResponse, dictionaryResponse, scaleResponse, formatResponse] = await Promise.all([
        requestJSON<RatingEnvelope<RatingIndicator[]>>(
          `/rating/models/${encodeURIComponent(modelId)}/indicators`,
          { method: "GET" },
          session,
        ),
        requestJSON<RatingEnvelope<RatingSource[]>>("/rating/datasources", { method: "GET" }, session),
        requestJSON<RatingEnvelope<RatingDictionary[]>>("/rating/dicts", { method: "GET" }, session),
        requestJSON<RatingEnvelope<RatingScale[]>>("/rating/scales", { method: "GET" }, session),
        requestJSON<RatingEnvelope<Record<string, unknown>>>(
          `/rating/models/${encodeURIComponent(modelId)}/format-meta`,
          { method: "GET" },
          session,
        ),
      ]);
      setIndicators(indicatorResponse.data || []);
      setSources(sourceResponse.data || []);
      setDictionaries(dictionaryResponse.data || []);
      setScales(scaleResponse.data || []);
      setFormatMeta(formatResponse.data || {});
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("模型配置读取失败"));
    } finally {
      setConfigLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [session]);

  useEffect(() => {
    if (view === "configuration" && selectedModel) void refreshConfiguration(selectedModel);
  }, [view, selectedModel]);

  const mutate = async (path: string, method: string, body?: unknown) => {
    const headers: Record<string, string> = { "Idempotency-Key": newIdempotencyKey("rating-config") };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (selected) headers["If-Match"] = `"${selected.version}"`;
    return requestJSON<RatingEnvelope<unknown>>(
      path,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      session,
    );
  };

  const finishMutation = async () => {
    await refresh();
    if (view === "configuration" && selectedModel) await refreshConfiguration();
  };

  const transitionModel = async (action: string, body?: unknown) => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      await mutate(`/rating/models/${encodeURIComponent(selected.id)}/${action}`, "POST", body);
      await finishMutation();
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("模型治理操作失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const saveEditor = async (event: FormEvent) => {
    event.preventDefault();
    if (!editor) return;
    setSubmitting(true);
    setError(null);
    try {
      const parsed = JSON.parse(editor.value) as unknown;
      await mutate(editor.path, editor.method, parsed);
      setEditor(null);
      await finishMutation();
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("配置保存失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const removeResource = async (path: string, label: string) => {
    if (!window.confirm(`确认删除“${label}”？`)) return;
    setSubmitting(true);
    setError(null);
    try {
      await mutate(path, "DELETE");
      await finishMutation();
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("删除失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const runModel = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedModel) return;
    setSubmitting(true);
    setError(null);
    try {
      const parsed = JSON.parse(formValues) as Record<string, number>;
      const response = await requestJSON<RatingEnvelope<Record<string, unknown>>>(
        `/rating/models/${encodeURIComponent(selectedModel)}/run`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": newIdempotencyKey("rating") },
          body: JSON.stringify({ credit_code: creditCode, freport_date: reportDate, form_values: parsed }),
        },
        session,
      );
      setRunResult(response.data || (response as unknown as Record<string, unknown>));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("评级执行失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const exportModel = async () => {
    if (!selected) return;
    try {
      const response = await requestJSON<RatingEnvelope<unknown>>(
        `/rating/models/${encodeURIComponent(selected.id)}/export`,
        { method: "GET" },
        session,
      );
      const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${selected.name}-v${selected.version}.rating.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("模型导出失败"));
    }
  };

  const importModel = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setSubmitting(true);
    try {
      const payload = JSON.parse(await file.text()) as unknown;
      await mutate("/rating/models/import", "POST", payload);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("模型导入失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const openEditor = (title: string, method: "POST" | "PUT", path: string, value: unknown) => {
    setEditor({ title, method, path, value: JSON.stringify(value, null, 2) });
  };

  return (
    <section className="rating-workspace">
      <PageHeader
        eyebrow="风险审批"
        title="规则与信用评级"
        meta="模型治理 · 评分配置 · 执行证据"
        action={
          <button
            className="button secondary compact"
            type="button"
            onClick={() => void refresh()}
            title="刷新评级工作台"
          >
            <RefreshCw size={15} />
            刷新
          </button>
        }
      />

      <div className="rating-tabs" role="tablist" aria-label="评级工作区">
        <button type="button" role="tab" aria-selected={view === "governance"} onClick={() => setView("governance")}>
          <ShieldCheck size={16} />
          模型治理
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "configuration"}
          onClick={() => setView("configuration")}
        >
          <Settings2 size={16} />
          评分配置
        </button>
        <button type="button" role="tab" aria-selected={view === "run"} onClick={() => setView("run")}>
          <Calculator size={16} />
          执行评级
        </button>
        <button type="button" role="tab" aria-selected={view === "executions"} onClick={() => setView("executions")}>
          <FileClock size={16} />
          执行记录
        </button>
      </div>

      {error ? <ErrorState error={error} onRetry={() => void refresh()} /> : null}
      {loading ? <LoadingState rows={6} /> : null}

      {!loading && view === "governance" ? (
        <div className="rating-model-layout">
          <div className="table-frame rating-model-list">
            <div className="table-toolbar">
              <strong>评级模型</strong>
              <span>{models.length} 个版本</span>
              <div className="page-action-group">
                <label className="button secondary compact" title="导入模型包">
                  <Upload size={15} />
                  导入
                  <input
                    hidden
                    type="file"
                    accept="application/json,.json"
                    onChange={(event) => void importModel(event)}
                  />
                </label>
                <button
                  className="button primary compact"
                  type="button"
                  onClick={() =>
                    openEditor("新建评级模型", "POST", "/rating/models", {
                      name: "",
                      category: "评级模型",
                      property: "产业模型",
                      mode: 0,
                      allow_null: 0,
                    })
                  }
                >
                  <Plus size={15} />
                  新建
                </button>
              </div>
            </div>
            {models.length === 0 ? (
              <EmptyState title="暂无评级模型" detail="" />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>模型</th>
                    <th>状态</th>
                    <th>版本</th>
                    <th>更新时间</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((model) => (
                    <tr
                      key={model.id}
                      className={selectedModel === model.id ? "selected-row" : ""}
                      onClick={() => setSelectedModel(model.id)}
                    >
                      <td>
                        <strong>{model.name}</strong>
                        <small>{model.id}</small>
                      </td>
                      <td>
                        <span className={`status-badge ${statusTone[model.lifecycle_status]}`}>
                          {statusLabels[model.lifecycle_status]}
                        </span>
                      </td>
                      <td>v{model.version}</td>
                      <td>{model.update_time || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <aside className="rating-model-inspector" aria-label="模型版本详情">
            {selected ? (
              <>
                <div className="rating-inspector-header">
                  <div>
                    <span className="eyebrow">模型版本</span>
                    <h2>{selected.name}</h2>
                  </div>
                  <span className={`status-badge ${statusTone[selected.lifecycle_status]}`}>
                    {statusLabels[selected.lifecycle_status]}
                  </span>
                </div>
                <dl className="rating-facts">
                  <div>
                    <dt>分类</dt>
                    <dd>{selected.category}</dd>
                  </div>
                  <div>
                    <dt>属性</dt>
                    <dd>{selected.property}</dd>
                  </div>
                  <div>
                    <dt>版本</dt>
                    <dd>v{selected.version}</dd>
                  </div>
                  <div>
                    <dt>前序版本</dt>
                    <dd className="mono-cell">{selected.revision_of || "-"}</dd>
                  </div>
                  <div className="span-2">
                    <dt>制品哈希</dt>
                    <dd className="mono-cell">{selected.artifact_hash || "待生成"}</dd>
                  </div>
                  <div>
                    <dt>提交人</dt>
                    <dd>{selected.submitted_by || "-"}</dd>
                  </div>
                  <div>
                    <dt>复核人</dt>
                    <dd>{selected.reviewed_by || "-"}</dd>
                  </div>
                </dl>
                {selected.review_comment ? (
                  <div className="rating-review-note">
                    <strong>复核意见</strong>
                    <span>{selected.review_comment}</span>
                  </div>
                ) : null}
                <div className="rating-governance-actions">
                  {selected.lifecycle_status === "draft" || selected.lifecycle_status === "rejected" ? (
                    <button
                      className="button primary compact"
                      type="button"
                      disabled={submitting}
                      onClick={() => void transitionModel("submit-review")}
                    >
                      <Send size={15} />
                      提交复核
                    </button>
                  ) : null}
                  {selected.lifecycle_status === "in_review" ? (
                    <>
                      <button
                        className="button primary compact"
                        type="button"
                        onClick={() =>
                          openEditor("复核通过", "POST", `/rating/models/${encodeURIComponent(selected.id)}/review`, {
                            decision: "approve",
                            comment: "",
                          })
                        }
                      >
                        <CheckCircle2 size={15} />
                        通过
                      </button>
                      <button
                        className="button danger compact"
                        type="button"
                        onClick={() =>
                          openEditor("退回修改", "POST", `/rating/models/${encodeURIComponent(selected.id)}/review`, {
                            decision: "reject",
                            comment: "",
                          })
                        }
                      >
                        <XCircle size={15} />
                        退回
                      </button>
                    </>
                  ) : null}
                  {selected.lifecycle_status === "approved" ? (
                    <button
                      className="button primary compact"
                      type="button"
                      disabled={submitting}
                      onClick={() => void transitionModel("publish")}
                    >
                      <ShieldCheck size={15} />
                      发布
                    </button>
                  ) : null}
                  {selected.lifecycle_status === "published" ? (
                    <>
                      <button
                        className="button secondary compact"
                        type="button"
                        disabled={submitting}
                        onClick={() => void transitionModel("revisions")}
                      >
                        <GitBranch size={15} />
                        新修订
                      </button>
                      <button
                        className="button secondary compact"
                        type="button"
                        disabled={submitting}
                        onClick={() => void transitionModel("retire")}
                      >
                        <Archive size={15} />
                        停用
                      </button>
                    </>
                  ) : null}
                  <button
                    className="icon-button"
                    type="button"
                    title="导出模型包"
                    aria-label="导出模型包"
                    onClick={() => void exportModel()}
                  >
                    <Download size={16} />
                  </button>
                  {selected.lifecycle_status === "draft" || selected.lifecycle_status === "rejected" ? (
                    <>
                      <button
                        className="icon-button"
                        type="button"
                        title="编辑模型"
                        aria-label="编辑模型"
                        onClick={() =>
                          openEditor("编辑评级模型", "PUT", `/rating/models/${encodeURIComponent(selected.id)}`, {
                            name: selected.name,
                            category: selected.category,
                            property: selected.property,
                          })
                        }
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        className="icon-button danger"
                        type="button"
                        title="删除模型"
                        aria-label="删除模型"
                        onClick={() =>
                          void removeResource(`/rating/models/${encodeURIComponent(selected.id)}`, selected.name)
                        }
                      >
                        <Trash2 size={16} />
                      </button>
                    </>
                  ) : null}
                </div>
              </>
            ) : (
              <EmptyState title="未选择模型" detail="" />
            )}
          </aside>
        </div>
      ) : null}

      {!loading && view === "configuration" ? (
        <div className="rating-config-workspace">
          <div className="workspace-controls">
            <label className="rating-model-select">
              <span>模型版本</span>
              <select value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} · v{model.version} · {statusLabels[model.lifecycle_status]}
                  </option>
                ))}
              </select>
            </label>
            <span className={`status-badge ${selected ? statusTone[selected.lifecycle_status] : ""}`}>
              {selected ? statusLabels[selected.lifecycle_status] : "未选择"}
            </span>
          </div>
          <div className="rating-config-tabs" role="tablist" aria-label="评分配置类型">
            <button
              type="button"
              aria-selected={configView === "indicators"}
              onClick={() => setConfigView("indicators")}
            >
              <ListTree size={15} />
              指标与区间
            </button>
            <button type="button" aria-selected={configView === "sources"} onClick={() => setConfigView("sources")}>
              <Database size={15} />
              数据映射
            </button>
            <button
              type="button"
              aria-selected={configView === "dictionaries"}
              onClick={() => setConfigView("dictionaries")}
            >
              <FileJson size={15} />
              映射字典
            </button>
            <button type="button" aria-selected={configView === "scales"} onClick={() => setConfigView("scales")}>
              <Scale size={15} />
              评级等级
            </button>
            <button type="button" aria-selected={configView === "format"} onClick={() => setConfigView("format")}>
              <Settings2 size={15} />
              表单与报告
            </button>
          </div>
          {configLoading ? <LoadingState rows={5} /> : null}
          {!configLoading && configView === "indicators" ? (
            <ConfigTable
              title="指标与区间"
              count={indicators.length}
              onCreate={() =>
                openEditor("新建指标", "POST", `/rating/models/${encodeURIComponent(selectedModel)}/indicators`, {
                  icode: "",
                  name: "",
                  formula: 0,
                  function: 0,
                  weight: 1,
                  parent_id: null,
                })
              }
            >
              <thead>
                <tr>
                  <th>层级</th>
                  <th>指标</th>
                  <th>公式</th>
                  <th>权重</th>
                  <th>区间</th>
                  <th>数据绑定</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {indicators
                  .sort((a, b) => a.level - b.level || a.icode.localeCompare(b.icode))
                  .map((indicator) => (
                    <tr key={indicator.id}>
                      <td>L{indicator.level}</td>
                      <td>
                        <strong>{indicator.name}</strong>
                        <small>{indicator.icode}</small>
                      </td>
                      <td>
                        {indicator.formula} / {indicator.function}
                      </td>
                      <td>{indicator.weight ?? "-"}</td>
                      <td>{indicator.ranges?.length || 0}</td>
                      <td>{indicator.sources?.length || 0}</td>
                      <td>
                        <div className="row-actions">
                          <button
                            className="icon-button"
                            type="button"
                            title="编辑指标"
                            aria-label="编辑指标"
                            onClick={() =>
                              openEditor("编辑指标", "PUT", `/rating/indicators/${encodeURIComponent(indicator.id)}`, {
                                icode: indicator.icode,
                                name: indicator.name,
                                formula: indicator.formula,
                                function: indicator.function,
                                weight: indicator.weight,
                                parent_id: indicator.parent_id,
                                description: indicator.description,
                              })
                            }
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            className="icon-button"
                            type="button"
                            title="编辑评分区间"
                            aria-label="编辑评分区间"
                            onClick={() =>
                              openEditor(
                                "编辑评分区间",
                                "PUT",
                                `/rating/indicators/${encodeURIComponent(indicator.id)}/ranges/batch`,
                                indicator.ranges || [],
                              )
                            }
                          >
                            <Settings2 size={15} />
                          </button>
                          <button
                            className="icon-button danger"
                            type="button"
                            title="删除指标"
                            aria-label="删除指标"
                            onClick={() =>
                              void removeResource(
                                `/rating/indicators/${encodeURIComponent(indicator.id)}`,
                                indicator.name,
                              )
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </ConfigTable>
          ) : null}
          {!configLoading && configView === "sources" ? (
            <ConfigTable
              title="数据映射"
              count={sources.length}
              onCreate={() =>
                openEditor("新建数据源", "POST", "/rating/datasources", {
                  src_name: "",
                  src_type: 0,
                  db_link: "default",
                  sql_str: "SELECT 1",
                  args: null,
                })
              }
            >
              <thead>
                <tr>
                  <th>数据源</th>
                  <th>类型</th>
                  <th>连接</th>
                  <th>字段</th>
                  <th>更新时间</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={source.id}>
                    <td>
                      <strong>{source.src_name}</strong>
                      <small>{source.id}</small>
                    </td>
                    <td>{source.src_type === 0 ? "数据库" : "API"}</td>
                    <td className="mono-cell">{source.db_link}</td>
                    <td>{source.fields?.length || 0}</td>
                    <td>{source.update_time || "-"}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="button secondary compact"
                          type="button"
                          onClick={() =>
                            void mutate(`/rating/models/${encodeURIComponent(selectedModel)}/source`, "PUT", {
                              source_id: source.id,
                            })
                              .then(finishMutation)
                              .catch((reason) => setError(reason instanceof Error ? reason : new Error("关联失败")))
                          }
                        >
                          关联
                        </button>
                        <button
                          className="icon-button"
                          type="button"
                          title="编辑字段映射"
                          aria-label="编辑字段映射"
                          onClick={() =>
                            openEditor(
                              "编辑字段映射",
                              "PUT",
                              `/rating/datasources/${encodeURIComponent(source.id)}/fields/batch`,
                              source.fields || [],
                            )
                          }
                        >
                          <ListTree size={15} />
                        </button>
                        <button
                          className="icon-button"
                          type="button"
                          title="编辑数据源"
                          aria-label="编辑数据源"
                          onClick={() =>
                            openEditor("编辑数据源", "PUT", `/rating/datasources/${encodeURIComponent(source.id)}`, {
                              src_name: source.src_name,
                              src_type: source.src_type,
                              db_link: source.db_link,
                              sql_str: source.sql_str,
                            })
                          }
                        >
                          <Pencil size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </ConfigTable>
          ) : null}
          {!configLoading && configView === "dictionaries" ? (
            <ConfigTable
              title="映射字典"
              count={dictionaries.length}
              onCreate={() =>
                openEditor("新建映射字典", "POST", "/rating/dicts", { name: "", mainaccount: 0, dict_function: null })
              }
            >
              <thead>
                <tr>
                  <th>字典</th>
                  <th>主账号</th>
                  <th>函数</th>
                  <th>条目</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {dictionaries.map((dictionary) => (
                  <tr key={dictionary.id}>
                    <td>
                      <strong>{dictionary.name}</strong>
                      <small>{dictionary.id}</small>
                    </td>
                    <td>{dictionary.mainaccount ?? "-"}</td>
                    <td className="mono-cell">{dictionary.dict_function || "-"}</td>
                    <td>{dictionary.items?.length || 0}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="icon-button"
                          type="button"
                          title="编辑字典条目"
                          aria-label="编辑字典条目"
                          onClick={() =>
                            openEditor(
                              "编辑字典条目",
                              "PUT",
                              `/rating/dicts/${encodeURIComponent(dictionary.id)}/items/batch`,
                              { items: dictionary.items || [] },
                            )
                          }
                        >
                          <ListTree size={15} />
                        </button>
                        <button
                          className="icon-button"
                          type="button"
                          title="编辑字典"
                          aria-label="编辑字典"
                          onClick={() =>
                            openEditor("编辑字典", "PUT", `/rating/dicts/${encodeURIComponent(dictionary.id)}`, {
                              name: dictionary.name,
                              mainaccount: dictionary.mainaccount,
                              dict_function: dictionary.dict_function,
                            })
                          }
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="icon-button danger"
                          type="button"
                          title="删除字典"
                          aria-label="删除字典"
                          onClick={() =>
                            void removeResource(`/rating/dicts/${encodeURIComponent(dictionary.id)}`, dictionary.name)
                          }
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </ConfigTable>
          ) : null}
          {!configLoading && configView === "scales" ? (
            <ConfigTable
              title="评级等级"
              count={scales.length}
              onCreate={() => openEditor("新建评级等级", "POST", "/rating/scales", { name: "", description: "" })}
            >
              <thead>
                <tr>
                  <th>等级方案</th>
                  <th>说明</th>
                  <th>等级数</th>
                  <th>更新时间</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {scales.map((scale) => (
                  <tr key={scale.id}>
                    <td>
                      <strong>{scale.name}</strong>
                      <small>{scale.id}</small>
                    </td>
                    <td>{scale.description || "-"}</td>
                    <td>{scale.items?.length || 0}</td>
                    <td>{scale.update_time || "-"}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="button secondary compact"
                          type="button"
                          onClick={() =>
                            void mutate(`/rating/models/${encodeURIComponent(selectedModel)}/scale`, "PUT", {
                              scale_id: scale.id,
                            })
                              .then(finishMutation)
                              .catch((reason) => setError(reason instanceof Error ? reason : new Error("关联失败")))
                          }
                        >
                          关联
                        </button>
                        <button
                          className="icon-button"
                          type="button"
                          title="编辑等级区间"
                          aria-label="编辑等级区间"
                          onClick={() =>
                            openEditor(
                              "编辑等级区间",
                              "PUT",
                              `/rating/scales/${encodeURIComponent(scale.id)}/items`,
                              scale.items || [],
                            )
                          }
                        >
                          <Scale size={15} />
                        </button>
                        <button
                          className="icon-button"
                          type="button"
                          title="编辑等级方案"
                          aria-label="编辑等级方案"
                          onClick={() =>
                            openEditor("编辑等级方案", "PUT", `/rating/scales/${encodeURIComponent(scale.id)}`, {
                              name: scale.name,
                              description: scale.description,
                            })
                          }
                        >
                          <Pencil size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </ConfigTable>
          ) : null}
          {!configLoading && configView === "format" ? (
            <div className="rating-format-editor">
              <div className="table-toolbar">
                <strong>表单与报告格式</strong>
                <button
                  className="button primary compact"
                  type="button"
                  onClick={() =>
                    openEditor(
                      "编辑表单与报告格式",
                      "PUT",
                      `/rating/models/${encodeURIComponent(selectedModel)}/format-meta`,
                      formatMeta,
                    )
                  }
                >
                  <Pencil size={15} />
                  编辑
                </button>
              </div>
              <pre>{JSON.stringify(formatMeta, null, 2)}</pre>
            </div>
          ) : null}
        </div>
      ) : null}

      {!loading && view === "run" ? (
        <div className="rating-run-grid">
          <form className="rating-run-form" onSubmit={runModel}>
            <label>
              <span>已发布模型</span>
              <select required value={selectedModel} onChange={(event) => setSelectedModel(event.target.value)}>
                <option value="">选择模型</option>
                {models
                  .filter((model) => model.lifecycle_status === "published")
                  .map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name} · v{model.version}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              <span>客户统一标识</span>
              <input required value={creditCode} onChange={(event) => setCreditCode(event.target.value)} />
            </label>
            <label>
              <span>报表日期</span>
              <input required type="date" value={reportDate} onChange={(event) => setReportDate(event.target.value)} />
            </label>
            <label>
              <span>指标输入（JSON）</span>
              <textarea
                rows={10}
                spellCheck={false}
                value={formValues}
                onChange={(event) => setFormValues(event.target.value)}
              />
            </label>
            <button
              className="button primary"
              type="submit"
              disabled={submitting || selected?.lifecycle_status !== "published"}
            >
              {submitting ? "执行中" : "执行确定性评级"}
            </button>
          </form>
          <div className="rating-result">
            <div className="eyebrow">执行结果</div>
            {runResult ? (
              <pre>{JSON.stringify(runResult, null, 2)}</pre>
            ) : (
              <EmptyState title="暂无执行结果" detail="" />
            )}
          </div>
        </div>
      ) : null}

      {!loading && view === "executions" ? (
        <div className="table-frame">
          {batches.length === 0 ? (
            <EmptyState title="暂无评级执行" detail="" />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>执行编号</th>
                  <th>业务对象</th>
                  <th>模型</th>
                  <th>版本</th>
                  <th>分数</th>
                  <th>等级</th>
                  <th>执行时间</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id}>
                    <td className="mono-cell">{batch.id}</td>
                    <td>{batch.unit_id}</td>
                    <td className="mono-cell">{batch.model_id}</td>
                    <td>v{batch.model_version}</td>
                    <td>{batch.score ?? "-"}</td>
                    <td>{batch.level || "-"}</td>
                    <td>{batch.create_time}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      {editor ? (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setEditor(null);
          }}
        >
          <form
            className="dialog-panel rating-json-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rating-editor-title"
            onSubmit={saveEditor}
          >
            <div className="dialog-header">
              <div>
                <span className="eyebrow">评级配置</span>
                <h2 id="rating-editor-title">{editor.title}</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                title="关闭"
                aria-label="关闭"
                onClick={() => setEditor(null)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="dialog-body">
              <label className="rating-json-field">
                <span>JSON 配置</span>
                <textarea
                  autoFocus
                  spellCheck={false}
                  rows={18}
                  value={editor.value}
                  onChange={(event) => setEditor({ ...editor, value: event.target.value })}
                />
              </label>
            </div>
            <div className="dialog-footer">
              <button className="button secondary" type="button" onClick={() => setEditor(null)}>
                取消
              </button>
              <button className="button primary" type="submit" disabled={submitting}>
                <Save size={15} />
                {submitting ? "保存中" : "保存"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}

function ConfigTable({
  title,
  count,
  onCreate,
  children,
}: {
  title: string;
  count: number;
  onCreate: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="table-frame rating-config-table">
      <div className="table-toolbar">
        <strong>{title}</strong>
        <span>{count} 项</span>
        <button className="button primary compact" type="button" onClick={onCreate}>
          <Plus size={15} />
          新建
        </button>
      </div>
      {count === 0 ? <EmptyState title={`暂无${title}`} detail="" /> : <table>{children}</table>}
    </div>
  );
}
