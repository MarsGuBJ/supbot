import { useCallback, useMemo, useState, type FormEvent } from "react";
import { Banknote, Boxes, Eye, FileKey2, Landmark, Search, ShieldCheck } from "lucide-react";
import {
  fetchAssets,
  fetchAssetComplianceSummary,
  fetchContracts,
  fetchDepositAccounts,
  fetchDisbursements,
  fetchProjects,
  newIdempotencyKey,
  recordDepositCollection,
  requestDisbursement,
  verifyAssetOwnership,
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
import { AssetWorkspaceDialog } from "../components/AssetWorkspaceDialog";
import { useRemoteData } from "../hooks/useRemoteData";
import { canRecordLeasingDeposit } from "../permissions";
import type { CommandReceipt, DepositAccount, LeaseAsset, LeaseContract, Session } from "../types";
import { formatDateTime, formatMoney, leaseTypeLabel, statusLabel, statusTone } from "../utils";

type View = "contracts" | "assets" | "disbursements";
type DialogKind = "ownership" | "disbursement" | "deposit" | null;

interface Props {
  session: Session;
  onOpenPricing: () => void;
}

const EMPTY_ASSET_COMPLIANCE_SUMMARY = {
  total: 0,
  pendingAcceptance: 0,
  missingRegistration: 0,
  missingInsurance: 0,
  insuranceExpiring: 0,
  valuationDue: 0,
  residualAtRisk: 0,
};

async function loadAssetComplianceSummary(session: Session, signal: AbortSignal) {
  try {
    return await fetchAssetComplianceSummary(session, signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    return EMPTY_ASSET_COMPLIANCE_SUMMARY;
  }
}

export default function ContractsAssetsPage({ session, onOpenPricing }: Props) {
  const loader = useCallback(
    async (signal: AbortSignal) => {
      const [contracts, assets, disbursements, projects, depositAccounts, compliance] = await Promise.all([
        fetchContracts(session, signal),
        fetchAssets(session, signal),
        fetchDisbursements(session, signal),
        fetchProjects(session, signal),
        fetchDepositAccounts(session, signal),
        loadAssetComplianceSummary(session, signal),
      ]);
      return { contracts, assets, disbursements, projects, depositAccounts, compliance };
    },
    [session],
  );
  const { data, error, loading, reload } = useRemoteData(loader);
  const [view, setView] = useState<View>("contracts");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [selectedAsset, setSelectedAsset] = useState<LeaseAsset | null>(null);
  const [detailAsset, setDetailAsset] = useState<LeaseAsset | null>(null);
  const [selectedContract, setSelectedContract] = useState<LeaseContract | null>(null);
  const [selectedDepositAccount, setSelectedDepositAccount] = useState<DepositAccount | null>(null);
  const [evidenceReference, setEvidenceReference] = useState("");
  const [payeeName, setPayeeName] = useState("");
  const [bankAccountRef, setBankAccountRef] = useState("");
  const [depositAmount, setDepositAmount] = useState("");
  const [depositValueDate, setDepositValueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [depositExternalReference, setDepositExternalReference] = useState("");
  const [validationError, setValidationError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const [receipt, setReceipt] = useState<CommandReceipt | null>(null);
  const projectMap = useMemo(() => new Map((data?.projects.items || []).map((item) => [item.id, item])), [data]);
  const contractMap = useMemo(() => new Map((data?.contracts.items || []).map((item) => [item.id, item])), [data]);
  const depositMap = useMemo(
    () => new Map((data?.depositAccounts.items || []).map((item) => [item.contractId, item])),
    [data],
  );
  const canRecordDeposit = session.mode === "dev-headers" && canRecordLeasingDeposit(session.roleIds);

  const closeDialog = useCallback(() => {
    if (!submitting) setDialog(null);
  }, [submitting]);
  const openOwnership = (asset: LeaseAsset) => {
    setSelectedAsset(asset);
    setEvidenceReference(asset.ownershipEvidenceRef || "");
    setValidationError("");
    setSubmitError(null);
    setDialog("ownership");
  };
  const openDisbursement = (contract: LeaseContract) => {
    setSelectedContract(contract);
    setPayeeName("");
    setBankAccountRef("");
    setValidationError("");
    setSubmitError(null);
    setDialog("disbursement");
  };
  const openDeposit = (contract: LeaseContract, account: DepositAccount) => {
    setSelectedContract(contract);
    setSelectedDepositAccount(account);
    setDepositAmount(account.availableAmount);
    setDepositValueDate(new Date().toISOString().slice(0, 10));
    setDepositExternalReference("");
    setValidationError("");
    setSubmitError(null);
    setDialog("deposit");
  };
  const finish = (nextReceipt: CommandReceipt) => {
    setReceipt(nextReceipt);
    setDialog(null);
    reload();
  };

  const submitOwnership = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedAsset || !evidenceReference.trim()) {
      setValidationError("请输入权属证据引用");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      finish(
        await verifyAssetOwnership(
          session,
          selectedAsset.id,
          evidenceReference.trim(),
          newIdempotencyKey("ownership"),
          selectedAsset.version,
        ),
      );
    } catch (reason) {
      setSubmitError(asError(reason, "权属核验提交失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const submitDisbursement = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedContract || !payeeName.trim() || !bankAccountRef.trim()) {
      setValidationError("请填写收款方和银行账户引用");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      finish(
        await requestDisbursement(
          session,
          {
            contractId: selectedContract.id,
            amount: selectedContract.principal,
            payeeName: payeeName.trim(),
            bankAccountRef: bankAccountRef.trim(),
            conditionChecks: ["contract_approved", "asset_ready", "payee_verified"],
          },
          newIdempotencyKey("disbursement"),
          selectedContract.version,
        ),
      );
    } catch (reason) {
      setSubmitError(asError(reason, "投放申请失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const submitDeposit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !selectedContract ||
      !selectedDepositAccount ||
      !depositAmount.trim() ||
      !depositValueDate ||
      !depositExternalReference.trim()
    ) {
      setValidationError("请填写实收金额、到账日期和外部流水号");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      finish(
        await recordDepositCollection(
          session,
          {
            contractId: selectedContract.id,
            amount: depositAmount.trim(),
            valueDate: depositValueDate,
            externalReference: depositExternalReference.trim(),
          },
          newIdempotencyKey("deposit"),
          selectedDepositAccount.version,
        ),
      );
    } catch (reason) {
      setSubmitError(asError(reason, "保证金实收登记失败"));
    } finally {
      setSubmitting(false);
    }
  };

  const normalized = query.trim().toLocaleLowerCase();
  const visibleContracts = (data?.contracts.items || []).filter(
    (item) =>
      !normalized ||
      [item.contractNumber, projectMap.get(item.projectId)?.name || "", item.status].some((value) =>
        value.toLocaleLowerCase().includes(normalized),
      ),
  );
  const visibleAssets = (data?.assets.items || []).filter(
    (item) =>
      !normalized ||
      [item.name, item.uniqueNumber, item.serialNumber || "", item.vin || ""].some((value) =>
        value.toLocaleLowerCase().includes(normalized),
      ),
  );

  return (
    <div className="workspace">
      <PageHeader
        eyebrow="核心交易"
        title="合同与资产"
        meta={data ? `${data.contracts.total} 份合同 · ${data.assets.total} 项租赁物` : undefined}
        action={
          <button className="button primary" type="button" onClick={onOpenPricing}>
            <FileKey2 size={17} />
            从定价报价创建
          </button>
        }
      />
      {receipt ? <CommandNotice receipt={receipt} onClose={() => setReceipt(null)} /> : null}
      <div className="workspace-controls">
        <div className="segmented" aria-label="合同资产视图">
          {(["contracts", "assets", "disbursements"] as View[]).map((item) => (
            <button type="button" key={item} aria-pressed={view === item} onClick={() => setView(item)}>
              {item === "contracts" ? "合同" : item === "assets" ? "租赁物" : "投放"}
            </button>
          ))}
        </div>
        <label className="search-box">
          <Search size={16} />
          <span className="sr-only">搜索</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="合同号、项目或租赁物" />
        </label>
      </div>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {!loading &&
        !error &&
        view === "contracts" &&
        (visibleContracts.length ? (
          <ContractsTable
            contracts={visibleContracts}
            projectMap={projectMap}
            depositMap={depositMap}
            canRecordDeposit={canRecordDeposit}
            onDeposit={openDeposit}
            onDisbursement={openDisbursement}
          />
        ) : (
          <EmptyState title="暂无合同" detail="请先在产品与定价工作台将报价定稿并创建合同" />
        ))}
      {!loading && !error && view === "assets" && data ? (
        <>
          <ComplianceQueue summary={data.compliance} />
          {visibleAssets.length ? (
            <AssetsTable
              assets={visibleAssets}
              contractMap={contractMap}
              onVerify={openOwnership}
              onOpen={setDetailAsset}
            />
          ) : (
            <EmptyState title="暂无租赁物" detail="租赁物随报价生成合同一并登记" />
          )}
        </>
      ) : null}
      {!loading &&
        !error &&
        view === "disbursements" &&
        (data?.disbursements.items.length || 0 ? (
          <DisbursementsTable items={data?.disbursements.items || []} contractMap={contractMap} />
        ) : (
          <EmptyState title="暂无投放" detail="合同、权属和保证金条件满足后可发起投放" />
        ))}

      <Dialog
        open={dialog === "ownership"}
        title="发起权属核验"
        subtitle={selectedAsset ? `${selectedAsset.name} · ${selectedAsset.uniqueNumber}` : "售后回租租赁物"}
        submitting={submitting}
        submitLabel="进入双人复核"
        error={submitError}
        onClose={closeDialog}
        onSubmit={submitOwnership}
      >
        <div className="form-grid">
          <Field label="权属证据引用" required span={2} error={validationError}>
            <input
              value={evidenceReference}
              onChange={(event) => {
                setEvidenceReference(event.target.value);
                setValidationError("");
              }}
            />
          </Field>
        </div>
      </Dialog>
      <Dialog
        open={dialog === "disbursement"}
        title="发起投放"
        subtitle={
          selectedContract
            ? `${selectedContract.contractNumber} · ${formatMoney(selectedContract.principal)}`
            : "合同投放"
        }
        submitting={submitting}
        submitLabel="进入投放复核"
        error={submitError}
        onClose={closeDialog}
        onSubmit={submitDisbursement}
      >
        <div className="form-grid">
          <Field label="收款方" required span={2} error={validationError}>
            <input
              value={payeeName}
              onChange={(event) => {
                setPayeeName(event.target.value);
                setValidationError("");
              }}
            />
          </Field>
          <Field label="银行账户引用" required span={2}>
            <input
              value={bankAccountRef}
              onChange={(event) => {
                setBankAccountRef(event.target.value);
                setValidationError("");
              }}
            />
          </Field>
        </div>
      </Dialog>
      <Dialog
        open={dialog === "deposit"}
        title="登记保证金实收"
        subtitle={
          selectedContract
            ? `${selectedContract.contractNumber} · 待收 ${formatMoney(selectedDepositAccount?.availableAmount || "0.00")}`
            : "合同保证金"
        }
        submitting={submitting}
        submitLabel="提交实收"
        error={submitError}
        onClose={closeDialog}
        onSubmit={submitDeposit}
      >
        <div className="form-grid">
          <Field label="实收金额" required error={validationError}>
            <input
              inputMode="decimal"
              value={depositAmount}
              onChange={(event) => {
                setDepositAmount(event.target.value);
                setValidationError("");
              }}
            />
          </Field>
          <Field label="到账日期" required>
            <input
              type="date"
              value={depositValueDate}
              onChange={(event) => {
                setDepositValueDate(event.target.value);
                setValidationError("");
              }}
            />
          </Field>
          <Field label="外部流水号" required span={2}>
            <input
              value={depositExternalReference}
              onChange={(event) => {
                setDepositExternalReference(event.target.value);
                setValidationError("");
              }}
              placeholder="例如 BANK-20260801-0001"
            />
          </Field>
        </div>
      </Dialog>
      {detailAsset ? (
        <AssetWorkspaceDialog
          session={session}
          asset={detailAsset}
          onClose={() => setDetailAsset(null)}
          onUpdated={(nextReceipt) => {
            setReceipt(nextReceipt);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function ContractsTable({
  contracts,
  projectMap,
  depositMap,
  canRecordDeposit,
  onDeposit,
  onDisbursement,
}: {
  contracts: LeaseContract[];
  projectMap: Map<string, { name: string }>;
  depositMap: Map<string, DepositAccount>;
  canRecordDeposit: boolean;
  onDeposit: (item: LeaseContract, account: DepositAccount) => void;
  onDisbursement: (item: LeaseContract) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">租赁合同列表</caption>
        <thead>
          <tr>
            <th>合同 / 项目</th>
            <th>模式</th>
            <th className="numeric">本金</th>
            <th className="numeric">租金总额</th>
            <th className="numeric">保证金</th>
            <th>期限</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {contracts.map((item) => {
            const account = depositMap.get(item.id);
            return (
              <tr key={item.id}>
                <td>
                  <span className="primary-cell">
                    <FileKey2 size={16} />
                    {item.contractNumber}
                  </span>
                  <small>{projectMap.get(item.projectId)?.name || item.projectId}</small>
                </td>
                <td>{leaseTypeLabel(item.leaseType)}</td>
                <td className="numeric strong">{formatMoney(item.principal)}</td>
                <td className="numeric">
                  {formatMoney(item.totalRent)}
                  <small>税额 {formatMoney(item.totalTax)}</small>
                </td>
                <td className="numeric">
                  {account ? (
                    <>
                      <strong>{formatMoney(account.collectedAmount)}</strong>
                      <small>待收 {formatMoney(account.availableAmount)}</small>
                      <StatusBadge label={statusLabel(account.status)} tone={statusTone(account.status)} />
                    </>
                  ) : (
                    "无需收取"
                  )}
                </td>
                <td>
                  {item.termMonths} 月
                  <small>
                    {item.startDate} 至 {item.endDate}
                  </small>
                </td>
                <td>
                  <StatusBadge label={statusLabel(item.status)} tone={statusTone(item.status)} />
                </td>
                <td className="table-actions">
                  {canRecordDeposit && account && account.status !== "collected_pending_accounting" ? (
                    <button className="button secondary compact" type="button" onClick={() => onDeposit(item, account)}>
                      <Landmark size={15} />
                      登记实收
                    </button>
                  ) : null}
                  {item.status === "approved" ? (
                    <button className="button secondary compact" type="button" onClick={() => onDisbursement(item)}>
                      <Banknote size={15} />
                      投放
                    </button>
                  ) : null}
                  {!account && item.status !== "approved" ? "--" : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
function AssetsTable({
  assets,
  contractMap,
  onVerify,
  onOpen,
}: {
  assets: LeaseAsset[];
  contractMap: Map<string, LeaseContract>;
  onVerify: (item: LeaseAsset) => void;
  onOpen: (item: LeaseAsset) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">租赁物列表</caption>
        <thead>
          <tr>
            <th>租赁物</th>
            <th>所属合同</th>
            <th>类型 / 主状态</th>
            <th>合规状态</th>
            <th className="numeric">残值</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {assets.map((item) => (
            <tr key={item.id}>
              <td>
                <span className="primary-cell">
                  <Boxes size={16} />
                  {item.name}
                </span>
                <small>
                  {item.uniqueNumber} {item.vin || item.serialNumber || ""}
                </small>
              </td>
              <td>{contractMap.get(item.contractId)?.contractNumber || item.contractId}</td>
              <td>
                {statusLabel(item.assetType)}
                <small>
                  <StatusBadge label={statusLabel(item.status)} tone={statusTone(item.status)} />
                </small>
              </td>
              <td>
                <span className="status-cluster">
                  <StatusBadge
                    label={`权属 ${statusLabel(item.ownershipStatus)}`}
                    tone={statusTone(item.ownershipStatus)}
                  />
                  <StatusBadge
                    label={`验收 ${statusLabel(item.acceptanceStatus)}`}
                    tone={statusTone(item.acceptanceStatus)}
                  />
                  <StatusBadge
                    label={`登记 ${statusLabel(item.registrationStatus)}`}
                    tone={statusTone(item.registrationStatus)}
                  />
                  <StatusBadge
                    label={`保险 ${statusLabel(item.insuranceStatus)}`}
                    tone={statusTone(item.insuranceStatus)}
                  />
                </span>
              </td>
              <td className="numeric strong">
                {formatMoney(item.forecastResidualValue)}
                <small>约定 {formatMoney(item.contractualResidualValue)}</small>
              </td>
              <td>
                <span className="inline-actions">
                  <button
                    className="icon-button quiet"
                    type="button"
                    title="打开资产工作区"
                    aria-label={`打开 ${item.name} 资产工作区`}
                    onClick={() => onOpen(item)}
                  >
                    <Eye size={16} />
                  </button>
                  {item.ownershipStatus === "pending_verification" ? (
                    <button className="button secondary compact" type="button" onClick={() => onVerify(item)}>
                      <ShieldCheck size={15} />
                      核验
                    </button>
                  ) : null}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ComplianceQueue({
  summary,
}: {
  summary: {
    total: number;
    pendingAcceptance: number;
    missingRegistration: number;
    missingInsurance: number;
    insuranceExpiring: number;
    valuationDue: number;
    residualAtRisk: number;
  };
}) {
  const items = [
    ["待验收", summary.pendingAcceptance],
    ["未登记", summary.missingRegistration],
    ["未投保", summary.missingInsurance],
    ["保险临期", summary.insuranceExpiring],
    ["估值到期", summary.valuationDue],
    ["残值偏差", summary.residualAtRisk],
  ];
  return (
    <div className="compliance-queue" aria-label="资产合规队列">
      <div>
        <span>资产总数</span>
        <strong>{summary.total}</strong>
      </div>
      {items.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong className={Number(value) > 0 ? "attention-text" : ""}>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function DisbursementsTable({
  items,
  contractMap,
}: {
  items: Array<{
    id: string;
    contractId: string;
    payeeName: string;
    amount: string;
    status: string;
    createdAt: string;
  }>;
  contractMap: Map<string, LeaseContract>;
}) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">投放列表</caption>
        <thead>
          <tr>
            <th>投放编号 / 合同</th>
            <th>收款方</th>
            <th className="numeric">金额</th>
            <th>状态</th>
            <th>申请时间</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>
                <span className="primary-cell">
                  <Banknote size={16} />
                  {item.id}
                </span>
                <small>{contractMap.get(item.contractId)?.contractNumber || item.contractId}</small>
              </td>
              <td>{item.payeeName}</td>
              <td className="numeric strong">{formatMoney(item.amount)}</td>
              <td>
                <StatusBadge label={statusLabel(item.status)} tone={statusTone(item.status)} />
              </td>
              <td>{formatDateTime(item.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function asError(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason : new Error(fallback);
}
