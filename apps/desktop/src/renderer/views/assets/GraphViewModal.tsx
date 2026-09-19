import { useMemo, useState } from "react";
import { Modal } from "antd";
import type { GraphExtraction } from "@supbot/shared";
import { layoutGraph } from "../../lib/assetsFormat";
import type { Translator } from "../../lib/types";

const NODE_RADIUS = 20;
const PALETTE = ["#4f7cff", "#13c2c2", "#722ed1", "#eb2f96", "#fa8c16", "#52c41a", "#2f54eb", "#fa541c"];

function typeColor(type: string, types: string[]): string {
  const index = Math.max(0, types.indexOf(type));
  return PALETTE[index % PALETTE.length];
}

/** Static SVG rendering of a graph extraction (no graph library dependency). */
export function GraphViewModal({
  extraction,
  title,
  open,
  onClose,
  t,
}: {
  extraction: GraphExtraction | null;
  title: string;
  open: boolean;
  onClose: () => void;
  t: Translator;
}) {
  const [selectedNode, setSelectedNode] = useState("");
  const layout = useMemo(() => (extraction ? layoutGraph(extraction.nodes, extraction.edges) : null), [extraction]);
  const types = useMemo(
    () => (extraction ? [...new Set(extraction.nodes.map((node) => node.type))] : []),
    [extraction],
  );
  const selected = extraction?.nodes.find((node) => node.name === selectedNode);

  return (
    <Modal title={title} open={open} onCancel={onClose} footer={null} width={860} destroyOnHidden>
      {layout && extraction ? (
        <div className="assets-graph-modal">
          <div className="assets-graph-canvas">
            <svg
              width={Math.max(layout.width, 400)}
              height={Math.max(layout.height, 240)}
              role="img"
              aria-label={title}
            >
              <defs>
                <marker
                  id="assets-graph-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 9 5 L 0 9 z" fill="#98a2b3" />
                </marker>
              </defs>
              {layout.edges.map((edge, index) => {
                const dx = edge.x2 - edge.x1;
                const dy = edge.y2 - edge.y1;
                const length = Math.hypot(dx, dy) || 1;
                const trim = NODE_RADIUS + 4;
                const x1 = edge.x1 + (dx / length) * trim;
                const y1 = edge.y1 + (dy / length) * trim;
                const x2 = edge.x2 - (dx / length) * trim;
                const y2 = edge.y2 - (dy / length) * trim;
                return (
                  <g key={index}>
                    <line
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke="#98a2b3"
                      strokeWidth={1.5}
                      markerEnd="url(#assets-graph-arrow)"
                    />
                    <text
                      x={(x1 + x2) / 2}
                      y={(y1 + y2) / 2 - 4}
                      textAnchor="middle"
                      className="assets-graph-edge-label"
                    >
                      {edge.edge.relation}
                    </text>
                  </g>
                );
              })}
              {layout.nodes.map((item) => (
                <g
                  key={item.node.name}
                  transform={`translate(${item.x}, ${item.y})`}
                  onClick={() => setSelectedNode(item.node.name)}
                  style={{ cursor: "pointer" }}
                >
                  <circle
                    r={NODE_RADIUS}
                    fill={typeColor(item.node.type, types)}
                    fillOpacity={0.15}
                    stroke={typeColor(item.node.type, types)}
                    strokeWidth={item.node.name === selectedNode ? 3 : 1.5}
                  />
                  <text textAnchor="middle" dy={4} className="assets-graph-node-initial">
                    {item.node.name.slice(0, 2)}
                  </text>
                  <text textAnchor="middle" y={NODE_RADIUS + 16} className="assets-graph-node-label">
                    {item.node.name.length > 12 ? `${item.node.name.slice(0, 12)}…` : item.node.name}
                  </text>
                </g>
              ))}
            </svg>
          </div>
          <div className="assets-graph-side">
            <div className="assets-graph-legend">
              {types.map((type) => (
                <span key={type} className="assets-graph-legend-item">
                  <i style={{ background: typeColor(type, types) }} />
                  {type}
                </span>
              ))}
            </div>
            {selected ? (
              <div className="assets-graph-node-info">
                <div className="assets-graph-node-name">{selected.name}</div>
                <div className="assets-graph-node-type">{selected.type}</div>
                {selected.description ? <p>{selected.description}</p> : null}
              </div>
            ) : (
              <p className="assets-placeholder">{t("Click a node to see details")}</p>
            )}
            <div className="assets-graph-counts">
              {t("{nodes} nodes, {edges} edges", { nodes: extraction.nodes.length, edges: extraction.edges.length })}
            </div>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
