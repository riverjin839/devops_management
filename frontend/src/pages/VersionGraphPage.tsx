import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import ForceGraph3D, { type ForceGraph3DInstance, type NodeObject, type LinkObject } from 'react-force-graph-3d';
import * as THREE from 'three';
import { Box, Maximize2, RefreshCw, Share2, Square, Table2, X } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { versionsApi, type VersionGraphNode, type VersionGraphEdge } from '@/services/api';
import { useClusters } from '@/hooks/useCluster';
import { useClusterRouteParam } from '@/hooks/useClusterRouteParam';
import { useCanOperate } from '@/hooks/useCanOperate';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import {
  useToast, SelectClusterEmptyState, LoadingState, EmptyState, ErrorState, PageHeader, RunLogPanel, ClusterSidebar,
} from '@/components/common';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { formatApiError, formatDateTime } from '@/lib/utils';
import { escapeHtml } from '@/lib/html';
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

// ── 표기(B-21) — 원문 값은 화면에 노출하지 않고 title 로만 남긴다 ─────────────
const TYPE_LABEL: Record<VersionGraphNode['type'], string> = {
  cluster:   '클러스터',
  category:  '분류',
  component: '컴포넌트',
  flag:      '설정 플래그',
};

const CATEGORY_LABEL: Record<string, string> = {
  control_plane: '컨트롤 플레인',
  cni:           'CNI',
  kubelet:       'kubelet',
  other:         '기타',
};
const categoryLabel = (c: string | undefined) => (c ? CATEGORY_LABEL[c] ?? c : '');

// 그래프에 그리는 플래그 leaf 상한 — 서버 `_GRAPH_FLAG_LIMIT` 와 같다(정책 ⑪).
const FLAG_LIMIT = 6;

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
  flagTotal?: number;
}

interface GLink extends LinkObject {
  source: string;
  target: string;
  type: VersionGraphEdge['type'];
}

/** 화면 표기 이름 — 분류 노드는 원문 키(`control_plane`) 대신 한국어 라벨. */
const displayLabel = (n: Pick<GNode, 'type' | 'label'>) => (n.type === 'category' ? categoryLabel(n.label) : n.label);

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

function NodeDetail({ node, shownFlags, onClose }: { node: GNode; shownFlags: number; onClose: () => void }) {
  const total = node.flagTotal ?? 0;
  return (
    <div className="absolute top-4 right-4 w-80 bg-card border border-border rounded-md shadow-2xl overflow-hidden z-10">
      <div className={`flex items-center justify-between px-4 py-3 border-b border-border border-l-4 ${NODE_CLASS[node.type]?.border ?? 'border-l-chart-8'}`}>
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground" title={node.type}>
            {TYPE_LABEL[node.type] ?? node.type}
          </p>
          <p className="text-sm font-bold text-foreground truncate" title={node.label}>{displayLabel(node)}</p>
        </div>
        <button type="button" onClick={onClose} title="노드 상세 닫기" aria-label="노드 상세 닫기"
          className="p-1 hover:bg-secondary rounded-xl text-muted-foreground flex-shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <X className="w-4 h-4" aria-hidden />
        </button>
      </div>
      <div className="px-4 py-3 space-y-3 max-h-[420px] overflow-y-auto text-sm">
        {node.version && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-0.5">버전</p>
            <p className="font-mono text-foreground break-all">{node.version}</p>
          </div>
        )}
        {node.value && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-0.5">값</p>
            <p className="font-mono text-foreground break-all">{node.value}</p>
          </div>
        )}
        {node.category && node.type !== 'cluster' && node.type !== 'category' && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-0.5">분류</p>
            <p className="text-foreground" title={node.category}>{categoryLabel(node.category)}</p>
          </div>
        )}
        {node.collectedAt && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-0.5">수집 시각</p>
            <p className="text-foreground text-xs tabular-nums" title={node.collectedAt}>{formatDateTime(node.collectedAt)}</p>
          </div>
        )}
        {node.type === 'component' && total > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-0.5">설정 플래그</p>
            {total > shownFlags ? (
              <p className="text-xs text-foreground">
                플래그 {shownFlags}/{total} —{' '}
                <Link to="/versions" className="text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl">
                  전체는 버전 화면
                </Link>
              </p>
            ) : (
              <p className="text-xs text-foreground">플래그 {total}개 (그래프에 모두 표시)</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── 표 보기 — 3D(WebGL)의 키보드·스크린리더 대체 뷰(D-092, B-9) ─────────────

function ComponentTable({ nodes, shownFlagsOf, selectedId, onSelect, panelOpen }: {
  nodes: GNode[];
  shownFlagsOf: (id: string) => number;
  selectedId: string | null;
  onSelect: (n: GNode | null) => void;
  panelOpen: boolean;
}) {
  const rows = useMemo(
    () => [...nodes].sort((a, b) =>
      categoryLabel(a.category).localeCompare(categoryLabel(b.category)) || a.label.localeCompare(b.label)),
    [nodes],
  );
  const th = 'px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap';
  const td = 'px-2 py-1.5 align-top';
  return (
    <div className={`absolute inset-0 overflow-auto p-3 ${panelOpen ? 'pr-[21.5rem]' : ''}`}>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-xs">
          <caption className="sr-only">컴포넌트 {rows.length}개 — 이름을 누르면 상세가 열린다</caption>
          <thead className="bg-muted/40">
            <tr>
              <th scope="col" className={th}>분류</th>
              <th scope="col" className={th}>컴포넌트</th>
              <th scope="col" className={th}>버전</th>
              <th scope="col" className={`${th} text-right`}>플래그</th>
              <th scope="col" className={th}>수집 시각</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((n) => {
              const active = selectedId === n.id;
              const label = active ? `${n.label} 상세 닫기` : `${n.label} 상세 보기`;
              const total = n.flagTotal ?? 0;
              const shown = shownFlagsOf(n.id);
              return (
                <tr key={n.id} className={active ? 'bg-primary/10' : 'hover:bg-muted/30'}>
                  <td className={`${td} whitespace-nowrap text-muted-foreground`} title={n.category}>{categoryLabel(n.category)}</td>
                  <td className={td}>
                    <button type="button" onClick={() => onSelect(active ? null : n)} aria-pressed={active}
                      aria-label={label} title={label}
                      className="text-left font-mono font-medium text-foreground hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-xl px-0.5 break-all">
                      {n.label}
                    </button>
                  </td>
                  <td className={`${td} font-mono break-all`}>{n.version || '—'}</td>
                  <td className={`${td} text-right tabular-nums`}>
                    {total === 0 ? '—' : total > shown ? `${shown}/${total}` : total}
                  </td>
                  <td className={`${td} whitespace-nowrap tabular-nums text-muted-foreground`} title={n.collectedAt}>
                    {n.collectedAt ? formatDateTime(n.collectedAt) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── 메인 페이지 ──────────────────────────────────────────────────────────────

export function VersionGraphPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const clustersQ = useClusters();
  const clustersData = clustersQ.data;
  const clusters = useMemo(() => clustersData ?? [], [clustersData]);
  // 선택은 URL(/versions/:id/graph)이 원천 — 레일에서 바꾸면 경로가 바뀌어 화면과 URL 이 어긋나지 않는다.
  const { clusterId: selectedId, selectCluster } = useClusterRouteParam('/versions', clusters, { pathFor: graphPath });
  const { canOperate, withHint, ariaWithHint } = useCanOperate(selectedId || null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['versions', 'graph', selectedId],
    queryFn: () => versionsApi.graph(selectedId).then((r) => r.data),
    enabled: !!selectedId,
  });

  const graphRef = useRef<ForceGraph3DInstance>();
  const containerRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const [dims, setDims] = useState({ w: 800, h: 600 });
  const [selectedNode, setSelectedNode] = useState<GNode | null>(null);
  const [view, setView] = useState<'3d' | 'table'>('3d');
  // OS "동작 줄이기"면 카메라 이동·화면 맞춤을 즉시(0ms) 처리한다(D-096).
  const reducedMotion = usePrefersReducedMotion();

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

  // 끝점이 노드 집합에 없는 링크는 그리기 전에 버린다(B-10 방어) — d3 force 가 "node not found" 를 던진다.
  const graphData = useMemo(() => {
    const nodes = (data?.nodes ?? []).map((n) => ({ ...n })) as GNode[];
    const ids = new Set(nodes.map((n) => n.id));
    const links = (data?.edges ?? [])
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, type: e.type })) as GLink[];
    return { nodes, links };
  }, [data]);

  const componentNodes = useMemo(() => graphData.nodes.filter((n) => n.type === 'component'), [graphData]);
  const flagLeafCount = useMemo(() => graphData.nodes.filter((n) => n.type === 'flag').length, [graphData]);
  // 컴포넌트별로 그래프에 실제 그린 플래그 수 — param 엣지 수(서버 상한 FLAG_LIMIT).
  const shownFlags = useMemo(() => {
    const m: Record<string, number> = {};
    for (const l of graphData.links) if (l.type === 'param') m[l.source] = (m[l.source] ?? 0) + 1;
    return m;
  }, [graphData]);
  const shownFlagsOf = useCallback((id: string) => shownFlags[id] ?? 0, [shownFlags]);

  const linkColor = useCallback((l: LinkObject) => {
    const link = l as GLink;
    return edgeColors[link.type] ?? edgeColors.contains;
  }, [edgeColors]);

  // force-graph 툴팁은 문자열을 HTML 로 넣는다 — 클러스터 이름·파드 인자는 사용자/외부 값이라 전부 이스케이프(B-3).
  const nodeLabel = useCallback((n: NodeObject) => {
    const node = n as GNode;
    const typeText = TYPE_LABEL[node.type] ?? node.type;
    return `<div style="background:hsl(var(--popover));border:1px solid hsl(var(--border));padding:4px 8px;border-radius:4px;font-size:12px;color:hsl(var(--popover-foreground));font-family:ui-monospace,monospace">
      <span style="opacity:.7">${escapeHtml(typeText)}</span><br/>
      <b>${escapeHtml(displayLabel(node))}</b>
      ${node.version ? `<br/><span style="opacity:.7">${escapeHtml(node.version)}</span>` : ''}
    </div>`;
  }, []);

  const handleNodeClick = useCallback((nodeObj: NodeObject) => {
    const n = nodeObj as GNode;
    setSelectedNode(n);
    if (graphRef.current && n.x !== undefined) {
      graphRef.current.cameraPosition(
        { x: n.x! + 40, y: n.y! + 30, z: n.z! + 60 },
        { x: n.x!, y: n.y!, z: n.z! },
        reducedMotion ? 0 : 800,
      );
    }
  }, [reducedMotion]);

  const zoomToFit = () => graphRef.current?.zoomToFit(reducedMotion ? 0 : 400);

  // 실행 로그(D-135) — 재수집/지금 수집을 요청·대기·컴포넌트별 결과·경고 줄로 남긴다(응답 errors[] 도 버리지 않는다).
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('version-graph-collect');
  const abortRef = useRef<AbortController | null>(null);
  // 화면을 떠나면 진행 중인 수집 요청을 끊는다(최대 5분 대기 방지).
  useEffect(() => () => abortRef.current?.abort(), []);

  const collectAndRefresh = async () => {
    if (!selectedId || runLog.running || !canOperate) return;
    const name = clusters.find((c) => c.id === selectedId)?.name ?? selectedId;
    const ac = new AbortController();
    abortRef.current = ac;
    const r = await runLogged(runLog, {
      title: '버전 재수집',
      first: `${name} — kubeconfig 로 컴포넌트 버전·플래그 수집 요청`,
      fn: () => versionsApi.collect(selectedId, ac.signal).then((res) => res.data),
      summarize: (d) => {
        const out: RunLogEntry[] = (d.components ?? []).map((c): RunLogEntry => [
          'info',
          `${c.component} — ${c.version ?? '버전 정보 없음'} · ${c.changed ? '변경 저장' : '변경 없음'}`,
        ]);
        for (const e of d.errors) out.push(['warn', `경고 — ${e}`]);
        const n = d.components?.length;
        out.push([
          d.errors.length > 0 ? 'warn' : 'info',
          `완료 — ${n !== undefined ? `컴포넌트 ${n}개 · ` : ''}변경 ${d.changed}건 · 경고 ${d.errors.length}건 · 그래프 새로고침`,
        ]);
        return out;
      },
    });
    if (abortRef.current === ac) abortRef.current = null;
    if (r.ok) {
      queryClient.invalidateQueries({ queryKey: ['versions'] });
      if (r.data.errors.length > 0) toast.warning(`수집됨 · 경고 ${r.data.errors.length}건`, '상세는 실행 로그 참조');
      else toast.success('수집됨');
    } else if (!r.aborted) {
      toast.error('수집 실패', formatApiError(r.error));
    }
  };

  const stopCollect = () => abortRef.current?.abort();

  const centered = (child: React.ReactNode) => (
    <div className="absolute inset-0 flex items-center justify-center p-4">{child}</div>
  );

  const toolbarBtn = 'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-xl border border-border bg-card text-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  let body: React.ReactNode;
  if (clustersQ.isError && clusters.length === 0) {
    body = centered(<ErrorState error={clustersQ.error} title="클러스터 목록을 불러오지 못했습니다" onRetry={() => clustersQ.refetch()} />);
  } else if (!selectedId) {
    body = centered(<SelectClusterEmptyState />);
  } else if (isLoading) {
    body = centered(<LoadingState />);
  } else if (isError) {
    body = centered(<ErrorState error={error} title="버전 그래프를 불러오지 못했습니다" onRetry={() => refetch()} />);
  } else if (componentNodes.length === 0) {
    // 서버는 루트 클러스터 노드를 항상 넣는다 — 컴포넌트가 0개면 수집 이력이 없는 것(B-8).
    body = centered(
      <EmptyState
        icon={Share2}
        title="수집 이력이 없습니다 — 재수집으로 컴포넌트 버전을 모읍니다"
        description="kubeconfig 로 API server·노드·kube-system 컴포넌트의 버전과 플래그를 수집하면 관계 그래프가 그려집니다."
        action={canOperate ? { label: '지금 수집', onClick: collectAndRefresh } : undefined}
      />,
    );
  } else if (view === 'table') {
    body = (
      <ComponentTable
        nodes={componentNodes}
        shownFlagsOf={shownFlagsOf}
        selectedId={selectedNode?.id ?? null}
        onSelect={setSelectedNode}
        panelOpen={!!selectedNode}
      />
    );
  } else {
    // WebGL 캔버스는 보조기기에 내용이 없다 — 요약·조작법을 그룹 라벨로 주고, 표 보기·화면 맞춤을
    // 실제 <button> 으로 둔다(D-092 방식, B-9).
    body = (
      <div role="group" className="absolute inset-0"
        aria-label={`버전 그래프 — 컴포넌트 ${componentNodes.length}개, 플래그 ${flagLeafCount}개`}
        aria-describedby={hintId}>
        <p id={hintId} className="sr-only">
          3D 보기는 마우스로만 조작할 수 있다(드래그 회전, 휠 확대, 노드 클릭 선택). 키보드나 스크린리더로는 툴바의 표로 보기를 쓴다.
        </p>
        <div className="absolute top-3 left-3 z-10 flex items-center gap-1.5">
          <button type="button" onClick={zoomToFit} title="화면 맞춤" aria-label="화면 맞춤" className={toolbarBtn}>
            <Maximize2 className="w-3.5 h-3.5" aria-hidden /> 화면 맞춤
          </button>
          <span aria-hidden className="hidden sm:inline text-xs text-muted-foreground bg-card rounded-xl px-2 py-0.5">
            드래그 회전 · 휠 확대 · 클릭 선택
          </span>
        </div>
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
      </div>
    );
  }

  const graphReady = !!selectedId && !isLoading && !isError && componentNodes.length > 0;

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
            back={{ to: selectedId ? `/k8s/${selectedId}/versions` : '/versions', label: '버전' }}
            icon={Share2}
            title="컴포넌트 관계 그래프"
            actions={<>
              <div className="flex items-center gap-1 text-xs text-muted-foreground flex-wrap" aria-label="범례">
                {(Object.entries(NODE_CLASS) as Array<[VersionGraphNode['type'], { dot: string }]>).map(([k, v]) => (
                  <span key={k} className="inline-flex items-center gap-1" title={k}>
                    <span aria-hidden className={`w-2 h-2 rounded-full ${v.dot}`} />
                    {TYPE_LABEL[k]}
                  </span>
                ))}
                <span className="ml-1">· 플래그는 컴포넌트당 {FLAG_LIMIT}개까지</span>
              </div>
              {graphReady && (
                <button
                  type="button"
                  onClick={() => setView((v) => (v === '3d' ? 'table' : '3d'))}
                  aria-pressed={view === 'table'}
                  title={view === '3d' ? '컴포넌트를 표로 보기 — 키보드·스크린리더용 대체 보기' : '3D 그래프로 보기'}
                  className={toolbarBtn}
                >
                  {view === '3d'
                    ? <><Table2 className="w-3.5 h-3.5" aria-hidden /> 표로 보기</>
                    : <><Box className="w-3.5 h-3.5" aria-hidden /> 3D로 보기</>}
                </button>
              )}
              <button
                type="button"
                onClick={collectAndRefresh}
                disabled={!selectedId || runLog.running || !canOperate}
                title={withHint('kubeconfig 로 컴포넌트 버전·플래그 재수집')}
                aria-label={ariaWithHint('재수집')}
                className="flex items-center gap-1 px-2 py-1 text-sm bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 rounded-xl transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${runLog.running ? 'animate-spin' : ''}`} aria-hidden />
                {runLog.running ? '수집 중' : '재수집'}
              </button>
            </>}
          />
        </div>

        {/* 실행 로그 — 툴바 아래 별도 줄(캔버스를 덮지 않고 그만큼 캔버스 높이가 줄어든다). 실행 전엔 렌더되지 않는다. */}
        {(runLog.running || runLog.lines.length > 0) && (
          <div className="flex-shrink-0 px-4 py-2 border-b border-border bg-card">
            <RunLogPanel
              run={runLog}
              show={showLog}
              onShowChange={setShowLog}
              maxHeight="max-h-40"
              actions={runLog.running ? (
                <button
                  type="button"
                  onClick={stopCollect}
                  title="수집 중지"
                  aria-label="수집 중지"
                  className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-xl border border-border bg-background hover:bg-secondary"
                >
                  <Square className="w-3 h-3 fill-current" aria-hidden /> 중지
                </button>
              ) : undefined}
            />
          </div>
        )}

        {/* 그래프 / 표 */}
        <div ref={containerRef} className="flex-1 relative">
          {body}

          {graphReady && selectedNode && (
            <NodeDetail
              node={selectedNode}
              shownFlags={shownFlagsOf(selectedNode.id)}
              onClose={() => setSelectedNode(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
