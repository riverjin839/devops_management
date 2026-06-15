import { cn, getStatusColor, getStatusBgColor } from '@/lib/utils';
import { Status } from '@/types';

interface StatusBadgeProps {
  status: Status;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
}

const statusLabels: Record<Status, string> = {
  healthy: 'Healthy',
  warning: 'Warning',
  critical: 'Critical',
  pending: '임시등록',
};

export function StatusBadge({ status, size = 'md', showLabel = true }: StatusBadgeProps) {
  const sizeClasses = {
    sm: 'px-2 py-0.5 text-sm',
    md: 'px-2.5 py-1 text-sm',
    lg: 'px-3 py-1.5 text-sm',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full font-semibold uppercase tracking-wide',
        sizeClasses[size],
        getStatusBgColor(status),
        getStatusColor(status)
      )}
    >
      {showLabel && statusLabels[status]}
    </span>
  );
}

interface StatusDotProps {
  status: Status;
  size?: 'sm' | 'md' | 'lg';
  pulse?: boolean;
}

export function StatusDot({ status, size = 'md', pulse = false }: StatusDotProps) {
  const sizeClasses = {
    sm: 'w-2 h-2',
    md: 'w-2.5 h-2.5',
    lg: 'w-3 h-3',
  };

  const colorClasses = {
    healthy: 'bg-status-healthy',
    warning: 'bg-status-warning',
    critical: 'bg-status-critical',
    pending: 'bg-slate-400',
  };

  return (
    <span
      className={cn(
        'inline-block rounded-full',
        sizeClasses[size],
        colorClasses[status],
        pulse && 'animate-pulse-slow'
      )}
    />
  );
}
