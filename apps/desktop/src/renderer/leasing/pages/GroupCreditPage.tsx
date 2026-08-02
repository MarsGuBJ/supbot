import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import cytoscape, { type ElementDefinition } from "cytoscape";
import {
  Ban,
  Building2,
  Check,
  CircleDollarSign,
  Download,
  FileUp,
  GitBranch,
  Pause,
  Pencil,
  Plus,
  ShieldCheck,
  UserRoundSearch,
  X,
} from "lucide-react";
import {
  executeCreditRiskCommand,
  fetchCreditFacilities,
  fetchCustomerGroups,
  fetchCustomers,
  fetchDueDiligenceSnapshots,
  fetchFacilityUtilization,
  fetchLimitLedger,
  fetchRiskImports,
  fetchPartyProfile,
  fetchPartyProfileChanges,
  fetchRatingSnapshots,
  fetchUBODeterminations,
  downloadRiskImportTemplate,
  newIdempotencyKey,
  preflightRiskImport,
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
  Customer,
  CustomerGroup,
  DueDiligenceSnapshot,
  FacilityUtilization,
  LimitLedgerEntry,
  PartyProfile,
  PartyProfileChange,
  RatingSnapshot,
  RiskImportBatch,
  RiskImportPreflight,
  Session,
  UBODetermination,
} from "../types";
import { formatDateTime, formatMoney, statusLabel, statusTone } from "../utils";

type View = "groups" | "profiles" | "facilities" | "ledger" | "imports";
type DialogKind = "group" | "relationship" | "ubo" | "rating" | "diligence" | "facility" | "facility-adjust" | null;
type ProfileData = {
  profile: PartyProfile;
  changes: PartyProfileChange[];
  ubos: UBODetermination[];
  ratings: RatingSnapshot[];
  diligence: DueDiligenceSnapshot[];
};

const today = new Date().toISOString().slice(0, 10);
const nextYear = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);

export default function GroupCreditPage({ session }: { session: Session }) {
  const loader = useCallback(
    async (signal: AbortSignal) => {
      const [customers, groups, facilities, ledger, imports] = await Promise.all([
        fetchCustomers(session, signal),
        fetchCustomerGroups(session, signal),
        fetchCreditFacilities(session, signal),
        fetchLimitLedger(session, "", signal),
        fetchRiskImports(session, signal),
      ]);
      const utilizationPairs = await Promise.all(
        facilities.items.map(
          async (facility) => [facility.id, await fetchFacilityUtilization(session, facility.id, signal)] as const,
        ),
      );
      return {
        customers: customers.items,
        groups: groups.items,
        facilities: facilities.items,
        ledger: ledger.items,
        imports: imports.items,
        utilization: new Map(utilizationPairs),
      };
    },
    [session],
  );
  const { data, error, loading, reload } = useRemoteData(loader);
  const [view, setView] = useState<View>("groups");
  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [profileData, setProfileData] = useState<ProfileData | null>(null);
  const [profileError, setProfileError] = useState<Error | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const [receipt, setReceipt] = useState<CommandReceipt | null>(null);

  const selectedCustomer = data?.customers.find((item) => item.id === selectedCustomerId);
  const refreshProfile = useCallback(async () => {
    if (!selectedCustomerId) {
      setProfileData(null);
      return;
    }
    setProfileLoading(true);
    setProfileError(null);
    try {
      const [profile, changes, ubos, ratings, diligence] = await Promise.all([
        fetchPartyProfile(session, selectedCustomerId),
        fetchPartyProfileChanges(session, selectedCustomerId),
        fetchUBODeterminations(session, selectedCustomerId),
        fetchRatingSnapshots(session, selectedCustomerId),
        fetchDueDiligenceSnapshots(session, selectedCustomerId),
      ]);
      setProfileData({
        profile,
        changes: changes.items,
        ubos: ubos.items,
        ratings: ratings.items,
        diligence: diligence.items,
      });
    } catch (reason) {
      setProfileError(reason instanceof Error ? reason : new Error("风险档案读取失败"));
    } finally {
      setProfileLoading(false);
    }
  }, [selectedCustomerId, session]);

  useEffect(() => {
    if (!selectedCustomerId && data?.customers[0]) setSelectedCustomerId(data.customers[0].id);
  }, [data, selectedCustomerId]);
  useEffect(() => {
    void refreshProfile();
  }, [refreshProfile]);

  const customerMap = useMemo(() => new Map((data?.customers || []).map((item) => [item.id, item])), [data]);
  const groupMap = useMemo(() => new Map((data?.groups || []).map((item) => [item.id, item])), [data]);

  const openDialog = (kind: Exclude<DialogKind, null>) => {
    setDialog(kind);
    setSubmitError(null);
    setMemberIds([]);
    if (kind === "group")
      setForm({
        name: "",
        groupCode: "",
        leadCustomerId: data?.customers[0]?.id || "",
        validFrom: today,
        validUntil: "",
      });
    if (kind === "relationship")
      setForm({
        partyId: `party-${Date.now()}`,
        partyType: "organization",
        partyName: "",
        creditCode: "",
        relationshipType: "ownership",
        ownershipPercent: "25",
        controlBasis: "",
        evidenceReference: "",
        validFrom: today,
        validUntil: "",
      });
    if (kind === "ubo")
      setForm({ thresholdPercent: "25", ruleVersion: "organization-default-v1", manualPartyIds: "", manualReason: "" });
    if (kind === "rating")
      setForm({
        ratingBatchId: "",
        modelId: "",
        modelVersion: "",
        modelArtifactHash: "",
        score: "",
        grade: "",
        ratedAt: today,
        validUntil: nextYear,
        evidenceHash: "",
      });
    if (kind === "diligence")
      setForm({
        ratingSnapshotId: profileData?.ratings.find((item) => item.status === "active")?.id || "",
        uboDeterminationId: profileData?.ubos.find((item) => item.status === "approved")?.id || "",
        aiSummaryDraftId: "",
        materialRefs: "",
        completeness: "group,related_parties,ubo,rating,materials",
      });
    if (kind === "facility")
      setForm({
        subjectType: "customer",
        subjectId: data?.customers[0]?.id || "",
        parentFacilityId: "",
        approvedLimit: "",
        currency: "CNY",
        validFrom: today,
        validUntil: nextYear,
      });
  };

  const openFacilityAdjustment = (facility: CreditFacility) => {
    setForm({ facilityId: facility.id, approvedLimit: facility.approvedLimit, reason: "" });
    setSubmitError(null);
    setDialog("facility-adjust");
  };

  const runCommand = async (commandType: string, body: unknown, version?: number) => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const nextReceipt = await executeCreditRiskCommand(
        session,
        commandType,
        body,
        newIdempotencyKey(commandType.replace(/\./g, "-")),
        version,
      );
      setReceipt(nextReceipt);
      setDialog(null);
      reload();
      await refreshProfile();
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason : new Error("操作失败"));
      throw reason;
    } finally {
      setSubmitting(false);
    }
  };

  const submitDialog = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      if (dialog === "group")
        await runCommand("customer-group.create", {
          ...form,
          memberIds: memberIds.length ? memberIds : [form.leadCustomerId],
        });
      if (dialog === "relationship" && selectedCustomer) {
        const rootId = `customer-${selectedCustomer.id}-${Date.now()}`;
        await runCommand("related-party.change.submit", {
          customerId: selectedCustomer.id,
          parties: [
            {
              id: rootId,
              type: "customer",
              name: selectedCustomer.name,
              unifiedSocialCreditCode: selectedCustomer.unifiedSocialCreditCode,
              customerId: selectedCustomer.id,
            },
            { id: form.partyId, type: form.partyType, name: form.partyName, unifiedSocialCreditCode: form.creditCode },
          ],
          relationships: [
            {
              fromPartyId: form.partyId,
              toPartyId: rootId,
              relationshipType: form.relationshipType,
              ownershipBps: Math.round(Number(form.ownershipPercent || 0) * 100),
              controlBasis: form.controlBasis,
              validFrom: form.validFrom,
              validUntil: form.validUntil,
              evidenceReference: form.evidenceReference,
            },
          ],
        });
      }
      if (dialog === "ubo")
        await runCommand("ubo.determine", {
          customerId: selectedCustomerId,
          thresholdBps: Math.round(Number(form.thresholdPercent) * 100),
          ruleVersion: form.ruleVersion,
          manualPartyIds: splitValues(form.manualPartyIds),
          manualReason: form.manualReason,
        });
      if (dialog === "rating") await runCommand("rating.snapshot.confirm", { ...form, customerId: selectedCustomerId });
      if (dialog === "diligence")
        await runCommand("due-diligence.snapshot.create", {
          customerId: selectedCustomerId,
          ratingSnapshotId: form.ratingSnapshotId,
          uboDeterminationId: form.uboDeterminationId,
          aiSummaryDraftId: form.aiSummaryDraftId,
          materialRefs: splitValues(form.materialRefs),
          completeness: splitValues(form.completeness),
        });
      if (dialog === "facility")
        await runCommand("credit-facility.submit", { ...form, approvedLimit: Number(form.approvedLimit).toFixed(2) });
      if (dialog === "facility-adjust")
        await runCommand(
          "credit-facility.adjust",
          { facilityId: form.facilityId, approvedLimit: Number(form.approvedLimit).toFixed(2), reason: form.reason },
          data?.facilities.find((item) => item.id === form.facilityId)?.version,
        );
    } catch {
      /* command state already contains the error */
    }
  };

  const review = async (
    commandType: string,
    idField: string,
    id: string,
    version: number,
    decision: "approved" | "rejected",
  ) => {
    try {
      await runCommand(
        commandType,
        { [idField]: id, decision, reason: decision === "approved" ? "复核通过" : "复核驳回" },
        version,
      );
    } catch {
      /* command state already contains the error */
    }
  };

  return (
    <div className="workspace risk-credit-workspace">
      <PageHeader
        eyebrow="集中度与授信控制"
        title="集团尽调与额度"
        meta={data ? `${data.groups.length} 个集团 · ${data.facilities.length} 个额度池` : undefined}
        action={
          view === "groups" ? (
            <button className="button primary" type="button" onClick={() => openDialog("group")}>
              <Plus size={16} />
              新建集团
            </button>
          ) : view === "facilities" ? (
            <button className="button primary" type="button" onClick={() => openDialog("facility")}>
              <Plus size={16} />
              申请额度
            </button>
          ) : null
        }
      />
      {receipt ? <CommandNotice receipt={receipt} onClose={() => setReceipt(null)} /> : null}
      {submitError && !dialog ? <ErrorState error={submitError} onRetry={() => setSubmitError(null)} /> : null}
      <div className="risk-tabs" role="tablist" aria-label="集团风险视图">
        <Tab
          active={view === "groups"}
          icon={<Building2 size={15} />}
          label="集团客户"
          onClick={() => setView("groups")}
        />
        <Tab
          active={view === "profiles"}
          icon={<UserRoundSearch size={15} />}
          label="风险档案"
          onClick={() => setView("profiles")}
        />
        <Tab
          active={view === "facilities"}
          icon={<CircleDollarSign size={15} />}
          label="额度池"
          onClick={() => setView("facilities")}
        />
        <Tab
          active={view === "ledger"}
          icon={<GitBranch size={15} />}
          label="占用流水"
          onClick={() => setView("ledger")}
        />
        <Tab
          active={view === "imports"}
          icon={<FileUp size={15} />}
          label="批量导入"
          onClick={() => setView("imports")}
        />
      </div>
      {loading ? <LoadingState /> : null}
      {error ? <ErrorState error={error} onRetry={reload} /> : null}
      {!loading && !error && view === "groups" ? (
        <GroupsView
          groups={data?.groups || []}
          customers={customerMap}
          onAction={(group, action) =>
            void (action === "submit"
              ? runCommand("customer-group.change.submit", { groupId: group.id }, group.version).catch(() => undefined)
              : review("customer-group.change.review", "groupId", group.id, group.version, action))
          }
        />
      ) : null}
      {!loading && !error && view === "profiles" ? (
        <ProfilesView
          customers={data?.customers || []}
          selectedCustomerId={selectedCustomerId}
          onSelect={setSelectedCustomerId}
          loading={profileLoading}
          error={profileError}
          data={profileData}
          onCreate={openDialog}
          onReview={(kind, id, version, decision) =>
            void review(
              kind === "party" ? "related-party.change.review" : "ubo.review",
              kind === "party" ? "changeId" : "determinationId",
              id,
              version,
              decision,
            )
          }
        />
      ) : null}
      {!loading && !error && view === "facilities" ? (
        <FacilitiesView
          facilities={data?.facilities || []}
          utilization={data?.utilization || new Map()}
          groups={groupMap}
          customers={customerMap}
          onReview={(facility, decision) =>
            void review("credit-facility.review", "facilityId", facility.id, facility.version, decision)
          }
          onAdjust={openFacilityAdjustment}
          onSuspend={(facility) =>
            void runCommand(
              "credit-facility.suspend",
              { facilityId: facility.id, reason: "风险经理暂停额度" },
              facility.version,
            ).catch(() => undefined)
          }
          onCancel={(facility) =>
            void runCommand(
              "credit-facility.cancel",
              { facilityId: facility.id, reason: "额度终止" },
              facility.version,
            ).catch(() => undefined)
          }
        />
      ) : null}
      {!loading && !error && view === "ledger" ? (
        <LedgerView
          entries={data?.ledger || []}
          facilities={new Map((data?.facilities || []).map((item) => [item.id, item]))}
        />
      ) : null}
      {!loading && !error && view === "imports" ? (
        <ImportView
          session={session}
          imports={data?.imports || []}
          submitting={submitting}
          onSubmit={(preflight) =>
            runCommand("risk-import.submit", {
              templateVersion: preflight.templateVersion,
              contentHash: preflight.contentHash,
              rows: preflight.rows,
            })
          }
          onReview={(batch, decision) => review("risk-import.review", "batchId", batch.id, batch.version, decision)}
        />
      ) : null}

      <Dialog
        open={dialog !== null}
        title={dialogTitle(dialog)}
        subtitle=""
        submitting={submitting}
        submitLabel="提交"
        error={submitError}
        onClose={() => setDialog(null)}
        onSubmit={submitDialog}
      >
        {dialog === "group" ? (
          <GroupFields
            form={form}
            setForm={setForm}
            customers={data?.customers || []}
            memberIds={memberIds}
            setMemberIds={setMemberIds}
          />
        ) : null}
        {dialog === "relationship" ? <RelationshipFields form={form} setForm={setForm} /> : null}
        {dialog === "ubo" ? <UBOFields form={form} setForm={setForm} /> : null}
        {dialog === "rating" ? <RatingFields form={form} setForm={setForm} /> : null}
        {dialog === "diligence" ? (
          <DiligenceFields
            form={form}
            setForm={setForm}
            ratings={profileData?.ratings || []}
            ubos={profileData?.ubos || []}
          />
        ) : null}
        {dialog === "facility" ? (
          <FacilityFields
            form={form}
            setForm={setForm}
            customers={data?.customers || []}
            groups={data?.groups || []}
            facilities={data?.facilities || []}
          />
        ) : null}
        {dialog === "facility-adjust" ? (
          <>
            <Field label="调整后额度" required>
              <input
                inputMode="decimal"
                value={form.approvedLimit || ""}
                onChange={(event) => setForm({ ...form, approvedLimit: event.target.value })}
              />
            </Field>
            <Field label="调整原因" required>
              <textarea
                rows={4}
                value={form.reason || ""}
                onChange={(event) => setForm({ ...form, reason: event.target.value })}
              />
            </Field>
          </>
        ) : null}
      </Dialog>
    </div>
  );
}

function Tab({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className={active ? "active" : ""} role="tab" aria-selected={active} type="button" onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}

function GroupsView({
  groups,
  customers,
  onAction,
}: {
  groups: CustomerGroup[];
  customers: Map<string, Customer>;
  onAction: (group: CustomerGroup, action: "submit" | "approved" | "rejected") => void;
}) {
  if (!groups.length) return <EmptyState title="暂无集团客户" detail="" />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>集团</th>
            <th>牵头客户</th>
            <th>有效期</th>
            <th>状态</th>
            <th>版本</th>
            <th aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <tr key={group.id}>
              <td>
                <strong>{group.name}</strong>
                <small>{group.groupCode}</small>
              </td>
              <td>{customers.get(group.leadCustomerId)?.name || group.leadCustomerId}</td>
              <td>
                {group.validFrom}
                {group.validUntil ? ` 至 ${group.validUntil}` : " 起"}
              </td>
              <td>
                <StatusBadge label={statusLabel(group.status)} tone={statusTone(group.status)} />
              </td>
              <td className="mono">v{group.version}</td>
              <td>
                <div className="row-actions">
                  {group.status === "draft" ? (
                    <button
                      className="button secondary compact"
                      type="button"
                      onClick={() => onAction(group, "submit")}
                    >
                      提交复核
                    </button>
                  ) : null}
                  {group.status === "in_review" ? (
                    <>
                      <button
                        className="icon-button"
                        title="复核通过"
                        aria-label="复核通过"
                        type="button"
                        onClick={() => onAction(group, "approved")}
                      >
                        <Check size={15} />
                      </button>
                      <button
                        className="icon-button danger"
                        title="复核驳回"
                        aria-label="复核驳回"
                        type="button"
                        onClick={() => onAction(group, "rejected")}
                      >
                        <X size={15} />
                      </button>
                    </>
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

function ProfilesView({
  customers,
  selectedCustomerId,
  onSelect,
  loading,
  error,
  data,
  onCreate,
  onReview,
}: {
  customers: Customer[];
  selectedCustomerId: string;
  onSelect: (id: string) => void;
  loading: boolean;
  error: Error | null;
  data: ProfileData | null;
  onCreate: (kind: "relationship" | "ubo" | "rating" | "diligence") => void;
  onReview: (kind: "party" | "ubo", id: string, version: number, decision: "approved" | "rejected") => void;
}) {
  return (
    <div className="risk-profile-layout">
      <aside className="risk-customer-index">
        <label>
          <span>客户</span>
          <select value={selectedCustomerId} onChange={(event) => onSelect(event.target.value)}>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </label>
        {data ? (
          <div className="risk-facts">
            <span>
              关联主体<strong>{data.profile.parties.total}</strong>
            </span>
            <span>
              UBO结论<strong>{data.ubos.length}</strong>
            </span>
            <span>
              有效评级<strong>{data.ratings.filter((item) => item.status === "active").length}</strong>
            </span>
            <span>
              尽调快照<strong>{data.diligence.length}</strong>
            </span>
          </div>
        ) : null}
      </aside>
      <section className="risk-profile-main">
        {loading ? <LoadingState rows={4} /> : null}
        {error ? <ErrorState error={error} onRetry={() => onSelect(selectedCustomerId)} /> : null}
        {!loading && data ? (
          <>
            <div className="risk-action-bar">
              <button className="button secondary compact" type="button" onClick={() => onCreate("relationship")}>
                <Plus size={14} />
                关联方
              </button>
              <button className="button secondary compact" type="button" onClick={() => onCreate("ubo")}>
                <ShieldCheck size={14} />
                UBO
              </button>
              <button className="button secondary compact" type="button" onClick={() => onCreate("rating")}>
                <Plus size={14} />
                评级快照
              </button>
              <button className="button primary compact" type="button" onClick={() => onCreate("diligence")}>
                固化尽调
              </button>
            </div>
            <ProfileSections data={data} onReview={onReview} />
          </>
        ) : null}
      </section>
    </div>
  );
}

function ProfileSections({
  data,
  onReview,
}: {
  data: ProfileData;
  onReview: (kind: "party" | "ubo", id: string, version: number, decision: "approved" | "rejected") => void;
}) {
  return (
    <div className="risk-section-stack">
      <section>
        <header>
          <h2>待复核变更</h2>
          <span>{data.changes.filter((item) => item.status === "in_review").length}</span>
        </header>
        {data.changes
          .filter((item) => item.status === "in_review")
          .map((item) => (
            <div className="risk-review-row" key={item.id}>
              <span>
                <strong>{item.relationships.length} 条关系</strong>
                <small>{item.id}</small>
              </span>
              <div>
                <button
                  className="icon-button"
                  title="复核通过"
                  aria-label="复核通过"
                  type="button"
                  onClick={() => onReview("party", item.id, item.version, "approved")}
                >
                  <Check size={15} />
                </button>
                <button
                  className="icon-button danger"
                  title="复核驳回"
                  aria-label="复核驳回"
                  type="button"
                  onClick={() => onReview("party", item.id, item.version, "rejected")}
                >
                  <X size={15} />
                </button>
              </div>
            </div>
          ))}
      </section>
      <section className="risk-graph-section">
        <header>
          <h2>关系与 UBO 图谱</h2>
          <span>{data.profile.relationships.total}</span>
        </header>
        <RelationshipGraph profile={data.profile} ubos={data.ubos} />
      </section>
      <section>
        <header>
          <h2>关联主体</h2>
          <span>{data.profile.parties.total}</span>
        </header>
        <div className="compact-records">
          {data.profile.parties.items.map((party) => (
            <div key={party.id}>
              <strong>{party.name}</strong>
              <span>{party.type}</span>
              <small>{party.unifiedSocialCreditCode || party.id}</small>
            </div>
          ))}
        </div>
      </section>
      <section>
        <header>
          <h2>UBO结论</h2>
          <span>{data.ubos.length}</span>
        </header>
        {data.ubos.map((ubo) => (
          <div className="risk-review-row" key={ubo.id}>
            <span>
              <strong>{ubo.paths.map((path) => path.partyName).join("、") || "待人工认定"}</strong>
              <small>
                {ubo.ruleVersion} · {ubo.thresholdBps / 100}% · 至 {ubo.validUntil}
              </small>
            </span>
            <StatusBadge
              label={ubo.manualRequired ? "待人工认定" : statusLabel(ubo.status)}
              tone={ubo.manualRequired ? "warning" : statusTone(ubo.status)}
            />
            {ubo.status === "in_review" && !ubo.manualRequired ? (
              <div>
                <button
                  className="icon-button"
                  title="复核通过"
                  aria-label="复核通过"
                  type="button"
                  onClick={() => onReview("ubo", ubo.id, ubo.version, "approved")}
                >
                  <Check size={15} />
                </button>
                <button
                  className="icon-button danger"
                  title="复核驳回"
                  aria-label="复核驳回"
                  type="button"
                  onClick={() => onReview("ubo", ubo.id, ubo.version, "rejected")}
                >
                  <X size={15} />
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </section>
      <section>
        <header>
          <h2>评级历史</h2>
          <span>{data.ratings.length}</span>
        </header>
        <div className="compact-records">
          {data.ratings.map((rating) => (
            <div key={rating.id}>
              <strong>
                {rating.grade} · {rating.score}
              </strong>
              <span>v{rating.modelVersion}</span>
              <small>
                {rating.ratedAt} 至 {rating.validUntil}
              </small>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function RelationshipGraph({ profile, ubos }: { profile: PartyProfile; ubos: UBODetermination[] }) {
  const container = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!container.current || !profile.parties.items.length) return;
    const uboIDs = new Set(ubos.flatMap((item) => item.paths.map((path) => path.partyId)));
    const nodes: ElementDefinition[] = profile.parties.items.map((party) => ({
      data: { id: party.id, label: party.name, partyType: party.type, isUBO: uboIDs.has(party.id) ? "true" : "false" },
    }));
    const edges: ElementDefinition[] = profile.relationships.items.map((relationship) => ({
      data: {
        id: relationship.id,
        source: relationship.fromPartyId,
        target: relationship.toPartyId,
        label:
          relationship.relationshipType === "ownership"
            ? `${relationship.ownershipBps ? relationship.ownershipBps / 100 : 0}%`
            : relationship.relationshipType,
      },
    }));
    const graph = cytoscape({
      container: container.current,
      elements: [...nodes, ...edges],
      layout: { name: "breadthfirst", directed: true, padding: 24, spacingFactor: 1.2 },
      minZoom: 0.45,
      maxZoom: 2,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "#17634b",
            label: "data(label)",
            color: "#26312d",
            "font-size": "10px",
            "text-valign": "bottom",
            "text-margin-y": 7,
            width: 30,
            height: 30,
            "text-wrap": "ellipsis",
            "text-max-width": "120px",
          },
        },
        { selector: 'node[partyType = "person"]', style: { "background-color": "#d49522", shape: "diamond" } },
        { selector: 'node[isUBO = "true"]', style: { "border-width": 3, "border-color": "#9b3d36" } },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "#9aa9a3",
            "target-arrow-color": "#9aa9a3",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            label: "data(label)",
            "font-size": "9px",
            color: "#64716c",
            "text-background-color": "#f7f8f6",
            "text-background-opacity": 0.92,
            "text-background-padding": "2px",
          },
        },
      ],
    });
    return () => graph.destroy();
  }, [profile, ubos]);
  if (!profile.parties.items.length) return <EmptyState title="暂无关系图谱" detail="" />;
  return <div className="risk-relationship-graph" ref={container} />;
}

function FacilitiesView({
  facilities,
  utilization,
  groups,
  customers,
  onReview,
  onAdjust,
  onSuspend,
  onCancel,
}: {
  facilities: CreditFacility[];
  utilization: Map<string, FacilityUtilization>;
  groups: Map<string, CustomerGroup>;
  customers: Map<string, Customer>;
  onReview: (facility: CreditFacility, decision: "approved" | "rejected") => void;
  onAdjust: (facility: CreditFacility) => void;
  onSuspend: (facility: CreditFacility) => void;
  onCancel: (facility: CreditFacility) => void;
}) {
  if (!facilities.length) return <EmptyState title="暂无授信额度池" detail="" />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>额度对象</th>
            <th className="numeric">核定</th>
            <th className="numeric">承诺</th>
            <th className="numeric">用信</th>
            <th className="numeric">可用</th>
            <th>状态</th>
            <th aria-label="操作" />
          </tr>
        </thead>
        <tbody>
          {facilities.map((facility) => {
            const used = utilization.get(facility.id);
            const name =
              facility.subjectType === "customerGroup"
                ? groups.get(facility.subjectId)?.name
                : customers.get(facility.subjectId)?.name;
            return (
              <tr key={facility.id}>
                <td>
                  <strong>{name || facility.subjectId}</strong>
                  <small>
                    {facility.parentFacilityId
                      ? "成员子限额"
                      : facility.subjectType === "customerGroup"
                        ? "集团总额"
                        : "独立客户额度"}
                  </small>
                </td>
                <td className="numeric strong">
                  {formatMoney(facility.approvedLimit)}
                  {facility.pendingApprovedLimit ? (
                    <small>待复核 {formatMoney(facility.pendingApprovedLimit)}</small>
                  ) : null}
                </td>
                <td className="numeric">{formatMoney(used?.committed || "0")}</td>
                <td className="numeric">{formatMoney(used?.used || "0")}</td>
                <td className="numeric strong">{formatMoney(used?.available || facility.approvedLimit)}</td>
                <td>
                  <StatusBadge label={statusLabel(facility.status)} tone={statusTone(facility.status)} />
                </td>
                <td>
                  <div className="row-actions">
                    {facility.status === "in_review" ? (
                      <>
                        <button
                          className="icon-button"
                          title="复核通过"
                          aria-label="复核通过"
                          type="button"
                          onClick={() => onReview(facility, "approved")}
                        >
                          <Check size={15} />
                        </button>
                        <button
                          className="icon-button danger"
                          title="复核驳回"
                          aria-label="复核驳回"
                          type="button"
                          onClick={() => onReview(facility, "rejected")}
                        >
                          <X size={15} />
                        </button>
                      </>
                    ) : null}
                    {facility.status === "active" ? (
                      <>
                        <button
                          className="icon-button"
                          title="调整额度"
                          aria-label="调整额度"
                          type="button"
                          onClick={() => onAdjust(facility)}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="icon-button"
                          title="暂停额度"
                          aria-label="暂停额度"
                          type="button"
                          onClick={() => onSuspend(facility)}
                        >
                          <Pause size={15} />
                        </button>
                      </>
                    ) : null}
                    {facility.status === "suspended" ? (
                      <button
                        className="icon-button danger"
                        title="取消额度"
                        aria-label="取消额度"
                        type="button"
                        onClick={() => onCancel(facility)}
                      >
                        <Ban size={15} />
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LedgerView({ entries, facilities }: { entries: LimitLedgerEntry[]; facilities: Map<string, CreditFacility> }) {
  if (!entries.length) return <EmptyState title="暂无额度占用流水" detail="" />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>发生时间</th>
            <th>额度池</th>
            <th>业务类型</th>
            <th className="numeric">承诺变动</th>
            <th className="numeric">用信变动</th>
            <th>来源</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>{formatDateTime(entry.createdAt)}</td>
              <td className="mono-cell">{facilities.get(entry.facilityId)?.subjectId || entry.facilityId}</td>
              <td>{entry.entryType}</td>
              <td className="numeric">{formatMoney(entry.committedDelta)}</td>
              <td className="numeric">{formatMoney(entry.usedDelta)}</td>
              <td className="mono-cell">{entry.sourceEventId}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ImportView({
  session,
  imports,
  submitting,
  onSubmit,
  onReview,
}: {
  session: Session;
  imports: RiskImportBatch[];
  submitting: boolean;
  onSubmit: (preflight: RiskImportPreflight) => Promise<void>;
  onReview: (batch: RiskImportBatch, decision: "approved" | "rejected") => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preflight, setPreflight] = useState<RiskImportPreflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const inspect = async () => {
    if (!file) return;
    setChecking(true);
    setError(null);
    try {
      setPreflight(await preflightRiskImport(session, await file.text()));
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("导入预检失败"));
    } finally {
      setChecking(false);
    }
  };
  const downloadErrors = () => {
    if (!preflight?.errorCsv) return;
    const url = URL.createObjectURL(new Blob(["\ufeff", preflight.errorCsv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "customer-risk-errors.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="risk-import-workspace">
      <div className="risk-import-toolbar">
        <button
          className="button secondary compact"
          type="button"
          onClick={() =>
            void downloadRiskImportTemplate(session).catch((reason) =>
              setError(reason instanceof Error ? reason : new Error("模板下载失败")),
            )
          }
        >
          <Download size={15} />
          下载模板
        </button>
        <label className="file-control">
          <FileUp size={16} />
          <span>{file?.name || "选择 CSV"}</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              setFile(event.target.files?.[0] || null);
              setPreflight(null);
              setError(null);
            }}
          />
        </label>
        <button
          className="button secondary compact"
          type="button"
          disabled={!file || checking}
          onClick={() => void inspect()}
        >
          {checking ? "预检中" : "预检"}
        </button>
        <button
          className="button primary compact"
          type="button"
          disabled={!preflight?.valid || submitting}
          onClick={() => preflight && void onSubmit(preflight)}
        >
          {submitting ? "提交中" : "提交复核"}
        </button>
      </div>
      {error ? <ErrorState error={error} onRetry={() => setError(null)} /> : null}
      {preflight ? (
        <div className="risk-import-result">
          <div>
            <strong>{preflight.rows.length}</strong>
            <span>数据行</span>
          </div>
          <div>
            <strong>{preflight.errors.length}</strong>
            <span>错误</span>
          </div>
          <StatusBadge label={preflight.valid ? "可提交" : "需修正"} tone={preflight.valid ? "success" : "danger"} />
          {preflight.errorCsv ? (
            <button className="button secondary compact" type="button" onClick={downloadErrors}>
              <Download size={14} />
              错误明细
            </button>
          ) : null}
        </div>
      ) : null}
      {imports.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>批次</th>
                <th>模板</th>
                <th className="numeric">数据行</th>
                <th>提交人</th>
                <th>状态</th>
                <th>更新时间</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {imports.map((batch) => (
                <tr key={batch.id}>
                  <td className="mono-cell">{batch.id}</td>
                  <td>{batch.templateVersion}</td>
                  <td className="numeric">{batch.rows.length}</td>
                  <td>{batch.submittedByUserId}</td>
                  <td>
                    <StatusBadge label={statusLabel(batch.status)} tone={statusTone(batch.status)} />
                  </td>
                  <td>{formatDateTime(batch.updatedAt)}</td>
                  <td>
                    {batch.status === "in_review" ? (
                      <div className="row-actions">
                        <button
                          className="icon-button"
                          title="复核通过"
                          aria-label="复核通过"
                          type="button"
                          onClick={() => onReview(batch, "approved")}
                        >
                          <Check size={15} />
                        </button>
                        <button
                          className="icon-button danger"
                          title="复核驳回"
                          aria-label="复核驳回"
                          type="button"
                          onClick={() => onReview(batch, "rejected")}
                        >
                          <X size={15} />
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="暂无导入批次" detail="" />
      )}
    </div>
  );
}

type FormProps = { form: Record<string, string>; setForm: (value: Record<string, string>) => void };
const field =
  (form: Record<string, string>, setForm: FormProps["setForm"], name: string) =>
  (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [name]: event.target.value });
function GroupFields({
  form,
  setForm,
  customers,
  memberIds,
  setMemberIds,
}: FormProps & { customers: Customer[]; memberIds: string[]; setMemberIds: (ids: string[]) => void }) {
  return (
    <div className="form-grid">
      <Field label="集团名称" required>
        <input required value={form.name} onChange={field(form, setForm, "name")} />
      </Field>
      <Field label="集团代码" required>
        <input required value={form.groupCode} onChange={field(form, setForm, "groupCode")} />
      </Field>
      <Field label="牵头客户" required span={2}>
        <select required value={form.leadCustomerId} onChange={field(form, setForm, "leadCustomerId")}>
          {customers.map((item) => (
            <option value={item.id} key={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="生效日" required>
        <input required type="date" value={form.validFrom} onChange={field(form, setForm, "validFrom")} />
      </Field>
      <Field label="失效日">
        <input type="date" value={form.validUntil} onChange={field(form, setForm, "validUntil")} />
      </Field>
      <Field label="集团成员" required span={2}>
        <div className="risk-check-list">
          {customers.map((item) => (
            <label key={item.id}>
              <input
                type="checkbox"
                checked={memberIds.includes(item.id)}
                onChange={(event) =>
                  setMemberIds(
                    event.target.checked ? [...memberIds, item.id] : memberIds.filter((id) => id !== item.id),
                  )
                }
              />
              <span>{item.name}</span>
            </label>
          ))}
        </div>
      </Field>
    </div>
  );
}
function RelationshipFields({ form, setForm }: FormProps) {
  return (
    <div className="form-grid">
      <Field label="主体名称" required>
        <input required value={form.partyName} onChange={field(form, setForm, "partyName")} />
      </Field>
      <Field label="主体类型" required>
        <select value={form.partyType} onChange={field(form, setForm, "partyType")}>
          <option value="organization">企业</option>
          <option value="person">自然人</option>
        </select>
      </Field>
      <Field label="主体标识" required>
        <input required value={form.partyId} onChange={field(form, setForm, "partyId")} />
      </Field>
      <Field label="统一社会信用代码">
        <input value={form.creditCode} onChange={field(form, setForm, "creditCode")} />
      </Field>
      <Field label="关系类型" required>
        <select value={form.relationshipType} onChange={field(form, setForm, "relationshipType")}>
          <option value="ownership">持股</option>
          <option value="control">控制</option>
          <option value="guarantee">担保</option>
          <option value="common_control">共同控制</option>
          <option value="executive">高管</option>
          <option value="family">亲属</option>
          <option value="other">其他</option>
        </select>
      </Field>
      <Field label="持股比例（%）">
        <input inputMode="decimal" value={form.ownershipPercent} onChange={field(form, setForm, "ownershipPercent")} />
      </Field>
      <Field label="控制依据">
        <input value={form.controlBasis} onChange={field(form, setForm, "controlBasis")} />
      </Field>
      <Field label="证据引用" required>
        <input required value={form.evidenceReference} onChange={field(form, setForm, "evidenceReference")} />
      </Field>
      <Field label="生效日" required>
        <input required type="date" value={form.validFrom} onChange={field(form, setForm, "validFrom")} />
      </Field>
      <Field label="失效日">
        <input type="date" value={form.validUntil} onChange={field(form, setForm, "validUntil")} />
      </Field>
    </div>
  );
}
function UBOFields({ form, setForm }: FormProps) {
  return (
    <div className="form-grid">
      <Field label="穿透规则" required>
        <input required value={form.ruleVersion} onChange={field(form, setForm, "ruleVersion")} />
      </Field>
      <Field label="阈值（%）" required>
        <input
          required
          inputMode="decimal"
          value={form.thresholdPercent}
          onChange={field(form, setForm, "thresholdPercent")}
        />
      </Field>
      <Field label="人工认定主体ID" span={2}>
        <input value={form.manualPartyIds} onChange={field(form, setForm, "manualPartyIds")} />
      </Field>
      <Field label="人工认定依据" span={2}>
        <textarea rows={3} value={form.manualReason} onChange={field(form, setForm, "manualReason")} />
      </Field>
    </div>
  );
}
function RatingFields({ form, setForm }: FormProps) {
  return (
    <div className="form-grid">
      <Field label="评级批次" required>
        <input required value={form.ratingBatchId} onChange={field(form, setForm, "ratingBatchId")} />
      </Field>
      <Field label="模型ID" required>
        <input required value={form.modelId} onChange={field(form, setForm, "modelId")} />
      </Field>
      <Field label="模型版本" required>
        <input required value={form.modelVersion} onChange={field(form, setForm, "modelVersion")} />
      </Field>
      <Field label="制品哈希" required>
        <input required value={form.modelArtifactHash} onChange={field(form, setForm, "modelArtifactHash")} />
      </Field>
      <Field label="分数">
        <input value={form.score} onChange={field(form, setForm, "score")} />
      </Field>
      <Field label="等级" required>
        <input required value={form.grade} onChange={field(form, setForm, "grade")} />
      </Field>
      <Field label="评级日" required>
        <input required type="date" value={form.ratedAt} onChange={field(form, setForm, "ratedAt")} />
      </Field>
      <Field label="有效期至" required>
        <input required type="date" value={form.validUntil} onChange={field(form, setForm, "validUntil")} />
      </Field>
      <Field label="证据哈希" required span={2}>
        <input required value={form.evidenceHash} onChange={field(form, setForm, "evidenceHash")} />
      </Field>
    </div>
  );
}
function DiligenceFields({
  form,
  setForm,
  ratings,
  ubos,
}: FormProps & { ratings: RatingSnapshot[]; ubos: UBODetermination[] }) {
  return (
    <div className="form-grid">
      <Field label="有效评级" required span={2}>
        <select required value={form.ratingSnapshotId} onChange={field(form, setForm, "ratingSnapshotId")}>
          <option value="">请选择</option>
          {ratings
            .filter((item) => item.status === "active")
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.grade} · {item.validUntil}
              </option>
            ))}
        </select>
      </Field>
      <Field label="UBO结论" required span={2}>
        <select required value={form.uboDeterminationId} onChange={field(form, setForm, "uboDeterminationId")}>
          <option value="">请选择</option>
          {ubos
            .filter((item) => item.status === "approved")
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.ruleVersion} · {item.paths.length} 人
              </option>
            ))}
        </select>
      </Field>
      <Field label="AI摘要草稿ID" span={2}>
        <input value={form.aiSummaryDraftId} onChange={field(form, setForm, "aiSummaryDraftId")} />
      </Field>
      <Field label="材料引用" required span={2}>
        <textarea required rows={3} value={form.materialRefs} onChange={field(form, setForm, "materialRefs")} />
      </Field>
      <Field label="完整性检查" required span={2}>
        <input required value={form.completeness} onChange={field(form, setForm, "completeness")} />
      </Field>
    </div>
  );
}
function FacilityFields({
  form,
  setForm,
  customers,
  groups,
  facilities,
}: FormProps & { customers: Customer[]; groups: CustomerGroup[]; facilities: CreditFacility[] }) {
  const subjects = form.subjectType === "customerGroup" ? groups.filter((item) => item.status === "active") : customers;
  return (
    <div className="form-grid">
      <Field label="额度层级" required>
        <select
          value={form.subjectType}
          onChange={(event) =>
            setForm({ ...form, subjectType: event.target.value, subjectId: "", parentFacilityId: "" })
          }
        >
          <option value="customer">客户额度</option>
          <option value="customerGroup">集团总额</option>
        </select>
      </Field>
      <Field label="额度对象" required>
        <select required value={form.subjectId} onChange={field(form, setForm, "subjectId")}>
          <option value="">请选择</option>
          {subjects.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </Field>
      {form.subjectType === "customer" ? (
        <Field label="上级集团额度">
          <select value={form.parentFacilityId} onChange={field(form, setForm, "parentFacilityId")}>
            <option value="">独立客户额度</option>
            {facilities
              .filter((item) => item.subjectType === "customerGroup" && item.status === "active")
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {groups.find((group) => group.id === item.subjectId)?.name || item.subjectId}
                </option>
              ))}
          </select>
        </Field>
      ) : null}
      <Field label="核定额度（元）" required>
        <input
          required
          inputMode="decimal"
          value={form.approvedLimit}
          onChange={field(form, setForm, "approvedLimit")}
        />
      </Field>
      <Field label="生效日" required>
        <input required type="date" value={form.validFrom} onChange={field(form, setForm, "validFrom")} />
      </Field>
      <Field label="失效日" required>
        <input required type="date" value={form.validUntil} onChange={field(form, setForm, "validUntil")} />
      </Field>
    </div>
  );
}

function dialogTitle(dialog: DialogKind): string {
  return (
    (
      {
        group: "新建集团客户",
        relationship: "提交关联方变更",
        ubo: "生成UBO结论",
        rating: "固化评级结果",
        diligence: "固化尽调快照",
        facility: "申请授信额度",
        "facility-adjust": "调整授信额度",
      } as Record<string, string>
    )[dialog || ""] || ""
  );
}
function splitValues(value: string): string[] {
  return value
    .split(/[，,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
