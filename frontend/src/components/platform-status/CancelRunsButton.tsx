import { Ban, Loader2 } from 'lucide-react';
import { useToast } from '@/components/common';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useCancelCheckMatrixRuns } from '@/hooks/useCheckMatrix';
import { formatApiError } from '@/lib/utils';

/**
 * 대기/실행 중 수행 취소 — 단건(`runId`) 또는 일괄(`batchId`).
 * 대기 중인 셀은 워커가 집지 않고, 실행 중인 셀은 워커 프로세스를 끊는다. 셀 값은 덮지 않는다(이전 결과 유지).
 */
export function CancelRunsButton({ runId, batchId, clusterId }: { runId?: string; batchId?: string; clusterId?: string }) {
  const toast = useToast();
  const { canOperate, withHint } = useCanOperate(clusterId);
  const cancel = useCancelCheckMatrixRuns();
  const label = batchId ? '남은 실행 모두 취소' : '실행 취소';

  const onClick = () => {
    cancel.mutate({ runId, batchId }, {
      onSuccess: (r) => {
        if (r.cancelled === 0) {
          toast.show({ variant: 'info', title: '취소할 실행이 없습니다', description: '이미 끝났습니다.' });
          return;
        }
        const parts = [`${r.cancelled}건 취소`];
        if (r.wasRunning > 0) parts.push(`실행 중이던 ${r.wasRunning}건은 워커에서 중단`);
        if (r.revokeErrors.length > 0) parts.push('워커 중단 신호 전달 실패 — 남은 단계는 건너뛴다');
        toast.show({ variant: r.revokeErrors.length > 0 ? 'warning' : 'info', title: '실행을 취소했습니다', description: parts.join(' · ') });
      },
      onError: (e) => toast.error('취소 실패', formatApiError(e)),
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!canOperate || cancel.isPending}
      title={withHint(label)}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-xl border border-border hover:bg-secondary text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {cancel.isPending
        ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
        : <Ban className="w-3.5 h-3.5" aria-hidden="true" />}
      {label}
    </button>
  );
}
