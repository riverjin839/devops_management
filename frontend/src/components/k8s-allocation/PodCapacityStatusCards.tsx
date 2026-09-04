// Pod 용량 / 상태 카드 — 개요 스냅샷에서 파생된 pods-summary(요청 스레드가 apiserver 를 치지 않음).
// 카드 2장의 프레임은 항상 유지하고 내부만 교체한다(클러스터 전환/재집계 시 blank-out 방지).
import { MacCard } from '@/components/ui/MacCard';
import { EmptyState, Skeleton } from '@/components/common';
import { usePodsSummary } from '@/hooks/useK8sAllocation';
import { fmtN } from './format';
import { CardHeader, Stat } from './primitives';

const POD_STATUS_META: { key: string; label: string; cls: string }[] = [
  { key: 'running', label: 'Running', cls: 'text-status-healthy' },
  { key: 'pending', label: 'Pending', cls: 'text-status-warning' },
  { key: 'error', label: 'Error', cls: 'text-status-critical' },
  { key: 'failed', label: 'Failed', cls: 'text-status-critical' },
  { key: 'succeeded', label: 'Succeeded', cls: 'text-muted-foreground' },
  { key: 'unknown', label: 'Unknown', cls: 'text-muted-foreground' },
];
// 0개여도 항상 노출하는 핵심 버킷
const POD_STATUS_ALWAYS = ['running', 'pending', 'error'];

export function PodCapacityStatusCards({ clusterId }: { clusterId: string }) {
  const { data, isLoading, isFetching, isError, error, refetch } = usePodsSummary(clusterId);
  const onRefresh = () => { void refetch(); };
  const loading = isLoading && !data;
  const failed = isError && !data;
  const cap = data?.capacity;
  const counts = data?.statusCounts ?? {};
  const computing = data?.status === 'computing' && !data.totalPods;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <MacCard bodyPadding="p-3">
        <CardHeader title="POD 용량" onRefresh={onRefresh} refreshing={isFetching} />
        <div className="min-h-16">
          {loading ? <Skeleton className="h-16 w-full" />
            : failed ? <EmptyState title="조회 실패" description={(error as Error)?.message ?? 'Pod 용량/상태를 불러오지 못했습니다.'} />
            : computing || !cap ? <Skeleton className="h-16 w-full" />
            : (
              <div className="grid grid-cols-3 gap-2">
                <Stat label="스케줄 가능 Pod" value={fmtN(cap.schedulableFreeSlots)}
                  help={<p>Ready·비cordon 노드({cap.nodesSchedulable}/{cap.nodesTotal})의 할당 가능 {fmtN(cap.schedulableAllocatablePods)}개 중 남은 슬롯(현재 파드 개수 기준, 크기 무관).</p>} />
                <Stat label="전체 Pod" value={fmtN(data.totalPods)}
                  help={data.terminalCounted === false ? <p>종료(Succeeded/Failed) 파드는 제외된 수입니다(K8S_ALLOC_COUNT_TERMINAL_PODS=0).</p> : undefined} />
                <Stat label="전체 할당 가능 Pod" value={fmtN(cap.allocatablePods)}
                  help={<p>전체 노드 <code>allocatable.pods</code>(max-pods) 합계.</p>} />
              </div>
            )}
        </div>
      </MacCard>
      <MacCard bodyPadding="p-3">
        <CardHeader title="POD 상태" onRefresh={onRefresh} refreshing={isFetching} />
        <div className="min-h-16">
          {loading || computing || (!data && !failed) ? <Skeleton className="h-16 w-full" />
            : failed ? <EmptyState title="조회 실패" description="Pod 상태를 불러오지 못했습니다." />
            : (
              <div className="grid grid-cols-3 gap-2">
                {POD_STATUS_META
                  .filter((m) => POD_STATUS_ALWAYS.includes(m.key) || (counts[m.key] ?? 0) > 0)
                  .map((m) => (
                    <Stat key={m.key} label={m.label} value={fmtN(counts[m.key] ?? 0)}
                      valueClassName={m.cls}
                      warn={(m.key === 'error' || m.key === 'failed') && (counts[m.key] ?? 0) > 0 ? 'critical' : false} />
                  ))}
              </div>
            )}
        </div>
      </MacCard>
    </div>
  );
}
