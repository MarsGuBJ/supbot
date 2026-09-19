/**
 * image-pipeline：视觉 LLM 直接生成描述性 Markdown。
 * 端口自 k-pipeline app/pipelines/image_pipeline.py（prompt 原样移植）。
 *
 * 输出约定（由 prompt 约束）：事实性 caption（一级标题 + 首段）、图中文字 OCR 转录、
 * 图中表格重建为 GFM；模型自评置信度以 <!-- confidence: 0.xx --> 结尾，写入
 * meta.quality.ocr_confidence（无自评标记时记 0，低置信度由编排层进 Review 队列）。
 * 视觉模型未配置/调用失败时：低置信度空结果进 Review（偏离 Python 版的抛错）。
 */

import { mkdirSync, readFileSync } from "node:fs";
import { baseMeta, type MarkdownBundle, type Pipeline } from "./base";
import { checkBundle } from "./quality";
import { FileFormat, identifyFormat } from "./router";
import { parseLlmConfidence, visionComplete, type VisionLlm } from "./vision";

/** 端口 Python image_pipeline._PROMPT（原文）。 */
export const IMAGE_PROMPT = `请把这张图片转录为 Markdown，要求：
1. 一级标题：给图片起一个事实性标题；
2. 首段：事实性 caption（客观描述图片内容，不臆测）；
3. "## 图中文字"：逐行转录图中所有文字（OCR），无文字则写"无"；
4. "## 图中表格"：图中表格重建为 GFM Markdown 表格，无表格则写"无"；
只输出 Markdown，不要额外解释；末尾输出 <!-- confidence: 0.xx --> 表示转录质量自评。`;

const MIME_BY_HEAD: Array<[number[], string]> = [
  [[0x89, 0x50, 0x4e, 0x47], "image/png"],
  [[0xff, 0xd8, 0xff], "image/jpeg"],
  [[0x47, 0x49, 0x46, 0x38], "image/gif"],
];

function mimeOf(raw: Buffer): string {
  for (const [signature, mime] of MIME_BY_HEAD) {
    if (signature.every((byte, index) => raw[index] === byte)) {
      return mime;
    }
  }
  if (
    raw.length >= 12 &&
    raw.subarray(0, 4).toString("ascii") === "RIFF" &&
    raw.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return "image/png";
}

export class ImagePipeline implements Pipeline {
  readonly name = "image-pipeline";

  constructor(private readonly vision: VisionLlm | null = null) {}

  async detect(file: string): Promise<boolean> {
    return (await identifyFormat(file)) === FileFormat.Image;
  }

  async convert(file: string, assetsDir: string): Promise<MarkdownBundle> {
    mkdirSync(assetsDir, { recursive: true });
    if (!(await this.detect(file))) {
      throw new Error(`image-pipeline 只处理图片文件: ${file}`);
    }

    const meta = await baseMeta(file, "image", this.name);
    if (!this.vision) {
      // 偏离 Python 版（抛 RuntimeError）：按任务约定降级为低置信度进 Review
      meta.quality.ocr_confidence = 0;
      meta.quality.review_reason = "视觉模型未配置，图片无法转写";
      return checkBundle({ markdown: "", assets: [], meta });
    }

    const raw = readFileSync(file);
    let markdown = "";
    let confidence: number | null = null;
    try {
      const output = await visionComplete(
        this.vision,
        { base64: raw.toString("base64"), mime: mimeOf(raw) },
        IMAGE_PROMPT,
      );
      [markdown, confidence] = parseLlmConfidence(output);
    } catch (error) {
      // 模型不支持图像 / 调用失败：低置信度进 Review
      meta.quality.review_reason = `视觉模型调用失败: ${error instanceof Error ? error.message : String(error)}`;
    }
    meta.quality.ocr_confidence = confidence ?? 0;
    return checkBundle({ markdown: markdown ? `${markdown}\n` : "", assets: [], meta });
  }
}
