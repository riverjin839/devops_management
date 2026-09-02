// 노드별 자원 — 카드/테이블 뷰. 대형 클러스터(수백 노드)는 react-virtuoso 로 가상화해
// 1.5초 폴링마다 전량 리렌더되던 비용을 화면에 보이는 행만으로 줄인다.
import { forwardRef, memo, useCallback, useMemo, useRef, useState } from 'react';
import { LayoutGrid, List, RefreshCw } from 'lucide-react';
import { TableVirtuoso, VirtuosoGrid } from 'react-virtuoso';
import type { GridComponents, GridListProps, TableComponents } from 'react-virtuoso';
import { MacCard } from '@/components/ui/MacCard';
import { EmptyState, Skeleton, SnapshotProgressCard } from '@/components/common';
import { useAllocNodes, useRefreshAllocNode } from '@/hooks/useK8sAllocation';
import { buildCsv, downloadCsv } from '@/lib/csv';
import type { AllocNodeRow } from '@/types';
import {
  calcGridCols, csvCluster, efficiency, fmtCores, fmtGi, pctText, ratio, slackCls, slackLabel, today, utilPct,
} from './format';
import { CsvButton, EffBadge, MeterBar, SearchInput, SortableTh, StatTooltip, UtilPct } from './primitives';
import { nextSort, useTableSort } from './tableSort';
import type { SortState } from './tableSort';

// 이 수를 넘으면 가상 스크롤(고정 높이 뷰포트)로 전환한다. 작은 클러스터는 종전처럼 전량 렌더.
const VIRTUALIZE_AT = 48;

const NODE_ACCESSORS: Record<string, (r: AllocNodeRow) => number | string | null> = {
  name: (r) => r.name,
  cpuReqM: (r) => r.cpuReqM,
  memReqB: (r) => r.memReqB,
  cpuSlackM: (r) => r.cpuSlackM,
  memSlackB: (r) => r.memSlackB,
  podCount: (r) => r.podCount,
};

// 카드 그리드 열 수: 'auto' = 노드 수 기반 자동 배치, 그 외 고정 열 수.
type ColMode = 'auto' | 5 | 10 | 20;
const COL_OPTIONS: { label: string; value: ColMode }[] = [
  { label: '자동 배치', value: 'auto' },
  { label: '5열', value: 5 },
  { label: '10열', value: 10 },
  { label: '20열', value: 20 },
];

// ── 노드 게이지 행 (카드 뷰에서 사용) ─────────────────────────────────────────────
const GaugeRow = memo(function GaugeRow({ label, alloc, req, lim, usage }: {
  label: string; alloc: number; req: number; lim: number; usage: number | null;
}) {
  const allocRatio = ratio(req, alloc);
  const reqPct = allocRatio == null ? 0 : Math.min(100, allocRatio * 100);
  const useRatio = usage == null ? null : ratio(usage, alloc);
  const usePct = useRatio == null ? 0 : Math.min(100, useRatio * 100);
  const over = allocRatio != null && allocRatio > 1;
  return (
    <div>
      <div className="flex justify-between text-xs text-muted-foreground mb-0.5">
        <span>{label}</span>
        <span className="tabular-nums">
          req <b className={over ? 'text-status-critical' : 'text-status-info'}>{pctText(req, alloc)}</b>
          {usage != null && <> · use <b className="text-status-healthy">{pctText(usage, alloc)}</b></>}
        </span>
      </div>
      <div className="relative h-3 rounded-full bg-muted/40 overflow-hidden">
        <div className={`absolute inset-y-0 left-0 ${over ? 'bg-status-critical/80' : 'bg-status-info/70'}`} style={{ width: `${reqPct}%` }} />
        {usage != null && <div className="absolute inset-y-0 left-0 bg-status-healthy opacity-85" style={{ width: `${usePct}%` }} />}
      </div>
      <div className="flex items-center gap-1.5 mt-0.5">
        <UtilPct usage={usage} req={req} lim={lim} />
        <EffBadge kind={efficiency(req, usage)} />
      </div>
    </div>
  );
});

// ── 노드 카드 / 테이블 행 (memo — 폴링 시 바뀐 노드만 리렌더) ────────────────────
const NodeCard = memo(function NodeCard({ n, onRefresh, refreshing }: {
  n: AllocNodeRow; onRefresh: (name: string) => void; refreshing: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-2.5 h-full">
      <div className="flex items-center justify-between mb-1">
        <div className="font-medium text-sm truncate" title={n.name}>{n.name}</div>
        <div className="flex items-center gap-1 shrink-0 ml-1.5">
          <span className="text-xs text-muted-foreground">{n.roles.join(',')}</span>
          {n.unschedulable && <span className="text-xs text-status-warning">cordoned</span>}
          <button
            type="button"
            onClick={() => onRefresh(n.name)}
            title="이 노드만 새로고침"
            aria-label="이 노드만 새로고침"
            className="text-muted-foreground hover:text-primary"
          >
            <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
      <div className="space-y-1.5">
        <GaugeRow label="CPU" alloc={n.cpuAllocM} req={n.cpuReqM} lim={n.cpuLimM} usage={n.cpuUsageM} />
        <GaugeRow label="MEM" alloc={n.memAllocB} req={n.memReqB} lim={n.memLimB} usage={n.memUsageB} />
      </div>
      <div className="flex justify-between text-xs mt-1.5 tabular-nums">
        <span className={slackCls(n.cpuSlackM)}>{slackLabel(n.cpuSlackM)} {fmtCores(n.cpuSlackM)}</span>
        <span className={slackCls(n.memSlackB)}>{slackLabel(n.memSlackB)} {fmtGi(n.memSlackB)}</span>
        <span className="text-muted-foreground">{n.podCount}p</span>
      </div>
    </div>
  );
});

const CELL = 'px-3 py-2 border-t border-border align-middle';
const NodeRowCells = memo(function NodeRowCells({ n, onRefresh, refreshing }: {
  n: AllocNodeRow; onRefresh: (name: string) => void; refreshing: boolean;
}) {
  return (
    <>
      <td className={CELL}>
        <div className="flex items-center gap-1.5">
          <span className="font-medium">{n.name}</span>
          <button
            type="button"
            onClick={() => onRefresh(n.name)}
            title="이 노드만 새로고침"
            aria-label="이 노드만 새로고침"
            className="text-muted-foreground hover:text-primary shrink-0"
          >
            <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
        <div className="text-xs text-muted-foreground">
          {n.roles.join(', ')}{n.unschedulable && <span className="text-status-warning"> · cordoned</span>}
        </div>
      </td>
      <td className={CELL}>
        <MeterBar alloc={n.cpuAllocM} req={n.cpuReqM} lim={n.cpuLimM} usage={n.cpuUsageM}
          reqDisplay={n.cpuReqDisplay} usageDisplay={n.cpuUsageDisplay} />
      </td>
      <td className={CELL}>
        <MeterBar alloc={n.memAllocB} req={n.memReqB} lim={n.memLimB} usage={n.memUsageB}
          reqDisplay={n.memReqDisplay} usageDisplay={n.memUsageDisplay} />
      </td>
      <td className={`${CELL} text-right tabular-nums`}>
        <div className={`font-medium ${slackCls(n.cpuSlackM)}`}>{fmtCores(n.cpuSlackM)}</div>
        <div className="text-xs text-muted-foreground">/ {fmtCores(n.cpuAllocM)}</div>
      </td>
      <td className={`${CELL} text-right tabular-nums`}>
        <div className={`font-medium ${slackCls(n.memSlackB)}`}>{fmtGi(n.memSlackB)}</div>
        <div className="text-xs text-muted-foreground">/ {fmtGi(n.memAllocB)}</div>
      </td>
      <td className={`${CELL} text-right tabular-nums`}>{n.podCount}</td>
    </>
  );
});

// ── react-virtuoso 래퍼(모듈 레벨 — 렌더마다 새 컴포넌트를 만들면 Virtuoso 가 리마운트) ───
const TABLE_COMPONENTS: TableComponents<AllocNodeRow> = {
  Table: ({ style, context: _context, ...props }) => <table {...props} style={style} className="w-full text-sm" />,
  TableRow: ({ item: _item, context: _context, ...props }) => <tr {...props} className="hover:bg-muted/10" />,
};
interface GridCtx { cols: number }
const GridList = forwardRef<HTMLDivElement, GridListProps & { context: GridCtx }>(
  function GridList({ style, children, context, className: _className, ...props }, ref) {
    return (
      <div ref={ref} {...props} className="grid gap-2 p-3"
        style={{ ...style, gridTemplateColumns: `repeat(${context.cols}, minmax(min(220px, 100%), 1fr))` }}>
        {children}
      </div>
    );
  },
);
const GRID_COMPONENTS: GridComponents<GridCtx> = { List: GridList };

export function NodesView({ clusterId, clusterName }: { clusterId: string; clusterName?: string }) {
  const { data, isLoading, isError, error, refetch, isFetching } = useAllocNodes(clusterId);
  const refreshNode = useRefreshAllocNode(clusterId);
  const [sort, setSort] = useState<SortState>({ key: 'cpuSlackM', dir: 'desc' });
  const [viewStyle, setViewStyle] = useState<'table' | 'card'>('card');
  const [colMode, setColMode] = useState<ColMode>('auto');
  const [q, setQ] = useState('');
  const onSort = (k: string) => setSort((p) => nextSort(p, k, k !== 'name'));
  const computing = data?.status === 'computing';

  const allItems = useMemo(() => data?.items ?? [], [data]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? allItems.filter((n) => n.name.toLowerCase().includes(s)) : allItems;
  }, [allItems, q]);
  // 집계 중에는 순서를 고정(frozen) — 부분 결과가 들어올 때마다 카드가 자리를 바꾸지 않게.
  const rows = useTableSort(filtered, NODE_ACCESSORS, sort, computing);

  // 그리드 열 수는 마지막 ready 행 수 기준 — 집계 중 행이 늘 때마다 재배치되지 않게.
  const readyCountRef = useRef(0);
  if (!computing) readyCountRef.current = rows.length;
  const countForCols = computing && readyCountRef.current ? readyCountRef.current : rows.length;
  const gridCols = colMode === 'auto' ? calcGridCols(Math.max(1, countForCols)) : colMode;
  const gridCtx = useMemo<GridCtx>(() => ({ cols: gridCols }), [gridCols]);

  const onRefreshNode = useCallback((name: string) => { refreshNode.mutate(name); }, [refreshNode]);
  const refreshingName = refreshNode.isPending ? refreshNode.variables : undefined;

  const exportCsv = useCallback(() => {
    const headers = ['Node', 'Roles', 'Cordoned', 'Pods',
      'CPU 할당', 'CPU 요청', 'CPU 사용', 'CPU 가용', 'CPU 사용률(req)', 'CPU 사용률(lim)',
      'MEM 할당', 'MEM 요청', 'MEM 사용', 'MEM 가용', 'MEM 사용률(req)', 'MEM 사용률(lim)'];
    const pct = (v: number | null) => (v == null ? '' : `${v}%`);
    const data2 = rows.map((n) => [
      n.name, n.roles.join(' '), n.unschedulable ? 'Y' : '',
      n.podCount,
      n.cpuAllocDisplay, n.cpuReqDisplay, n.cpuUsageDisplay ?? '', fmtCores(n.cpuSlackM),
      pct(utilPct(n.cpuUsageM, n.cpuReqM)), pct(utilPct(n.cpuUsageM, n.cpuLimM)),
      n.memAllocDisplay, n.memReqDisplay, n.memUsageDisplay ?? '', fmtGi(n.memSlackB),
      pct(utilPct(n.memUsageB, n.memReqB)), pct(utilPct(n.memUsageB, n.memLimB)),
    ]);
    downloadCsv(`k8s-alloc-nodes-${csvCluster(clusterName)}-${today()}.csv`, buildCsv(headers, data2));
  }, [rows, clusterName]);

  const virtual = rows.length > VIRTUALIZE_AT;
  const headerRow = (
    <tr className="bg-muted/20 text-left text-xs text-muted-foreground">
      <SortableTh label="Node" k="name" sort={sort} onSort={onSort} />
      <SortableTh label="CPU (req)" k="cpuReqM" sort={sort} onSort={onSort} title="CPU 요청량 기준 정렬" />
      <SortableTh label="MEM (req)" k="memReqB" sort={sort} onSort={onSort} title="MEM 요청량 기준 정렬" />
      <SortableTh label="CPU 가용 / 할당" k="cpuSlackM" sort={sort} onSort={onSort} align="right" title="할당 가용(slack=alloc−req) 기준 정렬" />
      <SortableTh label="MEM 가용 / 할당" k="memSlackB" sort={sort} onSort={onSort} align="right" title="할당 가용(slack=alloc−req) 기준 정렬" />
      <SortableTh label="Pods" k="podCount" sort={sort} onSort={onSort} align="right" />
    </tr>
  );

  // 프레임(MacCard)은 항상 유지 — 상태에 따라 body 만 바뀐다.
  let body: React.ReactNode;
  if (isLoading && !data) {
    body = <div className="p-3"><Skeleton className="h-40 w-full" /></div>;
  } else if (isError && !data) {
    body = <div className="p-3"><EmptyState title="조회 실패" description={(error as Error)?.message ?? '노드 자원을 불러오지 못했습니다.'} /></div>;
  } else if (computing && !allItems.length) {
    body = (
      <div className="p-3">
        <SnapshotProgressCard processed={data?.processed ?? 0} total={data?.total ?? null}
          progress={data?.progress ?? null} label="자원 집계 중" unit="Pod" />
      </div>
    );
  } else if (!allItems.length) {
    body = <div className="p-3"><EmptyState title="노드 없음" description="표시할 노드가 없습니다." /></div>;
  } else if (!rows.length) {
    body = <div className="p-6"><EmptyState title="검색 결과 없음" description={`'${q}' 와 일치하는 노드가 없습니다.`} /></div>;
  } else if (viewStyle === 'card') {
    body = virtual ? (
      <VirtuosoGrid
        style={{ height: '64vh' }}
        data={rows}
        context={gridCtx}
        components={GRID_COMPONENTS}
        computeItemKey={(_i, n) => n.name}
        itemContent={(_i, n) => <NodeCard n={n} onRefresh={onRefreshNode} refreshing={refreshingName === n.name} />}
      />
    ) : (
      <div className="p-3 overflow-x-auto">
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(min(220px, 100%), 1fr))` }}>
          {rows.map((n) => (
            <NodeCard key={n.name} n={n} onRefresh={onRefreshNode} refreshing={refreshingName === n.name} />
          ))}
        </div>
      </div>
    );
  } else {
    body = virtual ? (
      <TableVirtuoso
        style={{ height: '64vh' }}
        data={rows}
        components={TABLE_COMPONENTS}
        computeItemKey={(_i, n) => n.name}
        fixedHeaderContent={() => headerRow}
        itemContent={(_i, n) => <NodeRowCells n={n} onRefresh={onRefreshNode} refreshing={refreshingName === n.name} />}
      />
    ) : (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>{headerRow}</thead>
          <tbody>
            {rows.map((n) => (
              <tr key={n.name} className="hover:bg-muted/10">
                <NodeRowCells n={n} onRefresh={onRefreshNode} refreshing={refreshingName === n.name} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <MacCard title="노드별 자원" bodyPadding="p-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          {/* 뷰 전환 토글 */}
          <div className="inline-flex rounded-lg border border-border bg-muted/20 p-0.5">
            <button
              type="button"
              onClick={() => setViewStyle('table')}
              title="테이블 뷰"
              aria-label="테이블 뷰"
              className={`p-1.5 rounded-md ${viewStyle === 'table' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <List className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setViewStyle('card')}
              title="카드 뷰"
              aria-label="카드 뷰"
              className={`p-1.5 rounded-md ${viewStyle === 'card' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
          </div>
          <SearchInput value={q} onChange={setQ} placeholder="노드 찾기" />
          {viewStyle === 'table' && (
            <span className="text-xs text-muted-foreground inline-flex items-center">
              열 머리글을 클릭해 정렬
              <StatTooltip>
                <p><b>R</b> = 사용 ÷ 요청(request) 비율 · <b>L</b> = 사용 ÷ 제한(limit) 비율</p>
                <p className="text-muted-foreground mt-1">노드/네임스페이스/워크로드/파드 표 전반에서 공통으로 쓰이는 표기입니다.</p>
              </StatTooltip>
            </span>
          )}
          {viewStyle === 'card' && (
            <>
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                열 수
                <select
                  value={String(colMode)}
                  onChange={(e) => setColMode(e.target.value === 'auto' ? 'auto' : (Number(e.target.value) as ColMode))}
                  className="text-sm px-1.5 py-0.5 rounded-lg border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  title="한 줄에 표시할 카드 열 수"
                >
                  {COL_OPTIONS.map((o) => <option key={o.label} value={String(o.value)}>{o.label}</option>)}
                </select>
              </label>
              <span className="text-xs text-muted-foreground">노드 {rows.length}개 · {gridCols}열{virtual ? ' · 가상 스크롤' : ''}</span>
            </>
          )}
          {viewStyle === 'table' && virtual && (
            <span className="text-xs text-muted-foreground">노드 {rows.length}개 · 가상 스크롤</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <CsvButton onClick={exportCsv} disabled={!rows.length} />
          <button type="button" onClick={() => refetch()} className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} /> 새로고침
          </button>
        </div>
      </div>
      <div className="min-h-40">{body}</div>
    </MacCard>
  );
}
