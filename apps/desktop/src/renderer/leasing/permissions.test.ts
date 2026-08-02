import { describe, expect, it } from "vitest";
import {
  canManageLeasingProducts,
  canManageLeasingQuotes,
  canReadLeasing,
  canRecordLeasingDeposit,
} from "./permissions";

describe("leasing workspace permission", () => {
  it.each(["leasing-reader", "leasing-admin", "admin", "leasing-partner-operator"])(
    "shows the workspace for leasing read role %s",
    (role) => {
      expect(canReadLeasing({ roleIds: [role] })).toBe(true);
    },
  );

  it("allows a rating-only analyst to open the rating workspace", () => {
    expect(canReadLeasing({ roleIds: ["leasing-rating-analyst"] })).toBe(true);
  });

  it.each([
    undefined,
    { roleIds: [] },
    { roleIds: ["user"] },
    { roleIds: ["leasing-workflow-worker"] },
    { roleIds: ["leasing-accounting-interface"] },
  ])("does not expose leasing without a business read role", (identity) => {
    expect(canReadLeasing(identity)).toBe(false);
  });

  it("normalizes configured role values", () => {
    expect(canReadLeasing({ roleIds: ["  LEASING-READER  "] })).toBe(true);
  });

  it("matches the web product and quote controls", () => {
    expect(canManageLeasingProducts(["leasing-product-manager"])).toBe(true);
    expect(canManageLeasingProducts(["leasing-pricing-manager"])).toBe(false);
    expect(canManageLeasingQuotes(["leasing-pricing-manager"])).toBe(true);
    expect(canManageLeasingQuotes(["leasing-reader"])).toBe(false);
  });

  it("limits deposit registration to the finance and treasury roles", () => {
    expect(canRecordLeasingDeposit(["leasing-finance-operator"])).toBe(true);
    expect(canRecordLeasingDeposit(["leasing-treasury-operator"])).toBe(true);
    expect(canRecordLeasingDeposit(["leasing-reader"])).toBe(false);
  });
});
