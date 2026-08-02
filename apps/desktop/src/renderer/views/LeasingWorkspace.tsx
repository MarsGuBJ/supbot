import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  BriefcaseBusiness,
  Building2,
  Calculator,
  ChartNoAxesCombined,
  ClipboardCheck,
  FileCheck2,
  Gauge,
  Handshake,
  Landmark,
  LoaderCircle,
  ShieldCheck,
  Users,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import type { IdentityContext, RuntimeSnapshot } from "@supbot/shared";
import type { Translator } from "../lib/types";
import type { Session, WorkspaceKey } from "../leasing/types";
import {
  canReadLeasing,
  leasingRoleIds,
  LEASING_RATING_ANALYST_ROLE,
  LEASING_READ_ROLES,
} from "../leasing/permissions";
import "../leasing/leasing.css";
import "../leasing/shell.css";

const ContractsAssetsPage = lazy(() => import("../leasing/pages/ContractsAssetsPage"));
const CreditApplicationsPage = lazy(() => import("../leasing/pages/CreditApplicationsPage"));
const CustomersPage = lazy(() => import("../leasing/pages/CustomersPage"));
const DashboardPage = lazy(() => import("../leasing/pages/DashboardPage"));
const GroupCreditPage = lazy(() => import("../leasing/pages/GroupCreditPage"));
const PartnerManagementPage = lazy(() => import("../leasing/pages/PartnerManagementPage"));
const PostLeasePage = lazy(() => import("../leasing/pages/PostLeasePage"));
const PricingWorkspacePage = lazy(() => import("../leasing/pages/PricingWorkspacePage"));
const ProjectsPage = lazy(() => import("../leasing/pages/ProjectsPage"));
const ReceivablesPaymentsPage = lazy(() => import("../leasing/pages/ReceivablesPaymentsPage"));
const RiskRatingPage = lazy(() => import("../leasing/pages/RiskRatingPage"));

export type LeasingWorkspaceKey = Extract<
  WorkspaceKey,
  | "risk-rating"
  | "dashboard"
  | "customers"
  | "partners"
  | "projects"
  | "pricing"
  | "credit"
  | "group-credit"
  | "contracts-assets"
  | "receivables-payments"
  | "post-lease"
>;

type LeasingNavItem = {
  key: LeasingWorkspaceKey;
  label: string;
  icon: LucideIcon;
};

type LeasingNavGroup = {
  key: "operations" | "asset-operations";
  label: string;
  items: LeasingNavItem[];
};

export const LEASING_NAVIGATION: Array<{
  group: LeasingNavGroup["key"];
  labelKey: string;
  items: Array<{ key: LeasingWorkspaceKey; labelKey: string; icon: LeasingNavItem["icon"] }>;
}> = [
  {
    group: "operations",
    labelKey: "Leasing operations",
    items: [
      { key: "risk-rating", labelKey: "Risk rating", icon: ChartNoAxesCombined },
      { key: "dashboard", labelKey: "Business dashboard", icon: Gauge },
      { key: "customers", labelKey: "Customer management", icon: Users },
      { key: "partners", labelKey: "Partner management", icon: Handshake },
      { key: "projects", labelKey: "Lease projects", icon: BriefcaseBusiness },
      { key: "pricing", labelKey: "Product and pricing", icon: Calculator },
      { key: "credit", labelKey: "Credit applications", icon: ClipboardCheck },
      { key: "group-credit", labelKey: "Groups and limits", icon: Landmark },
    ],
  },
  {
    group: "asset-operations",
    labelKey: "Asset operations",
    items: [
      { key: "contracts-assets", labelKey: "Contracts and assets", icon: FileCheck2 },
      { key: "receivables-payments", labelKey: "Receivables and payments", icon: WalletCards },
      { key: "post-lease", labelKey: "Post-lease management", icon: ShieldCheck },
    ],
  },
];

const NAVIGATION_KEYS = new Set<LeasingWorkspaceKey>(
  LEASING_NAVIGATION.flatMap((group) => group.items.map((item) => item.key)),
);
const ACTIVE_PAGE_STORAGE_PREFIX = "hbclient.leasing.active-page";

export function LeasingWorkspace({ snapshot, t }: { snapshot: RuntimeSnapshot; t: Translator }) {
  const identity = snapshot.identityContext;
  const [activePage, setActivePage] = useState<LeasingWorkspaceKey>(() => initialPage(identity));
  const session = useMemo(
    () => identity && leasingSession(identity),
    [
      identity?.tenantId,
      identity?.organizationId,
      identity?.departmentId,
      identity?.userId,
      identity?.roleIds.join(","),
    ],
  );

  useEffect(() => {
    setActivePage(initialPage(identity));
  }, [identity?.tenantId, identity?.userId]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(activePageStorageKey(identity), activePage);
    } catch {
      // Session persistence is optional when storage is unavailable.
    }
  }, [activePage, identity?.tenantId, identity?.userId]);

  if (!canReadLeasing(identity)) {
    return (
      <section className="leasing-workspace leasing-access-denied" aria-labelledby="leasing-access-title">
        <div className="leasing-access-card">
          <ShieldCheck aria-hidden="true" />
          <h1 id="leasing-access-title">{t("Leasing access required")}</h1>
          <p>{t("Your account is not assigned a leasing read role.")}</p>
        </div>
      </section>
    );
  }

  if (!session) {
    return (
      <section className="leasing-workspace leasing-access-denied" aria-labelledby="leasing-identity-title">
        <div className="leasing-access-card">
          <ShieldCheck aria-hidden="true" />
          <h1 id="leasing-identity-title">{t("Leasing identity unavailable")}</h1>
          <p>{t("Pair a BotStation identity before opening leasing.")}</p>
        </div>
      </section>
    );
  }

  const navigate = (next: WorkspaceKey) => {
    if (NAVIGATION_KEYS.has(next as LeasingWorkspaceKey)) {
      setActivePage(next as LeasingWorkspaceKey);
    }
  };

  return (
    <section className="leasing-workspace" aria-label={t("Leasing workspace")}>
      <aside className="leasing-sidebar" aria-label={t("Leasing navigation")}>
        <div className="leasing-sidebar-brand">
          <span className="leasing-brand-mark" aria-hidden="true">
            <Building2 size={18} />
          </span>
          <div>
            <strong>{t("Leasing")}</strong>
            <span>{t("Finance lease operations")}</span>
          </div>
        </div>
        <nav className="leasing-nav" aria-label={t("Leasing pages")}>
          {LEASING_NAVIGATION.map((group) => (
            <div className="leasing-nav-group" key={group.group}>
              <div className="leasing-nav-group-label">{t(group.labelKey)}</div>
              {group.items.map((item) => {
                const Icon = item.icon;
                const selected = item.key === activePage;
                return (
                  <button
                    className={`leasing-nav-item${selected ? " is-active" : ""}`}
                    type="button"
                    key={item.key}
                    aria-current={selected ? "page" : undefined}
                    onClick={() => setActivePage(item.key)}
                  >
                    <Icon aria-hidden="true" size={17} strokeWidth={1.8} />
                    <span>{t(item.labelKey)}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>
      <main className="leasing-content">
        <Suspense
          fallback={
            <div className="leasing-route-loading" role="status" aria-label={t("Loading leasing page")}>
              <LoaderCircle aria-hidden="true" />
              <span>{t("Loading leasing page")}</span>
            </div>
          }
        >
          <LeasingPage page={activePage} session={session} onNavigate={navigate} />
        </Suspense>
      </main>
    </section>
  );
}

function LeasingPage({
  page,
  session,
  onNavigate,
}: {
  page: LeasingWorkspaceKey;
  session: Session;
  onNavigate: (page: WorkspaceKey) => void;
}) {
  switch (page) {
    case "dashboard":
      return <DashboardPage session={session} onNavigate={onNavigate} />;
    case "risk-rating":
      return <RiskRatingPage session={session} />;
    case "customers":
      return <CustomersPage session={session} />;
    case "partners":
      return <PartnerManagementPage session={session} />;
    case "projects":
      return <ProjectsPage session={session} />;
    case "pricing":
      return <PricingWorkspacePage session={session} />;
    case "credit":
      return <CreditApplicationsPage session={session} />;
    case "group-credit":
      return <GroupCreditPage session={session} />;
    case "contracts-assets":
      return <ContractsAssetsPage session={session} onOpenPricing={() => onNavigate("pricing")} />;
    case "receivables-payments":
      return <ReceivablesPaymentsPage session={session} />;
    case "post-lease":
      return <PostLeasePage session={session} />;
    default:
      return null;
  }
}

function leasingSession(identity: IdentityContext): Session {
  return {
    mode: "dev-headers",
    tenantId: identity.tenantId,
    organizationId: identity.organizationId,
    departmentId: identity.departmentId,
    userId: identity.userId,
    roleIds: leasingRoleIds(identity),
  };
}

function initialPage(identity?: IdentityContext): LeasingWorkspaceKey {
  const roles = leasingRoleIds(identity);
  if (roles.includes(LEASING_RATING_ANALYST_ROLE) && !roles.some((role) => LEASING_READ_ROLES.has(role))) {
    return "risk-rating";
  }
  try {
    const stored = window.sessionStorage.getItem(activePageStorageKey(identity)) as LeasingWorkspaceKey | null;
    if (stored && NAVIGATION_KEYS.has(stored)) {
      return stored;
    }
  } catch {
    // Fall through to the identity-aware default.
  }
  return "dashboard";
}

function activePageStorageKey(identity?: IdentityContext): string {
  return `${ACTIVE_PAGE_STORAGE_PREFIX}:${identity?.tenantId || "unknown"}:${identity?.userId || "unknown"}`;
}
