/**
 * 统一 Pipeline 接口与输出数据模型。
 * 端口自 k-pipeline app/pipelines/base.py（Python → TypeScript）。
 *
 * 所有格式 pipeline 只负责「还原为保真 Markdown」，不感知后续知识处理。
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";

/** 计算文件内容哈希，用于增量摄入去重与 assets 目录隔离。 */
export function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** 转换质量指标（写入 meta.quality，低置信度由编排层进 Review 队列）。 */
export interface BundleQuality {
  /** GFM 表格数（validateMarkdown 统计）。 */
  tables?: number;
  /** 行列不一致被降级为 HTML <table> 的表格数。 */
  tables_degraded_to_html?: number;
  paragraphs?: number;
  /** OCR/视觉转写自评置信度（0..1）。 */
  ocr_confidence?: number;
  /** 疑似无边框表格被拍平 / 无文本层的页码（1 起始）。 */
  suspect_pages?: number[];
  /** 无文本层页码（混合 PDF 中的扫描页，1 起始）。 */
  no_text_pages?: number[];
  /** 已被视觉模型抢救转写的页码。 */
  rescued_pages?: number[];
  /** 进 Review 队列的自定义原因（覆盖编排层默认文案）。 */
  review_reason?: string;
}

/** 公共元数据：来源文件、格式、pipeline 名、内容哈希、质量指标。 */
export interface BundleMeta {
  source_file: string;
  format: string;
  pipeline: string;
  sha256: string;
  quality: BundleQuality;
  /** PDF 页数。 */
  pages?: number;
  /** 文本文件嗅探出的编码。 */
  encoding?: string;
}

/** 统一输出：Markdown 正文 + 抽取的附件（绝对路径）+ 元数据。 */
export interface MarkdownBundle {
  markdown: string;
  assets: string[];
  meta: BundleMeta;
}

/** 格式 pipeline 接口。 */
export interface Pipeline {
  readonly name: string;
  /** 是否认领该文件。 */
  detect(file: string): Promise<boolean>;
  /** 转换为 MarkdownBundle；assetsDir 用于落盘抽取的图片等附件。 */
  convert(file: string, assetsDir: string): Promise<MarkdownBundle>;
}

/** 公共元数据构造（对应 Python Pipeline.base_meta）。 */
export async function baseMeta(file: string, format: string, pipelineName: string): Promise<BundleMeta> {
  return {
    source_file: basename(file),
    format,
    pipeline: pipelineName,
    sha256: await sha256Of(file),
    quality: {},
  };
}
