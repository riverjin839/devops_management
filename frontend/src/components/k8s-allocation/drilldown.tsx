// 자원 드릴다운 공용 — 워크로드(Deployment/STS/DS…) → 파드 → 컨테이너 단위로
// "자원 할당(request/limit) vs 실제 사용(usage)" 을 펼쳐 보여준다.
//
// 네임스페이스별 자원 탭의 인라인 드릴다운과, 노드/네임스페이스 상세 다이얼로그가 같은
// 컴포넌트를 쓴다 — 한쪽만 표기(사이드카 합산·사용률 배지·QoS)가 달라지면 같은 파드가
// 화면마다 다르게 보인다.
import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Skeleton } from '@/components/common';
import { useAllocPods, useAllocWorkloads } from '@/hooks/useK8sAllocation';
import type { AllocPodRow, AllocWorkloadRow } from '@/types';
import { efficiency, fmtCores, fmtGi } from './format';
import { EffBadge, ReqUseCell, UtilPct } from './primitives';
import { groupPodsByWorkload } from './podGroup';

// ── 배지 ──────────────────────────────────────────────────────────────────────
// Pod phase(Running/Pending/Succeeded/Failed/Unknown) 배지.
const POD_PHASE_CLS: Record<string, string> = {
  Running: 'bg-status-healthy/10 text-status-healthy',
  Pending: 'bg-status-warning/10 text-status-warning',
  Failed: 'bg-status-critical/10 text-status-critical',
  Succeeded: 'bg-muted text-muted-foreground',
  Unknown: 'bg-muted text-muted-foreground',
};
export function PodPhaseBadge({ phase }: { phase: string }) {
  const cls = POD_PHASE_CLS[phase] ?? 'bg-muted text-muted-foreground';
  return <span className={`text-xs px-1.5 py-0.5 rounded ${cls}`}>{phase || '-'}</span>;
}

export function QosBadge({ qos }: { qos: string | null }) {
  const cls = qos === 'Guaranteed'
    ? 'bg-status-healthy/10 text-status-healthy'
    : qos === 'BestEffort'
      ? 'bg-status-critical/10 text-status-critical'
      : 'bg-status-warning/10 text-status-warning';
  return <span className={`text-xs px-1.5 py-0.5 rounded ${cls}`}>{qos ?? '-'}</span>;
}

// ── 파드 + 컨테이너 표 ─────────────────────────────────────────────────────────
/** 파드 행(합계) + 컨테이너 행(↳)으로 req/lim/use 를 나란히 보여준다.
 * showNamespace: 노드 상세처럼 여러 NS 가 섞일 때만 NS 열을 추가한다. */
export function PodAllocTable({ pods, showNamespace = false }: {
  pods: AllocPodRow[]; showNamespace?: boolean;
}) {
  const span = showNamespace ? 7 : 6;
  return (
    <div className="rounded-lg border border-border bg-card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/20 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 font-medium">Pod / Container</th>
            {showNamespace && <th className="px-2 py-1.5 font-medium">Namespace</th>}
            <th className="px-2 py-1.5 font-medium">상태</th>
            <th className="px-2 py-1.5 font-medium">QoS</th>
            <th className="px-2 py-1.5 font-medium">Node</th>
            <th className="px-2 py-1.5 font-medium">CPU req/lim/use</th>
            <th className="px-2 py-1.5 font-medium">MEM req/lim/use</th>
          </tr>
        </thead>
        <tbody>
          {!pods.length && (
            <tr className="border-t border-border">
              <td colSpan={span} className="px-2 py-4 text-center text-sm text-muted-foreground">파드 없음</td>
            </tr>
          )}
          {pods.map((p) => (
            <Fragment key={`${p.namespace}/${p.name}`}>
              <tr className="border-t border-border">
                <td className="px-2 py-1.5 font-medium">{p.name}</td>
                {showNamespace && <td className="px-2 py-1.5 text-xs text-muted-foreground">{p.namespace}</td>}
                <td className="px-2 py-1.5"><PodPhaseBadge phase={p.phase} /></td>
                <td className="px-2 py-1.5"><QosBadge qos={p.qos} /></td>
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
                <tr key={`${p.namespace}-${p.name}-${c.name}`} className="text-muted-foreground">
                  <td className="px-2 py-1 pl-7 text-xs">
                    ↳ {c.name}
                    {!c.hasRequests && <span className="ml-2 text-status-warning">req 미설정</span>}
                  </td>
                  {showNamespace && <td aria-hidden="true" />}
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

/** 워크로드 소속 파드/컨테이너 — 워크로드 행을 펼쳤을 때 lazy 조회. */
export function PodsDrill({ clusterId, namespace, kind, name }: {
  clusterId: string; namespace: string; kind: string; name: string;
}) {
  const { data, isLoading, isError } = useAllocPods(clusterId, namespace, kind, name, true);
  if (isLoading) return <Skeleton className="h-10 w-full" />;
  if (isError) return <div className="text-sm text-status-critical">파드 조회 실패</div>;
  const rows = data?.items ?? [];
  if (!rows.length) return <div className="text-sm text-muted-foreground py-1">파드 없음</div>;
  return <PodAllocTable pods={rows} />;
}

// ── 워크로드 표 (공용 렌더) ────────────────────────────────────────────────────
/** 워크로드 1행 + 펼침 영역. children 이 펼쳤을 때의 내용(파드 표)이다. */
export function WorkloadTable({ rows, renderDetail, showNamespace = false }: {
  rows: AllocWorkloadRow[];
  renderDetail: (w: AllocWorkloadRow) => React.ReactNode;
  /** 여러 NS 가 섞이는 노드 상세에서 워크로드 이름 앞에 NS 를 붙인다. */
  showNamespace?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const key = (w: AllocWorkloadRow) => `${w.namespace}/${w.kind}/${w.name}`;
  const toggle = (k: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  return (
    <div className="rounded-lg border border-border bg-card overflow-x-auto">
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
                    {showNamespace && <span className="text-xs text-muted-foreground">{w.namespace}/</span>}
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
                    <td colSpan={5} className="px-2 py-1.5">{renderDetail(w)}</td>
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

/** NS 내 워크로드 → 파드 드릴다운 (서버 집계 사용). */
export function WorkloadsDrill({ clusterId, namespace }: { clusterId: string; namespace: string }) {
  const { data, isLoading, isError } = useAllocWorkloads(clusterId, namespace, true);
  if (isLoading) return <Skeleton className="h-12 w-full" />;
  if (isError) return <div className="text-sm text-status-critical">워크로드 조회 실패</div>;
  const rows = data?.items ?? [];
  if (!rows.length) return <div className="text-sm text-muted-foreground py-1">워크로드 없음</div>;
  return (
    <WorkloadTable
      rows={rows}
      renderDetail={(w) => <PodsDrill clusterId={clusterId} namespace={namespace} kind={w.kind} name={w.name} />}
    />
  );
}

/** 노드 상세: 워크로드(여러 NS 혼재) → 그 노드에 뜬 파드만 펼침. */
export function NodeWorkloadsDrill({ pods, showNamespace = true }: {
  pods: AllocPodRow[]; showNamespace?: boolean;
}) {
  const rows = useMemo(() => groupPodsByWorkload(pods), [pods]);
  const byKey = useMemo(() => {
    const m = new Map<string, AllocPodRow[]>();
    for (const p of pods) {
      const k = `${p.namespace}/${p.ownerKind || 'Pod'}/${p.ownerName || p.name}`;
      m.set(k, [...(m.get(k) ?? []), p]);
    }
    return m;
  }, [pods]);

  if (!rows.length) return <div className="text-sm text-muted-foreground py-1">워크로드 없음</div>;
  return (
    <WorkloadTable
      rows={rows}
      showNamespace={showNamespace}
      renderDetail={(w) => (
        <PodAllocTable pods={byKey.get(`${w.namespace}/${w.kind}/${w.name}`) ?? []} showNamespace={showNamespace} />
      )}
    />
  );
}
