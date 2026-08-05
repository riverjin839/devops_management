/* eslint-disable react-refresh/only-export-components -- STATE_META/TRIGGER_LABEL shared alongside RunStateBadge, same pattern as StatusBadge.tsx */
// 수행 로그 상태/트리거 배지 — CheckMatrixRunLog.tsx 와 CheckMatrixRunbookPanel.tsx 양쪽에서
// 쓰는데, 두 파일이 서로를 import 하므로(RunLog → RunbookPanel: 과거 스냅샷 렌더 /
// RunbookPanel → RunLog: 최근 수행 상태 배지) 순환 참조를 피하려 배지만 별도 파일로 뺀다.
import { Check, X, Loader2, Clock, SkipForward } from 'lucide-react';
import type { CheckMatrixRunState, CheckMatrixTrigger } from '@/types';

export const STATE_META: Record<CheckMatrixRunState, { label: string; cls: string; icon: typeof Check }> = {
  queued: { label: '대기열', cls: 'text-muted-foreground border-border', icon: Clock },
  running: { label: '실행 중', cls: 'text-status-warning border-status-warning/50', icon: Loader2 },
  success: { label: '완료', cls: 'text-status-healthy border-status-healthy/50', icon: Check },
  failed: { label: '실패', cls: 'text-status-critical border-status-critical/50', icon: X },
  skipped: { label: '건너뜀', cls: 'text-muted-foreground border-border', icon: SkipForward },
};

export const TRIGGER_LABEL: Record<CheckMatrixTrigger, string> = {
  cron: '자동(cron)',
  manual_cell: '수동 · 셀',
  manual_cluster: '수동 · 클러스터',
  manual_item: '수동 · 항목',
  manual_entry: '수동 입력',
};

export function RunStateBadge({ state }: { state: CheckMatrixRunState }) {
  const meta = STATE_META[state] ?? STATE_META.queued;
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium ${meta.cls}`}
    >
      <Icon className={`w-3 h-3 ${state === 'running' ? 'animate-spin' : ''}`} />
      {meta.label}
    </span>
  );
}
