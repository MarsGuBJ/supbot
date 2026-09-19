/**
 * pdfjs-dist 的 Node 入口封装（legacy build，CJS，无需配置 worker：
 * Node 环境下 pdfjs 自动走 fake worker，同目录加载 pdf.worker.js）。
 *
 * 对应 k-pipeline 中 PyMuPDF（fitz）的文本层检测能力。
 */

import { readFileSync } from "node:fs";
import { getDocument, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.js";

/** 每页可提取字符数低于该值视为无文本层（扫描页），与 Python 版 _PDF_MIN_CHARS_PER_PAGE 一致。 */
export const PDF_MIN_CHARS_PER_PAGE = 50;

export async function openPdf(path: string): Promise<PDFDocumentProxy> {
  const data = new Uint8Array(readFileSync(path));
  return getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
}

/** 单页文本层内容（textContent items 按阅读顺序拼接）。 */
export async function pageTextContent(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent();
  return content.items
    .map((item) => ("str" in item ? item.str : ""))
    .join(" ")
    .trim();
}

/** 逐页可提取字符数（1 起始页码顺序）。 */
export async function pageCharCounts(doc: PDFDocumentProxy): Promise<number[]> {
  const counts: number[] = [];
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
    const page = await doc.getPage(pageNo);
    counts.push((await pageTextContent(page)).length);
  }
  return counts;
}

/**
 * 逐页文本层检测：返回无文本页（可提取字符数 < 阈值）的 1 起始页码列表。
 * 混合型 PDF（正文有文本层、中间夹扫描页）靠逐页检测发现。
 */
export async function pagesWithoutText(path: string, minCharsPerPage = PDF_MIN_CHARS_PER_PAGE): Promise<number[]> {
  const doc = await openPdf(path);
  try {
    const counts = await pageCharCounts(doc);
    return counts.map((count, index) => (count < minCharsPerPage ? index + 1 : 0)).filter((page) => page > 0);
  } finally {
    await doc.destroy();
  }
}

/**
 * 整档扫描件判定：无文本页占比 ≥ scannedRatio 判为扫描件。
 * 混合文档仍路由 pdf-text，只有绝大部分页都无文本时才整体走 pdf-scan。
 */
export async function isScannedPdf(
  path: string,
  minCharsPerPage = PDF_MIN_CHARS_PER_PAGE,
  scannedRatio = 0.8,
): Promise<boolean> {
  const doc = await openPdf(path);
  try {
    const total = doc.numPages;
    if (total === 0) {
      return true;
    }
    const counts = await pageCharCounts(doc);
    const noText = counts.filter((count) => count < minCharsPerPage).length;
    return noText / total >= scannedRatio;
  } finally {
    await doc.destroy();
  }
}
