import { useCallback, useMemo, useState, type FormEvent } from "react";
import { AlertTriangle, ClipboardCheck, Gavel, Plus, RotateCcw, ShieldAlert, Truck, WalletCards } from "lucide-react";
import {
  changeRiskClassification,
  fetchAssetDispositions,
  fetchAssets,
  fetchCollectionActions,
  fetchContracts,
  fetchContractRestructures,
  fetchLegalCases,
  fetchOverdueAging,
  fetchPostLeaseInspections,
  fetchReceivableWriteOffs,
  fetchReceivables,
  fetchRiskClassifications,
  fetchRiskWarnings,
  newIdempotencyKey,
  openLegalCase,
  raiseRiskWarning,
  recordCollectionAction,
  recordPostLeaseInspection,
  requestAssetDisposition,
  requestContractRestructure,
  requestReceivableWriteOff,
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
  AssetDisposition,
  CollectionAction,
  CommandReceipt,
  ContractRestructure,
  LeaseAsset,
  LeaseContract,
  LegalCase,
  ListResponse,
  Receivable,
  ReceivableWriteOff,
  RiskClassification,
  RiskWarning,
  Session,
} from "../types";
import { formatDateTime, formatMoney, statusLabel, statusTone } from "../utils";

type View = "aging" | "inspections" | "risk" | "collections" | "recovery";
type Action =
  "inspection" | "warning" | "classification" | "collection" | "restructure" | "legal" | "disposition" | "writeoff";
type FormState = Record<string, string>;
interface PostLeaseData {
  warnings: ListResponse<RiskWarning>;
  classifications: ListResponse<RiskClassification>;
  actions: ListResponse<CollectionAction>;
  restructures: ListResponse<ContractRestructure>;
  legalCases: ListResponse<LegalCase>;
  dispositions: ListResponse<AssetDisposition>;
  writeOffs: ListResponse<ReceivableWriteOff>;
}

const today = () => new Date().toISOString().slice(0, 10);
const nextMonth = () => {
  const date = new Date();
  date.setMonth(date.getMonth() + 1);
  return date.toISOString().slice(0, 10);
};

export default function PostLeasePage({ session }: { session: Session }) {
  const loader = useCallback(
    async (signal: AbortSignal) => {
      const [
        contracts,
        assets,
        receivables,
        inspections,
        warnings,
        classifications,
        aging,
        actions,
        restructures,
        legalCases,
        dispositions,
        writeOffs,
      ] = await Promise.all([
        fetchContracts(session, signal),
        fetchAssets(session, signal),
        fetchReceivables(session, signal),
        fetchPostLeaseInspections(session, signal),
        fetchRiskWarnings(session, signal),
        fetchRiskClassifications(session, signal),
        fetchOverdueAging(session, signal),
        fetchCollectionActions(session, signal),
        fetchContractRestructures(session, signal),
        fetchLegalCases(session, signal),
        fetchAssetDispositions(session, signal),
        fetchReceivableWriteOffs(session, signal),
      ]);
      return {
        contracts,
        assets,
        receivables,
        inspections,
        warnings,
        classifications,
        aging,
        actions,
        restructures,
        legalCases,
        dispositions,
        writeOffs,
      };
    },
    [session],
  );
  const { data, error, loading, reload } = useRemoteData(loader);
  const [view, setView] = useState<View>("aging");
  const [action, setAction] = useState<Action | null>(null);
  const [form, setForm] = useState<FormState>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const [receipt, setReceipt] = useState<CommandReceipt | null>(null);
  const contracts = data?.contracts.items || [];
  const assets = data?.assets.items || [];
  const receivables = data?.receivables.items || [];
  const contractMap = useMemo(() => new Map(contracts.map((item) => [item.id, item])), [contracts]);
  const receivableMap = useMemo(() => new Map(receivables.map((item) => [item.id, item])), [receivables]);
  const assetMap = useMemo(() => new Map(assets.map((item) => [item.id, item])), [assets]);
  const overdueReceivableIds = useMemo(
    () => new Set((data?.aging.items || []).map((item) => item.receivableId)),
    [data?.aging.items],
  );
  const overdueOutstanding = (data?.aging.items || []).reduce((sum, item) => sum + Number(item.outstanding), 0);
  const contractLabel = (id: string) => contractMap.get(id)?.contractNumber || id;

  const openAction = (next: Action) => {
    const contract = contracts.find((item) => item.status === "active") || contracts[0];
    const overdue = data?.aging.items[0];
    const overdueReceivable = overdue ? receivableMap.get(overdue.receivableId) : undefined;
    const receivable =
      next === "collection"
        ? overdueReceivable
        : overdueReceivable || receivables.find((item) => Number(item.outstanding) > 0);
    const asset = assets.find((item) => item.status !== "disposed") || assets[0];
    const type = next === "collection" ? "phone" : next === "legal" ? "litigation" : "onsite";
    setForm({
      contractId: contract?.id || "",
      receivableId: receivable?.id || "",
      assetId: asset?.id || "",
      date: today(),
      nextDate: nextMonth(),
      amount: receivable?.outstanding || "0.00",
      rate: String(contract?.annualRateBps || 0),
      term: String(contract?.termMonths || 12),
      grace: "0",
      action: "repossess",
      severity: "high",
      classification: "special_mention",
      type,
      condition: "attention",
      promiseAmount: "0.00",
      proceeds: "0.00",
    });
    setSubmitError(null);
    setAction(next);
  };
  const update = (key: string, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const close = () => {
    if (!submitting) setAction(null);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!action) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const next = await submitAction(action, form, session, contractMap, receivableMap, assetMap);
      setReceipt(next);
      setAction(null);
      reload();
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason : new Error("命令提交失败"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="workspace">
      <PageHeader
        eyebrow="存续期运营"
        title="租后、催收与资产处置"
        meta={
          data
            ? `${data.aging.total} 笔逾期 · ${data.warnings.items.filter((item) => item.status === "open").length} 项预警`
            : undefined
        }
        action={
          <button
            className="button primary"
            type="button"
            onClick={() => openAction("inspection")}
            disabled={!contracts.length}
          >
            <Plus size={17} />
            记录检查
          </button>
        }
      />
      {receipt ? <CommandNotice receipt={receipt} onClose={() => setReceipt(null)} /> : null}
      {data ? (
        <section className="operations-strip" aria-label="租后运营指标">
          <div>
            <span>逾期余额</span>
            <strong>{formatMoney(overdueOutstanding.toFixed(2))}</strong>
          </div>
          <div>
            <span>逾期应收</span>
            <strong>
              {data.aging.total}
              <small>笔</small>
            </strong>
          </div>
          <div>
            <span>开放预警</span>
            <strong>
              {data.warnings.items.filter((item) => item.status === "open").length}
              <small>项</small>
            </strong>
          </div>
          <div>
            <span>法务案件</span>
            <strong>
              {data.legalCases.items.filter((item) => item.status === "open").length}
              <small>件</small>
            </strong>
          </div>
        </section>
      ) : null}
      <div className="workspace-controls">
        <div className="segmented" aria-label="租后视图">
          {(["aging", "inspections", "risk", "collections", "recovery"] as View[]).map((item) => (
            <button key={item} type="button" aria-pressed={view === item} onClick={() => setView(item)}>
              {viewLabel(item)}
            </button>
          ))}
        </div>
        <ActionButtons view={view} open={openAction} />
      </div>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {!loading &&
        !error &&
        view === "aging" &&
        (data?.aging.items.length ? (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">逾期账龄</caption>
              <thead>
                <tr>
                  <th>合同 / 应收</th>
                  <th>到期日</th>
                  <th className="numeric">逾期天数</th>
                  <th>账龄</th>
                  <th className="numeric">逾期余额</th>
                </tr>
              </thead>
              <tbody>
                {data.aging.items.map((item) => (
                  <tr key={item.receivableId}>
                    <td>
                      <span className="primary-cell">
                        <WalletCards size={16} />
                        {contractLabel(item.contractId)}
                      </span>
                      <small>{item.receivableId}</small>
                    </td>
                    <td>{item.dueDate}</td>
                    <td className="numeric strong">{item.daysOverdue}</td>
                    <td>
                      <StatusBadge
                        label={item.bucket}
                        tone={item.daysOverdue > 90 ? "danger" : item.daysOverdue > 30 ? "warning" : "info"}
                      />
                    </td>
                    <td className="numeric strong">{formatMoney(item.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="暂无逾期应收" detail="当前账龄快照无逾期余额" />
        ))}
      {!loading &&
        !error &&
        view === "inspections" &&
        (data?.inspections.items.length ? (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">租后检查</caption>
              <thead>
                <tr>
                  <th>合同 / 检查</th>
                  <th>检查日</th>
                  <th>方式</th>
                  <th>资产状态</th>
                  <th>风险信号</th>
                  <th>下次检查</th>
                </tr>
              </thead>
              <tbody>
                {data.inspections.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <span className="primary-cell">
                        <ClipboardCheck size={16} />
                        {contractLabel(item.contractId)}
                      </span>
                      <small>{item.findings}</small>
                    </td>
                    <td>{item.inspectionDate}</td>
                    <td>{item.inspectionType}</td>
                    <td>
                      <StatusBadge
                        label={item.assetCondition}
                        tone={item.assetCondition === "good" ? "success" : "warning"}
                      />
                    </td>
                    <td>{item.riskSignals.join("、") || "--"}</td>
                    <td>{item.nextDueDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="暂无租后检查" detail="记录现场、远程或物联网检查结果" />
        ))}
      {!loading && !error && view === "risk" && <RiskTables data={data!} contractLabel={contractLabel} />}
      {!loading && !error && view === "collections" && (
        <CollectionTables data={data!} contractLabel={contractLabel} receivableMap={receivableMap} />
      )}
      {!loading && !error && view === "recovery" && (
        <RecoveryTables data={data!} contractLabel={contractLabel} assetMap={assetMap} />
      )}
      <Dialog
        open={action !== null}
        title={action ? actionTitle(action) : ""}
        subtitle="提交后按权限与风险等级进入独立复核或直接记账"
        submitting={submitting}
        submitLabel="提交命令"
        error={submitError}
        onClose={close}
        onSubmit={submit}
      >
        <ActionForm
          action={action}
          form={form}
          update={update}
          contracts={contracts}
          receivables={receivables}
          overdueReceivableIds={overdueReceivableIds}
          assets={assets}
        />
      </Dialog>
    </div>
  );
}

function ActionButtons({ view, open }: { view: View; open: (action: Action) => void }) {
  const actions: Record<View, Array<[Action, string]>> = {
    aging: [["collection", "记录催收"]],
    inspections: [["inspection", "记录检查"]],
    risk: [
      ["warning", "新增预警"],
      ["classification", "调整分类"],
    ],
    collections: [
      ["collection", "记录催收"],
      ["restructure", "申请重组"],
    ],
    recovery: [
      ["legal", "立法务案件"],
      ["disposition", "资产处置"],
      ["writeoff", "申请核销"],
    ],
  };
  return (
    <div className="page-action-group">
      {actions[view].map(([kind, label]) => (
        <button className="button secondary compact" type="button" key={kind} onClick={() => open(kind)}>
          {kind === "legal" ? (
            <Gavel size={15} />
          ) : kind === "disposition" ? (
            <Truck size={15} />
          ) : kind === "restructure" ? (
            <RotateCcw size={15} />
          ) : kind === "warning" || kind === "writeoff" ? (
            <ShieldAlert size={15} />
          ) : (
            <Plus size={15} />
          )}
          {label}
        </button>
      ))}
    </div>
  );
}

function RiskTables({ data, contractLabel }: { data: PostLeaseData; contractLabel: (id: string) => string }) {
  return (
    <>
      {data.warnings.items.length ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">风险预警</caption>
            <thead>
              <tr>
                <th>合同 / 信号</th>
                <th>等级</th>
                <th>摘要</th>
                <th>状态</th>
                <th>发生时间</th>
              </tr>
            </thead>
            <tbody>
              {data.warnings.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className="primary-cell">
                      <AlertTriangle size={16} />
                      {contractLabel(item.contractId)}
                    </span>
                    <small>{item.signalCode}</small>
                  </td>
                  <td>
                    <StatusBadge
                      label={item.severity}
                      tone={item.severity === "critical" || item.severity === "high" ? "danger" : "warning"}
                    />
                  </td>
                  <td>{item.summary}</td>
                  <td>
                    <StatusBadge label={statusLabel(item.status)} tone={statusTone(item.status)} />
                  </td>
                  <td>{formatDateTime(item.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data.classifications.items.length ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">五级分类</caption>
            <thead>
              <tr>
                <th>合同</th>
                <th>分类</th>
                <th>生效日</th>
                <th>理由</th>
                <th>审批状态</th>
              </tr>
            </thead>
            <tbody>
              {data.classifications.items.map((item) => (
                <tr key={item.id}>
                  <td>{contractLabel(item.contractId)}</td>
                  <td className="strong">{item.classification}</td>
                  <td>{item.effectiveDate}</td>
                  <td>{item.reason}</td>
                  <td>
                    <StatusBadge label={statusLabel(item.status)} tone={statusTone(item.status)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {!data.warnings.items.length && !data.classifications.items.length ? (
        <EmptyState title="暂无风险记录" detail="当前组合尚无预警或分类调整" />
      ) : null}
    </>
  );
}

function CollectionTables({
  data,
  contractLabel,
  receivableMap,
}: {
  data: PostLeaseData;
  contractLabel: (id: string) => string;
  receivableMap: Map<string, Receivable>;
}) {
  return (
    <>
      {data.actions.items.length ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">催收行动</caption>
            <thead>
              <tr>
                <th>合同 / 应收</th>
                <th>行动</th>
                <th>结果</th>
                <th className="numeric">承诺金额</th>
                <th>发生时间</th>
              </tr>
            </thead>
            <tbody>
              {data.actions.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    {contractLabel(item.contractId)}
                    <small>{receivableMap.get(item.receivableId)?.dueDate || item.receivableId}</small>
                  </td>
                  <td>{item.actionType}</td>
                  <td>{item.outcome}</td>
                  <td className="numeric">{formatMoney(item.promiseAmount)}</td>
                  <td>{formatDateTime(item.occurredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data.restructures.items.length ? (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">合同重组</caption>
            <thead>
              <tr>
                <th>合同</th>
                <th>生效日</th>
                <th>新期限 / 利率</th>
                <th className="numeric">资本化金额</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {data.restructures.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    {contractLabel(item.contractId)}
                    <small>{item.reason}</small>
                  </td>
                  <td>{item.effectiveDate}</td>
                  <td>
                    {item.newTermMonths} 月 / {(item.newAnnualRateBps / 100).toFixed(2)}%
                  </td>
                  <td className="numeric">{formatMoney(item.capitalizedAmount)}</td>
                  <td>
                    <StatusBadge label={statusLabel(item.status)} tone={statusTone(item.status)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {!data.actions.items.length && !data.restructures.items.length ? (
        <EmptyState title="暂无催收与重组记录" detail="逾期行动和重组申请将在此归档" />
      ) : null}
    </>
  );
}

function RecoveryTables({
  data,
  contractLabel,
  assetMap,
}: {
  data: PostLeaseData;
  contractLabel: (id: string) => string;
  assetMap: Map<string, LeaseAsset>;
}) {
  const rows = [
    ...data.legalCases.items.map((item) => ({
      id: item.id,
      contractId: item.contractId,
      type: `法务 · ${item.caseType}`,
      subject: item.externalCaseNumber || item.court || item.summary,
      amount: item.claimAmount,
      status: item.status,
      time: item.createdAt,
    })),
    ...data.dispositions.items.map((item) => ({
      id: item.id,
      contractId: item.contractId,
      type: `资产 · ${item.action}`,
      subject: assetMap.get(item.assetId)?.name || item.assetId,
      amount: item.expectedProceeds,
      status: item.status,
      time: item.createdAt,
    })),
    ...data.writeOffs.items.map((item) => ({
      id: item.id,
      contractId: item.contractId,
      type: "应收核销",
      subject: item.receivableId,
      amount: item.amount,
      status: item.status,
      time: item.createdAt,
    })),
  ];
  return rows.length ? (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">法务与处置</caption>
        <thead>
          <tr>
            <th>合同 / 类型</th>
            <th>标的</th>
            <th className="numeric">金额</th>
            <th>状态</th>
            <th>创建时间</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => (
            <tr key={item.id}>
              <td>
                <span className="primary-cell">
                  <Gavel size={16} />
                  {contractLabel(item.contractId)}
                </span>
                <small>{item.type}</small>
              </td>
              <td>{item.subject}</td>
              <td className="numeric strong">{formatMoney(item.amount)}</td>
              <td>
                <StatusBadge label={statusLabel(item.status)} tone={statusTone(item.status)} />
              </td>
              <td>{formatDateTime(item.time)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <EmptyState title="暂无法务与处置记录" detail="法务立案、资产取回、处置和核销将在此归档" />
  );
}

function ActionForm({
  action,
  form,
  update,
  contracts,
  receivables,
  overdueReceivableIds,
  assets,
}: {
  action: Action | null;
  form: FormState;
  update: (key: string, value: string) => void;
  contracts: LeaseContract[];
  receivables: Receivable[];
  overdueReceivableIds: ReadonlySet<string>;
  assets: LeaseAsset[];
}) {
  if (!action) return null;
  const contractSelect = (
    <Field label="合同" required span={2}>
      <select value={form.contractId || ""} onChange={(event) => update("contractId", event.target.value)}>
        <option value="">请选择</option>
        {contracts
          .filter((item) => item.status === "active")
          .map((item) => (
            <option key={item.id} value={item.id}>
              {item.contractNumber}
            </option>
          ))}
      </select>
    </Field>
  );
  const reason = (
    <Field label="原因 / 说明" required span={2}>
      <textarea rows={3} value={form.reason || ""} onChange={(event) => update("reason", event.target.value)} />
    </Field>
  );
  if (action === "inspection")
    return (
      <div className="form-grid">
        {contractSelect}
        <Field label="检查日期" required>
          <input type="date" value={form.date || ""} onChange={(event) => update("date", event.target.value)} />
        </Field>
        <Field label="检查方式" required>
          <select value={form.type} onChange={(event) => update("type", event.target.value)}>
            <option value="onsite">现场</option>
            <option value="remote">远程</option>
            <option value="iot">物联网</option>
          </select>
        </Field>
        <Field label="资产状态" required>
          <select value={form.condition} onChange={(event) => update("condition", event.target.value)}>
            <option value="good">正常</option>
            <option value="attention">关注</option>
            <option value="impaired">受损</option>
            <option value="missing">失联</option>
          </select>
        </Field>
        <Field label="下次检查" required>
          <input type="date" value={form.nextDate || ""} onChange={(event) => update("nextDate", event.target.value)} />
        </Field>
        <Field label="检查结论" required span={2}>
          <textarea rows={3} value={form.reason || ""} onChange={(event) => update("reason", event.target.value)} />
        </Field>
        <Field label="风险信号（逗号分隔）" span={2}>
          <input value={form.signals || ""} onChange={(event) => update("signals", event.target.value)} />
        </Field>
      </div>
    );
  if (action === "warning")
    return (
      <div className="form-grid">
        {contractSelect}
        <Field label="信号代码" required>
          <input value={form.code || ""} onChange={(event) => update("code", event.target.value)} />
        </Field>
        <Field label="等级" required>
          <select value={form.severity} onChange={(event) => update("severity", event.target.value)}>
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
            <option value="critical">重大</option>
          </select>
        </Field>
        <Field label="预警摘要" required span={2}>
          <textarea rows={3} value={form.reason || ""} onChange={(event) => update("reason", event.target.value)} />
        </Field>
        <Field label="证据引用" span={2}>
          <input value={form.evidence || ""} onChange={(event) => update("evidence", event.target.value)} />
        </Field>
      </div>
    );
  if (action === "classification")
    return (
      <div className="form-grid">
        {contractSelect}
        <Field label="五级分类" required>
          <select value={form.classification} onChange={(event) => update("classification", event.target.value)}>
            <option value="normal">正常</option>
            <option value="special_mention">关注</option>
            <option value="substandard">次级</option>
            <option value="doubtful">可疑</option>
            <option value="loss">损失</option>
          </select>
        </Field>
        <Field label="生效日" required>
          <input type="date" value={form.date || ""} onChange={(event) => update("date", event.target.value)} />
        </Field>
        {reason}
      </div>
    );
  if (action === "collection")
    return (
      <div className="form-grid">
        <Field label="逾期应收" required span={2}>
          <select value={form.receivableId || ""} onChange={(event) => update("receivableId", event.target.value)}>
            <option value="">请选择</option>
            {receivables
              .filter((item) => overdueReceivableIds.has(item.id))
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.contractId} · {item.dueDate} · {item.outstanding}
                </option>
              ))}
          </select>
        </Field>
        <Field label="行动方式" required>
          <select value={form.type || "phone"} onChange={(event) => update("type", event.target.value)}>
            <option value="phone">电话</option>
            <option value="message">消息</option>
            <option value="letter">函件</option>
            <option value="visit">外访</option>
            <option value="promise">承诺</option>
            <option value="demand">催告</option>
          </select>
        </Field>
        <Field label="联系人">
          <input value={form.contact || ""} onChange={(event) => update("contact", event.target.value)} />
        </Field>
        <Field label="承诺日期">
          <input type="date" value={form.nextDate || ""} onChange={(event) => update("nextDate", event.target.value)} />
        </Field>
        <Field label="承诺金额">
          <input
            inputMode="decimal"
            value={form.promiseAmount || "0.00"}
            onChange={(event) => update("promiseAmount", event.target.value)}
          />
        </Field>
        {reason}
      </div>
    );
  if (action === "restructure")
    return (
      <div className="form-grid">
        {contractSelect}
        <Field label="生效日" required>
          <input type="date" value={form.date || ""} onChange={(event) => update("date", event.target.value)} />
        </Field>
        <Field label="新期限（月）" required>
          <input type="number" value={form.term || ""} onChange={(event) => update("term", event.target.value)} />
        </Field>
        <Field label="新年利率（基点）" required>
          <input type="number" value={form.rate || ""} onChange={(event) => update("rate", event.target.value)} />
        </Field>
        <Field label="宽限期（月）">
          <input type="number" value={form.grace || "0"} onChange={(event) => update("grace", event.target.value)} />
        </Field>
        <Field label="资本化金额" span={2}>
          <input
            inputMode="decimal"
            value={form.amount || "0.00"}
            onChange={(event) => update("amount", event.target.value)}
          />
        </Field>
        {reason}
      </div>
    );
  if (action === "legal")
    return (
      <div className="form-grid">
        {contractSelect}
        <Field label="案件类型" required>
          <select value={form.type || "litigation"} onChange={(event) => update("type", event.target.value)}>
            <option value="litigation">诉讼</option>
            <option value="arbitration">仲裁</option>
            <option value="enforcement">执行</option>
            <option value="bankruptcy">破产</option>
          </select>
        </Field>
        <Field label="主张金额" required>
          <input
            inputMode="decimal"
            value={form.amount || ""}
            onChange={(event) => update("amount", event.target.value)}
          />
        </Field>
        <Field label="法院 / 机构">
          <input value={form.court || ""} onChange={(event) => update("court", event.target.value)} />
        </Field>
        <Field label="外部案号">
          <input value={form.reference || ""} onChange={(event) => update("reference", event.target.value)} />
        </Field>
        {reason}
      </div>
    );
  if (action === "disposition")
    return (
      <div className="form-grid">
        <Field label="租赁物" required span={2}>
          <select value={form.assetId || ""} onChange={(event) => update("assetId", event.target.value)}>
            <option value="">请选择</option>
            {assets
              .filter((item) => item.status !== "disposed")
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.uniqueNumber}
                </option>
              ))}
          </select>
        </Field>
        <Field label="处置动作" required>
          <select value={form.action || "repossess"} onChange={(event) => update("action", event.target.value)}>
            <option value="repossess">取回</option>
            <option value="dispose">处置</option>
          </select>
        </Field>
        <Field label="预计回收">
          <input
            inputMode="decimal"
            value={form.proceeds || "0.00"}
            onChange={(event) => update("proceeds", event.target.value)}
          />
        </Field>
        <Field label="交易对手">
          <input value={form.counterparty || ""} onChange={(event) => update("counterparty", event.target.value)} />
        </Field>
        <Field label="证据引用" required>
          <input value={form.evidence || ""} onChange={(event) => update("evidence", event.target.value)} />
        </Field>
        {reason}
      </div>
    );
  return (
    <div className="form-grid">
      <Field label="待核销应收" required span={2}>
        <select
          value={form.receivableId || ""}
          onChange={(event) => {
            const item = receivables.find((candidate) => candidate.id === event.target.value);
            update("receivableId", event.target.value);
            if (item) update("amount", item.outstanding);
          }}
        >
          <option value="">请选择</option>
          {receivables
            .filter((item) => Number(item.outstanding) > 0)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.contractId} · {item.dueDate} · {item.outstanding}
              </option>
            ))}
        </select>
      </Field>
      <Field label="核销金额" required>
        <input readOnly value={form.amount || ""} />
      </Field>
      <Field label="证据引用" required>
        <input value={form.evidence || ""} onChange={(event) => update("evidence", event.target.value)} />
      </Field>
      {reason}
    </div>
  );
}

async function submitAction(
  action: Action,
  form: FormState,
  session: Session,
  contracts: Map<string, LeaseContract>,
  receivables: Map<string, Receivable>,
  assets: Map<string, LeaseAsset>,
) {
  const contract = contracts.get(form.contractId);
  const receivable = receivables.get(form.receivableId);
  const asset = assets.get(form.assetId);
  switch (action) {
    case "inspection":
      if (!contract) throw new Error("请选择有效合同");
      return recordPostLeaseInspection(
        session,
        {
          contractId: contract.id,
          inspectionDate: form.date,
          inspectionType: form.type,
          assetCondition: form.condition,
          findings: form.reason,
          riskSignals: (form.signals || "")
            .split(/[,，]/)
            .map((item) => item.trim())
            .filter(Boolean),
          nextDueDate: form.nextDate,
        },
        newIdempotencyKey("inspection"),
        contract.version,
      );
    case "warning":
      if (!contract) throw new Error("请选择有效合同");
      return raiseRiskWarning(
        session,
        {
          contractId: contract.id,
          signalCode: form.code,
          severity: form.severity,
          summary: form.reason,
          evidenceRef: form.evidence,
        },
        newIdempotencyKey("warning"),
        contract.version,
      );
    case "classification":
      if (!contract) throw new Error("请选择有效合同");
      return changeRiskClassification(
        session,
        { contractId: contract.id, classification: form.classification, effectiveDate: form.date, reason: form.reason },
        newIdempotencyKey("classification"),
        contract.version,
      );
    case "collection":
      if (!receivable) throw new Error("请选择有效应收");
      return recordCollectionAction(
        session,
        {
          receivableId: receivable.id,
          actionType: form.type,
          occurredAt: new Date().toISOString(),
          contactName: form.contact,
          outcome: form.reason,
          promiseDate: form.nextDate,
          promiseAmount: money(form.promiseAmount),
          notes: "",
        },
        newIdempotencyKey("collection"),
        receivable.version,
      );
    case "restructure":
      if (!contract) throw new Error("请选择有效合同");
      return requestContractRestructure(
        session,
        {
          contractId: contract.id,
          reason: form.reason,
          effectiveDate: form.date,
          newTermMonths: Number(form.term),
          newAnnualRateBps: Number(form.rate),
          gracePeriodMonths: Number(form.grace),
          capitalizedAmount: money(form.amount),
        },
        newIdempotencyKey("restructure"),
        contract.version,
      );
    case "legal":
      if (!contract) throw new Error("请选择有效合同");
      return openLegalCase(
        session,
        {
          contractId: contract.id,
          caseType: form.type || "litigation",
          court: form.court,
          externalCaseNumber: form.reference,
          claimAmount: money(form.amount),
          summary: form.reason,
        },
        newIdempotencyKey("legal"),
        contract.version,
      );
    case "disposition":
      if (!asset) throw new Error("请选择有效租赁物");
      return requestAssetDisposition(
        session,
        {
          assetId: asset.id,
          action: form.action,
          reason: form.reason,
          counterparty: form.counterparty,
          expectedProceeds: money(form.proceeds),
          evidenceRef: form.evidence,
        },
        newIdempotencyKey("disposition"),
        asset.version,
      );
    case "writeoff":
      if (!receivable) throw new Error("请选择有效应收");
      return requestReceivableWriteOff(
        session,
        {
          receivableId: receivable.id,
          amount: receivable.outstanding,
          reason: form.reason,
          evidenceRef: form.evidence,
        },
        newIdempotencyKey("writeoff"),
        receivable.version,
      );
  }
}

function money(value: string) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toFixed(2) : "0.00";
}
function viewLabel(view: View) {
  return {
    aging: "逾期账龄",
    inspections: "租后检查",
    risk: "风险分类",
    collections: "催收重组",
    recovery: "法务处置",
  }[view];
}
function actionTitle(action: Action) {
  return {
    inspection: "记录租后检查",
    warning: "新增风险预警",
    classification: "调整五级分类",
    collection: "记录催收行动",
    restructure: "申请合同重组",
    legal: "建立法务案件",
    disposition: "申请资产取回或处置",
    writeoff: "申请应收核销",
  }[action];
}
