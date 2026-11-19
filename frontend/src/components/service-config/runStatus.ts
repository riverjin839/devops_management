// 적용 실행 상태 → 배지(정상은 중립색, 비정상만 상태색).
import type { StatusVariant } from '@/components/common';
import type { ServiceConfigApplyRun } from '@/types';

export const RUN_STATUS: Record<ServiceConfigApplyRun['status'], { label: string; variant: StatusVariant }> = {
  running: { label: '실행 중', variant: 'info' },
  succeeded: { label: '성공', variant: 'healthy' },
  partial: { label: '일부 성공', variant: 'warning' },
  failed: { label: '실패', variant: 'critical' },
  stopped: { label: '중지됨', variant: 'warning' },
};
