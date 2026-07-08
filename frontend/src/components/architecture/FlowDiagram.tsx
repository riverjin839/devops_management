import { useMemo } from 'react';
import type { FlowNodeDef, FlowEdgeDef, FlowSide } from './flowTypes';
import { STATUS_COLOR, STATUS_FLOW_DURATION, STATUS_KEYS } from './statusVisuals';

const DEFAULT_W = 200;
const DEFAULT_H = 74;

function sidePoint(n: FlowNodeDef, side: FlowSide): [number, number] {
  const w = n.w ?? DEFAULT_W;
  const h = n.h ?? DEFAULT_H;
  switch (side) {
    case 'right': return [n.x + w, n.y + h / 2];
    case 'left': return [n.x, n.y + h / 2];
    case 'top': return [n.x + w / 2, n.y];
    case 'bottom': return [n.x + w / 2, n.y + h];
  }
}

/** from/to 앵커 사이를 잇는 부드러운 3차 베지어 경로 — RAG 파이프라인류 인포그래픽의 커브 화살표 스타일 */
function edgePath(p1: [number, number], p2: [number, number], fromSide: FlowSide, toSide: FlowSide): string {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const horizontal = fromSide === 'left' || fromSide === 'right';
  if (horizontal) {
    const dx = Math.max(Math.abs(x2 - x1) * 0.5, 40);
    const c1x = fromSide === 'right' ? x1 + dx : x1 - dx;
    const c2x = toSide === 'left' ? x2 - dx : x2 + dx;
    return `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`;
  }
  const dy = Math.max(Math.abs(y2 - y1) * 0.5, 40);
  const c1y = fromSide === 'bottom' ? y1 + dy : y1 - dy;
  const c2y = toSide === 'top' ? y2 - dy : y2 + dy;
  return `M ${x1} ${y1} C ${x1} ${c1y}, ${x2} ${c2y}, ${x2} ${y2}`;
}

interface FlowDiagramProps {
  nodes: FlowNodeDef[];
  edges: FlowEdgeDef[];
  width: number;
  height: number;
  onNodeClick?: (id: string) => void;
}

export function FlowDiagram({ nodes, edges, width, height, onNodeClick }: FlowDiagramProps) {
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  return (
    <div className="w-full overflow-x-auto">
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMinYMin meet"
        className="block"
      >
        <defs>
          {STATUS_KEYS.map((s) => (
            <marker
              key={s}
              id={`flow-arrow-${s}`}
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L10 5 L0 10 z" fill={STATUS_COLOR[s]} />
            </marker>
          ))}
        </defs>

        {edges.map((e) => {
          const s = nodeById.get(e.from);
          const t = nodeById.get(e.to);
          if (!s || !t) return null;
          const fromSide = e.fromSide ?? 'right';
          const toSide = e.toSide ?? 'left';
          const p1 = sidePoint(s, fromSide);
          const p2 = sidePoint(t, toSide);
          const d = edgePath(p1, p2, fromSide, toSide);
          const color = STATUS_COLOR[e.status];
          const pathId = `flow-edge-${e.id}`;
          const dur = e.muted ? '5.5s' : STATUS_FLOW_DURATION[e.status];
          const midX = (p1[0] + p2[0]) / 2;
          const midY = (p1[1] + p2[1]) / 2;

          return (
            <g key={e.id}>
              <path
                id={pathId}
                d={d}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeOpacity={e.muted ? 0.35 : 0.75}
                strokeDasharray={e.muted ? '5 4' : undefined}
                markerEnd={`url(#flow-arrow-${e.status})`}
              />
              <circle r={e.muted ? 2.5 : 3.5} fill={color} opacity={e.muted ? 0.5 : 0.95}>
                <animateMotion dur={dur} repeatCount="indefinite">
                  <mpath href={`#${pathId}`} />
                </animateMotion>
              </circle>
              {e.label && !e.muted && (
                <text
                  x={midX}
                  y={midY - 6}
                  textAnchor="middle"
                  className="fill-muted-foreground"
                  style={{ fontSize: 10 }}
                >
                  {e.label}
                </text>
              )}
            </g>
          );
        })}

        {nodes.map((n) => {
          const w = n.w ?? DEFAULT_W;
          const h = n.h ?? DEFAULT_H;
          const color = STATUS_COLOR[n.status];
          const Icon = n.icon;
          return (
            <g
              key={n.id}
              className={onNodeClick ? 'cursor-pointer' : undefined}
              onClick={() => onNodeClick?.(n.id)}
            >
              {n.tooltip && <title>{n.tooltip}</title>}
              <rect
                x={n.x}
                y={n.y}
                width={w}
                height={h}
                rx={14}
                fill="hsl(var(--card))"
                stroke={color}
                strokeWidth={n.muted ? 1.5 : 2}
                strokeDasharray={n.muted ? '5 4' : undefined}
              />
              <foreignObject x={n.x} y={n.y} width={w} height={h}>
                <div className="w-full h-full flex items-center gap-2 px-3">
                  {Icon && <Icon className="w-4 h-4 flex-shrink-0" style={{ color }} />}
                  {n.emoji && <span className="text-base flex-shrink-0">{n.emoji}</span>}
                  <div className="min-w-0">
                    <div className="text-xs font-semibold truncate">{n.label}</div>
                    {n.sublabel && <div className="text-[10px] text-muted-foreground truncate">{n.sublabel}</div>}
                  </div>
                </div>
              </foreignObject>
              <circle cx={n.x + w - 8} cy={n.y + 8} r={4} fill={color}>
                {!n.muted && (
                  <animate attributeName="opacity" values="1;0.35;1" dur="1.8s" repeatCount="indefinite" />
                )}
              </circle>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
