import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { encodePng, PdfScanPipeline, PdfTextPipeline, renderPdfPagePng } from "./pdfPipeline";
import { fakeVision, makeGapWordsPdf, makeMixedPdf, makeScanPdf, makeTextPdf } from "./testFixtures";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-pdf-"));
});

function fixture(name: string, data: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
}

describe("PdfTextPipeline", () => {
  it("提取文本层，每页出 <!-- page:N --> 锚点", async () => {
    const file = fixture(
      "text.pdf",
      makeTextPdf(["This page carries a real text layer with well over fifty characters in it."]),
    );
    const bundle = await new PdfTextPipeline().convert(file, join(dir, "assets-t"));
    expect(bundle.meta.format).toBe("pdf-text");
    expect(bundle.meta.pages).toBe(1);
    expect(bundle.markdown).toContain("<!-- page:1 -->");
    expect(bundle.markdown).toContain("real text layer");
    expect(bundle.meta.quality.no_text_pages).toEqual([]);
    expect(bundle.meta.quality.suspect_pages).toEqual([]);
  });

  it("词间无空格字符的英文 PDF 按定位间隙补空格", async () => {
    const file = fixture(
      "gap-words.pdf",
      makeGapWordsPdf(["Hello", "world", "from", "HyWork", "knowledge", "base", "pipeline", "testing"]),
    );
    const bundle = await new PdfTextPipeline().convert(file, join(dir, "assets-gap"));
    expect(bundle.markdown).toContain("Hello world from HyWork knowledge base pipeline testing");
  });

  it("千分位金额行 → suspect_pages；无文本页并入 suspect_pages", async () => {
    const file = fixture("mixed.pdf", makeMixedPdf());
    const bundle = await new PdfTextPipeline().convert(file, join(dir, "assets-m"));
    expect(bundle.meta.pages).toBe(2);
    expect(bundle.markdown).toContain("<!-- page:1 -->");
    expect(bundle.markdown).toContain("<!-- page:2 -->");
    expect(bundle.meta.quality.suspect_pages).toEqual([2]);
  });
});

describe("encodePng / renderPdfPagePng", () => {
  it("RGB 像素编码为合法 PNG", () => {
    const png = encodePng({ data: new Uint8Array(2 * 2 * 3).fill(255), width: 2, height: 2, channels: 3 });
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.toString("latin1")).toContain("IHDR");
    expect(png.toString("latin1")).toContain("IDAT");
  });

  it("从扫描页抽取内嵌图像并编码 PNG", async () => {
    const file = fixture("scan.pdf", makeScanPdf(1));
    const png = await renderPdfPagePng(file, 1);
    expect(png).not.toBeNull();
    expect(png!.subarray(1, 4).toString("latin1")).toBe("PNG");
    const ihdr = png!.indexOf("IHDR");
    expect(png!.readUInt32BE(ihdr + 4)).toBe(8); // width
    expect(png!.readUInt32BE(ihdr + 8)).toBe(8); // height
  });

  it("无内嵌位图的页返回 null", async () => {
    const file = fixture(
      "plain.pdf",
      makeTextPdf(["A normal text page without any embedded image objects in it at all."]),
    );
    expect(await renderPdfPagePng(file, 1)).toBeNull();
  });
});

describe("PdfScanPipeline", () => {
  it("视觉模型可用：逐页转写 + 页锚点 + 置信度", async () => {
    const file = fixture("scan2.pdf", makeScanPdf(2));
    const { vision, adapter } = fakeVision("# 第 1 页内容\n\n转写文本 <!-- confidence: 0.92 -->");
    const bundle = await new PdfScanPipeline(vision).convert(file, join(dir, "assets-s"));
    expect(bundle.meta.format).toBe("pdf-scan");
    expect(bundle.meta.pages).toBe(2);
    expect(bundle.markdown).toContain("<!-- page:1 -->");
    expect(bundle.markdown).toContain("<!-- page:2 -->");
    expect(bundle.markdown).toContain("第 1 页内容");
    expect(bundle.markdown).not.toContain("confidence:");
    expect(bundle.meta.quality.ocr_confidence).toBe(0.92);
    // 每页一次视觉调用，且消息带多模态图片 content
    expect(adapter.requests.length).toBe(2);
    const content = adapter.requests[0]!.messages[0]!.content as unknown as Array<{
      type: string;
      image_url?: { url: string };
    }>;
    expect(content[0]!.type).toBe("text");
    expect(content[1]!.image_url!.url).toMatch(/^data:image\/png;base64,/);
  });

  it("视觉模型未配置：ocr_confidence=0 + review_reason（进 Review）", async () => {
    const file = fixture("scan3.pdf", makeScanPdf(1));
    const bundle = await new PdfScanPipeline(null).convert(file, join(dir, "assets-s3"));
    expect(bundle.meta.quality.ocr_confidence).toBe(0);
    expect(bundle.meta.quality.review_reason).toContain("视觉模型未配置");
  });

  it("视觉调用失败：页记缺失，置信度归零", async () => {
    const file = fixture("scan4.pdf", makeScanPdf(1));
    const { vision } = fakeVision(() => {
      throw new Error("model does not support images");
    });
    const bundle = await new PdfScanPipeline(vision).convert(file, join(dir, "assets-s4"));
    expect(bundle.meta.quality.ocr_confidence).toBe(0);
    expect(bundle.meta.quality.review_reason).toContain("未能视觉转写");
  });
});
