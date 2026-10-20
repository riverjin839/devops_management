import { Play, Trash2, Clock, Loader2, LayoutDashboard, Pencil, FileText } from 'lucide-react';
import { Playbook } from '@/types';
import { useCanOperate } from '@/hooks/useCanOperate';

interface PlaybookCardProps {
  playbook: Playbook;
  isRunning: boolean;
  onRun: () => void;
  onDelete: () => void;
  onEdit?: () => void;
  onToggleDashboard?: () => void;
}

const statusConfig: Record<string, { color: string; bg: string; label: string }> = {
  // 상태 신호는 상태 pill 하나에만 — 카드 면·보더는 중립, 정상은 무채색(DESIGN_SYSTEM §12.12-3).
  healthy: { color: 'text-muted-foreground', bg: 'border-border', label: '정상' },
  warning: { color: 'text-status-warning', bg: 'border-status-warning/40', label: '변경' },
  critical: { color: 'text-status-critical', bg: 'border-status-critical/40', label: '실패' },
  running: { color: 'text-status-info', bg: 'border-status-info/40', label: '실행 중' },
  unknown: { color: 'text-status-unknown', bg: 'border-border', label: '미실행' },
};

function formatTimeAgo(dateStr?: string): string {
  if (!dateStr) return '실행 기록 없음';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '방금 전';
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

export function PlaybookCard({ playbook, isRunning, onRun, onDelete, onEdit, onToggleDashboard }: PlaybookCardProps) {
  // §12.9 — 실행·수정·삭제·대시보드 토글은 operator 이상 + 클러스터 operate 바인딩. 숨기지 않고 비활성+사유.
  const { canOperate, withHint, ariaWithHint } = useCanOperate(playbook.clusterId);
  const effectiveStatus = isRunning ? 'running' : playbook.status;
  const config = statusConfig[effectiveStatus] || statusConfig.unknown;
  const result = playbook.lastResult;
  const totals = result?.stats?.totals;

  return (
    <div className="bg-card border border-border rounded-md p-5">
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
              실행 중
            </span>
          ) : config.label}
        </span>
      </div>

      {/* Playbook 출처 — DB 파일명 우선, 없으면 path */}
      <div className="text-sm text-muted-foreground font-mono bg-background/50 rounded px-2 py-1 mb-3 space-y-0.5">
        {playbook.playbookFileName ? (
          <div className="truncate">
            <span className="inline-flex items-center gap-1 text-foreground/80"><FileText className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />{playbook.playbookFileName}</span>
            {playbook.inventoryName && (
              <span className="ml-2 text-foreground/60">· {playbook.inventoryName}</span>
            )}
          </div>
        ) : playbook.playbookPath ? (
          <div className="truncate">{playbook.playbookPath}</div>
        ) : (
          <div className="italic text-muted-foreground">(플레이북 출처 없음)</div>
        )}
      </div>

      {/* Stats (if available) */}
      {totals && (
        <div className="grid grid-cols-5 gap-1 mb-3">
          <StatBadge label="정상" value={totals.ok} color="text-muted-foreground" />
          <StatBadge label="변경" value={totals.changed} color="text-status-warning" />
          <StatBadge label="실패" value={totals.failures} color="text-status-critical" />
          <StatBadge label="접속 불가" value={totals.unreachable} color="text-status-warning" />
          <StatBadge label="건너뜀" value={totals.skipped} color="text-status-unknown" />
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
              disabled={!canOperate}
              className={`p-1.5 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                playbook.showOnDashboard
                  ? 'bg-primary/15 text-primary'
                  : 'hover:bg-primary/10 text-muted-foreground'
              }`}
              title={withHint(playbook.showOnDashboard ? '대시보드에서 빼기' : '대시보드에 표시')}
              aria-label={ariaWithHint(`${playbook.name} 대시보드 표시`)}
              aria-pressed={!!playbook.showOnDashboard}
            >
              <LayoutDashboard className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={onRun}
            disabled={isRunning || !canOperate}
            className="p-1.5 rounded-md hover:bg-primary/10 text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={withHint('플레이북 실행')}
            aria-label={ariaWithHint(`${playbook.name} 실행`)}
          >
            {isRunning ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
          </button>
          <button
            onClick={onEdit}
            disabled={isRunning || !onEdit || !canOperate}
            className="p-1.5 rounded-md hover:bg-primary/10 text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={withHint('플레이북 수정')}
            aria-label={ariaWithHint(`${playbook.name} 수정`)}
          >
            <Pencil className="w-4 h-4" />
          </button>
          <button
            onClick={onDelete}
            disabled={isRunning || !canOperate}
            className="p-1.5 rounded-md hover:bg-status-critical/10 text-status-critical transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={withHint('플레이북 삭제')}
            aria-label={ariaWithHint(`${playbook.name} 삭제`)}
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
