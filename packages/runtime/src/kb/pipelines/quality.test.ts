import { describe, expect, it } from "vitest";
import { escapeCell, toGfmTable, toHtmlTable, validateMarkdown } from "./quality";

describe("toGfmTable", () => {
  it("首行表头 + 分隔行 + 数据行", () => {
    const md = toGfmTable([
      ["名称", "数量"],
      ["苹果", 3],
    ]);
    expect(md).toBe("| 名称 | 数量 |\n| --- | --- |\n| 苹果 | 3 |");
  });

  it("竖线与换行转义；null 置空；行宽不齐补齐", () => {
    expect(escapeCell("a|b")).toBe("a\\|b");
    expect(escapeCell("a\nb")).toBe("a<br>b");
    expect(escapeCell(null)).toBe("");
    const md = toGfmTable([["a", "b"], ["1"]]);
    expect(md.split("\n")[2]).toBe("| 1 |  |");
  });

  it("空表返回空串", () => {
    expect(toGfmTable([])).toBe("");
  });
});

describe("toHtmlTable", () => {
  it("生成 <table> 并转义 HTML", () => {
    const html = toHtmlTable([["<h>"], ["a&b"]]);
    expect(html).toContain("<th>&lt;h&gt;</th>");
    expect(html).toContain("<td>a&amp;b</td>");
  });
});

describe("validateMarkdown", () => {
  it("行列一致的 GFM 表保持不变", () => {
    const input = "# t\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    const { markdown, quality } = validateMarkdown(input);
    expect(markdown).toBe(input);
    expect(quality).toMatchObject({ tables: 1, tables_degraded_to_html: 0 });
  });

  it("行列不一致的表降级为 HTML <table>", () => {
    const input = "| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n";
    const { markdown, quality } = validateMarkdown(input);
    expect(markdown).toContain("<table>");
    expect(markdown).toContain("<td>3</td>");
    expect(quality.tables_degraded_to_html).toBe(1);
  });

  it("转义竖线不算列分隔", () => {
    const input = "| a \\| x | b |\n| --- | --- |\n| 1 | 2 |\n";
    const { quality } = validateMarkdown(input);
    expect(quality.tables_degraded_to_html).toBe(0);
  });
});
