import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ClipboardCheck, LayoutGrid, List as ListIcon, ArrowRight,
  AlertTriangle, CheckCircle2, Server,
} from 'lucide-react';
import { useDailyCheckSummary, type DailyCheckSummaryItem } from '@/hooks/useDailyCheck';
import { ViewModeBar } from '@/components/common';

type Status = 'healthy' | 'warning' | 'critical';
const STATUS_META: Record<Status, { dot: string; text: string; label: string }> = {
  healthy:  { dot: 'bg-emerald-500', text: 'text-emerald-600', label: '정상' },
  warning:  { dot: 'bg-amber-500',   text: 'text-amber-600',   label: '주의' },
  critical: { dot: 'bg-red-500',     text: 'text-red-600',     label: '위험' },
};
const RANK: Record<Status, number> = { critical: 0, warning: 1, healthy: 2 };

function fmtTime(t?: string | null): string {
  if (!t) return '점검 기록 없음';
  const d = new Date(t.endsWith('Z') || t.includes('+') ? t : t + 'Z');
  if (isNaN(d.getTime())) return t.slice(5, 16).replace('T', ' ');
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function issueCount(it: DailyCheckSummaryItem): { err: number; warn: number } {
  return {
    err: it.latest_check?.error_messages?.length ?? 0,
    warn: it.latest_check?.warning_messages?.length ?? 0,
  };
}

export function DailyCheckReviewPanel() {
  const { data = [], isLoading } = useDailyCheckSummary();
  const [view, setView] = useState<'list' | 'card'>('list');

  const items = useMemo(
    () => [...data].sort((a, b) => (RANK[a.status as Status] ?? 3) - (RANK[b.status as Status] ?? 3)),
    [data],
  );
  const counts = useMemo(() => {
    const c = { healthy: 0, warning: 0, critical: 0 };
    for (const it of data) c[(it.status as Status) ?? 'healthy'] = (c[(it.status as Status) ?? 'healthy'] ?? 0) + 1;
    return c;
  }, [data]);

  return (
    <div className="rounded-md border border-border bg-card overflow-hidden flex flex-col">
      <div className="flex-none flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/40">
        <ClipboardCheck className="w-4 h-4 text-primary flex-shrink-0" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground select-none">
          일일 점검 리뷰
        </span>
        {/* 상태 요약 */}
        <div className="flex items-center gap-2 text-[11px] ml-1">
          {counts.critical > 0 && <span className="text-red-600">위험 {counts.critical}</span>}
          {counts.warning > 0 && <span className="text-amber-600">주의 {counts.warning}</span>}
          <span className="text-emerald-600">정상 {counts.healthy}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <ViewModeBar
            modes={[
              { id: 'list', label: '리스트', icon: <ListIcon className="w-3.5 h-3.5" /> },
              { id: 'card', label: '카드', icon: <LayoutGrid className="w-3.5 h-3.5" /> },
            ]}
            active={view}
            onChange={(v) => setView(v as 'list' | 'card')}
            showStylePanel={false}
          />
          <Link
            to="/daily-check/review"
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors"
          >
            전체 리뷰 <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      </div>

      {isLoading ? (
        <div className="p-3 space-y-1.5">
          {[0, 1, 2].map((i) => <div key={i} className="h-8 rounded bg-secondary/40 animate-pulse" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          점검 결과가 없습니다. 클러스터 점검 후 표시됩니다.
        </div>
      ) : view === 'list' ? (
        <div className="divide-y divide-border/50">
          {items.map((it) => {
            const meta = STATUS_META[(it.status as Status) ?? 'healthy'] ?? STATUS_META.healthy;
            const { err, warn } = issueCount(it);
            return (
              <Link
                key={it.cluster_id}
                to="/daily-check/review"
                className="flex items-center gap-2 px-4 py-2 hover:bg-secondary/40 transition-colors text-sm"
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${meta.dot}`} />
                <span className="font-medium truncate flex-1 min-w-0">{it.cluster_name}</span>
                {it.latest_check && (
                  <span className="hidden sm:inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Server className="w-3 h-3" />
                    {it.latest_check.ready_nodes ?? '–'}/{it.latest_check.total_nodes ?? '–'}
                  </span>
                )}
                {err > 0 && <span className="text-[11px] text-red-600 inline-flex items-center gap-0.5"><AlertTriangle className="w-3 h-3" />{err}</span>}
                {warn > 0 && <span className="text-[11px] text-amber-600">⚠{warn}</span>}
                {err === 0 && warn === 0 && it.latest_check && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
                <span className="text-[11px] text-muted-foreground font-mono w-24 text-right flex-shrink-0">
                  {fmtTime(it.latest_check?.checked_at)}
                </span>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="p-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
          {items.map((it) => {
            const meta = STATUS_META[(it.status as Status) ?? 'healthy'] ?? STATUS_META.healthy;
            const { err, warn } = issueCount(it);
            return (
              <Link
                key={it.cluster_id}
                to="/daily-check/review"
                className="rounded-lg border border-border bg-card/40 hover:border-primary/30 p-3 transition-colors"
              >
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
                  <span className="font-semibold text-sm truncate flex-1 min-w-0">{it.cluster_name}</span>
                  <span className={`text-[10px] font-medium ${meta.text}`}>{meta.label}</span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-0.5">
                    <Server className="w-3 h-3" />
                    {it.latest_check?.ready_nodes ?? '–'}/{it.latest_check?.total_nodes ?? '–'} 노드
                  </span>
                  {err > 0 && <span className="text-red-600">오류 {err}</span>}
                  {warn > 0 && <span className="text-amber-600">경고 {warn}</span>}
                </div>
                <div className="text-[10px] text-muted-foreground/80 font-mono mt-1">{fmtTime(it.latest_check?.checked_at)}</div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
