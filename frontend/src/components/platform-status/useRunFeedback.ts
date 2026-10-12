import { useCallback } from 'react';
import { useToast } from '@/components/common';
import { useCheckMatrixLogStore } from '@/stores/checkMatrixLogStore';
import type { CheckMatrixBatchResult, CheckMatrixRun } from '@/types';

/**
 * 실행 버튼 공통 피드백 — "실행했다" 는 토스트로 끝내지 않고 언제나 실시간 로그로 이어지게 한다.
 *
 * - 사용자 설정 `autoOpen`(표시 설정의 "실행 시 로그 자동 열기")이 켜져 있으면 로그 패널을 바로 연다.
 * - 꺼져 있어도 토스트에 "로그 보기" 액션을 붙여 언제든 열 수 있다.
 * - 이미 실행 중이던 셀(중복), 새로 큐잉된 것이 없는 일괄 실행, 큐잉 실패를 각각 다른 문구로 알린다.
 */
export function useRunFeedback() {
  const toast = useToast();
  const autoOpen = useCheckMatrixLogStore((s) => s.autoOpen);
  const show = useCheckMatrixLogStore((s) => s.show);

  const cellQueued = useCallback((run: CheckMatrixRun, label: string) => {
    const target = { runId: run.id, label };
    if (autoOpen) show(target);
    toast.show({
      variant: 'info',
      title: run.deduplicated ? '이미 실행 중인 셀입니다' : '실행을 시작했습니다',
      description: run.deduplicated ? `${label} — 진행 중인 실행을 이어서 보여줍니다.` : label,
      action: autoOpen ? undefined : { label: '로그 보기', onClick: () => show(target) },
    });
  }, [autoOpen, show, toast]);

  const batchQueued = useCallback((res: CheckMatrixBatchResult, label: string) => {
    const target = { batchId: res.batchId, label };
    const skipped = res.skipped ?? 0;
    if (res.total === 0) {
      toast.show({
        variant: 'warning',
        title: '새로 시작한 실행이 없습니다',
        description: skipped > 0
          ? `${label} — ${skipped}건이 이미 실행 중입니다.`
          : `${label} — 실행할 대상이 없습니다(실행 권한이 있는 클러스터·자동 점검 항목 없음).`,
      });
      return;
    }
    if (autoOpen) show(target);
    const failed = res.errors?.length ?? 0;
    const parts = [`${res.queued}건 실행 시작`];
    if (skipped > 0) parts.push(`${skipped}건은 이미 실행 중`);
    if (failed > 0) parts.push(`${failed}건 큐잉 실패`);
    toast.show({
      variant: failed > 0 ? 'warning' : 'info',
      title: label,
      description: parts.join(' · '),
      action: autoOpen ? undefined : { label: '로그 보기', onClick: () => show(target) },
    });
  }, [autoOpen, show, toast]);

  return { cellQueued, batchQueued, openLog: show };
}
