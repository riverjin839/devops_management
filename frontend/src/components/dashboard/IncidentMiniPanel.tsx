import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, AlertTriangle, XCircle, ExternalLink } from 'lucide-react';
import { useDailyCheckSummary } from '@/hooks/useDailyCheck';

export function IncidentMiniPanel() {
  const [collapsed, setCollapsed] = useState(true);
  const { data: summary = [] } = useDailyCheckSummary();

  const incidents = summary
    .filter((s) => s.status === 'critical' || s.status === 'warning')
    .sort((a, b) => {
      if (a.status === b.status) return 0;
      return a.status === 'critical' ? -1 : 1;
    });

  const criticalCount = incidents.filter((s) => s.status === 'critical').length;
  const warningCount  = incidents.filter((s) => s.status === 'warning').length;

  if (incidents.length === 0) return null;

  return (
    <div className="rounded-md border border-border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
      >
        {collapsed ? (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        )}
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          인시던트 현황
        </span>
        {criticalCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-red-600 dark:text-red-400 ml-2">
            <XCircle className="w-3 h-3" />
            위험 {criticalCount}
          </span>
        )}
        {warningCount > 0 && (
          <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 ml-1">
            <AlertTriangle className="w-3 h-3" />
            경고 {warningCount}
          </span>
        )}
        <Link
          to="/daily-check/review"
          onClick={(e) => e.stopPropagation()}
          className="ml-auto flex items-center gap-1 text-xs text-primary hover:underline"
        >
          전체보기
          <ExternalLink className="w-3 h-3" />
        </Link>
      </button>

      {!collapsed && (
        <div className="border-t border-border divide-y divide-border">
          {incidents.slice(0, 5).map((item) => (
            <Link
              key={item.cluster_id}
              to={`/daily-check/review?cluster=${item.cluster_id}`}
              className="flex items-start gap-2 px-3 py-2 hover:bg-muted/40 transition-colors"
            >
              {item.status === 'critical' ? (
                <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
              )}
              <div className="min-w-0">
                <span className="text-[12px] font-medium truncate block">{item.cluster_name}</span>
                {item.latest_check?.error_messages?.[0] && (
                  <span className="text-xs text-muted-foreground truncate block">
                    {item.latest_check.error_messages[0]}
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
