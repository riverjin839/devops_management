import { Activity, Gauge, Globe, Network } from 'lucide-react';
import type { ComponentType } from 'react';

// axis 별 색상 + 아이콘 매핑 — Design §5.3 PROBE_CATALOG 의 axis 와 일치
const AXIS_MAP: Record<string, { cls: string; icon: ComponentType<{ className?: string }>; label: string }> = {
  'L4 state':    { cls: 'bg-blue-500/10 text-blue-500 border-blue-500/30',     icon: Activity, label: 'L4 state' },
  'L4 counters': { cls: 'bg-violet-500/10 text-violet-500 border-violet-500/30', icon: Gauge,   label: 'L4 counters' },
  'L7 DNS':      { cls: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30', icon: Globe, label: 'L7 DNS' },
  'K8s control': { cls: 'bg-amber-500/10 text-amber-500 border-amber-500/30',   icon: Network, label: 'K8s control' },
};

interface ProbeAxisBadgeProps {
  axis: string;
}

export function ProbeAxisBadge({ axis }: ProbeAxisBadgeProps) {
  const meta = AXIS_MAP[axis] ?? { cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30', icon: Activity, label: axis };
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
