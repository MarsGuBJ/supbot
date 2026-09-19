/**
 * 测试 fixture：程序化生成最小 zip / docx / pdf / png 文件。
 * 零外部依赖（zip 用 zlib deflateRaw 手写，pdf 手写 xref）。
 */

import { deflateRawSync, deflateSync } from "node:zlib";

// ---- CRC32 ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---- zip（deflate 压缩）----

export interface ZipEntry {
  name: string;
  data: Buffer | string;
}

export function makeZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const compressed = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, compressed);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc32(raw), 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, name]));
    offset += local.length + name.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ---- 最小 docx ----

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
export { PNG_1PX };

const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const DOCX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCX_DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
</Relationships>`;

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style>
</w:styles>`;

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function wPara(text: string, opts: { style?: string; bold?: boolean } = {}): string {
  const pPr = opts.style ? `<w:pPr><w:pStyle w:val="${opts.style}"/></w:pPr>` : "";
  const rPr = opts.bold ? "<w:rPr><w:b/></w:rPr>" : "";
  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function wTable(rows: string[][]): string {
  const trs = rows.map((row) => `<w:tr>${row.map((cell) => `<w:tc>${wPara(cell)}</w:tc>`).join("")}</w:tr>`).join("");
  return `<w:tbl>${trs}</w:tbl>`;
}

const W_IMAGE = `<w:p><w:r><w:drawing>
<wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">
<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<pic:blipFill><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rId5" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></pic:blipFill>
</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;

/** 最小 docx：标题 + 加粗段落 + 2x2 表格 + 一张 1px 图片。 */
export function makeDocx(): Buffer {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
${wPara("年度总结", { style: "Heading1" })}
${wPara("这是一段普通正文。")}
${wPara("重点内容", { bold: true })}
${wTable([
  ["名称", "数量"],
  ["苹果", "3"],
])}
${W_IMAGE}
</w:body></w:document>`;
  return makeZip([
    { name: "[Content_Types].xml", data: DOCX_CONTENT_TYPES },
    { name: "_rels/.rels", data: DOCX_RELS },
    { name: "word/document.xml", data: document },
    { name: "word/styles.xml", data: DOCX_STYLES },
    { name: "word/_rels/document.xml.rels", data: DOCX_DOC_RELS },
    { name: "word/media/image1.png", data: PNG_1PX },
  ]);
}

// ---- 最小 PDF ----

interface PdfObject {
  id: number;
  body: string | Buffer;
}

function assemblePdf(objects: PdfObject[], rootId: number): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets = new Map<number, number>();
  let offset = parts[0]!.length;
  for (const obj of objects) {
    const body = Buffer.isBuffer(obj.body) ? obj.body : Buffer.from(obj.body, "latin1");
    const chunk = Buffer.concat([
      Buffer.from(`${obj.id} 0 obj\n`, "latin1"),
      body,
      Buffer.from("\nendobj\n", "latin1"),
    ]);
    offsets.set(obj.id, offset);
    parts.push(chunk);
    offset += chunk.length;
  }
  const maxId = Math.max(...objects.map((obj) => obj.id));
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) {
    xref += `${String(offsets.get(id) ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${maxId + 1} /Root ${rootId} 0 R >>\nstartxref\n${offset}\n%%EOF`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}

function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function streamObject(stream: string | Buffer, extraDict = ""): Buffer {
  const data = Buffer.isBuffer(stream) ? stream : Buffer.from(stream, "latin1");
  return Buffer.concat([
    Buffer.from(`<< /Length ${data.length}${extraDict} >>\nstream\n`, "latin1"),
    data,
    Buffer.from("\nendstream", "latin1"),
  ]);
}

export interface PdfPageSpec {
  /** 文本行（每行下移 20pt，12pt Helvetica）。 */
  lines?: string[];
  /** 原始 content stream 片段（优先于 lines，用于定制绘制方式）。 */
  content?: string;
  /** 是否嵌入一张 8x8 RGB 图像。 */
  withImage?: boolean;
}

/** 生成多页 PDF（MediaBox 足够宽，避免 pdfjs 按页面裁剪文本）。 */
export function makePdf(pages: PdfPageSpec[]): Buffer {
  const objects: PdfObject[] = [{ id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" }];
  let nextId = 3;
  const pageIds: number[] = [];
  const pageBodies: PdfObject[] = [];
  for (const spec of pages) {
    const pageId = nextId++;
    const contentId = nextId++;
    pageIds.push(pageId);
    let content = spec.content ?? "";
    if (!spec.content) {
      content = "BT /F1 12 Tf 72 700 Td ";
      for (const line of spec.lines ?? []) {
        content += `(${escapePdfText(line)}) Tj 0 -20 Td `;
      }
      content += "ET";
    }
    let resources = "<< /Font << /F1 9 0 R >> >>";
    if (spec.withImage) {
      const imageId = nextId++;
      content += ` q 8 0 0 8 0 0 cm /Im${imageId} Do Q`;
      const rgb = Buffer.alloc(8 * 8 * 3, 128);
      const compressed = deflateSync(rgb); // PDF FlateDecode 是 zlib 格式（非 raw deflate）
      pageBodies.push({
        id: imageId,
        body: streamObject(
          compressed,
          ` /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
        ),
      });
      resources = `<< /Font << /F1 9 0 R >> /XObject << /Im${imageId} ${imageId} 0 R >> >>`;
    }
    pageBodies.push({
      id: pageId,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 2000 792] /Resources ${resources} /Contents ${contentId} 0 R >>`,
    });
    pageBodies.push({ id: contentId, body: streamObject(content) });
  }
  objects.push({
    id: 2,
    body: `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  });
  objects.push(...pageBodies);
  objects.push({ id: 9, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" });
  return assemblePdf(objects, 1);
}

/** 有文本层的单页 PDF。 */
export function makeTextPdf(lines: string[]): Buffer {
  return makePdf([{ lines }]);
}

/** 词间只有定位间隙、没有空格字符的单页 PDF（复现英文词粘连场景）。 */
export function makeGapWordsPdf(words: string[]): Buffer {
  const runs = words.map((word) => `(${escapePdfText(word)}) Tj 80 0 Td`).join(" ");
  return makePdf([{ content: `BT /F1 12 Tf 72 700 Td ${runs} ET` }]);
}

/** 纯扫描 PDF（每页只有一张图像，无文本层）。 */
export function makeScanPdf(pageCount = 2): Buffer {
  return makePdf(Array.from({ length: pageCount }, () => ({ withImage: true })));
}

/** 混合 PDF：第 1 页正常文本，第 2 页含千分位金额行（疑似拍平表格）+ 内嵌图像。 */
export function makeMixedPdf(): Buffer {
  return makePdf([
    { lines: ["Quarterly report summary for the fiscal year, revenue grew steadily across all regions."] },
    {
      lines: ["Subtotal 1,234,567.00 and 9,876,543.21 plus 111,222.33 for the full fiscal year total"],
      withImage: true,
    },
  ]);
}

// ---- fake 视觉模型（实现 ModelAdapter 接口返回固定文本）----

import type { ModelConfig } from "@supbot/shared";
import type { ModelAdapter, ModelStreamEvent, ModelTurnRequest, ModelTurnResult } from "../../modelAdapter";
import type { VisionLlm } from "./vision";

export const FAKE_MODEL_CONFIG: ModelConfig = {
  providerName: "fake",
  baseUrl: "http://localhost:0/v1",
  model: "fake-vision",
  temperature: 0,
  maxTokens: 1024,
  apiKeySaved: false,
};

export class FakeVisionAdapter implements ModelAdapter {
  readonly requests: ModelTurnRequest[] = [];

  constructor(private readonly reply: string | ((request: ModelTurnRequest) => string)) {}

  async complete(input: ModelTurnRequest): Promise<ModelTurnResult> {
    this.requests.push(input);
    return { text: typeof this.reply === "function" ? this.reply(input) : this.reply, toolCalls: [] };
  }

  async *stream(input: ModelTurnRequest): AsyncGenerator<ModelStreamEvent, ModelTurnResult, unknown> {
    const result = await this.complete(input);
    if (result.text) {
      yield { type: "message_delta", delta: result.text };
    }
    return result;
  }
}

export function fakeVision(reply: string | ((request: ModelTurnRequest) => string)): {
  vision: VisionLlm;
  adapter: FakeVisionAdapter;
} {
  const adapter = new FakeVisionAdapter(reply);
  return { vision: { adapter, modelConfig: FAKE_MODEL_CONFIG }, adapter };
}
