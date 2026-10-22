import { Ban, Loader2 } from 'lucide-react';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useCancelPlaybookRun } from '@/hooks/usePlaybook';
import { usePlaybookStore } from '@/stores/playbookStore';

/**
 * 진행 중인 플레이북 실행 취소(R2) — 실행 로그 패널 헤더(`RunLogPanel` `actions`)에 둔다.
 * 진행 중 실행이 없으면 그리지 않는다. 서버 실행 스레드가 1초 안에 ansible 프로세스를 끊고,
 * 각 실행의 로그에 "취소" 줄이 이어서 찍힌다. `onRequested` 로 요청 결과를 실행 로그에 남긴다.
 */
export function CancelPlaybookRunsButton({ onRequested }: { onRequested?: (requested: number, failed: number) => void }) {
  const activeRuns = usePlaybookStore((s) => s.activeRuns);
  const cancel = useCancelPlaybookRun();
  const { canOperate, withHint, ariaWithHint } = useCanOperate();
  const runIds = Object.values(activeRuns);
  if (runIds.length === 0) return null;
  const label = runIds.length > 1 ? `실행 ${runIds.length}건 취소` : '실행 취소';

  return (
    <button
      type="button"
      onClick={() => cancel.mutate(runIds, {
        onSuccess: (res) => onRequested?.(runIds.length, res.filter((r) => r.status === 'rejected').length),
      })}
      disabled={!canOperate || cancel.isPending}
      title={withHint('진행 중인 ansible-playbook 을 중단한다')}
      aria-label={ariaWithHint(label)}
      className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-xl border border-border bg-background hover:bg-secondary disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {cancel.isPending
        ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
        : <Ban className="w-3.5 h-3.5" aria-hidden="true" />}
      {label}
    </button>
  );
}
