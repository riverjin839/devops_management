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
  neutral:  { icon: Circle,        defaultLabel: '-' },
  loading:  { icon: Loader2,       defaultLabel: '로딩' },
};

// CSS var 기반 — light/dark 에서 모두 자동 동작
const VARIANT_CLS: Record<StatusVariant, string> = {
  healthy:  'bg-[hsl(var(--status-healthy-bg))]  text-[hsl(var(--status-healthy))]  border-[hsl(var(--status-healthy)/0.3)]',
  warning:  'bg-[hsl(var(--status-warning-bg))]  text-[hsl(var(--status-warning))]  border-[hsl(var(--status-warning)/0.3)]',
  critical: 'bg-[hsl(var(--status-critical-bg))] text-[hsl(var(--status-critical))] border-[hsl(var(--status-critical)/0.3)]',
  pending:  'bg-[hsl(var(--status-pending-bg))]  text-[hsl(var(--status-pending))]  border-[hsl(var(--status-pending)/0.3)]',
  info:     'bg-[hsl(var(--status-info-bg))]     text-[hsl(var(--status-info))]     border-[hsl(var(--status-info)/0.3)]',
  neutral:  'bg-[hsl(var(--status-neutral-bg))]  text-[hsl(var(--status-neutral))]  border-[hsl(var(--status-neutral)/0.3)]',
  loading:  'bg-[hsl(var(--status-info-bg))]     text-[hsl(var(--status-info))]     border-[hsl(var(--status-info)/0.3)]',
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
    healthy:  'bg-[hsl(var(--status-healthy))]',
    warning:  'bg-[hsl(var(--status-warning))]',
    critical: 'bg-[hsl(var(--status-critical))]',
    pending:  'bg-[hsl(var(--status-pending))]',
    info:     'bg-[hsl(var(--status-info))]',
    neutral:  'bg-[hsl(var(--status-neutral))]',
    loading:  'bg-[hsl(var(--status-info))]',
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
