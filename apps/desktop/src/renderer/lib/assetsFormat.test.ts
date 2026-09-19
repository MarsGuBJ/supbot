import { describe, expect, test } from "vitest";
import type { GraphEdge, GraphNode, KbDocumentWithProgress } from "@supbot/shared";
import {
  docStem,
  formatKbBytes,
  kbDocStatus,
  kbDocStatusColor,
  kbHitTarget,
  layoutGraph,
  splitCitationRefs,
} from "./assetsFormat";

const doc = (fileName: string, overrides: Partial<KbDocumentWithProgress> = {}): KbDocumentWithProgress => ({
  id: `raw/sources/${fileName}`,
  projectId: "demo",
  fileName,
  relPath: `raw/sources/${fileName}`,
  format: "pdf",
  sizeBytes: 100,
  createdAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

describe("docStem", () => {
  test("strips the last extension", () => {
    expect(docStem("采购白皮书.pdf")).toBe("采购白皮书");
    expect(docStem("archive.tar.gz")).toBe("archive.tar");
    expect(docStem("README")).toBe("README");
    expect(docStem(".gitignore")).toBe(".gitignore");
  });
});

describe("formatKbBytes", () => {
  test("formats common sizes", () => {
    expect(formatKbBytes(0)).toBe("0 B");
    expect(formatKbBytes(512)).toBe("512 B");
    expect(formatKbBytes(2048)).toBe("2.0 KB");
    expect(formatKbBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatKbBytes(150 * 1024 * 1024)).toBe("150 MB");
  });

  test("handles invalid input", () => {
    expect(formatKbBytes(Number.NaN)).toBe("0 B");
    expect(formatKbBytes(-3)).toBe("0 B");
  });
});

describe("kbDocStatus", () => {
  test("reports none when no task exists", () => {
    expect(kbDocStatus(doc("a.pdf"))).toEqual({ status: "none", progress: 0 });
  });

  test("passes through task state", () => {
    const view = kbDocStatus(
      doc("a.pdf", {
        task: {
          id: "t1",
          projectId: "demo",
          status: "ingesting",
          progress: 0.4,
          attempts: 1,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      }),
    );
    expect(view.status).toBe("ingesting");
    expect(view.progress).toBe(0.4);
  });
});

describe("kbDocStatusColor", () => {
  test("maps statuses to tag colors", () => {
    expect(kbDocStatusColor("done")).toBe("success");
    expect(kbDocStatusColor("failed")).toBe("error");
    expect(kbDocStatusColor("parsing")).toBe("processing");
    expect(kbDocStatusColor("pending")).toBe("warning");
    expect(kbDocStatusColor("none")).toBe("default");
  });
});

describe("kbHitTarget", () => {
  test("parses wiki hit paths", () => {
    expect(kbHitTarget("wiki/entities/供应商.md")).toEqual({ kind: "wiki", rel: "entities/供应商.md" });
  });

  test("parses markdown hit paths and strips .md", () => {
    expect(kbHitTarget("raw/markdown/采购白皮书.md")).toEqual({ kind: "markdown", rel: "采购白皮书" });
    expect(kbHitTarget("raw/markdown/nested/dir/page")).toEqual({ kind: "markdown", rel: "nested/dir/page" });
  });

  test("rejects unknown or empty paths", () => {
    expect(kbHitTarget("raw/sources/a.pdf")).toBeNull();
    expect(kbHitTarget("wiki/")).toBeNull();
    expect(kbHitTarget("")).toBeNull();
  });
});

describe("splitCitationRefs", () => {
  test("splits answer text around [n] markers", () => {
    expect(splitCitationRefs("供应商系统 [1] 支持采购 [2]。")).toEqual([
      { type: "text", text: "供应商系统 " },
      { type: "ref", ref: 1 },
      { type: "text", text: " 支持采购 " },
      { type: "ref", ref: 2 },
      { type: "text", text: "。" },
    ]);
  });

  test("returns a single text segment without markers", () => {
    expect(splitCitationRefs("没有引用")).toEqual([{ type: "text", text: "没有引用" }]);
  });

  test("ignores non-numeric brackets", () => {
    expect(splitCitationRefs("[abc] 不是引用")).toEqual([{ type: "text", text: "[abc] 不是引用" }]);
  });
});

describe("layoutGraph", () => {
  const node = (name: string): GraphNode => ({ name, type: "实体" });

  test("layers nodes by longest path from roots", () => {
    const nodes = [node("a"), node("b"), node("c"), node("d")];
    const edges: GraphEdge[] = [
      { source: "a", target: "b", relation: "r" },
      { source: "b", target: "c", relation: "r" },
      { source: "a", target: "c", relation: "r" },
    ];
    const layout = layoutGraph(nodes, edges);
    const layers = Object.fromEntries(layout.nodes.map((n) => [n.node.name, n.layer]));
    expect(layers).toEqual({ a: 0, b: 1, c: 2, d: 0 });
    expect(layout.edges).toHaveLength(3);
    const ab = layout.edges.find((e) => e.edge.source === "a" && e.edge.target === "b")!;
    const a = layout.nodes.find((n) => n.node.name === "a")!;
    const b = layout.nodes.find((n) => n.node.name === "b")!;
    expect([ab.x1, ab.y1]).toEqual([a.x, a.y]);
    expect([ab.x2, ab.y2]).toEqual([b.x, b.y]);
  });

  test("appends cyclic nodes after BFS layers", () => {
    const nodes = [node("x"), node("y")];
    const edges: GraphEdge[] = [
      { source: "x", target: "y", relation: "r" },
      { source: "y", target: "x", relation: "r" },
    ];
    const layout = layoutGraph(nodes, edges);
    expect(layout.nodes).toHaveLength(2);
    expect(new Set(layout.nodes.map((n) => `${n.x}:${n.y}`)).size).toBe(2);
  });

  test("ignores edges referencing unknown nodes", () => {
    const layout = layoutGraph([node("a")], [{ source: "a", target: "ghost", relation: "r" }]);
    expect(layout.edges).toHaveLength(0);
    expect(layout.nodes).toHaveLength(1);
  });

  test("returns an empty layout for no nodes", () => {
    expect(layoutGraph([], [])).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });
});
