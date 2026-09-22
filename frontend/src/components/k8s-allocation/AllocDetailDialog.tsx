// 기준 정보(노드 / 네임스페이스) 클릭 → 그 대상이 실제로 안고 있는 리소스
// (Deployment/StatefulSet/DaemonSet/Pod …)의 **자원 할당(request·limit) vs 실제 사용(usage)**
// 상세를 여는 공용 다이얼로그.
//
// 노드별 자원 · 네임스페이스별 자원 · 네임스페이스 비효율 랭킹 세 탭이 모두 이 컴포넌트를
// 연다 — 탭마다 다른 상세 화면을 만들면 같은 질문("이 노드/NS 는 뭘 얼마나 잡고 있나")에
// 대한 답이 화면마다 달라진다.
import { useEffect, useMemo, useState } from 'react';
import { Box, Layers, RefreshCw, Server } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState, Skeleton } from '@/components/common';
import {
  useAllocNamespaces, useAllocNodePods, useAllocNodes, useAllocWorkloads,
} from '@/hooks/useK8sAllocation';
import { buildCsv, downloadCsv } from '@/lib/csv';
import type { AllocNodeRow, AllocWorkloadRow } from '@/types';
import { csvCluster, efficiency, EFF_BADGE, fmtCores, fmtGi, fmtN, today, utilPct } from './format';
import { CsvButton, MeterBar, SearchInput, Stat } from './primitives';
import { NodeWorkloadsDrill, PodsDrill, WorkloadTable } from './drilldown';
import { groupPodsByWorkload } from './podGroup';

/** 상세를 열 대상. null 이면 닫힘. */
export type AllocDetailTarget = { scope: 'node' | 'namespace'; name: string } | null;

/** 워크로드 목록 → CSV. 노드/NS 상세가 공통으로 쓴다. */
function exportWorkloadCsv(rows: AllocWorkloadRow[], filename: string) {
  const headers = ['Namespace', 'Kind', 'Workload', 'Pods', 'req미설정',
    'CPU 요청', 'CPU 제한', 'CPU 사용', 'CPU 사용률(req)',
    'MEM 요청', 'MEM 제한', 'MEM 사용', 'MEM 사용률(req)', '효율'];
  const pct = (v: number | null) => (v == null ? '' : `${v}%`);
  const data = rows.map((w) => {
    const k = efficiency(w.cpuReqM, w.cpuUsageM);
    return [
      w.namespace, w.kind, w.name, w.podCount, w.noRequestPods,
      fmtCores(w.cpuReqM), fmtCores(w.cpuLimM), w.cpuUsageM == null ? '' : fmtCores(w.cpuUsageM),
      pct(utilPct(w.cpuUsageM, w.cpuReqM)),
      fmtGi(w.memReqB), fmtGi(w.memLimB), w.memUsageB == null ? '' : fmtGi(w.memUsageB),
      pct(utilPct(w.memUsageB, w.memReqB)),
      k ? EFF_BADGE[k].label : '',
    ];
  });
  downloadCsv(filename, buildCsv(headers, data));
}

// ── 노드 상세 ─────────────────────────────────────────────────────────────────
function NodeSummary({ n }: { n: AllocNodeRow }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="rounded-lg border border-border bg-card/50 px-2.5 py-2">
        <div className="text-xs text-muted-foreground mb-1">CPU — 할당 {n.cpuAllocDisplay} 기준</div>
        <MeterBar alloc={n.cpuAllocM} req={n.cpuReqM} lim={n.cpuLimM} usage={n.cpuUsageM}
          reqDisplay={n.cpuReqDisplay} usageDisplay={n.cpuUsageDisplay} />
      </div>
      <div className="rounded-lg border border-border bg-card/50 px-2.5 py-2">
        <div className="text-xs text-muted-foreground mb-1">MEM — 할당 {n.memAllocDisplay} 기준</div>
        <MeterBar alloc={n.memAllocB} req={n.memReqB} lim={n.memLimB} usage={n.memUsageB}
          reqDisplay={n.memReqDisplay} usageDisplay={n.memUsageDisplay} />
      </div>
    </div>
  );
}

function NodeDetail({ clusterId, node, clusterName }: {
  clusterId: string; node: string; clusterName?: string;
}) {
  const nodesQ = useAllocNodes(clusterId);
  const row = nodesQ.data?.items.find((n) => n.name === node);
  const { data, isLoading, isError, error, refetch, isFetching } = useAllocNodePods(clusterId, node, true);
  const [q, setQ] = useState('');

  const pods = useMemo(() => {
    const s = q.trim().toLowerCase();
    const all = data?.items ?? [];
    if (!s) return all;
    return all.filter((p) =>
      p.name.toLowerCase().includes(s)
      || p.namespace.toLowerCase().includes(s)
      || (p.ownerName ?? '').toLowerCase().includes(s));
  }, [data, q]);
  const workloads = useMemo(() => groupPodsByWorkload(pods), [pods]);

  return (
    <div className="space-y-3">
      {row && <NodeSummary n={row} />}
      <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
        <Stat label="워크로드" value={fmtN(workloads.length)} icon={<Box className="w-3 h-3" />} />
        <Stat label="파드" value={fmtN(pods.length)} icon={<Layers className="w-3 h-3" />}
          sub={row ? `노드 집계 ${fmtN(row.podCount)}개` : undefined} />
        <Stat label="네임스페이스" value={fmtN(data?.namespaceCount ?? new Set(pods.map((p) => p.namespace)).size)} />
        <Stat label="역할" value={row?.roles.join(', ') || '-'}
          sub={row?.unschedulable ? 'cordoned (스케줄 불가)' : undefined} warn={row?.unschedulable} />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <SearchInput value={q} onChange={setQ} placeholder="파드/워크로드/NS 찾기" width="w-56" />
        <span className="text-xs text-muted-foreground">워크로드 행을 펼치면 파드·컨테이너별 req/limit/사용량이 보입니다</span>
        <div className="ml-auto flex items-center gap-3">
          <CsvButton
            onClick={() => exportWorkloadCsv(workloads, `k8s-node-detail-${csvCluster(clusterName)}-${node}-${today()}.csv`)}
            disabled={!workloads.length}
          />
          <button type="button" onClick={() => refetch()}
            className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} /> 새로고침
          </button>
        </div>
      </div>

      {isLoading && !data ? (
        <Skeleton className="h-40 w-full" />
      ) : isError && !data ? (
        <EmptyState title="조회 실패" description={(error as Error)?.message ?? '노드의 파드를 불러오지 못했습니다.'} />
      ) : !pods.length ? (
        <EmptyState title={q.trim() ? '검색 결과 없음' : '파드 없음'}
          description={q.trim() ? `'${q}' 와 일치하는 리소스가 없습니다.` : '이 노드에 스케줄된 활성 파드가 없습니다.'} />
      ) : (
        <NodeWorkloadsDrill pods={pods} />
      )}

      {data && !data.metricsAvailable && (
        <div className="text-sm text-muted-foreground">※ 사용량(use) 미가용 — metrics-server 응답이 없어 request/limit 만 표시됩니다.</div>
      )}
    </div>
  );
}

// ── 네임스페이스 상세 ──────────────────────────────────────────────────────────
function NamespaceDetail({ clusterId, namespace, clusterName }: {
  clusterId: string; namespace: string; clusterName?: string;
}) {
  const nsQ = useAllocNamespaces(clusterId);
  const row = nsQ.data?.items.find((n) => n.namespace === namespace);
  const { data, isLoading, isError, error, refetch, isFetching } = useAllocWorkloads(clusterId, namespace, true);
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const all = data?.items ?? [];
    return s ? all.filter((w) => w.name.toLowerCase().includes(s) || w.kind.toLowerCase().includes(s)) : all;
  }, [data, q]);

  return (
    <div className="space-y-3">
      {row && (
        <div className="grid gap-2 grid-cols-2 sm:grid-cols-5">
          <Stat label="파드" value={fmtN(row.podCount)} icon={<Layers className="w-3 h-3" />} />
          <Stat label="워크로드" value={fmtN(row.workloadCount)} icon={<Box className="w-3 h-3" />} />
          <Stat label="CPU req / use" value={`${row.cpuReqDisplay} / ${row.cpuUsageDisplay ?? '—'}`}
            sub={`limit ${fmtCores(row.cpuLimM)} · 사용률(req) ${utilPct(row.cpuUsageM, row.cpuReqM) ?? '—'}%`} />
          <Stat label="MEM req / use" value={`${row.memReqDisplay} / ${row.memUsageDisplay ?? '—'}`}
            sub={`limit ${fmtGi(row.memLimB)} · 사용률(req) ${utilPct(row.memUsageB, row.memReqB) ?? '—'}%`} />
          <Stat label="req 미설정 파드" value={fmtN(row.noRequestPods)} warn={row.noRequestPods > 0}
            help="request 가 없는 파드는 스케줄러가 자원을 계산하지 못해 노드 과밀·OOM 의 원인이 된다." />
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <SearchInput value={q} onChange={setQ} placeholder="워크로드 찾기" width="w-56" />
        <span className="text-xs text-muted-foreground">워크로드 행을 펼치면 파드·컨테이너별 req/limit/사용량이 보입니다</span>
        <div className="ml-auto flex items-center gap-3">
          <CsvButton
            onClick={() => exportWorkloadCsv(rows, `k8s-ns-detail-${csvCluster(clusterName)}-${namespace}-${today()}.csv`)}
            disabled={!rows.length}
          />
          <button type="button" onClick={() => refetch()}
            className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} /> 새로고침
          </button>
        </div>
      </div>

      {isLoading && !data ? (
        <Skeleton className="h-40 w-full" />
      ) : isError && !data ? (
        <EmptyState title="조회 실패" description={(error as Error)?.message ?? '워크로드를 불러오지 못했습니다.'} />
      ) : !rows.length ? (
        <EmptyState title={q.trim() ? '검색 결과 없음' : '워크로드 없음'}
          description={q.trim() ? `'${q}' 와 일치하는 워크로드가 없습니다.` : '이 네임스페이스에 활성 워크로드가 없습니다.'} />
      ) : (
        <WorkloadTable
          rows={rows}
          renderDetail={(w) => <PodsDrill clusterId={clusterId} namespace={namespace} kind={w.kind} name={w.name} />}
        />
      )}

      {data && !data.metricsAvailable && (
        <div className="text-sm text-muted-foreground">※ 사용량(use) 미가용 — metrics-server 응답이 없어 request/limit 만 표시됩니다.</div>
      )}
    </div>
  );
}

// ── 다이얼로그 ────────────────────────────────────────────────────────────────
export function AllocDetailDialog({ clusterId, target, clusterName, onClose }: {
  clusterId: string; target: AllocDetailTarget; clusterName?: string; onClose: () => void;
}) {
  // 대상이 바뀌면 검색어 등 내부 state 가 남지 않도록 키로 강제 remount 한다.
  const [key, setKey] = useState(0);
  useEffect(() => { setKey((k) => k + 1); }, [target?.scope, target?.name]);

  const open = !!target;
  const isNode = target?.scope === 'node';
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-none w-[min(96vw,1180px)] px-5 pb-5">
        <DialogHeader className="px-0 pt-0">
          <DialogTitle className="flex items-center gap-2 pr-8">
            {isNode ? <Server className="w-4 h-4 text-status-info" /> : <Layers className="w-4 h-4 text-status-info" />}
            {isNode ? '노드' : '네임스페이스'} 상세 — <span className="font-mono">{target?.name}</span>
          </DialogTitle>
          <DialogDescription>
            {isNode
              ? '이 노드에 스케줄된 실제 리소스(Deployment/StatefulSet/DaemonSet/Pod …)의 자원 할당(request·limit)과 실제 사용량입니다.'
              : '이 네임스페이스의 실제 리소스(Deployment/StatefulSet/DaemonSet/Pod …)의 자원 할당(request·limit)과 실제 사용량입니다.'}
          </DialogDescription>
        </DialogHeader>
        {target && (isNode
          ? <NodeDetail key={key} clusterId={clusterId} node={target.name} clusterName={clusterName} />
          : <NamespaceDetail key={key} clusterId={clusterId} namespace={target.name} clusterName={clusterName} />)}
      </DialogContent>
    </Dialog>
  );
}
