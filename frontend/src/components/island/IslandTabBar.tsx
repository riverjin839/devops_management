import type { ComponentType } from 'react';
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, horizontalListSortingStrategy, arrayMove, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Plus, X } from 'lucide-react';
import type { IslandPanel } from '@/types';

export interface IslandPanelView extends IslandPanel {
  displayLabel: string;
  Icon: ComponentType<{ className?: string }>;
}

interface SortableTabProps {
  panel: IslandPanelView;
  active: boolean;
  editable: boolean;
  onSelect: () => void;
  onRemove: () => void;
}

function SortableTab({ panel, active, editable, onSelect, onRemove }: SortableTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: panel.key,
    disabled: !editable,
  });
  const { Icon } = panel;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group relative flex items-center rounded-lg ${isDragging ? 'opacity-50 z-10' : ''}`}
      {...attributes}
      {...listeners}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'page' : undefined}
        className={`flex items-center gap-1.5 pl-3 py-1.5 text-sm rounded-lg transition-colors whitespace-nowrap ${
          editable ? 'pr-7' : 'pr-3'
        } ${
          active
            ? 'bg-card text-foreground font-semibold shadow-sm'
            : 'text-muted-foreground hover:text-foreground hover:bg-card/60'
        }`}
      >
        <Icon className="w-4 h-4 flex-shrink-0" />
        <span className="min-w-0">{panel.displayLabel}</span>
      </button>
      {editable && (
        <button
          type="button"
          onClick={onRemove}
          title={`${panel.displayLabel} 패널 제거`}
          aria-label={`${panel.displayLabel} 패널 제거`}
          className="absolute right-1.5 p-0.5 rounded text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-secondary hover:text-foreground transition-opacity"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

interface IslandTabBarProps {
  panels: IslandPanelView[];
  activeKey: string | null;
  editable: boolean;
  onSelect: (key: string) => void;
  onRemove: (key: string) => void;
  onReorder: (keys: string[]) => void;
  onAdd: () => void;
}

/** 상단 pill 탭바 — SettingsPage 의 탭 바 룩을 따르고, 드래그로 순서를 바꾼다. */
export function IslandTabBar({
  panels, activeKey, editable, onSelect, onRemove, onReorder, onAdd,
}: IslandTabBarProps) {
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
    <div className="flex items-center gap-1 bg-secondary/50 rounded-xl p-1 overflow-x-auto no-scrollbar">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={panels.map((p) => p.key)} strategy={horizontalListSortingStrategy}>
          {panels.map((p) => (
            <SortableTab
              key={p.key}
              panel={p}
              active={p.key === activeKey}
              editable={editable}
              onSelect={() => onSelect(p.key)}
              onRemove={() => onRemove(p.key)}
            />
          ))}
        </SortableContext>
      </DndContext>
      {editable && (
        <button
          type="button"
          onClick={onAdd}
          title="화면 추가"
          aria-label="화면 추가"
          className="flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-lg text-muted-foreground hover:text-foreground hover:bg-card/60 transition-colors whitespace-nowrap"
        >
          <Plus className="w-4 h-4" />
          <span>화면 추가</span>
        </button>
      )}
    </div>
  );
}
