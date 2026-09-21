import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ReviewQueue } from "./review";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "supbot-review-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("ReviewQueue", () => {
  test("persists to <projectRoot>/.kbase/review.json", () => {
    const root = createTempDir();
    const queue = new ReviewQueue(root);
    expect(queue.filePath).toBe(join(root, ".kbase", "review.json"));
    queue.add("raw/sources/a.pdf", "pdf", "低置信度 OCR", 0.42);
    expect(existsSync(queue.filePath)).toBe(true);
    const items = JSON.parse(readFileSync(queue.filePath, "utf8"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 1,
      sourceFile: "raw/sources/a.pdf",
      format: "pdf",
      reason: "低置信度 OCR",
      confidence: 0.42,
      status: "unresolved",
    });
    expect(typeof items[0].createdAt).toBe("string");
  });

  test("adds items with auto-incremented ids and lists them in order", () => {
    const queue = new ReviewQueue(createTempDir());
    const first = queue.add("a.pdf", "pdf", "r1", 0.1);
    const second = queue.add("b.docx", "docx", "r2", 0.2);
    expect(second).toBe(first + 1);
    expect(queue.list().map((item) => item.id)).toEqual([first, second]);
  });

  test("filters by status and resolves only unresolved items", () => {
    const queue = new ReviewQueue(createTempDir());
    const first = queue.add("a.pdf", "pdf", "r1", 0.1);
    const second = queue.add("b.pdf", "pdf", "r2", 0.2);
    expect(queue.resolve(first)).toBe(true);
    expect(queue.resolve(first)).toBe(false);
    expect(queue.resolve(999)).toBe(false);
    expect(queue.list("unresolved").map((item) => item.id)).toEqual([second]);
    expect(queue.list("resolved").map((item) => item.id)).toEqual([first]);
    expect(queue.list()).toHaveLength(2);
  });

  test("removes items and reports whether anything was removed", () => {
    const queue = new ReviewQueue(createTempDir());
    const id = queue.add("a.pdf", "pdf", "r1", 0.1);
    expect(queue.remove(id)).toBe(true);
    expect(queue.remove(id)).toBe(false);
    expect(queue.list()).toEqual([]);
  });

  test("dedupes items with the same sourceFile and reason", () => {
    const queue = new ReviewQueue(createTempDir());
    const id = queue.add("a.pdf", "pdf", "r1", 0.1);
    // Same issue re-reported (e.g. lint re-run) returns the existing id.
    expect(queue.add("a.pdf", "pdf", "r1", 0.2)).toBe(id);
    expect(queue.list()).toHaveLength(1);
    // A resolved item also suppresses duplicates of the same issue.
    queue.resolve(id);
    expect(queue.add("a.pdf", "pdf", "r1", 0.3)).toBe(id);
    expect(queue.list()).toHaveLength(1);
    // A different reason or source file still creates a new item.
    expect(queue.add("a.pdf", "pdf", "r2", 0.3)).toBe(id + 1);
    expect(queue.add("b.pdf", "pdf", "r1", 0.3)).toBe(id + 2);
    expect(queue.list()).toHaveLength(3);
  });

  test("reloads state across instances", () => {
    const root = createTempDir();
    const first = new ReviewQueue(root);
    const id = first.add("a.pdf", "pdf", "r1", 0.1);
    first.resolve(id);
    first.add("b.pdf", "pdf", "r2", 0.3);

    const second = new ReviewQueue(root);
    expect(second.list().map((item) => [item.id, item.status])).toEqual([
      [id, "resolved"],
      [id + 1, "unresolved"],
    ]);
    // Ids keep incrementing after reload (no reuse of the max id).
    expect(second.add("c.pdf", "pdf", "r3", 0.5)).toBe(id + 2);
  });

  test("starts empty when the file is missing and throws on corrupt JSON", () => {
    const root = createTempDir();
    const queue = new ReviewQueue(root);
    expect(queue.list()).toEqual([]);
    queue.add("a.pdf", "pdf", "r1", 0.1);
    rmSync(queue.filePath);
    expect(queue.list()).toEqual([]);
    writeFileSync(queue.filePath, "{ not json", "utf8");
    expect(() => queue.list()).toThrow();
  });
});
