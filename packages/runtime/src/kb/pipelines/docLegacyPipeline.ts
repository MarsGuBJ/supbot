/**
 * doc-legacy-pipeline：旧 OLE 格式（.doc/.xls）。
 *
 * 【刻意偏离 Python 版】k-pipeline 走 LibreOffice 预转（soffice --headless
 * --convert-to docx|xlsx）后复用 docx/table pipeline；桌面端不假设用户机器
 * 装有 LibreOffice，因此本 pipeline 不做实际转换：产出带说明的空 bundle，
 * ocr_confidence=0 + review_reason，由编排层直接进 Review 队列人工处理。
 */

import { mkdirSync } from "node:fs";
import { baseMeta, type MarkdownBundle, type Pipeline } from "./base";
import { checkBundle } from "./quality";
import { FileFormat, identifyFormat } from "./router";

export class DocLegacyPipeline implements Pipeline {
  readonly name = "doc-legacy-pipeline";

  async detect(file: string): Promise<boolean> {
    const format = await identifyFormat(file);
    return format === FileFormat.DocLegacy || format === FileFormat.XlsLegacy;
  }

  async convert(file: string, assetsDir: string): Promise<MarkdownBundle> {
    mkdirSync(assetsDir, { recursive: true });
    const format = await identifyFormat(file);
    if (format !== FileFormat.DocLegacy && format !== FileFormat.XlsLegacy) {
      throw new Error(`doc-legacy-pipeline 只处理 .doc/.xls: ${file}`);
    }
    const meta = await baseMeta(file, format, this.name);
    meta.quality.ocr_confidence = 0;
    meta.quality.review_reason = `旧格式 ${format === FileFormat.DocLegacy ? ".doc" : ".xls"} 依赖 LibreOffice 预转，桌面端未集成 LibreOffice，未执行转换`;
    return checkBundle({ markdown: "", assets: [], meta });
  }
}
