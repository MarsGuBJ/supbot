import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ImagePipeline } from "./imagePipeline";
import { fakeVision, PNG_1PX } from "./testFixtures";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-image-"));
});

function fixture(name: string, data: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
}

describe("ImagePipeline", () => {
  it("视觉模型转录：剥离 confidence 标记写入 meta", async () => {
    const file = fixture("photo.png", PNG_1PX);
    const { vision, adapter } = fakeVision("# 图片标题\n\ncaption 段落\n\n## 图中文字\n无 <!-- confidence: 0.88 -->");
    const bundle = await new ImagePipeline(vision).convert(file, join(dir, "assets-i"));
    expect(bundle.meta.format).toBe("image");
    expect(bundle.markdown).toContain("# 图片标题");
    expect(bundle.markdown).not.toContain("confidence:");
    expect(bundle.meta.quality.ocr_confidence).toBe(0.88);
    // prompt 为 Python 版原文移植（四段要求）
    const content = adapter.requests[0]!.messages[0]!.content as unknown as Array<{ type: string; text?: string }>;
    expect(content[0]!.text).toContain("请把这张图片转录为 Markdown");
  });

  it("无自评标记时置信度记 0", async () => {
    const file = fixture("photo2.png", PNG_1PX);
    const { vision } = fakeVision("# 无标记输出");
    const bundle = await new ImagePipeline(vision).convert(file, join(dir, "assets-i2"));
    expect(bundle.meta.quality.ocr_confidence).toBe(0);
  });

  it("视觉模型未配置：低置信度进 Review", async () => {
    const file = fixture("photo3.png", PNG_1PX);
    const bundle = await new ImagePipeline(null).convert(file, join(dir, "assets-i3"));
    expect(bundle.meta.quality.ocr_confidence).toBe(0);
    expect(bundle.meta.quality.review_reason).toContain("视觉模型未配置");
  });

  it("视觉调用失败：低置信度 + 原因", async () => {
    const file = fixture("photo4.png", PNG_1PX);
    const { vision } = fakeVision(() => {
      throw new Error("unsupported image content");
    });
    const bundle = await new ImagePipeline(vision).convert(file, join(dir, "assets-i4"));
    expect(bundle.meta.quality.ocr_confidence).toBe(0);
    expect(bundle.meta.quality.review_reason).toContain("视觉模型调用失败");
  });
});
