import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph3D, { type ForceGraph3DInstance, type NodeObject, type LinkObject } from 'react-force-graph-3d';
import * as THREE from 'three';
import { RefreshCw, Share2, X } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { versionsApi, type VersionGraphNode, type VersionGraphEdge } from '@/services/api';
import { useClusters } from '@/hooks/useCluster';
import { useClusterRouteParam } from '@/hooks/useClusterRouteParam';
import { useToast, SelectClusterEmptyState, LoadingState, EmptyState, PageHeader, RunLogPanel, ClusterSidebar } from '@/components/common';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { formatApiError } from '@/lib/utils';
import { cssVarColor, useThemeColorKey } from '@/lib/chartTokens';

// 클러스터 id 가 경로 가운데 오는 라우트 — 모듈 스코프(렌더마다 새 함수면 라우트 훅 effect 가 매번 돈다).
const graphPath = (id: string) => `/versions/${id}/graph`;

// ── 타입별 색상 (D-005·D-120: 차트 토큰 체계) ───────────────────────────────
// three.js(WebGL) 는 CSS var() 를 해석하지 못하므로 토큰명을 들고 있다가 cssVarColor 로
// 현재 테마 값을 hsl 문자열로 읽어 쓴다. DOM(범례 점·상세 패널 테두리)은 클래스로 칠한다.

const NODE_TOKEN: Record<VersionGraphNode['type'], string> = {
  cluster:   '--chart-1', // blue
  category:  '--chart-4', // violet
  component: '--chart-2', // teal/green
  flag:      '--chart-3', // amber
};

const NODE_CLASS: Record<VersionGraphNode['type'], { dot: string; border: string }> = {
  cluster:   { dot: 'bg-chart-1', border: 'border-l-chart-1' },
  category:  { dot: 'bg-chart-4', border: 'border-l-chart-4' },
  component: { dot: 'bg-chart-2', border: 'border-l-chart-2' },
  flag:      { dot: 'bg-chart-3', border: 'border-l-chart-3' },
};

const NODE_SIZE: Record<VersionGraphNode['type'], number> = {
  cluster:   14,
  category:  10,
  component: 7,
  flag:      3.5,
};

// 링크 색 — 토큰 + alpha. ForceGraph3D 는 hsla 문자열을 파싱한다(tinycolor).
// 교체(replaces)는 의미가 "구버전 대체" 경고라 status-critical, 나머지는 분류색.
const EDGE_TOKEN: Record<VersionGraphEdge['type'], { token: string; alpha: number }> = {
  contains:   { token: '--foreground',      alpha: 0.33 },
  param:      { token: '--chart-3',         alpha: 0.4 },
  configures: { token: '--chart-2',         alpha: 0.4 },
  replaces:   { token: '--status-critical', alpha: 0.53 },
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

function makeNodeObject(node: NodeObject, colors: Record<VersionGraphNode['type'], string>): THREE.Mesh {
  const n = node as GNode;
  const size = NODE_SIZE[n.type] ?? 5;
  const color = colors[n.type] ?? cssVarColor('--chart-8');
  const geo = new THREE.SphereGeometry(size, 16, 16);
  const mat = new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.92 });
  return new THREE.Mesh(geo, mat);
}

// ── Node detail panel ──────────────────────────────────────────────────────

function NodeDetail({ node, onClose }: { node: GNode; onClose: () => void }) {
  return (
    <div className="absolute top-4 right-4 w-80 bg-card border border-border rounded-md shadow-2xl overflow-hidden z-10">
      <div className={`flex items-center justify-between px-4 py-3 border-b border-border border-l-4 ${NODE_CLASS[node.type]?.border ?? 'border-l-chart-8'}`}>
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">
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
            <p className="text-xs font-medium text-muted-foreground mb-0.5">버전</p>
            <p className="font-mono text-foreground">{node.version}</p>
          </div>
        )}
        {node.value && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-0.5">값</p>
            <p className="font-mono text-foreground break-all">{node.value}</p>
          </div>
        )}
        {node.category && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-0.5">카테고리</p>
            <p className="font-mono text-foreground">{node.category}</p>
          </div>
        )}
        {node.collectedAt && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-0.5">수집 시각</p>
            <p className="font-mono text-foreground text-xs">{node.collectedAt}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 메인 페이지 ──────────────────────────────────────────────────────────────

export function VersionGraphPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: clustersData } = useClusters();
  const clusters = useMemo(() => clustersData ?? [], [clustersData]);
  // 선택은 URL(/versions/:id/graph)이 원천 — 레일에서 바꾸면 경로가 바뀌어 화면과 URL 이 어긋나지 않는다.
  const { clusterId: selectedId, selectCluster } = useClusterRouteParam('/versions', clusters, { pathFor: graphPath });

  const { data, isLoading } = useQuery({
    queryKey: ['versions', 'graph', selectedId],
    queryFn: () => versionsApi.graph(selectedId).then((r) => r.data),
    enabled: !!selectedId,
  });

  const graphRef = useRef<ForceGraph3DInstance>();
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 800, h: 600 });
  const [selectedNode, setSelectedNode] = useState<GNode | null>(null);

  // 클러스터가 바뀌면 이전 클러스터의 노드 상세를 닫는다.
  useEffect(() => { setSelectedNode(null); }, [selectedId]);

  // 테마·강조색이 바뀌면 키가 달라진다 → 색 맵·nodeThreeObject·linkColor identity 가 바뀌어
  // ForceGraph3D 가 노드 객체를 다시 만들고 링크를 다시 칠한다.
  const themeKey = useThemeColorKey();
  const nodeColors = useMemo(() => {
    void themeKey;
    return Object.fromEntries(
      (Object.entries(NODE_TOKEN) as Array<[VersionGraphNode['type'], string]>).map(([k, t]) => [k, cssVarColor(t)]),
    ) as Record<VersionGraphNode['type'], string>;
  }, [themeKey]);
  const edgeColors = useMemo(() => {
    void themeKey;
    return Object.fromEntries(
      (Object.entries(EDGE_TOKEN) as Array<[VersionGraphEdge['type'], { token: string; alpha: number }]>)
        .map(([k, v]) => [k, cssVarColor(v.token, { alpha: v.alpha })]),
    ) as Record<VersionGraphEdge['type'], string>;
  }, [themeKey]);
  const nodeThreeObject = useCallback((n: NodeObject) => makeNodeObject(n, nodeColors), [nodeColors]);

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
    return edgeColors[link.type] ?? edgeColors.contains;
  }, [edgeColors]);

  const nodeLabel = useCallback((n: NodeObject) => {
    const node = n as GNode;
    return `<div style="background:hsl(var(--popover));border:1px solid hsl(var(--border));padding:4px 8px;border-radius:4px;font-size:12px;color:hsl(var(--popover-foreground));font-family:ui-monospace,monospace">
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

  // 실행 로그(D-135) — 재수집/지금 수집을 요청·대기·응답 요약·경고 줄로 남긴다(응답 errors[] 도 버리지 않는다).
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('version-graph-collect');

  const collectAndRefresh = async () => {
    if (!selectedId || runLog.running) return;
    const name = clusters.find((c) => c.id === selectedId)?.name ?? selectedId;
    const r = await runLogged(runLog, {
      title: '버전 재수집',
      first: `${name} — kubeconfig 로 컴포넌트 버전·플래그 수집 요청`,
      fn: () => versionsApi.collect(selectedId).then((res) => res.data),
      summarize: (d) => {
        const out: RunLogEntry[] = d.errors.map((e): RunLogEntry => ['warn', `경고 — ${e}`]);
        out.push([d.errors.length > 0 ? 'warn' : 'info', `완료 — 변경 ${d.changed}건 · 경고 ${d.errors.length}건 · 그래프 새로고침`]);
        return out;
      },
    });
    if (r.ok) {
      queryClient.invalidateQueries({ queryKey: ['versions'] });
      if (r.data.errors.length > 0) toast.warning(`수집됨 · 경고 ${r.data.errors.length}건`, '상세는 실행 로그 참조');
      else toast.success('수집됨');
    } else if (!r.aborted) {
      toast.error('수집 실패', formatApiError(r.error));
    }
  };

  return (
    <div className="app-h-screen bg-background flex overflow-hidden">
      {/* 클러스터 레일 (D-113) — 메인 사이드바에 flush, 좌측 패딩 없음 */}
      <div className="py-3 flex-shrink-0">
        <ClusterSidebar clusters={clusters} selectedId={selectedId || null} onSelect={selectCluster} iconOnly />
      </div>

      <div className="flex-1 min-w-0 flex flex-col">
        {/* 툴바 */}
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-card flex-shrink-0 z-20">
          <PageHeader
            className="flex-1 items-center"
            back={{ to: '/versions', label: '버전' }}
            icon={Share2}
            title="컴포넌트 관계 그래프"
            actions={<>
              <div className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap">
                {(Object.entries(NODE_CLASS) as Array<[VersionGraphNode['type'], { dot: string }]>).map(([k, v]) => (
                  <span key={k} className="inline-flex items-center gap-1">
                    <span className={`w-2 h-2 rounded-full ${v.dot}`} />
                    {k}
                  </span>
                ))}
              </div>
              <button
                onClick={collectAndRefresh}
                disabled={!selectedId || runLog.running}
                className="flex items-center gap-1 px-2 py-1 text-sm bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 rounded-xl transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${runLog.running ? 'animate-spin' : ''}`} />
                {runLog.running ? '수집 중' : '재수집'}
              </button>
            </>}
          />
        </div>

        {/* 실행 로그 — 툴바 아래 별도 줄(캔버스를 덮지 않고 그만큼 캔버스 높이가 줄어든다). 실행 전엔 렌더되지 않는다. */}
        {(runLog.running || runLog.lines.length > 0) && (
          <div className="flex-shrink-0 px-4 py-2 border-b border-border bg-card">
            <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-40" />
          </div>
        )}

        {/* 그래프 */}
        <div ref={containerRef} className="flex-1 relative">
          {!selectedId ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <SelectClusterEmptyState />
            </div>
          ) : isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <LoadingState />
            </div>
          ) : graphData.nodes.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <EmptyState
                icon={Share2}
                title="아직 수집된 스냅샷이 없습니다."
                description="이 클러스터의 컴포넌트 버전을 수집하면 관계 그래프가 그려집니다."
                action={{ label: '지금 수집', onClick: collectAndRefresh }}
              />
            </div>
          ) : (
            <ForceGraph3D
              ref={graphRef}
              graphData={graphData}
              width={dims.w}
              height={dims.h}
              backgroundColor="rgba(0,0,0,0)"
              nodeThreeObject={nodeThreeObject}
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
    </div>
  );
}
