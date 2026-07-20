import { useState, useEffect } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { MetricCard as MetricCardType, MetricQueryResult } from '@/types';
import { MetricCard } from './MetricCard';
import { promqlApi } from '@/services/api';

// ── Sortable wrapper around each MetricCard ───────────────────────────────────
interface SortableMetricCardProps {
  card: MetricCardType;
  result?: MetricQueryResult;
  onDelete?: () => void;
  onEdit?: () => void;
}

function SortableMetricCard({ card, result, onDelete, onEdit }: SortableMetricCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} className="relative group/sortable">
      {/* Drag handle */}
      <div
        {...attributes}
        {...listeners}
        className="absolute top-3 right-3 z-10 p-1 rounded opacity-0 group-hover/sortable:opacity-60 hover:!opacity-100 cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground transition-opacity"
        title="드래그하여 순서 변경"
      >
        <GripVertical className="w-3.5 h-3.5" />
      </div>
      <MetricCard
        card={card}
        result={result}
        onDelete={onDelete}
        onEdit={onEdit}
      />
    </div>
  );
}

// ── Main grid ─────────────────────────────────────────────────────────────────
interface MetricCardGridProps {
  cards: MetricCardType[];
  results: MetricQueryResult[];
  isLoading?: boolean;
  onDeleteCard?: (id: string) => void;
  onEditCard?: (card: MetricCardType) => void;
}

export function MetricCardGrid({ cards, results, isLoading, onDeleteCard, onEditCard }: MetricCardGridProps) {
  const [orderedCards, setOrderedCards] = useState<MetricCardType[]>(cards);

  // Sync when cards prop changes (e.g. after refetch)
  useEffect(() => {
    setOrderedCards(cards);
  }, [cards]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const resultMap = new globalThis.Map<string, MetricQueryResult>();
  for (const r of results) {
    if (r.cardId) resultMap.set(r.cardId, r);
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = orderedCards.findIndex((c) => c.id === active.id);
    const newIndex = orderedCards.findIndex((c) => c.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    // Optimistically reorder
    const next = [...orderedCards];
    const [moved] = next.splice(oldIndex, 1);
    next.splice(newIndex, 0, moved);

    // Assign new sortOrder values
    const updated = next.map((c, i) => ({ ...c, sortOrder: i }));
    setOrderedCards(updated);

    // Persist: only update cards whose sortOrder changed
    const changed = updated.filter((c, i) => c.sortOrder !== cards[i]?.sortOrder);
    await Promise.all(
      changed.map((c) => promqlApi.updateCard(c.id, { sortOrder: c.sortOrder }).catch(() => null)),
    );
  };

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-card border border-border rounded-xl p-5 h-48 animate-pulse" />
        ))}
      </div>
    );
  }

  if (orderedCards.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">
          아직 메트릭 카드가 없습니다. "메트릭" 버튼을 눌러 첫 PromQL 카드를 만들어보세요.
        </p>
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={orderedCards.map((c) => c.id)} strategy={rectSortingStrategy}>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {orderedCards.map((card) => (
            <SortableMetricCard
              key={card.id}
              card={card}
              result={resultMap.get(card.id)}
              onDelete={onDeleteCard ? () => onDeleteCard(card.id) : undefined}
              onEdit={onEditCard ? () => onEditCard(card) : undefined}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
