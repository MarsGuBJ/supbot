import { useCallback, useMemo, useState, type FormEvent } from "react";
import { Banknote, CalendarClock, Landmark, ReceiptText, Scale, Search } from "lucide-react";
import {
  applyPayment,
  earlySettleContract,
  fetchContracts,
  fetchJournalEntries,
  fetchPayments,
  fetchReceivables,
  fetchSettlements,
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
import type { CommandReceipt, Session } from "../types";
import { formatDateTime, formatMoney, statusLabel, statusTone } from "../utils";

type View = "receivables" | "payments" | "journals" | "settlements";

export default function ReceivablesPaymentsPage({ session }: { session: Session }) {
  const loader = useCallback(
    async (signal: AbortSignal) => {
      const [contracts, receivables, payments, journals, settlements] = await Promise.all([
        fetchContracts(session, signal),
        fetchReceivables(session, signal),
        fetchPayments(session, signal),
        fetchJournalEntries(session, signal),
        fetchSettlements(session, signal),
      ]);
      return { contracts, receivables, payments, journals, settlements };
    },
    [session],
  );
  const { data, error, loading, reload } = useRemoteData(loader);
  const [view, setView] = useState<View>("receivables");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<"payment" | "settlement" | null>(null);
  const [contractId, setContractId] = useState("");
  const [amount, setAmount] = useState("");
  const [valueDate, setValueDate] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [penaltyFee, setPenaltyFee] = useState("0.00");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const [receipt, setReceipt] = useState<CommandReceipt | null>(null);
  const contractMap = useMemo(() => new Map((data?.contracts.items || []).map((item) => [item.id, item])), [data]);
  const activeContracts = useMemo(
    () => (data?.contracts.items || []).filter((item) => item.status === "active"),
    [data],
  );
  const outstanding = useMemo(
    () => (data?.receivables.items || []).reduce((sum, item) => sum + Number(item.outstanding), 0),
    [data],
  );
  const collected = useMemo(
    () =>
      (data?.payments.items || []).reduce((sum, item) => sum + Number(item.amount), 0) +
      (data?.settlements.items || []).reduce((sum, item) => sum + Number(item.amount), 0),
    [data],
  );
  const close = useCallback(() => {
    if (!submitting) setDialog(null);
  }, [submitting]);
  const open = (kind: "payment" | "settlement") => {
    const first = activeContracts[0];
    setContractId(first?.id || "");
    setAmount("");
    setPenaltyFee("0.00");
    setReference("");
    setSubmitError(null);
    setDialog(kind);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const contract = contractMap.get(contractId);
    if (!contract) {
      setSubmitError(new Error("请选择有效合同"));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const next =
        dialog === "payment"
          ? await applyPayment(
              session,
              { contractId, amount: Number(amount).toFixed(2), valueDate, externalReference: reference.trim() },
              newIdempotencyKey("payment"),
              contract.version,
            )
          : await earlySettleContract(
              session,
              {
                contractId,
                settlementDate: valueDate,
                penaltyFee: Number(penaltyFee || 0).toFixed(2),
                externalReference: reference.trim(),
              },
              newIdempotencyKey("settlement"),
              contract.version,
            );
      setReceipt(next);
      setDialog(null);
      reload();
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason : new Error("命令提交失败"));
    } finally {
      setSubmitting(false);
    }
  };
  const normalized = query.trim().toLocaleLowerCase();
  const contractLabel = (id: string) => contractMap.get(id)?.contractNumber || id;

  return (
    <div className="workspace">
      <PageHeader
        eyebrow="资金回收"
        title="应收与收款"
        meta={data ? `${data.receivables.total} 笔应收 · ${data.payments.total} 笔回款` : undefined}
        action={
          <div className="page-action-group">
            <button
              className="button secondary"
              type="button"
              onClick={() => open("settlement")}
              disabled={!activeContracts.length}
            >
              <Scale size={16} />
              提前结清
            </button>
            <button
              className="button primary"
              type="button"
              onClick={() => open("payment")}
              disabled={!activeContracts.length}
            >
              <Banknote size={16} />
              回款认领
            </button>
          </div>
        }
      />
      {receipt ? <CommandNotice receipt={receipt} onClose={() => setReceipt(null)} /> : null}
      {data ? (
        <section className="operations-strip" aria-label="回收指标">
          <div>
            <span>应收余额</span>
            <strong>{formatMoney(outstanding.toFixed(2))}</strong>
          </div>
          <div>
            <span>累计回收</span>
            <strong>{formatMoney(collected.toFixed(2))}</strong>
          </div>
          <div>
            <span>在执行合同</span>
            <strong>
              {activeContracts.length}
              <small>份</small>
            </strong>
          </div>
          <div>
            <span>平衡分录</span>
            <strong>
              {data.journals.total}
              <small>笔</small>
            </strong>
          </div>
        </section>
      ) : null}
      <div className="workspace-controls">
        <div className="segmented" aria-label="应收收款视图">
          {(["receivables", "payments", "journals", "settlements"] as View[]).map((item) => (
            <button type="button" key={item} aria-pressed={view === item} onClick={() => setView(item)}>
              {item === "receivables"
                ? "应收"
                : item === "payments"
                  ? "收款"
                  : item === "journals"
                    ? "会计分录"
                    : "结清"}
            </button>
          ))}
        </div>
        <label className="search-box">
          <Search size={16} />
          <span className="sr-only">搜索</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="合同号或业务编号" />
        </label>
      </div>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {!loading &&
        !error &&
        view === "receivables" &&
        (data?.receivables.items.length || 0 ? (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">应收列表</caption>
              <thead>
                <tr>
                  <th>合同 / 期次</th>
                  <th>到期日</th>
                  <th className="numeric">本金</th>
                  <th className="numeric">利息 / 费用 / 税</th>
                  <th className="numeric">余额</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {data?.receivables.items
                  .filter(
                    (item) => !normalized || contractLabel(item.contractId).toLocaleLowerCase().includes(normalized),
                  )
                  .map((item) => (
                    <tr key={item.id}>
                      <td>
                        <span className="primary-cell">
                          <CalendarClock size={16} />
                          {contractLabel(item.contractId)}
                        </span>
                        <small>第 {item.installmentNumber} 期</small>
                      </td>
                      <td>{item.dueDate}</td>
                      <td className="numeric">{formatMoney(item.principal)}</td>
                      <td className="numeric">
                        {formatMoney((Number(item.interest) + Number(item.fee) + Number(item.tax)).toFixed(2))}
                        <small>
                          息 {item.interest} / 费 {item.fee} / 税 {item.tax}
                        </small>
                      </td>
                      <td className="numeric strong">{formatMoney(item.outstanding)}</td>
                      <td>
                        <StatusBadge label={statusLabel(item.status)} tone={statusTone(item.status)} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="暂无应收" detail="投放审批完成后自动生成应收" />
        ))}
      {!loading &&
        !error &&
        view === "payments" &&
        (data?.payments.items.length || 0 ? (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">收款列表</caption>
              <thead>
                <tr>
                  <th>收款编号 / 合同</th>
                  <th>价值日</th>
                  <th className="numeric">到账</th>
                  <th className="numeric">已核销</th>
                  <th>状态</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {data?.payments.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <span className="primary-cell">
                        <Banknote size={16} />
                        {item.id}
                      </span>
                      <small>{contractLabel(item.contractId)}</small>
                    </td>
                    <td>{item.valueDate}</td>
                    <td className="numeric strong">{formatMoney(item.amount)}</td>
                    <td className="numeric">
                      {formatMoney(item.appliedAmount)}
                      <small>未核销 {formatMoney(item.unappliedAmount)}</small>
                    </td>
                    <td>
                      <StatusBadge label={statusLabel(item.status)} tone={statusTone(item.status)} />
                    </td>
                    <td>{formatDateTime(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="暂无收款" detail="银行到账后按合同认领并自动核销" />
        ))}
      {!loading &&
        !error &&
        view === "journals" &&
        (data?.journals.items.length || 0 ? (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">会计分录列表</caption>
              <thead>
                <tr>
                  <th>分录 / 来源</th>
                  <th>记账日</th>
                  <th className="numeric">借方</th>
                  <th className="numeric">贷方</th>
                  <th>平衡</th>
                </tr>
              </thead>
              <tbody>
                {data?.journals.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <span className="primary-cell">
                        <ReceiptText size={16} />
                        {item.id}
                      </span>
                      <small>
                        {item.sourceType} · {contractLabel(item.contractId)}
                      </small>
                    </td>
                    <td>{item.entryDate}</td>
                    <td className="numeric strong">{formatMoney(item.totalDebit)}</td>
                    <td className="numeric strong">{formatMoney(item.totalCredit)}</td>
                    <td>
                      <StatusBadge
                        label={item.totalDebit === item.totalCredit ? "已平衡" : "不平衡"}
                        tone={item.totalDebit === item.totalCredit ? "success" : "danger"}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="暂无分录" detail="投放、收款和结清将自动生成平衡分录" />
        ))}
      {!loading &&
        !error &&
        view === "settlements" &&
        (data?.settlements.items.length || 0 ? (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">提前结清列表</caption>
              <thead>
                <tr>
                  <th>结清编号 / 合同</th>
                  <th>结清日</th>
                  <th className="numeric">本金</th>
                  <th className="numeric">费用与税</th>
                  <th className="numeric">结清金额</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {data?.settlements.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <span className="primary-cell">
                        <Landmark size={16} />
                        {item.id}
                      </span>
                      <small>{contractLabel(item.contractId)}</small>
                    </td>
                    <td>{item.settlementDate}</td>
                    <td className="numeric">{formatMoney(item.principal)}</td>
                    <td className="numeric">
                      {formatMoney(
                        (
                          Number(item.accruedInterest) +
                          Number(item.accruedFee) +
                          Number(item.penaltyFee) +
                          Number(item.tax)
                        ).toFixed(2),
                      )}
                    </td>
                    <td className="numeric strong">{formatMoney(item.amount)}</td>
                    <td>
                      <StatusBadge label={statusLabel(item.status)} tone={statusTone(item.status)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="暂无提前结清" detail="结清金额由服务端依据未偿本金和到期费用计算" />
        ))}
      <Dialog
        open={dialog !== null}
        title={dialog === "payment" ? "回款认领" : "提前结清"}
        subtitle="操作使用当前合同版本并生成审计、事件和会计分录"
        submitting={submitting}
        submitLabel={dialog === "payment" ? "确认核销" : "执行结清"}
        error={submitError}
        onClose={close}
        onSubmit={submit}
      >
        <div className="form-grid">
          <Field label="合同" required span={2}>
            <select value={contractId} onChange={(event) => setContractId(event.target.value)}>
              <option value="">请选择</option>
              {activeContracts.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.contractNumber} · {formatMoney(item.principal)}
                </option>
              ))}
            </select>
          </Field>
          {dialog === "payment" ? (
            <Field label="到账金额（元）" required span={2}>
              <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
            </Field>
          ) : (
            <Field label="结清违约金（元）" required span={2}>
              <input inputMode="decimal" value={penaltyFee} onChange={(event) => setPenaltyFee(event.target.value)} />
            </Field>
          )}
          <Field label={dialog === "payment" ? "价值日" : "结清日"} required>
            <input type="date" value={valueDate} onChange={(event) => setValueDate(event.target.value)} />
          </Field>
          <Field label="银行流水引用" required>
            <input value={reference} onChange={(event) => setReference(event.target.value)} />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
