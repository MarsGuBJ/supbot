import { describe, expect, it } from "vitest";
import type { LocalFileReference } from "@supbot/shared";
import { classifyFile, formatJsonPreview, resolveLocalFileHref } from "./filePreview";

const knownFiles: LocalFileReference[] = [
  { path: "C:\\work\\report.docx", name: "report.docx" },
  { path: "C:\\work\\data.json", name: "data.json" },
];

describe("file preview helpers", () => {
  it("classifies supported file families", () => {
    expect(classifyFile("report.docx")).toBe("office");
    expect(classifyFile("table.xlsx")).toBe("office");
    expect(classifyFile("deck.pptx")).toBe("office");
    expect(classifyFile("page.html")).toBe("html");
    expect(classifyFile("document.pdf")).toBe("pdf");
    expect(classifyFile("photo.png")).toBe("image");
    expect(classifyFile("data.json")).toBe("json");
    expect(classifyFile("notes.txt")).toBe("text");
    expect(classifyFile("archive.zip")).toBe("binary");
  });

  it("formats valid JSON and preserves invalid JSON", () => {
    expect(formatJsonPreview('{"name":"HyBot","items":[1,2]}')).toEqual({
      text: '{\n  "name": "HyBot",\n  "items": [\n    1,\n    2\n  ]\n}',
      valid: true,
    });
    expect(formatJsonPreview("{broken")).toEqual({ text: "{broken", valid: false });
  });

  it("resolves only known relative links or absolute local paths", () => {
    expect(resolveLocalFileHref("data.json", knownFiles)?.path).toBe("C:\\work\\data.json");
    expect(resolveLocalFileHref("file:///C:/work/report.docx", knownFiles)?.name).toBe("report.docx");
    expect(resolveLocalFileHref("https://example.com/report.docx", knownFiles)).toBeNull();
    expect(resolveLocalFileHref("../secrets.txt", knownFiles)).toBeNull();
    expect(resolveLocalFileHref("C:\\work\\other.txt", knownFiles)?.name).toBe("other.txt");
  });
});
