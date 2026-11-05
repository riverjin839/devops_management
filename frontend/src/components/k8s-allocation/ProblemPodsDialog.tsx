// 요약 칩(Pod 오류 · Pod 대기 · request 미설정) 상세 팝업 — 해당 Pod 목록과 사유.
// 칩의 숫자만으로는 "어느 Pod 가 왜" 인지 알 수 없어, 눌렀을 때 목록을 바로 보여 준다.
import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState, ErrorState, Skeleton } from '@/components/common';
import { useAllocProblemPods } from '@/hooks/useK8sAllocation';
import { buildCsv, downloadCsv } from '@/lib/csv';
import { csvCluster, fmtN, today } from './format';
import { CsvButton, SearchInput } from './primitives';
import { PodPhaseBadge } from './drilldown';
import { fmtTs } from './effUtils';

export type ProblemPodKind = 'error' | 'pending' | 'norequest';

const META: Record<ProblemPodKind, { title: string; desc: string }> = {
  error: { title: 'Pod 오류', desc: 'Error·Failed 상태이거나 CrashLoopBackOff·ImagePull 오류 등 컨테이너가 비정상인 Pod 입니다.' },
  pending: { title: 'Pod 대기', desc: 'Pending 상태 — 스케줄 대기 중이거나 이미지·볼륨 준비 중인 Pod 입니다.' },
  norequest: { title: 'request 미설정 Pod', desc: 'CPU·메모리 request 가 모두 없는 활성 Pod 입니다. 스케줄러가 자원을 계산하지 못해 노드 과밀·OOM 의 원인이 됩니다.' },
};

function Body({ clusterId, kind, clusterName }: { clusterId: string; kind: ProblemPodKind; clusterName?: string }) {
  const { data, isLoading, isError, error, refetch, isFetching } = useAllocProblemPods(clusterId, kind);
  const [q, setQ] = useState('');
  const showReason = kind !== 'norequest';
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const items = data?.items ?? [];
    if (!needle) return items;
    return items.filter((p) => `${p.namespace}/${p.name} ${p.node ?? ''} ${p.reason} ${p.ownerName ?? ''}`.toLowerCase().includes(needle));
  }, [data, q]);

  const exportCsv = () => {
    const headers = ['Namespace', 'Pod', '워크로드', '노드', '상태', ...(showReason ? ['사유'] : []), '재시작', '생성'];
    const out = rows.map((p) => [
      p.namespace, p.name, p.ownerKind ? `${p.ownerKind}/${p.ownerName}` : '', p.node ?? '', p.phase,
      ...(showReason ? [p.reason] : []), p.restarts, p.createdAt ?? '',
    ]);
    downloadCsv(`k8s-alloc-${kind}-pods-${csvCluster(clusterName)}-${today()}.csv`, buildCsv(headers, out));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <SearchInput value={q} onChange={setQ} placeholder="Pod·네임스페이스·노드·사유 찾기" width="w-72" />
        <span className="text-xs text-muted-foreground tabular-nums">
          {data ? `${fmtN(rows.length)} / ${fmtN(data.total)}건` : ''}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <CsvButton onClick={exportCsv} disabled={!rows.length} />
          <button type="button" onClick={() => void refetch()}
            className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} aria-hidden="true" /> 다시 읽기
          </button>
        </div>
      </div>

      {isLoading && !data ? (
        <Skeleton className="h-40 w-full" />
      ) : isError && !data ? (
        <ErrorState error={error} title="Pod 목록을 불러오지 못했습니다" onRetry={() => void refetch()} />
      ) : !rows.length ? (
        <EmptyState title={q.trim() ? '검색 결과 없음' : '해당 Pod 없음'}
          description={q.trim() ? `'${q}' 와 일치하는 Pod 가 없습니다.` : '지금은 해당하는 Pod 가 없습니다(요약은 직전 집계 기준).'} />
      ) : (
        <div className="rounded-md border border-border bg-card overflow-auto max-h-[60vh]">
          <table className="w-full text-sm">
            <thead className="bg-muted/20 text-left text-xs text-muted-foreground sticky top-0">
              <tr>
                <th className="px-2 py-1.5 font-medium">Pod</th>
                <th className="px-2 py-1.5 font-medium">네임스페이스</th>
                <th className="px-2 py-1.5 font-medium">워크로드</th>
                <th className="px-2 py-1.5 font-medium">노드</th>
                <th className="px-2 py-1.5 font-medium">상태</th>
                {showReason && <th className="px-2 py-1.5 font-medium">사유</th>}
                <th className="px-2 py-1.5 font-medium text-right">재시작</th>
                <th className="px-2 py-1.5 font-medium">생성</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={`${p.namespace}/${p.name}`} className="border-t border-border align-top">
                  <td className="px-2 py-1.5 font-medium break-all">{p.name}</td>
                  <td className="px-2 py-1.5 text-xs text-muted-foreground">{p.namespace}</td>
                  <td className="px-2 py-1.5 text-xs text-muted-foreground">
                    {p.ownerKind ? <><span>{p.ownerKind}/</span>{p.ownerName}</> : '—'}
                  </td>
                  <td className="px-2 py-1.5 text-xs text-muted-foreground">{p.node ?? '—'}</td>
                  <td className="px-2 py-1.5"><PodPhaseBadge phase={p.phase} /></td>
                  {showReason && <td className="px-2 py-1.5 text-xs break-words max-w-[28rem]">{p.reason || '—'}</td>}
                  <td className="px-2 py-1.5 text-right tabular-nums">{p.restarts}</td>
                  <td className="px-2 py-1.5 text-xs text-muted-foreground tabular-nums whitespace-nowrap">{fmtTs(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.truncated && (
        <div className="text-sm text-muted-foreground">※ 전체 {fmtN(data.total)}건 중 앞 {fmtN(data.items.length)}건만 표시합니다. 검색·CSV 도 이 범위입니다.</div>
      )}
    </div>
  );
}

export function ProblemPodsDialog({ clusterId, kind, clusterName, onClose }: {
  clusterId: string; kind: ProblemPodKind | null; clusterName?: string; onClose: () => void;
}) {
  const meta = kind ? META[kind] : null;
  return (
    <Dialog open={!!kind} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-none w-[min(96vw,1180px)] px-5 pb-5">
        <DialogHeader className="px-0 pt-0">
          <DialogTitle className="pr-8">{meta?.title}</DialogTitle>
          <DialogDescription>{meta?.desc}</DialogDescription>
        </DialogHeader>
        {kind && <Body key={kind} clusterId={clusterId} kind={kind} clusterName={clusterName} />}
      </DialogContent>
    </Dialog>
  );
}
