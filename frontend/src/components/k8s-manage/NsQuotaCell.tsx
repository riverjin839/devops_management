// Namespaces 목록의 ResourceQuota 사용/한도 셀 — "사용 / 한도" + 사용률 막대.
// 정상 범위는 중립색, 80% 이상만 경고·100% 이상만 위험 색(DESIGN_SYSTEM §12.12 #3).
import type { K8sQuotaUsageCell } from '@/types';

export const QUOTA_WARN_RATIO = 0.8;
export const QUOTA_CRIT_RATIO = 1;

function barColor(ratio: number | null): string {
  if (ratio == null) return 'bg-muted-foreground/40';
  if (ratio >= QUOTA_CRIT_RATIO) return 'bg-status-critical';
  if (ratio >= QUOTA_WARN_RATIO) return 'bg-status-warning';
  return 'bg-muted-foreground/50';
}

function pctText(ratio: number | null): string {
  if (ratio == null) return '—';
  return `${Math.round(ratio * 100)}%`;
}

export function NsQuotaCell({ cell, label }: { cell?: K8sQuotaUsageCell; label: string }) {
  if (!cell) return <span className="text-faint">—</span>;
  const pct = cell.ratio == null ? 0 : Math.min(100, Math.max(0, cell.ratio * 100));
  const level = cell.ratio != null && cell.ratio >= QUOTA_CRIT_RATIO ? '초과'
    : cell.ratio != null && cell.ratio >= QUOTA_WARN_RATIO ? '임박' : '';
  const tip = `${label} ${cell.used} / ${cell.hard} (${pctText(cell.ratio)}) · quota ${cell.quota}`;
  return (
    <div className="min-w-0" title={tip}>
      <div className="flex items-baseline justify-between gap-1 text-xs tabular-nums">
        <span className="truncate text-foreground">
          {cell.used}<span className="text-muted-foreground"> / {cell.hard}</span>
        </span>
        <span className={`shrink-0 ${level === '초과' ? 'text-status-critical font-medium' : level === '임박' ? 'text-status-warning font-medium' : 'text-muted-foreground'}`}>
          {pctText(cell.ratio)}
        </span>
      </div>
      <div
        className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-secondary"
        role="meter"
        aria-label={`${label} 사용률`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={`${cell.used} / ${cell.hard}${level ? ` · ${level}` : ''}`}
      >
        <div className={`h-full rounded-full ${barColor(cell.ratio)}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
