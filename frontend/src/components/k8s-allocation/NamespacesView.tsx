// 네임스페이스별 자원 — 워크로드 → 파드/컨테이너 드릴다운.
import { Fragment, memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { EmptyState, Skeleton, SnapshotProgressCard } from '@/components/common';
import { useAllocNamespaces, useRefreshAllocNamespace } from '@/hooks/useK8sAllocation';
import { buildCsv, downloadCsv } from '@/lib/csv';
import type { AllocNamespaceRow } from '@/types';
import { EFF_BADGE, csvCluster, efficiency, fmtN, today, utilPct } from './format';
import {
  CsvButton, EffBadge, PageSizeSelect, Pager, ReqUseCell, SearchInput, SortableTh, StatTooltip, UtilPct,
} from './primitives';
import { nextSort, paginate, useTableSort } from './tableSort';
import type { SortState } from './tableSort';
import { WorkloadsDrill } from './drilldown';
import type { AllocDetailTarget } from './AllocDetailDialog';

const NS_ACCESSORS: Record<string, (r: AllocNamespaceRow) => number | string | null> = {
  namespace: (r) => r.namespace,
  podCount: (r) => r.podCount,
  workloadCount: (r) => r.workloadCount,
  cpuReqM: (r) => r.cpuReqM,
  memReqB: (r) => r.memReqB,
  // `efficiency()` 배지와 동일하게 reqM<=0 이면 null(배지 없음).
  eff: (r) => (r.cpuUsageM == null || r.cpuReqM <= 0 ? null : r.cpuUsageM / r.cpuReqM),
};
const NS_PAGE_SIZES = [10, 20, 50, 100];

export function NamespacesView({ clusterId, clusterName, onOpenDetail }: {
  clusterId: string; clusterName?: string; onOpenDetail: (t: AllocDetailTarget) => void;
}) {
  const { data, isLoading, isError, error, refetch, isFetching } = useAllocNamespaces(clusterId);
  const refreshNs = useRefreshAllocNamespace(clusterId);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<SortState>({ key: 'cpuReqM', dir: 'desc' });
  const [q, setQ] = useState('');
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const onSort = (k: string) => setSort((p) => nextSort(p, k, k !== 'namespace'));
  const computing = data?.status === 'computing';

  const toggle = useCallback((ns: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(ns)) next.delete(ns); else next.add(ns);
    return next;
  }), []);

  const allItems = useMemo(() => data?.items ?? [], [data]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? allItems.filter((n) => n.namespace.toLowerCase().includes(s)) : allItems;
  }, [allItems, q]);
  const rows = useTableSort(filtered, NS_ACCESSORS, sort, computing);
  const { totalPages, safePage, start, pageRows } = paginate(rows, page, pageSize);
  // 검색/정렬/페이지당 변경 시 1페이지로 리셋.
  useEffect(() => { setPage(1); }, [q, sort, pageSize]);

  const onRefreshNs = useCallback((ns: string) => { refreshNs.mutate(ns); }, [refreshNs]);
  const openNsDetail = useCallback((ns: string) => onOpenDetail({ scope: 'namespace', name: ns }), [onOpenDetail]);
  const refreshingNs = refreshNs.isPending ? refreshNs.variables : undefined;

  const exportCsv = useCallback(() => {
    const headers = ['Namespace', 'Pods', 'Workloads', 'req미설정',
      'CPU 요청', 'CPU 사용', 'CPU 사용률(req)', 'CPU 사용률(lim)',
      'MEM 요청', 'MEM 사용', 'MEM 사용률(req)', 'MEM 사용률(lim)', '효율'];
    const pct = (v: number | null) => (v == null ? '' : `${v}%`);
    const effLabel = (r: AllocNamespaceRow) => {
      const k = efficiency(r.cpuReqM, r.cpuUsageM);
      return k ? EFF_BADGE[k].label : '';
    };
    const data2 = rows.map((ns) => [
      ns.namespace, ns.podCount, ns.workloadCount, ns.noRequestPods,
      ns.cpuReqDisplay, ns.cpuUsageDisplay ?? '', pct(utilPct(ns.cpuUsageM, ns.cpuReqM)), pct(utilPct(ns.cpuUsageM, ns.cpuLimM)),
      ns.memReqDisplay, ns.memUsageDisplay ?? '', pct(utilPct(ns.memUsageB, ns.memReqB)), pct(utilPct(ns.memUsageB, ns.memLimB)),
      effLabel(ns),
    ]);
    downloadCsv(`k8s-alloc-namespaces-${csvCluster(clusterName)}-${today()}.csv`, buildCsv(headers, data2));
  }, [rows, clusterName]);

  let body: React.ReactNode;
  if (isLoading && !data) {
    body = <div className="p-3"><Skeleton className="h-40 w-full" /></div>;
  } else if (isError && !data) {
    body = <div className="p-3"><EmptyState title="조회 실패" description={(error as Error)?.message ?? '불러오지 못했습니다.'} /></div>;
  } else if (computing && !allItems.length) {
    body = (
      <div className="p-3">
        <SnapshotProgressCard processed={data?.processed ?? 0} total={data?.total ?? null}
          progress={data?.progress ?? null} label="자원 집계 중" unit="Pod" />
      </div>
    );
  } else if (!allItems.length) {
    body = <div className="p-3"><EmptyState title="데이터 없음" description="표시할 네임스페이스가 없습니다." /></div>;
  } else {
    body = (
      <>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/20 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-2 py-2 font-medium w-7"><span className="sr-only">펼치기</span></th>
                <SortableTh label="Namespace" k="namespace" sort={sort} onSort={onSort} />
                <SortableTh label="Pods" k="podCount" sort={sort} onSort={onSort} align="right" />
                <SortableTh label="Workloads" k="workloadCount" sort={sort} onSort={onSort} align="right" />
                <SortableTh label="CPU req/use" k="cpuReqM" sort={sort} onSort={onSort} title="CPU 요청량 기준 정렬" />
                <SortableTh label="MEM req/use" k="memReqB" sort={sort} onSort={onSort} title="MEM 요청량 기준 정렬" />
                <SortableTh label="효율" k="eff" sort={sort} onSort={onSort} title="사용/요청 비율 기준 정렬" />
              </tr>
            </thead>
            <tbody>
              {!rows.length && (
                <tr className="border-t border-border">
                  <td colSpan={7} className="px-3 py-6 text-center text-sm text-muted-foreground">
                    '{q}' 와 일치하는 네임스페이스가 없습니다.
                  </td>
                </tr>
              )}
              {pageRows.map((ns) => (
                <NsRow key={ns.namespace} ns={ns} clusterId={clusterId} open={expanded.has(ns.namespace)}
                  onToggle={toggle} onRefresh={onRefreshNs} refreshing={refreshingNs === ns.namespace}
                  onOpenDetail={openNsDetail} />
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > 0 && (
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-border flex-wrap">
            <span className="text-xs text-muted-foreground tabular-nums">
              {fmtN(start + 1)}–{fmtN(start + pageRows.length)} / {fmtN(rows.length)}
            </span>
            <Pager page={safePage} totalPages={totalPages} onPage={setPage} />
          </div>
        )}
      </>
    );
  }

  return (
    <MacCard title={allItems.length ? `네임스페이스별 자원 (${fmtN(rows.length)}/${fmtN(allItems.length)}개)` : '네임스페이스별 자원'} bodyPadding="p-0">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-wrap gap-2">
        <div className="flex items-center gap-3 flex-wrap">
          <SearchInput value={q} onChange={setQ} placeholder="네임스페이스 찾기" width="w-52" />
          <span className="text-xs text-muted-foreground inline-flex items-center">
            NS 명 클릭=상세 · 행 클릭=펼치기 · 열 머리글을 클릭해 정렬
            <StatTooltip>
              <p><b>R</b> = 사용 ÷ 요청(request) 비율 · <b>L</b> = 사용 ÷ 제한(limit) 비율</p>
              <p className="text-muted-foreground mt-1">네임스페이스/워크로드/파드 표 전반에서 공통으로 쓰이는 표기입니다.</p>
            </StatTooltip>
          </span>
          <PageSizeSelect value={pageSize} onChange={setPageSize} options={NS_PAGE_SIZES} />
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

const NsRow = memo(function NsRow({ ns, clusterId, open, onToggle, onRefresh, refreshing, onOpenDetail }: {
  ns: AllocNamespaceRow; clusterId: string; open: boolean;
  onToggle: (ns: string) => void; onRefresh: (ns: string) => void; refreshing: boolean;
  onOpenDetail: (ns: string) => void;
}) {
  return (
    <Fragment>
      <tr
        className="border-t border-border hover:bg-muted/10 cursor-pointer"
        onClick={() => onToggle(ns.namespace)}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(ns.namespace); }
        }}
      >
        <td className="px-2 py-2 text-muted-foreground">{open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</td>
        <td className="px-2 py-2 font-medium">
          <span className="inline-flex items-center gap-1.5">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpenDetail(ns.namespace); }}
              title={`${ns.namespace} — 이 네임스페이스의 리소스(워크로드/파드) 할당·사용 상세 보기`}
              className="text-left hover:text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            >
              {ns.namespace}
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRefresh(ns.namespace); }}
              title="이 네임스페이스만 새로고침"
              aria-label="이 네임스페이스만 새로고침"
              className="text-muted-foreground hover:text-primary shrink-0"
            >
              <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </span>
          {ns.noRequestPods > 0 && <span className="ml-2 text-xs text-status-warning">· req미설정 {ns.noRequestPods}</span>}
        </td>
        <td className="px-2 py-2 text-right tabular-nums">{ns.podCount}</td>
        <td className="px-2 py-2 text-right tabular-nums">{ns.workloadCount}</td>
        <td className="px-2 py-2">
          <ReqUseCell req={ns.cpuReqDisplay} usage={ns.cpuUsageDisplay} icon="cpu" />
          <UtilPct usage={ns.cpuUsageM} req={ns.cpuReqM} lim={ns.cpuLimM} className="mt-0.5" />
        </td>
        <td className="px-2 py-2">
          <ReqUseCell req={ns.memReqDisplay} usage={ns.memUsageDisplay} icon="mem" />
          <UtilPct usage={ns.memUsageB} req={ns.memReqB} lim={ns.memLimB} className="mt-0.5" />
        </td>
        <td className="px-2 py-2"><EffBadge kind={efficiency(ns.cpuReqM, ns.cpuUsageM)} /></td>
      </tr>
      {open && (
        <tr className="bg-muted/5">
          <td aria-hidden="true" />
          <td colSpan={6} className="px-2 py-2">
            <WorkloadsDrill clusterId={clusterId} namespace={ns.namespace} />
          </td>
        </tr>
      )}
    </Fragment>
  );
});
