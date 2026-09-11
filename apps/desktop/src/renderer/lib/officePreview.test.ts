import { describe, expect, it } from "vitest";
import { base64ToArrayBuffer, normalizeSheetRows, parseXlsxFirstSheet } from "./officePreview";

describe("office preview helpers", () => {
  it("decodes base64 into an ArrayBuffer", () => {
    const bytes = new Uint8Array(base64ToArrayBuffer("aGVsbG8="));
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
  });

  it("normalizes sheet rows with caps and string coercion", () => {
    const rows = normalizeSheetRows(
      [["名称", 1, null], ["苹果", 2.5, undefined], ...Array.from({ length: 300 }, () => ["x"])],
      200,
      2,
    );
    expect(rows).toHaveLength(200);
    expect(rows[0]).toEqual(["名称", "1"]);
    expect(rows[1]).toEqual(["苹果", "2.5"]);
  });

  it("parses the first sheet of an xlsx workbook", async () => {
    const XLSX = await import("xlsx");
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["名称", "数量"],
        ["苹果", 3],
      ]),
      "数据",
    );
    const base64 = XLSX.write(workbook, { type: "base64", bookType: "xlsx" });
    const sheet = await parseXlsxFirstSheet(base64);
    expect(sheet?.name).toBe("数据");
    expect(sheet?.rows.slice(0, 2)).toEqual([
      ["名称", "数量"],
      ["苹果", "3"],
    ]);
  });
});
