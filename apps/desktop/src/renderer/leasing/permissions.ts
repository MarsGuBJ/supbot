import type { IdentityContext } from "@supbot/shared";

/** Roles that can open the general leasing workspace in leasing-api. */
export const LEASING_READ_ROLES = new Set([
  "admin",
  "leasing-admin",
  "leasing-auditor",
  "leasing-credit-officer",
  "leasing-contract-manager",
  "leasing-asset-manager",
  "leasing-finance-operator",
  "leasing-finance-manager",
  "leasing-operator",
  "leasing-reader",
  "leasing-risk-manager",
  "leasing-treasury-operator",
  "leasing-postlease-officer",
  "leasing-collection-officer",
  "leasing-collection-manager",
  "leasing-legal-manager",
  "leasing-tax-operator",
  "leasing-treasury-manager",
  "leasing-regulatory-operator",
  "leasing-regulatory-manager",
  "leasing-partner-operator",
  "leasing-partner-manager",
  "leasing-product-manager",
  "leasing-pricing-manager",
]);

/** Rating is a separate read boundary; it is intentionally allowed to expose the tab for analysts. */
export const LEASING_RATING_ANALYST_ROLE = "leasing-rating-analyst";

const PRODUCT_ROLES = new Set(["leasing-admin", "leasing-product-manager"]);
const QUOTE_ROLES = new Set(["leasing-admin", "leasing-operator", "leasing-pricing-manager"]);
const DEPOSIT_ROLES = new Set([
  "leasing-admin",
  "leasing-finance-operator",
  "leasing-finance-manager",
  "leasing-treasury-operator",
]);

export function leasingRoleIds(identity?: Pick<IdentityContext, "roleIds"> | null): string[] {
  return (identity?.roleIds || []).map((role) => role.trim().toLowerCase()).filter(Boolean);
}

export function canReadLeasing(identity?: Pick<IdentityContext, "roleIds"> | null): boolean {
  return leasingRoleIds(identity).some((role) => LEASING_READ_ROLES.has(role) || role === LEASING_RATING_ANALYST_ROLE);
}

export function canManageLeasingProducts(roleIds: readonly string[]): boolean {
  return hasAllowedRole(roleIds, PRODUCT_ROLES);
}

export function canManageLeasingQuotes(roleIds: readonly string[]): boolean {
  return hasAllowedRole(roleIds, QUOTE_ROLES);
}

export function canRecordLeasingDeposit(roleIds: readonly string[]): boolean {
  return hasAllowedRole(roleIds, DEPOSIT_ROLES);
}

function hasAllowedRole(roleIds: readonly string[], allowed: ReadonlySet<string>): boolean {
  return roleIds.some((role) => allowed.has(role.trim().toLowerCase()));
}
