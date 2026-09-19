/**
 * table-pipeline：xlsx（SheetJS）/ csv 转 Markdown。
 * 端口自 k-pipeline app/pipelines/table_pipeline.py
 * （openpyxl → xlsx，pandas → 内置 CSV 解析器）。
 *
 * - 每个 sheet → `## sheet名` + GFM 表格；
 * - 超过 20 列或 500 行的宽表只输出前 50 行，并追加 schema 摘要（列名、dtype、总行数）；
 * - 合并单元格语义保留：只有合并区域首单元格取值，其余为空。
 */

import { mkdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import * as XLSX from "xlsx";
import { baseMeta, type MarkdownBundle, type Pipeline } from "./base";
import { decodeText } from "./encoding";
import { checkBundle, toGfmTable } from "./quality";
import { FileFormat, identifyFormat, sniffCsv } from "./router";

export const MAX_COLS = 20;
export const MAX_ROWS = 500;
export const HEAD_ROWS = 50;

type Cell = string | number | boolean | Date | null;

/** 从列采样值推断简单类型。 */
function dtypeOf(values: Cell[]): string {
  const seen = new Set(values.filter((v) => v !== null).map((v) => (v instanceof Date ? "date" : typeof v)));
  if (!seen.size) {
    return "unknown";
  }
  if ([...seen].every((t) => t === "number")) {
    return "number";
  }
  if ([...seen].every((t) => t === "date")) {
    return "datetime";
  }
  if ([...seen].every((t) => t === "boolean")) {
    return "bool";
  }
  return "string";
}

/** 宽表 schema 摘要：列名、dtype、总行数。 */
function schemaSummary(header: Cell[], rows: Cell[][], totalRows: number): string {
  const lines = [`> 宽表摘要：共 ${totalRows} 行（仅展示前 ${HEAD_ROWS} 行）`, ">"];
  for (let i = 0; i < header.length; i += 1) {
    const colValues = rows.filter((row) => i < row.length).map((row) => row[i]!);
    lines.push(`> - \`${header[i]}\`: ${dtypeOf(colValues)}`);
  }
  return lines.join("\n");
}

/** 单个 sheet / 单个数据表 → 二级标题 + GFM 表格（宽表截断 + schema 摘要）。 */
export function sheetToMd(title: string, rows: Cell[][]): string {
  if (!rows.length) {
    return `## ${title}\n\n（空表）`;
  }
  const totalRows = Math.max(rows.length - 1, 0);
  const nCols = Math.max(...rows.map((row) => row.length));
  const [header, ...body] = rows as [Cell[], ...Cell[][]];
  if (nCols > MAX_COLS || totalRows > MAX_ROWS) {
    const shown = [header, ...body.slice(0, HEAD_ROWS)];
    return `## ${title}\n\n${toGfmTable(shown)}\n\n${schemaSummary(header, body, totalRows)}`;
  }
  return `## ${title}\n\n${toGfmTable(rows)}`;
}

export class TablePipeline implements Pipeline {
  readonly name = "table-pipeline";

  async detect(file: string): Promise<boolean> {
    const format = await identifyFormat(file);
    return format === FileFormat.Xlsx || format === FileFormat.Csv;
  }

  async convert(file: string, assetsDir: string): Promise<MarkdownBundle> {
    mkdirSync(assetsDir, { recursive: true });
    const format = await identifyFormat(file);
    let markdown: string;
    if (format === FileFormat.Xlsx) {
      markdown = this.xlsxMd(file);
    } else if (format === FileFormat.Csv) {
      markdown = this.csvMd(file);
    } else {
      throw new Error(`table-pipeline 不支持格式: ${format}`);
    }
    const meta = await baseMeta(file, format, this.name);
    return checkBundle({ markdown, assets: [], meta });
  }

  // ------------------------------------------------------------------

  private xlsxMd(file: string): string {
    const workbook = XLSX.read(readFileSync(file), { type: "buffer", cellDates: true });
    const blocks: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName]!;
      let rows = XLSX.utils.sheet_to_json<Cell[]>(sheet, { header: 1, raw: true, defval: null }) as Cell[][];
      // 去掉末尾全空行
      while (rows.length && rows[rows.length - 1]!.every((value) => value === null)) {
        rows = rows.slice(0, -1);
      }
      blocks.push(sheetToMd(sheetName, rows));
    }
    return `${blocks.join("\n\n")}\n`;
  }

  private csvMd(file: string): string {
    const dialect = sniffCsv(file);
    const text = decodeText(readFileSync(file), dialect.encoding);
    const rows = parseCsv(text, dialect.delimiter);
    // 去掉末尾全空行
    while (rows.length && rows[rows.length - 1]!.every((value) => value === null || value === "")) {
      rows.pop();
    }
    return `${sheetToMd(basename(file).replace(/\.[^.]*$/, ""), rows)}\n`;
  }
}

/**
 * 最小 CSV 解析器（支持引号包裹、引号内换行/分隔符、"" 转义）。
 * pandas.read_csv(dtype=object) 的对应物：全部字段按字符串处理。
 */
export function parseCsv(text: string, delimiter: string): Cell[][] {
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = (): void => {
    row.push(field === "" ? null : field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== "" || row.length) {
    pushRow();
  }
  return rows;
}
