import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FullscreenOutlined, ReloadOutlined } from "@ant-design/icons";
import { Button, Empty, Input, Spin, Switch, Tag } from "antd";
import type { MessageInstance } from "antd/es/message/interface";
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-2d";
import type { KbWikiGraph, KbWikiGraphNode } from "@supbot/shared";
import type { Translator } from "../../lib/types";

type GNode = NodeObject & KbWikiGraphNode;
type GLink = LinkObject & { source: string | GNode; target: string | GNode };

/** Stable color per wiki page type (logseq-style type legend). */
const TYPE_COLORS: Record<string, string> = {
  entity: "#4f7cff",
  concept: "#13c2c2",
  source: "#fa8c16",
  query: "#722ed1",
  synthesis: "#eb2f96",
  graph: "#52c41a",
};
const FALLBACK_COLOR = "#8e94a0";
const EDGE_COLOR = "rgba(90, 96, 112, 0.35)";
const EDGE_HIGHLIGHT = "#3b82f6";
const LABEL_MIN_SCALE = 1.1;
/** Nodes with degree >= this always show a label, even when zoomed out. */
const HUB_DEGREE = 4;

function typeColor(type: string): string {
  return TYPE_COLORS[type] || FALLBACK_COLOR;
}

function nodeRadius(node: KbWikiGraphNode): number {
  return 4 + Math.min(node.degree, 12) * 0.8;
}

function linkNodeId(end: string | GNode): string {
  return typeof end === "string" ? end : end.id;
}

/** Logseq-style whole-wiki link graph: force-directed canvas over [[wikilink]] edges. */
export function WikiGraphPanel({
  project,
  onOpenPage,
  t,
  messageApi,
}: {
  project: string;
  /** When omitted (standalone window), the "Open in Wiki" action is hidden. */
  onOpenPage?: (relPath: string) => void;
  t: Translator;
  messageApi: MessageInstance;
}) {
  const [graph, setGraph] = useState<KbWikiGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [showOrphans, setShowOrphans] = useState(false);
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState("");
  const [hoverId, setHoverId] = useState("");
  const [size, setSize] = useState({ width: 0, height: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods<GNode, GLink> | undefined>(undefined);

  const load = useCallback(async () => {
    if (!project) {
      setGraph(null);
      return;
    }
    setLoading(true);
    try {
      setGraph(await window.supbot.kbWikiGraph(project));
      setSelectedId("");
      setHoverId("");
    } catch (error) {
      messageApi.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [project, messageApi]);

  useEffect(() => {
    setSearch("");
    void load();
  }, [load]);

  // Canvas needs explicit pixel size: track the container.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) {
        setSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // In/out adjacency over the full graph (for hover highlight and the detail panel).
  const { outbound, inbound, neighborIds } = useMemo(() => {
    const out = new Map<string, string[]>();
    const inn = new Map<string, string[]>();
    const neighbors = new Map<string, Set<string>>();
    for (const link of graph?.links ?? []) {
      out.set(link.source, [...(out.get(link.source) ?? []), link.target]);
      inn.set(link.target, [...(inn.get(link.target) ?? []), link.source]);
      neighbors.set(link.source, (neighbors.get(link.source) ?? new Set()).add(link.target));
      neighbors.set(link.target, (neighbors.get(link.target) ?? new Set()).add(link.source));
    }
    return { outbound: out, inbound: inn, neighborIds: neighbors };
  }, [graph]);

  const types = useMemo(() => [...new Set((graph?.nodes ?? []).map((node) => node.type || "untyped"))], [graph]);

  const isOrphan = useCallback(
    (node: KbWikiGraphNode) => node.degree === 0 && node.type !== "source" && node.type !== "overview",
    [],
  );

  const visible = useMemo(() => {
    if (!graph) {
      return { nodes: [] as GNode[], links: [] as GLink[] };
    }
    const nodes = graph.nodes.filter(
      (node) => !hiddenTypes.has(node.type || "untyped") && (showOrphans || !isOrphan(node)),
    );
    const ids = new Set(nodes.map((node) => node.id));
    const links = graph.links.filter((link) => ids.has(link.source) && ids.has(link.target));
    return { nodes: nodes.map((node): GNode => ({ ...node })), links: links.map((link): GLink => ({ ...link })) };
  }, [graph, hiddenTypes, showOrphans, isOrphan]);

  // Active highlight set: hovered node wins over the selected one (logseq dims non-neighbors).
  const focusId = hoverId || selectedId;
  const highlight = useMemo(() => {
    if (!focusId) {
      return null;
    }
    return new Set([focusId, ...(neighborIds.get(focusId) ?? [])]);
  }, [focusId, neighborIds]);

  const selected = graph?.nodes.find((node) => node.id === selectedId) ?? null;

  const toggleType = (type: string) => {
    setHiddenTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  // The simulation mutates the node objects in `visible` in place (adds x/y).
  const locateNode = (id: string) => {
    const node = visible.nodes.find((item) => item.id === id);
    if (node && typeof node.x === "number" && typeof node.y === "number") {
      graphRef.current?.centerAt(node.x, node.y, 600);
      graphRef.current?.zoom(2, 600);
    }
  };

  const runSearch = () => {
    const query = search.trim().toLowerCase();
    if (!query || !graph) {
      return;
    }
    const hit = visible.nodes.find((node) => node.title.toLowerCase().includes(query));
    if (!hit) {
      messageApi.info(t("No page matches the search"));
      return;
    }
    setSelectedId(hit.id);
    locateNode(hit.id);
  };

  const openLinkedPage = (id: string) => {
    setSelectedId(id);
    locateNode(id);
  };

  const renderNode = useCallback(
    (node: GNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = nodeRadius(node);
      const dimmed = highlight !== null && !highlight.has(node.id);
      ctx.globalAlpha = dimmed ? 0.15 : 1;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = typeColor(node.type);
      ctx.fill();
      if (node.id === selectedId) {
        ctx.beginPath();
        ctx.arc(x, y, r + 2.5, 0, 2 * Math.PI);
        ctx.strokeStyle = typeColor(node.type);
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      const emphasized = highlight?.has(node.id) === true;
      if (!dimmed && (emphasized || node.degree >= HUB_DEGREE || globalScale >= LABEL_MIN_SCALE)) {
        const fontSize = Math.max(11 / globalScale, 3);
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = "#1a1d23";
        ctx.fillText(node.title, x, y + r + 1.5);
      }
      ctx.globalAlpha = 1;
    },
    [highlight, selectedId],
  );

  const paintLink = useCallback(
    (link: GLink) => {
      if (highlight === null) {
        return EDGE_COLOR;
      }
      return highlight.has(linkNodeId(link.source)) && highlight.has(linkNodeId(link.target))
        ? EDGE_HIGHLIGHT
        : "rgba(90, 96, 112, 0.08)";
    },
    [highlight],
  );

  if (!project) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("Select a project first")} />;
  }

  return (
    <div className="assets-wikigraph">
      <div className="assets-wikigraph-toolbar">
        <Input
          className="assets-wikigraph-search"
          placeholder={t("Search pages…")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onPressEnter={runSearch}
          allowClear
        />
        <span className="assets-wikigraph-orphans">
          <Switch size="small" checked={showOrphans} onChange={setShowOrphans} />
          {t("Orphan pages")}
        </span>
        <span className="assets-wikigraph-legend">
          {types.map((type) => (
            <button
              type="button"
              key={type}
              className={`assets-graph-legend-item assets-wikigraph-legend-item ${hiddenTypes.has(type) ? "off" : ""}`}
              onClick={() => toggleType(type)}
              title={t("Click to show/hide this type")}
            >
              <i style={{ background: typeColor(type === "untyped" ? "" : type) }} />
              {type}
            </button>
          ))}
        </span>
        <span className="assets-wikigraph-actions">
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            {t("Refresh")}
          </Button>
          <Button size="small" icon={<FullscreenOutlined />} onClick={() => graphRef.current?.zoomToFit(600, 40)}>
            {t("Fit view")}
          </Button>
        </span>
      </div>
      <div className="assets-wikigraph-body">
        <div className="assets-wikigraph-canvas" ref={containerRef}>
          <Spin spinning={loading} className="assets-wikigraph-spin" />
          {!loading && graph && graph.nodes.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("No wiki pages yet")} />
          ) : null}
          {size.width > 0 && size.height > 0 && visible.nodes.length > 0 ? (
            <ForceGraph2D
              ref={graphRef}
              width={size.width}
              height={size.height}
              graphData={visible}
              nodeId="id"
              nodeCanvasObject={renderNode}
              nodePointerAreaPaint={(node: GNode, color, ctx) => {
                const r = nodeRadius(node) + 3;
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, 2 * Math.PI);
                ctx.fill();
              }}
              linkColor={paintLink}
              linkWidth={(link: GLink) =>
                highlight !== null && highlight.has(linkNodeId(link.source)) && highlight.has(linkNodeId(link.target))
                  ? 1.8
                  : 1
              }
              linkDirectionalArrowLength={3.5}
              linkDirectionalArrowRelPos={0.85}
              onNodeHover={(node) => setHoverId(node ? String(node.id) : "")}
              onNodeClick={(node) => setSelectedId(String(node.id))}
              onBackgroundClick={() => setSelectedId("")}
              cooldownTicks={120}
            />
          ) : null}
        </div>
        <div className="assets-wikigraph-side">
          {selected ? (
            <>
              <div className="assets-graph-node-info">
                <div className="assets-graph-node-name">{selected.title}</div>
                <div className="assets-graph-node-type">{selected.type || t("untyped")}</div>
                {selected.tags.length ? (
                  <div className="assets-wikigraph-tags">
                    {selected.tags.map((tag) => (
                      <Tag key={tag}>{tag}</Tag>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="assets-wikigraph-links">
                <div className="assets-sub-header">
                  <span>{t("Outgoing links")}</span>
                </div>
                {(outbound.get(selected.id) ?? []).length ? (
                  (outbound.get(selected.id) ?? []).map((id) => (
                    <button type="button" key={id} className="assets-wikigraph-link" onClick={() => openLinkedPage(id)}>
                      {graph?.nodes.find((node) => node.id === id)?.title || id}
                    </button>
                  ))
                ) : (
                  <p className="assets-placeholder">{t("None")}</p>
                )}
                <div className="assets-sub-header">
                  <span>{t("Incoming links")}</span>
                </div>
                {(inbound.get(selected.id) ?? []).length ? (
                  (inbound.get(selected.id) ?? []).map((id) => (
                    <button type="button" key={id} className="assets-wikigraph-link" onClick={() => openLinkedPage(id)}>
                      {graph?.nodes.find((node) => node.id === id)?.title || id}
                    </button>
                  ))
                ) : (
                  <p className="assets-placeholder">{t("None")}</p>
                )}
              </div>
              {onOpenPage ? (
                <Button type="primary" block onClick={() => onOpenPage(selected.id)}>
                  {t("Open in Wiki")}
                </Button>
              ) : null}
            </>
          ) : (
            <p className="assets-placeholder">{t("Click a node to see details")}</p>
          )}
          <div className="assets-graph-counts">
            {t("{pages} pages, {links} links", { pages: visible.nodes.length, links: visible.links.length })}
          </div>
        </div>
      </div>
    </div>
  );
}
