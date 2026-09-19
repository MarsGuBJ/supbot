import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ReviewQueue } from "../review";
import { convertFile, joinPageAnchors, rewriteAssetRefs, splitPageAnchors } from "./orchestrator";
import { fakeVision, makeDocx, makeMixedPdf, makeScanPdf, PNG_1PX } from "./testFixtures";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-orch-"));
});

let kbCounter = 0;
function freshKbRoot(): string {
  kbCounter += 1;
  return join(dir, `kb${kbCounter}`);
}

function fixture(name: string, data: Buffer | string): string {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
}

describe("convertFile 落盘", () => {
  it("txt → raw/markdown/{stem}.md，sha8 assets 目录建立", async () => {
    const kbRoot = freshKbRoot();
    const file = fixture("报告.txt", "正文内容\r\n第二行");
    const bundle = await convertFile(file, kbRoot);
    expect(bundle.meta.format).toBe("txt");
    const md = readFileSync(join(kbRoot, "raw", "markdown", "报告.md"), "utf8");
    expect(md).toContain("正文内容");
    expect(existsSync(join(kbRoot, "raw", "assets", bundle.meta.sha256.slice(0, 8)))).toBe(true);
  });

  it("docx → assets 按 sha8 隔离且正文引用改写", async () => {
    const kbRoot = freshKbRoot();
    const file = fixture("sample.docx", makeDocx());
    const bundle = await convertFile(file, kbRoot);
    const sha8 = bundle.meta.sha256.slice(0, 8);
    expect(bundle.markdown).toContain(`![](assets/${sha8}/image1.png)`);
    expect(bundle.markdown).not.toContain("![](assets/image1.png)");
    expect(existsSync(join(kbRoot, "raw", "assets", sha8, "image1.png"))).toBe(true);
  });
});

describe("convertFile 低置信度进 Review", () => {
  it("旧格式 .doc：不转换，Review 注明 LibreOffice 原因", async () => {
    const kbRoot = freshKbRoot();
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    const file = fixture("old.doc", ole);
    const bundle = await convertFile(file, kbRoot);
    expect(bundle.meta.format).toBe("doc-legacy");
    const items = new ReviewQueue(kbRoot).list();
    expect(items.length).toBe(1);
    expect(items[0]!.reason).toContain("LibreOffice");
    expect(items[0]!.confidence).toBe(0);
    expect(items[0]!.sourceFile).toBe("old.doc");
  });

  it("扫描 PDF 无视觉模型 → Review", async () => {
    const kbRoot = freshKbRoot();
    const file = fixture("scan.pdf", makeScanPdf(2));
    const bundle = await convertFile(file, kbRoot);
    expect(bundle.meta.format).toBe("pdf-scan");
    const items = new ReviewQueue(kbRoot).list();
    expect(items.length).toBe(1);
    expect(items[0]!.reason).toContain("视觉模型未配置");
  });

  it("扫描 PDF 有视觉模型且高置信度 → 不进 Review", async () => {
    const kbRoot = freshKbRoot();
    const file = fixture("scan-ok.pdf", makeScanPdf(1));
    const { vision } = fakeVision("# 转写 <!-- confidence: 0.95 -->");
    const bundle = await convertFile(file, kbRoot, { vision });
    expect(bundle.markdown).toContain("转写");
    expect(new ReviewQueue(kbRoot).list()).toEqual([]);
  });

  it("图片低置信度 → Review", async () => {
    const kbRoot = freshKbRoot();
    const file = fixture("img.png", PNG_1PX);
    const { vision } = fakeVision("# 模糊 <!-- confidence: 0.3 -->");
    await convertFile(file, kbRoot, { vision });
    const items = new ReviewQueue(kbRoot).list();
    expect(items.length).toBe(1);
    expect(items[0]!.reason).toContain("低于阈值");
  });
});

describe("表格抢救", () => {
  it("suspect_pages 经视觉模型重转并按页锚点替换", async () => {
    const kbRoot = freshKbRoot();
    const file = fixture("mixed.pdf", makeMixedPdf());
    const { vision, adapter } = fakeVision(
      "| 项目 | 金额 |\n| --- | --- |\n| 小计 | 1,234,567.00 | <!-- confidence: 0.9 -->",
    );
    const bundle = await convertFile(file, kbRoot, { vision });

    expect(bundle.meta.quality.suspect_pages).toEqual([2]);
    expect(bundle.meta.quality.rescued_pages).toEqual([2]);
    expect(adapter.requests.length).toBe(1);
    // 第 2 页内容被抢救结果替换，第 1 页保持原文
    const [, pages] = splitPageAnchors(bundle.markdown);
    expect(pages.get(2)).toContain("| 小计 | 1,234,567.00 |");
    expect(pages.get(1)).toContain("Quarterly report");
    expect(bundle.markdown).toMatch(/<!-- page:1 -->[\s\S]*<!-- page:2 -->/);
  });

  it("无视觉模型时保留原文与 suspect_pages 标记", async () => {
    const kbRoot = freshKbRoot();
    const file = fixture("mixed2.pdf", makeMixedPdf());
    const bundle = await convertFile(file, kbRoot);
    expect(bundle.meta.quality.suspect_pages).toEqual([2]);
    expect(bundle.meta.quality.rescued_pages).toBeUndefined();
    expect(bundle.markdown).toContain("1,234,567.00");
  });
});

describe("锚点工具", () => {
  it("split/join 往返", () => {
    const md = "前言\n\n<!-- page:1 -->\n\n第一页\n\n<!-- page:3 -->\n\n第三页\n";
    const [preamble, pages] = splitPageAnchors(md);
    expect(preamble).toBe("前言");
    expect([...pages.keys()]).toEqual([1, 3]);
    expect(joinPageAnchors(preamble, pages)).toBe("前言\n\n<!-- page:1 -->\n\n第一页\n\n<!-- page:3 -->\n\n第三页\n");
  });

  it("joinPageAnchors 允许插入新页并按页码排序", () => {
    const pages = new Map([
      [1, "a"],
      [3, "c"],
    ]);
    pages.set(2, "b");
    expect(joinPageAnchors("", pages)).toBe("<!-- page:1 -->\n\na\n\n<!-- page:2 -->\n\nb\n\n<!-- page:3 -->\n\nc\n");
  });

  it("rewriteAssetRefs 只改 assets/ 前缀引用", () => {
    const md = "![](assets/a.png) 和 http://x/assets/a.png";
    const out = rewriteAssetRefs(md, ["/tmp/abcd1234/a.png"], "/kb/raw/assets/abcd1234");
    expect(out).toContain("![](assets/abcd1234/a.png)");
  });
});
