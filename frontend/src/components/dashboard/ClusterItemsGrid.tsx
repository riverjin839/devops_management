import { ClusterItem, ClusterItemCardSize } from '@/types';
import { Plus, LayoutGrid } from 'lucide-react';
import { ClusterItemCard } from './ClusterItemCard';

interface ClusterItemsGridProps {
  items: ClusterItem[];
  isLoading?: boolean;
  runningIds?: Set<string>;
  onAdd?: () => void;
  onRun?: (item: ClusterItem) => void;
  onEdit?: (item: ClusterItem) => void;
  onDelete?: (item: ClusterItem) => void;
  onResize?: (item: ClusterItem, size: ClusterItemCardSize) => void;
}

// 카드 크기 → 4열 그리드에서 차지하는 컬럼 수.
const SIZE_SPAN: Record<ClusterItemCardSize, string> = {
  sm: 'sm:col-span-1',
  md: 'sm:col-span-2',
  lg: 'sm:col-span-4',
};

export function ClusterItemsGrid({
  items,
  isLoading,
  runningIds,
  onAdd,
  onRun,
  onEdit,
  onDelete,
  onResize,
}: ClusterItemsGridProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        {[0, 1].map((i) => (
          <div key={i} className="sm:col-span-2 h-36 rounded-xl bg-secondary/40 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
      {items.map((item) => (
        <div key={item.id} className={SIZE_SPAN[item.cardSize] ?? SIZE_SPAN.md}>
          <ClusterItemCard
            item={item}
            isRunning={runningIds?.has(item.id)}
            onRun={onRun ? () => onRun(item) : undefined}
            onEdit={onEdit ? () => onEdit(item) : undefined}
            onDelete={onDelete ? () => onDelete(item) : undefined}
            onResize={onResize ? (size) => onResize(item, size) : undefined}
          />
        </div>
      ))}

      {onAdd && (
        <button
          onClick={onAdd}
          className="sm:col-span-1 min-h-[9rem] flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-muted-foreground hover:border-primary/40 hover:text-primary transition-colors"
        >
          <Plus className="w-5 h-5" />
          <span className="text-sm font-medium">아이템 추가</span>
        </button>
      )}

      {items.length === 0 && !onAdd && (
        <div className="sm:col-span-4 flex flex-col items-center justify-center py-10 text-muted-foreground">
          <LayoutGrid className="w-6 h-6 mb-2 opacity-50" />
          <p className="text-sm">등록된 아이템이 없습니다.</p>
        </div>
      )}
    </div>
  );
}
