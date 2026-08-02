import { useCallback, useMemo, useState, type FormEvent } from "react";
import {
  Archive,
  Calculator,
  CheckCircle2,
  CopyPlus,
  Download,
  FileOutput,
  FilePlus2,
  PackagePlus,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  ShieldAlert,
} from "lucide-react";
import {
  calculatePricingQuote,
  convertPricingQuoteToContract,
  createPricingProduct,
  createPricingQuote,
  downloadPricingQuoteDocument,
  fetchPricingProduct,
  fetchPricingProducts,
  fetchPricingQuotes,
  fetchProjects,
  finalizePricingQuote,
  generatePricingQuoteDocument,
  newIdempotencyKey,
  publishPricingProductVersion,
  retirePricingProductVersion,
  revisePricingQuote,
  updatePricingProductVersion,
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
import { canManageLeasingProducts, canManageLeasingQuotes } from "../permissions";
import type {
  CommandReceipt,
  LeaseProject,
  PricingPolicy,
  PricingProduct,
  PricingProductDetail,
  PricingProductVersion,
  PricingQuote,
  QuoteTerms,
  Session,
} from "../types";
import { formatDateTime, formatMoney, statusTone } from "../utils";

type View = "quotes" | "products";
type DialogMode = "product" | "quote" | "contract" | null;

interface PricingWorkspaceData {
  products: PricingProduct[];
  details: PricingProductDetail[];
  quotes: PricingQuote[];
  projects: LeaseProject[];
}

interface ProductForm {
  code: string;
  name: string;
  description: string;
  authorizedDepartmentIds: string;
  dayCount: PricingPolicy["dayCount"];
  paymentFrequencyMonths: string;
  vatRateBps: string;
  defaultVatRecoverableBps: string;
  principalHardMin: string;
  principalHardMax: string;
  principalSoftMin: string;
  principalSoftMax: string;
  termHardMin: string;
  termHardMax: string;
  termSoftMin: string;
  termSoftMax: string;
  rateHardMin: string;
  rateHardMax: string;
  rateSoftMin: string;
  rateSoftMax: string;
  maximumGracePeriods: string;
  negativeAmortizationEnabled: boolean;
  negativeAmortizationSoftCapBps: string;
  negativeAmortizationHardCapBps: string;
  quoteValidityDays: string;
}

interface QuoteForm {
  projectId: string;
  productVersionId: string;
  expectedFundingDate: string;
  leaseStartDate: string;
  vatRecoverableBps: string;
  scheduleWeights: string;
  gracePeriodCount: string;
  graceMode: QuoteTerms["graceMode"];
  depositAmount: string;
  depositAnnualInterestBps: string;
  depositReleaseDate: string;
  depositReleaseAmount: string;
  depositReleaseMethod: "refund" | "offset";
  endTermMode: "purchase" | "return";
  customerPurchasePrice: string;
  customerGuaranteedResidual: string;
  assetResidualGross: string;
  assetRealizationDate: string;
  disposalCost: string;
  baseHaircutBps: string;
  stressHaircutBps: string;
  irregularInstallmentNumber: string;
  irregularDueDate: string;
  irregularGrossRent: string;
  scheduledFeeTotal: string;
  clientFeeAmount: string;
  clientFeeDescription: string;
}

interface ContractForm {
  contractNumber: string;
  assetName: string;
  uniqueNumber: string;
  serialNumber: string;
  purchasePrice: string;
  ownershipEvidenceRef: string;
}

export default function PricingWorkspacePage({ session }: { session: Session }) {
  const [view, setView] = useState<View>("quotes");
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [selectedQuoteId, setSelectedQuoteId] = useState("");
  const [editingVersion, setEditingVersion] = useState<PricingProductVersion | null>(null);
  const [revisingQuote, setRevisingQuote] = useState<PricingQuote | null>(null);
  const [productForm, setProductForm] = useState<ProductForm>(() => defaultProductForm(session));
  const [quoteForm, setQuoteForm] = useState<QuoteForm>(defaultQuoteForm);
  const [contractForm, setContractForm] = useState<ContractForm>(() => defaultContractForm());
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [receipt, setReceipt] = useState<CommandReceipt | null>(null);

  const loader = useCallback(
    async (signal: AbortSignal): Promise<PricingWorkspaceData> => {
      const [products, quotes, projects] = await Promise.all([
        fetchPricingProducts(session, signal),
        fetchPricingQuotes(session, signal),
        fetchProjects(session, signal),
      ]);
      const details = await Promise.all(
        products.items.map((product) => fetchPricingProduct(session, product.id, signal)),
      );
      return { products: products.items, details, quotes: quotes.items, projects: projects.items };
    },
    [session],
  );
  const { data, error, loading, reload } = useRemoteData(loader);

  const selectedQuote = useMemo(
    () => data?.quotes.find((quote) => quote.id === selectedQuoteId) || null,
    [data?.quotes, selectedQuoteId],
  );
  const versions = useMemo(() => data?.details.flatMap((detail) => detail.versions) || [], [data?.details]);
  const canManageProducts = session.mode === "oidc-token" || canManageLeasingProducts(session.roleIds);
  const canManageQuotes = session.mode === "oidc-token" || canManageLeasingQuotes(session.roleIds);

  const runAction = async (operation: () => Promise<CommandReceipt>) => {
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

  const openProduct = (version?: PricingProductVersion, product?: PricingProduct) => {
    setEditingVersion(version || null);
    setProductForm(version && product ? productFormFromVersion(product, version) : defaultProductForm(session));
    setSubmitError(null);
    setDialog("product");
  };

  const openQuote = (quote?: PricingQuote) => {
    setRevisingQuote(quote || null);
    setQuoteForm(
      quote ? quoteFormFromQuote(quote) : defaultQuoteForm(data?.projects[0], firstPublishedVersion(versions)),
    );
    setSubmitError(null);
    setDialog("quote");
  };

  const openContract = (quote: PricingQuote) => {
    const project = data?.projects.find((item) => item.id === quote.projectId);
    setSelectedQuoteId(quote.id);
    setContractForm(defaultContractForm(project));
    setSubmitError(null);
    setDialog("contract");
  };

  const submitProduct = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let policy: PricingPolicy;
    try {
      policy = policyFromForm(productForm);
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason : new Error("产品策略无效"));
      return;
    }
    const departmentIds = splitList(productForm.authorizedDepartmentIds);
    if (departmentIds.length === 0) {
      setSubmitError(new Error("至少配置一个授权部门"));
      return;
    }
    if (editingVersion) {
      void runAction(() =>
        updatePricingProductVersion(
          session,
          editingVersion.id,
          policy,
          departmentIds,
          newIdempotencyKey("pricing-product-version"),
          editingVersion.version,
        ),
      );
      return;
    }
    void runAction(() =>
      createPricingProduct(
        session,
        {
          code: required(productForm.code, "产品代码"),
          name: required(productForm.name, "产品名称"),
          description: productForm.description.trim() || undefined,
          policy,
          authorizedDepartmentIds: departmentIds,
        },
        newIdempotencyKey("pricing-product"),
      ),
    );
  };

  const submitQuote = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const project = data?.projects.find((item) => item.id === quoteForm.projectId);
      const version = versions.find((item) => item.id === quoteForm.productVersionId);
      if (!project || !version) throw new Error("请选择有效的项目和产品版本");
      const terms = termsFromForm(quoteForm, project, version.policy);
      if (revisingQuote) {
        void runAction(() =>
          revisePricingQuote(
            session,
            revisingQuote.id,
            terms,
            newIdempotencyKey("pricing-quote-revision"),
            revisingQuote.version,
          ),
        );
      } else {
        void runAction(() =>
          createPricingQuote(session, project.id, version.id, terms, newIdempotencyKey("pricing-quote")),
        );
      }
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason : new Error("报价条款无效"));
    }
  };

  const submitContract = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedQuote) return;
    try {
      const body = {
        quoteId: selectedQuote.id,
        contractNumber: required(contractForm.contractNumber, "合同编号"),
        assets: [
          {
            name: required(contractForm.assetName, "租赁物名称"),
            uniqueNumber: required(contractForm.uniqueNumber, "租赁物唯一编号"),
            serialNumber: contractForm.serialNumber.trim() || undefined,
            purchasePrice: positiveMoney(contractForm.purchasePrice, "购置价"),
            ownershipEvidenceRef: contractForm.ownershipEvidenceRef.trim() || undefined,
          },
        ],
      };
      void runAction(() =>
        convertPricingQuoteToContract(session, body, newIdempotencyKey("contract-from-quote"), selectedQuote.version),
      );
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason : new Error("合同信息无效"));
    }
  };

  const publishVersion = (version: PricingProductVersion) =>
    void runAction(() =>
      publishPricingProductVersion(session, version.id, newIdempotencyKey("pricing-product-publish"), version.version),
    );
  const retireVersion = (version: PricingProductVersion) =>
    void runAction(() =>
      retirePricingProductVersion(session, version.id, newIdempotencyKey("pricing-product-retire"), version.version),
    );
  const calculateQuote = (quote: PricingQuote) =>
    void runAction(() =>
      calculatePricingQuote(session, quote.id, newIdempotencyKey("pricing-quote-calculate"), quote.version),
    );
  const finalizeQuote = (quote: PricingQuote) =>
    void runAction(() =>
      finalizePricingQuote(session, quote.id, newIdempotencyKey("pricing-quote-finalize"), quote.version),
    );
  const generateDocument = (quote: PricingQuote) =>
    void runAction(() =>
      generatePricingQuoteDocument(session, quote.id, newIdempotencyKey("pricing-quote-document"), quote.version),
    );

  const downloadDocument = async (quote: PricingQuote) => {
    setActionError(null);
    try {
      const { blob, filename } = await downloadPricingQuoteDocument(session, quote.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason : new Error("报价文件下载失败"));
    }
  };

  return (
    <div className="workspace pricing-workspace">
      <PageHeader
        eyebrow="产品策略 / 现金流定价"
        title="产品与定价"
        meta={data ? `${data.products.length} 个产品 · ${data.quotes.length} 份报价` : undefined}
        action={
          view === "products" ? (
            canManageProducts ? (
              <button className="button primary" type="button" aria-label="创建定价产品" onClick={() => openProduct()}>
                <PackagePlus size={16} />
                创建产品
              </button>
            ) : null
          ) : canManageQuotes ? (
            <button className="button primary" type="button" onClick={() => openQuote()}>
              <Plus size={16} />
              新建报价
            </button>
          ) : null
        }
      />
      <div className="pricing-view-tabs" role="tablist" aria-label="产品与定价功能">
        <button type="button" role="tab" aria-selected={view === "quotes"} onClick={() => setView("quotes")}>
          <Calculator size={16} />
          报价工作台
        </button>
        <button type="button" role="tab" aria-selected={view === "products"} onClick={() => setView("products")}>
          <FileOutput size={16} />
          产品版本
        </button>
      </div>
      {receipt ? <CommandNotice receipt={receipt} onClose={() => setReceipt(null)} /> : null}
      {actionError ? (
        <div className="inline-alert" role="alert">
          {actionError.message}
        </div>
      ) : null}
      {loading ? <LoadingState rows={7} /> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {!loading && !error && view === "products" ? (
        <ProductVersionWorkspace
          details={data?.details || []}
          canManage={canManageProducts}
          submitting={submitting}
          onEdit={openProduct}
          onPublish={publishVersion}
          onRetire={retireVersion}
        />
      ) : null}
      {!loading && !error && view === "quotes" ? (
        <QuoteWorkspace
          quotes={data?.quotes || []}
          projects={data?.projects || []}
          products={data?.products || []}
          selected={selectedQuote}
          canManage={canManageQuotes}
          submitting={submitting}
          onSelect={setSelectedQuoteId}
          onCalculate={calculateQuote}
          onFinalize={finalizeQuote}
          onRevise={openQuote}
          onGenerateDocument={generateDocument}
          onDownloadDocument={(quote) => void downloadDocument(quote)}
          onCreateContract={openContract}
        />
      ) : null}
      <ProductDialog
        open={dialog === "product"}
        editing={editingVersion}
        form={productForm}
        setForm={setProductForm}
        submitting={submitting}
        error={submitError}
        close={() => setDialog(null)}
        submit={submitProduct}
      />
      <QuoteDialog
        open={dialog === "quote"}
        revising={revisingQuote}
        projects={data?.projects || []}
        versions={versions}
        form={quoteForm}
        setForm={setQuoteForm}
        submitting={submitting}
        error={submitError}
        close={() => setDialog(null)}
        submit={submitQuote}
      />
      <ContractDialog
        open={dialog === "contract"}
        quote={selectedQuote}
        form={contractForm}
        setForm={setContractForm}
        submitting={submitting}
        error={submitError}
        close={() => setDialog(null)}
        submit={submitContract}
      />
    </div>
  );
}

function ProductVersionWorkspace({
  details,
  canManage,
  submitting,
  onEdit,
  onPublish,
  onRetire,
}: {
  details: PricingProductDetail[];
  canManage: boolean;
  submitting: boolean;
  onEdit: (version: PricingProductVersion, product: PricingProduct) => void;
  onPublish: (version: PricingProductVersion) => void;
  onRetire: (version: PricingProductVersion) => void;
}) {
  if (details.length === 0)
    return <EmptyState title="暂无定价产品" detail="由产品经理建立策略边界和部门授权后发布使用" />;
  return (
    <div className="pricing-product-list">
      {details.map(({ product, versions }) => (
        <section className="pricing-product-band" key={product.id}>
          <header>
            <div>
              <span className="mono">{product.code}</span>
              <h2>{product.name}</h2>
              <p>{product.description || "未填写产品说明"}</p>
            </div>
            <div className="pricing-product-meta">
              <span>最新 V{product.latestVersionNumber}</span>
              <StatusBadge label={product.status === "active" ? "已启用" : "草稿"} tone={statusTone(product.status)} />
            </div>
          </header>
          <div className="table-frame">
            <table>
              <caption className="sr-only">{product.name}版本列表</caption>
              <thead>
                <tr>
                  <th>版本</th>
                  <th>状态</th>
                  <th>本金硬范围</th>
                  <th>期限 / 频率</th>
                  <th>利率范围</th>
                  <th>宽限 / 期末</th>
                  <th>部门授权</th>
                  <th>更新时间</th>
                  {canManage ? <th>操作</th> : null}
                </tr>
              </thead>
              <tbody>
                {versions.map((version) => (
                  <tr key={version.id}>
                    <td>
                      <strong>V{version.versionNumber}</strong>
                      <small>策略 v{version.version}</small>
                    </td>
                    <td>
                      <StatusBadge
                        label={productVersionStatusLabel(version.status)}
                        tone={pricingStatusTone(version.status)}
                      />
                    </td>
                    <td>
                      {formatMoney(version.policy.principalRange.hardMin)} –{" "}
                      {formatMoney(version.policy.principalRange.hardMax)}
                    </td>
                    <td>
                      {version.policy.termRange.hardMin}–{version.policy.termRange.hardMax} 月
                      <small>每 {version.policy.paymentFrequencyMonths} 月</small>
                    </td>
                    <td>
                      {version.policy.annualRateRangeBps.hardMin}–{version.policy.annualRateRangeBps.hardMax} bp
                    </td>
                    <td>
                      最多 {version.policy.maximumGracePeriods} 期
                      <small>{version.policy.allowedEndTermModes.map(endTermLabel).join(" / ")}</small>
                    </td>
                    <td>{version.authorizedDepartmentIds.join("、")}</td>
                    <td>{formatDateTime(version.updatedAt)}</td>
                    {canManage ? (
                      <td>
                        <div className="row-actions">
                          <button
                            className="icon-button quiet"
                            type="button"
                            title={version.status === "draft" ? "编辑策略" : "复制为新版本"}
                            aria-label={`${version.status === "draft" ? "编辑" : "复制"}版本 V${version.versionNumber}`}
                            disabled={submitting}
                            onClick={() => onEdit(version, product)}
                          >
                            {version.status === "draft" ? <Pencil size={15} /> : <CopyPlus size={15} />}
                          </button>
                          {version.status === "draft" ? (
                            <button
                              className="icon-button quiet success"
                              type="button"
                              title="发布版本"
                              aria-label={`发布版本 V${version.versionNumber}`}
                              disabled={submitting}
                              onClick={() => onPublish(version)}
                            >
                              <CheckCircle2 size={15} />
                            </button>
                          ) : null}
                          {version.status === "published" ? (
                            <button
                              className="icon-button quiet danger"
                              type="button"
                              title="退役版本"
                              aria-label={`退役版本 V${version.versionNumber}`}
                              disabled={submitting}
                              onClick={() => onRetire(version)}
                            >
                              <Archive size={15} />
                            </button>
                          ) : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

function QuoteWorkspace({
  quotes,
  projects,
  products,
  selected,
  canManage,
  submitting,
  onSelect,
  onCalculate,
  onFinalize,
  onRevise,
  onGenerateDocument,
  onDownloadDocument,
  onCreateContract,
}: {
  quotes: PricingQuote[];
  projects: LeaseProject[];
  products: PricingProduct[];
  selected: PricingQuote | null;
  canManage: boolean;
  submitting: boolean;
  onSelect: (id: string) => void;
  onCalculate: (quote: PricingQuote) => void;
  onFinalize: (quote: PricingQuote) => void;
  onRevise: (quote: PricingQuote) => void;
  onGenerateDocument: (quote: PricingQuote) => void;
  onDownloadDocument: (quote: PricingQuote) => void;
  onCreateContract: (quote: PricingQuote) => void;
}) {
  const projectMap = new Map(projects.map((item) => [item.id, item]));
  const productMap = new Map(products.map((item) => [item.id, item]));
  if (quotes.length === 0)
    return <EmptyState title="暂无报价" detail="选择授信通过的租赁项目和已发布产品版本开始报价" />;
  return (
    <div className={`pricing-quote-layout ${selected ? "has-detail" : ""}`}>
      <section className="pricing-quote-list" aria-label="报价列表">
        <div className="pricing-list-heading">
          <span>当前范围报价</span>
          <strong>{quotes.length}</strong>
        </div>
        {quotes.map((quote) => {
          const project = projectMap.get(quote.projectId);
          return (
            <button
              className={selected?.id === quote.id ? "selected" : ""}
              type="button"
              key={quote.id}
              aria-label={`查看报价 ${quote.quoteNumber}`}
              onClick={() => onSelect(quote.id)}
            >
              <span>
                <strong>{quote.quoteNumber}</strong>
                <small>{project?.name || quote.projectId}</small>
              </span>
              <span>
                <StatusBadge label={quoteStatusLabel(quote.status)} tone={pricingStatusTone(quote.status)} />
                <small>
                  R{quote.revisionNumber} · v{quote.version}
                </small>
              </span>
            </button>
          );
        })}
      </section>
      {selected ? (
        <QuoteInspector
          quote={selected}
          project={projectMap.get(selected.projectId)}
          product={productMap.get(selected.productId)}
          canManage={canManage}
          submitting={submitting}
          onCalculate={onCalculate}
          onFinalize={onFinalize}
          onRevise={onRevise}
          onGenerateDocument={onGenerateDocument}
          onDownloadDocument={onDownloadDocument}
          onCreateContract={onCreateContract}
        />
      ) : (
        <div className="pricing-inspector-placeholder">
          <FileOutput size={26} />
          <strong>选择一份报价</strong>
          <span>查看租金表、综合成本和偏离诊断</span>
        </div>
      )}
    </div>
  );
}

function QuoteInspector({
  quote,
  project,
  product,
  canManage,
  submitting,
  onCalculate,
  onFinalize,
  onRevise,
  onGenerateDocument,
  onDownloadDocument,
  onCreateContract,
}: {
  quote: PricingQuote;
  project?: LeaseProject;
  product?: PricingProduct;
  canManage: boolean;
  submitting: boolean;
  onCalculate: (quote: PricingQuote) => void;
  onFinalize: (quote: PricingQuote) => void;
  onRevise: (quote: PricingQuote) => void;
  onGenerateDocument: (quote: PricingQuote) => void;
  onDownloadDocument: (quote: PricingQuote) => void;
  onCreateContract: (quote: PricingQuote) => void;
}) {
  const calculation = quote.calculation;
  const finalized = quote.status === "finalized" || quote.status === "approved";
  return (
    <article className="pricing-quote-inspector">
      <header className="pricing-inspector-header">
        <div>
          <div className="eyebrow">
            R{quote.revisionNumber} / {product?.name || quote.productId}
          </div>
          <h2>{quote.quoteNumber}</h2>
          <p>{project?.name || quote.projectId}</p>
        </div>
        <div>
          <StatusBadge label={quoteStatusLabel(quote.status)} tone={pricingStatusTone(quote.status)} />
          <small>有效至 {formatDateTime(quote.validUntil)}</small>
        </div>
      </header>
      {canManage ? (
        <div className="pricing-action-bar">
          {quote.status === "draft" ? (
            <button
              className="button primary compact"
              type="button"
              disabled={submitting}
              onClick={() => onCalculate(quote)}
            >
              <Calculator size={15} />
              执行试算
            </button>
          ) : null}
          {quote.status === "calculated" ? (
            <button
              className="button primary compact"
              type="button"
              disabled={submitting || Boolean(calculation.blocksFinalization)}
              onClick={() => onFinalize(quote)}
            >
              <Send size={15} />
              提交定稿
            </button>
          ) : null}
          {quote.status !== "converted" ? (
            <button
              className="button secondary compact"
              type="button"
              disabled={submitting}
              onClick={() => onRevise(quote)}
            >
              <RefreshCw size={15} />
              创建修订
            </button>
          ) : null}
          {finalized && !quote.documentArtifactId ? (
            <button
              className="button secondary compact"
              type="button"
              disabled={submitting}
              onClick={() => onGenerateDocument(quote)}
            >
              <FilePlus2 size={15} />
              生成客户 PDF
            </button>
          ) : null}
          {quote.documentArtifactId ? (
            <button className="button secondary compact" type="button" onClick={() => onDownloadDocument(quote)}>
              <Download size={15} />
              下载 PDF
            </button>
          ) : null}
          {finalized ? (
            <button
              className="button secondary compact"
              type="button"
              disabled={submitting}
              onClick={() => onCreateContract(quote)}
            >
              <FileOutput size={15} />
              创建合同
            </button>
          ) : null}
        </div>
      ) : null}
      {quote.status === "approval_pending" ? (
        <div className="pricing-approval-strip">
          <ShieldAlert size={18} />
          <div>
            <strong>偏离审批处理中</strong>
            <span>须由独立定价经理复核，发起人与审批人不可相同</span>
          </div>
        </div>
      ) : null}
      {calculation.approvalRequired ? (
        <div className="pricing-deviation-summary">
          <ShieldAlert size={16} />
          <strong>需偏离审批</strong>
          <span>{calculation.deviations?.length || 0} 项策略偏离</span>
        </div>
      ) : null}
      {calculation.blocksFinalization ? (
        <div className="inline-alert" role="alert">
          IRR 诊断未收敛，当前报价不可定稿
        </div>
      ) : null}
      {calculation.customerCosts ? (
        <>
          <section className="pricing-metric-strip" aria-label="报价核心指标">
            <div>
              <span>客户综合成本</span>
              <strong>{formatMoney(calculation.customerCosts.total)}</strong>
              <small>利息、费用、净税费与期末款</small>
            </div>
            <div>
              <span>客户税前 XIRR</span>
              <strong>{formatRate(calculation.metrics?.lesseeGrossXirr?.roots?.[0])}</strong>
              <small>{xirrStatusLabel(calculation.metrics?.lesseeGrossXirr?.status)}</small>
            </div>
            <div>
              <span>客户税后 XIRR</span>
              <strong>{formatRate(calculation.metrics?.lesseeTaxAdjustedXirr?.roots?.[0])}</strong>
              <small>{xirrStatusLabel(calculation.metrics?.lesseeTaxAdjustedXirr?.status)}</small>
            </div>
            <div>
              <span>净融资额</span>
              <strong>{formatMoney(calculation.netFinancing)}</strong>
              <small>最大余额 {formatMoney(calculation.maximumBalance)}</small>
            </div>
          </section>
          <section className="pricing-breakdown">
            <h3>客户成本分解</h3>
            <dl>
              <div>
                <dt>租赁利息</dt>
                <dd>{formatMoney(calculation.customerCosts.interest)}</dd>
              </div>
              <div>
                <dt>客户费用</dt>
                <dd>{formatMoney(calculation.customerCosts.clientFees)}</dd>
              </div>
              <div>
                <dt>净税费</dt>
                <dd>{formatMoney(calculation.customerCosts.netTax)}</dd>
              </div>
              <div>
                <dt>期末客户支付</dt>
                <dd>{formatMoney(calculation.customerCosts.customerTerminal)}</dd>
              </div>
              <div>
                <dt>保证金利息抵减</dt>
                <dd>-{formatMoney(calculation.customerCosts.depositInterestCredit)}</dd>
              </div>
              <div>
                <dt>保证金余额</dt>
                <dd>{formatMoney(calculation.deposit?.closingBalance)}</dd>
              </div>
            </dl>
          </section>
        </>
      ) : (
        <EmptyState title="尚未试算" detail="执行试算后展示现金流、IRR、综合成本和策略偏离" />
      )}
      {(calculation.deviations?.length || 0) > 0 ? (
        <section className="pricing-deviations">
          <h3>策略偏离</h3>
          {calculation.deviations?.map((item) => (
            <div key={item.code}>
              <StatusBadge
                label={item.severity === "hard" ? "阻断" : "审批"}
                tone={item.severity === "hard" ? "danger" : "warning"}
              />
              <span>
                <strong>{item.code}</strong>
                <small>{item.message}</small>
              </span>
            </div>
          ))}
        </section>
      ) : null}
      {(calculation.schedule?.length || 0) > 0 ? (
        <section className="pricing-schedule">
          <div>
            <h3>租金计划</h3>
            <span>
              {calculation.schedule?.length} 期 · 截止 {calculation.scheduleSummary?.endDate}
            </span>
          </div>
          <div className="table-frame">
            <table>
              <thead>
                <tr>
                  <th>期次</th>
                  <th>到期日</th>
                  <th>期初本金</th>
                  <th>本金</th>
                  <th>到期利息</th>
                  <th>费用</th>
                  <th>税额</th>
                  <th>现金流</th>
                  <th>期末本金</th>
                </tr>
              </thead>
              <tbody>
                {calculation.schedule?.map((item) => (
                  <tr key={`${item.installmentNumber}-${item.dueDate}`}>
                    <td>{item.installmentNumber}</td>
                    <td>{item.dueDate}</td>
                    <td>{formatMoney(item.openingPrincipal)}</td>
                    <td>{formatMoney(item.principal)}</td>
                    <td>{formatMoney(item.dueInterest)}</td>
                    <td>{formatMoney(item.fee)}</td>
                    <td>{formatMoney(item.tax)}</td>
                    <td>
                      <strong>{formatMoney(item.grossCash)}</strong>
                    </td>
                    <td>{formatMoney(item.closingPrincipal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      {calculation.inputHash ? (
        <details className="pricing-trace">
          <summary>计算追踪与哈希</summary>
          <dl>
            <div>
              <dt>引擎版本</dt>
              <dd>{calculation.engineVersion}</dd>
            </div>
            <div>
              <dt>输入哈希</dt>
              <dd className="mono">{calculation.inputHash}</dd>
            </div>
            <div>
              <dt>输出哈希</dt>
              <dd className="mono">{calculation.outputHash}</dd>
            </div>
          </dl>
        </details>
      ) : null}
    </article>
  );
}

function ProductDialog({
  open,
  editing,
  form,
  setForm,
  submitting,
  error,
  close,
  submit,
}: {
  open: boolean;
  editing: PricingProductVersion | null;
  form: ProductForm;
  setForm: (next: ProductForm) => void;
  submitting: boolean;
  error: Error | null;
  close: () => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const set = <K extends keyof ProductForm>(key: K, value: ProductForm[K]) => setForm({ ...form, [key]: value });
  return (
    <Dialog
      open={open}
      title={
        editing ? `${editing.status === "draft" ? "编辑" : "复制"}产品版本 V${editing.versionNumber}` : "创建定价产品"
      }
      subtitle="配置硬边界、软偏离阈值、宽限期和期末处理策略"
      submitting={submitting}
      submitLabel={editing ? "保存产品版本" : "创建产品与 V1"}
      error={error}
      onClose={close}
      onSubmit={submit}
    >
      <div className="pricing-dialog-form product-policy-form">
        {!editing ? (
          <>
            <Field label="产品代码" required>
              <input value={form.code} onChange={(event) => set("code", event.target.value)} />
            </Field>
            <Field label="产品名称" required>
              <input value={form.name} onChange={(event) => set("name", event.target.value)} />
            </Field>
            <Field label="产品说明" span={2}>
              <textarea
                rows={2}
                value={form.description}
                onChange={(event) => set("description", event.target.value)}
              />
            </Field>
          </>
        ) : null}
        <Field label="授权部门（逗号分隔）" required span={2}>
          <input
            value={form.authorizedDepartmentIds}
            onChange={(event) => set("authorizedDepartmentIds", event.target.value)}
          />
        </Field>
        <div className="pricing-form-section span-2">
          <strong>计息与税费</strong>
        </div>
        <Field label="计息基础" required>
          <select
            value={form.dayCount}
            onChange={(event) => set("dayCount", event.target.value as ProductForm["dayCount"])}
          >
            <option value="ACT/365F">ACT/365F</option>
            <option value="ACT/360">ACT/360</option>
            <option value="30E/360">30E/360</option>
          </select>
        </Field>
        <Field label="支付频率（月）" required>
          <input
            type="number"
            min="1"
            value={form.paymentFrequencyMonths}
            onChange={(event) => set("paymentFrequencyMonths", event.target.value)}
          />
        </Field>
        <Field label="增值税率（基点）" required>
          <input
            type="number"
            min="0"
            value={form.vatRateBps}
            onChange={(event) => set("vatRateBps", event.target.value)}
          />
        </Field>
        <Field label="默认可抵扣税率（基点）">
          <input
            type="number"
            min="0"
            value={form.defaultVatRecoverableBps}
            onChange={(event) => set("defaultVatRecoverableBps", event.target.value)}
          />
        </Field>
        <div className="pricing-form-section span-2">
          <strong>本金、期限与利率边界</strong>
          <span>软边界触发审批，硬边界直接阻断</span>
        </div>
        <RangeFields
          label="本金"
          hardMin={form.principalHardMin}
          hardMax={form.principalHardMax}
          softMin={form.principalSoftMin}
          softMax={form.principalSoftMax}
          set={(part, value) => set(`principal${part}` as keyof ProductForm, value as never)}
        />
        <RangeFields
          label="期限（月）"
          hardMin={form.termHardMin}
          hardMax={form.termHardMax}
          softMin={form.termSoftMin}
          softMax={form.termSoftMax}
          set={(part, value) => set(`term${part}` as keyof ProductForm, value as never)}
        />
        <RangeFields
          label="年利率（基点）"
          hardMin={form.rateHardMin}
          hardMax={form.rateHardMax}
          softMin={form.rateSoftMin}
          softMax={form.rateSoftMax}
          set={(part, value) => set(`rate${part}` as keyof ProductForm, value as never)}
        />
        <div className="pricing-form-section span-2">
          <strong>特殊条款</strong>
        </div>
        <Field label="最大宽限期数">
          <input
            type="number"
            min="0"
            value={form.maximumGracePeriods}
            onChange={(event) => set("maximumGracePeriods", event.target.value)}
          />
        </Field>
        <Field label="报价有效天数">
          <input
            type="number"
            min="1"
            value={form.quoteValidityDays}
            onChange={(event) => set("quoteValidityDays", event.target.value)}
          />
        </Field>
        <Field label="负摊销软上限（基点）">
          <input
            type="number"
            min="0"
            value={form.negativeAmortizationSoftCapBps}
            onChange={(event) => set("negativeAmortizationSoftCapBps", event.target.value)}
          />
        </Field>
        <Field label="负摊销硬上限（基点）">
          <input
            type="number"
            min="0"
            value={form.negativeAmortizationHardCapBps}
            onChange={(event) => set("negativeAmortizationHardCapBps", event.target.value)}
          />
        </Field>
        <label className="toggle-row span-2">
          <input
            type="checkbox"
            checked={form.negativeAmortizationEnabled}
            onChange={(event) => set("negativeAmortizationEnabled", event.target.checked)}
          />
          <span>允许在阈值内出现负摊销并进入偏离审批</span>
        </label>
      </div>
    </Dialog>
  );
}

function RangeFields({
  label,
  hardMin,
  hardMax,
  softMin,
  softMax,
  set,
}: {
  label: string;
  hardMin: string;
  hardMax: string;
  softMin: string;
  softMax: string;
  set: (part: "HardMin" | "HardMax" | "SoftMin" | "SoftMax", value: string) => void;
}) {
  return (
    <div className="pricing-range-row span-2">
      <span>{label}</span>
      <label>
        硬下限
        <input aria-label={`${label}硬下限`} value={hardMin} onChange={(event) => set("HardMin", event.target.value)} />
      </label>
      <label>
        软下限
        <input aria-label={`${label}软下限`} value={softMin} onChange={(event) => set("SoftMin", event.target.value)} />
      </label>
      <label>
        软上限
        <input aria-label={`${label}软上限`} value={softMax} onChange={(event) => set("SoftMax", event.target.value)} />
      </label>
      <label>
        硬上限
        <input aria-label={`${label}硬上限`} value={hardMax} onChange={(event) => set("HardMax", event.target.value)} />
      </label>
    </div>
  );
}

function QuoteDialog({
  open,
  revising,
  projects,
  versions,
  form,
  setForm,
  submitting,
  error,
  close,
  submit,
}: {
  open: boolean;
  revising: PricingQuote | null;
  projects: LeaseProject[];
  versions: PricingProductVersion[];
  form: QuoteForm;
  setForm: (next: QuoteForm) => void;
  submitting: boolean;
  error: Error | null;
  close: () => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const set = <K extends keyof QuoteForm>(key: K, value: QuoteForm[K]) => setForm({ ...form, [key]: value });
  const eligibleVersions = versions.filter(
    (version) => version.status === "published" || version.id === form.productVersionId,
  );
  return (
    <Dialog
      open={open}
      title={revising ? `修订报价 ${revising.quoteNumber}` : "新建报价"}
      subtitle="客户条款进入确定性现金流引擎，试算后方可提交定稿"
      submitting={submitting}
      submitLabel={revising ? "创建修订草稿" : "保存报价草稿"}
      error={error}
      onClose={close}
      onSubmit={submit}
    >
      <div className="pricing-dialog-form pricing-quote-form">
        <div className="pricing-form-section span-2">
          <strong>项目与产品</strong>
        </div>
        <Field label="租赁项目" required>
          <select
            value={form.projectId}
            disabled={Boolean(revising)}
            onChange={(event) => set("projectId", event.target.value)}
          >
            <option value="">请选择</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name} · {formatMoney(project.requestedAmount)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="产品版本" required>
          <select
            value={form.productVersionId}
            disabled={Boolean(revising)}
            onChange={(event) => set("productVersionId", event.target.value)}
          >
            <option value="">请选择已发布版本</option>
            {eligibleVersions.map((version) => (
              <option key={version.id} value={version.id}>
                V{version.versionNumber} · {version.policy.dayCount} · 每 {version.policy.paymentFrequencyMonths} 月
              </option>
            ))}
          </select>
        </Field>
        <Field label="预计投放日" required>
          <input
            type="date"
            value={form.expectedFundingDate}
            onChange={(event) => set("expectedFundingDate", event.target.value)}
          />
        </Field>
        <Field label="起租日" required>
          <input
            type="date"
            value={form.leaseStartDate}
            onChange={(event) => set("leaseStartDate", event.target.value)}
          />
        </Field>
        <Field label="可抵扣税率（基点）">
          <input
            type="number"
            min="0"
            max="10000"
            value={form.vatRecoverableBps}
            onChange={(event) => set("vatRecoverableBps", event.target.value)}
          />
        </Field>
        <Field label="租金权重（逗号分隔）">
          <input
            value={form.scheduleWeights}
            placeholder="留空为等权"
            onChange={(event) => set("scheduleWeights", event.target.value)}
          />
        </Field>
        <div className="pricing-form-section span-2">
          <strong>宽限与租金</strong>
        </div>
        <Field label="宽限期数">
          <input
            type="number"
            min="0"
            value={form.gracePeriodCount}
            onChange={(event) => set("gracePeriodCount", event.target.value)}
          />
        </Field>
        <Field label="宽限方式">
          <select
            value={form.graceMode || "principal_only"}
            onChange={(event) => set("graceMode", event.target.value as QuoteForm["graceMode"])}
          >
            <option value="principal_only">仅本金宽限</option>
            <option value="full_defer_capitalized">本息递延并资本化</option>
            <option value="full_defer_lump_sum">本息递延期末一次支付</option>
          </select>
        </Field>
        <Field label="不规则租金期次">
          <input
            type="number"
            min="1"
            value={form.irregularInstallmentNumber}
            onChange={(event) => set("irregularInstallmentNumber", event.target.value)}
          />
        </Field>
        <Field label="第 2 期不规则租金">
          <input
            inputMode="decimal"
            value={form.irregularGrossRent}
            onChange={(event) => set("irregularGrossRent", event.target.value)}
          />
        </Field>
        <Field label="不规则到期日">
          <input
            type="date"
            value={form.irregularDueDate}
            onChange={(event) => set("irregularDueDate", event.target.value)}
          />
        </Field>
        <Field label="租期内费用">
          <input
            inputMode="decimal"
            value={form.scheduledFeeTotal}
            onChange={(event) => set("scheduledFeeTotal", event.target.value)}
          />
        </Field>
        <div className="pricing-form-section span-2">
          <strong>保证金</strong>
          <span>按收取批次 FIFO 计提单利，可退款或抵扣</span>
        </div>
        <Field label="保证金收取金额">
          <input
            inputMode="decimal"
            value={form.depositAmount}
            onChange={(event) => set("depositAmount", event.target.value)}
          />
        </Field>
        <Field label="保证金年利率（基点）">
          <input
            type="number"
            min="0"
            value={form.depositAnnualInterestBps}
            onChange={(event) => set("depositAnnualInterestBps", event.target.value)}
          />
        </Field>
        <Field label="保证金释放日">
          <input
            type="date"
            value={form.depositReleaseDate}
            onChange={(event) => set("depositReleaseDate", event.target.value)}
          />
        </Field>
        <Field label="保证金释放金额">
          <input
            inputMode="decimal"
            value={form.depositReleaseAmount}
            onChange={(event) => set("depositReleaseAmount", event.target.value)}
          />
        </Field>
        <Field label="释放方式">
          <select
            value={form.depositReleaseMethod}
            onChange={(event) => set("depositReleaseMethod", event.target.value as QuoteForm["depositReleaseMethod"])}
          >
            <option value="refund">退款</option>
            <option value="offset">抵扣</option>
          </select>
        </Field>
        <div className="pricing-form-section span-2">
          <strong>期末残值</strong>
        </div>
        <Field label="期末处理">
          <select
            value={form.endTermMode}
            onChange={(event) => set("endTermMode", event.target.value as QuoteForm["endTermMode"])}
          >
            <option value="purchase">客户留购</option>
            <option value="return">退回资产</option>
          </select>
        </Field>
        {form.endTermMode === "purchase" ? (
          <Field label="客户留购价">
            <input
              inputMode="decimal"
              value={form.customerPurchasePrice}
              onChange={(event) => set("customerPurchasePrice", event.target.value)}
            />
          </Field>
        ) : (
          <>
            <Field label="客户担保残值">
              <input
                inputMode="decimal"
                value={form.customerGuaranteedResidual}
                onChange={(event) => set("customerGuaranteedResidual", event.target.value)}
              />
            </Field>
            <Field label="资产预计残值">
              <input
                inputMode="decimal"
                value={form.assetResidualGross}
                onChange={(event) => set("assetResidualGross", event.target.value)}
              />
            </Field>
            <Field label="资产处置日">
              <input
                type="date"
                value={form.assetRealizationDate}
                onChange={(event) => set("assetRealizationDate", event.target.value)}
              />
            </Field>
            <Field label="处置成本">
              <input
                inputMode="decimal"
                value={form.disposalCost}
                onChange={(event) => set("disposalCost", event.target.value)}
              />
            </Field>
            <Field label="基础折价（基点）">
              <input
                type="number"
                min="0"
                max="10000"
                value={form.baseHaircutBps}
                onChange={(event) => set("baseHaircutBps", event.target.value)}
              />
            </Field>
            <Field label="压力折价（基点）">
              <input
                type="number"
                min="0"
                max="10000"
                value={form.stressHaircutBps}
                onChange={(event) => set("stressHaircutBps", event.target.value)}
              />
            </Field>
          </>
        )}
        <div className="pricing-form-section span-2">
          <strong>客户一次性费用</strong>
        </div>
        <Field label="费用金额">
          <input
            inputMode="decimal"
            value={form.clientFeeAmount}
            onChange={(event) => set("clientFeeAmount", event.target.value)}
          />
        </Field>
        <Field label="费用说明">
          <input
            value={form.clientFeeDescription}
            onChange={(event) => set("clientFeeDescription", event.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}

function ContractDialog({
  open,
  quote,
  form,
  setForm,
  submitting,
  error,
  close,
  submit,
}: {
  open: boolean;
  quote: PricingQuote | null;
  form: ContractForm;
  setForm: (next: ContractForm) => void;
  submitting: boolean;
  error: Error | null;
  close: () => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const set = <K extends keyof ContractForm>(key: K, value: ContractForm[K]) => setForm({ ...form, [key]: value });
  return (
    <Dialog
      open={open}
      title="从定稿报价创建合同"
      subtitle={`${quote?.quoteNumber || ""} 的策略、租金表和计算哈希将原样固化到合同`}
      submitting={submitting}
      submitLabel="创建合同"
      error={error}
      onClose={close}
      onSubmit={submit}
    >
      <div className="pricing-dialog-form">
        <Field label="合同编号" required>
          <input value={form.contractNumber} onChange={(event) => set("contractNumber", event.target.value)} />
        </Field>
        <Field label="租赁物唯一编号" required>
          <input value={form.uniqueNumber} onChange={(event) => set("uniqueNumber", event.target.value)} />
        </Field>
        <Field label="租赁物名称" required span={2}>
          <input value={form.assetName} onChange={(event) => set("assetName", event.target.value)} />
        </Field>
        <Field label="序列号">
          <input value={form.serialNumber} onChange={(event) => set("serialNumber", event.target.value)} />
        </Field>
        <Field label="购置价" required>
          <input
            inputMode="decimal"
            value={form.purchasePrice}
            onChange={(event) => set("purchasePrice", event.target.value)}
          />
        </Field>
        <Field label="权属证据引用" span={2}>
          <input
            value={form.ownershipEvidenceRef}
            onChange={(event) => set("ownershipEvidenceRef", event.target.value)}
          />
        </Field>
      </div>
    </Dialog>
  );
}

function defaultProductForm(session: Session): ProductForm {
  const departmentId = session.mode === "dev-headers" ? session.departmentId : "";
  return {
    code: "",
    name: "",
    description: "",
    authorizedDepartmentIds: departmentId,
    dayCount: "ACT/365F",
    paymentFrequencyMonths: "1",
    vatRateBps: "600",
    defaultVatRecoverableBps: "0",
    principalHardMin: "100000.00",
    principalHardMax: "100000000.00",
    principalSoftMin: "500000.00",
    principalSoftMax: "50000000.00",
    termHardMin: "6",
    termHardMax: "120",
    termSoftMin: "12",
    termSoftMax: "60",
    rateHardMin: "0",
    rateHardMax: "3000",
    rateSoftMin: "300",
    rateSoftMax: "1500",
    maximumGracePeriods: "6",
    negativeAmortizationEnabled: true,
    negativeAmortizationSoftCapBps: "100",
    negativeAmortizationHardCapBps: "1000",
    quoteValidityDays: "30",
  };
}

function productFormFromVersion(product: PricingProduct, version: PricingProductVersion): ProductForm {
  const policy = version.policy;
  return {
    code: product.code,
    name: product.name,
    description: product.description || "",
    authorizedDepartmentIds: version.authorizedDepartmentIds.join(","),
    dayCount: policy.dayCount,
    paymentFrequencyMonths: String(policy.paymentFrequencyMonths),
    vatRateBps: String(policy.vatRateBps),
    defaultVatRecoverableBps: String(policy.defaultVatRecoverableBps),
    principalHardMin: policy.principalRange.hardMin,
    principalHardMax: policy.principalRange.hardMax,
    principalSoftMin: policy.principalRange.softMin || "",
    principalSoftMax: policy.principalRange.softMax || "",
    termHardMin: String(policy.termRange.hardMin),
    termHardMax: String(policy.termRange.hardMax),
    termSoftMin: String(policy.termRange.softMin || ""),
    termSoftMax: String(policy.termRange.softMax || ""),
    rateHardMin: String(policy.annualRateRangeBps.hardMin),
    rateHardMax: String(policy.annualRateRangeBps.hardMax),
    rateSoftMin: String(policy.annualRateRangeBps.softMin || ""),
    rateSoftMax: String(policy.annualRateRangeBps.softMax || ""),
    maximumGracePeriods: String(policy.maximumGracePeriods),
    negativeAmortizationEnabled: policy.negativeAmortization.enabled,
    negativeAmortizationSoftCapBps: String(policy.negativeAmortization.softCapBps),
    negativeAmortizationHardCapBps: String(policy.negativeAmortization.hardCapBps),
    quoteValidityDays: String(policy.quoteValidityDays),
  };
}

function policyFromForm(form: ProductForm): PricingPolicy {
  const moneyRange = (hardMin: string, hardMax: string, softMin: string, softMax: string) => ({
    hardMin: nonNegativeMoney(hardMin, "本金硬下限"),
    hardMax: positiveMoney(hardMax, "本金硬上限"),
    ...(softMin ? { softMin: nonNegativeMoney(softMin, "本金软下限") } : {}),
    ...(softMax ? { softMax: nonNegativeMoney(softMax, "本金软上限") } : {}),
  });
  const integerRange = (hardMin: string, hardMax: string, softMin: string, softMax: string, label: string) => ({
    hardMin: nonNegativeInteger(hardMin, `${label}硬下限`),
    hardMax: positiveInteger(hardMax, `${label}硬上限`),
    ...(softMin ? { softMin: nonNegativeInteger(softMin, `${label}软下限`) } : {}),
    ...(softMax ? { softMax: nonNegativeInteger(softMax, `${label}软上限`) } : {}),
  });
  return {
    dayCount: form.dayCount,
    paymentFrequencyMonths: positiveInteger(form.paymentFrequencyMonths, "支付频率"),
    vatRateBps: boundedBps(form.vatRateBps, "增值税率"),
    defaultVatRecoverableBps: boundedBps(form.defaultVatRecoverableBps, "默认可抵扣税率"),
    principalRange: moneyRange(
      form.principalHardMin,
      form.principalHardMax,
      form.principalSoftMin,
      form.principalSoftMax,
    ),
    termRange: integerRange(form.termHardMin, form.termHardMax, form.termSoftMin, form.termSoftMax, "期限"),
    annualRateRangeBps: integerRange(form.rateHardMin, form.rateHardMax, form.rateSoftMin, form.rateSoftMax, "利率"),
    allowedGraceModes: ["principal_only", "full_defer_capitalized", "full_defer_lump_sum"],
    maximumGracePeriods: nonNegativeInteger(form.maximumGracePeriods, "最大宽限期数"),
    allowedEndTermModes: ["purchase", "return"],
    negativeAmortization: {
      enabled: form.negativeAmortizationEnabled,
      softCapBps: boundedBps(form.negativeAmortizationSoftCapBps, "负摊销软上限"),
      hardCapBps: boundedBps(form.negativeAmortizationHardCapBps, "负摊销硬上限"),
    },
    quoteValidityDays: positiveInteger(form.quoteValidityDays, "报价有效天数"),
  };
}

function defaultQuoteForm(project?: LeaseProject, version?: PricingProductVersion): QuoteForm {
  const fundingDate = addDays(currentDate(), 7);
  return {
    projectId: project?.id || "",
    productVersionId: version?.id || "",
    expectedFundingDate: fundingDate,
    leaseStartDate: fundingDate,
    vatRecoverableBps: String(version?.policy.defaultVatRecoverableBps || 0),
    scheduleWeights: "",
    gracePeriodCount: "0",
    graceMode: "principal_only",
    depositAmount: "",
    depositAnnualInterestBps: "",
    depositReleaseDate: "",
    depositReleaseAmount: "",
    depositReleaseMethod: "refund",
    endTermMode: "purchase",
    customerPurchasePrice: "0.00",
    customerGuaranteedResidual: "",
    assetResidualGross: "",
    assetRealizationDate: "",
    disposalCost: "",
    baseHaircutBps: "0",
    stressHaircutBps: "2000",
    irregularInstallmentNumber: "2",
    irregularDueDate: "",
    irregularGrossRent: "",
    scheduledFeeTotal: "",
    clientFeeAmount: "",
    clientFeeDescription: "服务费",
  };
}

function quoteFormFromQuote(quote: PricingQuote): QuoteForm {
  const base = defaultQuoteForm();
  const override = quote.terms.installmentOverrides?.[0];
  const collection = quote.terms.depositPlan.collections[0];
  const release = quote.terms.depositPlan.releases[0];
  const fee = quote.terms.clientCosts?.[0];
  return {
    ...base,
    projectId: quote.projectId,
    productVersionId: quote.productVersionId,
    expectedFundingDate: quote.terms.expectedFundingDate,
    leaseStartDate: quote.terms.leaseStartDate,
    vatRecoverableBps: String(quote.terms.vatRecoverableBps),
    scheduleWeights: quote.terms.scheduleWeights.join(","),
    gracePeriodCount: String(quote.terms.gracePeriodCount),
    graceMode: quote.terms.graceMode || "principal_only",
    depositAmount: collection?.amount || "",
    depositAnnualInterestBps: String(quote.terms.depositPlan.annualInterestBps || ""),
    depositReleaseDate: release?.date || "",
    depositReleaseAmount: release?.amount || "",
    depositReleaseMethod: release?.method || "refund",
    endTermMode: quote.terms.endTermPlan.mode,
    customerPurchasePrice: quote.terms.endTermPlan.customerPurchasePrice || "",
    customerGuaranteedResidual: quote.terms.endTermPlan.customerGuaranteedResidual || "",
    assetResidualGross: quote.terms.endTermPlan.assetResidualGross || "",
    assetRealizationDate: quote.terms.endTermPlan.assetRealizationDate || "",
    disposalCost: quote.terms.endTermPlan.disposalCost || "",
    baseHaircutBps: String(quote.terms.endTermPlan.baseHaircutBps || 0),
    stressHaircutBps: String(quote.terms.endTermPlan.stressHaircutBps || 0),
    irregularInstallmentNumber: String(override?.installmentNumber || 2),
    irregularDueDate: override?.dueDate || "",
    irregularGrossRent: override?.grossRent || "",
    scheduledFeeTotal: quote.terms.scheduledFeeTotal || "",
    clientFeeAmount: fee?.amount || "",
    clientFeeDescription: fee?.description || "服务费",
  };
}

function termsFromForm(form: QuoteForm, project: LeaseProject, policy: PricingPolicy): QuoteTerms {
  const periods = project.termMonths / policy.paymentFrequencyMonths;
  if (!Number.isInteger(periods) || periods < 1) throw new Error("项目期限必须能被产品支付频率整除");
  const weights = splitList(form.scheduleWeights);
  const scheduleWeights = weights.length > 0 ? weights : Array.from({ length: periods }, () => "1");
  if (scheduleWeights.length !== periods) throw new Error(`租金权重应填写 ${periods} 项`);
  const depositAmount = optionalMoney(form.depositAmount);
  const releaseAmount = optionalMoney(form.depositReleaseAmount);
  if (releaseAmount && !form.depositReleaseDate) throw new Error("填写保证金释放金额时必须选择释放日");
  const overrideRent = optionalMoney(form.irregularGrossRent);
  const installmentOverrides =
    overrideRent || form.irregularDueDate
      ? [
          {
            installmentNumber: positiveInteger(form.irregularInstallmentNumber, "不规则租金期次"),
            ...(form.irregularDueDate ? { dueDate: form.irregularDueDate } : {}),
            ...(overrideRent ? { grossRent: overrideRent } : {}),
          },
        ]
      : undefined;
  const clientFee = optionalMoney(form.clientFeeAmount);
  return {
    expectedFundingDate: required(form.expectedFundingDate, "预计投放日"),
    leaseStartDate: required(form.leaseStartDate, "起租日"),
    vatRecoverableBps: boundedBps(form.vatRecoverableBps, "可抵扣税率"),
    scheduleWeights,
    installmentOverrides,
    gracePeriodCount: nonNegativeInteger(form.gracePeriodCount, "宽限期数"),
    graceMode: form.graceMode || "principal_only",
    depositPlan: {
      annualInterestBps: boundedRateBps(form.depositAnnualInterestBps || "0", "保证金利率"),
      dayCount: policy.dayCount,
      collections: depositAmount ? [{ id: "deposit-1", date: form.expectedFundingDate, amount: depositAmount }] : [],
      releases: releaseAmount
        ? [{ date: form.depositReleaseDate, amount: releaseAmount, method: form.depositReleaseMethod }]
        : [],
    },
    endTermPlan:
      form.endTermMode === "purchase"
        ? { mode: "purchase", customerPurchasePrice: optionalMoney(form.customerPurchasePrice) || "0.00" }
        : {
            mode: "return",
            customerGuaranteedResidual: optionalMoney(form.customerGuaranteedResidual) || "0.00",
            assetResidualGross: optionalMoney(form.assetResidualGross) || "0.00",
            assetRealizationDate: form.assetRealizationDate || undefined,
            disposalCost: optionalMoney(form.disposalCost) || "0.00",
            baseHaircutBps: boundedBps(form.baseHaircutBps || "0", "基础折价"),
            stressHaircutBps: boundedBps(form.stressHaircutBps || "0", "压力折价"),
          },
    clientCosts: clientFee
      ? [
          {
            code: "client_fee",
            description: form.clientFeeDescription.trim() || "客户费用",
            date: form.expectedFundingDate,
            amount: clientFee,
          },
        ]
      : undefined,
    scheduledFeeTotal: optionalMoney(form.scheduledFeeTotal),
  };
}

function defaultContractForm(project?: LeaseProject): ContractForm {
  return {
    contractNumber: `LC-${currentDate().replace(/-/g, "")}-`,
    assetName: project?.assetDescription || "",
    uniqueNumber: "",
    serialNumber: "",
    purchasePrice: project?.requestedAmount || "",
    ownershipEvidenceRef: "",
  };
}

function firstPublishedVersion(versions: PricingProductVersion[]) {
  return versions.find((version) => version.status === "published");
}

function quoteStatusLabel(status: string) {
  return (
    {
      draft: "草稿",
      calculated: "已试算",
      approval_pending: "待偏离审批",
      approved: "审批通过",
      rejected: "审批拒绝",
      finalized: "已定稿",
      expired: "已过期",
      converted: "已转合同",
    }[status] || status
  );
}

function productVersionStatusLabel(status: string) {
  return { draft: "草稿", published: "已发布", retired: "已退役" }[status] || status;
}

function pricingStatusTone(status: string): "neutral" | "info" | "success" | "warning" | "danger" {
  if (["published", "approved", "finalized", "converted"].includes(status)) return "success";
  if (["approval_pending", "calculated"].includes(status)) return "warning";
  if (["rejected", "expired"].includes(status)) return "danger";
  if (status === "draft") return "info";
  return "neutral";
}

function endTermLabel(value: string) {
  return value === "purchase" ? "留购" : value === "return" ? "退回" : value;
}
function xirrStatusLabel(value?: string) {
  return value === "single_root"
    ? "已收敛"
    : value === "multiple_roots"
      ? "存在多解"
      : value === "no_root"
        ? "无有效根"
        : value || "未计算";
}

function formatRate(value?: string) {
  const number = Number(value);
  return Number.isFinite(number) ? `${(number * 100).toFixed(3)}%` : "--";
}

function required(value: string, label: string) {
  const clean = String(value || "").trim();
  if (!clean) throw new Error(`${label}不能为空`);
  return clean;
}

function positiveMoney(value: string, label: string) {
  const clean = nonNegativeMoney(value, label);
  if (Number(clean) <= 0) throw new Error(`${label}必须大于零`);
  return clean;
}

function nonNegativeMoney(value: string, label: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(String(value || "").trim()) || Number(value) < 0)
    throw new Error(`${label}必须是非负金额，最多两位小数`);
  return Number(value).toFixed(2);
}

function optionalMoney(value: string) {
  return String(value || "").trim() ? nonNegativeMoney(value, "金额") : undefined;
}

function positiveInteger(value: string, label: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label}必须是正整数`);
  return number;
}

function nonNegativeInteger(value: string, label: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label}必须是非负整数`);
  return number;
}

function boundedBps(value: string, label: string) {
  const number = nonNegativeInteger(value, label);
  if (number > 10000) throw new Error(`${label}不能超过 10000 基点`);
  return number;
}

function boundedRateBps(value: string, label: string) {
  const number = nonNegativeInteger(value, label);
  if (number > 100000) throw new Error(`${label}不能超过 100000 基点`);
  return number;
}

function splitList(value: string) {
  return value
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function currentDate() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(date: string, days: number) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}
