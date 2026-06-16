import { ClusterItem, ClusterItemCardSize } from '@/types';
import { formatDateTime } from '@/lib/utils';
import {
  RefreshCw,
  Pencil,
  Trash2,
  Hand,
  Clock3,
  Sparkles,
  AlertTriangle,
  Maximize2,
} from 'lucide-react';

interface ClusterItemCardProps {
  item: ClusterItem;
  isRunning?: boolean;
  onRun?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onResize?: (size: ClusterItemCardSize) => void;
}

const SIZE_LABEL: Record<ClusterItemCardSize, string> = { sm: 'S', md: 'M', lg: 'L' };
const SIZE_ORDER: ClusterItemCardSize[] = ['sm', 'md', 'lg'];

// 결과 수집 방식 배지 (수동/자동/AI)
function SourceBadge({ mode }: { mode: ClusterItem['sourceMode'] }) {
  const map = {
    manual: { label: '수동', icon: Hand, cls: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
    auto: { label: '자동', icon: Clock3, cls: 'bg-primary/10 text-primary border-primary/20' },
    ai: { label: 'AI', icon: Sparkles, cls: 'bg-purple-500/10 text-purple-600 border-purple-500/20' },
  }[mode] ?? { label: mode, icon: Clock3, cls: 'bg-secondary text-muted-foreground border-border' };
  const Icon = map.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium rounded-full border ${map.cls}`}>
      <Icon className="w-2.5 h-2.5" /> {map.label}
    </span>
  );
}

function formatValue(value: number | null | undefined, unit?: string | null): string {
  if (value == null) return '—';
  // 노드 수 등 정수형은 소수점 없이.
  const num = Number.isInteger(value) ? value.toString() : value.toFixed(1);
  return unit ? `${num}${unit}` : num;
}

export function ClusterItemCard({ item, isRunning, onRun, onEdit, onDelete, onResize }: ClusterItemCardProps) {
  const hasError = item.lastStatus === 'error';
  const nextSize = (): ClusterItemCardSize => {
    const idx = SIZE_ORDER.indexOf(item.cardSize);
    return SIZE_ORDER[(idx + 1) % SIZE_ORDER.length];
  };

  return (
    <div className="h-full bg-card border border-border rounded-xl p-4 hover:border-muted-foreground/30 transition-all relative group flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center text-lg flex-shrink-0">
            {item.icon || '🖥️'}
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold truncate">{item.title}</h3>
            <div className="flex items-center gap-1 mt-0.5">
              <SourceBadge mode={item.sourceMode} />
              {item.isBuiltin && (
                <span className="px-1.5 py-0.5 text-xs rounded-full bg-secondary text-muted-foreground">기본</span>
              )}
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          {onResize && (
            <button
              onClick={(e) => { e.stopPropagation(); onResize(nextSize()); }}
              className="p-1 hover:bg-secondary rounded-lg transition-colors opacity-0 group-hover:opacity-100 inline-flex items-center"
              title={`카드 크기: ${SIZE_LABEL[item.cardSize]} → ${SIZE_LABEL[nextSize()]}`}
              aria-label="Resize card"
            >
              <Maximize2 className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-xs text-muted-foreground ml-0.5">{SIZE_LABEL[item.cardSize]}</span>
            </button>
          )}
          {onRun && (
            <button
              onClick={(e) => { e.stopPropagation(); onRun(); }}
              disabled={isRunning}
              className="p-1 hover:bg-primary/10 rounded-lg transition-colors disabled:opacity-50"
              title="수동 실행 (지금 점검)"
              aria-label="Run now"
            >
              <RefreshCw className={`w-3.5 h-3.5 text-primary ${isRunning ? 'animate-spin' : ''}`} />
            </button>
          )}
          {onEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); onEdit(); }}
              className="p-1 hover:bg-primary/10 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
              title="편집"
              aria-label="Edit item"
            >
              <Pencil className="w-3.5 h-3.5 text-primary" />
            </button>
          )}
          {onDelete && !item.isBuiltin && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              className="p-1 hover:bg-status-critical/10 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
              title="삭제"
              aria-label="Delete item"
            >
              <Trash2 className="w-3.5 h-3.5 text-status-critical" />
            </button>
          )}
        </div>
      </div>

      {/* Value */}
      <div className="flex-1 flex flex-col justify-center py-2">
        {hasError ? (
          <div className="flex items-start gap-1.5 text-sm text-status-critical">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span className="break-words">{item.lastError || '수집 실패'}</span>
          </div>
        ) : (
          <div className="flex items-baseline gap-1.5">
            <span className="text-4xl font-bold font-mono text-foreground">
              {formatValue(item.currentValue, item.unit)}
            </span>
          </div>
        )}
      </div>

      {/* Footer — 마지막 변경일자 + 그 당시 값 */}
      <div className="pt-2 border-t border-border space-y-0.5">
        {item.lastChangedAt ? (
          <p className="text-xs text-muted-foreground">
            마지막 변경 <span className="font-medium text-foreground/80">{formatDateTime(item.lastChangedAt)}</span>
            {' · '}
            {item.previousValue != null && (
              <span className="text-muted-foreground/70">{formatValue(item.previousValue, item.unit)} → </span>
            )}
            <span className="font-medium text-foreground/80">{formatValue(item.currentValue, item.unit)}</span>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground/60">변경 이력 없음</p>
        )}
        {item.lastCheckedAt && (
          <p className="text-xs text-muted-foreground/50">
            점검 {formatDateTime(item.lastCheckedAt)}
            {item.lastSource && ` · ${item.lastSource === 'manual' ? '수동' : item.lastSource === 'auto' ? '자동' : 'AI'}`}
          </p>
        )}
      </div>
    </div>
  );
}
