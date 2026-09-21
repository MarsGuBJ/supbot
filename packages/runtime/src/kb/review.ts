/**
 * Human review queue: low-confidence conversion results persisted as JSON at
 * <projectRoot>/.kbase/review.json. Ported from k-pipeline's
 * app/storage/review.py, with SQLite replaced by an atomically-written JSON
 * array file (temp file + rename).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KbReviewItem, KbReviewStatus } from "@supbot/shared";

export class ReviewQueue {
  readonly filePath: string;

  constructor(projectRoot: string) {
    this.filePath = join(projectRoot, ".kbase", "review.json");
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  /**
   * Add a review item; returns its auto-incremented id. If an item with the
   * same sourceFile + reason already exists (in any status), returns the
   * existing id instead of creating a duplicate — lint re-runs and repeated
   * low-confidence conversions must not re-flood the queue.
   */
  add(sourceFile: string, format: string, reason: string, confidence: number): number {
    const items = this.load();
    const existing = items.find((item) => item.sourceFile === sourceFile && item.reason === reason);
    if (existing) {
      return existing.id;
    }
    const id = items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
    items.push({
      id,
      sourceFile,
      format,
      reason,
      confidence,
      status: "unresolved",
      createdAt: new Date().toISOString(),
    });
    this.save(items);
    return id;
  }

  /** List items ordered by id, optionally filtered by status. */
  list(status?: KbReviewStatus): KbReviewItem[] {
    const items = this.load();
    return status ? items.filter((item) => item.status === status) : items;
  }

  /** Mark an item as resolved; returns whether an unresolved item was updated. */
  resolve(itemId: number): boolean {
    const items = this.load();
    const item = items.find((entry) => entry.id === itemId && entry.status === "unresolved");
    if (!item) {
      return false;
    }
    item.status = "resolved";
    this.save(items);
    return true;
  }

  /** Remove an item entirely; returns whether an item was removed. */
  remove(itemId: number): boolean {
    const items = this.load();
    const next = items.filter((entry) => entry.id !== itemId);
    if (next.length === items.length) {
      return false;
    }
    this.save(next);
    return true;
  }

  private load(): KbReviewItem[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error(`Invalid review queue file: ${this.filePath}`);
    }
    return raw as KbReviewItem[];
  }

  private save(items: KbReviewItem[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
    renameSync(tempPath, this.filePath);
  }
}
