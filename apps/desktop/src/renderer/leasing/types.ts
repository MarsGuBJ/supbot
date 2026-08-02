export type Session = OIDCSession | DevSession;

export interface OIDCSession {
  mode: "oidc-token";
  accessToken: string;
  userId?: string;
  displayName?: string;
}

export interface DevSession {
  mode: "dev-headers";
  tenantId: string;
  organizationId: string;
  departmentId: string;
  userId: string;
  roleIds: string[];
}

export interface ResourceFields {
  id: string;
  tenantId: string;
  organizationId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Customer extends ResourceFields {
  name: string;
  unifiedSocialCreditCode: string;
  industry: string;
  contactName: string;
  contactPhone: string;
}

export type LeaseType = "direct" | "sale_and_leaseback";

export interface LeaseProject extends ResourceFields {
  customerId: string;
  customerName?: string;
  name: string;
  leaseType: LeaseType;
  requestedAmount: string;
  termMonths: number;
  annualRateBps: number;
  assetDescription: string;
  status: string;
}

export interface CreditApplication extends ResourceFields {
  projectId: string;
  projectName?: string;
  customerName?: string;
  requestedLimit: string;
  approvedLimit?: string;
  riskNotes: string;
  facilityId?: string;
  memberSublimitId?: string;
  ratingSnapshotId?: string;
  dueDiligenceSnapshotId?: string;
  exceptionApprovalId?: string;
  status: string;
}

export interface CustomerGroup extends ResourceFields {
  groupCode: string;
  name: string;
  leadCustomerId: string;
  status: string;
  validFrom: string;
  validUntil?: string;
  createdByUserId: string;
  reviewedByUserId?: string;
}

export interface Party {
  id: string;
  type: "customer" | "organization" | "person";
  name: string;
  unifiedSocialCreditCode?: string;
  customerId?: string;
  status: string;
  version: number;
}

export interface PartyRelationship {
  id: string;
  fromPartyId: string;
  toPartyId: string;
  relationshipType: string;
  ownershipBps?: number;
  controlBasis?: string;
  validFrom: string;
  validUntil?: string;
  evidenceReference: string;
  status: string;
}

export interface PartyProfile {
  parties: ListResponse<Party>;
  relationships: ListResponse<PartyRelationship>;
}

export interface PartyProfileChange extends ResourceFields {
  customerId: string;
  status: string;
  submittedByUserId: string;
  reviewedByUserId?: string;
  reviewReason?: string;
  parties: Array<Pick<Party, "id" | "type" | "name" | "unifiedSocialCreditCode" | "customerId">>;
  relationships: Array<Omit<PartyRelationship, "id" | "status">>;
}

export interface UBOPath {
  partyId: string;
  partyName: string;
  path: string[];
  ownershipBps: number;
  controlBasis?: string;
}
export interface UBODetermination extends ResourceFields {
  customerId: string;
  ruleVersion: string;
  thresholdBps: number;
  paths: UBOPath[];
  manualReason?: string;
  validUntil: string;
  manualRequired: boolean;
  status: string;
  submittedByUserId: string;
  reviewedByUserId?: string;
}

export interface RatingSnapshot extends ResourceFields {
  customerId: string;
  ratingBatchId: string;
  modelId: string;
  modelVersion: string;
  modelArtifactHash: string;
  score: string;
  grade: string;
  ratedAt: string;
  validUntil: string;
  evidenceHash: string;
  status: string;
}

export interface DueDiligenceSnapshot extends ResourceFields {
  customerId: string;
  ratingSnapshotId: string;
  uboDeterminationId: string;
  aiSummaryDraftId?: string;
  materialRefs: string[];
  completeness: string[];
  status: string;
  validUntil: string;
  createdByUserId: string;
}
export interface DueDiligenceException extends ResourceFields {
  customerId: string;
  reason: string;
  validUntil: string;
  status: string;
  requestedByUserId: string;
  reviewedByUserId?: string;
  reviewReason?: string;
}

export interface CreditFacility extends ResourceFields {
  subjectType: "customerGroup" | "customer";
  subjectId: string;
  parentFacilityId?: string;
  approvedLimit: string;
  pendingApprovedLimit?: string;
  currency: "CNY";
  validFrom: string;
  validUntil: string;
  status: string;
  submittedByUserId: string;
  reviewedByUserId?: string;
}

export interface FacilityUtilization {
  facility: CreditFacility;
  committed: string;
  used: string;
  available: string;
}
export interface LimitLedgerEntry {
  id: string;
  facilityId: string;
  creditApplicationId?: string;
  contractId?: string;
  entryType: string;
  committedDelta: string;
  usedDelta: string;
  sourceEventId: string;
  createdAt: string;
}

export interface RiskImportRow {
  line: number;
  recordType: "group" | "member" | "party" | "relationship";
  groupCode?: string;
  groupName?: string;
  leadCustomerId?: string;
  profileCustomerId?: string;
  customerId?: string;
  partyId?: string;
  partyType?: string;
  partyName?: string;
  unifiedSocialCreditCode?: string;
  fromPartyId?: string;
  toPartyId?: string;
  relationshipType?: string;
  ownershipBps?: number;
  controlBasis?: string;
  validFrom?: string;
  validUntil?: string;
  evidenceReference?: string;
}
export interface RiskImportError {
  line: number;
  field: string;
  code: string;
  message: string;
}
export interface RiskImportPreflight {
  valid: boolean;
  templateVersion: string;
  contentHash: string;
  rows: RiskImportRow[];
  errors: RiskImportError[];
  errorCsv: string;
}
export interface RiskImportBatch extends ResourceFields {
  templateVersion: string;
  contentHash: string;
  rows: RiskImportRow[];
  status: string;
  submittedByUserId: string;
  reviewedByUserId?: string;
  reviewReason?: string;
}

export interface DashboardSummary {
  counts: {
    customers: number;
    projects: number;
    creditApplications: number;
    contracts?: number;
    assets?: number;
    openReceivables?: number;
  };
  projectAmounts: {
    requestedTotal: string;
  };
  creditAmounts: {
    requestedLimitTotal: string;
  };
  portfolioAmounts?: {
    contractPrincipalTotal: string;
    receivableOutstanding: string;
    cashCollectedTotal: string;
  };
}

export interface LeaseContract extends ResourceFields {
  projectId: string;
  customerId: string;
  contractNumber: string;
  leaseType: LeaseType;
  principal: string;
  annualRateBps: number;
  termMonths: number;
  paymentFrequencyMonths: number;
  startDate: string;
  endDate: string;
  upfrontFee: string;
  vatRateBps: number;
  residualValue: string;
  totalInterest: string;
  totalTax: string;
  totalRent: string;
  status: string;
  createdByUserId: string;
  depositRequiredAmount?: string;
  depositAccountId?: string;
  depositCollectedAmount?: string;
  depositAvailableAmount?: string;
  depositStatus?: string;
  depositAccountingStatus?: string;
}

export interface DepositCollectionLot {
  id: string;
  depositAccountId: string;
  contractId: string;
  externalReference: string;
  valueDate: string;
  amount: string;
  collectionLotNumber: number;
  createdAt: string;
}

export interface DepositAccount extends ResourceFields {
  departmentId: string;
  contractId: string;
  requiredAmount: string;
  collectedAmount: string;
  releasedAmount: string;
  availableAmount: string;
  status: string;
  accountingStatus: string;
  collections: DepositCollectionLot[];
}

export interface RentScheduleItem {
  id: string;
  contractId: string;
  installmentNumber: number;
  dueDate: string;
  openingPrincipal: string;
  principal: string;
  interest: string;
  fee: string;
  tax: string;
  total: string;
  closingPrincipal: string;
}

export interface LeaseAsset extends ResourceFields {
  contractId: string;
  name: string;
  uniqueNumber: string;
  serialNumber?: string;
  vin?: string;
  assetType: "equipment" | "vehicle" | "ship" | "aircraft" | "real_estate" | "other";
  brand?: string;
  model?: string;
  manufacturer?: string;
  manufactureDate?: string;
  location?: string;
  engineNumber?: string;
  licensePlateNumber?: string;
  vehicleUse?: string;
  firstRegistrationDate?: string;
  purchasePrice: string;
  ownershipEvidenceRef?: string;
  ownershipStatus: string;
  acceptanceStatus: string;
  registrationStatus: string;
  insuranceStatus: string;
  registrationRequired: boolean;
  insuranceRequired: boolean;
  controlProfile: string;
  contractualResidualValue: string;
  forecastResidualValue: string;
  actualDisposalNetProceeds: string;
  lastValuationDate?: string;
  nextValuationDate?: string;
  status: string;
  createdByUserId: string;
}

export interface AssetRegistration extends ResourceFields {
  assetId: string;
  registrationType: string;
  registrationNumber: string;
  certificateNumber: string;
  registeredOwner: string;
  authority: string;
  jurisdiction: string;
  effectiveDate: string;
  expiryDate?: string;
  evidenceRef: string;
  providerMode: string;
  providerReference?: string;
  responseHash?: string;
  status: string;
  recordedByUserId: string;
  cancelledByUserId?: string;
  cancellationReason?: string;
}
export interface AssetInsurancePolicy extends ResourceFields {
  assetId: string;
  policyNumber: string;
  insurer: string;
  coverageTypes: string[];
  insuredAmount: string;
  deductible: string;
  premium: string;
  insuredParty: string;
  beneficiary: string;
  startDate: string;
  endDate: string;
  evidenceRef: string;
  providerMode: string;
  providerReference?: string;
  responseHash?: string;
  status: string;
  recordedByUserId: string;
  cancelledByUserId?: string;
  cancellationReason?: string;
}
export interface AssetAcceptance extends ResourceFields {
  contractId: string;
  assetId: string;
  acceptanceType: string;
  acceptanceDate: string;
  location: string;
  result: string;
  assetCondition: string;
  meterReading?: string;
  meterUnit?: string;
  findings: string;
  checklist: Array<{ code: string; result: string; note?: string; evidenceRefs?: string[] }>;
  evidenceRefs: string[];
  status: string;
  requestedByUserId: string;
  reviewedByUserId?: string;
}
export interface AssetValuation extends ResourceFields {
  contractId: string;
  assetId: string;
  purpose: string;
  baseDate: string;
  method: string;
  marketValue: string;
  forcedSaleValue: string;
  recommendedResidualValue: string;
  valuerType: string;
  valuerName: string;
  valuerOrganization?: string;
  reportRef: string;
  nextValuationDate: string;
  status: string;
  requestedByUserId: string;
  reviewedByUserId?: string;
}
export interface AssetResidualValue extends ResourceFields {
  contractId: string;
  assetId: string;
  sourceType: string;
  valuationId?: string;
  effectiveDate: string;
  contractualValue: string;
  forecastValue: string;
  actualNetProceeds: string;
  deviationBps: number;
  reason: string;
  evidenceRef: string;
  status: string;
  requestedByUserId: string;
  reviewedByUserId?: string;
}
export interface AssetIdentifierHistory {
  id: string;
  assetId: string;
  identifierType: string;
  oldValue: string;
  newValue: string;
  reason: string;
  evidenceRef: string;
  changedByUserId: string;
  createdAt: string;
}
export interface AssetComplianceSummary {
  total: number;
  pendingAcceptance: number;
  missingRegistration: number;
  missingInsurance: number;
  insuranceExpiring: number;
  valuationDue: number;
  residualAtRisk: number;
}

export interface Disbursement extends ResourceFields {
  contractId: string;
  amount: string;
  payeeName: string;
  bankAccountRef: string;
  conditionChecks: string[];
  status: string;
  requestedByUserId: string;
  approvedAt?: string;
}

export interface Receivable extends ResourceFields {
  contractId: string;
  scheduleItemId: string;
  installmentNumber: number;
  dueDate: string;
  principal: string;
  interest: string;
  fee: string;
  tax: string;
  paidPrincipal: string;
  paidInterest: string;
  paidFee: string;
  paidTax: string;
  waivedInterest: string;
  waivedFee: string;
  waivedTax: string;
  outstanding: string;
  status: string;
}

export interface PaymentAllocation {
  receivableId: string;
  principal: string;
  interest: string;
  fee: string;
  tax: string;
  total: string;
}

export interface LeasePayment {
  id: string;
  tenantId: string;
  organizationId: string;
  contractId: string;
  amount: string;
  appliedAmount: string;
  unappliedAmount: string;
  valueDate: string;
  externalReference: string;
  status: string;
  allocations: PaymentAllocation[];
  createdAt: string;
}

export interface JournalLine {
  accountCode: string;
  debit: string;
  credit: string;
  description: string;
}
export interface JournalEntry {
  id: string;
  tenantId: string;
  organizationId: string;
  contractId: string;
  sourceType: string;
  sourceId: string;
  entryDate: string;
  status: string;
  totalDebit: string;
  totalCredit: string;
  lines: JournalLine[];
  createdAt: string;
}

export interface Settlement {
  id: string;
  contractId: string;
  settlementDate: string;
  principal: string;
  accruedInterest: string;
  accruedFee: string;
  tax: string;
  penaltyFee: string;
  amount: string;
  externalReference: string;
  status: string;
  createdAt: string;
}

export interface PostLeaseInspection extends ResourceFields {
  contractId: string;
  inspectionDate: string;
  inspectionType: string;
  assetCondition: string;
  findings: string;
  riskSignals: string[];
  nextDueDate: string;
  status: string;
  recordedByUserId: string;
}
export interface RiskWarning extends ResourceFields {
  contractId: string;
  signalCode: string;
  severity: string;
  summary: string;
  evidenceRef?: string;
  status: string;
  raisedByUserId: string;
}
export interface RiskClassification extends ResourceFields {
  contractId: string;
  classification: string;
  effectiveDate: string;
  reason: string;
  sourceInspectionId?: string;
  status: string;
  requestedByUserId: string;
}
export interface OverdueAging {
  receivableId: string;
  contractId: string;
  dueDate: string;
  asOfDate: string;
  daysOverdue: number;
  bucket: string;
  outstanding: string;
}
export interface CollectionAction {
  id: string;
  contractId: string;
  receivableId: string;
  actionType: string;
  occurredAt: string;
  contactName?: string;
  outcome: string;
  promiseDate?: string;
  promiseAmount: string;
  notes?: string;
  recordedByUserId: string;
  version: number;
  createdAt: string;
}
export interface ContractRestructure extends ResourceFields {
  contractId: string;
  reason: string;
  effectiveDate: string;
  newTermMonths: number;
  newAnnualRateBps: number;
  gracePeriodMonths: number;
  capitalizedAmount: string;
  status: string;
  requestedByUserId: string;
}
export interface LegalCase extends ResourceFields {
  contractId: string;
  caseType: string;
  court?: string;
  externalCaseNumber?: string;
  claimAmount: string;
  summary: string;
  status: string;
  openedByUserId: string;
}
export interface AssetDisposition extends ResourceFields {
  contractId: string;
  assetId: string;
  action: string;
  reason: string;
  counterparty?: string;
  expectedProceeds: string;
  evidenceRef: string;
  status: string;
  requestedByUserId: string;
}
export interface ReceivableWriteOff extends ResourceFields {
  contractId: string;
  receivableId: string;
  amount: string;
  reason: string;
  evidenceRef: string;
  status: string;
  requestedByUserId: string;
}

export interface GeneralLedgerEntry {
  lineNumber: number;
  ledgerReference: string;
  controlCode: string;
  accountCode: string;
  debit: string;
  credit: string;
  sourceType: string;
  sourceId: string;
}

export interface GeneralLedgerSnapshot {
  id: string;
  tenantId: string;
  organizationId: string;
  departmentId: string;
  accountingPeriod: string;
  sourceSystem: string;
  batchReference: string;
  sourceBatchHash: string;
  contentHash: string;
  totalDebit: string;
  totalCredit: string;
  entries: GeneralLedgerEntry[];
  importedByUserId: string;
  version: number;
  createdAt: string;
}

export interface GeneralLedgerControlReconciliation {
  controlCode: string;
  accountCode: string;
  subledgerDebit: string;
  subledgerCredit: string;
  generalLedgerDebit: string;
  generalLedgerCredit: string;
  matched: boolean;
}

export interface GeneralLedgerEntryRegisterInput {
  ledgerReference: string;
  controlCode: string;
  accountCode: string;
  debit: string;
  credit: string;
  sourceType: string;
  sourceId: string;
}

export interface GeneralLedgerSnapshotRegisterInput {
  accountingPeriod: string;
  sourceSystem: string;
  batchReference: string;
  sourceBatchHash: string;
  entries: GeneralLedgerEntryRegisterInput[];
}

export interface MonthCloseRequestInput {
  accountingPeriod: string;
  generalLedgerSnapshotId: string;
  notes: string;
}

export interface VATInvoiceMatchInput {
  invoiceId: string;
  generalLedgerSnapshotId: string;
  ledgerReference: string;
  matchedTaxAmount: string;
}

export interface MonthClose extends ResourceFields {
  accountingPeriod: string;
  generalLedgerSnapshotId: string;
  generalLedgerSnapshotHash: string;
  subledgerDebit: string;
  subledgerCredit: string;
  generalLedgerDebit: string;
  generalLedgerCredit: string;
  vatInputTax: string;
  vatOutputTax: string;
  generalLedgerTaxInput: string;
  generalLedgerTaxOutput: string;
  controlReconciliation: GeneralLedgerControlReconciliation[];
  reconciliationStatus: string;
  status: string;
  notes: string;
  requestedByUserId: string;
  approvedByUserId?: string;
}

export interface VATInvoice extends ResourceFields {
  direction: "input" | "output";
  invoiceCode: string;
  invoiceNumber: string;
  invoiceDate: string;
  counterpartyName: string;
  taxRateBps: number;
  netAmount: string;
  taxAmount: string;
  grossAmount: string;
  sourceType: string;
  sourceId: string;
  ledgerReference?: string;
  matchedTaxAmount: string;
  status: string;
  registeredByUserId: string;
  matchedByUserId?: string;
}

export interface TreasuryFacility extends ResourceFields {
  facilityNumber: string;
  lenderName: string;
  facilityType: "revolving" | "non_revolving" | "bond_program";
  currency: string;
  approvedLimit: string;
  usedAmount: string;
  availableAmount: string;
  annualRateBps: number;
  startDate: string;
  endDate: string;
  status: string;
  registeredByUserId: string;
}

export interface TreasuryFunding extends ResourceFields {
  facilityId: string;
  fundingType: "bank_loan" | "bond" | "shareholder_loan";
  fundingReference: string;
  currency: string;
  amount: string;
  outstandingAmount: string;
  annualCostBps: number;
  drawdownDate: string;
  maturityDate: string;
  status: string;
  recordedByUserId: string;
}

export interface LiquiditySummary {
  asOfDate: string;
  totalFacilityLimit: string;
  totalFacilityUsed: string;
  totalFacilityAvailable: string;
  fundingOutstanding: string;
  maturingWithin30Days: string;
  maturingWithin90Days: string;
  maturingWithin365Days: string;
  weightedAverageCostBps: number;
}

export interface RegulatoryMetrics {
  activeContractCount: number;
  contractPrincipal: string;
  receivableOutstanding: string;
  overdueOutstanding: string;
  fundingOutstanding: string;
  liquidityAvailable: string;
  overdueRatioBps: number;
}

export interface RegulatoryReportSummary {
  id: string;
  reportCode: string;
  reportingPeriod: string;
  schemaVersion: string;
  reportVersion: number;
  payloadHash: string;
  metrics: RegulatoryMetrics;
  sourceSnapshotId: string;
  sourceHash: string;
  correctionOfReportId?: string;
  correctionReason?: string;
  revisionOfReportId?: string;
  revisionReason?: string;
  status: string;
  preparedByUserId: string;
  approvedByUserId?: string;
  submissionReference?: string;
  submittedAt?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RegulatoryReport extends RegulatoryReportSummary {
  tenantId: string;
  organizationId: string;
  departmentId: string;
  payload: unknown;
  exportArtifact?: unknown;
  submissionReceipt?: unknown;
}

export interface OperatingAnalyticsSnapshot {
  id: string;
  tenantId: string;
  organizationId: string;
  departmentId: string;
  asOfDate: string;
  activeContractCount: number;
  contractPrincipal: string;
  receivableOutstanding: string;
  overdueOutstanding: string;
  cashCollected: string;
  fundingOutstanding: string;
  liquidityAvailable: string;
  liquidityShortfall30d: string;
  overdueRatioBps: number;
  capturedByUserId: string;
  version: number;
  createdAt: string;
}

export interface ListResponse<T> {
  items: T[];
  total: number;
}

export interface CommandReceipt {
  commandId: string;
  flowExecutionId?: string;
  auditId: string;
  status: string;
  resourceType?: string;
  resourceId?: string;
  version?: number;
  createdAt?: string;
}

export interface CustomerCreateInput {
  name: string;
  unifiedSocialCreditCode: string;
  industry: string;
  contactName: string;
  contactPhone: string;
}

export interface ProjectCreateInput {
  customerId: string;
  name: string;
  leaseType: LeaseType;
  requestedAmount: string;
  termMonths: number;
  annualRateBps: number;
  assetDescription: string;
  vendorIds?: string[];
  channelId?: string;
  commissionMode?: "none" | "agreement";
  commissionAgreementId?: string;
  noCommissionReason?: string;
  businessRegion?: string;
  industry?: string;
}

export type PartnerRole = "vendor" | "channel";

export interface PartnerVendorProfile {
  productCategories?: string[];
  brandAuthorizations?: string[];
  supplyRegions?: string[];
  deliveryCapability?: string;
  qualityCapability?: string;
  afterSalesCapability?: string;
}

export interface PartnerChannelProfile {
  channelType?: string;
  coverageRegions?: string[];
  coverageIndustries?: string[];
  acquisitionMethod?: string;
  historicalPerformance?: string;
}

export interface Partner extends ResourceFields {
  name: string;
  unifiedSocialCreditCode: string;
  legalRepresentative: string;
  registeredAddress: string;
  contactName: string;
  contactPhone: string;
  bankName: string;
  bankAccount: string;
  roles: PartnerRole[];
  vendorProfile?: PartnerVendorProfile;
  channelProfile?: PartnerChannelProfile;
  engagement?: {
    id: string;
    departmentId: string;
    roles: PartnerRole[];
    ownerUserId: string;
    status: string;
    version: number;
  };
  status: string;
}

export interface PartnerCreateInput {
  name: string;
  unifiedSocialCreditCode: string;
  legalRepresentative: string;
  registeredAddress: string;
  contactName: string;
  contactPhone: string;
  bankName: string;
  bankAccount: string;
  roles: PartnerRole[];
  ownerUserId: string;
  vendorProfile?: PartnerVendorProfile;
  channelProfile?: PartnerChannelProfile;
}

export interface PartnerEvidenceUpload {
  artifactId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

export interface AdmissionCondition {
  type: string;
  value: string;
  dueDate?: string;
  acknowledged?: boolean;
}

export interface PartnerAdmission extends ResourceFields {
  partnerId: string;
  initiatingDepartmentId: string;
  initiatorUserId: string;
  role: PartnerRole;
  reason: string;
  status: string;
  ratingExecutionId?: string;
  modelId?: string;
  modelVersion?: string;
  score: number;
  recommendation?: string;
  disqualifiers?: string[];
  conditions: AdmissionCondition[];
  decisionReason?: string;
  checkerUserIds?: string[];
  validUntil?: string;
  suspensionReason?: string;
  alerts?: Array<{
    type: string;
    severity: string;
    message: string;
    reminderDays?: number;
    daysUntilExpiry?: number;
    requiresReevaluation?: boolean;
  }>;
}

export interface CommissionAgreement extends ResourceFields {
  departmentId: string;
  channelPartnerId: string;
  agreementNumber: string;
  calculationType: "fixed" | "rate";
  fixedAmount?: string;
  rateBps?: number;
  minimumAmount?: string;
  maximumAmount?: string;
  effectiveFrom: string;
  effectiveTo: string;
  status: string;
  initiatorUserId: string;
  checkerUserIds?: string[];
  decisionReason?: string;
  approvedAt?: string;
}

export interface CommissionAccrual {
  id: string;
  tenantId: string;
  organizationId: string;
  departmentId: string;
  projectId: string;
  channelPartnerId: string;
  disbursementId: string;
  commissionSnapshotId: string;
  disbursementAmount: string;
  amount: string;
  currency: string;
  accountingPeriod: string;
  status: string;
  adjustmentOfAccrualId?: string;
  reason?: string;
  createdAt: string;
}

export interface CommissionPayment {
  id: string;
  settlementId: string;
  paymentDate: string;
  amount: string;
  currency: string;
  externalReference: string;
  recordedByUserId: string;
  createdAt: string;
}

export interface CommissionSettlement extends ResourceFields {
  departmentId: string;
  channelPartnerId: string;
  accountingPeriod: string;
  totalAmount: string;
  currency: string;
  status: string;
  initiatorUserId: string;
  checkerUserIds?: string[];
  decisionReason?: string;
  items: Array<{ id: string; settlementId: string; accrualId: string; amount: string }>;
  payments: CommissionPayment[];
}

export type DayCountConvention = "ACT/365F" | "ACT/360" | "30E/360";
export type GraceMode = "principal_only" | "full_defer_capitalized" | "full_defer_lump_sum";
export type EndTermMode = "purchase" | "return";
export type PricingProductVersionStatus = "draft" | "published" | "retired";
export type PricingQuoteStatus =
  "draft" | "calculated" | "approval_pending" | "approved" | "rejected" | "finalized" | "expired" | "converted";

export interface MoneyRange {
  hardMin: string;
  hardMax: string;
  softMin?: string;
  softMax?: string;
}

export interface IntegerRange {
  hardMin: number;
  hardMax: number;
  softMin?: number;
  softMax?: number;
}

export interface PricingPolicy {
  dayCount: DayCountConvention;
  paymentFrequencyMonths: number;
  vatRateBps: number;
  defaultVatRecoverableBps: number;
  principalRange: MoneyRange;
  termRange: IntegerRange;
  annualRateRangeBps: IntegerRange;
  allowedGraceModes: GraceMode[];
  maximumGracePeriods: number;
  allowedEndTermModes: EndTermMode[];
  negativeAmortization: { enabled: boolean; softCapBps: number; hardCapBps: number };
  quoteValidityDays: number;
}

export interface PricingProduct extends ResourceFields {
  code: string;
  name: string;
  description?: string;
  latestVersionNumber: number;
  publishedVersionId?: string;
  status: string;
  createdByUserId: string;
}

export interface PricingProductVersion extends ResourceFields {
  productId: string;
  versionNumber: number;
  status: PricingProductVersionStatus;
  policy: PricingPolicy;
  authorizedDepartmentIds: string[];
  createdByUserId: string;
  publishedByUserId?: string;
  publishedAt?: string;
  retiredAt?: string;
}

export interface PricingProductDetail {
  product: PricingProduct;
  versions: PricingProductVersion[];
}

export interface PricingCost {
  code: string;
  description?: string;
  date: string;
  amount: string;
}

export interface DepositPlan {
  annualInterestBps: number;
  dayCount: DayCountConvention;
  collections: Array<{ id: string; date: string; amount: string }>;
  releases: Array<{ date: string; amount: string; method: "refund" | "offset" }>;
}

export interface QuoteTerms {
  expectedFundingDate: string;
  leaseStartDate: string;
  vatRecoverableBps: number;
  scheduleWeights: string[];
  installmentOverrides?: Array<{ installmentNumber: number; dueDate?: string; grossRent?: string }>;
  gracePeriodCount: number;
  graceMode?: GraceMode;
  depositPlan: DepositPlan;
  endTermPlan: {
    mode: EndTermMode;
    customerPurchasePrice?: string;
    customerGuaranteedResidual?: string;
    assetResidualGross?: string;
    assetRealizationDate?: string;
    disposalCost?: string;
    baseHaircutBps?: number;
    stressHaircutBps?: number;
  };
  clientCosts?: PricingCost[];
  lessorCosts?: PricingCost[];
  scheduledFeeTotal?: string;
}

export interface PricingScheduleItem {
  itemType: string;
  installmentNumber: number;
  dueDate: string;
  openingPrincipal: string;
  accruedInterest: string;
  dueInterest: string;
  capitalizedInterest: string;
  deferredInterest: string;
  principal: string;
  fee: string;
  grossRent: string;
  tax: string;
  grossCash: string;
  closingPrincipal: string;
}

export interface PricingCalculation {
  engineVersion: string;
  inputHash: string;
  outputHash: string;
  schedule: PricingScheduleItem[];
  scheduleSummary: {
    totalPrincipal: string;
    totalAccruedInterest: string;
    totalDueInterest: string;
    totalCapitalizedInterest: string;
    totalFee: string;
    totalTax: string;
    totalGrossCash: string;
    endDate: string;
  };
  deposit: { totalCollected: string; totalReleased: string; totalInterest: string; closingBalance: string };
  residual: { customerTerminalAmount: string; baseAssetProceeds: string; stressAssetProceeds: string };
  metrics: {
    lesseeGrossXirr: { status: string; roots: string[]; diagnostic?: string; blocksFinalization?: boolean };
    lesseeTaxAdjustedXirr: { status: string; roots: string[]; diagnostic?: string; blocksFinalization?: boolean };
    lessorBaseXirr?: { status: string; roots: string[] };
    lessorStressXirr?: { status: string; roots: string[] };
    simpleAnnualizedCost: string;
  };
  customerCosts: {
    interest: string;
    clientFees: string;
    grossTax: string;
    recoverableTax: string;
    netTax: string;
    customerTerminal: string;
    depositInterestCredit: string;
    total: string;
  };
  netFinancing: string;
  maximumBalance: string;
  negativeAmortBps: number;
  deviations: Array<{ code: string; severity: string; message: string }>;
  approvalRequired: boolean;
  blocksFinalization: boolean;
}

export interface PricingQuote extends ResourceFields {
  departmentId: string;
  projectId: string;
  productId: string;
  productVersionId: string;
  quoteNumber: string;
  revisionNumber: number;
  parentQuoteId?: string;
  terms: QuoteTerms;
  calculation: Partial<PricingCalculation>;
  status: PricingQuoteStatus;
  validUntil: string;
  convertedContractId?: string;
  documentArtifactId?: string;
  createdByUserId: string;
  approvedByUserId?: string;
}

export interface PricingProjectContext {
  projectId: string;
  leaseType: string;
  principal: string;
  termMonths: number;
  annualRateBps: number;
  projectStatus: string;
  creditApproved: boolean;
  eligibleProductVersionIds: string[];
  commission?: PricingCost[];
}

export interface CreditSubmitInput {
  projectId: string;
  requestedLimit: string;
  riskNotes: string;
  facilityId?: string;
  memberSublimitId?: string;
  ratingSnapshotId?: string;
  dueDiligenceSnapshotId?: string;
  exceptionApprovalId?: string;
}

export interface ContractCreateInput {
  projectId: string;
  contractNumber: string;
  leaseType: LeaseType;
  principal: string;
  annualRateBps: number;
  termMonths: number;
  paymentFrequencyMonths: number;
  startDate: string;
  upfrontFee: string;
  vatRateBps: number;
  residualValue: string;
  assets: AssetCreateInput[];
}

export interface AssetCreateInput {
  name: string;
  uniqueNumber: string;
  serialNumber?: string;
  vin?: string;
  assetType: "equipment" | "vehicle" | "ship" | "aircraft" | "real_estate" | "other";
  brand?: string;
  model?: string;
  manufacturer?: string;
  manufactureDate?: string;
  location?: string;
  engineNumber?: string;
  licensePlateNumber?: string;
  vehicleUse?: string;
  firstRegistrationDate?: string;
  registrationRequired?: boolean;
  insuranceRequired?: boolean;
  contractualResidualValue?: string;
  purchasePrice: string;
  ownershipEvidenceRef?: string;
}

export interface DisbursementRequestInput {
  contractId: string;
  amount: string;
  payeeName: string;
  bankAccountRef: string;
  conditionChecks: string[];
}
export interface PaymentApplyInput {
  contractId: string;
  amount: string;
  valueDate: string;
  externalReference: string;
}
export interface EarlySettlementInput {
  contractId: string;
  settlementDate: string;
  penaltyFee: string;
  externalReference: string;
}

export type WorkspaceKey =
  | "dashboard"
  | "customers"
  | "partners"
  | "projects"
  | "credit"
  | "risk-rating"
  | "group-credit"
  | "pricing"
  | "contracts-assets"
  | "receivables-payments"
  | "post-lease";

export type AuditTab = "operations" | "workflow-dispatches" | "event-deliveries";

export interface AuditFilters {
  from: string;
  to: string;
  departmentId: string;
  correlationId: string;
  actorUserId: string;
  actorType: string;
  action: string;
  outcome: string;
  resourceType: string;
  resourceId: string;
  workflowType: string;
  status: string;
  flowStatus: string;
  businessObjectType: string;
  businessObjectId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  reconciliationStatus: string;
}

export interface CursorPage<T> {
  items: T[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface AuditOverview {
  from: string;
  to: string;
  operationTotal: number;
  successTotal: number;
  failedTotal: number;
  deniedTotal: number;
  workflowActive: number;
  workflowFailed: number;
  eventPublishing: number;
  eventProjectionFailed: number;
  eventDeadLetter: number;
  projectionP95Ms: number;
  generatedAt: string;
}

export interface AuditOperation {
  id: string;
  departmentId?: string;
  actorUserId: string;
  actorRoles?: string[];
  actorType: string;
  action: string;
  resourceType: string;
  resourceId: string;
  outcome: string;
  requestId: string;
  correlationId: string;
  occurredAt: string;
  details?: unknown;
}

export interface AuditCommandReceipt {
  commandId: string;
  departmentId: string;
  commandType: string;
  idempotencyKey: string;
  flowExecutionId?: string;
  auditId: string;
  status: string;
  resourceType?: string;
  resourceId?: string;
  resourceVersion?: number;
  requestId: string;
  correlationId: string;
  createdAt: string;
}

export interface AuditWorkflow {
  id: string;
  sourceCommandId: string;
  workflowType: string;
  departmentId: string;
  initiatorUserId: string;
  businessKey: string;
  businessObjectType: string;
  businessObjectId: string;
  businessObjectVersion: number;
  correlationId: string;
  flowExecutionId?: string;
  flowStatus?: string;
  outcome?: string;
  status: string;
  attemptCount: number;
  lastError?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEventDelivery {
  eventId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  departmentId?: string;
  occurredAt: string;
  correlationId: string;
  causationId: string;
  publicationStatus: string;
  publicationAttempts: number;
  publishedAt?: string;
  streamSequence?: number;
  projectionStatus?: string;
  projectionAttempts?: number;
  receivedAt?: string;
  projectedAt?: string;
  reconciliationStatus: string;
  latencyMs?: number;
  lastError?: string;
  payload?: unknown;
}

export interface AuditFlowTrace {
  available: boolean;
  degraded?: boolean;
  errorCode?: string;
  execution?: Record<string, unknown> & { id: string; status: string; createdAt: string };
  events?: Array<{ id: string; type: string; payload?: unknown; createdAt: string }>;
  nodeRuns?: Array<{ id: string; nodeId: string; status: string; input?: unknown; output?: unknown; error?: unknown }>;
  approvals?: Array<{
    id: string;
    nodeId: string;
    assigneeId?: string;
    approverUserIds?: string[];
    title: string;
    status: string;
    decision?: string;
    actedAt?: string;
    comment?: string;
    decisions?: Array<{ actorUserId: string; actorAgentId?: string; decision: string; actedAt?: string }>;
  }>;
}

export interface AuditTrace {
  correlationId: string;
  operations: AuditOperation[];
  commandReceipts: AuditCommandReceipt[];
  workflows: AuditWorkflow[];
  eventDeliveries: AuditEventDelivery[];
  flow?: AuditFlowTrace;
}
