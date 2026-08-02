import { useCallback } from "react";
import {
  ArrowRight,
  BriefcaseBusiness,
  CircleDollarSign,
  ClipboardCheck,
  FileText,
  Landmark,
  Receipt,
  UsersRound,
} from "lucide-react";
import { fetchDashboard } from "../api";
import { ErrorState, LoadingState, PageHeader } from "../components/Workspace";
import { useRemoteData } from "../hooks/useRemoteData";
import type { Session, WorkspaceKey } from "../types";
import { formatCompactMoney, formatMoney } from "../utils";

export default function DashboardPage({
  session,
  onNavigate,
}: {
  session: Session;
  onNavigate: (workspace: WorkspaceKey) => void;
}) {
  const loader = useCallback((signal: AbortSignal) => fetchDashboard(session, signal), [session]);
  const { data, error, loading, reload } = useRemoteData(loader);

  return (
    <div className="workspace">
      <PageHeader eyebrow="经营总览" title="融资租赁运营台" meta="当前组织 · 人民币口径" />
      {loading ? <LoadingState rows={4} /> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {data && !loading ? (
        <>
          <section className="metric-grid" aria-label="核心指标">
            <Metric icon={<UsersRound />} label="客户总数" value={String(data.counts.customers)} unit="户" tone="ink" />
            <Metric
              icon={<BriefcaseBusiness />}
              label="租赁项目"
              value={String(data.counts.projects)}
              unit="项"
              tone="blue"
            />
            <Metric
              icon={<ClipboardCheck />}
              label="授信申请"
              value={String(data.counts.creditApplications)}
              unit="笔"
              tone="amber"
            />
            <Metric
              icon={<Landmark />}
              label="项目申请金额"
              value={formatCompactMoney(data.projectAmounts.requestedTotal)}
              fullValue={formatMoney(data.projectAmounts.requestedTotal)}
              tone="green"
            />
            <Metric
              icon={<CircleDollarSign />}
              label="授信申请额度"
              value={formatCompactMoney(data.creditAmounts.requestedLimitTotal)}
              fullValue={formatMoney(data.creditAmounts.requestedLimitTotal)}
              tone="red"
            />
            <Metric
              icon={<FileText />}
              label="租赁合同"
              value={String(data.counts.contracts ?? 0)}
              unit="份"
              tone="blue"
            />
            <Metric
              icon={<Receipt />}
              label="应收余额"
              value={formatCompactMoney(data.portfolioAmounts?.receivableOutstanding ?? "0.00")}
              fullValue={formatMoney(data.portfolioAmounts?.receivableOutstanding ?? "0.00")}
              tone="amber"
            />
            <Metric
              icon={<CircleDollarSign />}
              label="累计回收"
              value={formatCompactMoney(data.portfolioAmounts?.cashCollectedTotal ?? "0.00")}
              fullValue={formatMoney(data.portfolioAmounts?.cashCollectedTotal ?? "0.00")}
              tone="green"
            />
          </section>

          <section className="dashboard-band">
            <div className="section-heading">
              <div>
                <span className="eyebrow">工作队列</span>
                <h2>业务入口</h2>
              </div>
              <span className="section-meta">{data.counts.projects + data.counts.creditApplications} 项在册业务</span>
            </div>
            <div className="queue-list">
              <QueueRow
                icon={<UsersRound size={18} />}
                label="客户管理"
                value={`${data.counts.customers} 户`}
                detail="客户主档"
                onClick={() => onNavigate("customers")}
              />
              <QueueRow
                icon={<BriefcaseBusiness size={18} />}
                label="项目管理"
                value={`${data.counts.projects} 项`}
                detail={formatMoney(data.projectAmounts.requestedTotal)}
                onClick={() => onNavigate("projects")}
              />
              <QueueRow
                icon={<ClipboardCheck size={18} />}
                label="授信申请"
                value={`${data.counts.creditApplications} 笔`}
                detail={formatMoney(data.creditAmounts.requestedLimitTotal)}
                onClick={() => onNavigate("credit")}
              />
              <QueueRow
                icon={<FileText size={18} />}
                label="合同与资产"
                value={`${data.counts.contracts ?? 0} 份`}
                detail={formatMoney(data.portfolioAmounts?.contractPrincipalTotal ?? "0.00")}
                onClick={() => onNavigate("contracts-assets")}
              />
              <QueueRow
                icon={<Receipt size={18} />}
                label="应收与收款"
                value={`${data.counts.openReceivables ?? 0} 笔待收`}
                detail={formatMoney(data.portfolioAmounts?.receivableOutstanding ?? "0.00")}
                onClick={() => onNavigate("receivables-payments")}
              />
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  unit,
  fullValue,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  unit?: string;
  fullValue?: string;
  tone: string;
}) {
  return (
    <article className={`metric ${tone}`} title={fullValue}>
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>
        {value}
        {unit ? <small>{unit}</small> : null}
      </strong>
    </article>
  );
}

function QueueRow({
  icon,
  label,
  value,
  detail,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button className="queue-row" type="button" onClick={onClick}>
      <span className="queue-icon">{icon}</span>
      <span className="queue-label">{label}</span>
      <strong>{value}</strong>
      <span>{detail}</span>
      <ArrowRight size={17} />
    </button>
  );
}
