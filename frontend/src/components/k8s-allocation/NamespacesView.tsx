// 네임스페이스별 자원 — 워크로드 → 파드/컨테이너 드릴다운.
import { Fragment, memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { EmptyState, Skeleton, SnapshotProgressCard } from '@/components/common';
import {
  useAllocNamespaces, useAllocPods, useAllocWorkloads, useRefreshAllocNamespace,
} from '@/hooks/useK8sAllocation';
import { buildCsv, downloadCsv } from '@/lib/csv';
import type { AllocNamespaceRow, AllocWorkloadRow } from '@/types';
import { EFF_BADGE, csvCluster, efficiency, fmtCores, fmtGi, fmtN, today, utilPct } from './format';
import {
  CsvButton, EffBadge, PageSizeSelect, Pager, ReqUseCell, SearchInput, SortableTh, StatTooltip, UtilPct,
} from './primitives';
import { nextSort, paginate, useTableSort } from './tableSort';
import type { SortState } from './tableSort';

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

export function NamespacesView({ clusterId, clusterName }: { clusterId: string; clusterName?: string }) {
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
                  onToggle={toggle} onRefresh={onRefreshNs} refreshing={refreshingNs === ns.namespace} />
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
            열 머리글을 클릭해 정렬
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

const NsRow = memo(function NsRow({ ns, clusterId, open, onToggle, onRefresh, refreshing }: {
  ns: AllocNamespaceRow; clusterId: string; open: boolean;
  onToggle: (ns: string) => void; onRefresh: (ns: string) => void; refreshing: boolean;
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
            {ns.namespace}
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

function WorkloadsDrill({ clusterId, namespace }: { clusterId: string; namespace: string }) {
  const { data, isLoading, isError } = useAllocWorkloads(clusterId, namespace, true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const key = (w: AllocWorkloadRow) => `${w.kind}/${w.name}`;
  const toggle = (k: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  if (isLoading) return <Skeleton className="h-12 w-full" />;
  if (isError) return <div className="text-sm text-status-critical">워크로드 조회 실패</div>;
  const rows = data?.items ?? [];
  if (!rows.length) return <div className="text-sm text-muted-foreground py-1">워크로드 없음</div>;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/20 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 font-medium w-7"><span className="sr-only">펼치기</span></th>
            <th className="px-2 py-1.5 font-medium">Workload</th>
            <th className="px-2 py-1.5 font-medium text-right">Pods</th>
            <th className="px-2 py-1.5 font-medium">CPU req/use</th>
            <th className="px-2 py-1.5 font-medium">MEM req/use</th>
            <th className="px-2 py-1.5 font-medium">효율</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((w) => {
            const k = key(w);
            const open = expanded.has(k);
            return (
              <Fragment key={k}>
                <tr
                  className="border-t border-border hover:bg-muted/10 cursor-pointer"
                  onClick={() => toggle(k)}
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(k); }
                  }}
                >
                  <td className="px-2 py-1.5 text-muted-foreground">{open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}</td>
                  <td className="px-2 py-1.5">
                    <span className="text-xs uppercase text-muted-foreground mr-1.5">{w.kind}</span>
                    <span className="font-medium">{w.name}</span>
                    {w.noRequestPods > 0 && <span className="ml-2 text-xs text-status-warning">· req미설정 {w.noRequestPods}</span>}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{w.podCount}</td>
                  <td className="px-2 py-1.5">
                    <ReqUseCell req={fmtCores(w.cpuReqM)} usage={w.cpuUsageM == null ? null : fmtCores(w.cpuUsageM)} icon="cpu" />
                    <UtilPct usage={w.cpuUsageM} req={w.cpuReqM} lim={w.cpuLimM} className="mt-0.5" />
                  </td>
                  <td className="px-2 py-1.5">
                    <ReqUseCell req={fmtGi(w.memReqB)} usage={w.memUsageB == null ? null : fmtGi(w.memUsageB)} icon="mem" />
                    <UtilPct usage={w.memUsageB} req={w.memReqB} lim={w.memLimB} className="mt-0.5" />
                  </td>
                  <td className="px-2 py-1.5"><EffBadge kind={efficiency(w.cpuReqM, w.cpuUsageM)} /></td>
                </tr>
                {open && (
                  <tr className="bg-muted/5">
                    <td aria-hidden="true" />
                    <td colSpan={5} className="px-2 py-1.5">
                      <PodsDrill clusterId={clusterId} namespace={namespace} kind={w.kind} name={w.name} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Pod phase(Running/Pending/Succeeded/Failed/Unknown) 배지.
const POD_PHASE_CLS: Record<string, string> = {
  Running: 'bg-status-healthy/10 text-status-healthy',
  Pending: 'bg-status-warning/10 text-status-warning',
  Failed: 'bg-status-critical/10 text-status-critical',
  Succeeded: 'bg-muted text-muted-foreground',
  Unknown: 'bg-muted text-muted-foreground',
};
function PodPhaseBadge({ phase }: { phase: string }) {
  const cls = POD_PHASE_CLS[phase] ?? 'bg-muted text-muted-foreground';
  return <span className={`text-xs px-1.5 py-0.5 rounded ${cls}`}>{phase || '-'}</span>;
}

function PodsDrill({ clusterId, namespace, kind, name }: { clusterId: string; namespace: string; kind: string; name: string }) {
  const { data, isLoading, isError } = useAllocPods(clusterId, namespace, kind, name, true);
  if (isLoading) return <Skeleton className="h-10 w-full" />;
  if (isError) return <div className="text-sm text-status-critical">파드 조회 실패</div>;
  const rows = data?.items ?? [];
  if (!rows.length) return <div className="text-sm text-muted-foreground py-1">파드 없음</div>;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-muted/20 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 font-medium">Pod / Container</th>
            <th className="px-2 py-1.5 font-medium">상태</th>
            <th className="px-2 py-1.5 font-medium">QoS</th>
            <th className="px-2 py-1.5 font-medium">Node</th>
            <th className="px-2 py-1.5 font-medium">CPU req/lim/use</th>
            <th className="px-2 py-1.5 font-medium">MEM req/lim/use</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <Fragment key={p.name}>
              <tr className="border-t border-border">
                <td className="px-2 py-1.5 font-medium">{p.name}</td>
                <td className="px-2 py-1.5"><PodPhaseBadge phase={p.phase} /></td>
                <td className="px-2 py-1.5">
                  <span className={`text-xs px-1.5 py-0.5 rounded ${p.qos === 'Guaranteed' ? 'bg-status-healthy/10 text-status-healthy' : p.qos === 'BestEffort' ? 'bg-status-critical/10 text-status-critical' : 'bg-status-warning/10 text-status-warning'}`}>
                    {p.qos ?? '-'}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-xs text-muted-foreground">{p.node ?? '-'}</td>
                <td className="px-2 py-1.5 text-xs tabular-nums">
                  {fmtCores(p.cpuReqM)} / {fmtCores(p.cpuLimM)} / {p.cpuUsageM == null ? '—' : fmtCores(p.cpuUsageM)}
                  <UtilPct usage={p.cpuUsageM} req={p.cpuReqM} lim={p.cpuLimM} />
                </td>
                <td className="px-2 py-1.5 text-xs tabular-nums">
                  {fmtGi(p.memReqB)} / {fmtGi(p.memLimB)} / {p.memUsageB == null ? '—' : fmtGi(p.memUsageB)}
                  <UtilPct usage={p.memUsageB} req={p.memReqB} lim={p.memLimB} />
                </td>
              </tr>
              {p.containers.map((c) => (
                <tr key={`${p.name}-${c.name}`} className="text-muted-foreground">
                  <td className="px-2 py-1 pl-7 text-xs">
                    ↳ {c.name}
                    {!c.hasRequests && <span className="ml-2 text-status-warning">req 미설정</span>}
                  </td>
                  <td aria-hidden="true" />
                  <td aria-hidden="true" />
                  <td aria-hidden="true" />
                  <td className="px-2 py-1 text-xs tabular-nums">{fmtCores(c.cpuReqM)} / {fmtCores(c.cpuLimM)} / {c.cpuUsageM == null ? '—' : fmtCores(c.cpuUsageM)}</td>
                  <td className="px-2 py-1 text-xs tabular-nums">{fmtGi(c.memReqB)} / {fmtGi(c.memLimB)} / {c.memUsageB == null ? '—' : fmtGi(c.memUsageB)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
