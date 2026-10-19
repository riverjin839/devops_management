import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D, { type ForceGraph3DInstance, type NodeObject, type LinkObject } from 'react-force-graph-3d';
import * as THREE from 'three';
import { AlertTriangle, Filter, Info, Loader2, RefreshCw, Search, Share2, X, Zap } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useClusterRouteParam } from '@/hooks/useClusterRouteParam';
import { useOntologyGraph, useAnalyzeImpact } from '@/hooks/useOntology';
import type { OntologyEntityType, OntologyImpactResponse } from '@/types';
import { PageHeader, LoadingState, EmptyState, RunLogPanel, ClusterSidebar } from '@/components/common';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { cssVarColor, useThemeColorKey } from '@/lib/chartTokens';

// ── 엔티티 타입별 색상 (D-120: 차트 토큰) ─────────────────────────────────────
// three.js 재질 전용 — 토큰명을 들고 있다가 cssVarColor 로 현재 테마 값을 읽는다.
// DOM(칩·점·바)은 아래 ENTITY_CLASS 의 Tailwind 토큰 클래스를 쓴다 — 두 맵은 같이 바꾼다.
// 분류색이 8종이라 10종 중 2종은 같은 계열의 명도 변형(lighten)으로 구분한다.
const ENTITY_TOKEN: Record<OntologyEntityType, { token: string; lighten?: number }> = {
  node:              { token: '--chart-1' },              // blue
  hardware:          { token: '--chart-8' },              // slate
  os:                { token: '--chart-2' },              // teal
  kernel_param:      { token: '--chart-3' },              // amber
  network:           { token: '--chart-6' },              // cyan
  k8s_component:     { token: '--chart-4' },              // violet
  cilium_component:  { token: '--chart-6', lighten: 16 }, // 네트워크 계열 명도 변형
  workload:          { token: '--chart-7' },              // orange
  service:           { token: '--chart-5' },              // rose
  config_item:       { token: '--chart-3', lighten: 16 }, // 설정 계열 명도 변형
};

/** 엔티티 타입별 DOM 클래스 — dot(점), tint(활성 칩 배경), edge(칩 테두리), bar(상세 패널 좌측 바).
 *  CSS 변수를 직접 참조하므로 테마가 바뀌면 리렌더 없이 따라간다. JIT 가 찾도록 전체 클래스명을 리터럴로 둔다. */
const ENTITY_CLASS: Record<OntologyEntityType, { dot: string; tint: string; edge: string; bar: string }> = {
  node:              { dot: 'bg-chart-1',       tint: 'bg-chart-1/[0.13]',       edge: 'border-chart-1/40',       bar: 'border-l-chart-1' },
  hardware:          { dot: 'bg-chart-8',       tint: 'bg-chart-8/[0.13]',       edge: 'border-chart-8/40',       bar: 'border-l-chart-8' },
  os:                { dot: 'bg-chart-2',       tint: 'bg-chart-2/[0.13]',       edge: 'border-chart-2/40',       bar: 'border-l-chart-2' },
  kernel_param:      { dot: 'bg-chart-3',       tint: 'bg-chart-3/[0.13]',       edge: 'border-chart-3/40',       bar: 'border-l-chart-3' },
  network:           { dot: 'bg-chart-6',       tint: 'bg-chart-6/[0.13]',       edge: 'border-chart-6/40',       bar: 'border-l-chart-6' },
  k8s_component:     { dot: 'bg-chart-4',       tint: 'bg-chart-4/[0.13]',       edge: 'border-chart-4/40',       bar: 'border-l-chart-4' },
  cilium_component:  { dot: 'bg-chart-6-light', tint: 'bg-chart-6-light/[0.13]', edge: 'border-chart-6-light/40', bar: 'border-l-chart-6-light' },
  workload:          { dot: 'bg-chart-7',       tint: 'bg-chart-7/[0.13]',       edge: 'border-chart-7/40',       bar: 'border-l-chart-7' },
  service:           { dot: 'bg-chart-5',       tint: 'bg-chart-5/[0.13]',       edge: 'border-chart-5/40',       bar: 'border-l-chart-5' },
  config_item:       { dot: 'bg-chart-3-light', tint: 'bg-chart-3-light/[0.13]', edge: 'border-chart-3-light/40', bar: 'border-l-chart-3-light' },
};

const FALLBACK_CLASS = ENTITY_CLASS.hardware; // chart-8 slate

function entityClass(t: OntologyEntityType) {
  return ENTITY_CLASS[t] ?? FALLBACK_CLASS;
}

/** 엔티티 타입별 three.js 재질 색(alpha 없는 hsl). */
function entityColors(): Record<OntologyEntityType, string> {
  return Object.fromEntries(
    (Object.entries(ENTITY_TOKEN) as Array<[OntologyEntityType, { token: string; lighten?: number }]>).map(([t, { token, lighten }]) => [
      t, cssVarColor(token, { lighten }),
    ]),
  ) as Record<OntologyEntityType, string>;
}

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

const ALL_TYPES = Object.keys(ENTITY_TOKEN) as OntologyEntityType[];

const IMPACT_MAX_DEPTH = 4;
const LOG_ITEM_CAP = 200;

/** 영향 분석 응답 → 실행 로그 줄(영향 엔티티·경로는 한 건당 한 줄, 200건 초과분은 "외 N건"). */
function impactLines(r: OntologyImpactResponse): RunLogEntry[] {
  const out: RunLogEntry[] = [[
    'info',
    `분석 완료 — Blast Radius ${(r.blastRadiusScore * 100).toFixed(0)}% · 영향 엔티티 ${r.impactedEntities.length} · 영향 경로 ${r.impactPaths.length} · 최대 깊이 ${IMPACT_MAX_DEPTH} · 이벤트 ${r.eventId.slice(0, 8)}`,
  ]];
  if (r.impactedEntities.length === 0) out.push(['info', '영향 받는 엔티티 없음']);
  for (const e of r.impactedEntities.slice(0, LOG_ITEM_CAP)) {
    out.push(['info', `영향 엔티티 — ${e.name} (${ENTITY_LABEL[e.entityType] ?? e.entityType})`]);
  }
  if (r.impactedEntities.length > LOG_ITEM_CAP) out.push(['info', `영향 엔티티 외 ${r.impactedEntities.length - LOG_ITEM_CAP}건`]);
  r.impactPaths.slice(0, LOG_ITEM_CAP).forEach((p, i) => {
    out.push(['info', `경로 ${i + 1} · ${(p.score * 100).toFixed(0)}% · 깊이 ${Math.max(p.pathNames.length - 1, 0)} — ${p.pathNames.join(' → ')}`]);
  });
  if (r.impactPaths.length > LOG_ITEM_CAP) out.push(['info', `경로 외 ${r.impactPaths.length - LOG_ITEM_CAP}건`]);
  return out;
}

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
function makeNodeObject(node: NodeObject, colors: Record<OntologyEntityType, string>): THREE.Mesh {
  const n = node as GNode;
  // MeshLambertMaterial 은 hsl(…) 을 파싱한다 — alpha 없는 색만 넘긴다.
  const color = colors[n.entityType] ?? cssVarColor('--chart-8');
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
  const hasConfig = node.entityType === 'config_item' || node.entityType === 'kernel_param';

  return (
    <div className="absolute top-4 right-4 w-72 bg-card border border-border rounded-md shadow-card overflow-hidden z-10">
      <div className={`flex items-center justify-between px-4 py-3 border-b border-border border-l-4 ${entityClass(node.entityType).bar}`}>
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">
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
            <p className="text-xs font-medium text-muted-foreground mb-0.5">버전</p>
            <p className="text-sm font-mono text-foreground">{node.version}</p>
          </div>
        )}
        {node.__degree !== undefined && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-0.5">연결 수</p>
            <p className="text-sm text-foreground">{node.__degree}개 관계</p>
          </div>
        )}
        {Object.keys(node.properties).length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">속성</p>
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
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-secondary hover:bg-muted text-foreground border border-border rounded-xl text-sm font-medium transition-colors"
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
  const scoreColor = result.blastRadiusScore >= 0.7 ? 'text-status-critical' : result.blastRadiusScore >= 0.4 ? 'text-status-warning' : 'text-foreground';

  return (
    <div className="absolute bottom-4 left-4 w-80 bg-card border border-border rounded-md shadow-card overflow-hidden z-10">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-status-warning" />
          <p className="text-sm font-semibold text-foreground">변경 영향 분석</p>
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
            <p className="text-xs font-medium text-muted-foreground mb-1.5">
              영향 받는 엔티티 ({result.impactedEntities.length})
            </p>
            <div className="space-y-1">
              {result.impactedEntities.slice(0, 8).map((e) => (
                <div key={e.id} className="flex items-center gap-2 text-sm">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${entityClass(e.entityType).dot}`} />
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
          <div key={i} className="rounded-md bg-secondary/40 px-3 py-2">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs text-muted-foreground">경로 {i + 1}</p>
              <p className="text-xs font-semibold text-foreground tabular-nums">{(path.score * 100).toFixed(0)}%</p>
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
export function OntologyPage({ embedded = false }: { embedded?: boolean } = {}) {
  const graphRef = useRef<ForceGraph3DInstance>();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ w: 800, h: 600 });

  const { data: clustersData } = useClusters();
  const clusters = useMemo(() => clustersData ?? [], [clustersData]);
  // 선택은 URL(/ontology/:clusterId)이 원천. 지식 허브 탭에 마운트될 땐(embedded) URL 을 건드리지 않는다.
  const { clusterId, selectCluster } = useClusterRouteParam('/ontology', clusters, { local: embedded });
  const [search, setSearch] = useState('');
  const [activeTypes, setActiveTypes] = useState<Set<OntologyEntityType>>(new Set(ALL_TYPES));
  const [selectedNode, setSelectedNode] = useState<GNode | null>(null);
  const [impactResult, setImpactResult] = useState<ReturnType<typeof useAnalyzeImpact>['data'] | null>(null);
  const [showLegend, setShowLegend] = useState(true);

  const { data: graph, isLoading, refetch } = useOntologyGraph(clusterId || null);
  const { mutateAsync: analyzeImpact, isPending: analyzing } = useAnalyzeImpact();
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('ontology-impact');

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

  // 클러스터가 바뀌면 이전 클러스터의 노드 상세·영향 분석 결과를 닫는다.
  useEffect(() => {
    setSelectedNode(null);
    setImpactResult(null);
  }, [clusterId]);

  // 캔버스 전용: 테마·강조색이 바뀌면 키가 달라진다 → 색 맵·nodeThreeObject·linkColor identity 가 바뀌어
  // ForceGraph3D 가 노드 객체를 다시 만들고 링크·배경을 다시 칠한다. DOM 색은 클래스라 이 키와 무관하다.
  const themeKey = useThemeColorKey();
  const colors = useMemo(() => { void themeKey; return entityColors(); }, [themeKey]);
  const canvasColors = useMemo(() => {
    void themeKey;
    return { background: cssVarColor('--background'), foreground: cssVarColor('--foreground') };
  }, [themeKey]);
  const nodeThreeObject = useCallback((n: NodeObject) => makeNodeObject(n, colors), [colors]);

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

  const handleAnalyzeImpact = useCallback(async (entityId: string) => {
    if (!clusterId) return;
    const name = selectedNode?.name ?? entityId;
    const typeLabel = selectedNode ? (ENTITY_LABEL[selectedNode.entityType] ?? selectedNode.entityType) : '';
    const clusterName = clusters.find((c) => c.id === clusterId)?.name ?? clusterId;
    const r = await runLogged(runLog, {
      title: '변경 영향 분석',
      first: `${clusterName} · ${name}${typeLabel ? ` (${typeLabel})` : ''} — 변경 영향 분석 요청(최대 깊이 ${IMPACT_MAX_DEPTH})`,
      fn: () => analyzeImpact({
        clusterId,
        configEntityId: entityId,
        category: 'config_change',
        severity: 'warning',
        title: `${name} 변경 영향 분석`,
        maxDepth: IMPACT_MAX_DEPTH,
      }),
      summarize: impactLines,
    });
    if (r.ok) setImpactResult(r.data);
  }, [clusterId, clusters, selectedNode, analyzeImpact, runLog]);

  const toggleType = (t: OntologyEntityType) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });
  };

  const nodeLabel = useCallback((n: NodeObject) => {
    const node = n as GNode;
    return `<div style="background:hsl(var(--popover));border:1px solid hsl(var(--border));padding:4px 8px;border-radius:4px;font-size:12px;color:hsl(var(--popover-foreground))">
      <b>${node.name}</b><br/><span style="opacity:.7">${ENTITY_LABEL[node.entityType] ?? node.entityType}</span>
      ${node.version ? `<br/><span style="opacity:.5">v${node.version}</span>` : ''}
    </div>`;
  }, []);

  const linkColor = useCallback((l: LinkObject) => {
    const link = l as GLink;
    // 가중치 0→1 을 불투명도 0.16→0.63 으로 (기존 hex alpha 40→160/255 와 같은 구간).
    // 링크마다 getComputedStyle 을 부르지 않도록 memo 한 전경색 hsl 에 alpha 만 붙인다.
    const alpha = Math.round(((40 + link.weight * 120) / 255) * 100) / 100;
    return canvasColors.foreground.replace(/^hsl\((.*)\)$/, `hsla($1, ${alpha})`);
  }, [canvasColors]);

  const isEmpty = !isLoading && graph && graph.entities.length === 0;

  return (
    <div className="app-h-screen bg-background flex overflow-hidden">
      {/* 클러스터 레일 (D-113) — 메인 사이드바에 flush, 좌측 패딩 없음 */}
      <div className="py-3 flex-shrink-0">
        <ClusterSidebar clusters={clusters} selectedId={clusterId || null} onSelect={selectCluster} iconOnly />
      </div>

      <div className="flex-1 min-w-0 flex flex-col">
        {/* 상단 툴바 */}
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-card flex-shrink-0 z-20">
          <PageHeader
            className="flex-1 items-center"
            icon={Share2}
            title="온톨로지 그래프"
            titleExtra={<>
              {/* 검색 */}
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="노드 검색..."
                  aria-label="노드 검색"
                  className="pl-7 pr-3 py-1 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-primary w-44"
                />
              </div>

              {/* 통계 */}
              {graph && (
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                  <span><b className="text-foreground">{graphData.nodes.length}</b>/{graph.entities.length} 노드</span>
                  <span><b className="text-foreground">{graphData.links.length}</b> 관계</span>
                </div>
              )}
            </>}
            actions={<>
              {/* 범례 토글 */}
              <button
                onClick={() => setShowLegend((v) => !v)}
                aria-pressed={showLegend}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-sm border transition-colors ${
                  showLegend ? 'bg-primary/10 border-primary/30 text-primary' : 'bg-secondary border-border text-muted-foreground'
                }`}
              >
                <Info className="w-3.5 h-3.5" />범례
              </button>

              {/* 필터 초기화 */}
              {activeTypes.size < ALL_TYPES.length && (
                <button
                  onClick={() => setActiveTypes(new Set(ALL_TYPES))}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-xl text-sm bg-secondary border border-border text-muted-foreground hover:text-foreground"
                >
                  <Filter className="w-3.5 h-3.5" />전체
                </button>
              )}

              {/* 새로고침 */}
              <button
                onClick={() => refetch()}
                disabled={isLoading}
                title="새로고침"
                aria-label="새로고침"
                className="p-1.5 hover:bg-secondary rounded-xl text-muted-foreground hover:text-foreground transition-colors"
              >
                <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
              </button>
            </>}
          />
        </div>

        {/* 타입 필터 바 */}
        <div className="flex items-center gap-1.5 px-4 py-2 bg-card border-b border-border/60 flex-shrink-0 overflow-x-auto">
          {ALL_TYPES.map((t) => {
            const active = activeTypes.has(t);
            const cls = ENTITY_CLASS[t];
            return (
              <button
                key={t}
                type="button"
                aria-pressed={active}
                onClick={() => toggleType(t)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-foreground border flex-shrink-0 transition-opacity ${cls.edge} ${
                  active ? `opacity-100 ${cls.tint}` : 'opacity-35 bg-transparent'
                }`}
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cls.dot}`} />
                {ENTITY_LABEL[t]}
              </button>
            );
          })}
        </div>

        {/* 영향 분석 실행 로그 — 캔버스를 가리지 않도록 툴바 아래 고정 영역 */}
        {(runLog.running || runLog.lines.length > 0) && (
          <div className="px-4 py-2 bg-card border-b border-border/60 flex-shrink-0">
            <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-40" />
          </div>
        )}

        {/* 3D 그래프 영역 */}
        <div ref={containerRef} className="flex-1 relative overflow-hidden">
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/70 z-10">
              <LoadingState />
            </div>
          )}

          {analyzing && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-card border border-border rounded-full px-4 py-2 text-sm text-muted-foreground shadow-card z-20">
              <Loader2 className="w-4 h-4 animate-spin" />영향 분석 중…
            </div>
          )}

          {isEmpty ? (
            <div className="flex items-center justify-center h-full">
              <EmptyState
                icon={Share2}
                title="이 클러스터에 온톨로지 데이터가 없습니다."
                description="API 로 엔티티와 관계를 먼저 등록하면 그래프가 그려집니다."
              >
                <code className="mt-3 px-3 py-1.5 bg-secondary rounded text-sm font-mono text-muted-foreground">
                  POST /api/v1/ontology/entities
                </code>
              </EmptyState>
            </div>
          ) : (
            <ForceGraph3D
              ref={graphRef as React.MutableRefObject<ForceGraph3DInstance>}
              graphData={graphData}
              width={dimensions.w}
              height={dimensions.h}
              backgroundColor={canvasColors.background}
              nodeId="id"
              nodeLabel={nodeLabel}
              nodeThreeObject={nodeThreeObject}
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
            <div className="absolute top-4 left-4 bg-card border border-border rounded-md px-4 py-3 space-y-1.5 z-10">
              <p className="text-xs font-medium text-muted-foreground mb-2">엔티티 타입</p>
              {ALL_TYPES.map((t) => (
                <div key={t} className="flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${ENTITY_CLASS[t].dot}`} />
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
              onAnalyzeImpact={(id) => { void handleAnalyzeImpact(id); }}
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
    </div>
  );
}
