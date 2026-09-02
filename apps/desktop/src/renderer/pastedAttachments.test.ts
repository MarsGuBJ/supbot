import { describe, expect, it } from "vitest";
import { filesFromPasteEvent, pastedFileName, renamePastedFiles } from "./lib/pastedAttachments";

const now = new Date(2026, 8, 2, 9, 30, 5);

describe("pastedFileName", () => {
  it("replaces generic screenshot names with a timestamped name from the MIME type", () => {
    expect(pastedFileName({ name: "image.png", type: "image/png" }, now)).toBe("pasted-20260902-093005.png");
    expect(pastedFileName({ name: "image.jpeg", type: "image/jpeg" }, now)).toBe("pasted-20260902-093005.jpg");
  });

  it("names unnamed blobs from the MIME type", () => {
    expect(pastedFileName({ name: "", type: "application/pdf" }, now)).toBe("pasted-20260902-093005.pdf");
  });

  it("falls back to .bin for unknown MIME types", () => {
    expect(pastedFileName({ name: "", type: "application/octet-stream" }, now)).toBe("pasted-20260902-093005.bin");
  });

  it("keeps real file names as-is", () => {
    expect(pastedFileName({ name: "报表.xlsx", type: "image/png" }, now)).toBe("报表.xlsx");
  });
});

describe("filesFromPasteEvent", () => {
  it("returns files from clipboardData", () => {
    const file = new File(["x"], "image.png", { type: "image/png" });
    expect(filesFromPasteEvent({ clipboardData: { files: [file] } as unknown as DataTransfer })).toEqual([file]);
  });

  it("returns an empty list for text-only pastes", () => {
    expect(filesFromPasteEvent({ clipboardData: { files: [] } as unknown as DataTransfer })).toEqual([]);
    expect(filesFromPasteEvent({ clipboardData: null })).toEqual([]);
  });
});

describe("renamePastedFiles", () => {
  it("renames generic files and keeps their bytes and type", async () => {
    const file = new File(["pixels"], "image.png", { type: "image/png" });
    const [renamed] = renamePastedFiles([file], now);
    expect(renamed.name).toBe("pasted-20260902-093005.png");
    expect(renamed.type).toBe("image/png");
    expect(await renamed.text()).toBe("pixels");
  });

  it("keeps already-named files untouched", () => {
    const file = new File(["x"], "notes.txt", { type: "text/plain" });
    expect(renamePastedFiles([file], now)[0]).toBe(file);
  });
});
