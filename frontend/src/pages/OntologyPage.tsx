import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D, { type ForceGraph3DInstance, type NodeObject, type LinkObject } from 'react-force-graph-3d';
import * as THREE from 'three';
import { AlertTriangle, Filter, Info, Loader2, RefreshCw, Search, Share2, X, Zap } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useOntologyGraph, useAnalyzeImpact } from '@/hooks/useOntology';
import type { OntologyEntityType } from '@/types';

// ── 엔티티 타입별 색상 ─────────────────────────────────────────────────────────
const ENTITY_COLOR: Record<OntologyEntityType, string> = {
  node:              '#60a5fa', // blue
  hardware:          '#94a3b8', // slate
  os:                '#34d399', // emerald
  kernel_param:      '#fbbf24', // amber
  network:           '#22d3ee', // cyan
  k8s_component:     '#818cf8', // indigo
  cilium_component:  '#c084fc', // purple
  workload:          '#fb923c', // orange
  service:           '#4ade80', // green
  config_item:       '#f87171', // red
};

const ENTITY_LABEL: Record<OntologyEntityType, string> = {
  node:              'Node',
  hardware:          'Hardware',
  os:                'OS',
  kernel_param:      'Kernel Param',
  network:           'Network',
  k8s_component:     'K8s Component',
  cilium_component:  'Cilium',
  workload:          'Workload',
  service:           'Service',
  config_item:       'Config Item',
};

const ALL_TYPES = Object.keys(ENTITY_COLOR) as OntologyEntityType[];

// ── 그래프 노드/링크 타입 ──────────────────────────────────────────────────────
interface GNode extends NodeObject {
  id: string;
  name: string;
  entityType: OntologyEntityType;
  version?: string;
  properties: Record<string, unknown>;
  __degree?: number;
}

interface GLink extends LinkObject {
  source: string;
  target: string;
  relationType: string;
  weight: number;
}

// ── 노드 Three.js 객체 생성 ────────────────────────────────────────────────────
function makeNodeObject(node: NodeObject): THREE.Mesh {
  const n = node as GNode;
  const color = ENTITY_COLOR[n.entityType] ?? '#888';
  const size = 4 + Math.min((n.__degree ?? 1) * 0.8, 8);
  const geo = new THREE.SphereGeometry(size, 16, 16);
  const mat = new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.92 });
  return new THREE.Mesh(geo, mat);
}

// ── 상세 패널 ─────────────────────────────────────────────────────────────────
function NodeDetailPanel({ node, onClose, onAnalyzeImpact }: {
  node: GNode;
  onClose: () => void;
  onAnalyzeImpact: (entityId: string) => void;
}) {
  const color = ENTITY_COLOR[node.entityType] ?? '#888';
  const hasConfig = node.entityType === 'config_item' || node.entityType === 'kernel_param';

  return (
    <div className="absolute top-4 right-4 w-72 bg-card border border-border rounded-xl shadow-2xl overflow-hidden z-10">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border"
        style={{ borderLeftColor: color, borderLeftWidth: 4 }}>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {ENTITY_LABEL[node.entityType] ?? node.entityType}
          </p>
          <p className="text-sm font-bold text-foreground truncate">{node.name}</p>
        </div>
        <button onClick={onClose} aria-label="닫기" className="p-1 hover:bg-secondary rounded text-muted-foreground flex-shrink-0">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-4 py-3 space-y-3 max-h-[420px] overflow-y-auto">
        {node.version && (
          <div>
            <p className="text-xs text-muted-foreground uppercase font-semibold mb-0.5">버전</p>
            <p className="text-sm font-mono text-foreground">{node.version}</p>
          </div>
        )}
        {node.__degree !== undefined && (
          <div>
            <p className="text-xs text-muted-foreground uppercase font-semibold mb-0.5">연결 수</p>
            <p className="text-sm text-foreground">{node.__degree}개 관계</p>
          </div>
        )}
        {Object.keys(node.properties).length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground uppercase font-semibold mb-1">속성</p>
            <div className="space-y-1">
              {Object.entries(node.properties).map(([k, v]) => (
                <div key={k} className="flex items-start justify-between gap-2 text-sm">
                  <span className="text-muted-foreground flex-shrink-0">{k}</span>
                  <span className="font-mono text-foreground text-right break-all">{String(v)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {hasConfig && (
        <div className="px-4 py-3 border-t border-border">
          <button
            onClick={() => onAnalyzeImpact(node.id)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 border border-amber-500/30 rounded-lg text-sm font-semibold transition-colors"
          >
            <Zap className="w-3.5 h-3.5" />
            변경 영향 분석
          </button>
        </div>
      )}
    </div>
  );
}

// ── Impact 결과 패널 ──────────────────────────────────────────────────────────
function ImpactPanel({ result, onClose }: {
  result: { blastRadiusScore: number; impactedEntities: { id: string; name: string; entityType: OntologyEntityType }[]; impactPaths: { pathNames: string[]; pathRelations: string[]; score: number }[] };
  onClose: () => void;
}) {
  const scoreColor = result.blastRadiusScore >= 0.7 ? 'text-red-400' : result.blastRadiusScore >= 0.4 ? 'text-amber-400' : 'text-emerald-400';

  return (
    <div className="absolute bottom-4 left-4 w-80 bg-card border border-amber-500/40 rounded-xl shadow-2xl overflow-hidden z-10">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-amber-500/10">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <p className="text-sm font-bold text-amber-400">변경 영향 분석</p>
        </div>
        <button onClick={onClose} aria-label="닫기" className="p-1 hover:bg-secondary rounded text-muted-foreground">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="px-4 py-3 space-y-3 max-h-[320px] overflow-y-auto">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">Blast Radius Score</p>
          <p className={`text-lg font-bold ${scoreColor}`}>{(result.blastRadiusScore * 100).toFixed(0)}%</p>
        </div>
        {result.impactedEntities.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground uppercase font-semibold mb-1.5">
              영향 받는 엔티티 ({result.impactedEntities.length})
            </p>
            <div className="space-y-1">
              {result.impactedEntities.slice(0, 8).map((e) => (
                <div key={e.id} className="flex items-center gap-2 text-sm">
                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: ENTITY_COLOR[e.entityType] }} />
                  <span className="text-foreground truncate">{e.name}</span>
                </div>
              ))}
              {result.impactedEntities.length > 8 && (
                <p className="text-xs text-muted-foreground">+{result.impactedEntities.length - 8}개 더...</p>
              )}
            </div>
          </div>
        )}
        {result.impactPaths.slice(0, 3).map((path, i) => (
          <div key={i} className="rounded-lg bg-secondary/40 px-3 py-2">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-muted-foreground">경로 {i + 1}</p>
              <p className="text-xs font-semibold text-amber-400">{(path.score * 100).toFixed(0)}%</p>
            </div>
            <p className="text-xs text-foreground font-mono">
              {path.pathNames.join(' → ')}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── 메인 페이지 ───────────────────────────────────────────────────────────────
export function OntologyPage() {
  const graphRef = useRef<ForceGraph3DInstance>();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ w: 800, h: 600 });

  const { data: clustersData } = useClusters();
  const clusters = useMemo(() => clustersData ?? [], [clustersData]);
  const [clusterId, setClusterId] = useState('');
  const [search, setSearch] = useState('');
  const [activeTypes, setActiveTypes] = useState<Set<OntologyEntityType>>(new Set(ALL_TYPES));
  const [selectedNode, setSelectedNode] = useState<GNode | null>(null);
  const [impactResult, setImpactResult] = useState<ReturnType<typeof useAnalyzeImpact>['data'] | null>(null);
  const [showLegend, setShowLegend] = useState(true);

  const { data: graph, isLoading, refetch } = useOntologyGraph(clusterId || null);
  const { mutate: analyzeImpact, isPending: analyzing } = useAnalyzeImpact();

  // 컨테이너 크기 추적
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        setDimensions({
          w: containerRef.current.clientWidth,
          h: containerRef.current.clientHeight,
        });
      }
    });
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // 클러스터 자동 선택
  useEffect(() => {
    if (!clusterId && clusters.length > 0) setClusterId(clusters[0].id);
  }, [clusters, clusterId]);

  // degree 계산
  const degreeMap = useMemo<Record<string, number>>(() => {
    if (!graph) return {};
    const m: Record<string, number> = {};
    for (const r of graph.relationships) {
      m[r.sourceEntityId] = (m[r.sourceEntityId] ?? 0) + 1;
      m[r.targetEntityId] = (m[r.targetEntityId] ?? 0) + 1;
    }
    return m;
  }, [graph]);

  // ForceGraph3D graphData 변환
  const graphData = useMemo(() => {
    if (!graph) return { nodes: [], links: [] };

    const q = search.toLowerCase();
    const filteredIds = new Set(
      graph.entities
        .filter((e) => activeTypes.has(e.entityType) && (!q || e.name.toLowerCase().includes(q)))
        .map((e) => e.id)
    );

    const nodes: GNode[] = graph.entities
      .filter((e) => filteredIds.has(e.id))
      .map((e) => ({
        id: e.id,
        name: e.name,
        entityType: e.entityType,
        version: e.version,
        properties: e.properties,
        __degree: degreeMap[e.id] ?? 0,
      }));

    const links: GLink[] = graph.relationships
      .filter((r) => filteredIds.has(r.sourceEntityId) && filteredIds.has(r.targetEntityId))
      .map((r) => ({
        source: r.sourceEntityId,
        target: r.targetEntityId,
        relationType: r.relationType,
        weight: r.weight,
      }));

    return { nodes, links };
  }, [graph, activeTypes, search, degreeMap]);

  const handleNodeClick = useCallback((nodeObj: NodeObject) => {
    const n = nodeObj as GNode;
    setSelectedNode(n);
    setImpactResult(null);
    // 카메라 포커스
    if (graphRef.current && n.x !== undefined) {
      graphRef.current.cameraPosition(
        { x: n.x! + 60, y: n.y! + 30, z: n.z! + 80 },
        { x: n.x!, y: n.y!, z: n.z! },
        800,
      );
    }
  }, []);

  const handleAnalyzeImpact = useCallback((entityId: string) => {
    if (!clusterId) return;
    analyzeImpact({
      clusterId,
      configEntityId: entityId,
      category: 'config_change',
      severity: 'warning',
      title: `${selectedNode?.name ?? entityId} 변경 영향 분석`,
      maxDepth: 4,
    }, {
      onSuccess: (data) => setImpactResult(data),
    });
  }, [clusterId, selectedNode, analyzeImpact]);

  const toggleType = (t: OntologyEntityType) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });
  };

  const nodeLabel = useCallback((n: NodeObject) => {
    const node = n as GNode;
    return `<div style="background:rgba(0,0,0,0.8);padding:4px 8px;border-radius:4px;font-size:12px;color:#fff">
      <b>${node.name}</b><br/><span style="opacity:.7">${ENTITY_LABEL[node.entityType] ?? node.entityType}</span>
      ${node.version ? `<br/><span style="opacity:.5">v${node.version}</span>` : ''}
    </div>`;
  }, []);

  const linkColor = useCallback((l: LinkObject) => {
    const link = l as GLink;
    const alpha = Math.round(40 + link.weight * 120).toString(16).padStart(2, '0');
    return `#ffffff${alpha}`;
  }, []);

  const isEmpty = !isLoading && graph && graph.entities.length === 0;

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      {/* 상단 툴바 */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-card flex-shrink-0 z-20">
        <Share2 className="w-5 h-5 text-primary flex-shrink-0" />
        <h1 className="text-base font-bold flex-shrink-0">온톨로지 그래프</h1>

        <div className="h-5 w-px bg-border" />

        {/* 클러스터 선택 */}
        <select
          value={clusterId}
          onChange={(e) => setClusterId(e.target.value)}
          className="px-2 py-1 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        >
          <option value="">— 클러스터 선택 —</option>
          {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        {/* 검색 */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="노드 검색..."
            className="pl-7 pr-3 py-1 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary w-44"
          />
        </div>

        {/* 통계 */}
        {graph && (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span><b className="text-foreground">{graphData.nodes.length}</b>/{graph.entities.length} 노드</span>
            <span><b className="text-foreground">{graphData.links.length}</b> 관계</span>
          </div>
        )}

        <div className="flex-1" />

        {/* 범례 토글 */}
        <button
          onClick={() => setShowLegend((v) => !v)}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-sm border transition-colors ${
            showLegend ? 'bg-primary/10 border-primary/30 text-primary' : 'bg-secondary border-border text-muted-foreground'
          }`}
        >
          <Info className="w-3.5 h-3.5" />범례
        </button>

        {/* 필터 초기화 */}
        {activeTypes.size < ALL_TYPES.length && (
          <button
            onClick={() => setActiveTypes(new Set(ALL_TYPES))}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-sm bg-secondary border border-border text-muted-foreground hover:text-foreground"
          >
            <Filter className="w-3.5 h-3.5" />전체
          </button>
        )}

        {/* 새로고침 */}
        <button
          onClick={() => refetch()}
          disabled={isLoading}
          aria-label="새로고침"
          className="p-1.5 hover:bg-secondary rounded-lg text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* 타입 필터 바 */}
      <div className="flex items-center gap-1.5 px-4 py-2 bg-card/60 border-b border-border/60 flex-shrink-0 overflow-x-auto">
        {ALL_TYPES.map((t) => {
          const active = activeTypes.has(t);
          return (
            <button
              key={t}
              onClick={() => toggleType(t)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border flex-shrink-0 transition-all ${
                active ? 'opacity-100' : 'opacity-35'
              }`}
              style={{
                background: active ? `${ENTITY_COLOR[t]}20` : 'transparent',
                borderColor: `${ENTITY_COLOR[t]}60`,
                color: ENTITY_COLOR[t],
              }}
            >
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: ENTITY_COLOR[t] }} />
              {ENTITY_LABEL[t]}
            </button>
          );
        })}
      </div>

      {/* 3D 그래프 영역 */}
      <div ref={containerRef} className="flex-1 relative overflow-hidden">
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/70 z-10">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
          </div>
        )}

        {analyzing && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-amber-500/20 border border-amber-500/40 rounded-full px-4 py-2 text-sm text-amber-400 z-20">
            <Loader2 className="w-4 h-4 animate-spin" />영향 분석 중...
          </div>
        )}

        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground/50">
            <Share2 className="w-16 h-16 mb-4" />
            <p className="text-base">이 클러스터에 온톨로지 데이터가 없습니다</p>
            <p className="text-sm mt-1">API로 엔티티와 관계를 먼저 등록하세요</p>
            <code className="mt-3 px-3 py-1.5 bg-secondary rounded text-sm font-mono">
              POST /api/v1/ontology/entities
            </code>
          </div>
        ) : (
          <ForceGraph3D
            ref={graphRef as React.MutableRefObject<ForceGraph3DInstance>}
            graphData={graphData}
            width={dimensions.w}
            height={dimensions.h}
            backgroundColor="#09090b"
            nodeId="id"
            nodeLabel={nodeLabel}
            nodeThreeObject={makeNodeObject}
            nodeThreeObjectExtend={false}
            nodeVal={(n) => Math.max(1, (n as GNode).__degree ?? 1)}
            linkSource="source"
            linkTarget="target"
            linkLabel={(l: LinkObject) => (l as GLink).relationType}
            linkColor={linkColor}
            linkWidth={(l: LinkObject) => 0.5 + (l as GLink).weight * 1.5}
            linkOpacity={0.6}
            linkDirectionalArrowLength={6}
            linkDirectionalArrowRelPos={1}
            linkDirectionalArrowColor={linkColor}
            linkDirectionalParticles={(l: LinkObject) => Math.round((l as GLink).weight * 3)}
            linkDirectionalParticleSpeed={0.004}
            linkDirectionalParticleColor={linkColor}
            onNodeClick={handleNodeClick}
            enableNodeDrag
            enableNavigationControls
            showNavInfo={false}
            warmupTicks={80}
            cooldownTicks={200}
          />
        )}

        {/* 범례 패널 */}
        {showLegend && (
          <div className="absolute top-4 left-4 bg-card/90 backdrop-blur border border-border rounded-xl px-4 py-3 space-y-1.5 z-10">
            <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">엔티티 타입</p>
            {ALL_TYPES.map((t) => (
              <div key={t} className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: ENTITY_COLOR[t] }} />
                <span className="text-sm text-muted-foreground">{ENTITY_LABEL[t]}</span>
              </div>
            ))}
            <div className="pt-2 mt-2 border-t border-border/40 space-y-1">
              <p className="text-xs text-muted-foreground">• 구체 크기 = 연결 수</p>
              <p className="text-xs text-muted-foreground">• 파티클 = 관계 방향</p>
              <p className="text-xs text-muted-foreground">• 링크 굵기 = 가중치</p>
              <p className="text-xs text-muted-foreground">• 드래그로 노드 이동</p>
            </div>
          </div>
        )}

        {/* 선택된 노드 상세 패널 */}
        {selectedNode && (
          <NodeDetailPanel
            node={selectedNode}
            onClose={() => { setSelectedNode(null); setImpactResult(null); }}
            onAnalyzeImpact={handleAnalyzeImpact}
          />
        )}

        {/* 영향 분석 결과 패널 */}
        {impactResult && (
          <ImpactPanel
            result={impactResult}
            onClose={() => setImpactResult(null)}
          />
        )}
      </div>
    </div>
  );
}
