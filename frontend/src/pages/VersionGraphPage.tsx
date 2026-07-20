import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import ForceGraph3D, { type ForceGraph3DInstance, type NodeObject, type LinkObject } from 'react-force-graph-3d';
import * as THREE from 'three';
import { ArrowLeft, Loader2, RefreshCw, Share2, X } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { versionsApi, type VersionGraphNode, type VersionGraphEdge } from '@/services/api';
import { useClusters } from '@/hooks/useCluster';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';

// ── 타입별 색상 (D-005: 차트 토큰 체계) ─────────────────────────────────────
// three.js(WebGL) 는 CSS var() 문자열을 해석하지 못하므로, 토큰명을 들고 있다가
// 렌더 시점에 computed value 를 읽어 THREE.Color 와 DOM 이 모두 파싱 가능한
// hsl(h, s%, l%) 문자열로 변환해 쓴다.

const NODE_TOKEN: Record<VersionGraphNode['type'], string> = {
  cluster:   '--chart-1', // blue
  category:  '--chart-4', // violet
  component: '--chart-2', // teal/green
  flag:      '--chart-3', // amber
};

function chartTokenColor(token: string | undefined): string {
  if (!token) return 'hsl(215, 15%, 50%)'; // --chart-8 slate fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  if (!v) return 'hsl(215, 15%, 50%)';
  return `hsl(${v.split(/\s+/).join(', ')})`;
}

const NODE_SIZE: Record<VersionGraphNode['type'], number> = {
  cluster:   14,
  category:  10,
  component: 7,
  flag:      3.5,
};

// EDGE_COLOR — 허용 예외(D-005): alpha 포함 hex 를 ForceGraph3D(WebGL 링크 블렌딩)가
// 직접 파싱하므로 CSS 토큰으로 이관하지 않는다 (FlowGraph3D 등 canvas/three.js 와 동일 예외).
const EDGE_COLOR: Record<VersionGraphEdge['type'], string> = {
  contains:   '#ffffff55',
  param:      '#fbbf2466',
  configures: '#4ade8066',
  replaces:   '#f8717188',
};

interface GNode extends NodeObject {
  id: string;
  label: string;
  type: VersionGraphNode['type'];
  category?: string;
  version?: string | null;
  value?: string;
  collectedAt?: string;
}

interface GLink extends LinkObject {
  source: string;
  target: string;
  type: VersionGraphEdge['type'];
}

// ── Three.js Mesh factory ──────────────────────────────────────────────────

function makeNodeObject(node: NodeObject): THREE.Mesh {
  const n = node as GNode;
  const size = NODE_SIZE[n.type] ?? 5;
  const color = chartTokenColor(NODE_TOKEN[n.type]);
  const geo = new THREE.SphereGeometry(size, 16, 16);
  const mat = new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.92 });
  return new THREE.Mesh(geo, mat);
}

// ── Node detail panel ──────────────────────────────────────────────────────

function NodeDetail({ node, onClose }: { node: GNode; onClose: () => void }) {
  return (
    <div className="absolute top-4 right-4 w-80 bg-card border border-border rounded-xl shadow-2xl overflow-hidden z-10">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border"
        style={{ borderLeftColor: chartTokenColor(NODE_TOKEN[node.type]), borderLeftWidth: 4 }}>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {node.type}
          </p>
          <p className="text-sm font-bold text-foreground truncate">{node.label}</p>
        </div>
        <button onClick={onClose} aria-label="닫기" className="p-1 hover:bg-secondary rounded text-muted-foreground flex-shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="px-4 py-3 space-y-3 max-h-[420px] overflow-y-auto text-sm">
        {node.version && (
          <div>
            <p className="text-xs text-muted-foreground uppercase mb-0.5">Version</p>
            <p className="font-mono text-foreground">{node.version}</p>
          </div>
        )}
        {node.value && (
          <div>
            <p className="text-xs text-muted-foreground uppercase mb-0.5">Value</p>
            <p className="font-mono text-foreground break-all">{node.value}</p>
          </div>
        )}
        {node.category && (
          <div>
            <p className="text-xs text-muted-foreground uppercase mb-0.5">Category</p>
            <p className="font-mono text-foreground">{node.category}</p>
          </div>
        )}
        {node.collectedAt && (
          <div>
            <p className="text-xs text-muted-foreground uppercase mb-0.5">Collected</p>
            <p className="font-mono text-foreground text-xs">{node.collectedAt}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 메인 페이지 ──────────────────────────────────────────────────────────────

export function VersionGraphPage() {
  const { clusterId: paramClusterId } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: clusters = [] } = useClusters();
  const [selectedId, setSelectedId] = useState<string>('');

  useEffect(() => {
    if (paramClusterId) setSelectedId(paramClusterId);
    else if (clusters.length > 0 && !selectedId) setSelectedId(clusters[0].id);
  }, [paramClusterId, clusters, selectedId]);

  const { data, isLoading } = useQuery({
    queryKey: ['versions', 'graph', selectedId],
    queryFn: () => versionsApi.graph(selectedId).then((r) => r.data),
    enabled: !!selectedId,
  });

  const graphRef = useRef<ForceGraph3DInstance>();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 800, h: 600 });
  const [selectedNode, setSelectedNode] = useState<GNode | null>(null);

  useEffect(() => {
    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        setDims({ w: containerRef.current.clientWidth, h: containerRef.current.clientHeight });
      }
    });
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const graphData = useMemo(() => ({
    nodes: (data?.nodes ?? []).map((n) => ({ ...n })) as GNode[],
    links: (data?.edges ?? []).map((e) => ({ source: e.source, target: e.target, type: e.type })) as GLink[],
  }), [data]);

  const linkColor = useCallback((l: LinkObject) => {
    const link = l as GLink;
    return EDGE_COLOR[link.type] ?? '#ffffff55';
  }, []);

  const nodeLabel = useCallback((n: NodeObject) => {
    const node = n as GNode;
    return `<div style="background:rgba(0,0,0,0.85);padding:4px 8px;border-radius:4px;font-size:12px;color:#fff;font-family:ui-monospace,monospace">
      <b>${node.label}</b>
      ${node.version ? `<br/><span style="opacity:.7">${node.version}</span>` : ''}
    </div>`;
  }, []);

  const handleNodeClick = useCallback((nodeObj: NodeObject) => {
    const n = nodeObj as GNode;
    setSelectedNode(n);
    if (graphRef.current && n.x !== undefined) {
      graphRef.current.cameraPosition(
        { x: n.x! + 40, y: n.y! + 30, z: n.z! + 60 },
        { x: n.x!, y: n.y!, z: n.z! },
        800,
      );
    }
  }, []);

  const collectAndRefresh = async () => {
    if (!selectedId) return;
    try {
      await versionsApi.collect(selectedId);
      queryClient.invalidateQueries({ queryKey: ['versions'] });
      toast.success('수집 완료');
    } catch (e) {
      toast.error('수집 실패', formatApiError(e));
    }
  };

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      {/* 툴바 */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-card flex-shrink-0 z-20">
        <button onClick={() => navigate('/versions')}
          className="p-1.5 hover:bg-secondary rounded text-muted-foreground hover:text-foreground"
          title="버전 페이지로" aria-label="버전 페이지로">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <Share2 className="w-5 h-5 text-primary flex-shrink-0" />
        <h1 className="text-base font-bold flex-shrink-0">컴포넌트 관계 그래프</h1>
        <div className="h-5 w-px bg-border" />
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="px-2 py-1 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="">— 클러스터 선택 —</option>
          {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div className="flex items-center gap-1 ml-auto text-xs text-muted-foreground flex-wrap">
          {(Object.entries(NODE_TOKEN) as Array<[VersionGraphNode['type'], string]>).map(([k, v]) => (
            <span key={k} className="inline-flex items-center gap-1">
              <span className="w-2 h-2 rounded-full" style={{ background: `hsl(var(${v}))` }} />
              {k}
            </span>
          ))}
        </div>
        <button
          onClick={collectAndRefresh}
          disabled={!selectedId}
          className="flex items-center gap-1 px-2 py-1 text-sm bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 rounded transition-colors disabled:opacity-50"
        >
          <RefreshCw className="w-3 h-3" />
          재수집
        </button>
      </div>

      {/* 그래프 */}
      <div ref={containerRef} className="flex-1 relative">
        {!selectedId ? (
          <p className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
            클러스터를 선택하세요.
          </p>
        ) : isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> 로딩 중…
          </div>
        ) : graphData.nodes.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground text-sm gap-2">
            <p>아직 수집된 스냅샷이 없습니다.</p>
            <button
              onClick={collectAndRefresh}
              className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg"
            >
              지금 수집
            </button>
          </div>
        ) : (
          <ForceGraph3D
            ref={graphRef}
            graphData={graphData}
            width={dims.w}
            height={dims.h}
            backgroundColor="rgba(0,0,0,0)"
            nodeThreeObject={makeNodeObject}
            nodeLabel={nodeLabel}
            linkColor={linkColor}
            linkWidth={1}
            linkDirectionalArrowLength={3}
            linkDirectionalArrowRelPos={1}
            linkOpacity={0.6}
            onNodeClick={handleNodeClick}
          />
        )}

        {selectedNode && (
          <NodeDetail node={selectedNode} onClose={() => setSelectedNode(null)} />
        )}
      </div>
    </div>
  );
}
