import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { FileFormat, identifyFormat, isScannedPdf, sniffCsv } from "./router";
import { pagesWithoutText } from "./pdfDoc";
import { makeDocx, makeMixedPdf, makeScanPdf, makeTextPdf, makeZip, PNG_1PX } from "./testFixtures";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-router-"));
});

function fixture(name: string, data: Buffer | string): string {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
}

describe("identifyFormat L1: magic bytes", () => {
  it("PNG / JPEG / GIF / WEBP → image", async () => {
    expect(await identifyFormat(fixture("a.png", PNG_1PX))).toBe(FileFormat.Image);
    expect(await identifyFormat(fixture("a.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])))).toBe(FileFormat.Image);
    expect(await identifyFormat(fixture("a.gif", Buffer.from("GIF89axxxx", "latin1")))).toBe(FileFormat.Image);
    expect(await identifyFormat(fixture("a.bin", Buffer.from("RIFF\x00\x00\x00\x00WEBP", "latin1")))).toBe(
      FileFormat.Image,
    );
  });

  it("PK zip 按内部结构区分 docx / xlsx / unknown", async () => {
    expect(await identifyFormat(fixture("a.docx", makeDocx()))).toBe(FileFormat.Docx);
    const fakeXlsx = makeZip([{ name: "xl/workbook.xml", data: "<workbook/>" }]);
    expect(await identifyFormat(fixture("a.xlsx", fakeXlsx))).toBe(FileFormat.Xlsx);
    const pptx = makeZip([{ name: "ppt/presentation.xml", data: "<p/>" }]);
    expect(await identifyFormat(fixture("a.pptx", pptx))).toBe(FileFormat.Unknown);
  });

  it("OLE 复合文档按扩展名区分 doc-legacy / xls-legacy", async () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect(await identifyFormat(fixture("old.doc", ole))).toBe(FileFormat.DocLegacy);
    expect(await identifyFormat(fixture("old.xls", ole))).toBe(FileFormat.XlsLegacy);
    expect(await identifyFormat(fixture("old.ppt", ole))).toBe(FileFormat.Unknown);
  });

  it("PDF 按文本层密度区分 pdf-text / pdf-scan", async () => {
    expect(
      await identifyFormat(
        fixture(
          "text.pdf",
          makeTextPdf(["This page carries a real text layer with well over fifty characters in it."]),
        ),
      ),
    ).toBe(FileFormat.PdfText);
    expect(await identifyFormat(fixture("scan.pdf", makeScanPdf(2)))).toBe(FileFormat.PdfScan);
  });
});

describe("identifyFormat L2/L3: 扩展名 + 内容嗅探", () => {
  it("按扩展名识别 txt/md/csv/html", async () => {
    expect(await identifyFormat(fixture("a.txt", "plain text"))).toBe(FileFormat.Txt);
    expect(await identifyFormat(fixture("a.md", "# 标题"))).toBe(FileFormat.Md);
    expect(await identifyFormat(fixture("a.csv", "a,b\n1,2"))).toBe(FileFormat.Csv);
    expect(await identifyFormat(fixture("a.html", "<p>hi</p>"))).toBe(FileFormat.Html);
  });

  it("无扩展名文本兜底 txt；二进制兜底 unknown", async () => {
    expect(await identifyFormat(fixture("noext", "just some readable text"))).toBe(FileFormat.Txt);
    expect(await identifyFormat(fixture("bin.dat", Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff])))).toBe(
      FileFormat.Unknown,
    );
  });
});

describe("pdf 逐页文本层检测", () => {
  it("isScannedPdf / pagesWithoutText", async () => {
    const scan = fixture("scan2.pdf", makeScanPdf(3));
    expect(await isScannedPdf(scan)).toBe(true);
    expect(await pagesWithoutText(scan)).toEqual([1, 2, 3]);

    const mixed = fixture("mixed.pdf", makeMixedPdf());
    expect(await isScannedPdf(mixed)).toBe(false);
    expect(await pagesWithoutText(mixed)).toEqual([]);
  });
});

describe("sniffCsv", () => {
  it("识别 utf-8 + 逗号 / 分号分隔符", () => {
    expect(sniffCsv(fixture("c1.csv", "a,b,c\n1,2,3\n4,5,6"))).toEqual({ encoding: "utf-8", delimiter: "," });
    expect(sniffCsv(fixture("c2.csv", "a;b;c\n1;2;3\n4;5;6"))).toEqual({ encoding: "utf-8", delimiter: ";" });
  });

  it("UTF-16LE BOM 嗅探", () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a\tb\n1\t2", "utf16le")]);
    const result = sniffCsv(fixture("c3.csv", utf16));
    expect(result.encoding).toBe("utf-16le");
    expect(result.delimiter).toBe("\t");
  });
});
