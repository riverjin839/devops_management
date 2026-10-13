import type { StatusVariant } from '@/components/common/StatusBadge';

/**
 * 상태별 라인/점/아이콘 색상 — CSS var 기반이라 라이트/다크에서 자동 대응.
 * SVG fill/stroke 속성값이라 Tailwind 클래스가 아닌 hsl() 문자열이다.
 * D-119: 정상(healthy)·중립은 무채색, pending 은 status-unknown.
 */
export const STATUS_COLOR: Record<StatusVariant, string> = {
  healthy: 'hsl(var(--muted-foreground))',
  warning: 'hsl(var(--status-warning))',
  critical: 'hsl(var(--status-critical))',
  pending: 'hsl(var(--status-unknown))',
  info: 'hsl(var(--status-info))',
  neutral: 'hsl(var(--muted-foreground))',
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
