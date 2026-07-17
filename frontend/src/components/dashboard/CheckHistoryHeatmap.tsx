// DESIGN_SYSTEM.md §5③ Heat Map — Recent Check History (cluster × time).
// 라이브러리 없이 CSS Grid(table)로 직접 구현. 셀 hover 시 shadcn Tooltip(Base UI)으로 상세 표시.
import { useMemo } from 'react';
import type { CheckLog, Status } from '@/types';
import { parseUTC } from '@/lib/utils';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';

const STATUS_RANK: Record<Status, number> = { critical: 3, warning: 2, pending: 1, healthy: 0 };
const STATUS_CELL_CLASS: Record<Status, string> = {
  critical: 'bg-status-critical',
  warning: 'bg-status-warning',
  healthy: 'bg-status-healthy',
  pending: 'bg-muted-foreground/40',
};
const STATUS_LABEL: Record<Status, string> = { critical: '위험', warning: '경고', healthy: '정상', pending: '미연결' };

interface DayCell {
  worst: Status;
  count: number;
  messages: string[];
}

interface CheckHistoryHeatmapProps {
  logs: CheckLog[];
  isLoading?: boolean;
  /** 표시할 최근 일수 (기본 14일) */
  days?: number;
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function CheckHistoryHeatmap({ logs, isLoading, days = 14 }: CheckHistoryHeatmapProps) {
  const { clusters, dayCols, grid } = useMemo(() => {
    const today = new Date();
    const cols: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      cols.push(dayKey(d));
    }
    const colSet = new Set(cols);

    const clusterSet = new Set<string>();
    const g = new Map<string, Map<string, DayCell>>();

    for (const log of logs) {
      const dk = dayKey(parseUTC(log.checkedAt));
      if (!colSet.has(dk)) continue;
      clusterSet.add(log.clusterName);
      if (!g.has(log.clusterName)) g.set(log.clusterName, new Map());
      const row = g.get(log.clusterName)!;
      const cell = row.get(dk);
      if (!cell) {
        row.set(dk, { worst: log.status, count: 1, messages: [log.message] });
      } else {
        cell.count += 1;
        if (STATUS_RANK[log.status] > STATUS_RANK[cell.worst]) cell.worst = log.status;
        if (cell.messages.length < 3) cell.messages.push(log.message);
      }
    }

    return { clusters: Array.from(clusterSet).sort(), dayCols: cols, grid: g };
  }, [logs, days]);

  if (isLoading) {
    return (
      <div className="p-5 space-y-1.5">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-6 bg-secondary/50 rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (clusters.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        최근 {days}일간 점검 이력이 없습니다.
      </div>
    );
  }

  return (
    <TooltipProvider delay={150}>
      <div className="overflow-x-auto p-4">
        <table className="border-separate" style={{ borderSpacing: '3px' }}>
          <thead>
            <tr>
              <th className="text-left sticky left-0 bg-card">
                <span className="sr-only">클러스터</span>
              </th>
              {dayCols.map((d) => (
                <th key={d} className="text-[10px] font-normal text-muted-foreground w-5" title={d}>
                  {d.slice(5).replace('-', '/')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {clusters.map((clusterName) => (
              <tr key={clusterName}>
                <td className="text-xs text-muted-foreground pr-2 whitespace-nowrap sticky left-0 bg-card">
                  {clusterName}
                </td>
                {dayCols.map((d) => {
                  const cell = grid.get(clusterName)?.get(d);
                  const cls = cell ? STATUS_CELL_CLASS[cell.worst] : 'bg-secondary/40 border border-dashed border-border';
                  const label = `cluster=${clusterName} time=${d} status=${cell?.worst ?? 'no-data'}`;
                  return (
                    <td key={d} className="p-0">
                      <Tooltip>
                        <TooltipTrigger
                          type="button"
                          aria-label={label}
                          className={`block w-5 h-5 rounded ${cls}`}
                        />
                        <TooltipContent>
                          <p className="font-medium">{clusterName} · {d}</p>
                          {cell ? (
                            <>
                              <p>{STATUS_LABEL[cell.worst]} · {cell.count}건</p>
                              {cell.messages.map((m, i) => (
                                <p key={i} className="text-muted-foreground truncate max-w-[220px]">{m}</p>
                              ))}
                            </>
                          ) : (
                            <p className="text-muted-foreground">점검 데이터 없음</p>
                          )}
                        </TooltipContent>
                      </Tooltip>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TooltipProvider>
  );
}
