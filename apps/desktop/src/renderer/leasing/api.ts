import type {
  CommandReceipt,
  CreditApplication,
  CreditSubmitInput,
  Customer,
  CustomerCreateInput,
  DashboardSummary,
  DepositAccount,
  LeaseProject,
  ListResponse,
  ProjectCreateInput,
  Partner,
  PartnerAdmission,
  PartnerCreateInput,
  PartnerEvidenceUpload,
  CommissionAgreement,
  CommissionAccrual,
  CommissionSettlement,
  Session,
  LeaseContract,
  LeaseAsset,
  AssetRegistration,
  AssetInsurancePolicy,
  AssetAcceptance,
  AssetValuation,
  AssetResidualValue,
  AssetIdentifierHistory,
  AssetComplianceSummary,
  Disbursement,
  Receivable,
  LeasePayment,
  JournalEntry,
  Settlement,
  RentScheduleItem,
  DisbursementRequestInput,
  PaymentApplyInput,
  EarlySettlementInput,
  PostLeaseInspection,
  RiskWarning,
  RiskClassification,
  OverdueAging,
  CollectionAction,
  ContractRestructure,
  LegalCase,
  AssetDisposition,
  ReceivableWriteOff,
  CustomerGroup,
  PartyProfile,
  UBODetermination,
  RatingSnapshot,
  CreditFacility,
  FacilityUtilization,
  LimitLedgerEntry,
  PartyProfileChange,
  DueDiligenceSnapshot,
  DueDiligenceException,
  RiskImportBatch,
  RiskImportPreflight,
  PricingProduct,
  PricingProductDetail,
  PricingProjectContext,
  PricingQuote,
  PricingPolicy,
  QuoteTerms,
} from "./types";
import type {
  LeasingMultipartField,
  LeasingMultipartFile,
  LeasingRequestBody,
  LeasingRequestInput,
  LeasingRequestMethod,
  LeasingResponse,
} from "@supbot/shared";

export class LeasingAPIError extends Error {
  readonly status: number;
  readonly payload: unknown;
  readonly requestId?: string;

  constructor(message: string, status: number, payload: unknown, requestId?: string) {
    super(message);
    this.name = "LeasingAPIError";
    this.status = status;
    this.payload = payload;
    this.requestId = requestId;
  }

  get isConflict(): boolean {
    return this.status === 409 || this.status === 412 || this.status === 428;
  }
}

export function fetchDashboard(session: Session, signal?: AbortSignal): Promise<DashboardSummary> {
  return requestJSON("/dashboard", { method: "GET", signal }, session);
}

export function fetchCustomers(session: Session, signal?: AbortSignal): Promise<ListResponse<Customer>> {
  return requestList("/customers", session, signal);
}

export function fetchProjects(session: Session, signal?: AbortSignal): Promise<ListResponse<LeaseProject>> {
  return requestList("/projects", session, signal);
}

export const fetchPartners = (session: Session, signal?: AbortSignal) =>
  requestList<Partner>("/partners", session, signal);
export const fetchPartnerAdmissions = (session: Session, signal?: AbortSignal) =>
  requestList<PartnerAdmission>("/partner-admissions", session, signal);
export const fetchCommissionAgreements = (session: Session, signal?: AbortSignal) =>
  requestList<CommissionAgreement>("/commission-agreements", session, signal);
export const fetchCommissionAccruals = (session: Session, signal?: AbortSignal) =>
  requestList<CommissionAccrual>("/commission-accruals", session, signal);
export const fetchCommissionSettlements = (session: Session, signal?: AbortSignal) =>
  requestList<CommissionSettlement>("/commission-settlements", session, signal);

export function fetchCreditApplications(
  session: Session,
  signal?: AbortSignal,
): Promise<ListResponse<CreditApplication>> {
  return requestList("/credit-applications", session, signal);
}

export const fetchCustomerGroups = (session: Session, signal?: AbortSignal) =>
  requestList<CustomerGroup>("/customer-groups", session, signal);
export const fetchPartyProfile = (session: Session, customerId: string, signal?: AbortSignal) =>
  requestJSON<PartyProfile>(
    `/customers/${encodeURIComponent(customerId)}/party-profile`,
    { method: "GET", signal },
    session,
  );
export const fetchPartyProfileChanges = (session: Session, customerId: string, signal?: AbortSignal) =>
  requestList<PartyProfileChange>(
    `/customers/${encodeURIComponent(customerId)}/party-profile-changes`,
    session,
    signal,
  );
export const fetchUBODeterminations = (session: Session, customerId: string, signal?: AbortSignal) =>
  requestList<UBODetermination>(`/customers/${encodeURIComponent(customerId)}/ubo`, session, signal);
export const fetchRatingSnapshots = (session: Session, customerId: string, signal?: AbortSignal) =>
  requestList<RatingSnapshot>(`/customers/${encodeURIComponent(customerId)}/ratings`, session, signal);
export const fetchDueDiligenceSnapshots = (session: Session, customerId: string, signal?: AbortSignal) =>
  requestList<DueDiligenceSnapshot>(
    `/customers/${encodeURIComponent(customerId)}/due-diligence-snapshots`,
    session,
    signal,
  );
export const fetchDiligenceExceptions = (session: Session, customerId: string, signal?: AbortSignal) =>
  requestList<DueDiligenceException>(
    `/customers/${encodeURIComponent(customerId)}/due-diligence-exceptions`,
    session,
    signal,
  );
export const fetchCreditFacilities = (session: Session, signal?: AbortSignal) =>
  requestList<CreditFacility>("/credit-facilities", session, signal);
export const fetchFacilityUtilization = (session: Session, facilityId: string, signal?: AbortSignal) =>
  requestJSON<FacilityUtilization>(
    `/credit-facilities/${encodeURIComponent(facilityId)}/utilization`,
    { method: "GET", signal },
    session,
  );
export const fetchLimitLedger = (session: Session, facilityId = "", signal?: AbortSignal) =>
  requestList<LimitLedgerEntry>(
    `/limit-ledger${facilityId ? `?facilityId=${encodeURIComponent(facilityId)}` : ""}`,
    session,
    signal,
  );
export const fetchRiskImports = (session: Session, signal?: AbortSignal) =>
  requestList<RiskImportBatch>("/risk-imports", session, signal);
export const preflightRiskImport = (session: Session, csv: string, signal?: AbortSignal) =>
  requestJSON<RiskImportPreflight>(
    "/risk-imports/preflight",
    { method: "POST", headers: { "Content-Type": "text/csv; charset=utf-8" }, body: csv, signal },
    session,
  );
export async function downloadRiskImportTemplate(session: Session): Promise<void> {
  void session;
  const response = await requestLeasingFile("/risk-imports/template", "text/csv");
  const url = URL.createObjectURL(bridgeResponseBlob(response, "text/csv"));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "customer-risk-v1.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

export const executeCreditRiskCommand = (
  session: Session,
  commandType: string,
  body: unknown,
  key: string,
  version?: number,
) => submitCommand(session, commandType, body, key, version);

export const fetchContracts = (session: Session, signal?: AbortSignal) =>
  requestList<LeaseContract>("/contracts", session, signal);
export const fetchDepositAccounts = (session: Session, signal?: AbortSignal) =>
  requestList<DepositAccount>("/deposit-accounts", session, signal);
export const fetchContractDepositAccount = (session: Session, contractId: string, signal?: AbortSignal) =>
  requestJSON<DepositAccount>(
    `/contracts/${encodeURIComponent(contractId)}/deposit-account`,
    { method: "GET", signal },
    session,
  );
export const fetchAssets = (session: Session, signal?: AbortSignal) =>
  requestList<LeaseAsset>("/assets", session, signal);
export const fetchAsset = (session: Session, assetId: string, signal?: AbortSignal) =>
  requestJSON<LeaseAsset>(`/assets/${encodeURIComponent(assetId)}`, { method: "GET", signal }, session);
export const fetchAssetRegistrations = (session: Session, assetId: string, signal?: AbortSignal) =>
  requestList<AssetRegistration>(`/assets/${encodeURIComponent(assetId)}/registrations`, session, signal);
export const fetchAssetInsurancePolicies = (session: Session, assetId: string, signal?: AbortSignal) =>
  requestList<AssetInsurancePolicy>(`/assets/${encodeURIComponent(assetId)}/insurance-policies`, session, signal);
export const fetchAssetAcceptances = (session: Session, assetId: string, signal?: AbortSignal) =>
  requestList<AssetAcceptance>(`/assets/${encodeURIComponent(assetId)}/acceptances`, session, signal);
export const fetchAssetValuations = (session: Session, assetId: string, signal?: AbortSignal) =>
  requestList<AssetValuation>(`/assets/${encodeURIComponent(assetId)}/valuations`, session, signal);
export const fetchAssetResidualValues = (session: Session, assetId: string, signal?: AbortSignal) =>
  requestList<AssetResidualValue>(`/assets/${encodeURIComponent(assetId)}/residual-values`, session, signal);
export const fetchAssetIdentifierHistory = (session: Session, assetId: string, signal?: AbortSignal) =>
  requestList<AssetIdentifierHistory>(`/assets/${encodeURIComponent(assetId)}/identifier-history`, session, signal);
export const fetchAssetComplianceSummary = (session: Session, signal?: AbortSignal) =>
  requestJSON<AssetComplianceSummary>("/asset-compliance-summary", { method: "GET", signal }, session);
export const fetchDisbursements = (session: Session, signal?: AbortSignal) =>
  requestList<Disbursement>("/disbursements", session, signal);
export const fetchReceivables = (session: Session, signal?: AbortSignal) =>
  requestList<Receivable>("/receivables", session, signal);
export const fetchPayments = (session: Session, signal?: AbortSignal) =>
  requestList<LeasePayment>("/payments", session, signal);
export const fetchJournalEntries = (session: Session, signal?: AbortSignal) =>
  requestList<JournalEntry>("/accounting-entries", session, signal);
export const fetchSettlements = (session: Session, signal?: AbortSignal) =>
  requestList<Settlement>("/settlements", session, signal);
export const fetchRentSchedule = (session: Session, contractId: string, signal?: AbortSignal) =>
  requestList<RentScheduleItem>(`/contracts/${encodeURIComponent(contractId)}/rent-schedule`, session, signal);
export const fetchPostLeaseInspections = (session: Session, signal?: AbortSignal) =>
  requestList<PostLeaseInspection>("/postlease/inspections", session, signal);
export const fetchRiskWarnings = (session: Session, signal?: AbortSignal) =>
  requestList<RiskWarning>("/postlease/risk-warnings", session, signal);
export const fetchRiskClassifications = (session: Session, signal?: AbortSignal) =>
  requestList<RiskClassification>("/postlease/risk-classifications", session, signal);
export const fetchOverdueAging = (session: Session, signal?: AbortSignal) =>
  requestList<OverdueAging>("/postlease/overdue-aging", session, signal);
export const fetchCollectionActions = (session: Session, signal?: AbortSignal) =>
  requestList<CollectionAction>("/collection/actions", session, signal);
export const fetchContractRestructures = (session: Session, signal?: AbortSignal) =>
  requestList<ContractRestructure>("/postlease/restructures", session, signal);
export const fetchLegalCases = (session: Session, signal?: AbortSignal) =>
  requestList<LegalCase>("/postlease/legal-cases", session, signal);
export const fetchAssetDispositions = (session: Session, signal?: AbortSignal) =>
  requestList<AssetDisposition>("/postlease/asset-dispositions", session, signal);
export const fetchReceivableWriteOffs = (session: Session, signal?: AbortSignal) =>
  requestList<ReceivableWriteOff>("/postlease/write-offs", session, signal);
export const fetchPricingProducts = (session: Session, signal?: AbortSignal) =>
  requestList<PricingProduct>("/pricing/products", session, signal);
export const fetchPricingProduct = (session: Session, productId: string, signal?: AbortSignal) =>
  requestJSON<PricingProductDetail>(
    `/pricing/products/${encodeURIComponent(productId)}`,
    { method: "GET", signal },
    session,
  );
export const fetchPricingQuotes = (session: Session, signal?: AbortSignal) =>
  requestList<PricingQuote>("/pricing/quotes", session, signal);
export const fetchPricingQuote = (session: Session, quoteId: string, signal?: AbortSignal) =>
  requestJSON<PricingQuote>(`/pricing/quotes/${encodeURIComponent(quoteId)}`, { method: "GET", signal }, session);
export const fetchPricingProjectContext = (session: Session, projectId: string, signal?: AbortSignal) =>
  requestJSON<PricingProjectContext>(
    `/projects/${encodeURIComponent(projectId)}/pricing-context`,
    { method: "GET", signal },
    session,
  );

export function createCustomer(
  session: Session,
  body: CustomerCreateInput,
  idempotencyKey: string,
): Promise<CommandReceipt> {
  return submitCommand(session, "customer.create", body, idempotencyKey);
}

export function createProject(
  session: Session,
  body: ProjectCreateInput,
  idempotencyKey: string,
): Promise<CommandReceipt> {
  return submitCommand(session, "project.create", body, idempotencyKey);
}

export const createPartner = (session: Session, body: PartnerCreateInput, key: string) =>
  submitCommand(session, "partner.create", body, key);
export const attachPartnerEvidence = (session: Session, body: unknown, key: string) =>
  submitCommand(session, "partner.evidence.attach", body, key);
export function uploadPartnerEvidence(session: Session, partnerId: string, file: File): Promise<PartnerEvidenceUpload> {
  const body = new FormData();
  body.set("file", file);
  return requestJSON(`/partners/${encodeURIComponent(partnerId)}/evidence/files`, { method: "POST", body }, session);
}
export const createPartnerAdmission = (session: Session, body: unknown, key: string) =>
  submitCommand(session, "partner.admission.create", body, key);
export const evaluatePartnerAdmission = (session: Session, body: unknown, key: string, version: number) =>
  submitCommand(session, "partner.admission.evaluate", body, key, version);
export const submitPartnerAdmission = (session: Session, admissionId: string, key: string, version: number) =>
  submitCommand(session, "partner.admission.submit", { admissionId }, key, version);
export const suspendPartnerAdmission = (session: Session, body: unknown, key: string, version: number) =>
  submitCommand(session, "partner.admission.suspend", body, key, version);
export const createCommissionAgreement = (session: Session, body: unknown, key: string) =>
  submitCommand(session, "commission.agreement.create", body, key);
export const submitCommissionAgreement = (session: Session, agreementId: string, key: string, version: number) =>
  submitCommand(session, "commission.agreement.submit", { agreementId }, key, version);
export const prepareCommissionSettlement = (session: Session, body: unknown, key: string) =>
  submitCommand(session, "commission.settlement.prepare", body, key);
export const submitCommissionSettlement = (session: Session, settlementId: string, key: string, version: number) =>
  submitCommand(session, "commission.settlement.submit", { settlementId }, key, version);
export const recordCommissionPayment = (session: Session, body: unknown, key: string) =>
  submitCommand(session, "commission.payment.record", body, key);
export const createCommissionAdjustment = (session: Session, body: unknown, key: string) =>
  submitCommand(session, "commission.adjustment.create", body, key);

export const createPricingProduct = (
  session: Session,
  body: { code: string; name: string; description?: string; policy: PricingPolicy; authorizedDepartmentIds: string[] },
  key: string,
) => submitCommand(session, "pricing.product.create", body, key);
export const updatePricingProductVersion = (
  session: Session,
  productVersionId: string,
  policy: PricingPolicy,
  authorizedDepartmentIds: string[],
  key: string,
  version: number,
) =>
  submitCommand(
    session,
    "pricing.product.version.update",
    { productVersionId, policy, authorizedDepartmentIds },
    key,
    version,
  );
export const publishPricingProductVersion = (
  session: Session,
  productVersionId: string,
  key: string,
  version: number,
) => submitCommand(session, "pricing.product.version.publish", { productVersionId }, key, version);
export const retirePricingProductVersion = (session: Session, productVersionId: string, key: string, version: number) =>
  submitCommand(session, "pricing.product.version.retire", { productVersionId }, key, version);
export const createPricingQuote = (
  session: Session,
  projectId: string,
  productVersionId: string,
  terms: QuoteTerms,
  key: string,
) => submitCommand(session, "pricing.quote.create", { projectId, productVersionId, terms }, key);
export const calculatePricingQuote = (session: Session, quoteId: string, key: string, version: number) =>
  submitCommand(session, "pricing.quote.calculate", { quoteId }, key, version);
export const finalizePricingQuote = (session: Session, quoteId: string, key: string, version: number) =>
  submitCommand(session, "pricing.quote.finalize", { quoteId }, key, version);
export const revisePricingQuote = (
  session: Session,
  quoteId: string,
  terms: QuoteTerms,
  key: string,
  version: number,
) => submitCommand(session, "pricing.quote.revise", { quoteId, terms }, key, version);
export const generatePricingQuoteDocument = (session: Session, quoteId: string, key: string, version: number) =>
  submitCommand(session, "pricing.quote.document.generate", { quoteId }, key, version);
export const convertPricingQuoteToContract = (
  session: Session,
  body: {
    quoteId: string;
    contractNumber: string;
    assets: Array<{
      name: string;
      uniqueNumber: string;
      serialNumber?: string;
      vin?: string;
      purchasePrice: string;
      ownershipEvidenceRef?: string;
    }>;
  },
  key: string,
  version: number,
) => submitCommand(session, "contract.create", body, key, version);

export async function downloadPricingQuoteDocument(
  session: Session,
  quoteId: string,
): Promise<{ blob: Blob; filename: string }> {
  void session;
  const response = await requestLeasingFile(
    `/pricing/quotes/${encodeURIComponent(quoteId)}/document`,
    "application/pdf",
  );
  const disposition = response.headers?.["content-disposition"] || response.headers?.["Content-Disposition"] || "";
  const filename = decodeURIComponent(
    disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1] || `pricing-quote-${quoteId}.pdf`,
  );
  return { blob: bridgeResponseBlob(response, "application/pdf"), filename };
}

export function submitCredit(
  session: Session,
  body: CreditSubmitInput,
  idempotencyKey: string,
  expectedProjectVersion: number,
): Promise<CommandReceipt> {
  return submitCommand(session, "credit.submit", body, idempotencyKey, expectedProjectVersion);
}

export function verifyAssetOwnership(
  session: Session,
  assetId: string,
  evidenceReference: string,
  idempotencyKey: string,
  expectedVersion: number,
) {
  return submitCommand(
    session,
    "asset.ownership.verify",
    { assetId, evidenceReference },
    idempotencyKey,
    expectedVersion,
  );
}

export const executeAssetCommand = (
  session: Session,
  commandType: string,
  body: unknown,
  idempotencyKey: string,
  expectedVersion: number,
) => submitCommand(session, commandType, body, idempotencyKey, expectedVersion);

export function requestDisbursement(
  session: Session,
  body: DisbursementRequestInput,
  idempotencyKey: string,
  expectedContractVersion: number,
) {
  return submitCommand(session, "disbursement.request", body, idempotencyKey, expectedContractVersion);
}

export function recordDepositCollection(
  session: Session,
  body: { contractId: string; amount: string; valueDate: string; externalReference: string },
  idempotencyKey: string,
  expectedAccountVersion: number,
) {
  return submitCommand(session, "deposit.collection.record", body, idempotencyKey, expectedAccountVersion);
}

export function applyPayment(
  session: Session,
  body: PaymentApplyInput,
  idempotencyKey: string,
  expectedContractVersion: number,
) {
  return submitCommand(session, "payment.apply", body, idempotencyKey, expectedContractVersion);
}

export function earlySettleContract(
  session: Session,
  body: EarlySettlementInput,
  idempotencyKey: string,
  expectedContractVersion: number,
) {
  return submitCommand(session, "contract.early-settle", body, idempotencyKey, expectedContractVersion);
}

export const recordPostLeaseInspection = (session: Session, body: unknown, key: string, version: number) =>
  submitCommand(session, "postlease.inspection.record", body, key, version);
export const raiseRiskWarning = (session: Session, body: unknown, key: string, version: number) =>
  submitCommand(session, "risk.warning.raise", body, key, version);
export const changeRiskClassification = (session: Session, body: unknown, key: string, version: number) =>
  submitCommand(session, "risk.classification.change", body, key, version);
export const recordCollectionAction = (session: Session, body: unknown, key: string, version: number) =>
  submitCommand(session, "collection.action.record", body, key, version);
export const requestContractRestructure = (session: Session, body: unknown, key: string, version: number) =>
  submitCommand(session, "contract.restructure", body, key, version);
export const openLegalCase = (session: Session, body: unknown, key: string, version: number) =>
  submitCommand(session, "legal.case.open", body, key, version);
export const requestAssetDisposition = (session: Session, body: unknown, key: string, version: number) =>
  submitCommand(session, "asset.dispose", body, key, version);
export const requestReceivableWriteOff = (session: Session, body: unknown, key: string, version: number) =>
  submitCommand(session, "receivable.write-off", body, key, version);
async function requestList<T>(path: string, session: Session, signal?: AbortSignal): Promise<ListResponse<T>> {
  const payload = await requestJSON<ListResponse<T> | T[]>(path, { method: "GET", signal }, session);
  if (Array.isArray(payload)) {
    return { items: payload, total: payload.length };
  }
  return { items: Array.isArray(payload.items) ? payload.items : [], total: Number(payload.total || 0) };
}

async function submitCommand<TBody>(
  session: Session,
  commandType: string,
  body: TBody,
  idempotencyKey: string,
  expectedVersion?: number,
): Promise<CommandReceipt> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Idempotency-Key": idempotencyKey,
  };
  if (expectedVersion !== undefined) {
    headers["If-Match"] = `"${expectedVersion}"`;
  }
  return requestJSON(
    `/commands/${encodeURIComponent(commandType)}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    session,
  );
}

/**
 * The main process owns the leasing endpoint and all authentication headers.
 * Keep this bridge deliberately small: pages can only send a relative path,
 * method, application headers, and a serialisable request body.
 */
interface LeasingBridge {
  requestLeasing(input: LeasingRequestInput): Promise<LeasingResponse>;
}

function leasingBridge(): LeasingBridge {
  return window.supbot as unknown as LeasingBridge;
}

async function requestLeasingFile(path: string, accept: string): Promise<LeasingResponse> {
  const response = await leasingBridge().requestLeasing({ path, method: "GET", headers: { Accept: accept } });
  if (!response.ok) {
    throw responseError(response);
  }
  return response;
}

function bridgeResponseBlob(response: LeasingResponse, mimeType: string): Blob {
  if (response.body.encoding === "base64") {
    const binary = atob(response.body.data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
  }
  if (response.body.encoding === "text") {
    return new Blob([response.body.data], { type: mimeType });
  }
  if (response.body.encoding === "json") {
    return new Blob([JSON.stringify(response.body.data)], { type: mimeType });
  }
  return new Blob([], { type: mimeType });
}

export async function requestJSON<T>(path: string, init: RequestInit, session: Session): Promise<T> {
  void session;
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  const bridgeHeaders: Record<string, string> = {};
  headers.forEach((value, key) => {
    bridgeHeaders[key] = value;
  });
  const response = await leasingBridge().requestLeasing({
    path,
    method: (init.method || "GET").toUpperCase() as LeasingRequestMethod,
    headers: bridgeHeaders,
    body: await serialiseRequestBody(init.body),
  });
  if (!response.ok) {
    throw responseError(response);
  }
  if (response.body.encoding === "empty") {
    return undefined as T;
  }
  if (response.body.encoding === "json") {
    return response.body.data as T;
  }
  if (response.body.encoding === "text") {
    try {
      return JSON.parse(response.body.data) as T;
    } catch {
      return response.body.data as T;
    }
  }
  throw new LeasingAPIError("Expected a JSON response", response.status, response.body);
}

async function serialiseRequestBody(body: BodyInit | null | undefined): Promise<LeasingRequestBody | undefined> {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof FormData) {
    const fields: LeasingMultipartField[] = [];
    const files: LeasingMultipartFile[] = [];
    const pending: Promise<void>[] = [];
    body.forEach((value, name) => {
      if (typeof value === "string") {
        fields.push({ name, value });
        return;
      }
      pending.push(
        value.arrayBuffer().then((buffer) => {
          files.push({
            fieldName: name,
            fileName: value.name,
            contentType: value.type || undefined,
            contentBase64: bytesToBase64(new Uint8Array(buffer)),
          });
        }),
      );
    });
    await Promise.all(pending);
    return { encoding: "multipart", fields, files };
  }
  if (body instanceof Blob) {
    return { encoding: "base64", data: bytesToBase64(new Uint8Array(await body.arrayBuffer())) };
  }
  if (body instanceof ArrayBuffer) {
    return { encoding: "base64", data: bytesToBase64(new Uint8Array(body)) };
  }
  if (ArrayBuffer.isView(body)) {
    return { encoding: "base64", data: bytesToBase64(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)) };
  }
  throw new TypeError("Unsupported leasing request body");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function responseError(response: LeasingResponse): LeasingAPIError {
  const rawPayload =
    response.body.encoding === "json"
      ? response.body.data
      : response.body.encoding === "text"
        ? parseTextPayload(response.body.data)
        : response.body;
  const payload = rawPayload as {
    error?: string | { code?: string; message?: string };
    error_description?: string;
    message?: string;
    requestId?: string;
  } | null;
  const nestedError = payload?.error && typeof payload.error === "object" ? payload.error : undefined;
  const stringError = typeof payload?.error === "string" ? payload.error : undefined;
  const message =
    nestedError?.message ||
    payload?.message ||
    payload?.error_description ||
    stringError ||
    response.statusText ||
    `请求失败 (${response.status})`;
  return new LeasingAPIError(message, response.status, payload, payload?.requestId);
}

function parseTextPayload(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { message: value };
  }
}

export function newIdempotencyKey(prefix: string): string {
  if (typeof window.crypto.randomUUID === "function") {
    return `${prefix}-${window.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
