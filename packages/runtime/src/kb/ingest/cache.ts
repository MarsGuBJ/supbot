/**
 * 增量摄入缓存：source sha256 → { 源路径, 受影响 wiki 页列表 }。
 * 端口自 k-pipeline app/ingest/cache.py，SQLite 换成原子写入的 JSON 文件
 * （<projectRoot>/.kbase/ingest-cache.json，与 ReviewQueue 同一持久化风格）。
 *
 * sha256 未变且已摄入的文档直接跳过；删除源时反查受影响 wiki 页做级联删除。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface IngestCacheRecord {
  sha256: string;
  /** 摄入时的源文件引用（posix 路径串）。 */
  sourcePath: string;
  /** 该源摄入出的 wiki 页 rel 路径。 */
  pages: string[];
  updatedAt: string;
}

export class IngestCache {
  readonly filePath: string;

  constructor(projectRoot: string) {
    this.filePath = join(projectRoot, ".kbase", "ingest-cache.json");
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  /** 该内容哈希是否已摄入完成（可跳过整个 ingest）。 */
  shouldSkip(sha256: string): boolean {
    return this.load().some((record) => record.sha256 === sha256);
  }

  /** 写入/更新一条摄入记录。 */
  record(sha256: string, pages: string[], sourcePath = ""): void {
    const records = this.load().filter((entry) => entry.sha256 !== sha256);
    records.push({ sha256, sourcePath, pages, updatedAt: new Date().toISOString() });
    this.save(records);
  }

  /** 反查：该哈希的源影响了哪些 wiki 页（rel 路径列表）。 */
  affectedPages(sha256: string): string[] {
    return this.load().find((record) => record.sha256 === sha256)?.pages ?? [];
  }

  /** 删除该哈希的缓存记录，返回被删记录（无记录时返回 undefined）。 */
  remove(sha256: string): IngestCacheRecord | undefined {
    const records = this.load();
    const target = records.find((record) => record.sha256 === sha256);
    if (!target) {
      return undefined;
    }
    this.save(records.filter((record) => record.sha256 !== sha256));
    return target;
  }

  /** 按源路径反查记录（删除级联用；匹配最新一条）。 */
  findBySource(sourcePath: string): IngestCacheRecord | undefined {
    const records = this.load().filter((record) => record.sourcePath === sourcePath);
    return records.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
  }

  /** 列出全部缓存记录（按更新时间升序）。 */
  listAll(): IngestCacheRecord[] {
    return this.load().sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
  }

  private load(): IngestCacheRecord[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error(`Invalid ingest cache file: ${this.filePath}`);
    }
    return raw as IngestCacheRecord[];
  }

  private save(records: IngestCacheRecord[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
    renameSync(tempPath, this.filePath);
  }
}
