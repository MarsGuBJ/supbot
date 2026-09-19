import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { beforeAll, describe, expect, it } from "vitest";
import { HEAD_ROWS, parseCsv, sheetToMd, TablePipeline } from "./tablePipeline";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-table-"));
});

function fixture(name: string, data: Buffer | string): string {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
}

function makeXlsx(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("TablePipeline xlsx", () => {
  it("每个 sheet → 二级标题 + GFM 表格；末尾空行剔除", async () => {
    const file = fixture(
      "book.xlsx",
      makeXlsx({
        库存: [
          ["名称", "数量"],
          ["苹果", 3],
          ["梨", 5],
        ],
        空表: [],
      }),
    );
    const bundle = await new TablePipeline().convert(file, join(dir, "assets-xlsx"));
    expect(bundle.markdown).toContain("## 库存");
    expect(bundle.markdown).toContain("| 名称 | 数量 |");
    expect(bundle.markdown).toContain("| 苹果 | 3 |");
    expect(bundle.markdown).toContain("## 空表\n\n（空表）");
    expect(bundle.meta.format).toBe("xlsx");
    expect(bundle.meta.quality.tables).toBe(1);
  });

  it("宽表（>20 列）截断并追加 schema 摘要", async () => {
    const header = Array.from({ length: 25 }, (_, i) => `col${i}`);
    const rows = [header, ...Array.from({ length: 10 }, (_, r) => header.map((_, c) => r * 100 + c))];
    const file = fixture("wide.xlsx", makeXlsx({ 宽表: rows }));
    const bundle = await new TablePipeline().convert(file, join(dir, "assets-wide"));
    expect(bundle.markdown).toContain("宽表摘要：共 10 行");
    expect(bundle.markdown).toContain("`col0`: number");
    // 只展示前 HEAD_ROWS 行 + 表头
    const tableLines = bundle.markdown.split("\n").filter((line) => line.startsWith("|"));
    expect(tableLines.length).toBeLessThanOrEqual(HEAD_ROWS + 2);
  });

  it("超长表（>500 行）截断", () => {
    const rows = [["n"], ...Array.from({ length: 600 }, (_, i) => [i])];
    const md = sheetToMd("长表", rows);
    expect(md).toContain("宽表摘要：共 600 行（仅展示前 50 行）");
  });
});

describe("TablePipeline csv", () => {
  it("逗号 csv → GFM 表格", async () => {
    const file = fixture("data.csv", "名称,数量\n苹果,3\n梨,5\n");
    const bundle = await new TablePipeline().convert(file, join(dir, "assets-csv"));
    expect(bundle.markdown).toContain("## data");
    expect(bundle.markdown).toContain("| 名称 | 数量 |");
    expect(bundle.markdown).toContain("| 梨 | 5 |");
    expect(bundle.meta.format).toBe("csv");
  });

  it("分号分隔 + 引号包裹字段", async () => {
    const file = fixture("semi.csv", 'a;b\n"x;y";2\n');
    const bundle = await new TablePipeline().convert(file, join(dir, "assets-semi"));
    expect(bundle.markdown).toContain("| a | b |");
    expect(bundle.markdown).toContain("x;y");
  });
});

describe("parseCsv", () => {
  it("引号内换行与双引号转义", () => {
    const rows = parseCsv('a,b\n"x\ny","he said ""hi"""', ",");
    expect(rows).toEqual([
      ["a", "b"],
      ["x\ny", 'he said "hi"'],
    ]);
  });

  it("空字段为 null", () => {
    expect(parseCsv("a,,c", ",")[0]).toEqual(["a", null, "c"]);
  });
});
