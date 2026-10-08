import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import type { TopoNode, TopoEdge, TopologyTrafficEdge } from '@/types';
import {
  computeLayout, edgeStyleToken, kindAccent, statusColor, statusGlyph, usageRatio,
  KIND_ABBR, NODE_W, NODE_H, type LayoutPos,
} from './topologyShared';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

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

/** 이 거리(px)를 넘기 전의 이동은 클릭의 손떨림으로 보고 드래그/팬으로 취급하지 않는다. */
const DRAG_THRESHOLD = 5;

export function TopologyCanvas({
  graph, trafficEdges = [], showTraffic, selectedId, onSelectNode, editMode, linkSourceId,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<ViewState>({ x: 60, y: 40, k: 1 });
  const [drag, setDrag] = useState<{ id: string | null; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [override, setOverride] = useState<Record<string, LayoutPos>>({});
  const panning = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  // 마우스를 누른 뒤 임계값 넘게 움직였는지 — 드래그 직후 발화하는 click 을 무시하는 데 쓴다(D-091).
  const moved = useRef(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  // ref 만으로는 재렌더가 없어 grabbing 커서가 바뀌지 않았다(D-097) — 커서용 상태를 따로 둔다.
  const [isPanning, setIsPanning] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  const baseLayout = useMemo(() => computeLayout(graph.nodes, graph.edges), [graph]);
  const layout = useMemo(() => ({ ...baseLayout.pos, ...override }), [baseLayout, override]);
  const groups = baseLayout.groups;
  // 그래프가 다시 오면(재조회·링크 추가 후 invalidate) 사용자가 옮긴 배치는 노드 id 기준으로 유지하고,
  // 새 그래프에 없는 노드의 위치만 버린다. 예전엔 generatedAt 이 바뀔 때마다 배치가 전부 초기화됐다(D-094).
  useEffect(() => {
    const ids = new Set(graph.nodes.map((n) => n.id));
    setOverride((o) => {
      const kept = Object.entries(o).filter(([id]) => ids.has(id));
      return kept.length === Object.keys(o).length ? o : Object.fromEntries(kept);
    });
  }, [graph]);

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
    moved.current = false;
    panning.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    setIsPanning(true);
  };
  const onMove = (e: React.MouseEvent) => {
    if (drag) {
      const rawDx = e.clientX - drag.startX;
      const rawDy = e.clientY - drag.startY;
      if (!moved.current && Math.hypot(rawDx, rawDy) <= DRAG_THRESHOLD) return;
      moved.current = true;
      if (drag.id) setOverride((o) => ({ ...o, [drag.id!]: { x: drag.origX + rawDx / view.k, y: drag.origY + rawDy / view.k } }));
      return;
    }
    if (panning.current) {
      const p = panning.current;
      if (!moved.current && Math.hypot(e.clientX - p.x, e.clientY - p.y) <= DRAG_THRESHOLD) return;
      moved.current = true;
      setView((v) => ({ ...v, x: p.vx + (e.clientX - p.x), y: p.vy + (e.clientY - p.y) }));
    }
  };
  const onUp = () => { panning.current = null; setDrag(null); setIsPanning(false); };

  const onNodeDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const p = layout[id];
    if (!p) return;
    moved.current = false;
    setDrag({ id, startX: e.clientX, startY: e.clientY, origX: p.x, origY: p.y });
  };
  const onNodeClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    // 노드를 끌어 옮긴 뒤 손을 떼면 click 이 따라 발화한다 — 링크 편집 모드에서 시작 노드로 잘못 잡히던 버그.
    if (moved.current) { moved.current = false; return; }
    onSelectNode(id);
  };
  const onBgClick = () => {
    // 배경을 끌어 팬한 뒤 손을 뗀 click 은 선택 해제로 보지 않는다.
    if (moved.current) { moved.current = false; return; }
    if (!editMode) onSelectNode(null);
  };
  const onNodeKeyDown = (e: React.KeyboardEvent, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      onSelectNode(id);
    }
  };
  const onSvgKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !editMode) onSelectNode(null);
  };

  const zoomBy = (factor: number) =>
    setView((v) => ({ ...v, k: Math.max(0.2, Math.min(2.5, v.k * factor)) }));

  const bezier = (a: LayoutPos, b: LayoutPos): string => {
    const mx = (a.x + b.x) / 2;
    return `M ${a.x} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x} ${b.y}`;
  };

  const maxFlow = useMemo(
    () => Math.max(1, ...trafficEdges.map((t) => t.flowCount)),
    [trafficEdges],
  );

  return (
    <div className="relative w-full h-full">
    <svg
      ref={svgRef}
      role="group"
      aria-label={`서비스 토폴로지 그래프 — 노드 ${graph.nodes.length}개, 연결 ${graph.edges.length}개. Tab 으로 노드를 이동하고 Enter 로 선택한다.`}
      className={`w-full h-full select-none touch-none bg-transparent ${isPanning ? 'cursor-grabbing' : 'cursor-default'}`}
      onWheel={onWheel}
      onMouseDown={onBgDown}
      onMouseMove={onMove}
      onMouseUp={onUp}
      onMouseLeave={onUp}
      onClick={onBgClick}
      onKeyDown={onSvgKeyDown}
    >
      <defs>
        <marker id="topo-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="hsl(var(--muted-foreground))" />
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
          const st = edgeStyleToken(e.type);
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
          const st = edgeStyleToken('traffic', t.droppedCount > 0);
          const w = 1.5 + (t.flowCount / maxFlow) * 4;
          return (
            <g key={`tr-${i}`}>
              <path d={bezier(a, b)} fill="none" stroke={st.stroke} strokeWidth={w}
                strokeDasharray={st.dash} strokeOpacity={0.85} markerEnd="url(#topo-arrow)">
                {/* OS "동작 줄이기" 설정이면 흐름 애니메이션을 끈다(D-096) */}
                {!reducedMotion && (
                  <animate attributeName="stroke-dashoffset" from="20" to="0" dur="0.6s" repeatCount="indefinite" />
                )}
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
              onKeyDown={(e) => onNodeKeyDown(e, n.id)}
              onFocus={() => setFocusId(n.id)}
              onBlur={() => setFocusId((cur) => (cur === n.id ? null : cur))}
              role="button"
              tabIndex={0}
              aria-pressed={isSel || isLinkSrc}
              aria-label={nodeAriaLabel(n, isLinkSrc, editMode)}
              className="cursor-pointer outline-none"
            >
              <title>{n.name}</title>
              {focusId === n.id && (
                <rect x={-3} y={-3} width={NODE_W + 6} height={NODE_H + 6} rx={12}
                  fill="none" stroke="hsl(var(--ring))" strokeWidth={2} />
              )}
              <rect
                width={NODE_W} height={NODE_H} rx={10}
                fill="hsl(var(--card))"
                stroke={isLinkSrc ? 'hsl(var(--chart-7))' : isSel ? 'hsl(var(--primary))' : accent}
                strokeWidth={isSel || isLinkSrc ? 2.5 : 1.2}
                strokeDasharray={n.ghost ? '4 3' : undefined}
                opacity={n.ghost ? 0.6 : 1}
              />
              <rect width={4} height={NODE_H} rx={2} fill={accent} />
              {/* kind 배지 */}
              <text x={12} y={16} fontSize={8} fontWeight={700} fill={accent}>{KIND_ABBR[n.kind] ?? n.kind}</text>
              {/* status dot */}
              {/* 상태는 색 + 글자(!/?/·)로 함께 전달한다(D-096) */}
              <circle cx={NODE_W - 10} cy={12} r={5} fill={statusColor(n.status)} />
              {statusGlyph(n.status) && (
                <text x={NODE_W - 10} y={15} fontSize={8} fontWeight={700} textAnchor="middle"
                  fill="hsl(var(--background))" className="pointer-events-none">
                  {statusGlyph(n.status)}
                </text>
              )}
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
                        fill={cpuR > 0.9 ? 'hsl(var(--status-critical))' : cpuR > 0.7 ? 'hsl(var(--status-warning))' : 'hsl(var(--status-healthy))'} />
                    </>
                  )}
                  {memR != null && (
                    <>
                      <rect x={NODE_W - 50} y={44} width={38} height={4} rx={2} fill="hsl(var(--secondary))" />
                      <rect x={NODE_W - 50} y={44} width={38 * memR} height={4} rx={2}
                        fill={memR > 0.9 ? 'hsl(var(--status-critical))' : memR > 0.7 ? 'hsl(var(--status-warning))' : 'hsl(var(--chart-6))'} />
                    </>
                  )}
                </>
              )}
            </g>
          );
        })}
      </g>

    </svg>

      {/* zoom 컨트롤 — SVG <g onClick> 은 키보드·스크린리더로 못 쓰므로 실제 button 으로 둔다(D-092) */}
      <div className="absolute top-3 left-3 flex flex-col gap-1.5">
        <ZoomBtn label="확대" onClick={() => zoomBy(1.2)}><ZoomIn className="w-4 h-4" /></ZoomBtn>
        <ZoomBtn label="축소" onClick={() => zoomBy(1 / 1.2)}><ZoomOut className="w-4 h-4" /></ZoomBtn>
        <ZoomBtn label="보기 초기화" onClick={() => setView({ x: 60, y: 40, k: 1 })}><Maximize2 className="w-4 h-4" /></ZoomBtn>
      </div>
    </div>
  );
}


function ZoomBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="w-8 h-8 inline-flex items-center justify-center rounded-xl border border-border bg-card text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

/** 스크린리더용 노드 설명 — kind·이름·네임스페이스·상태. */
function nodeAriaLabel(n: TopoNode, isLinkSrc: boolean, editMode: boolean): string {
  const parts = [`${n.kind} ${n.name}`, n.namespace ? `네임스페이스 ${n.namespace}` : '', `상태 ${n.status}`];
  if (n.podCount > 0) parts.push(`Pod ${n.readyCount}/${n.podCount}`);
  if (n.ghost) parts.push('존재하지 않는 참조');
  if (isLinkSrc) parts.push('링크 시작 노드');
  else if (editMode) parts.push('Enter 로 링크 양끝으로 선택');
  return parts.filter(Boolean).join(', ');
}
