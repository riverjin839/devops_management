import { Play, Trash2, Clock, Loader2, LayoutDashboard, Pencil, FileText, GripVertical } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Playbook } from '@/types';

interface PlaybookListRowProps {
  playbook: Playbook;
  isRunning: boolean;
  onRun: () => void;
  onDelete: () => void;
  onEdit?: () => void;
  onToggleDashboard?: () => void;
  onViewLog: () => void;
  /** 클러스터 이름을 함께 보여줌 (선택된 클러스터가 여러 개일 때 컨텍스트 식별용) */
  clusterName?: string;
}

const STATUS_CONFIG: Record<string, { dot: string; label: string; text: string }> = {
  healthy: { dot: 'bg-emerald-500', label: 'OK', text: 'text-emerald-600 dark:text-emerald-400' },
  warning: { dot: 'bg-amber-500', label: 'Changed', text: 'text-amber-600 dark:text-amber-400' },
  critical: { dot: 'bg-red-500', label: 'Failed', text: 'text-red-600 dark:text-red-400' },
  running: { dot: 'bg-blue-500', label: 'Running', text: 'text-blue-600 dark:text-blue-400' },
  unknown: { dot: 'bg-slate-400', label: 'Not Run', text: 'text-muted-foreground' },
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

export function PlaybookListRow({
  playbook, isRunning, onRun, onDelete, onEdit, onToggleDashboard, onViewLog, clusterName,
}: PlaybookListRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: playbook.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };

  const effectiveStatus = isRunning ? 'running' : playbook.status;
  const cfg = STATUS_CONFIG[effectiveStatus] ?? STATUS_CONFIG.unknown;
  const totals = playbook.lastResult?.stats?.totals;
  const fileLabel = playbook.playbookFileName || playbook.playbookPath || '(no source)';

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group flex items-center gap-3 px-3 py-2 bg-card border border-border rounded-lg hover:border-primary/40 transition-colors"
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing p-1 text-muted-foreground/30 hover:text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
        title="드래그하여 순서 변경"
        aria-label="드래그하여 순서 변경"
      >
        <GripVertical className="w-3.5 h-3.5" />
      </button>

      {/* Status dot + label */}
      <div className="flex items-center gap-2 w-24 flex-shrink-0">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cfg.dot} ${isRunning ? 'animate-pulse' : ''}`} />
        <span className={`text-sm font-medium ${cfg.text}`}>
          {isRunning ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              Running
            </span>
          ) : cfg.label}
        </span>
      </div>

      {/* Name + description */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold truncate">{playbook.name}</span>
          {clusterName && (
            <span className="text-xs text-muted-foreground/70 px-1.5 py-0.5 rounded bg-secondary/50 truncate">
              {clusterName}
            </span>
          )}
        </div>
        {(playbook.description || fileLabel) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground/80 truncate">
            {playbook.description && <span className="truncate">{playbook.description}</span>}
            {playbook.description && <span aria-hidden>·</span>}
            <span className="font-mono truncate" title={fileLabel}>📄 {fileLabel}</span>
          </div>
        )}
      </div>

      {/* Stats (compact) */}
      {totals ? (
        <div className="hidden md:flex items-center gap-2 text-xs flex-shrink-0 tabular-nums">
          <Stat label="OK"   value={totals.ok}          color="text-emerald-500" />
          <Stat label="Chg"  value={totals.changed}     color="text-amber-500" />
          <Stat label="Fail" value={totals.failures}    color="text-red-500" />
          <Stat label="Unr"  value={totals.unreachable} color="text-orange-500" />
          <Stat label="Skip" value={totals.skipped}     color="text-slate-400" />
        </div>
      ) : (
        <div className="hidden md:block text-xs text-muted-foreground/50 italic flex-shrink-0">no stats</div>
      )}

      {/* Last run */}
      <div className="hidden lg:flex items-center gap-1 text-xs text-muted-foreground w-28 flex-shrink-0">
        <Clock className="w-3 h-3" />
        {formatTimeAgo(playbook.lastRunAt)}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-0.5 flex-shrink-0">
        <button
          onClick={onViewLog}
          disabled={!playbook.lastResult}
          className="p-1.5 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title={playbook.lastResult ? '실행 로그 보기' : '실행 기록 없음'}
          aria-label="실행 로그 보기"
        >
          <FileText className="w-4 h-4" />
        </button>
        {onToggleDashboard && (
          <button
            onClick={onToggleDashboard}
            className={`p-1.5 rounded-md transition-colors ${
              playbook.showOnDashboard
                ? 'bg-primary/15 text-primary'
                : 'hover:bg-primary/10 text-muted-foreground'
            }`}
            title={playbook.showOnDashboard ? 'Remove from Dashboard' : 'Add to Dashboard'}
            aria-label="대시보드 표시 토글"
          >
            <LayoutDashboard className="w-4 h-4" />
          </button>
        )}
        <button
          onClick={onRun}
          disabled={isRunning}
          className="p-1.5 rounded-md hover:bg-primary/10 text-primary transition-colors disabled:opacity-50"
          title="Run playbook"
          aria-label="실행"
        >
          {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
        </button>
        <button
          onClick={onEdit}
          disabled={isRunning || !onEdit}
          className="p-1.5 rounded-md hover:bg-primary/10 text-primary transition-colors disabled:opacity-50"
          title="Edit playbook"
          aria-label="편집"
        >
          <Pencil className="w-4 h-4" />
        </button>
        <button
          onClick={onDelete}
          disabled={isRunning}
          className="p-1.5 rounded-md hover:bg-red-500/10 text-red-500 transition-colors disabled:opacity-50"
          title="Delete playbook"
          aria-label="삭제"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  const v = Number(value ?? 0);
  return (
    <span className={`inline-flex items-baseline gap-0.5 ${v > 0 ? color : 'text-muted-foreground/40'}`}>
      <span className="font-bold">{v}</span>
      <span className="text-xs text-muted-foreground/70">{label}</span>
    </span>
  );
}
