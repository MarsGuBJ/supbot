import { describe, expect, it } from "vitest";
import { fileTypeForName } from "./fileType";

describe("fileTypeForName", () => {
  it("maps common result formats to their file icon family", () => {
    expect(fileTypeForName("report.docx")).toBe("word");
    expect(fileTypeForName("budget.xlsx")).toBe("excel");
    expect(fileTypeForName("briefing.pptx")).toBe("powerpoint");
    expect(fileTypeForName("manual.pdf")).toBe("pdf");
    expect(fileTypeForName("preview.png")).toBe("image");
    expect(fileTypeForName("payload.json")).toBe("json");
    expect(fileTypeForName("notes.txt")).toBe("text");
    expect(fileTypeForName("bundle.zip")).toBe("archive");
    expect(fileTypeForName("bundle.bin")).toBe("unknown");
  });

  it("uses the MIME type when the filename has no useful extension", () => {
    expect(fileTypeForName("download", "application/pdf")).toBe("pdf");
    expect(fileTypeForName("download", "image/png")).toBe("image");
    expect(fileTypeForName("download", "application/vnd.ms-excel")).toBe("excel");
  });
});
