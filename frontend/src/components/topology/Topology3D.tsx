import { useId, useMemo, useRef } from 'react';
import { Maximize2, Table2 } from 'lucide-react';
import ForceGraph3D, { type ForceGraph3DInstance, type NodeObject, type LinkObject } from 'react-force-graph-3d';
import type { TopoNode, TopoEdge, TopologyTrafficEdge } from '@/types';
import { kindAccent, edgeStyle, KIND_ABBR } from './topologyShared';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';

interface Props {
  graph: { nodes: TopoNode[]; edges: TopoEdge[] };
  trafficEdges?: TopologyTrafficEdge[];
  showTraffic: boolean;
  width: number;
  height: number;
  onSelectNode: (id: string | null) => void;
  /** 3D(WebGL)는 키보드·스크린리더로 조작할 수 없다 — 같은 데이터를 표로 보는 대체 뷰로 전환(D-092). */
  onShowTable?: () => void;
}

interface G3Node extends NodeObject {
  id: string;
  name: string;
  kind: string;
  status: string;
  degree: number;
}
interface G3Link extends LinkObject {
  type: string;
  dropped?: boolean;
}

export function Topology3D({ graph, trafficEdges = [], showTraffic, width, height, onSelectNode, onShowTable }: Props) {
  const ref = useRef<ForceGraph3DInstance>();
  const hintId = useId();

  const data = useMemo(() => {
    const degree: Record<string, number> = {};
    for (const e of graph.edges) {
      degree[e.source] = (degree[e.source] ?? 0) + 1;
      degree[e.target] = (degree[e.target] ?? 0) + 1;
    }
    const nodes: G3Node[] = graph.nodes.map((n) => ({
      id: n.id, name: `${KIND_ABBR[n.kind] ?? n.kind} · ${n.name}`,
      kind: n.kind, status: n.status, degree: degree[n.id] ?? 1,
    }));
    const ids = new Set(nodes.map((n) => n.id));
    const links: G3Link[] = graph.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, type: e.type }));
    if (showTraffic) {
      for (const t of trafficEdges) {
        if (ids.has(t.source) && ids.has(t.target)) {
          links.push({ source: t.source, target: t.target, type: 'traffic', dropped: t.droppedCount > 0 });
        }
      }
    }
    return { nodes, links };
  }, [graph, trafficEdges, showTraffic]);

  // OS "동작 줄이기" 설정이면 트래픽 파티클(무한 애니메이션)을 끈다(D-096).
  const reducedMotion = usePrefersReducedMotion();
  const linkColor = (l: LinkObject) => edgeStyle((l as G3Link).type, (l as G3Link).dropped).stroke;

  // WebGL 캔버스는 보조기기에 내용이 없다 — 요약·조작법을 그룹 라벨로 주고, 같은 정보를 담은 표 보기로 가는
  // 버튼과 "화면 맞춤"을 실제 <button> 으로 둔다(D-092 잔여).
  return (
    <div role="group" className="relative w-full h-full"
      aria-label={`서비스 토폴로지 3D 그래프 — 노드 ${graph.nodes.length}개, 연결 ${graph.edges.length}개`}
      aria-describedby={hintId}>
      <p id={hintId} className="sr-only">
        3D 보기는 마우스로만 조작할 수 있다(드래그 회전, 휠 확대, 노드 클릭 선택). 키보드나 스크린리더로는 표 보기를 쓴다.
      </p>
      <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5">
        {onShowTable && (
          <button type="button" onClick={onShowTable}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-xl border border-border bg-card/90 text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Table2 className="w-3.5 h-3.5" aria-hidden /> 표로 보기
          </button>
        )}
        <button type="button" onClick={() => ref.current?.zoomToFit(400)}
          title="화면 맞춤" aria-label="화면 맞춤"
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-xl border border-border bg-card/90 text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Maximize2 className="w-3.5 h-3.5" aria-hidden />
        </button>
        <span aria-hidden className="hidden sm:inline text-[11px] text-muted-foreground bg-card/80 rounded-xl px-2 py-0.5">
          드래그 회전 · 휠 확대 · 클릭 선택
        </span>
      </div>
    <ForceGraph3D
      ref={ref as React.MutableRefObject<ForceGraph3DInstance>}
      graphData={data}
      width={width}
      height={height}
      backgroundColor="#0b0b0f"
      nodeId="id"
      nodeLabel={(n: NodeObject) => (n as G3Node).name}
      nodeColor={(n: NodeObject) => kindAccent((n as G3Node).kind)}
      nodeVal={(n: NodeObject) => Math.max(1.5, (n as G3Node).degree)}
      linkSource="source"
      linkTarget="target"
      linkColor={linkColor}
      linkWidth={(l: LinkObject) => ((l as G3Link).type === 'traffic' ? 1.5 : 0.6)}
      linkOpacity={0.55}
      linkDirectionalArrowLength={5}
      linkDirectionalArrowRelPos={1}
      linkDirectionalArrowColor={linkColor}
      linkDirectionalParticles={(l: LinkObject) => (!reducedMotion && (l as G3Link).type === 'traffic' ? 4 : 0)}
      linkDirectionalParticleSpeed={0.01}
      linkDirectionalParticleColor={linkColor}
      onNodeClick={(n: NodeObject) => onSelectNode((n as G3Node).id)}
      enableNodeDrag
      enableNavigationControls
      showNavInfo={false}
      warmupTicks={60}
      cooldownTicks={150}
      nodeOpacity={0.95}
    />
    </div>
  );
}
