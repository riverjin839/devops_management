import type { StatusVariant } from '@/components/common/StatusBadge';
import type { AlarmRequestStatus, AlarmSeverity } from '@/types';

export const INPUT =
  'w-full text-sm px-2.5 py-1.5 rounded-xl border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60';
export const CODE_INPUT = `${INPUT} font-mono text-xs bg-secondary/40`;
export const BTN =
  'text-sm inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';
export const BTN_SM =
  'text-xs inline-flex items-center gap-1 px-2.5 py-1 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-50 whitespace-nowrap';
export const BTN_PRIMARY =
  'text-sm inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';
export const BTN_DANGER =
  'text-sm inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-status-critical/40 text-status-critical bg-card hover:bg-status-critical/10 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';

/** 상태색은 비정상·주의가 필요한 상태에만(§12.12-3) — 완료는 중립. */
export const STATUS_VARIANT: Record<AlarmRequestStatus, StatusVariant> = {
  in_progress: 'info',
  done: 'healthy',
  rejected: 'critical',
};

export const STATUS_LABEL: Record<AlarmRequestStatus, string> = {
  in_progress: '진행',
  done: '완료',
  rejected: '반려',
};

export const STATUS_ORDER: AlarmRequestStatus[] = ['in_progress', 'done', 'rejected'];

export const SEVERITY_LABEL: Record<AlarmSeverity, string> = { critical: 'Critical', warning: 'Warning', info: 'Info' };
export const SEVERITY_CLS: Record<AlarmSeverity, string> = {
  critical: 'text-status-critical',
  warning: 'text-status-warning',
  info: 'text-status-info',
};
export const SEVERITY_ORDER: AlarmSeverity[] = ['critical', 'warning', 'info'];

export const ACTION_LABEL: Record<string, string> = {
  created: '요청 등록',
  updated: '요청 수정',
  in_progress: '진행으로 변경',
  done: '완료',
  rejected: '반려',
  // 예전 승인 절차 시절 이력(상태 항목 하나로 바뀌기 전 기록)
  requested: '요청 등록',
  reviewing: '검토 시작(이전 절차)',
  approved: '승인(이전 절차)',
  applied: '반영 완료(이전 절차)',
  rule_applied: 'PrometheusRule 적용',
  rule_apply_failed: 'PrometheusRule 적용 실패',
};

/** Prometheus duration(5m, 1h30m, 30s, 0). 빈 값 허용. */
export const DURATION_RE = /^$|^0$|^(\d+(ms|s|m|h|d|w|y))+$/;
