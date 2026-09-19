import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { IngestCache } from "./cache";

const tempDirs: string[] = [];

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "supbot-ingestcache-test-"));
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("IngestCache", () => {
  test("sha 未变跳过：record 后 shouldSkip 为真", () => {
    const cache = new IngestCache(createRoot());
    expect(cache.shouldSkip("sha-a")).toBe(false);
    cache.record("sha-a", ["sources/文档.md"], "raw/sources/文档.txt");
    expect(cache.shouldSkip("sha-a")).toBe(true);
    expect(cache.shouldSkip("sha-b")).toBe(false);
  });

  test("变更重摄入：同 sha 重复 record 覆盖旧 pages", () => {
    const cache = new IngestCache(createRoot());
    cache.record("sha-a", ["sources/旧.md"], "raw/sources/文档.txt");
    cache.record("sha-a", ["sources/新.md", "concepts/概念.md"], "raw/sources/文档.txt");
    expect(cache.affectedPages("sha-a")).toEqual(["sources/新.md", "concepts/概念.md"]);
    expect(cache.listAll()).toHaveLength(1);
  });

  test("删除反查：remove 返回受影响页并清除记录", () => {
    const cache = new IngestCache(createRoot());
    cache.record("sha-a", ["sources/文档.md"], "raw/sources/文档.txt");
    expect(cache.remove("sha-a")?.pages).toEqual(["sources/文档.md"]);
    expect(cache.shouldSkip("sha-a")).toBe(false);
    expect(cache.remove("sha-a")).toBeUndefined();
  });

  test("findBySource 按源路径反查，持久化跨实例可见", () => {
    const root = createRoot();
    const cache = new IngestCache(root);
    cache.record("sha-a", ["sources/甲.md"], "raw/sources/甲.txt");
    cache.record("sha-b", ["sources/乙.md"], "raw/sources/乙.txt");

    const reopened = new IngestCache(root);
    expect(reopened.findBySource("raw/sources/乙.txt")?.sha256).toBe("sha-b");
    expect(reopened.findBySource("raw/sources/丙.txt")).toBeUndefined();
    expect(
      reopened
        .listAll()
        .map((record) => record.sha256)
        .sort(),
    ).toEqual(["sha-a", "sha-b"]);
  });
});
