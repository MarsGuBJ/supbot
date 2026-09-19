import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { htmlToMarkdown, TextPipeline } from "./textPipeline";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-text-"));
});

function fixture(name: string, data: Buffer | string): string {
  const path = join(dir, name);
  writeFileSync(path, data);
  return path;
}

describe("htmlToMarkdown", () => {
  it("标题 / 列表 / 段落 / 表格单元格", () => {
    const md = htmlToMarkdown(
      "<h1>大标题</h1><p>第一段</p><ul><li>甲</li><li>乙</li></ul><table><tr><td>a</td><td>b</td></tr></table>",
    );
    expect(md).toContain("# 大标题");
    expect(md).toContain("第一段");
    expect(md).toContain("- 甲");
    expect(md).toContain("- 乙");
    expect(md).toMatch(/\|\s*a\s+\|\s*b/);
  });

  it("script/style/head 内容丢弃", () => {
    const md = htmlToMarkdown("<head><title>T</title></head><p>正文</p><script>var x=1;</script><style>.a{}</style>");
    expect(md).toContain("正文");
    expect(md).not.toContain("var x");
    expect(md).not.toContain(".a{");
  });

  it("实体解码与空行折叠", () => {
    const md = htmlToMarkdown("<p>a &amp; b</p><div><br></div><p>c</p>");
    expect(md).toContain("a & b");
    expect(md).not.toMatch(/\n{3,}/);
  });
});

describe("TextPipeline.convert", () => {
  it("txt 原样保留并归一化 CRLF", async () => {
    const file = fixture("note.txt", "line1\r\nline2\rline3\n");
    const bundle = await new TextPipeline().convert(file, join(dir, "assets-txt"));
    expect(bundle.markdown).toBe("line1\nline2\nline3\n");
    expect(bundle.meta.format).toBe("txt");
    expect(bundle.meta.pipeline).toBe("text-pipeline");
    expect(bundle.meta.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("md 原样保留", async () => {
    const file = fixture("doc.md", "# 标题\n\n正文 [[链接]]\n");
    const bundle = await new TextPipeline().convert(file, join(dir, "assets-md"));
    expect(bundle.markdown).toContain("# 标题");
    expect(bundle.meta.format).toBe("md");
  });

  it("html 抽取为 markdown", async () => {
    const file = fixture("page.html", "<html><body><h2>小节</h2><p>内容</p></body></html>");
    const bundle = await new TextPipeline().convert(file, join(dir, "assets-html"));
    expect(bundle.markdown).toContain("## 小节");
    expect(bundle.markdown).toContain("内容");
    expect(bundle.meta.format).toBe("html");
  });

  it("UTF-16LE BOM 文件正确解码", async () => {
    const raw = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("中文内容 UTF-16", "utf16le")]);
    const file = fixture("utf16.txt", raw);
    const bundle = await new TextPipeline().convert(file, join(dir, "assets-u16"));
    expect(bundle.markdown).toContain("中文内容 UTF-16");
    expect(bundle.meta.encoding).toBe("utf-16le");
  });

  it("不支持的格式抛错", async () => {
    const file = fixture("bin.dat", Buffer.from([0x00, 0x01, 0x00]));
    await expect(new TextPipeline().convert(file, join(dir, "assets-x"))).rejects.toThrow("text-pipeline 不支持格式");
  });
});
