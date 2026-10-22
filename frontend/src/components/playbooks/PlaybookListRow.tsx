import { Play, Trash2, Clock, Loader2, LayoutDashboard, Pencil, FileText, GripVertical } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Playbook } from '@/types';
import { useCanOperate } from '@/hooks/useCanOperate';
import { Card } from '@/components/ui/card';

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
  healthy: { dot: 'bg-muted-foreground/40', label: '정상', text: 'text-muted-foreground' },
  warning: { dot: 'bg-status-warning', label: '변경', text: 'text-status-warning' },
  critical: { dot: 'bg-status-critical', label: '실패', text: 'text-status-critical' },
  running: { dot: 'bg-status-info', label: '실행 중', text: 'text-status-info' },
  unknown: { dot: 'bg-status-unknown', label: '미실행', text: 'text-muted-foreground' },
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

export function PlaybookListRow({
  playbook, isRunning, onRun, onDelete, onEdit, onToggleDashboard, onViewLog, clusterName,
}: PlaybookListRowProps) {
  // §12.9 — 실행·수정·삭제·클러스터 상세 표시 토글은 operator 이상 + 클러스터 operate 바인딩. 숨기지 않고 비활성+사유.
  const { canOperate, withHint, ariaWithHint } = useCanOperate(playbook.clusterId);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: playbook.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };

  const effectiveStatus = isRunning ? 'running' : playbook.status;
  const cfg = STATUS_CONFIG[effectiveStatus] ?? STATUS_CONFIG.unknown;
  const totals = playbook.lastResult?.stats?.totals;
  const fileLabel = playbook.playbookFileName || playbook.playbookPath || '(출처 없음)';

  return (
    // 행 표면은 shadcn Card 프리미티브(MacCard 의 바탕) — 카드 div 를 손으로 조합하지 않는다(D-004).
    <Card
      ref={setNodeRef}
      style={style}
      className="group flex items-center gap-3 px-3 py-2 shadow-none hover:border-primary/40 transition-colors"
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing p-1 rounded-md text-muted-foreground/30 hover:text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
        title="드래그하여 순서 변경"
        aria-label="드래그하여 순서 변경"
      >
        <GripVertical className="w-3.5 h-3.5" aria-hidden="true" />
      </button>

      {/* Status dot + label */}
      <div className="flex items-center gap-2 w-24 flex-shrink-0">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cfg.dot} ${isRunning ? 'animate-pulse' : ''}`} />
        <span className={`text-sm font-medium ${cfg.text}`}>
          {isRunning ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              실행 중
            </span>
          ) : cfg.label}
        </span>
      </div>

      {/* Name + description */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold truncate">{playbook.name}</span>
          {clusterName && (
            <span className="text-xs text-muted-foreground px-1.5 py-0.5 rounded bg-secondary/50 truncate">
              {clusterName}
            </span>
          )}
        </div>
        {(playbook.description || fileLabel) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground truncate">
            {playbook.description && <span className="truncate">{playbook.description}</span>}
            {playbook.description && <span aria-hidden>·</span>}
            <span className="inline-flex items-center gap-1 font-mono truncate" title={fileLabel}><FileText className="w-3 h-3 flex-shrink-0" aria-hidden />{fileLabel}</span>
          </div>
        )}
      </div>

      {/* Stats (compact) */}
      {totals ? (
        <div className="hidden md:flex items-center gap-2 text-xs flex-shrink-0 tabular-nums">
          <Stat label="정상"   value={totals.ok}          color="text-muted-foreground" />
          <Stat label="변경"  value={totals.changed}     color="text-status-warning" />
          <Stat label="실패" value={totals.failures}    color="text-status-critical" />
          <Stat label="접속 불가"  value={totals.unreachable} color="text-status-warning" />
          <Stat label="건너뜀" value={totals.skipped}     color="text-status-unknown" />
        </div>
      ) : (
        <div className="hidden md:block text-xs text-muted-foreground italic flex-shrink-0">통계 없음</div>
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
          aria-label={`${playbook.name} 실행 로그 보기`}
        >
          <FileText className="w-4 h-4" />
        </button>
        {onToggleDashboard && (
          <button
            onClick={onToggleDashboard}
            disabled={!canOperate}
            className={`p-1.5 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              playbook.showOnDashboard
                ? 'bg-primary/15 text-primary'
                : 'hover:bg-primary/10 text-muted-foreground'
            }`}
            title={withHint(playbook.showOnDashboard ? '클러스터 상세에서 빼기' : '클러스터 상세에 표시')}
            aria-label={ariaWithHint(`${playbook.name} 클러스터 상세 표시`)}
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
          {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
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
    </Card>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  const v = Number(value ?? 0);
  return (
    <span className={`inline-flex items-baseline gap-0.5 ${v > 0 ? color : 'text-muted-foreground/40'}`}>
      <span className="font-bold">{v}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </span>
  );
}
