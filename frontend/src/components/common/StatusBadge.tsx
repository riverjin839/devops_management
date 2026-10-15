/* eslint-disable react-refresh/only-export-components */
import { memo, type ComponentType } from 'react';
import {
  CheckCircle2, AlertTriangle, XCircle, WifiOff, Info, Circle, Loader2,
} from 'lucide-react';

export type StatusVariant =
  | 'healthy'
  | 'warning'
  | 'critical'
  | 'pending'
  | 'info'
  | 'neutral'
  | 'loading';

interface StatusBadgeProps {
  variant: StatusVariant;
  label?: string;
  /** 아이콘 표시 여부 (기본 true) */
  icon?: boolean;
  /** 아이콘 덮어쓰기 */
  iconOverride?: ComponentType<{ className?: string }>;
  size?: 'sm' | 'md';
  className?: string;
  title?: string;
}

const VARIANT_META: Record<StatusVariant, { icon: ComponentType<{ className?: string }>; defaultLabel: string }> = {
  healthy:  { icon: CheckCircle2,  defaultLabel: '정상' },
  warning:  { icon: AlertTriangle, defaultLabel: '경고' },
  critical: { icon: XCircle,       defaultLabel: '위험' },
  pending:  { icon: WifiOff,       defaultLabel: '미연결' },
  info:     { icon: Info,          defaultLabel: 'Info' },
  neutral:  { icon: Circle,        defaultLabel: '—' },
  loading:  { icon: Loader2,       defaultLabel: '로딩' },
};

// 상태 토큰 — 글자는 4.5:1 대비를 보장하는 text-status-*(→ --status-*-text), 면은 bg/border-status-*/N.
// 정상(healthy)·중립은 색을 쓰지 않는다 — 상태색은 비정상에만 (DESIGN_SYSTEM §12.12-3, D-119·D-132).
const VARIANT_CLS: Record<StatusVariant, string> = {
  healthy:  'bg-secondary text-muted-foreground border-border',
  warning:  'bg-status-warning/10 text-status-warning border-status-warning/30',
  critical: 'bg-status-critical/10 text-status-critical border-status-critical/30',
  pending:  'bg-status-unknown/10 text-status-unknown border-status-unknown/30',
  info:     'bg-status-info/10 text-status-info border-status-info/30',
  neutral:  'bg-secondary text-muted-foreground border-border',
  loading:  'bg-status-info/10 text-status-info border-status-info/30',
};

function StatusBadgeBase({
  variant, label, icon = true, iconOverride, size = 'sm', className = '', title,
}: StatusBadgeProps) {
  const meta = VARIANT_META[variant];
  const Icon = iconOverride ?? meta.icon;
  const displayLabel = label ?? meta.defaultLabel;
  const sizeCls = size === 'md'
    ? 'text-sm px-2 py-0.5'
    : 'text-xs px-1.5 py-0.5';
  const iconCls = size === 'md' ? 'w-3.5 h-3.5' : 'w-3 h-3';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-medium ${sizeCls} ${VARIANT_CLS[variant]} ${className}`}
      title={title ?? displayLabel}
    >
      {icon && <Icon className={`${iconCls} ${variant === 'loading' ? 'animate-spin' : ''}`} />}
      {displayLabel}
    </span>
  );
}

export const StatusBadge = memo(StatusBadgeBase);

// ── 더 작은 dot (테이블 셀 왼쪽 등) ─────────────────────────────────
interface StatusDotProps {
  variant: StatusVariant;
  pulse?: boolean;
  className?: string;
  title?: string;
}

export function StatusDot({ variant, pulse = false, className = '', title }: StatusDotProps) {
  const colorMap: Record<StatusVariant, string> = {
    healthy:  'bg-muted-foreground/40',
    warning:  'bg-status-warning',
    critical: 'bg-status-critical',
    pending:  'bg-status-unknown',
    info:     'bg-status-info',
    neutral:  'bg-muted-foreground/40',
    loading:  'bg-status-info',
  };
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${colorMap[variant]} ${pulse ? 'animate-pulse-slow' : ''} ${className}`}
      title={title}
      aria-hidden="true"
    />
  );
}

/** cluster.status 같은 string 에서 variant 로 매핑 */
export function statusToVariant(status: string | null | undefined): StatusVariant {
  switch (status) {
    case 'healthy': return 'healthy';
    case 'warning': return 'warning';
    case 'critical': return 'critical';
    case 'pending': return 'pending';
    case 'ok': return 'healthy';
    case 'error': return 'critical';
    case 'timeout': return 'warning';
    case 'auth_error':
    case 'connect_error': return 'critical';
    default: return 'neutral';
  }
}
