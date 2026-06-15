import { CheckLog } from '@/types';
import { StatusDot } from './StatusBadge';
import { formatDateTime } from '@/lib/utils';

interface HistoryLogProps {
  logs: CheckLog[];
  isLoading?: boolean;
  maxItems?: number;
  onViewAll?: () => void;
}

export function HistoryLog({ logs, isLoading, maxItems = 10, onViewAll }: HistoryLogProps) {
  const displayLogs = logs.slice(0, maxItems);

  return (
    <div className="max-h-80 overflow-y-auto">
      {onViewAll && (
        <div className="px-5 py-2.5 border-b border-border flex justify-end">
          <button
            onClick={onViewAll}
            className="px-3 py-1 text-sm font-medium bg-secondary hover:bg-secondary/80 rounded-lg transition-colors"
          >
            View All
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="p-5 space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-14 bg-secondary/50 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : displayLogs.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">
          No check history available
        </div>
      ) : (
        displayLogs.map((log) => (
          <div
            key={log.id}
            className="flex items-center px-5 py-3.5 border-b border-border/60 last:border-b-0 hover:bg-secondary/30 transition-colors"
          >
            <StatusDot status={log.status} size="md" />
            <div className="ml-3 flex-1 min-w-0">
              <p className="text-sm truncate">{log.message}</p>
              <p className="text-xs text-muted-foreground font-mono mt-0.5">
                {formatDateTime(log.checkedAt)}
              </p>
            </div>
            <span className="ml-3 px-2 py-0.5 bg-secondary rounded-md text-xs font-mono text-muted-foreground">
              {log.clusterName}
            </span>
          </div>
        ))
      )}
    </div>
  );
}
