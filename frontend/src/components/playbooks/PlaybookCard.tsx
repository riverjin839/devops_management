import { Play, Trash2, Clock, Loader2, LayoutDashboard, Pencil } from 'lucide-react';
import { Playbook } from '@/types';

interface PlaybookCardProps {
  playbook: Playbook;
  isRunning: boolean;
  onRun: () => void;
  onDelete: () => void;
  onEdit?: () => void;
  onToggleDashboard?: () => void;
}

const statusConfig: Record<string, { color: string; bg: string; label: string }> = {
  healthy: { color: 'text-status-healthy', bg: 'bg-status-healthy/15 border-status-healthy/30', label: 'OK' },
  warning: { color: 'text-status-warning', bg: 'bg-status-warning/15 border-status-warning/30', label: 'Changed' },
  critical: { color: 'text-status-critical', bg: 'bg-status-critical/15 border-status-critical/30', label: 'Failed' },
  running: { color: 'text-blue-400', bg: 'bg-blue-500/15 border-blue-500/30', label: 'Running' },
  unknown: { color: 'text-status-unknown', bg: 'bg-status-unknown/15 border-status-unknown/30', label: 'Not Run' },
};

function formatTimeAgo(dateStr?: string): string {
  if (!dateStr) return 'Never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function PlaybookCard({ playbook, isRunning, onRun, onDelete, onEdit, onToggleDashboard }: PlaybookCardProps) {
  const effectiveStatus = isRunning ? 'running' : playbook.status;
  const config = statusConfig[effectiveStatus] || statusConfig.unknown;
  const result = playbook.lastResult;
  const totals = result?.stats?.totals;

  return (
    <div className={`bg-card border rounded-xl p-5 transition-all hover:shadow-md ${config.bg}`}>
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-sm truncate">{playbook.name}</h3>
          {playbook.description && (
            <p className="text-sm text-muted-foreground mt-0.5 truncate">{playbook.description}</p>
          )}
        </div>
        <span className={`text-sm font-medium px-2 py-0.5 rounded-full border ${config.bg} ${config.color}`}>
          {isRunning ? (
            <span className="flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              Running
            </span>
          ) : config.label}
        </span>
      </div>

      {/* Playbook 출처 — DB 파일명 우선, 없으면 path */}
      <div className="text-sm text-muted-foreground font-mono bg-background/50 rounded px-2 py-1 mb-3 space-y-0.5">
        {playbook.playbookFileName ? (
          <div className="truncate">
            <span className="text-foreground/80">📄 {playbook.playbookFileName}</span>
            {playbook.inventoryName && (
              <span className="ml-2 text-foreground/60">· {playbook.inventoryName}</span>
            )}
          </div>
        ) : playbook.playbookPath ? (
          <div className="truncate">{playbook.playbookPath}</div>
        ) : (
          <div className="italic text-muted-foreground">(no playbook source)</div>
        )}
      </div>

      {/* Stats (if available) */}
      {totals && (
        <div className="grid grid-cols-5 gap-1 mb-3">
          <StatBadge label="OK" value={totals.ok} color="text-status-healthy" />
          <StatBadge label="Chg" value={totals.changed} color="text-status-warning" />
          <StatBadge label="Fail" value={totals.failures} color="text-status-critical" />
          <StatBadge label="Unr" value={totals.unreachable} color="text-orange-400" />
          <StatBadge label="Skip" value={totals.skipped} color="text-status-unknown" />
        </div>
      )}

      {/* Message */}
      {result?.message && (
        <p className="text-sm text-muted-foreground mb-3 line-clamp-2">{String(result.message)}</p>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-2 border-t border-border/50">
        <div className="flex items-center gap-1 text-sm text-muted-foreground">
          <Clock className="w-3 h-3" />
          {formatTimeAgo(playbook.lastRunAt)}
          {result?.durationMs != null && (
            <span className="ml-1">({Number(result.durationMs)}ms)</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {onToggleDashboard && (
            <button
              onClick={onToggleDashboard}
              className={`p-1.5 rounded-md transition-colors ${
                playbook.showOnDashboard
                  ? 'bg-primary/15 text-primary'
                  : 'hover:bg-primary/10 text-muted-foreground'
              }`}
              title={playbook.showOnDashboard ? 'Remove from Dashboard' : 'Add to Dashboard'}
            >
              <LayoutDashboard className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={onRun}
            disabled={isRunning}
            className="p-1.5 rounded-md hover:bg-primary/10 text-primary transition-colors disabled:opacity-50"
            title="Run playbook"
          >
            {isRunning ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
          </button>
          <button
            onClick={onEdit}
            disabled={isRunning || !onEdit}
            className="p-1.5 rounded-md hover:bg-primary/10 text-primary transition-colors disabled:opacity-50"
            title="Edit playbook"
          >
            <Pencil className="w-4 h-4" />
          </button>
          <button
            onClick={onDelete}
            disabled={isRunning}
            className="p-1.5 rounded-md hover:bg-status-critical/10 text-status-critical transition-colors disabled:opacity-50"
            title="Delete playbook"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function StatBadge({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="text-center">
      <div className={`text-sm font-bold ${value > 0 ? color : 'text-muted-foreground'}`}>
        {value}
      </div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
