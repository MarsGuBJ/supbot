import { useCallback, useMemo, useState, type FormEvent } from "react";
import { ClipboardCheck, Plus, Search } from "lucide-react";
import {
  fetchCreditApplications,
  fetchCreditFacilities,
  fetchDiligenceExceptions,
  fetchDueDiligenceSnapshots,
  fetchProjects,
  fetchRatingSnapshots,
  newIdempotencyKey,
  submitCredit,
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
import type {
  CommandReceipt,
  CreditFacility,
  CreditSubmitInput,
  DueDiligenceException,
  DueDiligenceSnapshot,
  RatingSnapshot,
  Session,
} from "../types";
import { formatDateTime, formatMoney, statusLabel, statusTone } from "../utils";

const EMPTY_FORM: CreditSubmitInput = { projectId: "", requestedLimit: "", riskNotes: "" };

export default function CreditApplicationsPage({ session }: { session: Session }) {
  const loader = useCallback(
    async (signal: AbortSignal) => {
      const [applications, projects, facilities] = await Promise.all([
        fetchCreditApplications(session, signal),
        fetchProjects(session, signal),
        fetchCreditFacilities(session, signal),
      ]);
      return { applications, projects, facilities };
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
  const [ratingOptions, setRatingOptions] = useState<RatingSnapshot[]>([]);
  const [diligenceOptions, setDiligenceOptions] = useState<DueDiligenceSnapshot[]>([]);
  const [exceptionOptions, setExceptionOptions] = useState<DueDiligenceException[]>([]);
  const projectMap = useMemo(() => new Map((data?.projects.items || []).map((item) => [item.id, item])), [data]);
  const applications = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const items = data?.applications.items || [];
    if (!normalized) return items;
    return items.filter((item) =>
      [item.projectName || projectMap.get(item.projectId)?.name || "", item.customerName || "", item.riskNotes].some(
        (value) => value.toLocaleLowerCase().includes(normalized),
      ),
    );
  }, [data, projectMap, query]);

  const loadRiskOptions = async (projectId: string, nextForm: CreditSubmitInput) => {
    const customerId = projectMap.get(projectId)?.customerId;
    if (!customerId) {
      setRatingOptions([]);
      setDiligenceOptions([]);
      setExceptionOptions([]);
      setForm(nextForm);
      return;
    }
    try {
      const [ratings, diligence, exceptions] = await Promise.all([
        fetchRatingSnapshots(session, customerId),
        fetchDueDiligenceSnapshots(session, customerId),
        fetchDiligenceExceptions(session, customerId),
      ]);
      const activeRatings = ratings.items.filter(
        (item) => item.status === "active" && item.validUntil >= new Date().toISOString().slice(0, 10),
      );
      const activeDiligence = diligence.items.filter((item) => item.status === "active");
      const selectedRating = activeRatings[0];
      const selectedDiligence =
        activeDiligence.find((item) => item.ratingSnapshotId === selectedRating?.id) || activeDiligence[0];
      setRatingOptions(activeRatings);
      setDiligenceOptions(activeDiligence);
      setExceptionOptions(
        exceptions.items.filter(
          (item) => item.status === "approved" && item.validUntil >= new Date().toISOString().slice(0, 10),
        ),
      );
      setForm({
        ...nextForm,
        ratingSnapshotId: selectedRating?.id || "",
        dueDiligenceSnapshotId: selectedDiligence?.id || "",
        exceptionApprovalId: "",
      });
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason : new Error("评级与尽调数据读取失败"));
      setRatingOptions([]);
      setDiligenceOptions([]);
      setExceptionOptions([]);
      setForm(nextForm);
    }
  };
  const customerFacilityOptions = (projectId: string): CreditFacility[] => {
    const customerId = projectMap.get(projectId)?.customerId;
    return (data?.facilities.items || []).filter(
      (item) => item.subjectType === "customer" && item.subjectId === customerId && item.status === "active",
    );
  };
  const applyFacility = (nextForm: CreditSubmitInput, selectedId: string): CreditSubmitInput => {
    const selected = data?.facilities.items.find((item) => item.id === selectedId);
    return {
      ...nextForm,
      facilityId: selected?.parentFacilityId || selected?.id || "",
      memberSublimitId: selected?.parentFacilityId ? selected.id : "",
    };
  };
  const openDialog = () => {
    const first = data?.projects.items[0];
    const firstFacility = customerFacilityOptions(first?.id || "")[0];
    const nextForm = applyFacility(
      { ...EMPTY_FORM, projectId: first?.id || "", requestedLimit: first?.requestedAmount || "" },
      firstFacility?.id || "",
    );
    void loadRiskOptions(first?.id || "", nextForm);
    setErrors({});
    setSubmitError(null);
    setDialogOpen(true);
  };
  const closeDialog = useCallback(() => {
    if (!submitting) setDialogOpen(false);
  }, [submitting]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validateCredit(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const expectedProjectVersion = projectMap.get(form.projectId)?.version;
      if (!expectedProjectVersion) {
        throw new Error("项目版本缺失，请刷新后重试");
      }
      const nextReceipt = await submitCredit(
        session,
        { ...form, requestedLimit: Number(form.requestedLimit).toFixed(2), riskNotes: form.riskNotes.trim() },
        newIdempotencyKey("credit"),
        expectedProjectVersion,
      );
      setReceipt(nextReceipt);
      setDialogOpen(false);
      reload();
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason : new Error("授信提交失败"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="workspace">
      <PageHeader
        eyebrow="风险审批"
        title="授信申请"
        meta={data ? `${data.applications.total} 笔申请` : undefined}
        action={
          <button className="button primary" type="button" onClick={openDialog} disabled={!data?.projects.items.length}>
            <Plus size={17} />
            提交授信
          </button>
        }
      />
      {receipt ? <CommandNotice receipt={receipt} onClose={() => setReceipt(null)} /> : null}
      <div className="table-toolbar">
        <label className="search-box">
          <Search size={16} />
          <span className="sr-only">搜索授信申请</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="项目、客户或风险说明" />
        </label>
        <span>{applications.length} 条结果</span>
      </div>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {!loading && !error && applications.length === 0 ? (
        <EmptyState
          title={query ? "未找到匹配申请" : "暂无授信申请"}
          detail={data?.projects.items.length ? "选择租赁项目并提交授信申请" : "请先建立租赁项目"}
        />
      ) : null}
      {!loading && !error && applications.length > 0 ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">授信申请列表</caption>
            <thead>
              <tr>
                <th>申请编号 / 项目</th>
                <th className="numeric">申请额度</th>
                <th>风险说明</th>
                <th>状态</th>
                <th>流程</th>
                <th>提交时间</th>
              </tr>
            </thead>
            <tbody>
              {applications.map((application) => {
                const project = projectMap.get(application.projectId);
                return (
                  <tr key={application.id}>
                    <td>
                      <span className="primary-cell">
                        <ClipboardCheck size={16} />
                        {application.projectName || project?.name || application.projectId}
                      </span>
                      <small>{application.id}</small>
                    </td>
                    <td className="numeric strong">{formatMoney(application.requestedLimit)}</td>
                    <td className="truncate-cell" title={application.riskNotes}>
                      {application.riskNotes || "--"}
                    </td>
                    <td>
                      <StatusBadge label={statusLabel(application.status)} tone={statusTone(application.status)} />
                    </td>
                    <td>{application.status === "submitted" ? "审批中" : "--"}</td>
                    <td>{formatDateTime(application.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <Dialog
        open={dialogOpen}
        title="提交授信申请"
        subtitle="提交后进入授信审批流程"
        submitting={submitting}
        submitLabel="确认提交"
        error={submitError}
        onClose={closeDialog}
        onSubmit={submit}
      >
        <div className="form-grid">
          <Field label="租赁项目" required span={2} error={errors.projectId}>
            <select
              value={form.projectId}
              onChange={(event) => {
                const project = projectMap.get(event.target.value);
                const next = applyFacility(
                  {
                    ...form,
                    projectId: event.target.value,
                    requestedLimit: project?.requestedAmount || form.requestedLimit,
                    ratingSnapshotId: "",
                    dueDiligenceSnapshotId: "",
                  },
                  customerFacilityOptions(event.target.value)[0]?.id || "",
                );
                void loadRiskOptions(event.target.value, next);
              }}
            >
              <option value="">请选择项目</option>
              {data?.projects.items.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="客户额度池" required span={2} error={errors.facilityId}>
            <select
              value={form.memberSublimitId || form.facilityId || ""}
              onChange={(event) => setForm(applyFacility(form, event.target.value))}
            >
              <option value="">请选择有效额度</option>
              {customerFacilityOptions(form.projectId).map((facility) => (
                <option key={facility.id} value={facility.id}>
                  {facility.parentFacilityId ? "集团成员子限额" : "独立客户额度"} ·{" "}
                  {formatMoney(facility.approvedLimit)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="有效评级" required={!form.exceptionApprovalId} error={errors.ratingSnapshotId}>
            <select
              disabled={Boolean(form.exceptionApprovalId)}
              value={form.ratingSnapshotId || ""}
              onChange={(event) => {
                const ratingSnapshotId = event.target.value;
                setForm({
                  ...form,
                  ratingSnapshotId,
                  dueDiligenceSnapshotId:
                    diligenceOptions.find((item) => item.ratingSnapshotId === ratingSnapshotId)?.id || "",
                });
              }}
            >
              <option value="">请选择评级</option>
              {ratingOptions.map((rating) => (
                <option key={rating.id} value={rating.id}>
                  {rating.grade} · {rating.score} · 至{rating.validUntil}
                </option>
              ))}
            </select>
          </Field>
          <Field label="尽调快照" required={!form.exceptionApprovalId} error={errors.dueDiligenceSnapshotId}>
            <select
              disabled={Boolean(form.exceptionApprovalId)}
              value={form.dueDiligenceSnapshotId || ""}
              onChange={(event) => setForm({ ...form, dueDiligenceSnapshotId: event.target.value })}
            >
              <option value="">请选择尽调快照</option>
              {diligenceOptions
                .filter((item) => !form.ratingSnapshotId || item.ratingSnapshotId === form.ratingSnapshotId)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id} · 至{item.validUntil}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="例外审批" span={2}>
            <select
              value={form.exceptionApprovalId || ""}
              onChange={(event) =>
                setForm({
                  ...form,
                  exceptionApprovalId: event.target.value,
                  ratingSnapshotId: event.target.value ? "" : form.ratingSnapshotId,
                  dueDiligenceSnapshotId: event.target.value ? "" : form.dueDiligenceSnapshotId,
                })
              }
            >
              <option value="">不使用例外</option>
              {exceptionOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.reason} · 至{item.validUntil}
                </option>
              ))}
            </select>
          </Field>
          <Field label="申请额度（元）" required span={2} error={errors.requestedLimit}>
            <input
              inputMode="decimal"
              value={form.requestedLimit}
              onChange={(event) => setForm({ ...form, requestedLimit: event.target.value })}
            />
          </Field>
          <Field label="风险说明" required span={2} error={errors.riskNotes}>
            <textarea
              rows={5}
              value={form.riskNotes}
              onChange={(event) => setForm({ ...form, riskNotes: event.target.value })}
            />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

function validateCredit(form: CreditSubmitInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.projectId) errors.projectId = "请选择租赁项目";
  if (!/^\d+(\.\d{1,2})?$/.test(form.requestedLimit) || Number(form.requestedLimit) <= 0)
    errors.requestedLimit = "请输入大于0且最多两位小数的额度";
  if (form.riskNotes.trim().length < 10) errors.riskNotes = "风险说明至少10个字符";
  if (!form.facilityId) errors.facilityId = "请选择有效客户额度池";
  if (!form.exceptionApprovalId && !form.ratingSnapshotId) errors.ratingSnapshotId = "请选择有效评级";
  if (!form.exceptionApprovalId && !form.dueDiligenceSnapshotId) errors.dueDiligenceSnapshotId = "请选择尽调快照";
  return errors;
}
