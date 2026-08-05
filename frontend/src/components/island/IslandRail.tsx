import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, arrayMove, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Pencil, Plus, X } from 'lucide-react';
import type { IslandPanelView } from './IslandTabBar';

interface SortableRailItemProps {
  panel: IslandPanelView;
  active: boolean;
  editable: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onEdit: () => void;
}

function SortableRailItem({ panel, active, editable, onSelect, onRemove, onEdit }: SortableRailItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: panel.key,
    disabled: !editable,
  });
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // 툴팁은 레일의 overflow 클리핑을 피하려고 body 에 portal 로 띄운다 (Sidebar 와 동일 패턴).
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);
  const { Icon } = panel;

  const showTooltip = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setTooltipPos({ top: rect.top + rect.height / 2, left: rect.right + 8 });
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group relative ${isDragging ? 'opacity-50 z-10' : ''}`}
      {...attributes}
      {...listeners}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={onSelect}
        aria-label={panel.displayLabel}
        aria-current={active ? 'page' : undefined}
        onMouseEnter={showTooltip}
        onMouseLeave={() => setTooltipPos(null)}
        onFocus={showTooltip}
        onBlur={() => setTooltipPos(null)}
        className={`relative flex items-center justify-center w-10 h-10 rounded-md transition-colors ${
          active
            ? 'bg-primary/15 text-primary'
            : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
        }`}
      >
        {active && (
          <span aria-hidden className="absolute left-0 top-1.5 -translate-x-[3px] w-1 h-7 bg-primary rounded-r" />
        )}
        <Icon className="w-5 h-5" />
      </button>
      {editable && (
        <>
          <button
            type="button"
            onClick={onEdit}
            title={`${panel.displayLabel} 이름·아이콘 변경`}
            aria-label={`${panel.displayLabel} 이름·아이콘 변경`}
            className="absolute -bottom-0.5 -right-0.5 p-0.5 rounded-full bg-card border border-border text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-foreground transition-opacity"
          >
            <Pencil className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            title={`${panel.displayLabel} 패널 제거`}
            aria-label={`${panel.displayLabel} 패널 제거`}
            className="absolute -top-0.5 -right-0.5 p-0.5 rounded-full bg-card border border-border text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-foreground transition-opacity"
          >
            <X className="w-3 h-3" />
          </button>
        </>
      )}
      {tooltipPos && createPortal(
        <span
          role="tooltip"
          style={{ top: tooltipPos.top, left: tooltipPos.left, transform: 'translateY(-50%)' }}
          className="fixed px-2 py-1 text-sm font-medium whitespace-nowrap bg-zinc-700 text-white rounded shadow-lg pointer-events-none z-[60]"
        >
          {panel.displayLabel}
        </span>,
        document.body,
      )}
    </div>
  );
}

interface IslandRailProps {
  panels: IslandPanelView[];
  activeKey: string | null;
  editable: boolean;
  onSelect: (key: string) => void;
  onRemove: (key: string) => void;
  onEdit: (key: string) => void;
  onReorder: (keys: string[]) => void;
  onAdd: () => void;
  /** 패널 상한 도달 — '화면 추가' 를 막고 이유를 툴팁으로 알린다. */
  atCapacity: boolean;
}

/**
 * 좌측 아이콘 레일 — 폭 56px 로 ClusterSidebar iconOnly 규격과 맞춘다(CLAUDE.md 보조
 * 사이드바 표준). 메인 사이드바에 flush 하게 붙고, 스크롤해도 따라오도록 sticky.
 */
export function IslandRail({
  panels, activeKey, editable, onSelect, onRemove, onEdit, onReorder, onAdd, atCapacity,
}: IslandRailProps) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = panels.findIndex((p) => p.key === active.id);
    const to = panels.findIndex((p) => p.key === over.id);
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(panels, from, to).map((p) => p.key));
  };

  return (
    <nav
      aria-label="아일랜드 패널"
      className="flex-shrink-0 w-14 sticky top-0 self-start app-max-h-screen overflow-y-auto no-scrollbar border-r border-border bg-card py-2"
    >
      <div className="flex flex-col items-center gap-1">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={panels.map((p) => p.key)} strategy={verticalListSortingStrategy}>
            {panels.map((p) => (
              <SortableRailItem
                key={p.key}
                panel={p}
                active={p.key === activeKey}
                editable={editable}
                onSelect={() => onSelect(p.key)}
                onRemove={() => onRemove(p.key)}
                onEdit={() => onEdit(p.key)}
              />
            ))}
          </SortableContext>
        </DndContext>
        {editable && (
          <button
            type="button"
            onClick={onAdd}
            disabled={atCapacity}
            title={atCapacity ? '패널 수가 상한에 도달했습니다' : '화면 추가'}
            aria-label={atCapacity ? '패널 수가 상한에 도달했습니다' : '화면 추가'}
            className="flex items-center justify-center w-10 h-10 rounded-md text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground disabled:cursor-not-allowed"
          >
            <Plus className="w-5 h-5" />
          </button>
        )}
      </div>
    </nav>
  );
}
