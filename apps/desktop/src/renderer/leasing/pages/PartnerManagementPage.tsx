import { useCallback, useMemo, useState, type FormEvent } from "react";
import {
  BadgeDollarSign,
  Ban,
  Building2,
  CreditCard,
  FileUp,
  Handshake,
  PlayCircle,
  Plus,
  ReceiptText,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
} from "lucide-react";
import {
  createCommissionAdjustment,
  createCommissionAgreement,
  createPartner,
  attachPartnerEvidence,
  createPartnerAdmission,
  evaluatePartnerAdmission,
  fetchCommissionAccruals,
  fetchCommissionAgreements,
  fetchCommissionSettlements,
  fetchPartnerAdmissions,
  fetchPartners,
  newIdempotencyKey,
  prepareCommissionSettlement,
  recordCommissionPayment,
  submitCommissionAgreement,
  submitCommissionSettlement,
  submitPartnerAdmission,
  suspendPartnerAdmission,
  uploadPartnerEvidence,
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
  CommissionAccrual,
  CommissionAgreement,
  CommissionSettlement,
  Partner,
  PartnerAdmission,
  PartnerCreateInput,
  PartnerRole,
  Session,
} from "../types";
import { formatDateTime, formatMoney, statusLabel, statusTone } from "../utils";

type Tab = "partners" | "admissions" | "agreements" | "settlements";
type DialogMode =
  | "partner"
  | "evidence"
  | "admission"
  | "evaluation"
  | "suspension"
  | "agreement"
  | "settlement"
  | "payment"
  | "adjustment"
  | null;

interface WorkspaceData {
  partners: Partner[];
  total: number;
  admissions?: PartnerAdmission[];
  agreements?: CommissionAgreement[];
  accruals?: CommissionAccrual[];
  settlements?: CommissionSettlement[];
}

const EMPTY_PARTNER: PartnerCreateInput = {
  name: "",
  unifiedSocialCreditCode: "",
  legalRepresentative: "",
  registeredAddress: "",
  contactName: "",
  contactPhone: "",
  bankName: "",
  bankAccount: "",
  roles: ["vendor"],
  ownerUserId: "",
};

const TABS: Array<{ key: Tab; label: string; icon: typeof Handshake }> = [
  { key: "partners", label: "合作机构", icon: Handshake },
  { key: "admissions", label: "准入评价", icon: ShieldCheck },
  { key: "agreements", label: "佣金协议", icon: ReceiptText },
  { key: "settlements", label: "结算支付", icon: BadgeDollarSign },
];

export default function PartnerManagementPage({ session }: { session: Session }) {
  const [tab, setTab] = useState<Tab>("partners");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [selected, setSelected] = useState<PartnerAdmission | CommissionSettlement | CommissionAccrual | null>(null);
  const [partnerForm, setPartnerForm] = useState<PartnerCreateInput>({ ...EMPTY_PARTNER });
  const [evidencePartner, setEvidencePartner] = useState<Partner | null>(null);
  const [evidenceForm, setEvidenceForm] = useState({
    evidenceType: "business_license",
    documentNumber: "",
    validUntil: "",
    file: null as File | null,
  });
  const [admissionForm, setAdmissionForm] = useState({ partnerId: "", role: "vendor" as PartnerRole, reason: "" });
  const [evaluationForm, setEvaluationForm] = useState(defaultEvaluation("vendor"));
  const [suspensionReason, setSuspensionReason] = useState("");
  const [agreementForm, setAgreementForm] = useState(defaultAgreement());
  const [settlementForm, setSettlementForm] = useState({ channelPartnerId: "", accountingPeriod: currentPeriod() });
  const [paymentForm, setPaymentForm] = useState({ paymentDate: currentDate(), amount: "", externalReference: "" });
  const [adjustmentForm, setAdjustmentForm] = useState({ amount: "", reason: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<CommandReceipt | null>(null);

  const loader = useCallback(
    async (signal: AbortSignal): Promise<WorkspaceData> => {
      const partners = await fetchPartners(session, signal);
      if (tab === "admissions") {
        const admissions = await fetchPartnerAdmissions(session, signal);
        return { partners: partners.items, total: admissions.total, admissions: admissions.items };
      }
      if (tab === "agreements") {
        const agreements = await fetchCommissionAgreements(session, signal);
        return { partners: partners.items, total: agreements.total, agreements: agreements.items };
      }
      if (tab === "settlements") {
        const [accruals, settlements] = await Promise.all([
          fetchCommissionAccruals(session, signal),
          fetchCommissionSettlements(session, signal),
        ]);
        return {
          partners: partners.items,
          total: settlements.total,
          accruals: accruals.items,
          settlements: settlements.items,
        };
      }
      return { partners: partners.items, total: partners.total };
    },
    [session, tab],
  );
  const { data, error, loading, reload } = useRemoteData(loader);
  const partnerMap = useMemo(
    () => new Map((data?.partners || []).map((partner) => [partner.id, partner.name])),
    [data],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const channels = (data?.partners || []).filter(
    (partner) => partner.roles.includes("channel") && partner.status === "active",
  );

  const open = (
    mode: Exclude<DialogMode, null>,
    item?: PartnerAdmission | CommissionSettlement | CommissionAccrual,
  ) => {
    setDialog(mode);
    setSelected(item || null);
    setErrors({});
    setSubmitError(null);
    if (mode === "partner") setPartnerForm({ ...EMPTY_PARTNER, roles: ["vendor"], ownerUserId: session.userId || "" });
    if (mode === "admission")
      setAdmissionForm({
        partnerId: data?.partners[0]?.id || "",
        role: data?.partners[0]?.roles[0] || "vendor",
        reason: "",
      });
    if (mode === "evaluation" && item) setEvaluationForm(defaultEvaluation((item as PartnerAdmission).role));
    if (mode === "suspension") setSuspensionReason("");
    if (mode === "agreement") setAgreementForm({ ...defaultAgreement(), channelPartnerId: channels[0]?.id || "" });
    if (mode === "settlement")
      setSettlementForm({ channelPartnerId: channels[0]?.id || "", accountingPeriod: currentPeriod() });
    if (mode === "payment" && item)
      setPaymentForm({
        paymentDate: currentDate(),
        amount: (item as CommissionSettlement).totalAmount,
        externalReference: "",
      });
    if (mode === "adjustment") setAdjustmentForm({ amount: "", reason: "" });
  };

  const openEvidence = (partner: Partner) => {
    setEvidencePartner(partner);
    setEvidenceForm({ evidenceType: "business_license", documentNumber: "", validUntil: "", file: null });
    setErrors({});
    setSubmitError(null);
    setDialog("evidence");
  };

  const close = useCallback(() => {
    if (!submitting) setDialog(null);
  }, [submitting]);

  const run = async (operation: () => Promise<CommandReceipt>) => {
    setSubmitting(true);
    setSubmitError(null);
    setActionError(null);
    try {
      const next = await operation();
      setReceipt(next);
      setDialog(null);
      reload();
    } catch (reason) {
      const next = reason instanceof Error ? reason : new Error("操作失败");
      if (dialog) setSubmitError(next);
      else setActionError(next);
    } finally {
      setSubmitting(false);
    }
  };

  const submitDialog = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validateDialog(dialog, {
      partnerForm,
      evidenceForm,
      admissionForm,
      evaluationForm,
      agreementForm,
      settlementForm,
      paymentForm,
      adjustmentForm,
      suspensionReason,
    });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    if (dialog === "partner") {
      await run(() => createPartner(session, normalizePartner(partnerForm), newIdempotencyKey("partner")));
    } else if (dialog === "evidence" && evidencePartner && evidenceForm.file) {
      await run(async () => {
        const uploaded = await uploadPartnerEvidence(session, evidencePartner.id, evidenceForm.file!);
        return attachPartnerEvidence(
          session,
          {
            partnerId: evidencePartner.id,
            evidenceType: evidenceForm.evidenceType,
            documentNumber: evidenceForm.documentNumber.trim() || undefined,
            validUntil: evidenceForm.validUntil || undefined,
            ...uploaded,
          },
          newIdempotencyKey("partner-evidence"),
        );
      });
    } else if (dialog === "admission") {
      await run(() => createPartnerAdmission(session, admissionForm, newIdempotencyKey("partner-admission")));
    } else if (dialog === "evaluation" && selected) {
      const admission = selected as PartnerAdmission;
      await run(() =>
        evaluatePartnerAdmission(
          session,
          {
            admissionId: admission.id,
            modelId: evaluationForm.modelId.trim() || undefined,
            formValues: ratingValues(admission.role, evaluationForm),
            disqualifiers: evaluationForm.disqualifiers,
          },
          newIdempotencyKey("partner-admission-evaluate"),
          admission.version,
        ),
      );
    } else if (dialog === "suspension" && selected) {
      const admission = selected as PartnerAdmission;
      await run(() =>
        suspendPartnerAdmission(
          session,
          { admissionId: admission.id, reason: suspensionReason.trim() },
          newIdempotencyKey("partner-admission-suspend"),
          admission.version,
        ),
      );
    } else if (dialog === "agreement") {
      await run(() =>
        createCommissionAgreement(
          session,
          normalizeAgreement(agreementForm),
          newIdempotencyKey("commission-agreement"),
        ),
      );
    } else if (dialog === "settlement") {
      await run(() => prepareCommissionSettlement(session, settlementForm, newIdempotencyKey("commission-settlement")));
    } else if (dialog === "payment" && selected) {
      await run(() =>
        recordCommissionPayment(
          session,
          { settlementId: selected.id, ...paymentForm },
          newIdempotencyKey("commission-payment"),
        ),
      );
    } else if (dialog === "adjustment" && selected) {
      await run(() =>
        createCommissionAdjustment(
          session,
          { accrualId: selected.id, amount: adjustmentForm.amount, reason: adjustmentForm.reason.trim() },
          newIdempotencyKey("commission-adjustment"),
        ),
      );
    }
  };

  const submitAdmission = (admission: PartnerAdmission) =>
    void run(() =>
      submitPartnerAdmission(session, admission.id, newIdempotencyKey("partner-admission-submit"), admission.version),
    );
  const submitAgreement = (agreement: CommissionAgreement) =>
    void run(() =>
      submitCommissionAgreement(
        session,
        agreement.id,
        newIdempotencyKey("commission-agreement-submit"),
        agreement.version,
      ),
    );
  const submitSettlement = (settlement: CommissionSettlement) =>
    void run(() =>
      submitCommissionSettlement(
        session,
        settlement.id,
        newIdempotencyKey("commission-settlement-submit"),
        settlement.version,
      ),
    );

  return (
    <div className="workspace partner-workspace">
      <PageHeader
        eyebrow="合作生态"
        title="合作方管理"
        meta={data ? `${data.total} 条当前记录` : undefined}
        action={tabAction(tab, data ?? undefined, channels, open)}
      />
      <div className="rating-tabs partner-tabs" role="tablist" aria-label="合作方管理功能">
        {TABS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={tab === item.key}
              onClick={() => {
                setTab(item.key);
                setQuery("");
                setActionError(null);
              }}
            >
              <Icon size={16} />
              {item.label}
            </button>
          );
        })}
      </div>
      {receipt ? <CommandNotice receipt={receipt} onClose={() => setReceipt(null)} /> : null}
      {actionError ? (
        <div className="inline-alert" role="alert">
          {actionError.message}
        </div>
      ) : null}
      <div className="table-toolbar">
        <label className="search-box">
          <Search size={16} />
          <span className="sr-only">检索当前页签</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder(tab)}
          />
        </label>
        <span>{data?.total || 0} 条记录</span>
      </div>
      <div role="tabpanel" aria-label={TABS.find((item) => item.key === tab)?.label}>
        {loading ? <LoadingState /> : null}
        {error ? <ErrorState error={error} onRetry={reload} /> : null}
        {!loading && !error && tab === "partners" ? (
          <PartnerTable
            items={filterPartners(data?.partners || [], normalizedQuery)}
            onEmpty={Boolean(data?.partners.length)}
            onEvidence={openEvidence}
          />
        ) : null}
        {!loading && !error && tab === "admissions" ? (
          <AdmissionTable
            items={filterAdmissions(data?.admissions || [], partnerMap, normalizedQuery)}
            partnerMap={partnerMap}
            open={open}
            submit={submitAdmission}
          />
        ) : null}
        {!loading && !error && tab === "agreements" ? (
          <AgreementTable
            items={filterAgreements(data?.agreements || [], partnerMap, normalizedQuery)}
            partnerMap={partnerMap}
            submit={submitAgreement}
          />
        ) : null}
        {!loading && !error && tab === "settlements" ? (
          <SettlementTables
            settlements={filterSettlements(data?.settlements || [], partnerMap, normalizedQuery)}
            accruals={filterAccruals(data?.accruals || [], partnerMap, normalizedQuery)}
            partnerMap={partnerMap}
            open={open}
            submit={submitSettlement}
          />
        ) : null}
      </div>
      <PartnerDialog
        mode={dialog}
        form={partnerForm}
        setForm={setPartnerForm}
        errors={errors}
        submitting={submitting}
        submitError={submitError}
        close={close}
        submit={submitDialog}
      />
      <EvidenceDialog
        mode={dialog}
        partner={evidencePartner}
        form={evidenceForm}
        setForm={setEvidenceForm}
        errors={errors}
        submitting={submitting}
        submitError={submitError}
        close={close}
        submit={submitDialog}
      />
      <AdmissionDialog
        mode={dialog}
        partners={data?.partners || []}
        form={admissionForm}
        setForm={setAdmissionForm}
        evaluation={evaluationForm}
        setEvaluation={setEvaluationForm}
        suspensionReason={suspensionReason}
        setSuspensionReason={setSuspensionReason}
        selected={selected as PartnerAdmission | null}
        errors={errors}
        submitting={submitting}
        submitError={submitError}
        close={close}
        submit={submitDialog}
      />
      <CommissionDialog
        mode={dialog}
        channels={channels}
        agreement={agreementForm}
        setAgreement={setAgreementForm}
        settlement={settlementForm}
        setSettlement={setSettlementForm}
        payment={paymentForm}
        setPayment={setPaymentForm}
        adjustment={adjustmentForm}
        setAdjustment={setAdjustmentForm}
        selected={selected}
        errors={errors}
        submitting={submitting}
        submitError={submitError}
        close={close}
        submit={submitDialog}
      />
    </div>
  );
}

function PartnerTable({
  items,
  onEmpty,
  onEvidence,
}: {
  items: Partner[];
  onEmpty: boolean;
  onEvidence: (partner: Partner) => void;
}) {
  if (items.length === 0)
    return (
      <EmptyState
        title={onEmpty ? "未找到匹配合作机构" : "暂无合作机构"}
        detail={onEmpty ? "请调整检索条件" : "建立机构主档后可分别发起厂商或渠道准入"}
      />
    );
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">合作机构列表</caption>
        <thead>
          <tr>
            <th>机构</th>
            <th>角色</th>
            <th>部门合作关系</th>
            <th>联系人</th>
            <th>银行信息</th>
            <th>状态</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((partner) => (
            <tr key={partner.id}>
              <td>
                <span className="primary-cell">
                  <Building2 size={16} />
                  {partner.name}
                </span>
                <small className="mono">{partner.unifiedSocialCreditCode}</small>
              </td>
              <td>
                <RoleBadges roles={partner.roles} />
              </td>
              <td>
                {partner.engagement ? (
                  <>
                    <StatusBadge
                      label={partnerStatusLabel(partner.engagement.status)}
                      tone={statusTone(partner.engagement.status)}
                    />
                    <small>{partner.engagement.ownerUserId}</small>
                  </>
                ) : (
                  "未建立"
                )}
              </td>
              <td>
                {partner.contactName}
                <small>{partner.contactPhone}</small>
              </td>
              <td>
                {partner.bankName || "--"}
                <small className="mono masked-account">{maskAccount(partner.bankAccount)}</small>
              </td>
              <td>
                <StatusBadge label={partnerStatusLabel(partner.status)} tone={statusTone(partner.status)} />
              </td>
              <td>
                {formatDateTime(partner.updatedAt)}
                <small>v{partner.version}</small>
              </td>
              <td>
                <button
                  className="icon-button quiet"
                  type="button"
                  title="上传证据材料"
                  aria-label={`上传 ${partner.name} 证据材料`}
                  onClick={() => onEvidence(partner)}
                >
                  <FileUp size={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdmissionTable({
  items,
  partnerMap,
  open,
  submit,
}: {
  items: PartnerAdmission[];
  partnerMap: Map<string, string>;
  open: (mode: Exclude<DialogMode, null>, item?: PartnerAdmission) => void;
  submit: (item: PartnerAdmission) => void;
}) {
  if (items.length === 0) return <EmptyState title="暂无准入评价" detail="按厂商或渠道角色发起独立评价" />;
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">合作机构准入评价列表</caption>
        <thead>
          <tr>
            <th>机构 / 角色</th>
            <th>评分</th>
            <th>系统建议</th>
            <th>有效期</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <span className="primary-cell">
                  <ShieldCheck size={16} />
                  {partnerMap.get(item.partnerId) || item.partnerId}
                </span>
                <small>
                  {roleLabel(item.role)} · {item.reason}
                </small>
              </td>
              <td className="strong">
                {item.score ? `${item.score} 分` : "待评分"}
                <small>{item.modelVersion ? `${item.modelId} / ${item.modelVersion}` : ""}</small>
              </td>
              <td>
                {admissionLabel(item.recommendation || "--")}
                {item.disqualifiers?.length ? (
                  <small className="danger-text">否决项 {item.disqualifiers.length} 项</small>
                ) : null}
              </td>
              <td>
                {item.validUntil ? formatDateTime(item.validUntil) : "--"}
                {item.alerts?.map((alert) => (
                  <small key={alert.type} className={alert.severity === "high" ? "danger-text" : "warning-text"}>
                    {alert.message}
                  </small>
                ))}
              </td>
              <td>
                <StatusBadge label={admissionLabel(item.status)} tone={admissionTone(item.status)} />
              </td>
              <td>
                <div className="row-actions">
                  {["draft", "materials_incomplete", "evaluating"].includes(item.status) ? (
                    <button
                      className="icon-button quiet"
                      type="button"
                      title="执行评分"
                      aria-label={`评价 ${partnerMap.get(item.partnerId) || item.partnerId}`}
                      onClick={() => open("evaluation", item)}
                    >
                      <PlayCircle size={16} />
                    </button>
                  ) : null}
                  {item.status === "evaluating" && item.recommendation ? (
                    <button
                      className="icon-button quiet"
                      type="button"
                      title="提交准入审批"
                      aria-label={`提交 ${partnerMap.get(item.partnerId) || item.partnerId} 准入审批`}
                      onClick={() => submit(item)}
                    >
                      <Send size={16} />
                    </button>
                  ) : null}
                  {["admitted", "conditionally_admitted"].includes(item.status) ? (
                    <button
                      className="icon-button quiet danger-quiet"
                      type="button"
                      title="暂停准入"
                      aria-label={`暂停 ${partnerMap.get(item.partnerId) || item.partnerId} 准入`}
                      onClick={() => open("suspension", item)}
                    >
                      <Ban size={16} />
                    </button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AgreementTable({
  items,
  partnerMap,
  submit,
}: {
  items: CommissionAgreement[];
  partnerMap: Map<string, string>;
  submit: (item: CommissionAgreement) => void;
}) {
  if (items.length === 0) return <EmptyState title="暂无佣金协议" detail="为已准入渠道建立部门级佣金规则" />;
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">渠道佣金协议列表</caption>
        <thead>
          <tr>
            <th>协议 / 渠道</th>
            <th>计算规则</th>
            <th>保底 / 封顶</th>
            <th>生效区间</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <span className="primary-cell">
                  <ReceiptText size={16} />
                  {item.agreementNumber}
                </span>
                <small>{partnerMap.get(item.channelPartnerId) || item.channelPartnerId}</small>
              </td>
              <td>
                {item.calculationType === "fixed"
                  ? `固定 ${formatMoney(item.fixedAmount)}`
                  : `投放额 × ${(Number(item.rateBps || 0) / 100).toFixed(2)}%`}
              </td>
              <td>
                {formatMoney(item.minimumAmount)} / {formatMoney(item.maximumAmount)}
              </td>
              <td>
                {item.effectiveFrom}
                <small>至 {item.effectiveTo}</small>
              </td>
              <td>
                <StatusBadge label={partnerStatusLabel(item.status)} tone={statusTone(item.status)} />
              </td>
              <td>
                <div className="row-actions">
                  {item.status === "draft" ? (
                    <button
                      className="icon-button quiet"
                      type="button"
                      title="提交协议审批"
                      aria-label={`提交协议 ${item.agreementNumber}`}
                      onClick={() => submit(item)}
                    >
                      <Send size={16} />
                    </button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SettlementTables({
  settlements,
  accruals,
  partnerMap,
  open,
  submit,
}: {
  settlements: CommissionSettlement[];
  accruals: CommissionAccrual[];
  partnerMap: Map<string, string>;
  open: (mode: Exclude<DialogMode, null>, item?: CommissionSettlement | CommissionAccrual) => void;
  submit: (item: CommissionSettlement) => void;
}) {
  if (settlements.length === 0 && accruals.length === 0)
    return <EmptyState title="暂无待结算计提或结算单" detail="成功投放后按项目佣金快照自动计提" />;
  return (
    <div className="commission-datasets">
      <section>
        <div className="dataset-heading">
          <h2>结算单</h2>
          <span>{settlements.length} 张</span>
        </div>
        {settlements.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>渠道 / 账期</th>
                  <th className="numeric">应付金额</th>
                  <th>复核</th>
                  <th>支付记录</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {settlements.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <span className="primary-cell">
                        <BadgeDollarSign size={16} />
                        {partnerMap.get(item.channelPartnerId) || item.channelPartnerId}
                      </span>
                      <small>{item.accountingPeriod}</small>
                    </td>
                    <td className="numeric strong">{formatMoney(item.totalAmount)}</td>
                    <td>{item.checkerUserIds?.length || 0} / 2</td>
                    <td>{item.payments?.length || 0} 笔</td>
                    <td>
                      <StatusBadge label={partnerStatusLabel(item.status)} tone={statusTone(item.status)} />
                    </td>
                    <td>
                      <div className="row-actions">
                        {item.status === "prepared" ? (
                          <button
                            className="icon-button quiet"
                            type="button"
                            title="提交结算审批"
                            aria-label={`提交 ${item.accountingPeriod} 结算审批`}
                            onClick={() => submit(item)}
                          >
                            <Send size={16} />
                          </button>
                        ) : null}
                        {item.status === "approved" ? (
                          <button
                            className="icon-button quiet"
                            type="button"
                            title="登记支付"
                            aria-label={`登记 ${item.accountingPeriod} 支付`}
                            onClick={() => open("payment", item)}
                          >
                            <CreditCard size={16} />
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="暂无结算单" detail="按渠道和账期汇总可结算计提" />
        )}
      </section>
      <section>
        <div className="dataset-heading">
          <h2>佣金计提</h2>
          <span>{accruals.length} 笔</span>
        </div>
        {accruals.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>项目 / 渠道</th>
                  <th>投放记录</th>
                  <th>账期</th>
                  <th className="numeric">计提金额</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {accruals.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <span className="primary-cell">
                        <BadgeDollarSign size={16} />
                        {item.projectId}
                      </span>
                      <small>{partnerMap.get(item.channelPartnerId) || item.channelPartnerId}</small>
                    </td>
                    <td className="mono">{item.disbursementId}</td>
                    <td>{item.accountingPeriod}</td>
                    <td className="numeric strong">{formatMoney(item.amount)}</td>
                    <td>
                      <StatusBadge label={partnerStatusLabel(item.status)} tone={statusTone(item.status)} />
                    </td>
                    <td>
                      {!item.adjustmentOfAccrualId ? (
                        <button
                          className="icon-button quiet danger-quiet"
                          type="button"
                          title="负数调整"
                          aria-label={`调整计提 ${item.id}`}
                          onClick={() => open("adjustment", item)}
                        >
                          <RotateCcw size={16} />
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="暂无佣金计提" detail="投放审批通过后自动生成" />
        )}
      </section>
    </div>
  );
}

function PartnerDialog({
  mode,
  form,
  setForm,
  errors,
  submitting,
  submitError,
  close,
  submit,
}: {
  mode: DialogMode;
  form: PartnerCreateInput;
  setForm: (value: PartnerCreateInput) => void;
  errors: Record<string, string>;
  submitting: boolean;
  submitError: Error | null;
  close: () => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const toggleRole = (role: PartnerRole, checked: boolean) =>
    setForm({
      ...form,
      roles: checked ? [...new Set([...form.roles, role])] : form.roles.filter((item) => item !== role),
    });
  return (
    <Dialog
      open={mode === "partner"}
      title="新增合作机构"
      subtitle="建立组织级主档及当前部门合作关系"
      submitting={submitting}
      submitLabel="提交创建"
      error={submitError}
      onClose={close}
      onSubmit={submit}
    >
      <div className="form-grid">
        <Field label="机构名称" required span={2} error={errors.name}>
          <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </Field>
        <Field label="统一社会信用代码" required span={2} error={errors.unifiedSocialCreditCode}>
          <input
            className="mono"
            maxLength={18}
            value={form.unifiedSocialCreditCode}
            onChange={(event) => setForm({ ...form, unifiedSocialCreditCode: event.target.value.toUpperCase() })}
          />
        </Field>
        <Field label="法定代表人" required error={errors.legalRepresentative}>
          <input
            value={form.legalRepresentative}
            onChange={(event) => setForm({ ...form, legalRepresentative: event.target.value })}
          />
        </Field>
        <Field label="联系人" required error={errors.contactName}>
          <input value={form.contactName} onChange={(event) => setForm({ ...form, contactName: event.target.value })} />
        </Field>
        <Field label="联系电话" required error={errors.contactPhone}>
          <input
            inputMode="tel"
            value={form.contactPhone}
            onChange={(event) => setForm({ ...form, contactPhone: event.target.value })}
          />
        </Field>
        <Field label="注册地址" required error={errors.registeredAddress}>
          <input
            value={form.registeredAddress}
            onChange={(event) => setForm({ ...form, registeredAddress: event.target.value })}
          />
        </Field>
        <Field label="开户银行" required error={errors.bankName}>
          <input value={form.bankName} onChange={(event) => setForm({ ...form, bankName: event.target.value })} />
        </Field>
        <Field label="银行账号" required error={errors.bankAccount}>
          <input
            className="mono"
            inputMode="numeric"
            value={form.bankAccount}
            onChange={(event) => setForm({ ...form, bankAccount: event.target.value })}
          />
        </Field>
        <div className="field span-2">
          <label>
            合作角色<b aria-hidden="true">*</b>
          </label>
          <div className="checkbox-row">
            <label>
              <input
                type="checkbox"
                checked={form.roles.includes("vendor")}
                onChange={(event) => toggleRole("vendor", event.target.checked)}
              />
              厂商
            </label>
            <label>
              <input
                type="checkbox"
                checked={form.roles.includes("channel")}
                onChange={(event) => toggleRole("channel", event.target.checked)}
              />
              渠道
            </label>
          </div>
          {errors.roles ? <small className="field-error">{errors.roles}</small> : null}
        </div>
      </div>
    </Dialog>
  );
}

function EvidenceDialog({
  mode,
  partner,
  form,
  setForm,
  errors,
  submitting,
  submitError,
  close,
  submit,
}: {
  mode: DialogMode;
  partner: Partner | null;
  form: { evidenceType: string; documentNumber: string; validUntil: string; file: File | null };
  setForm: (value: { evidenceType: string; documentNumber: string; validUntil: string; file: File | null }) => void;
  errors: Record<string, string>;
  submitting: boolean;
  submitError: Error | null;
  close: () => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Dialog
      open={mode === "evidence"}
      title="上传证据材料"
      subtitle={partner?.name || "合作机构"}
      submitting={submitting}
      submitLabel="上传并关联"
      error={submitError}
      onClose={close}
      onSubmit={submit}
    >
      <div className="form-grid">
        <Field label="材料类型" required>
          <select
            value={form.evidenceType}
            onChange={(event) => setForm({ ...form, evidenceType: event.target.value })}
          >
            <option value="business_license">营业执照</option>
            <option value="brand_authorization">品牌授权</option>
            <option value="bank_account">银行账户证明</option>
            <option value="compliance_certificate">合规证明</option>
            <option value="other">其他材料</option>
          </select>
        </Field>
        <Field label="文件" required error={errors.file}>
          <input
            type="file"
            accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png"
            onChange={(event) => setForm({ ...form, file: event.target.files?.[0] || null })}
          />
        </Field>
        <Field label="证件编号">
          <input
            value={form.documentNumber}
            onChange={(event) => setForm({ ...form, documentNumber: event.target.value })}
          />
        </Field>
        <Field label="有效期至">
          <input
            type="date"
            value={form.validUntil}
            onChange={(event) => setForm({ ...form, validUntil: event.target.value })}
          />
        </Field>
      </div>
    </Dialog>
  );
}

function AdmissionDialog({
  mode,
  partners,
  form,
  setForm,
  evaluation,
  setEvaluation,
  suspensionReason,
  setSuspensionReason,
  selected,
  errors,
  submitting,
  submitError,
  close,
  submit,
}: {
  mode: DialogMode;
  partners: Partner[];
  form: { partnerId: string; role: PartnerRole; reason: string };
  setForm: (value: { partnerId: string; role: PartnerRole; reason: string }) => void;
  evaluation: ReturnType<typeof defaultEvaluation>;
  setEvaluation: (value: ReturnType<typeof defaultEvaluation>) => void;
  suspensionReason: string;
  setSuspensionReason: (value: string) => void;
  selected: PartnerAdmission | null;
  errors: Record<string, string>;
  submitting: boolean;
  submitError: Error | null;
  close: () => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const partner = partners.find((item) => item.id === form.partnerId);
  const setPartner = (id: string) => {
    const next = partners.find((item) => item.id === id);
    setForm({ ...form, partnerId: id, role: next?.roles[0] || "vendor" });
  };
  return (
    <>
      <Dialog
        open={mode === "admission"}
        title="发起准入评价"
        subtitle="厂商与渠道角色分别评价、分别形成结论"
        submitting={submitting}
        submitLabel="建立评价草稿"
        error={submitError}
        onClose={close}
        onSubmit={submit}
      >
        <div className="form-grid">
          <Field label="合作机构" required span={2} error={errors.partnerId}>
            <select value={form.partnerId} onChange={(event) => setPartner(event.target.value)}>
              <option value="">请选择合作机构</option>
              {partners.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="准入角色" required>
            <select
              value={form.role}
              onChange={(event) => setForm({ ...form, role: event.target.value as PartnerRole })}
            >
              {(partner?.roles || []).map((role) => (
                <option key={role} value={role}>
                  {roleLabel(role)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="发起原因" required error={errors.reason}>
            <input value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} />
          </Field>
        </div>
      </Dialog>
      <Dialog
        open={mode === "evaluation"}
        title={`准入评分 · ${roleLabel(selected?.role || "vendor")}`}
        subtitle="系统评分不可用时将保留可重试的评价草稿"
        submitting={submitting}
        submitLabel="执行评分"
        error={submitError}
        onClose={close}
        onSubmit={submit}
      >
        <div className="form-grid">
          <Field label="评分模型">
            <input
              value={evaluation.modelId}
              onChange={(event) => setEvaluation({ ...evaluation, modelId: event.target.value })}
              placeholder={selected?.role === "channel" ? "partner_channel" : "partner_vendor"}
            />
          </Field>
          <Field label="主体资质（15）" required error={errors.qualification}>
            <input
              type="number"
              min={0}
              max={15}
              value={evaluation.qualification}
              onChange={(event) => setEvaluation({ ...evaluation, qualification: event.target.value })}
            />
          </Field>
          <Field label="合规信用（15）" required>
            <input
              type="number"
              min={0}
              max={15}
              value={evaluation.compliance}
              onChange={(event) => setEvaluation({ ...evaluation, compliance: event.target.value })}
            />
          </Field>
          <Field label="经营稳定性（10）" required>
            <input
              type="number"
              min={0}
              max={10}
              value={evaluation.stability}
              onChange={(event) => setEvaluation({ ...evaluation, stability: event.target.value })}
            />
          </Field>
          {(selected?.role || "vendor") === "vendor" ? (
            <>
              <ScoreField label="产品授权（15）" field="special1" max={15} form={evaluation} setForm={setEvaluation} />
              <ScoreField label="交付能力（15）" field="special2" max={15} form={evaluation} setForm={setEvaluation} />
              <ScoreField label="质量售后（15）" field="special3" max={15} form={evaluation} setForm={setEvaluation} />
              <ScoreField label="财务能力（10）" field="special4" max={10} form={evaluation} setForm={setEvaluation} />
              <ScoreField label="合作记录（5）" field="special5" max={5} form={evaluation} setForm={setEvaluation} />
            </>
          ) : (
            <>
              <ScoreField label="获客覆盖（20）" field="special1" max={20} form={evaluation} setForm={setEvaluation} />
              <ScoreField label="营销合规（15）" field="special2" max={15} form={evaluation} setForm={setEvaluation} />
              <ScoreField label="转化质量（15）" field="special3" max={15} form={evaluation} setForm={setEvaluation} />
              <ScoreField label="合作记录（10）" field="special4" max={10} form={evaluation} setForm={setEvaluation} />
            </>
          )}
          <div className="field span-2">
            <label>否决项</label>
            <div className="checkbox-row wrap">
              {[
                ["license_expired", "证照失效"],
                ["blacklist_or_sanction", "黑名单或制裁命中"],
                ["material_fraud", "材料造假"],
              ].map(([value, label]) => (
                <label key={value}>
                  <input
                    type="checkbox"
                    checked={evaluation.disqualifiers.includes(value)}
                    onChange={(event) =>
                      setEvaluation({
                        ...evaluation,
                        disqualifiers: event.target.checked
                          ? [...evaluation.disqualifiers, value]
                          : evaluation.disqualifiers.filter((item) => item !== value),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
        </div>
      </Dialog>
      <Dialog
        open={mode === "suspension"}
        title="暂停准入"
        subtitle="暂停仅阻止新项目，不修改历史项目"
        submitting={submitting}
        submitLabel="确认暂停"
        error={submitError}
        onClose={close}
        onSubmit={submit}
      >
        <div className="form-grid">
          <Field label="暂停原因" required span={2} error={errors.suspensionReason}>
            <textarea rows={4} value={suspensionReason} onChange={(event) => setSuspensionReason(event.target.value)} />
          </Field>
        </div>
      </Dialog>
    </>
  );
}

function ScoreField({
  label,
  field,
  max,
  form,
  setForm,
}: {
  label: string;
  field: "special1" | "special2" | "special3" | "special4" | "special5";
  max: number;
  form: ReturnType<typeof defaultEvaluation>;
  setForm: (value: ReturnType<typeof defaultEvaluation>) => void;
}) {
  return (
    <Field label={label} required>
      <input
        type="number"
        min={0}
        max={max}
        value={form[field]}
        onChange={(event) => setForm({ ...form, [field]: event.target.value })}
      />
    </Field>
  );
}

function CommissionDialog({
  mode,
  channels,
  agreement,
  setAgreement,
  settlement,
  setSettlement,
  payment,
  setPayment,
  adjustment,
  setAdjustment,
  selected,
  errors,
  submitting,
  submitError,
  close,
  submit,
}: {
  mode: DialogMode;
  channels: Partner[];
  agreement: ReturnType<typeof defaultAgreement>;
  setAgreement: (value: ReturnType<typeof defaultAgreement>) => void;
  settlement: { channelPartnerId: string; accountingPeriod: string };
  setSettlement: (value: { channelPartnerId: string; accountingPeriod: string }) => void;
  payment: { paymentDate: string; amount: string; externalReference: string };
  setPayment: (value: { paymentDate: string; amount: string; externalReference: string }) => void;
  adjustment: { amount: string; reason: string };
  setAdjustment: (value: { amount: string; reason: string }) => void;
  selected: PartnerAdmission | CommissionSettlement | CommissionAccrual | null;
  errors: Record<string, string>;
  submitting: boolean;
  submitError: Error | null;
  close: () => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <>
      <Dialog
        open={mode === "agreement"}
        title="新增佣金协议"
        subtitle="同部门、同渠道的生效区间不得重叠"
        submitting={submitting}
        submitLabel="建立协议草稿"
        error={submitError}
        onClose={close}
        onSubmit={submit}
      >
        <div className="form-grid">
          <Field label="渠道" required span={2} error={errors.channelPartnerId}>
            <select
              value={agreement.channelPartnerId}
              onChange={(event) => setAgreement({ ...agreement, channelPartnerId: event.target.value })}
            >
              <option value="">请选择渠道</option>
              {channels.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="协议编号" required error={errors.agreementNumber}>
            <input
              value={agreement.agreementNumber}
              onChange={(event) => setAgreement({ ...agreement, agreementNumber: event.target.value })}
            />
          </Field>
          <Field label="计算方式" required>
            <select
              value={agreement.calculationType}
              onChange={(event) =>
                setAgreement({ ...agreement, calculationType: event.target.value as "fixed" | "rate" })
              }
            >
              <option value="fixed">固定金额</option>
              <option value="rate">按实际投放比例</option>
            </select>
          </Field>
          {agreement.calculationType === "fixed" ? (
            <Field label="固定金额（元）" required error={errors.fixedAmount}>
              <input
                inputMode="decimal"
                value={agreement.fixedAmount}
                onChange={(event) => setAgreement({ ...agreement, fixedAmount: event.target.value })}
              />
            </Field>
          ) : (
            <Field label="比例（基点）" required error={errors.rateBps}>
              <input
                type="number"
                min={1}
                max={10000}
                value={agreement.rateBps}
                onChange={(event) => setAgreement({ ...agreement, rateBps: event.target.value })}
              />
            </Field>
          )}
          <Field label="保底金额（元）">
            <input
              inputMode="decimal"
              value={agreement.minimumAmount}
              onChange={(event) => setAgreement({ ...agreement, minimumAmount: event.target.value })}
            />
          </Field>
          <Field label="封顶金额（元）">
            <input
              inputMode="decimal"
              value={agreement.maximumAmount}
              onChange={(event) => setAgreement({ ...agreement, maximumAmount: event.target.value })}
            />
          </Field>
          <Field label="生效日期" required>
            <input
              type="date"
              value={agreement.effectiveFrom}
              onChange={(event) => setAgreement({ ...agreement, effectiveFrom: event.target.value })}
            />
          </Field>
          <Field label="失效日期" required error={errors.effectiveTo}>
            <input
              type="date"
              value={agreement.effectiveTo}
              onChange={(event) => setAgreement({ ...agreement, effectiveTo: event.target.value })}
            />
          </Field>
        </div>
      </Dialog>
      <Dialog
        open={mode === "settlement"}
        title="生成佣金结算单"
        subtitle="按当前部门、渠道和账期汇总未占用计提"
        submitting={submitting}
        submitLabel="生成结算单"
        error={submitError}
        onClose={close}
        onSubmit={submit}
      >
        <div className="form-grid">
          <Field label="渠道" required error={errors.channelPartnerId}>
            <select
              value={settlement.channelPartnerId}
              onChange={(event) => setSettlement({ ...settlement, channelPartnerId: event.target.value })}
            >
              <option value="">请选择渠道</option>
              {channels.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="账期" required>
            <input
              type="month"
              value={settlement.accountingPeriod}
              onChange={(event) => setSettlement({ ...settlement, accountingPeriod: event.target.value })}
            />
          </Field>
        </div>
      </Dialog>
      <Dialog
        open={mode === "payment"}
        title="登记佣金支付"
        subtitle="外部流水号在当前部门内唯一"
        submitting={submitting}
        submitLabel="登记支付"
        error={submitError}
        onClose={close}
        onSubmit={submit}
      >
        <div className="form-grid">
          <Field label="支付日期" required>
            <input
              type="date"
              value={payment.paymentDate}
              onChange={(event) => setPayment({ ...payment, paymentDate: event.target.value })}
            />
          </Field>
          <Field label="支付金额（元）" required error={errors.amount}>
            <input
              inputMode="decimal"
              value={payment.amount}
              onChange={(event) => setPayment({ ...payment, amount: event.target.value })}
            />
          </Field>
          <Field label="外部流水号" required span={2} error={errors.externalReference}>
            <input
              className="mono"
              value={payment.externalReference}
              onChange={(event) => setPayment({ ...payment, externalReference: event.target.value })}
            />
          </Field>
        </div>
      </Dialog>
      <Dialog
        open={mode === "adjustment"}
        title="创建佣金负数调整"
        subtitle={`原计提 ${formatMoney((selected as CommissionAccrual | null)?.amount)}`}
        submitting={submitting}
        submitLabel="创建调整"
        error={submitError}
        onClose={close}
        onSubmit={submit}
      >
        <div className="form-grid">
          <Field label="调整金额（元）" required error={errors.amount}>
            <input
              inputMode="decimal"
              placeholder="例如 -100.00"
              value={adjustment.amount}
              onChange={(event) => setAdjustment({ ...adjustment, amount: event.target.value })}
            />
          </Field>
          <Field label="调整原因" required error={errors.reason}>
            <input
              value={adjustment.reason}
              onChange={(event) => setAdjustment({ ...adjustment, reason: event.target.value })}
            />
          </Field>
        </div>
      </Dialog>
    </>
  );
}

function tabAction(
  tab: Tab,
  data: WorkspaceData | undefined,
  channels: Partner[],
  open: (mode: Exclude<DialogMode, null>) => void,
) {
  if (tab === "partners")
    return (
      <button className="button primary" type="button" onClick={() => open("partner")}>
        <Plus size={17} />
        新增合作机构
      </button>
    );
  if (tab === "admissions")
    return (
      <button
        className="button primary"
        type="button"
        disabled={!data?.partners.length}
        onClick={() => open("admission")}
      >
        <Plus size={17} />
        发起准入
      </button>
    );
  if (tab === "agreements")
    return (
      <button className="button primary" type="button" disabled={!channels.length} onClick={() => open("agreement")}>
        <Plus size={17} />
        新增佣金协议
      </button>
    );
  return (
    <button className="button primary" type="button" disabled={!channels.length} onClick={() => open("settlement")}>
      <Plus size={17} />
      生成结算单
    </button>
  );
}

function RoleBadges({ roles }: { roles: PartnerRole[] }) {
  return (
    <div className="role-badges">
      {roles.map((role) => (
        <span key={role}>{roleLabel(role)}</span>
      ))}
    </div>
  );
}
function roleLabel(role: PartnerRole) {
  return role === "channel" ? "渠道" : "厂商";
}
function admissionLabel(value: string) {
  return (
    (
      {
        materials_incomplete: "材料不完整",
        evaluating: "评价中",
        workflow_pending: "审批中",
        admitted: "准入",
        conditionally_admitted: "条件准入",
        rejected: "拒绝",
        suspended: "暂停",
        expired: "过期",
        draft: "草稿",
      } as Record<string, string>
    )[value] || value
  );
}
function admissionTone(value: string) {
  if (value === "admitted") return "success";
  if (["rejected", "suspended", "expired"].includes(value)) return "danger";
  if (["conditionally_admitted", "workflow_pending", "materials_incomplete"].includes(value)) return "warning";
  return "info";
}
function partnerStatusLabel(value: string) {
  return (
    (
      {
        active: "启用",
        inactive: "停用",
        archived: "已归档",
        workflow_pending: "审批中",
        prepared: "待提交",
        approved: "已审批",
        paid: "已支付",
        accrued: "已计提",
        settled: "已结算",
        adjusted: "已调整",
        draft: "草稿",
        rejected: "已拒绝",
      } as Record<string, string>
    )[value] || statusLabel(value)
  );
}
function maskAccount(value: string) {
  return value ? `${value.slice(0, 4)} **** ${value.slice(-4)}` : "--";
}
function searchPlaceholder(tab: Tab) {
  return tab === "partners"
    ? "机构名称、统一社会信用代码、联系人"
    : tab === "admissions"
      ? "机构、角色、状态"
      : tab === "agreements"
        ? "协议编号、渠道、状态"
        : "渠道、账期、项目或投放记录";
}

function filterPartners(items: Partner[], query: string) {
  return query
    ? items.filter((item) =>
        [item.name, item.unifiedSocialCreditCode, item.contactName, ...item.roles].some((value) =>
          value.toLocaleLowerCase().includes(query),
        ),
      )
    : items;
}
function filterAdmissions(items: PartnerAdmission[], names: Map<string, string>, query: string) {
  return query
    ? items.filter((item) =>
        [names.get(item.partnerId) || "", item.role, item.status, item.reason].some((value) =>
          value.toLocaleLowerCase().includes(query),
        ),
      )
    : items;
}
function filterAgreements(items: CommissionAgreement[], names: Map<string, string>, query: string) {
  return query
    ? items.filter((item) =>
        [item.agreementNumber, names.get(item.channelPartnerId) || "", item.status].some((value) =>
          value.toLocaleLowerCase().includes(query),
        ),
      )
    : items;
}
function filterSettlements(items: CommissionSettlement[], names: Map<string, string>, query: string) {
  return query
    ? items.filter((item) =>
        [item.accountingPeriod, names.get(item.channelPartnerId) || "", item.status].some((value) =>
          value.toLocaleLowerCase().includes(query),
        ),
      )
    : items;
}
function filterAccruals(items: CommissionAccrual[], names: Map<string, string>, query: string) {
  return query
    ? items.filter((item) =>
        [
          item.projectId,
          item.disbursementId,
          item.accountingPeriod,
          names.get(item.channelPartnerId) || "",
          item.status,
        ].some((value) => value.toLocaleLowerCase().includes(query)),
      )
    : items;
}

function validateDialog(
  mode: DialogMode,
  forms: {
    partnerForm: PartnerCreateInput;
    evidenceForm: { file: File | null };
    admissionForm: { partnerId: string; reason: string };
    evaluationForm: ReturnType<typeof defaultEvaluation>;
    agreementForm: ReturnType<typeof defaultAgreement>;
    settlementForm: { channelPartnerId: string };
    paymentForm: { amount: string; externalReference: string };
    adjustmentForm: { amount: string; reason: string };
    suspensionReason: string;
  },
) {
  const errors: Record<string, string> = {};
  if (mode === "partner") {
    const form = forms.partnerForm;
    if (form.name.trim().length < 2) errors.name = "请输入机构名称";
    if (!/^[0-9A-Z]{18}$/.test(form.unifiedSocialCreditCode.trim()))
      errors.unifiedSocialCreditCode = "请输入18位统一社会信用代码";
    for (const key of [
      "legalRepresentative",
      "registeredAddress",
      "contactName",
      "contactPhone",
      "bankName",
      "bankAccount",
    ] as const)
      if (!form[key].trim()) errors[key] = "此项不能为空";
    if (!form.roles.length) errors.roles = "至少选择一个合作角色";
  }
  if (mode === "evidence") {
    if (!forms.evidenceForm.file) errors.file = "请选择证据文件";
    else if (forms.evidenceForm.file.size > 20 * 1024 * 1024) errors.file = "单个文件不得超过20 MB";
  }
  if (mode === "admission") {
    if (!forms.admissionForm.partnerId) errors.partnerId = "请选择合作机构";
    if (!forms.admissionForm.reason.trim()) errors.reason = "请输入发起原因";
  }
  if (mode === "evaluation" && !forms.evaluationForm.qualification) errors.qualification = "请输入主体资质得分";
  if (mode === "suspension" && !forms.suspensionReason.trim()) errors.suspensionReason = "请输入暂停原因";
  if (mode === "agreement") {
    const form = forms.agreementForm;
    if (!form.channelPartnerId) errors.channelPartnerId = "请选择渠道";
    if (!form.agreementNumber.trim()) errors.agreementNumber = "请输入协议编号";
    if (form.calculationType === "fixed" && !positiveMoney(form.fixedAmount)) errors.fixedAmount = "请输入有效固定金额";
    if (form.calculationType === "rate" && !(Number(form.rateBps) >= 1 && Number(form.rateBps) <= 10000))
      errors.rateBps = "比例须为1至10000基点";
    if (!form.effectiveTo || form.effectiveTo < form.effectiveFrom) errors.effectiveTo = "失效日期不得早于生效日期";
  }
  if (mode === "settlement" && !forms.settlementForm.channelPartnerId) errors.channelPartnerId = "请选择渠道";
  if (mode === "payment") {
    if (!positiveMoney(forms.paymentForm.amount)) errors.amount = "请输入有效支付金额";
    if (!forms.paymentForm.externalReference.trim()) errors.externalReference = "请输入外部流水号";
  }
  if (mode === "adjustment") {
    if (!/^-[0-9]+(?:\.[0-9]{1,2})?$/.test(forms.adjustmentForm.amount)) errors.amount = "请输入负数调整金额";
    if (!forms.adjustmentForm.reason.trim()) errors.reason = "请输入调整原因";
  }
  return errors;
}

function normalizePartner(form: PartnerCreateInput): PartnerCreateInput {
  return {
    ...form,
    name: form.name.trim(),
    unifiedSocialCreditCode: form.unifiedSocialCreditCode.trim().toUpperCase(),
    legalRepresentative: form.legalRepresentative.trim(),
    registeredAddress: form.registeredAddress.trim(),
    contactName: form.contactName.trim(),
    contactPhone: form.contactPhone.trim(),
    bankName: form.bankName.trim(),
    bankAccount: form.bankAccount.trim(),
    ownerUserId: form.ownerUserId.trim(),
  };
}
function defaultAgreement() {
  return {
    channelPartnerId: "",
    agreementNumber: "",
    calculationType: "fixed" as "fixed" | "rate",
    fixedAmount: "",
    rateBps: "",
    minimumAmount: "",
    maximumAmount: "",
    effectiveFrom: currentDate(),
    effectiveTo: nextYearDate(),
  };
}
function normalizeAgreement(form: ReturnType<typeof defaultAgreement>) {
  return {
    channelPartnerId: form.channelPartnerId,
    agreementNumber: form.agreementNumber.trim(),
    calculationType: form.calculationType,
    fixedAmount: form.calculationType === "fixed" ? money(form.fixedAmount) : undefined,
    rateBps: form.calculationType === "rate" ? Number(form.rateBps) : undefined,
    minimumAmount: form.minimumAmount ? money(form.minimumAmount) : undefined,
    maximumAmount: form.maximumAmount ? money(form.maximumAmount) : undefined,
    effectiveFrom: form.effectiveFrom,
    effectiveTo: form.effectiveTo,
  };
}
function defaultEvaluation(role: PartnerRole) {
  return {
    modelId: role === "channel" ? "partner_channel" : "partner_vendor",
    qualification: "15",
    compliance: "15",
    stability: "10",
    special1: role === "channel" ? "20" : "15",
    special2: "15",
    special3: "15",
    special4: "10",
    special5: role === "channel" ? "0" : "5",
    disqualifiers: [] as string[],
  };
}
function ratingValues(role: PartnerRole, form: ReturnType<typeof defaultEvaluation>) {
  const common = {
    qualification: Number(form.qualification),
    compliance: Number(form.compliance),
    stability: Number(form.stability),
  };
  return role === "vendor"
    ? {
        ...common,
        authorization: Number(form.special1),
        delivery: Number(form.special2),
        qualityAfterSales: Number(form.special3),
        financialCapacity: Number(form.special4),
        cooperationHistory: Number(form.special5),
      }
    : {
        ...common,
        coverage: Number(form.special1),
        marketingCompliance: Number(form.special2),
        conversionQuality: Number(form.special3),
        cooperationHistory: Number(form.special4),
      };
}
function positiveMoney(value: string) {
  return /^\d+(?:\.\d{1,2})?$/.test(value) && Number(value) > 0;
}
function money(value: string) {
  return Number(value).toFixed(2);
}
function currentDate() {
  return new Date().toISOString().slice(0, 10);
}
function currentPeriod() {
  return currentDate().slice(0, 7);
}
function nextYearDate() {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString().slice(0, 10);
}
