import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ClipboardCheck, FilePenLine, Gauge, Landmark, RefreshCw, ShieldCheck, Tag, X } from "lucide-react";
import {
  executeAssetCommand,
  fetchAsset,
  fetchAssetAcceptances,
  fetchAssetIdentifierHistory,
  fetchAssetInsurancePolicies,
  fetchAssetRegistrations,
  fetchAssetResidualValues,
  fetchAssetValuations,
  newIdempotencyKey,
} from "../api";
import { useRemoteData } from "../hooks/useRemoteData";
import type {
  AssetAcceptance,
  AssetIdentifierHistory,
  AssetInsurancePolicy,
  AssetRegistration,
  AssetResidualValue,
  AssetValuation,
  CommandReceipt,
  LeaseAsset,
  ListResponse,
  Session,
} from "../types";
import { formatDateTime, formatMoney, statusLabel, statusTone } from "../utils";
import { Dialog, EmptyState, ErrorState, Field, LoadingState, StatusBadge } from "./Workspace";

type Tab = "summary" | "registrations" | "insurance" | "acceptances" | "valuations" | "residuals" | "identifiers";
type Action =
  | "profile"
  | "identifier"
  | "registration"
  | "registrationCancel"
  | "insurance"
  | "insuranceCancel"
  | "acceptance"
  | "valuation"
  | "residual"
  | "disposition";
type FormState = Record<string, string | boolean>;
interface AssetWorkspaceData {
  asset: LeaseAsset;
  registrations: ListResponse<AssetRegistration>;
  insurance: ListResponse<AssetInsurancePolicy>;
  acceptances: ListResponse<AssetAcceptance>;
  valuations: ListResponse<AssetValuation>;
  residuals: ListResponse<AssetResidualValue>;
  identifiers: ListResponse<AssetIdentifierHistory>;
}

const TABS: Array<[Tab, string]> = [
  ["summary", "概览"],
  ["registrations", "登记"],
  ["insurance", "保险"],
  ["acceptances", "验收"],
  ["valuations", "估值"],
  ["residuals", "残值"],
  ["identifiers", "标识历史"],
];

export function AssetWorkspaceDialog({
  session,
  asset: initialAsset,
  onClose,
  onUpdated,
}: {
  session: Session;
  asset: LeaseAsset;
  onClose: () => void;
  onUpdated: (receipt: CommandReceipt) => void;
}) {
  const loader = useCallback(
    async (signal: AbortSignal) => {
      const [asset, registrations, insurance, acceptances, valuations, residuals, identifiers] = await Promise.all([
        fetchAsset(session, initialAsset.id, signal),
        fetchAssetRegistrations(session, initialAsset.id, signal),
        fetchAssetInsurancePolicies(session, initialAsset.id, signal),
        fetchAssetAcceptances(session, initialAsset.id, signal),
        fetchAssetValuations(session, initialAsset.id, signal),
        fetchAssetResidualValues(session, initialAsset.id, signal),
        fetchAssetIdentifierHistory(session, initialAsset.id, signal),
      ]);
      return { asset, registrations, insurance, acceptances, valuations, residuals, identifiers };
    },
    [initialAsset.id, session],
  );
  const { data, error, loading, reload } = useRemoteData(loader);
  const [tab, setTab] = useState<Tab>("summary");
  const [action, setAction] = useState<Action | null>(null);
  const [form, setForm] = useState<FormState>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const asset = data?.asset || initialAsset;
  const actionDefinition = useMemo(() => (action ? actionConfig(action, asset, form) : null), [action, asset, form]);

  const openAction = (next: Action, values: FormState = {}) => {
    setAction(next);
    setForm(defaultActionForm(next, asset, values));
    setSubmitError(null);
  };
  const closeAction = () => {
    if (!submitting) setAction(null);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!action || !actionDefinition) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const receipt = await executeAssetCommand(
        session,
        actionDefinition.command,
        actionDefinition.payload,
        newIdempotencyKey(`asset-${action}`),
        asset.version,
      );
      setAction(null);
      reload();
      onUpdated(receipt);
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason : new Error("资产命令提交失败"));
    } finally {
      setSubmitting(false);
    }
  };
  const set = (key: string, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));

  return (
    <>
      {createPortal(
        <div className="dialog-backdrop asset-workspace-backdrop" role="presentation">
          <section
            className="asset-workspace-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="asset-workspace-title"
          >
            <header className="dialog-header asset-workspace-header">
              <div>
                <p className="eyebrow">资产工作区</p>
                <h2 id="asset-workspace-title">{asset.name}</h2>
                <p>
                  {asset.uniqueNumber} ·{" "}
                  {asset.assetType === "vehicle" ? asset.vin : asset.serialNumber || "未登记序列号"}
                </p>
              </div>
              <div className="asset-workspace-header-actions">
                <button
                  className="icon-button quiet"
                  type="button"
                  title="刷新资产数据"
                  aria-label="刷新资产数据"
                  onClick={reload}
                >
                  <RefreshCw size={17} />
                </button>
                <button className="icon-button quiet" type="button" aria-label="关闭" onClick={onClose}>
                  <X size={18} />
                </button>
              </div>
            </header>
            <div className="asset-workspace-toolbar">
              <div className="segmented" aria-label="资产详情标签页">
                {TABS.map(([key, label]) => (
                  <button type="button" key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="asset-action-menu">
                <button className="button secondary compact" type="button" onClick={() => openAction("profile")}>
                  <FilePenLine size={15} />
                  主档
                </button>
                {asset.assetType === "vehicle" ? (
                  <button className="button secondary compact" type="button" onClick={() => openAction("identifier")}>
                    <Tag size={15} />
                    VIN 更正
                  </button>
                ) : null}
                <button className="button secondary compact" type="button" onClick={() => openAction("acceptance")}>
                  <ClipboardCheck size={15} />
                  验收
                </button>
                <button className="button secondary compact" type="button" onClick={() => openAction("valuation")}>
                  <Gauge size={15} />
                  估值
                </button>
              </div>
            </div>
            <div className="asset-workspace-body">
              {loading ? <LoadingState /> : null}
              {error ? <ErrorState error={error} onRetry={reload} /> : null}
              {!loading && !error && data ? <AssetTab tab={tab} data={data} onAction={openAction} /> : null}
            </div>
          </section>
        </div>,
        document.body,
      )}
      <Dialog
        open={Boolean(action && actionDefinition)}
        title={actionDefinition?.title || "资产操作"}
        subtitle={`${asset.name} · 版本 ${asset.version}`}
        submitting={submitting}
        submitLabel={actionDefinition?.submitLabel || "提交"}
        error={submitError}
        onClose={closeAction}
        onSubmit={submit}
      >
        <div className="form-grid">
          {actionDefinition?.fields.map((field) => (
            <Field key={field.key} label={field.label} required={field.required} span={field.span}>
              {field.kind === "select" ? (
                <select
                  disabled={field.disabled}
                  value={String(form[field.key] ?? "")}
                  onChange={(event) => set(field.key, event.target.value)}
                >
                  {field.options?.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              ) : field.kind === "checkbox" ? (
                <label className="checkbox-row">
                  <input
                    disabled={field.disabled}
                    type="checkbox"
                    checked={Boolean(form[field.key])}
                    onChange={(event) => set(field.key, event.target.checked)}
                  />
                  <span>{field.help}</span>
                </label>
              ) : field.kind === "textarea" ? (
                <textarea
                  disabled={field.disabled}
                  rows={3}
                  value={String(form[field.key] ?? "")}
                  onChange={(event) => set(field.key, event.target.value)}
                />
              ) : (
                <input
                  disabled={field.disabled}
                  type={field.kind === "date" ? "date" : "text"}
                  inputMode={field.kind === "money" ? "decimal" : undefined}
                  value={String(form[field.key] ?? "")}
                  onChange={(event) => set(field.key, event.target.value)}
                />
              )}
            </Field>
          ))}
        </div>
      </Dialog>
    </>
  );
}

function AssetTab({
  tab,
  data,
  onAction,
}: {
  tab: Tab;
  data: AssetWorkspaceData;
  onAction: (action: Action, values?: FormState) => void;
}) {
  const asset = data.asset;
  if (tab === "summary")
    return (
      <div className="asset-summary-layout">
        <div className="asset-status-strip">
          <StatusItem label="主状态" value={asset.status} />
          <StatusItem label="权属" value={asset.ownershipStatus} />
          <StatusItem label="登记" value={asset.registrationStatus} />
          <StatusItem label="保险" value={asset.insuranceStatus} />
          <StatusItem label="验收" value={asset.acceptanceStatus} />
        </div>
        <dl className="detail-grid">
          <Detail label="资产类型" value={asset.assetType} />
          <Detail label="品牌 / 型号" value={[asset.brand, asset.model].filter(Boolean).join(" / ") || "--"} />
          <Detail label="制造商" value={asset.manufacturer || "--"} />
          <Detail label="存放地点" value={asset.location || "--"} />
          <Detail label="购置价" value={formatMoney(asset.purchasePrice)} />
          <Detail label="合同约定残值" value={formatMoney(asset.contractualResidualValue)} />
          <Detail label="最新预测残值" value={formatMoney(asset.forecastResidualValue)} />
          <Detail label="实际净回收" value={formatMoney(asset.actualDisposalNetProceeds)} />
          <Detail label="最近估值" value={asset.lastValuationDate || "--"} />
          <Detail label="下次估值" value={asset.nextValuationDate || "--"} />
        </dl>
        <div className="asset-summary-actions">
          <button className="button secondary compact" type="button" onClick={() => onAction("registration")}>
            <Landmark size={15} />
            登记
          </button>
          <button className="button secondary compact" type="button" onClick={() => onAction("insurance")}>
            <ShieldCheck size={15} />
            保险
          </button>
          <button className="button secondary compact" type="button" onClick={() => onAction("residual")}>
            <Gauge size={15} />
            调整残值
          </button>
          {asset.status === "held_for_disposal" ? (
            <button className="button primary compact" type="button" onClick={() => onAction("disposition")}>
              <Landmark size={15} />
              完成处置
            </button>
          ) : null}
        </div>
      </div>
    );
  if (tab === "registrations")
    return (
      <RecordTable
        headers={["类型 / 登记号", "登记机关", "有效期间", "状态", "操作"]}
        empty="暂无登记记录"
        rows={data.registrations.items.map((item) => [
          <span key="id">
            <strong>{item.registrationType}</strong>
            <small>{item.registrationNumber}</small>
          </span>,
          `${item.authority} · ${item.jurisdiction}`,
          `${item.effectiveDate} 至 ${item.expiryDate || "长期"}`,
          <StatusBadge key="status" label={statusLabel(item.status)} tone={statusTone(item.status)} />,
          item.status === "active" ? (
            <button
              key="cancel"
              className="button tertiary compact"
              type="button"
              onClick={() => onAction("registrationCancel", { registrationId: item.id })}
            >
              注销
            </button>
          ) : (
            "--"
          ),
        ])}
        action={
          <button className="button primary compact" type="button" onClick={() => onAction("registration")}>
            <Landmark size={15} />
            新增登记
          </button>
        }
      />
    );
  if (tab === "insurance")
    return (
      <RecordTable
        headers={["保单 / 保险人", "险种", "保险金额", "保险期间", "状态 / 操作"]}
        empty="暂无保险记录"
        rows={data.insurance.items.map((item) => [
          <span key="id">
            <strong>{item.policyNumber}</strong>
            <small>{item.insurer}</small>
          </span>,
          item.coverageTypes.join("、"),
          formatMoney(item.insuredAmount),
          `${item.startDate} 至 ${item.endDate}`,
          <span key="action" className="inline-actions">
            <StatusBadge label={statusLabel(item.status)} tone={statusTone(item.status)} />
            {item.status === "active" ? (
              <button
                className="button tertiary compact"
                type="button"
                onClick={() => onAction("insuranceCancel", { policyId: item.id })}
              >
                取消
              </button>
            ) : null}
          </span>,
        ])}
        action={
          <button className="button primary compact" type="button" onClick={() => onAction("insurance")}>
            <ShieldCheck size={15} />
            新增保单
          </button>
        }
      />
    );
  if (tab === "acceptances")
    return (
      <RecordTable
        headers={["验收类型", "日期 / 地点", "结果", "资产状况", "审批状态"]}
        empty="暂无验收记录"
        rows={data.acceptances.items.map((item) => [
          item.acceptanceType,
          <span key="date">
            {item.acceptanceDate}
            <small>{item.location}</small>
          </span>,
          statusLabel(item.result),
          statusLabel(item.assetCondition),
          <StatusBadge key="status" label={statusLabel(item.status)} tone={statusTone(item.status)} />,
        ])}
        action={
          <button className="button primary compact" type="button" onClick={() => onAction("acceptance")}>
            <ClipboardCheck size={15} />
            记录验收
          </button>
        }
      />
    );
  if (tab === "valuations")
    return (
      <RecordTable
        headers={["目的 / 基准日", "方法", "市场价值", "快速变现价值", "状态"]}
        empty="暂无估值记录"
        rows={data.valuations.items.map((item) => [
          <span key="id">
            <strong>{item.purpose}</strong>
            <small>{item.baseDate}</small>
          </span>,
          item.method,
          formatMoney(item.marketValue),
          formatMoney(item.forcedSaleValue),
          <StatusBadge key="status" label={statusLabel(item.status)} tone={statusTone(item.status)} />,
        ])}
        action={
          <button className="button primary compact" type="button" onClick={() => onAction("valuation")}>
            <Gauge size={15} />
            提交估值
          </button>
        }
      />
    );
  if (tab === "residuals")
    return (
      <RecordTable
        headers={["来源 / 生效日", "约定残值", "预测残值", "实际净回收", "偏差 / 状态"]}
        empty="暂无残值历史"
        rows={data.residuals.items.map((item) => [
          <span key="id">
            <strong>{item.sourceType}</strong>
            <small>{item.effectiveDate}</small>
          </span>,
          formatMoney(item.contractualValue),
          formatMoney(item.forecastValue),
          formatMoney(item.actualNetProceeds),
          <span key="status">
            <strong className={item.deviationBps <= -2000 ? "danger-text" : ""}>
              {(item.deviationBps / 100).toFixed(2)}%
            </strong>
            <small>{statusLabel(item.status)}</small>
          </span>,
        ])}
        action={
          <button className="button primary compact" type="button" onClick={() => onAction("residual")}>
            <Gauge size={15} />
            调整预测
          </button>
        }
      />
    );
  return (
    <RecordTable
      headers={["标识类型", "原值", "新值", "更正原因", "更正时间"]}
      empty="暂无标识更正记录"
      rows={data.identifiers.items.map((item) => [
        item.identifierType.toUpperCase(),
        item.oldValue,
        item.newValue,
        item.reason,
        formatDateTime(item.createdAt),
      ])}
    />
  );
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <StatusBadge label={statusLabel(value)} tone={statusTone(value)} />
    </div>
  );
}
function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
function RecordTable({
  headers,
  rows,
  empty,
  action,
}: {
  headers: string[];
  rows: ReactNode[][];
  empty: string;
  action?: ReactNode;
}) {
  return (
    <div className="asset-records">
      <div className="asset-records-heading">{action}</div>
      {rows.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {headers.map((item) => (
                  <th key={item}>{item}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title={empty} detail="可通过右上角操作建立新的权威台账记录" />
      )}
    </div>
  );
}

interface ActionField {
  key: string;
  label: string;
  kind?: "text" | "date" | "money" | "select" | "checkbox" | "textarea";
  options?: Array<[string, string]>;
  required?: boolean;
  span?: 1 | 2;
  help?: string;
  disabled?: boolean;
}
interface ActionDefinition {
  title: string;
  submitLabel: string;
  command: string;
  payload: Record<string, unknown>;
  fields: ActionField[];
}

function actionConfig(action: Action, asset: LeaseAsset, form: FormState): ActionDefinition {
  const value = (key: string) => String(form[key] ?? "").trim();
  const vehicleProfile = value("assetType") === "vehicle";
  const base = (
    title: string,
    submitLabel: string,
    command: string,
    fields: ActionField[],
    payload: Record<string, unknown>,
  ): ActionDefinition => ({ title, submitLabel, command, fields, payload: { assetId: asset.id, ...payload } });
  if (action === "profile")
    return base(
      "维护资产主档",
      "保存主档",
      "asset.profile.update",
      profileFields(value("assetType") || asset.assetType, asset.status === "registered"),
      {
        assetType: value("assetType"),
        vin: vehicleProfile ? value("vin").toUpperCase() : "",
        brand: value("brand"),
        model: value("model"),
        manufacturer: value("manufacturer"),
        manufactureDate: value("manufactureDate"),
        location: value("location"),
        engineNumber: vehicleProfile ? value("engineNumber") : "",
        licensePlateNumber: vehicleProfile ? value("licensePlateNumber") : "",
        vehicleUse: vehicleProfile ? value("vehicleUse") : "",
        firstRegistrationDate: vehicleProfile ? value("firstRegistrationDate") : "",
        registrationRequired: Boolean(form.registrationRequired),
        insuranceRequired: Boolean(form.insuranceRequired),
      },
    );
  if (action === "identifier")
    return base(
      "更正 VIN",
      "提交更正",
      "asset.identifier.correct",
      fields([
        ["newVin", "新 VIN"],
        ["reason", "更正原因"],
        ["evidenceRef", "证据引用"],
      ]),
      {
        oldVin: asset.vin || "",
        newVin: value("newVin").toUpperCase(),
        reason: value("reason"),
        evidenceRef: value("evidenceRef"),
      },
    );
  if (action === "registration")
    return base(
      "新增登记记录",
      "保存登记",
      "asset.registration.record",
      [
        {
          key: "registrationType",
          label: "登记类型",
          kind: "select",
          options: [
            ["vehicle", "车辆"],
            ["equipment", "设备"],
            ["industry", "行业"],
            ["other", "其他"],
          ],
          required: true,
        },
        ...fields([
          ["registrationNumber", "登记号"],
          ["certificateNumber", "证书号"],
          ["registeredOwner", "登记所有人"],
          ["authority", "登记机关"],
          ["jurisdiction", "辖区"],
          ["effectiveDate", "生效日期", "date"],
          ["expiryDate", "到期日期", "date"],
          ["evidenceRef", "证据引用"],
        ]),
      ],
      {
        registrationType: value("registrationType"),
        registrationNumber: value("registrationNumber"),
        certificateNumber: value("certificateNumber"),
        registeredOwner: value("registeredOwner"),
        authority: value("authority"),
        jurisdiction: value("jurisdiction"),
        effectiveDate: value("effectiveDate"),
        expiryDate: value("expiryDate"),
        evidenceRef: value("evidenceRef"),
        providerMode: "manual",
      },
    );
  if (action === "registrationCancel")
    return base(
      "注销登记",
      "确认注销",
      "asset.registration.cancel",
      fields([
        ["reason", "注销原因"],
        ["evidenceRef", "证据引用"],
      ]),
      { registrationId: value("registrationId"), reason: value("reason"), evidenceRef: value("evidenceRef") },
    );
  if (action === "insurance")
    return base(
      "新增保险记录",
      "保存保单",
      "asset.insurance.record",
      fields([
        ["policyNumber", "保单号"],
        ["insurer", "保险人"],
        ["coverageTypes", "险种（逗号分隔）"],
        ["insuredAmount", "保险金额", "money"],
        ["deductible", "免赔额", "money"],
        ["premium", "保费", "money"],
        ["insuredParty", "被保险人"],
        ["beneficiary", "受益人"],
        ["startDate", "保险起期", "date"],
        ["endDate", "保险止期", "date"],
        ["evidenceRef", "证据引用"],
      ]),
      {
        policyNumber: value("policyNumber"),
        insurer: value("insurer"),
        coverageTypes: value("coverageTypes")
          .split(/[，,]/)
          .map((item) => item.trim())
          .filter(Boolean),
        insuredAmount: money(value("insuredAmount")),
        deductible: money(value("deductible")),
        premium: money(value("premium")),
        insuredParty: value("insuredParty"),
        beneficiary: value("beneficiary"),
        startDate: value("startDate"),
        endDate: value("endDate"),
        evidenceRef: value("evidenceRef"),
        providerMode: "manual",
      },
    );
  if (action === "insuranceCancel")
    return base(
      "取消保单",
      "确认取消",
      "asset.insurance.cancel",
      fields([
        ["reason", "取消原因"],
        ["evidenceRef", "证据引用"],
      ]),
      { policyId: value("policyId"), reason: value("reason"), evidenceRef: value("evidenceRef") },
    );
  if (action === "acceptance")
    return base(
      "记录资产验收",
      "进入验收复核",
      "asset.acceptance.record",
      [
        {
          key: "acceptanceType",
          label: "验收类型",
          kind: "select",
          options: [
            ["initial", "初验"],
            ["rectification", "整改复验"],
            ["repossession", "收回验收"],
          ],
          required: true,
        },
        {
          key: "result",
          label: "验收结果",
          kind: "select",
          options: [
            ["accepted", "通过"],
            ["rejected", "拒绝"],
          ],
          required: true,
        },
        {
          key: "assetCondition",
          label: "资产状况",
          kind: "select",
          options: [
            ["good", "良好"],
            ["attention", "需关注"],
            ["impaired", "受损"],
            ["missing", "缺失"],
          ],
          required: true,
        },
        ...fields([
          ["acceptanceDate", "验收日期", "date"],
          ["location", "验收地点"],
          ["meterReading", "里程 / 工时"],
          ["meterUnit", "计量单位"],
          ["findings", "验收结论", "textarea"],
          ["evidenceRefs", "证据引用（逗号分隔）"],
        ]),
      ],
      {
        acceptanceType: value("acceptanceType"),
        acceptanceDate: value("acceptanceDate"),
        location: value("location"),
        result: value("result"),
        assetCondition: value("assetCondition"),
        meterReading: value("meterReading"),
        meterUnit: value("meterUnit"),
        findings: value("findings"),
        checklist: [
          {
            code: "GENERAL_CONDITION",
            result: value("result") === "accepted" ? "pass" : "fail",
            note: value("findings"),
          },
        ],
        evidenceRefs: split(value("evidenceRefs")),
      },
    );
  if (action === "valuation")
    return base(
      "提交资产估值",
      "进入估值复核",
      "asset.valuation.submit",
      [
        {
          key: "purpose",
          label: "估值目的",
          kind: "select",
          options: [
            ["initial", "初始"],
            ["periodic", "定期"],
            ["impairment", "减值"],
            ["pre_disposal", "处置前"],
          ],
          required: true,
        },
        {
          key: "method",
          label: "估值方法",
          kind: "select",
          options: [
            ["market", "市场法"],
            ["comparable", "可比法"],
            ["income", "收益法"],
            ["cost", "成本法"],
            ["third_party", "第三方"],
          ],
          required: true,
        },
        ...fields([
          ["baseDate", "估值基准日", "date"],
          ["marketValue", "市场价值", "money"],
          ["forcedSaleValue", "快速变现价值", "money"],
          ["recommendedResidualValue", "建议预测残值", "money"],
          ["valuerName", "估值人员 / 机构"],
          ["reportRef", "估值报告引用"],
          ["nextValuationDate", "下次估值日期", "date"],
        ]),
      ],
      {
        purpose: value("purpose"),
        baseDate: value("baseDate"),
        method: value("method"),
        marketValue: money(value("marketValue")),
        forcedSaleValue: money(value("forcedSaleValue")),
        recommendedResidualValue: money(value("recommendedResidualValue")),
        valuerType: "external",
        valuerName: value("valuerName"),
        valuerOrganization: value("valuerName"),
        reportRef: value("reportRef"),
        nextValuationDate: value("nextValuationDate"),
      },
    );
  if (action === "residual")
    return base(
      "调整预测残值",
      "进入三方复核",
      "asset.residual-value.adjust",
      fields([
        ["effectiveDate", "生效日期", "date"],
        ["forecastValue", "预测残值", "money"],
        ["reason", "调整原因", "textarea"],
        ["evidenceRef", "证据引用"],
      ]),
      {
        effectiveDate: value("effectiveDate"),
        forecastValue: money(value("forecastValue")),
        reason: value("reason"),
        evidenceRef: value("evidenceRef"),
      },
    );
  return base(
    "完成资产处置",
    "确认完成",
    "asset.disposition.complete",
    fields([
      ["dispositionId", "处置决策编号"],
      ["completedAt", "完成日期", "date"],
      ["grossProceeds", "处置收入", "money"],
      ["taxes", "税费", "money"],
      ["dispositionCosts", "处置费用", "money"],
      ["settlementReference", "结算引用"],
      ["evidenceRefs", "证据引用（逗号分隔）"],
    ]),
    {
      dispositionId: value("dispositionId"),
      completedAt: value("completedAt"),
      grossProceeds: money(value("grossProceeds")),
      taxes: money(value("taxes")),
      dispositionCosts: money(value("dispositionCosts")),
      netProceeds: money(
        String(
          Number(value("grossProceeds") || 0) - Number(value("taxes") || 0) - Number(value("dispositionCosts") || 0),
        ),
      ),
      settlementReference: value("settlementReference"),
      evidenceRefs: split(value("evidenceRefs")),
    },
  );
}

function defaultActionForm(action: Action, asset: LeaseAsset, values: FormState): FormState {
  const today = new Date().toISOString().slice(0, 10);
  const common: FormState = {
    effectiveDate: today,
    acceptanceDate: today,
    baseDate: today,
    completedAt: today,
    registrationType: asset.assetType === "vehicle" ? "vehicle" : "equipment",
    acceptanceType: "initial",
    result: "accepted",
    assetCondition: "good",
    purpose: "periodic",
    method: "market",
    deductible: "0.00",
    premium: "0.00",
    taxes: "0.00",
    dispositionCosts: "0.00",
    forecastValue: asset.forecastResidualValue,
  };
  if (action === "profile")
    Object.assign(common, {
      assetType: asset.assetType,
      vin: asset.vin || "",
      brand: asset.brand || "",
      model: asset.model || "",
      manufacturer: asset.manufacturer || "",
      manufactureDate: asset.manufactureDate || "",
      location: asset.location || "",
      engineNumber: asset.engineNumber || "",
      licensePlateNumber: asset.licensePlateNumber || "",
      vehicleUse: asset.vehicleUse || "",
      firstRegistrationDate: asset.firstRegistrationDate || "",
      registrationRequired: asset.registrationRequired,
      insuranceRequired: asset.insuranceRequired,
    });
  return { ...common, ...values };
}

function profileFields(assetType: string, identifierEditable: boolean): ActionField[] {
  return [
    {
      key: "assetType",
      label: "资产类型",
      kind: "select",
      options: [
        ["equipment", "设备"],
        ["vehicle", "车辆"],
        ["ship", "船舶"],
        ["aircraft", "航空器"],
        ["real_estate", "不动产"],
        ["other", "其他"],
      ],
      required: true,
      disabled: !identifierEditable,
    },
    ...(assetType === "vehicle" && identifierEditable ? fields([["vin", "VIN"]]) : []),
    ...fields([
      ["brand", "品牌"],
      ["model", "型号"],
      ["manufacturer", "制造商"],
      ["manufactureDate", "制造日期", "date"],
      ["location", "存放地点"],
    ]),
    ...(assetType === "vehicle"
      ? fields([
          ["engineNumber", "发动机号"],
          ["licensePlateNumber", "车牌号"],
          ["vehicleUse", "车辆用途"],
          ["firstRegistrationDate", "首次登记日期", "date"],
        ])
      : []),
    { key: "registrationRequired", label: "登记控制", kind: "checkbox", help: "投放前必须具备有效登记" },
    { key: "insuranceRequired", label: "保险控制", kind: "checkbox", help: "投放前必须具备有效保险" },
  ];
}
function fields(input: Array<[string, string, ActionField["kind"]?]>): ActionField[] {
  return input.map(([key, label, kind = "text"]) => ({
    key,
    label,
    kind,
    required: !["expiryDate", "meterReading", "meterUnit"].includes(key),
    span: kind === "textarea" ? 2 : 1,
  }));
}
function split(value: string) {
  return value
    .split(/[，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
function money(value: string) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toFixed(2) : value;
}
