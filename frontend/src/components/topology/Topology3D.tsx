import { useMemo, useRef } from 'react';
import ForceGraph3D, { type ForceGraph3DInstance, type NodeObject, type LinkObject } from 'react-force-graph-3d';
import type { TopoNode, TopoEdge, TopologyTrafficEdge } from '@/types';
import { kindAccent, edgeStyle, KIND_ABBR } from './topologyShared';

interface Props {
  graph: { nodes: TopoNode[]; edges: TopoEdge[] };
  trafficEdges?: TopologyTrafficEdge[];
  showTraffic: boolean;
  width: number;
  height: number;
  onSelectNode: (id: string | null) => void;
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

export function Topology3D({ graph, trafficEdges = [], showTraffic, width, height, onSelectNode }: Props) {
  const ref = useRef<ForceGraph3DInstance>();

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

  const linkColor = (l: LinkObject) => edgeStyle((l as G3Link).type, (l as G3Link).dropped).stroke;

  return (
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
      linkDirectionalParticles={(l: LinkObject) => ((l as G3Link).type === 'traffic' ? 4 : 0)}
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
  );
}
