import type { GraphEdge, GraphNode, KbDocumentWithProgress, KbIngestTaskStatus } from "@supbot/shared";

/** Strip the last extension from an uploaded file name to get the raw/markdown doc stem. */
export function docStem(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index > 0 ? fileName.slice(0, index) : fileName;
}

/** Human-readable byte size for the document list. */
export function formatKbBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) {
      break;
    }
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

export type KbDocStatus = KbIngestTaskStatus | "none";

/** Display state of a source document merged with its latest ingest task. */
export function kbDocStatus(doc: KbDocumentWithProgress): { status: KbDocStatus; progress: number; error?: string } {
  if (!doc.task) {
    return { status: "none", progress: 0 };
  }
  return { status: doc.task.status, progress: doc.task.progress, error: doc.task.error };
}

/** antd Tag color for a document ingest status. */
export function kbDocStatusColor(status: KbDocStatus): string {
  switch (status) {
    case "done":
      return "success";
    case "failed":
      return "error";
    case "parsing":
    case "ingesting":
      return "processing";
    case "pending":
      return "warning";
    default:
      return "default";
  }
}

export type KbHitTarget = { kind: "wiki" | "markdown"; rel: string };

/**
 * Parse a search/chat hit path into a loadable target.
 * Hit paths look like `wiki/<rel>` for wiki pages and `raw/markdown/<name>` for markdown artifacts.
 */
export function kbHitTarget(page: string): KbHitTarget | null {
  const trimmed = (page || "").trim();
  if (trimmed.startsWith("wiki/")) {
    const rel = trimmed.slice("wiki/".length);
    return rel ? { kind: "wiki", rel } : null;
  }
  if (trimmed.startsWith("raw/markdown/")) {
    const rel = trimmed.slice("raw/markdown/".length);
    return rel ? { kind: "markdown", rel: rel.replace(/\.md$/i, "") } : null;
  }
  return null;
}

export type AnswerSegment = { type: "text"; text: string } | { type: "ref"; ref: number };

/** Split a chat answer into plain-text and `[n]` citation-reference segments. */
export function splitCitationRefs(answer: string): AnswerSegment[] {
  const segments: AnswerSegment[] = [];
  const pattern = /\[(\d+)\]/g;
  let last = 0;
  for (const match of answer.matchAll(pattern)) {
    const index = match.index;
    if (index > last) {
      segments.push({ type: "text", text: answer.slice(last, index) });
    }
    segments.push({ type: "ref", ref: Number(match[1]) });
    last = index + match[0].length;
  }
  if (last < answer.length) {
    segments.push({ type: "text", text: answer.slice(last) });
  }
  return segments;
}

export interface GraphLayoutNode {
  node: GraphNode;
  layer: number;
  x: number;
  y: number;
}

export interface GraphLayoutEdge {
  edge: GraphEdge;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GraphLayout {
  nodes: GraphLayoutNode[];
  edges: GraphLayoutEdge[];
  width: number;
  height: number;
}

const LAYER_WIDTH = 220;
const ROW_HEIGHT = 90;
const PADDING = 60;

/**
 * Layered (longest-path from roots) static layout for rendering an extraction
 * as a plain SVG without a graph library. Cycle-safe: unvisited nodes are
 * appended after the BFS layers.
 */
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): GraphLayout {
  if (!nodes.length) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }
  const names = nodes.map((node) => node.name);
  const known = new Set(names);
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>(names.map((name) => [name, 0]));
  for (const edge of edges) {
    if (!known.has(edge.source) || !known.has(edge.target)) {
      continue;
    }
    outgoing.set(edge.source, [...(outgoing.get(edge.source) || []), edge.target]);
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
  }

  const layer = new Map<string, number>();
  const queue = names.filter((name) => (indegree.get(name) || 0) === 0);
  for (const root of queue) {
    layer.set(root, 0);
  }
  // Longest-path layering via repeated relaxation (bounded by node count).
  const visited = new Set(queue);
  let frontier = [...queue];
  while (frontier.length) {
    const next: string[] = [];
    for (const name of frontier) {
      for (const target of outgoing.get(name) || []) {
        const candidate = (layer.get(name) || 0) + 1;
        if ((layer.get(target) ?? -1) < candidate) {
          layer.set(target, candidate);
        }
        if (!visited.has(target)) {
          visited.add(target);
          next.push(target);
        }
      }
    }
    frontier = next;
  }
  // Nodes locked in cycles get appended one layer past the deepest known layer.
  let maxLayer = Math.max(0, ...layer.values());
  for (const name of names) {
    if (!layer.has(name)) {
      maxLayer += 1;
      layer.set(name, maxLayer);
    }
  }

  const rowsPerLayer = new Map<number, number>();
  const positioned = new Map<string, GraphLayoutNode>();
  const layoutNodes: GraphLayoutNode[] = nodes.map((node) => {
    const nodeLayer = layer.get(node.name) || 0;
    const row = rowsPerLayer.get(nodeLayer) || 0;
    rowsPerLayer.set(nodeLayer, row + 1);
    const positionedNode: GraphLayoutNode = {
      node,
      layer: nodeLayer,
      x: PADDING + nodeLayer * LAYER_WIDTH,
      y: PADDING + row * ROW_HEIGHT,
    };
    positioned.set(node.name, positionedNode);
    return positionedNode;
  });

  const layoutEdges: GraphLayoutEdge[] = [];
  for (const edge of edges) {
    const source = positioned.get(edge.source);
    const target = positioned.get(edge.target);
    if (!source || !target) {
      continue;
    }
    layoutEdges.push({ edge, x1: source.x, y1: source.y, x2: target.x, y2: target.y });
  }

  const layerCount = Math.max(0, ...rowsPerLayer.keys()) + 1;
  const maxRows = Math.max(1, ...rowsPerLayer.values());
  return {
    nodes: layoutNodes,
    edges: layoutEdges,
    width: PADDING * 2 + (layerCount - 1) * LAYER_WIDTH,
    height: PADDING * 2 + (maxRows - 1) * ROW_HEIGHT,
  };
}
