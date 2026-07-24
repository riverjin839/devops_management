import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TopoNode, TopoEdge } from '@/types';
import {
  computeLayout, edgeStyle, kindAccent, statusColor,
  KIND_ABBR, NODE_W, NODE_H, type LayoutPos,
} from '@/components/topology/topologyShared';

/** 캔버스 표시용 노드 — auto/manual 병합 후 페이지가 만들어 넘긴다. */
export interface ArchCanvasNode {
  id: string;
  kind: string;          // K8s kind 또는 manual kind(database|queue|api|external|user|custom)
  name: string;
  status: string;
  stale?: boolean;       // 사라진 auto 노드 (ghost 점선)
  manual?: boolean;      // 수동 추가 노드 (별도 accent)
  manualPk?: string;     // 수동 노드 DB id
  annotated?: boolean;   // 주석 있음 표시
  detail?: string | null;
}

export interface ArchCanvasEdge {
  id: string;
  source: string;
  target: string;
  type: string;          // routes|exposes|...|manual|traffic
  label?: string | null;
  manualPk?: string;
  flowCount?: number;    // traffic 엣지 굵기용
  dropped?: boolean;
  step?: number;         // 플로우 뷰 순번 뱃지
}

interface Props {
  nodes: ArchCanvasNode[];
  edges: ArchCanvasEdge[];
  /** 영속 배치(doc.layout[view]) — 없으면 자동 레이아웃. */
  positions: Record<string, { x: number; y: number }>;
  /** 드래그 종료 시 최종 좌표 통지(디바운스 영속화는 페이지 훅이 담당). */
  onNodeMoved: (id: string, x: number, y: number) => void;
  /** serviceId+view 가 바뀌면 로컬 드래그 오버라이드 초기화. */
  resetKey: string;
  selectedId: string | null;
  onSelectNode: (id: string | null) => void;
  editMode: boolean;
  linkSourceId: string | null;
}

const MANUAL_KIND_ABBR: Record<string, string> = {
  database: 'DB', queue: 'MQ', api: 'API', external: 'EXT', user: 'USR', custom: 'ETC',
};
const MANUAL_ACCENT = '#f97316';

/** SVG ref 를 export(PNG/SVG)용으로 부모에 노출한다. */
export const ArchDocCanvas = forwardRef<SVGSVGElement, Props>(function ArchDocCanvas(
  {
    nodes, edges, positions, onNodeMoved, resetKey,
    selectedId, onSelectNode, editMode, linkSourceId,
  }: Props,
  svgForwardRef,
) {
  const [view, setView] = useState({ x: 60, y: 40, k: 1 });
  const [drag, setDrag] = useState<{
    id: string; startX: number; startY: number; origX: number; origY: number; moved: boolean;
  } | null>(null);
  const [override, setOverride] = useState<Record<string, LayoutPos>>({});
  const panning = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  // 자동 레이아웃은 topologyShared.computeLayout 재사용 — manual kind 는 External 랭크로.
  const baseLayout = useMemo(() => {
    const layoutNodes = nodes.map((n) => ({
      id: n.id,
      kind: n.manual ? 'External' : n.kind,
      name: n.name,
      namespace: '',
      status: n.status,
      podCount: 0, readyCount: 0, restartCount: 0, ghost: false,
      metrics: { cpu: {}, mem: {} },
    })) as unknown as TopoNode[];
    const layoutEdges = edges
      .filter((e) => e.type !== 'traffic')
      .map((e) => ({
        id: e.id, source: e.source, target: e.target, type: e.type, label: '', detail: '',
      })) as unknown as TopoEdge[];
    return computeLayout(layoutNodes, layoutEdges);
  }, [nodes, edges]);

  // 우선순위: 로컬 드래그 > 영속 배치 > 자동 레이아웃
  const layout = useMemo(
    () => ({ ...baseLayout.pos, ...positions, ...override }),
    [baseLayout, positions, override],
  );
  useEffect(() => { setOverride({}); }, [resetKey]);

  const center = (id: string): LayoutPos | null => {
    const p = layout[id];
    if (!p) return null;
    return { x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 };
  };

  // ── pan / zoom / drag ─────────────────────────────────────────────────────
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
      setDrag((d) => (d ? { ...d, moved: d.moved || Math.abs(dx) + Math.abs(dy) > 2 } : d));
      setOverride((o) => ({ ...o, [drag.id]: { x: drag.origX + dx, y: drag.origY + dy } }));
      return;
    }
    if (panning.current) {
      setView((v) => ({
        ...v,
        x: panning.current!.vx + (e.clientX - panning.current!.x),
        y: panning.current!.vy + (e.clientY - panning.current!.y),
      }));
    }
  };
  const onUp = () => {
    panning.current = null;
    if (drag?.moved) {
      const p = override[drag.id];
      if (p) onNodeMoved(drag.id, p.x, p.y);
    }
    setDrag(null);
  };

  const onNodeDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const p = layout[id];
    if (!p) return;
    setDrag({ id, startX: e.clientX, startY: e.clientY, origX: p.x, origY: p.y, moved: false });
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
    () => Math.max(1, ...edges.filter((e) => e.type === 'traffic').map((e) => e.flowCount ?? 0)),
    [edges],
  );

  return (
    <svg
      ref={svgForwardRef}
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
        <marker id="arch-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
        </marker>
      </defs>
      <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
        {/* 엣지 */}
        {edges.map((e) => {
          const a = center(e.source);
          const b = center(e.target);
          if (!a || !b) return null;
          const isTraffic = e.type === 'traffic';
          const st = edgeStyle(e.type, e.dropped);
          const active = selectedId && (e.source === selectedId || e.target === selectedId);
          const width = isTraffic
            ? 1.5 + ((e.flowCount ?? 0) / maxFlow) * 4
            : active ? st.width + 1 : st.width;
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          return (
            <g key={e.id}>
              <path
                d={bezier(a, b)}
                fill="none"
                stroke={st.stroke}
                strokeWidth={width}
                strokeDasharray={st.dash}
                strokeOpacity={selectedId && !active ? 0.25 : 0.85}
                markerEnd="url(#arch-arrow)"
              >
                {isTraffic && (
                  <animate attributeName="stroke-dashoffset" from="20" to="0" dur="0.6s" repeatCount="indefinite" />
                )}
              </path>
              {e.label && !isTraffic && (
                <text x={mid.x} y={mid.y - 6} fontSize={9} fill={st.stroke}
                  textAnchor="middle" className="pointer-events-none">
                  {e.label.length > 20 ? `${e.label.slice(0, 19)}…` : e.label}
                </text>
              )}
              {isTraffic && (
                <text x={mid.x} y={mid.y - 4} fontSize={9} fill={st.stroke}
                  textAnchor="middle" className="pointer-events-none">
                  {e.flowCount}{e.dropped ? ' ⚠' : ''}
                </text>
              )}
              {/* 플로우 순번 뱃지 */}
              {e.step != null && (
                <g className="pointer-events-none">
                  <circle cx={mid.x} cy={mid.y + 10} r={9} fill="#f97316" />
                  <text x={mid.x} y={mid.y + 13.5} fontSize={10} fontWeight={700}
                    fill="#ffffff" textAnchor="middle">
                    {e.step}
                  </text>
                </g>
              )}
            </g>
          );
        })}

        {/* 노드 */}
        {nodes.map((n) => {
          const p = layout[n.id];
          if (!p) return null;
          const accent = n.manual ? MANUAL_ACCENT : kindAccent(n.kind);
          const isSel = selectedId === n.id;
          const isLinkSrc = linkSourceId === n.id;
          const abbr = n.manual
            ? (MANUAL_KIND_ABBR[n.kind] ?? 'EXT')
            : (KIND_ABBR[n.kind] ?? n.kind);
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
                strokeDasharray={n.stale ? '4 3' : n.manual ? '6 3' : undefined}
                opacity={n.stale ? 0.55 : 1}
              />
              <rect width={4} height={NODE_H} rx={2} fill={accent} />
              <text x={12} y={16} fontSize={8} fontWeight={700} fill={accent}>{abbr}</text>
              {!n.manual && <circle cx={NODE_W - 10} cy={12} r={4} fill={statusColor(n.stale ? 'unknown' : n.status)} />}
              <text x={12} y={31} fontSize={11} fontWeight={600} fill="hsl(var(--foreground))">
                {n.name.length > 18 ? `${n.name.slice(0, 17)}…` : n.name}
              </text>
              {n.stale && (
                <text x={12} y={45} fontSize={8} fill="#f59e0b">현행화 시점에 미존재 (stale)</text>
              )}
              {!n.stale && n.detail && (
                <text x={12} y={45} fontSize={8} fill="hsl(var(--muted-foreground))">
                  {n.detail.length > 26 ? `${n.detail.slice(0, 25)}…` : n.detail}
                </text>
              )}
              {n.annotated && (
                <text x={NODE_W - 22} y={48} fontSize={9} className="pointer-events-none">📝</text>
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
});

function ZoomBtn({ y, label, onClick }: { y: number; label: string; onClick: () => void }) {
  return (
    <g transform={`translate(0,${y})`} onClick={(e) => { e.stopPropagation(); onClick(); }} style={{ cursor: 'pointer' }}>
      <rect width={24} height={24} rx={6} fill="hsl(var(--card))" stroke="hsl(var(--border))" />
      <text x={12} y={16} fontSize={14} textAnchor="middle" fill="hsl(var(--foreground))">{label}</text>
    </g>
  );
}
