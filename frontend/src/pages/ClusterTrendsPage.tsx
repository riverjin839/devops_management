import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, TrendingUp, ArrowUp, ArrowDown, ChevronsUpDown, AlertTriangle, RefreshCw,
} from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { EmptyState } from '@/components/common';
import { NodeMultiSelect } from '@/components/k8s/NodeMultiSelect';
import { useClusters } from '@/hooks/useCluster';
import { useClusterTrends } from '@/hooks/useClusterTrends';
import type { TrendMetricKey, TrendRange, TrendMetricBlock } from '@/types';

const RANGES: TrendRange[] = ['30m', '1h', '6h', '24h', '7d'];

const METRICS: { key: TrendMetricKey; label: string }[] = [
  { key: 'cpu', label: 'CPU' },
  { key: 'memory', label: 'Memory' },
  { key: 'disk', label: 'Disk' },
  { key: 'diskio', label: 'DiskIO' },
  { key: 'network', label: 'Network' },
  { key: 'networkerr', label: 'Network Err' },
];
const METRIC_LABEL: Record<TrendMetricKey, string> = Object.fromEntries(
  METRICS.map((m) => [m.key, m.label]),
) as Record<TrendMetricKey, string>;

// 지표별 라인 색 (테마 토큰 기반 — 원색 남용 회피).
const METRIC_COLOR: Record<TrendMetricKey, string> = {
  cpu: '#0ea5e9',
  memory: '#22c55e',
  disk: '#f59e0b',
  diskio: '#a855f7',
  network: '#0369a1',
  networkerr: '#dc2626',
};

const COLS = [1, 5, 10, 20] as const;
const MAX_NODES = 30;     // 백엔드 settings.trends_max_nodes 와 동기 (과수집 방지 상한).

type SortKey = 'name' | 'latest';
type SortDir = 'asc' | 'desc';

function fmtVal(v: number | null, unit: string): string {
  if (v == null) return '–';
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
  data: { t: number; v: number | null }[];
}

export function ClusterTrendsPage() {
  const { clusterId = '' } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const { data: clusters = [] } = useClusters();

  const [range, setRange] = useState<TrendRange>('1h');
  const [metrics, setMetrics] = useState<Set<TrendMetricKey>>(new Set(['cpu', 'memory']));
  const [nodes, setNodes] = useState<Set<string>>(new Set());
  const [cols, setCols] = useState<number>(5);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const metricList = useMemo(
    () => METRICS.map((m) => m.key).filter((k) => metrics.has(k)),
    [metrics],
  );
  const nodeList = useMemo(() => Array.from(nodes), [nodes]);

  const query = useClusterTrends(clusterId, { range, metrics: metricList, nodes: nodeList });
  const resp = query.data;

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
        const lastDefined = [...pts].reverse().find((p) => p.v != null);
        out.push({ node, metric: m, unit: block.unit, latest: lastDefined?.v ?? null, data: pts });
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

  const toggleMetric = (k: TrendMetricKey) => {
    setMetrics((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };
  const onSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(k); setSortDir(k === 'latest' ? 'desc' : 'asc'); }
  };
  const SortIcon = sortKey === 'name' ? (sortDir === 'asc' ? ArrowUp : ArrowDown) : ChevronsUpDown;
  const LatestIcon = sortKey === 'latest' ? (sortDir === 'asc' ? ArrowUp : ArrowDown) : ChevronsUpDown;

  const noSelection = nodeList.length === 0 || metricList.length === 0;

  return (
    <div className="min-h-screen bg-background p-3">
      <div className="flex gap-3 max-w-[1800px] mx-auto">
        <div className="sticky top-3 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            onSelect={(id) => { if (id) navigate(`/cluster-trends/${id}`); }}
            iconOnly
          />
        </div>

        <div className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <Link to="/cluster-overview" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
              <ArrowLeft className="w-4 h-4" /> 클러스터 현황
            </Link>
            <h1 className="text-lg font-semibold flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-cyan-500" /> 클러스터 추이
            </h1>
            <span className="text-sm text-muted-foreground">노드별 메트릭 시계열 (선택 노드 한정)</span>
            {query.isFetching && <RefreshCw className="w-4 h-4 text-muted-foreground animate-spin" />}
          </div>

          {!clusterId ? (
            <MacCard><EmptyState title="클러스터를 선택하세요" /></MacCard>
          ) : (
            <>
              {/* ── 컨트롤 바 ── */}
              <MacCard bodyPadding="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  {/* 시간창 */}
                  <div className="inline-flex rounded-xl border border-border bg-card p-1">
                    {RANGES.map((r) => (
                      <button key={r} onClick={() => setRange(r)}
                        className={`px-3 py-1.5 rounded-lg text-sm ${range === r ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}>
                        {r}
                      </button>
                    ))}
                  </div>

                  <span className="mx-1 h-5 w-px bg-border" />

                  {/* 지표 토글 */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    {METRICS.map((m) => (
                      <button key={m.key} onClick={() => toggleMetric(m.key)}
                        className={`px-2.5 py-1 rounded-lg border text-sm ${metrics.has(m.key) ? 'border-primary text-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                        {m.label}
                      </button>
                    ))}
                  </div>

                  <span className="mx-1 h-5 w-px bg-border" />

                  {/* 노드 선택 */}
                  <NodeMultiSelect clusterId={clusterId} selected={nodes} onChange={setNodes} max={MAX_NODES} />

                  <div className="ml-auto flex items-center gap-2">
                    {/* 정렬 */}
                    <button onClick={() => onSort('name')}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-sm ${sortKey === 'name' ? 'border-primary text-primary' : 'border-border text-muted-foreground'}`}>
                      이름 <SortIcon className="w-3 h-3" />
                    </button>
                    <button onClick={() => onSort('latest')}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-sm ${sortKey === 'latest' ? 'border-primary text-primary' : 'border-border text-muted-foreground'}`}>
                      최신값 <LatestIcon className="w-3 h-3" />
                    </button>

                    <span className="mx-1 h-5 w-px bg-border" />

                    {/* 컬럼 수 */}
                    <span className="text-sm text-muted-foreground">컬럼</span>
                    <div className="inline-flex rounded-xl border border-border bg-card p-1">
                      {COLS.map((c) => (
                        <button key={c} onClick={() => setCols(c)}
                          className={`px-2.5 py-1 rounded-lg text-sm ${cols === c ? 'bg-primary text-white' : 'text-muted-foreground hover:text-foreground'}`}>
                          {c}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 상태/경고 라인 */}
                {resp?.status === 'offline' && (
                  <div className="mt-2 flex items-center gap-1.5 text-sm text-amber-600">
                    <AlertTriangle className="w-4 h-4" /> Prometheus offline — {resp.error || '클러스터 관리에서 Prometheus URL 을 설정/활성화하세요.'}
                  </div>
                )}
                {resp?.status === 'error' && (
                  <div className="mt-2 flex items-center gap-1.5 text-sm text-destructive">
                    <AlertTriangle className="w-4 h-4" /> 조회 오류 — {resp.error}
                  </div>
                )}
                {resp?.dropped && resp.dropped.length > 0 && (
                  <div className="mt-2 flex items-center gap-1.5 text-sm text-amber-600">
                    <AlertTriangle className="w-4 h-4" /> 상한({MAX_NODES}) 초과로 {resp.dropped.length}개 노드 제외: {resp.dropped.join(', ')}
                  </div>
                )}
              </MacCard>

              {/* ── 차트 그리드 ── */}
              {noSelection ? (
                <MacCard><EmptyState title="노드와 지표를 선택하세요" description={`노드를 최대 ${MAX_NODES}개까지 선택할 수 있습니다.`} /></MacCard>
              ) : (
                <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
                  {cells.map((cell) => (
                    <div key={`${cell.node}__${cell.metric}`} className="rounded-xl border border-border bg-card p-2.5">
                      <div className="flex items-center justify-between gap-1 mb-1 min-w-0">
                        <span className="text-xs font-medium truncate" title={cell.node}>{cell.node}</span>
                        <span className="text-[10px] text-muted-foreground whitespace-nowrap">{METRIC_LABEL[cell.metric]}</span>
                      </div>
                      <div className="text-sm font-semibold mb-1" style={{ color: METRIC_COLOR[cell.metric] }}>
                        {fmtVal(cell.latest, cell.unit)}
                      </div>
                      {cell.data.length === 0 ? (
                        <div className="h-[110px] flex items-center justify-center text-xs text-muted-foreground">데이터 없음</div>
                      ) : (
                        <ResponsiveContainer width="100%" height={110}>
                          <LineChart data={cell.data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                            <XAxis dataKey="t" tick={{ fontSize: 9 }} tickFormatter={(t) => fmtTime(t, range)} minTickGap={24} />
                            <YAxis tick={{ fontSize: 9 }} width={34} domain={cell.unit === '%' ? [0, 100] : ['auto', 'auto']} />
                            <Tooltip
                              labelFormatter={(t) => fmtTime(Number(t), range)}
                              formatter={(v) => [fmtVal(typeof v === 'number' ? v : null, cell.unit), METRIC_LABEL[cell.metric]]}
                            />
                            <Line type="monotone" dataKey="v" stroke={METRIC_COLOR[cell.metric]} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
                          </LineChart>
                        </ResponsiveContainer>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
