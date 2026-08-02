import { describe, expect, it } from "vitest";
import { LEASING_NAVIGATION } from "../views/LeasingWorkspace";

describe("leasing workspace navigation", () => {
  it("contains only operating and asset-operation pages", () => {
    expect(LEASING_NAVIGATION.map((group) => group.group)).toEqual(["operations", "asset-operations"]);
    expect(LEASING_NAVIGATION.flatMap((group) => group.items.map((item) => item.key))).toEqual([
      "risk-rating",
      "dashboard",
      "customers",
      "partners",
      "projects",
      "pricing",
      "credit",
      "group-credit",
      "contracts-assets",
      "receivables-payments",
      "post-lease",
    ]);
  });

  it("does not expose management workspaces", () => {
    const keys: string[] = LEASING_NAVIGATION.flatMap((group) => group.items.map((item) => item.key));
    expect(keys).not.toContain("finance-treasury");
    expect(keys).not.toContain("regulatory");
    expect(keys).not.toContain("ai-ontology");
    expect(keys).not.toContain("audit");
  });
});
