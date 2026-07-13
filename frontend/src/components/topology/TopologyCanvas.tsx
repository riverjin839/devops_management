import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TopoNode, TopoEdge, TopologyTrafficEdge } from '@/types';
import {
  computeLayout, edgeStyle, kindAccent, statusColor, usageRatio,
  KIND_ABBR, NODE_W, NODE_H, type LayoutPos,
} from './topologyShared';

/** namespace 단위 그래프와 cluster 전체 그래프 모두 받도록 구조적 타입. */
type TopoGraphLike = { nodes: TopoNode[]; edges: TopoEdge[]; generatedAt: string };

interface Props {
  graph: TopoGraphLike;
  trafficEdges?: TopologyTrafficEdge[];
  showTraffic: boolean;
  selectedId: string | null;
  onSelectNode: (id: string | null) => void;
  /** 링크 편집 모드 — 노드 클릭이 링크 양끝 선택으로 동작. */
  editMode: boolean;
  linkSourceId: string | null;
}

interface ViewState { x: number; y: number; k: number; }

export function TopologyCanvas({
  graph, trafficEdges = [], showTraffic, selectedId, onSelectNode, editMode, linkSourceId,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<ViewState>({ x: 60, y: 40, k: 1 });
  const [drag, setDrag] = useState<{ id: string | null; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [override, setOverride] = useState<Record<string, LayoutPos>>({});
  const panning = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const baseLayout = useMemo(() => computeLayout(graph.nodes, graph.edges), [graph]);
  const layout = useMemo(() => ({ ...baseLayout.pos, ...override }), [baseLayout, override]);
  const groups = baseLayout.groups;
  // 새 그래프 로드 시 수동 이동 초기화
  useEffect(() => { setOverride({}); }, [graph.generatedAt]);

  const center = (id: string): LayoutPos | null => {
    const p = layout[id];
    if (!p) return null;
    return { x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 };
  };

  // ── pan / zoom ────────────────────────────────────────────────────────────
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const scale = e.deltaY < 0 ? 1.1 : 0.9;
    setView((v) => ({ ...v, k: Math.max(0.2, Math.min(2.5, v.k * scale)) }));
  }, []);

  const onBgDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    panning.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };
  const onMove = (e: React.MouseEvent) => {
    if (drag) {
      const dx = (e.clientX - drag.startX) / view.k;
      const dy = (e.clientY - drag.startY) / view.k;
      if (drag.id) setOverride((o) => ({ ...o, [drag.id!]: { x: drag.origX + dx, y: drag.origY + dy } }));
      return;
    }
    if (panning.current) {
      setView((v) => ({ ...v, x: panning.current!.vx + (e.clientX - panning.current!.x), y: panning.current!.vy + (e.clientY - panning.current!.y) }));
    }
  };
  const onUp = () => { panning.current = null; setDrag(null); };

  const onNodeDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const p = layout[id];
    if (!p) return;
    setDrag({ id, startX: e.clientX, startY: e.clientY, origX: p.x, origY: p.y });
  };
  const onNodeClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    onSelectNode(id);
  };

  const bezier = (a: LayoutPos, b: LayoutPos): string => {
    const mx = (a.x + b.x) / 2;
    return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
  };

  const maxFlow = useMemo(
    () => Math.max(1, ...trafficEdges.map((t) => t.flowCount)),
    [trafficEdges],
  );

  return (
    <svg
      ref={svgRef}
      className="w-full h-full select-none touch-none"
      style={{ cursor: panning.current ? 'grabbing' : 'default', background: 'transparent' }}
      onWheel={onWheel}
      onMouseDown={onBgDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onMouseLeave={onUp}
      onClick={() => !editMode && onSelectNode(null)}
    >
      <defs>
        <marker id="topo-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
        </marker>
      </defs>
      <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
        {/* 네임스페이스 그룹 박스 (cluster 상세) */}
        {groups.map((box) => (
          <g key={`ns-${box.namespace}`} className="pointer-events-none">
            <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={12}
              fill="hsl(var(--secondary))" fillOpacity={0.25}
              stroke="hsl(var(--border))" strokeDasharray="4 4" />
            <text x={box.x + 12} y={box.y + 17} fontSize={11} fontWeight={700}
              fill="hsl(var(--muted-foreground))">
              {box.namespace}
            </text>
          </g>
        ))}
        {/* 구조 엣지 */}
        {graph.edges.map((e) => {
          const a = center(e.source); const b = center(e.target);
          if (!a || !b) return null;
          const st = edgeStyle(e.type);
          const active = selectedId && (e.source === selectedId || e.target === selectedId);
          return (
            <path
              key={e.id}
              d={bezier(a, b)}
              fill="none"
              stroke={st.stroke}
              strokeWidth={active ? st.width + 1 : st.width}
              strokeDasharray={st.dash}
              strokeOpacity={selectedId && !active ? 0.25 : 0.8}
              markerEnd={e.type === 'manual' ? undefined : 'url(#topo-arrow)'}
            />
          );
        })}

        {/* 트래픽 오버레이 */}
        {showTraffic && trafficEdges.map((t, i) => {
          const a = center(t.source); const b = center(t.target);
          if (!a || !b) return null;
          const st = edgeStyle('traffic', t.droppedCount > 0);
          const w = 1.5 + (t.flowCount / maxFlow) * 4;
          return (
            <g key={`tr-${i}`}>
              <path d={bezier(a, b)} fill="none" stroke={st.stroke} strokeWidth={w}
                strokeDasharray={st.dash} strokeOpacity={0.85} markerEnd="url(#topo-arrow)">
                <animate attributeName="stroke-dashoffset" from="20" to="0" dur="0.6s" repeatCount="indefinite" />
              </path>
              <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4} fontSize={9}
                fill={st.stroke} textAnchor="middle" className="pointer-events-none">
                {t.flowCount}{t.droppedCount > 0 ? ` ⚠${t.droppedCount}` : ''}
              </text>
            </g>
          );
        })}

        {/* 노드 */}
        {graph.nodes.map((n) => {
          const p = layout[n.id];
          if (!p) return null;
          const accent = kindAccent(n.kind);
          const isSel = selectedId === n.id;
          const isLinkSrc = linkSourceId === n.id;
          const cpuR = usageRatio(n.metrics.cpu.usage, n.metrics.cpu.request, n.metrics.cpu.limit);
          const memR = usageRatio(n.metrics.mem.usage, n.metrics.mem.request, n.metrics.mem.limit);
          return (
            <g
              key={n.id}
              transform={`translate(${p.x},${p.y})`}
              onMouseDown={(e) => onNodeDown(e, n.id)}
              onClick={(e) => onNodeClick(e, n.id)}
              style={{ cursor: 'pointer' }}
            >
              <rect
                width={NODE_W} height={NODE_H} rx={10}
                fill="hsl(var(--card))"
                stroke={isLinkSrc ? '#f97316' : isSel ? 'hsl(var(--primary))' : accent}
                strokeWidth={isSel || isLinkSrc ? 2.5 : 1.2}
                strokeDasharray={n.ghost ? '4 3' : undefined}
                opacity={n.ghost ? 0.6 : 1}
              />
              <rect width={4} height={NODE_H} rx={2} fill={accent} />
              {/* kind 배지 */}
              <text x={12} y={16} fontSize={8} fontWeight={700} fill={accent}>{KIND_ABBR[n.kind] ?? n.kind}</text>
              {/* status dot */}
              <circle cx={NODE_W - 10} cy={12} r={4} fill={statusColor(n.status)} />
              {/* 이름 */}
              <text x={12} y={31} fontSize={11} fontWeight={600} fill="hsl(var(--foreground))">
                {n.name.length > 18 ? n.name.slice(0, 17) + '…' : n.name}
              </text>
              {/* Namespace 요약 — 카운트 표시 */}
              {n.kind === 'Namespace' && n.detail && (
                <text x={12} y={45} fontSize={8} fill="hsl(var(--muted-foreground))">
                  {n.detail.length > 24 ? n.detail.slice(0, 23) + '…' : n.detail}
                </text>
              )}
              {/* pod 수 / 미니 usage 바 */}
              {(n.kind !== 'ConfigMap' && n.kind !== 'Secret' && n.kind !== 'External' && n.kind !== 'Namespace') && (
                <>
                  {n.podCount > 0 && (
                    <text x={12} y={45} fontSize={8.5} fill="hsl(var(--muted-foreground))">
                      {n.readyCount}/{n.podCount} pod{n.restartCount > 0 ? ` · ↻${n.restartCount}` : ''}
                    </text>
                  )}
                  {/* CPU 바 */}
                  {cpuR != null && (
                    <>
                      <rect x={NODE_W - 50} y={38} width={38} height={4} rx={2} fill="hsl(var(--secondary))" />
                      <rect x={NODE_W - 50} y={38} width={38 * cpuR} height={4} rx={2}
                        fill={cpuR > 0.9 ? '#ef4444' : cpuR > 0.7 ? '#f59e0b' : '#10b981'} />
                    </>
                  )}
                  {memR != null && (
                    <>
                      <rect x={NODE_W - 50} y={44} width={38} height={4} rx={2} fill="hsl(var(--secondary))" />
                      <rect x={NODE_W - 50} y={44} width={38 * memR} height={4} rx={2}
                        fill={memR > 0.9 ? '#ef4444' : memR > 0.7 ? '#f59e0b' : '#06b6d4'} />
                    </>
                  )}
                </>
              )}
            </g>
          );
        })}
      </g>

      {/* zoom 컨트롤 */}
      <g transform="translate(12,12)" className="pointer-events-auto">
        <ZoomBtn y={0} label="+" onClick={() => setView((v) => ({ ...v, k: Math.min(2.5, v.k * 1.2) }))} />
        <ZoomBtn y={28} label="−" onClick={() => setView((v) => ({ ...v, k: Math.max(0.2, v.k / 1.2) }))} />
        <ZoomBtn y={56} label="⟲" onClick={() => setView({ x: 60, y: 40, k: 1 })} />
      </g>
    </svg>
  );
}

function ZoomBtn({ y, label, onClick }: { y: number; label: string; onClick: () => void }) {
  return (
    <g transform={`translate(0,${y})`} onClick={(e) => { e.stopPropagation(); onClick(); }} style={{ cursor: 'pointer' }}>
      <rect width={24} height={24} rx={6} fill="hsl(var(--card))" stroke="hsl(var(--border))" />
      <text x={12} y={16} fontSize={14} textAnchor="middle" fill="hsl(var(--foreground))">{label}</text>
    </g>
  );
}
