import type { StatusVariant } from '@/components/common/StatusBadge';

/** 상태별 라인/점/아이콘 색상 — CSS var 기반이라 라이트/다크에서 자동 대응 */
export const STATUS_COLOR: Record<StatusVariant, string> = {
  healthy: 'hsl(var(--status-healthy))',
  warning: 'hsl(var(--status-warning))',
  critical: 'hsl(var(--status-critical))',
  pending: 'hsl(var(--status-pending))',
  info: 'hsl(var(--status-info))',
  neutral: 'hsl(var(--status-neutral))',
  loading: 'hsl(var(--status-info))',
};

/** 상태가 급할수록(critical) 점 흐름이 빨라지고, 평온할수록(healthy) 느긋하게 흐른다 */
export const STATUS_FLOW_DURATION: Record<StatusVariant, string> = {
  healthy: '2.4s',
  warning: '1.5s',
  critical: '0.85s',
  pending: '3.5s',
  info: '2s',
  neutral: '3.5s',
  loading: '2s',
};

export const STATUS_KEYS: StatusVariant[] = [
  'healthy', 'warning', 'critical', 'pending', 'info', 'neutral', 'loading',
];
