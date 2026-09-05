import { describe, expect, it } from "vitest";
import { buildFilePreviewResult, classifyFilePath } from "./filePreview";

describe("main file preview metadata", () => {
  it("classifies supported preview families", () => {
    expect(classifyFilePath("report.docx")).toBe("office");
    expect(classifyFilePath("table.xlsx")).toBe("office");
    expect(classifyFilePath("deck.pptx")).toBe("office");
    expect(classifyFilePath("page.html")).toBe("html");
    expect(classifyFilePath("document.pdf")).toBe("pdf");
    expect(classifyFilePath("photo.jpg")).toBe("image");
    expect(classifyFilePath("data.json")).toBe("json");
    expect(classifyFilePath("notes.txt")).toBe("text");
  });

  it("does not include content for large files", () => {
    const result = buildFilePreviewResult("large.txt", 20 * 1024 * 1024 + 1, new TextEncoder().encode("text"));
    expect(result.tooLarge).toBe(true);
    expect(result.previewable).toBe(false);
    expect(result.contentBase64).toBeUndefined();
  });
});
