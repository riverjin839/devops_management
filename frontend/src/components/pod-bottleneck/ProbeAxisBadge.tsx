import { Activity, Gauge, Globe, Network } from 'lucide-react';
import type { ComponentType } from 'react';

// axis 별 색상 + 아이콘 매핑 — Design §5.3 PROBE_CATALOG 의 axis 와 일치
const AXIS_MAP: Record<string, { cls: string; icon: ComponentType<{ className?: string }>; label: string }> = {
  'L4 state':    { cls: 'bg-blue-500/10 text-blue-500 border-blue-500/30',     icon: Activity, label: 'L4 state' },
  'L4 counters': { cls: 'bg-violet-500/10 text-violet-500 border-violet-500/30', icon: Gauge,   label: 'L4 counters' },
  'L7 DNS':      { cls: 'bg-status-healthy/10 text-status-healthy border-status-healthy/30', icon: Globe, label: 'L7 DNS' },
  'K8s control': { cls: 'bg-status-warning/10 text-status-warning border-status-warning/30',   icon: Network, label: 'K8s control' },
};

interface ProbeAxisBadgeProps {
  axis: string;
}

export function ProbeAxisBadge({ axis }: ProbeAxisBadgeProps) {
  const meta = AXIS_MAP[axis] ?? { cls: 'bg-status-unknown/10 text-status-unknown border-status-unknown/30', icon: Activity, label: axis };
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${meta.cls}`}
      aria-label={`Axis: ${meta.label}`}
    >
      <Icon className="w-3 h-3" />
      {meta.label}
    </span>
  );
}
