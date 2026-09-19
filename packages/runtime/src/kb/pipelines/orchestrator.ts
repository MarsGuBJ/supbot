/**
 * 转换编排：route → convert → 质量校验 → 落盘 kb_root/raw/ → 低置信度进 Review。
 * 端口自 k-pipeline app/pipelines/orchestrator.py。
 *
 * 表格抢救：pdf-text 输出的 meta.quality.suspect_pages 非空（疑似无边框表格被拍平
 * / 无文本层）且视觉模型可用时，对这些页抽取页面图像做视觉转写，
 * 按 <!-- page:N --> 锚点替换主 markdown 中对应页内容，meta.quality 记录 rescued_pages。
 *
 * 与 Python 版的差异：表格抢救依赖页面栅格化，本实现用 pdfjs 内嵌图像抽取
 * 代替 canvas 渲染，因此对纯矢量文本页（无内嵌位图）无法抢救，保留 suspect_pages 标记。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ReviewQueue } from "../review";
import { sha256Of, type MarkdownBundle, type Pipeline } from "./base";
import { SCAN_PAGE_PROMPT, renderPdfPagePng } from "./pdfPipeline";
import { checkBundle } from "./quality";
import { route } from "./router";
import { parseLlmConfidence, visionComplete, type VisionLlm } from "./vision";

export const DEFAULT_OCR_CONFIDENCE_THRESHOLD = 0.8;

export interface ConvertFileOptions {
  /** 显式指定 pipeline（跳过 route 自动分发）。 */
  pipeline?: Pipeline;
  /** 视觉 LLM（pdf-scan / image pipeline 与表格抢救用）。 */
  vision?: VisionLlm | null;
  /** Review 队列（默认按 kbRoot 构造）。 */
  reviewQueue?: ReviewQueue;
  /** 低于该 ocr_confidence 进 Review（对应 Python settings.ocr_confidence_threshold）。 */
  ocrConfidenceThreshold?: number;
  /** 是否启用表格抢救（对应 Python settings.table_rescue）。 */
  tableRescue?: boolean;
}

const PAGE_ANCHOR_RE = /<!--\s*page:(\d+)\s*-->/g;

/**
 * 把单个文件转成 MarkdownBundle 并落盘：
 * - markdown → kbRoot/raw/markdown/{stem}.md
 * - assets   → kbRoot/raw/assets/{sha8}/（sha8 = 文档 sha256 前 8 位，
 *   按文档隔离子目录，避免跨文档同名图片互相覆盖；正文 assets/ 引用同步改写）
 * - meta.quality.ocr_confidence 低于阈值时写 Review 队列
 */
export async function convertFile(
  path: string,
  kbRoot: string,
  options: ConvertFileOptions = {},
): Promise<MarkdownBundle> {
  const vision = options.vision ?? null;
  const pipeline = options.pipeline ?? (await route(path, { vision }));
  const threshold = options.ocrConfidenceThreshold ?? DEFAULT_OCR_CONFIDENCE_THRESHOLD;
  const tableRescue = options.tableRescue ?? true;

  const assetsDir = join(kbRoot, "raw", "assets", (await sha256Of(path)).slice(0, 8));
  mkdirSync(assetsDir, { recursive: true });
  let bundle = checkBundle(await pipeline.convert(path, assetsDir));
  if (tableRescue) {
    bundle = checkBundle(await maybeRescueTables(bundle, path, vision));
  }
  bundle.markdown = rewriteAssetRefs(bundle.markdown, bundle.assets, assetsDir);

  const mdDir = join(kbRoot, "raw", "markdown");
  mkdirSync(mdDir, { recursive: true });
  const stem = basename(path).replace(/\.[^.]*$/, "");
  writeFileSync(join(mdDir, `${stem}.md`), bundle.markdown, "utf8");

  const confidence = bundle.meta.quality.ocr_confidence;
  if (confidence !== undefined && confidence !== null && confidence < threshold) {
    const reason = bundle.meta.quality.review_reason ?? `ocr_confidence ${confidence.toFixed(2)} 低于阈值 ${threshold}`;
    (options.reviewQueue ?? new ReviewQueue(kbRoot)).add(
      bundle.meta.source_file || basename(path),
      bundle.meta.format || "unknown",
      reason,
      confidence,
    );
  }
  return bundle;
}

/** 把正文中 assets/xxx.png 引用改写为 assets/{sha8}/xxx.png（与落盘位置对齐）。 */
export function rewriteAssetRefs(markdown: string, assets: string[], assetsDir: string): string {
  const sha8 = basename(assetsDir);
  for (const asset of assets) {
    const name = basename(asset);
    markdown = markdown.split(`assets/${name}`).join(`assets/${sha8}/${name}`);
  }
  return markdown;
}

// ------------------------------------------------------------------
// 表格抢救：suspect_pages（无边框表格拍平页 / 无文本层页）交给视觉模型重转

async function maybeRescueTables(
  bundle: MarkdownBundle,
  path: string,
  vision: VisionLlm | null,
): Promise<MarkdownBundle> {
  const suspect = bundle.meta.quality.suspect_pages ?? [];
  if (!suspect.length || !vision || bundle.meta.format !== "pdf-text") {
    return bundle;
  }

  const rescuePages = new Map<number, string>();
  for (const pageNo of suspect) {
    const png = await renderPdfPagePng(path, pageNo);
    if (!png) {
      continue; // 纯矢量文本页无法栅格化：保留原样与 suspect_pages 标记
    }
    try {
      const raw = await visionComplete(vision, { base64: png.toString("base64"), mime: "image/png" }, SCAN_PAGE_PROMPT);
      const [md] = parseLlmConfidence(raw);
      rescuePages.set(pageNo, md);
    } catch {
      // 抢救失败保留原文，仅留 suspect_pages 标记
    }
  }
  if (!rescuePages.size) {
    return bundle;
  }

  const [preamble, mainPages] = splitPageAnchors(bundle.markdown);
  for (const [pageNo, markdown] of rescuePages) {
    mainPages.set(pageNo, markdown);
  }
  bundle.markdown = joinPageAnchors(preamble, mainPages);
  bundle.meta.quality.rescued_pages = [...rescuePages.keys()].sort((a, b) => a - b);
  return bundle;
}

/** 按 <!-- page:N --> 锚点切分，返回 [首个锚点之前的内容, {页码: 页内容}]。 */
export function splitPageAnchors(markdown: string): [string, Map<number, string>] {
  const preamble = markdown.split(PAGE_ANCHOR_RE)[0]?.trim() ?? "";
  const pages = new Map<number, string>();
  const matches = [...markdown.matchAll(PAGE_ANCHOR_RE)];
  for (let i = 0; i < matches.length; i += 1) {
    const start = matches[i]!.index! + matches[i]![0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : markdown.length;
    pages.set(Number.parseInt(matches[i]![1]!, 10), markdown.slice(start, end).trim());
  }
  return [preamble, pages];
}

/** 把 (前导内容, {页码: 页内容}) 拼回带页锚点的 markdown（按页码升序）。 */
export function joinPageAnchors(preamble: string, pages: Map<number, string>): string {
  const blocks: string[] = preamble ? [preamble] : [];
  for (const [page, content] of [...pages.entries()].sort((a, b) => a[0] - b[0])) {
    blocks.push(content ? `<!-- page:${page} -->\n\n${content}` : `<!-- page:${page} -->`);
  }
  return `${blocks.join("\n\n")}\n`;
}
