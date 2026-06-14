import { SummaryStats as SummaryStatsType } from '@/types';
import { MacCard } from '@/components/ui/MacCard';

interface SummaryStatsProps {
  stats: SummaryStatsType;
  isLoading?: boolean;
}

interface StatCardProps {
  title: string;
  value: number;
  icon: string;
  colorClass: string;
  bgClass: string;
}

function StatCard({ title, value, icon, colorClass, bgClass }: StatCardProps) {
  return (
    <MacCard bodyPadding="p-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">
            {title}
          </p>
          <p className={`text-4xl font-bold font-mono leading-none ${colorClass}`}>{value}</p>
        </div>
        <div className={`w-13 h-13 w-12 h-12 rounded-2xl flex items-center justify-center text-2xl ${bgClass}`}>
          {icon}
        </div>
      </div>
    </MacCard>
  );
}

const defaultStats: SummaryStatsType = { totalClusters: 0, healthy: 0, warning: 0, critical: 0 };

export function SummaryStats({ stats, isLoading }: SummaryStatsProps) {
  const s = stats ?? defaultStats;

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-card rounded-2xl border border-border h-24 animate-pulse mac-shadow" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      <StatCard title="Total Clusters" value={s.totalClusters} icon="☸"  colorClass="text-foreground"      bgClass="bg-primary/10" />
      <StatCard title="Healthy"         value={s.healthy}        icon="✓"  colorClass="text-status-healthy" bgClass="bg-status-healthy/10" />
      <StatCard title="Warning"         value={s.warning}        icon="!"  colorClass="text-status-warning" bgClass="bg-status-warning/10" />
      <StatCard title="Critical"        value={s.critical}       icon="✕"  colorClass="text-status-critical" bgClass="bg-status-critical/10" />
    </div>
  );
}
