import { CheckCircle, AlertTriangle, XCircle, WifiOff } from 'lucide-react';
import type { LakeStatus } from '@/types';

const STATUS_MAP: Record<LakeStatus, { label: string; cls: string; icon: typeof CheckCircle }> = {
  healthy:  { label: '정상',  cls: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30', icon: CheckCircle },
  warning:  { label: '경고',  cls: 'bg-amber-500/10 text-amber-500 border-amber-500/30',       icon: AlertTriangle },
  critical: { label: '위험',  cls: 'bg-red-500/10 text-red-500 border-red-500/30',             icon: XCircle },
  pending:  { label: '미연결', cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30',      icon: WifiOff },
};

interface HealthBadgeProps {
  status: LakeStatus;
  size?: 'sm' | 'md';
  showIcon?: boolean;
}

export function HealthBadge({ status, size = 'sm', showIcon = true }: HealthBadgeProps) {
  const meta = STATUS_MAP[status] ?? STATUS_MAP.pending;
  const Icon = meta.icon;
  const sizeCls = size === 'sm' ? 'text-[11px] px-2 py-0.5' : 'text-xs px-2.5 py-1';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border ${meta.cls} ${sizeCls} font-medium`}
      aria-label={`상태: ${meta.label}`}
    >
      {showIcon && <Icon className={size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5'} />}
      {meta.label}
    </span>
  );
}
