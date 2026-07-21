import { describe, expect, test } from "vitest";
import {
  extractReviewViolations,
  formatAutopilotApprovalHistory,
  goalReviewPassed,
  sumOptionalNumber
} from "../src/autopilotRuntime";
import {
  marketInstallSlug,
  materializeInstallPath,
  normalizeMarketMcpTimeout,
  resolveToolMarketPackagePath,
  uniqueMarketProducts
} from "../src/toolMarketRuntime";

describe("autopilot runtime policy helpers", () => {
  test("parses review outcomes and usage totals", () => {
    expect(goalReviewPassed("PASS\nAll checks passed")).toBe(true);
    expect(goalReviewPassed("FAIL\n- missing test\n- wrong output")).toBe(false);
    expect(extractReviewViolations("FAIL\n- missing test\n* wrong output")).toEqual(["missing test", "wrong output"]);
    expect(sumOptionalNumber(undefined, undefined)).toBeUndefined();
    expect(sumOptionalNumber(3, undefined)).toBe(3);
  });

  test("formats approval history without exposing object formatting", () => {
    const history = formatAutopilotApprovalHistory([{
      id: "event-1",
      runId: "run-1",
      kind: "approval",
      message: "Autopilot approval granted",
      createdAt: "2026-07-21T00:00:00.000Z",
      data: { decision: { title: "Write README", kind: "file_write", risk: "high", impact: ["README.md"] }, comment: "approved" }
    }]);
    expect(history).toContain("Approved");
    expect(history).toContain("README.md");
  });
});

describe("tool market runtime policy helpers", () => {
  test("normalizes install values and rejects path escapes", () => {
    expect(marketInstallSlug("Vendor/My Tool")).toBe("vendor-my-tool");
    expect(materializeInstallPath("{installDir}/server.js", "C:/tools/product")).toBe("C:/tools/product/server.js");
    expect(normalizeMarketMcpTimeout(5)).toBe(1_000);
    expect(normalizeMarketMcpTimeout(500_000)).toBe(120_000);
    expect(resolveToolMarketPackagePath("C:/tools/product", "dist/server.js")).toContain("dist");
    expect(() => resolveToolMarketPackagePath("C:/tools/product", "../escape.js")).toThrow(/escapes install directory/);
  });

  test("keeps the last market product for duplicate ids", () => {
    const products = [
      { id: "same", name: "first" },
      { id: "same", name: "second" }
    ] as never[];
    expect(uniqueMarketProducts(products)).toEqual([{ id: "same", name: "second" }]);
  });
});
