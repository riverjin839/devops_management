// DESIGN_SYSTEM.md §4 Health Hero — Asymmetric Bento Grid(12-col).
// 좌측 큰 셀(Bullet Chart) + 우측 4개 KPI 셀. 그림자 없이 --card-shadow: none 철학 유지.
import type { ComponentType } from 'react';
import { CheckCircle, AlertTriangle, XCircle, Clock } from 'lucide-react';
import type { SummaryStats as SummaryStatsType } from '@/types';
import { MacCard } from '@/components/ui/MacCard';
import { BulletChart } from '@/components/ui/BulletChart';
import { formatRelativeTime } from '@/lib/utils';

interface HealthHeroProps {
  stats: SummaryStatsType;
  isLoading?: boolean;
  lastCheckTime?: string | null;
}

interface KpiCellProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  colorClass: string;
  bgClass: string;
  className?: string;
}

function KpiCell({ icon: Icon, label, value, colorClass, bgClass, className = '' }: KpiCellProps) {
  return (
    <MacCard rootClassName={className} bodyPadding="p-4">
      <div className="flex items-center justify-between h-full">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-1.5 truncate">
            {label}
          </p>
          <p className={`font-bold font-mono leading-none ${colorClass} ${typeof value === 'number' ? 'text-3xl' : 'text-lg'}`}>
            {value}
          </p>
        </div>
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${bgClass}`}>
          <Icon className={`w-5 h-5 ${colorClass}`} />
        </div>
      </div>
    </MacCard>
  );
}

const defaultStats: SummaryStatsType = { totalClusters: 0, healthy: 0, warning: 0, critical: 0 };

export function HealthHero({ stats, isLoading, lastCheckTime }: HealthHeroProps) {
  const s = stats ?? defaultStats;

  if (isLoading) {
    return (
      <div className="grid grid-cols-12 gap-3 mb-3">
        <div className="col-span-12 lg:col-span-6 lg:row-span-2 bg-card rounded-md border border-border h-52 animate-pulse" />
        {[...Array(4)].map((_, i) => (
          <div key={i} className="col-span-6 lg:col-span-3 bg-card rounded-md border border-border h-24 animate-pulse" />
        ))}
      </div>
    );
  }

  const total = s.totalClusters;
  const healthyPct = total > 0 ? Math.round((s.healthy / total) * 100) : 0;
  const overallLabel = total === 0 ? '데이터 없음' : s.critical > 0 ? '위험' : s.warning > 0 ? '주의 필요' : '정상';
  const overallColor = total === 0
    ? 'text-muted-foreground'
    : s.critical > 0 ? 'text-status-critical' : s.warning > 0 ? 'text-status-warning' : 'text-status-healthy';

  return (
    <section className="grid grid-cols-12 gap-3 mb-3">
      {/* ── Hero — Bullet Chart ─────────────────────────────────────────── */}
      <MacCard
        title="전체 헬스"
        rootClassName="col-span-12 lg:col-span-6 lg:row-span-2 h-full flex flex-col"
        bodyPadding="p-5"
        className="flex-1 flex flex-col justify-between"
      >
        <div>
          <div className="flex items-baseline gap-2">
            <span className={`text-5xl font-bold font-mono leading-none ${overallColor}`}>{healthyPct}%</span>
            <span className={`text-sm font-semibold ${overallColor}`}>{overallLabel}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            클러스터 {total}개 중 정상 {s.healthy}개
            {lastCheckTime && ` · 마지막 점검 ${formatRelativeTime(lastCheckTime)}`}
          </p>
        </div>
        <div className="mt-5">
          <BulletChart
            value={healthyPct}
            target={100}
            zones={[
              { end: 70, color: 'hsl(var(--status-critical-bg))', label: '위험' },
              { end: 90, color: 'hsl(var(--status-warning-bg))', label: '주의' },
              { end: 100, color: 'hsl(var(--status-healthy-bg))', label: '정상' },
            ]}
            ariaLabel={`전체 헬스 ${healthyPct}% (${overallLabel}), 목표 100% 정상`}
          />
          <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
            <span>0%</span>
            <span>목표 100% 정상</span>
          </div>
        </div>
      </MacCard>

      {/* ── KPI 4셀 ─────────────────────────────────────────────────────── */}
      <KpiCell className="col-span-6 lg:col-span-3" icon={XCircle} label="위험" value={s.critical}
        colorClass="text-status-critical" bgClass="bg-status-critical/10" />
      <KpiCell className="col-span-6 lg:col-span-3" icon={AlertTriangle} label="경고" value={s.warning}
        colorClass="text-status-warning" bgClass="bg-status-warning/10" />
      <KpiCell className="col-span-6 lg:col-span-3" icon={CheckCircle} label="정상" value={s.healthy}
        colorClass="text-status-healthy" bgClass="bg-status-healthy/10" />
      <KpiCell className="col-span-6 lg:col-span-3" icon={Clock} label="마지막 점검"
        value={lastCheckTime ? formatRelativeTime(lastCheckTime) : '-'}
        colorClass="text-foreground" bgClass="bg-primary/10" />
    </section>
  );
}
