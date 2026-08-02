import { useCallback, useMemo, useState, type FormEvent } from "react";
import { BriefcaseBusiness, Plus, Search } from "lucide-react";
import {
  createProject,
  fetchCommissionAgreements,
  fetchCustomers,
  fetchPartners,
  fetchProjects,
  newIdempotencyKey,
} from "../api";
import {
  CommandNotice,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  PageHeader,
  StatusBadge,
} from "../components/Workspace";
import { useRemoteData } from "../hooks/useRemoteData";
import type { CommandReceipt, ProjectCreateInput, Session } from "../types";
import { formatDateTime, formatMoney, leaseTypeLabel, statusLabel, statusTone } from "../utils";

const EMPTY_FORM: ProjectCreateInput = {
  customerId: "",
  name: "",
  leaseType: "direct",
  requestedAmount: "",
  termMonths: 36,
  annualRateBps: 500,
  assetDescription: "",
  vendorIds: [],
  channelId: "",
  commissionMode: "none",
  commissionAgreementId: "",
  noCommissionReason: "",
  businessRegion: "",
  industry: "",
};

export default function ProjectsPage({ session }: { session: Session }) {
  const loader = useCallback(
    async (signal: AbortSignal) => {
      const [projects, customers, partners, agreements] = await Promise.all([
        fetchProjects(session, signal),
        fetchCustomers(session, signal),
        fetchPartners(session, signal),
        fetchCommissionAgreements(session, signal),
      ]);
      return { projects, customers, partners, agreements };
    },
    [session],
  );
  const { data, error, loading, reload } = useRemoteData(loader);
  const [query, setQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<CommandReceipt | null>(null);
  const customerMap = useMemo(() => new Map((data?.customers.items || []).map((item) => [item.id, item.name])), [data]);
  const vendors = useMemo(
    () => (data?.partners.items || []).filter((item) => item.status === "active" && item.roles.includes("vendor")),
    [data],
  );
  const channels = useMemo(
    () => (data?.partners.items || []).filter((item) => item.status === "active" && item.roles.includes("channel")),
    [data],
  );
  const agreements = useMemo(
    () =>
      (data?.agreements.items || []).filter(
        (item) => item.status === "active" && item.channelPartnerId === form.channelId,
      ),
    [data, form.channelId],
  );
  const projects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const items = data?.projects.items || [];
    if (!normalized) return items;
    return items.filter((item) =>
      [item.name, item.assetDescription, customerMap.get(item.customerId) || item.customerName || ""].some((value) =>
        value.toLocaleLowerCase().includes(normalized),
      ),
    );
  }, [customerMap, data, query]);

  const openDialog = () => {
    setForm({ ...EMPTY_FORM, vendorIds: [], customerId: data?.customers.items[0]?.id || "" });
    setErrors({});
    setSubmitError(null);
    setDialogOpen(true);
  };
  const closeDialog = useCallback(() => {
    if (!submitting) setDialogOpen(false);
  }, [submitting]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validateProject(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const nextReceipt = await createProject(session, normalizeProject(form), newIdempotencyKey("project"));
      setReceipt(nextReceipt);
      setDialogOpen(false);
      reload();
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason : new Error("项目创建失败"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="workspace">
      <PageHeader
        eyebrow="业务受理"
        title="租赁项目"
        meta={data ? `${data.projects.total} 个项目` : undefined}
        action={
          <button
            className="button primary"
            type="button"
            onClick={openDialog}
            disabled={!data?.customers.items.length}
          >
            <Plus size={17} />
            新建项目
          </button>
        }
      />
      {receipt ? <CommandNotice receipt={receipt} onClose={() => setReceipt(null)} /> : null}
      <div className="table-toolbar">
        <label className="search-box">
          <Search size={16} />
          <span className="sr-only">搜索项目</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="项目、客户或租赁物" />
        </label>
        <span>{projects.length} 条结果</span>
      </div>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {!loading && !error && projects.length === 0 ? (
        <EmptyState
          title={query ? "未找到匹配项目" : "暂无租赁项目"}
          detail={data?.customers.items.length ? "创建项目并进入授信流程" : "请先建立客户主档"}
        />
      ) : null}
      {!loading && !error && projects.length > 0 ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">融资租赁项目列表</caption>
            <thead>
              <tr>
                <th>项目名称</th>
                <th>客户</th>
                <th>模式</th>
                <th className="numeric">申请金额</th>
                <th>期限 / 利率</th>
                <th>状态</th>
                <th>更新时间</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => (
                <tr key={project.id}>
                  <td>
                    <span className="primary-cell">
                      <BriefcaseBusiness size={16} />
                      {project.name}
                    </span>
                    <small>{project.assetDescription || project.id}</small>
                  </td>
                  <td>{customerMap.get(project.customerId) || project.customerName || project.customerId}</td>
                  <td>{leaseTypeLabel(project.leaseType)}</td>
                  <td className="numeric strong">{formatMoney(project.requestedAmount)}</td>
                  <td>
                    {project.termMonths} 个月<small>{(project.annualRateBps / 100).toFixed(2)}%</small>
                  </td>
                  <td>
                    <StatusBadge label={statusLabel(project.status)} tone={statusTone(project.status)} />
                  </td>
                  <td>{formatDateTime(project.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Dialog
        open={dialogOpen}
        title="新建租赁项目"
        subtitle="项目创建后进入授信申请阶段"
        submitting={submitting}
        submitLabel="提交创建"
        error={submitError}
        onClose={closeDialog}
        onSubmit={submit}
      >
        <div className="form-grid">
          <Field label="客户" required span={2} error={errors.customerId}>
            <select value={form.customerId} onChange={(event) => setForm({ ...form, customerId: event.target.value })}>
              <option value="">请选择客户</option>
              {data?.customers.items.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="项目名称" required span={2} error={errors.name}>
            <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </Field>
          <Field label="租赁模式" required>
            <select
              value={form.leaseType}
              onChange={(event) =>
                setForm({ ...form, leaseType: event.target.value as ProjectCreateInput["leaseType"] })
              }
            >
              <option value="direct">直接租赁</option>
              <option value="sale_and_leaseback">售后回租</option>
            </select>
          </Field>
          <Field label="申请金额（元）" required error={errors.requestedAmount}>
            <input
              inputMode="decimal"
              value={form.requestedAmount}
              onChange={(event) => setForm({ ...form, requestedAmount: event.target.value })}
            />
          </Field>
          <Field label="租赁期限（月）" required error={errors.termMonths}>
            <input
              type="number"
              min={1}
              max={360}
              value={form.termMonths}
              onChange={(event) => setForm({ ...form, termMonths: Number(event.target.value) })}
            />
          </Field>
          <Field label="年利率（基点）" required error={errors.annualRateBps}>
            <input
              type="number"
              min={0}
              max={10000}
              value={form.annualRateBps}
              onChange={(event) => setForm({ ...form, annualRateBps: Number(event.target.value) })}
            />
          </Field>
          <Field label="租赁物说明" required span={2} error={errors.assetDescription}>
            <textarea
              rows={3}
              value={form.assetDescription}
              onChange={(event) => setForm({ ...form, assetDescription: event.target.value })}
            />
          </Field>
          <div className="field span-2">
            <label>厂商{form.leaseType === "direct" ? <b aria-hidden="true">*</b> : null}</label>
            <div className="checkbox-row wrap project-partner-options">
              {vendors.length ? (
                vendors.map((vendor) => (
                  <label key={vendor.id}>
                    <input
                      type="checkbox"
                      checked={form.vendorIds?.includes(vendor.id)}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          vendorIds: event.target.checked
                            ? [...(form.vendorIds || []), vendor.id]
                            : (form.vendorIds || []).filter((id) => id !== vendor.id),
                        })
                      }
                    />
                    {vendor.name}
                  </label>
                ))
              ) : (
                <span>暂无可选厂商</span>
              )}
            </div>
            {errors.vendorIds ? <small className="field-error">{errors.vendorIds}</small> : null}
          </div>
          <Field label="渠道">
            <select
              value={form.channelId}
              onChange={(event) =>
                setForm({
                  ...form,
                  channelId: event.target.value,
                  commissionMode: "none",
                  commissionAgreementId: "",
                  noCommissionReason: "",
                })
              }
            >
              <option value="">不关联渠道</option>
              {channels.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  {channel.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="业务区域">
            <input
              value={form.businessRegion}
              onChange={(event) => setForm({ ...form, businessRegion: event.target.value })}
              placeholder="用于条件准入校验"
            />
          </Field>
          <Field label="项目行业">
            <input
              value={form.industry}
              onChange={(event) => setForm({ ...form, industry: event.target.value })}
              placeholder="留空时沿用客户行业"
            />
          </Field>
          {form.channelId ? (
            <div className="field">
              <label>佣金方式</label>
              <div className="segmented compact-segmented" role="group" aria-label="佣金方式">
                <button
                  type="button"
                  aria-pressed={form.commissionMode === "none"}
                  onClick={() => setForm({ ...form, commissionMode: "none", commissionAgreementId: "" })}
                >
                  无佣金
                </button>
                <button
                  type="button"
                  aria-pressed={form.commissionMode === "agreement"}
                  onClick={() => setForm({ ...form, commissionMode: "agreement", noCommissionReason: "" })}
                >
                  按协议
                </button>
              </div>
            </div>
          ) : null}
          {form.channelId && form.commissionMode === "none" ? (
            <Field label="无佣金原因" required span={2} error={errors.noCommissionReason}>
              <textarea
                rows={2}
                value={form.noCommissionReason}
                onChange={(event) => setForm({ ...form, noCommissionReason: event.target.value })}
              />
            </Field>
          ) : null}
          {form.channelId && form.commissionMode === "agreement" ? (
            <Field label="佣金协议" required span={2} error={errors.commissionAgreementId}>
              <select
                value={form.commissionAgreementId}
                onChange={(event) => setForm({ ...form, commissionAgreementId: event.target.value })}
              >
                <option value="">请选择当前有效协议</option>
                {agreements.map((agreement) => (
                  <option key={agreement.id} value={agreement.id}>
                    {agreement.agreementNumber} ·{" "}
                    {agreement.calculationType === "fixed"
                      ? `固定 ${agreement.fixedAmount}`
                      : `${Number(agreement.rateBps || 0) / 100}%`}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}

function validateProject(form: ProjectCreateInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.customerId) errors.customerId = "请选择客户";
  if (!form.name.trim()) errors.name = "请输入项目名称";
  if (!/^\d+(\.\d{1,2})?$/.test(form.requestedAmount) || Number(form.requestedAmount) <= 0)
    errors.requestedAmount = "请输入大于0且最多两位小数的金额";
  if (!Number.isInteger(form.termMonths) || form.termMonths < 1 || form.termMonths > 360)
    errors.termMonths = "期限须为1至360个月";
  if (!Number.isInteger(form.annualRateBps) || form.annualRateBps < 0 || form.annualRateBps > 10000)
    errors.annualRateBps = "利率须为0至10000基点";
  if (!form.assetDescription.trim()) errors.assetDescription = "请输入租赁物说明";
  if (form.leaseType === "direct" && !form.vendorIds?.length) errors.vendorIds = "直接租赁须至少选择一个厂商";
  if (form.channelId && form.commissionMode === "none" && !form.noCommissionReason?.trim())
    errors.noCommissionReason = "选择渠道但无佣金时须填写原因";
  if (form.channelId && form.commissionMode === "agreement" && !form.commissionAgreementId)
    errors.commissionAgreementId = "请选择佣金协议";
  return errors;
}

function normalizeProject(form: ProjectCreateInput): ProjectCreateInput {
  return {
    ...form,
    name: form.name.trim(),
    requestedAmount: Number(form.requestedAmount).toFixed(2),
    assetDescription: form.assetDescription.trim(),
    businessRegion: form.businessRegion?.trim() || undefined,
    industry: form.industry?.trim() || undefined,
    channelId: form.channelId || undefined,
    commissionMode: form.channelId ? form.commissionMode : "none",
    commissionAgreementId: form.commissionMode === "agreement" ? form.commissionAgreementId : undefined,
    noCommissionReason: form.channelId && form.commissionMode === "none" ? form.noCommissionReason?.trim() : undefined,
  };
}
