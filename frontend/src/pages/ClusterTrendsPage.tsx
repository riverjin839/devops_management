import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  TrendingUp, ArrowUp, ArrowDown, ChevronsUpDown, AlertTriangle, RefreshCw, Info,
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import {
  EmptyState, ErrorState, LoadingState, SelectClusterEmptyState, PageShell,
} from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { MacCard } from '@/components/ui/MacCard';
import { NodeMultiSelect } from '@/components/k8s/NodeMultiSelect';
import { useClusters } from '@/hooks/useCluster';
import { useClusterTrends } from '@/hooks/useClusterTrends';
import { useUrlParams, pickParam } from '@/hooks/useUrlParams';
import { CHART_TOOLTIP_PROPS, chartAxisTick } from '@/lib/chartTokens';
import { formatApiError } from '@/lib/utils';
import type { TrendMetricKey, TrendRange, TrendMetricBlock } from '@/types';

// D-191: 시간창·지표 라벨은 한국어 표준어. 질의 키(30m·cpu …)는 URL·API 값으로만 쓴다.
const RANGES: { key: TrendRange; label: string }[] = [
  { key: '30m', label: '30분' },
  { key: '1h', label: '1시간' },
  { key: '6h', label: '6시간' },
  { key: '24h', label: '24시간' },
  { key: '7d', label: '7일' },
];
const RANGE_KEYS = RANGES.map((r) => r.key);

const METRICS: { key: TrendMetricKey; label: string }[] = [
  { key: 'cpu', label: 'CPU' },
  { key: 'memory', label: '메모리' },
  { key: 'disk', label: '디스크' },
  { key: 'diskio', label: '디스크 I/O' },
  { key: 'network', label: '네트워크' },
  { key: 'networkerr', label: '네트워크 오류' },
];
const METRIC_KEYS = METRICS.map((m) => m.key);
const METRIC_LABEL: Record<TrendMetricKey, string> = Object.fromEntries(
  METRICS.map((m) => [m.key, m.label]),
) as Record<TrendMetricKey, string>;

// 지표별 라인 색 — 종류 구분은 --chart-N 만 쓴다(D-190 ②: 네트워크 오류도 상태색으로 칠하지 않는다.
// 오류율 0 은 중립이고, 최신값 > 0 일 때만 값 글자를 status-critical 로 둔다).
const METRIC_COLOR: Record<TrendMetricKey, string> = {
  cpu: 'hsl(var(--chart-6))',
  memory: 'hsl(var(--chart-2))',
  disk: 'hsl(var(--chart-3))',
  diskio: 'hsl(var(--chart-4))',
  network: 'hsl(var(--chart-1))',
  networkerr: 'hsl(var(--chart-5))',
};

// D-190 ①: 열 수는 정적 클래스 맵(인라인 gridTemplateColumns 제거).
const COLS = ['1', '5', '10', '20'] as const;
type ColsKey = (typeof COLS)[number];
const COLS_CLASS: Record<ColsKey, string> = {
  '1': 'grid-cols-1',
  '5': 'grid-cols-5',
  '10': 'grid-cols-10',
  '20': 'grid-cols-[repeat(20,minmax(0,1fr))]',
};

/** 서버 응답에 `max_nodes` 가 없을 때(구버전 서버)만 쓰는 폴백 — 원천은 서버 `trends_max_nodes`(D-185 ③). */
const DEFAULT_MAX_NODES = 30;
/** 자동 갱신 주기 — 30분·1시간 창은 기본 켬, 6시간 이상은 기본 끔(D-184 ⑤, 정책 결정 ④). */
const AUTO_REFRESH_MS = 60_000;
const AUTO_DEFAULT_RANGES: readonly TrendRange[] = ['30m', '1h'];

/** 클러스터 정보 수정 화면의 Prometheus 토글 이름 — 안내 문구에 그대로 쓴다(D-185). */
const PROM_TOGGLE_GUIDE =
  "클러스터 정보 수정 → '메트릭 추이 (Prometheus)' 의 '이 클러스터에서 클러스터 추이(Prometheus) 사용' 토글과 Prometheus URL 을 확인하세요.";

type SortKey = 'name' | 'latest';
type SortDir = 'asc' | 'desc';

function fmtVal(v: number | null, unit: string): string {
  if (v == null) return '—';
  if (unit === 'B/s') {
    const u = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let n = v, i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(1)} ${u[i]}`;
  }
  if (unit === '%') return `${v.toFixed(1)}%`;
  return `${v.toFixed(2)} ${unit}`;
}

function fmtTime(t: number, range: TrendRange): string {
  const d = new Date(t * 1000);
  if (range === '7d' || range === '24h') {
    return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

interface Cell {
  node: string;
  metric: TrendMetricKey;
  unit: string;
  latest: number | null;
  min: number | null;
  max: number | null;
  /** 지표 질의 실패 사유 — 있으면 "조회 실패"(데이터 없음과 구분, D-184 ④). */
  error: string | null;
  data: { t: number; v: number | null }[];
}

function parseMetrics(raw: string): Set<TrendMetricKey> {
  const keys = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return new Set(METRIC_KEYS.filter((k) => keys.includes(k)));
}

export function ClusterTrendsPage() {
  const { clusterId = '' } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const clustersQ = useClusters();
  const { data: clusters = [] } = clustersQ;

  // D-190 ⑨: 시간창·지표·열 수는 URL 쿼리(새로고침·링크 공유 유지).
  const [url, setUrl] = useUrlParams({ range: '1h', metrics: 'cpu,memory', cols: '5' });
  const range = pickParam(url.range, RANGE_KEYS, '1h');
  const cols = pickParam(url.cols, COLS, '5');
  const metrics = useMemo(() => parseMetrics(url.metrics), [url.metrics]);

  // D-184 ①: 선택 노드는 클러스터별로 따로 둔다 — 클러스터를 바꾸면 이전 클러스터 노드명으로
  // 질의하지 않고, 다시 돌아오면 그 클러스터에서 마지막으로 고른 노드가 그대로 있다.
  const [nodesByCluster, setNodesByCluster] = useState<Record<string, string[]>>({});
  const nodes = useMemo(() => new Set(nodesByCluster[clusterId] ?? []), [nodesByCluster, clusterId]);
  const setNodes = (next: Set<string>) =>
    setNodesByCluster((prev) => ({ ...prev, [clusterId]: Array.from(next) }));

  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // D-184 ⑤: 자동 갱신 — 시간창 기본값(30분·1시간 켬, 6시간 이상 끔)에 사용자가 덮어쓴 값.
  // 시간창을 바꾸면 그 창의 기본값으로 돌아간다. 탭이 숨겨지면 훅이 멈춘다.
  const [autoOverride, setAutoOverride] = useState<{ range: TrendRange; on: boolean } | null>(null);
  const auto = autoOverride?.range === range ? autoOverride.on : AUTO_DEFAULT_RANGES.includes(range);

  const metricList = useMemo(() => METRIC_KEYS.filter((k) => metrics.has(k)), [metrics]);
  const nodeList = useMemo(() => Array.from(nodes), [nodes]);
  const noSelection = nodeList.length === 0 || metricList.length === 0;

  const query = useClusterTrends(
    clusterId,
    { range, metrics: metricList, nodes: nodeList },
    auto ? AUTO_REFRESH_MS : 0,
  );
  const resp = query.data;
  const maxNodes = resp?.maxNodes ?? DEFAULT_MAX_NODES;
  const nodeLabel = resp?.nodeLabel || null;
  const editPath = `/cluster-manage/${clusterId}/edit`;

  // (노드 × 지표) 셀 평탄화 + 정렬.
  const cells = useMemo<Cell[]>(() => {
    if (!resp) return [];
    const out: Cell[] = [];
    for (const m of metricList) {
      const block: TrendMetricBlock | undefined = resp.metrics[m];
      if (!block) continue;
      const byNode = new Map(block.series.map((s) => [s.node, s]));
      for (const node of nodeList) {
        const s = byNode.get(node);
        const pts = (s?.points ?? []).map((p) => ({ t: p.t, v: p.v }));
        const defined = pts.map((p) => p.v).filter((v): v is number => v != null);
        out.push({
          node,
          metric: m,
          unit: block.unit,
          latest: defined.length ? defined[defined.length - 1] : null,
          min: defined.length ? Math.min(...defined) : null,
          max: defined.length ? Math.max(...defined) : null,
          error: block.error || null,
          data: pts,
        });
      }
    }
    const mul = sortDir === 'asc' ? 1 : -1;
    out.sort((a, b) => {
      if (sortKey === 'latest') {
        const av = a.latest ?? -Infinity, bv = b.latest ?? -Infinity;
        if (av !== bv) return (av - bv) * mul;
      }
      const c = a.node.localeCompare(b.node);
      if (c !== 0) return c * mul;
      return a.metric.localeCompare(b.metric);
    });
    return out;
  }, [resp, metricList, nodeList, sortKey, sortDir]);

  const failedMetrics = useMemo(
    () => (resp ? metricList.filter((m) => resp.metrics[m]?.error) : []),
    [resp, metricList],
  );
  // 서버 hint 가 없을 때(구버전 서버) 시리즈가 전부 비면 같은 원인 안내를 화면이 만든다(D-185).
  const allEmpty = cells.length > 0 && cells.every((c) => !c.error && c.data.length === 0);
  const hint = resp && resp.status !== 'offline'
    ? resp.hint || (allEmpty && resp.status === 'ok'
      ? `선택한 노드의 시리즈가 없습니다 — Prometheus 시리즈의 노드 라벨${nodeLabel ? ` '${nodeLabel}'` : ''}이 K8s 노드 이름과 맞지 않을 수 있습니다. 클러스터 정보 수정에서 노드 라벨을 확인하세요.`
      : null)
    : null;

  const toggleMetric = (k: TrendMetricKey) => {
    const next = new Set(metrics);
    if (next.has(k)) next.delete(k); else next.add(k);
    setUrl({ metrics: METRIC_KEYS.filter((m) => next.has(m)).join(',') });
  };
  const onSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir(k === 'latest' ? 'desc' : 'asc'); }
  };
  const SortIcon = sortKey === 'name' ? (sortDir === 'asc' ? ArrowUp : ArrowDown) : ChevronsUpDown;
  const LatestIcon = sortKey === 'latest' ? (sortDir === 'asc' ? ArrowUp : ArrowDown) : ChevronsUpDown;
  const sortLabel = sortDir === 'asc' ? '오름차순' : '내림차순';

  const updatedAt = query.dataUpdatedAt
    ? new Date(query.dataUpdatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;
  const autoTitle = auto
    ? `자동 갱신 켜짐 (${AUTO_REFRESH_MS / 1000}초마다, 탭이 숨겨지면 멈춤) — 눌러서 끄기`
    : `자동 갱신 꺼짐 — 눌러서 ${AUTO_REFRESH_MS / 1000}초마다 갱신`;

  const headerActions = clusterId && !clustersQ.isError ? (
    <>
      <span role="status" className="sr-only">{query.isFetching ? '갱신 중' : ''}</span>
      {updatedAt && !noSelection && (
        <span className="text-xs text-muted-foreground whitespace-nowrap">마지막 갱신 {updatedAt}</span>
      )}
      <button
        type="button"
        onClick={() => setAutoOverride({ range, on: !auto })}
        aria-pressed={auto}
        title={autoTitle}
        className={`px-2.5 py-1 rounded-xl border text-sm whitespace-nowrap ${auto ? 'border-primary text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}
      >
        자동 갱신 {auto ? `${AUTO_REFRESH_MS / 1000}초` : '끔'}
      </button>
      <button
        type="button"
        onClick={() => { void query.refetch(); }}
        disabled={noSelection || query.isFetching}
        title="지금 새로고침"
        aria-label="지금 새로고침"
        className="inline-flex items-center justify-center w-8 h-8 rounded-xl border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/60 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <RefreshCw className={`w-4 h-4 ${query.isFetching ? 'animate-spin' : ''}`} aria-hidden />
      </button>
    </>
  ) : undefined;

  const renderBody = () => {
    if (noSelection) {
      return (
        <EmptyState
          title="노드와 지표를 선택하세요"
          description={`노드를 최대 ${maxNodes}개까지 선택할 수 있습니다.`}
        />
      );
    }
    if (query.isError && !resp) {
      return (
        <ErrorState
          error={query.error}
          title="추이를 불러오지 못했습니다"
          onRetry={() => { void query.refetch(); }}
        />
      );
    }
    if (!resp) return <LoadingState />;
    if (resp.status === 'offline') {
      // D-184 ④ / D-185: 빈 그리드 대신 원인 + 정확한 토글 이름 + 정보 수정 링크.
      return (
        <div role="alert">
          <EmptyState
            icon={AlertTriangle}
            title="Prometheus 미연결"
            description={resp.hint || resp.error || '이 클러스터의 Prometheus 연동이 꺼져 있거나 응답이 없습니다.'}
            action={{ label: '클러스터 정보 수정', onClick: () => navigate(editPath), variant: 'secondary' }}
          >
            {!resp.hint && <p className="mt-3 max-w-md text-sm text-muted-foreground">{PROM_TOGGLE_GUIDE}</p>}
          </EmptyState>
        </div>
      );
    }
    return (
      <div
        className={`grid gap-2 ${COLS_CLASS[cols]} ${query.isPlaceholderData ? 'opacity-60' : ''}`}
        aria-busy={query.isPlaceholderData || undefined}
      >
        {cells.map((cell) => {
          const label = METRIC_LABEL[cell.metric];
          const critical = cell.metric === 'networkerr' && (cell.latest ?? 0) > 0;
          return (
            <MacCard key={`${cell.node}__${cell.metric}`} bodyPadding="p-2.5">
              <div className="flex items-center justify-between gap-1 mb-1 min-w-0">
                <span className="text-xs font-medium truncate" title={cell.node}>{cell.node}</span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">{label}</span>
              </div>
              <div className={`text-sm font-semibold mb-1 ${critical ? 'text-status-critical' : 'text-foreground'}`}>
                {fmtVal(cell.latest, cell.unit)}
              </div>
              {cell.error ? (
                <div className="h-[110px] flex flex-col items-center justify-center gap-1 px-1 text-center text-xs" title={cell.error}>
                  <span className="inline-flex items-center gap-1 font-medium text-status-critical">
                    <AlertTriangle className="w-3.5 h-3.5" aria-hidden /> 조회 실패
                  </span>
                  <span className="text-muted-foreground line-clamp-3 break-all">{cell.error}</span>
                </div>
              ) : cell.data.length === 0 ? (
                <div className="h-[110px] flex items-center justify-center text-xs text-muted-foreground">데이터 없음</div>
              ) : (
                <>
                  {/* D-189: 차트 텍스트 대안 */}
                  <p className="sr-only">
                    {`${cell.node} · ${label} · 최신값 ${fmtVal(cell.latest, cell.unit)} · 구간 최소 ${fmtVal(cell.min, cell.unit)} / 최대 ${fmtVal(cell.max, cell.unit)}`}
                  </p>
                  <div aria-hidden>
                    <ResponsiveContainer width="100%" height={110}>
                      <LineChart data={cell.data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                        <XAxis dataKey="t" tick={chartAxisTick(9)} stroke="hsl(var(--border))" tickFormatter={(t) => fmtTime(t, range)} minTickGap={24} />
                        <YAxis tick={chartAxisTick(9)} stroke="hsl(var(--border))" width={34} domain={cell.unit === '%' ? [0, 100] : ['auto', 'auto']} />
                        <Tooltip
                          {...CHART_TOOLTIP_PROPS}
                          labelFormatter={(t) => fmtTime(Number(t), range)}
                          formatter={(v) => [fmtVal(typeof v === 'number' ? v : null, cell.unit), label]}
                        />
                        <Line type="monotone" dataKey="v" stroke={METRIC_COLOR[cell.metric]} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </>
              )}
            </MacCard>
          );
        })}
      </div>
    );
  };

  const segBtn = (on: boolean) =>
    `px-3 py-1.5 rounded-xl text-sm ${on ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`;
  const chipBtn = (on: boolean) =>
    `inline-flex items-center gap-1 px-2.5 py-1 rounded-xl border text-sm ${on ? 'border-primary text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`;

  return (
    <div className="app-min-h-screen bg-background">
      {/* D-190 ⑦: 사이드바는 PageShell 안 sticky 래퍼 — 관측 지표·파드 로그와 같은 레이아웃 */}
      <PageShell density="console" as="div" className="flex gap-3">
        <div className="sticky top-4 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            // 시간창·지표·열 수(URL 쿼리)는 유지하고 클러스터만 바꾼다.
            onSelect={(id) => { if (id) navigate(`/cluster-trends/${id}${location.search}`); }}
            iconOnly
          />
        </div>

        <main className="flex-1 min-w-0 space-y-2">
          <PageHeader
            back={{ to: '/clusters', label: '클러스터 상세' }}
            icon={TrendingUp}
            title="클러스터 추이"
            description={
              <>
                노드별 지표 추이 (선택한 노드만 조회)
                {nodeLabel && <> · 노드 라벨 <code className="text-xs">{nodeLabel}</code></>}
              </>
            }
            actions={headerActions}
          />

          {clustersQ.isError ? (
            <ErrorState
              error={clustersQ.error}
              title="클러스터 목록을 불러오지 못했습니다"
              onRetry={() => { void clustersQ.refetch(); }}
            />
          ) : !clusterId ? (
            <SelectClusterEmptyState />
          ) : (
            <>
              {/* ── 컨트롤 바 (D-122: 툴바만 감싸던 카드를 걷음) ── */}
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  {/* 시간창 */}
                  <div role="group" aria-label="시간 범위" className="inline-flex rounded-xl border border-border bg-card p-1">
                    {RANGES.map((r) => (
                      <button key={r.key} type="button" onClick={() => setUrl({ range: r.key })}
                        aria-pressed={range === r.key} className={segBtn(range === r.key)}>
                        {r.label}
                      </button>
                    ))}
                  </div>

                  <span className="mx-1 h-5 w-px bg-border" aria-hidden />

                  {/* 지표 토글 */}
                  <div role="group" aria-label="지표" className="flex flex-wrap items-center gap-1.5">
                    {METRICS.map((m) => (
                      <button key={m.key} type="button" onClick={() => toggleMetric(m.key)}
                        aria-pressed={metrics.has(m.key)} className={chipBtn(metrics.has(m.key))}>
                        {m.label}
                      </button>
                    ))}
                  </div>

                  <span className="mx-1 h-5 w-px bg-border" aria-hidden />

                  {/* 노드 선택 — 클러스터가 바뀌면 다시 마운트해 패널·검색어를 비운다 */}
                  <NodeMultiSelect key={clusterId} clusterId={clusterId} selected={nodes} onChange={setNodes} max={maxNodes} />

                  <div className="ml-auto flex items-center gap-2">
                    {/* 정렬 */}
                    <div role="group" aria-label="정렬" className="flex items-center gap-2">
                      <button type="button" onClick={() => onSort('name')} aria-pressed={sortKey === 'name'}
                        title={sortKey === 'name' ? `이름 ${sortLabel}` : '이름순 정렬'} className={chipBtn(sortKey === 'name')}>
                        이름 <SortIcon className="w-3 h-3" aria-hidden />
                      </button>
                      <button type="button" onClick={() => onSort('latest')} aria-pressed={sortKey === 'latest'}
                        title={sortKey === 'latest' ? `최신값 ${sortLabel}` : '최신값순 정렬'} className={chipBtn(sortKey === 'latest')}>
                        최신값 <LatestIcon className="w-3 h-3" aria-hidden />
                      </button>
                    </div>

                    <span className="mx-1 h-5 w-px bg-border" aria-hidden />

                    {/* 열 수 */}
                    <span id="trend-cols-label" className="text-sm text-muted-foreground">열 수</span>
                    <div role="group" aria-labelledby="trend-cols-label" className="inline-flex rounded-xl border border-border bg-card p-1">
                      {COLS.map((c) => (
                        <button key={c} type="button" onClick={() => setUrl({ cols: c })}
                          aria-pressed={cols === c} className={`px-2.5 py-1 rounded-xl text-sm ${cols === c ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
                          {c}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 상태/경고 라인 */}
                {query.isError && resp && (
                  <div role="alert" className="mt-2 flex flex-wrap items-center gap-1.5 text-sm text-status-critical">
                    <AlertTriangle className="w-4 h-4" aria-hidden />
                    갱신 실패 — {formatApiError(query.error)} (마지막으로 받은 결과를 표시합니다)
                    <button type="button" onClick={() => { void query.refetch(); }}
                      className="ml-1 px-2 py-0.5 rounded-xl border border-border text-foreground hover:bg-secondary/60">
                      다시 시도
                    </button>
                  </div>
                )}
                {resp?.status === 'error' && (
                  <div className="mt-2 flex items-center gap-1.5 text-sm text-status-warning">
                    <AlertTriangle className="w-4 h-4" aria-hidden />
                    {failedMetrics.length > 0
                      ? `일부 지표 조회 실패 — ${failedMetrics.map((m) => METRIC_LABEL[m]).join(', ')} (사유는 각 칸에 표시)`
                      : `일부 지표 조회 실패 — ${resp.error || '사유 미상'}`}
                  </div>
                )}
                {resp?.dropped && resp.dropped.length > 0 && (
                  <div className="mt-2 flex items-center gap-1.5 text-sm text-status-warning">
                    <AlertTriangle className="w-4 h-4" aria-hidden /> 상한({maxNodes}) 초과로 {resp.dropped.length}개 노드 제외: {resp.dropped.join(', ')}
                  </div>
                )}
                {hint && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sm text-status-warning">
                    <Info className="w-4 h-4" aria-hidden />
                    <span>{hint}</span>
                    {nodeLabel && !hint.includes(nodeLabel) && (
                      <span className="text-muted-foreground">(현재 노드 라벨 <code className="text-xs">{nodeLabel}</code>)</span>
                    )}
                    <Link to={editPath} className="text-primary underline underline-offset-2 hover:text-primary/80">
                      클러스터 정보 수정
                    </Link>
                  </div>
                )}
              </div>

              {/* ── 차트 그리드 ── */}
              {renderBody()}
            </>
          )}
        </main>
      </PageShell>
    </div>
  );
}
