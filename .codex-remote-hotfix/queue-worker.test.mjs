import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { contentTypeFromName, isDeliverableFile } from "./queue-worker.mjs";

describe("isDeliverableFile", () => {
  test("collects HTML, HTM, and TSV outputs into generated-file manifests", () => {
    assert.equal(isDeliverableFile("report.html"), true);
    assert.equal(isDeliverableFile("report.htm"), true);
    assert.equal(isDeliverableFile("data/result.tsv"), true);
    assert.equal(isDeliverableFile("REPORT.HTML"), true);
  });

  test("keeps existing deliverable extensions", () => {
    for (const path of ["notes.txt", "task-output.md", "data.csv", "slides.pptx", "book.xlsx", "doc.pdf"]) {
      assert.equal(isDeliverableFile(path), true, path);
    }
  });

  test("still rejects hidden, scratch, and unsupported files", () => {
    for (const path of [
      ".hidden/output.html",
      "tmp/report.html",
      "scripts/build.sh",
      "cache/page.htm",
      "image.png",
      "archive.zip",
    ]) {
      assert.equal(isDeliverableFile(path), false, path);
    }
  });
});

describe("contentTypeFromName", () => {
  test("maps html/htm/tsv to browser-friendly content types", () => {
    assert.equal(contentTypeFromName("report.html"), "text/html; charset=utf-8");
    assert.equal(contentTypeFromName("report.htm"), "text/html; charset=utf-8");
    assert.equal(contentTypeFromName("result.tsv"), "text/tab-separated-values; charset=utf-8");
  });
});
