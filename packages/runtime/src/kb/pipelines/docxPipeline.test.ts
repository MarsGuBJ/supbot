import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { docxHtmlToMarkdown, DocxPipeline } from "./docxPipeline";
import { makeDocx, PNG_1PX } from "./testFixtures";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-docx-"));
});

describe("docxHtmlToMarkdown", () => {
  it("标题 / 加粗 / 斜体 / 段落", () => {
    const md = docxHtmlToMarkdown("<h1>标题</h1><p>普通<strong>加粗</strong><em>斜体</em></p>");
    expect(md).toContain("# 标题");
    expect(md).toContain("**加粗**");
    expect(md).toContain("*斜体*");
  });

  it("表格 → GFM", () => {
    const md = docxHtmlToMarkdown("<table><tr><td>名称</td><td>数量</td></tr><tr><td>苹果</td><td>3</td></tr></table>");
    expect(md).toContain("| 名称 | 数量 |");
    expect(md).toContain("| 苹果 | 3 |");
  });

  it("图片引用与列表", () => {
    const md = docxHtmlToMarkdown('<p><img src="assets/image1.png"/></p><ul><li>甲</li><li>乙</li></ul>');
    expect(md).toContain("![](assets/image1.png)");
    expect(md).toContain("- 甲");
    expect(md).toContain("- 乙");
  });
});

describe("DocxPipeline.convert（mammoth 端到端）", () => {
  it("最小 docx：标题/表格/图片资产", async () => {
    const file = join(dir, "sample.docx");
    writeFileSync(file, makeDocx());
    const assetsDir = join(dir, "assets-docx");
    const bundle = await new DocxPipeline().convert(file, assetsDir);

    expect(bundle.meta.format).toBe("docx");
    expect(bundle.meta.pipeline).toBe("docx-pipeline");
    expect(bundle.markdown).toContain("年度总结");
    expect(bundle.markdown).toContain("普通正文");
    expect(bundle.markdown).toContain("| 名称 | 数量 |");
    expect(bundle.markdown).toContain("![](assets/image1.png)");
    // 图片落盘到 assets 目录且内容与源一致
    expect(bundle.assets.length).toBe(1);
    expect(existsSync(bundle.assets[0]!)).toBe(true);
    expect(readFileSync(bundle.assets[0]!)).toEqual(PNG_1PX);
  });
});
