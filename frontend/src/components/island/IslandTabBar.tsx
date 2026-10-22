import type { ComponentType } from 'react';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, horizontalListSortingStrategy, arrayMove, sortableKeyboardCoordinates, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Pencil, Plus, X } from 'lucide-react';
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
  onEdit: () => void;
}

function SortableTab({ panel, active, editable, onSelect, onRemove, onEdit }: SortableTabProps) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({
    id: panel.key,
    disabled: !editable,
  });
  const { Icon } = panel;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group relative flex items-center rounded-xl transition-colors ${isDragging ? 'opacity-50 z-10' : ''} ${
        active ? 'bg-card shadow-sm' : 'hover:bg-card/60'
      }`}
    >
      {/* 드래그 핸들 — dnd 속성은 여기에만 붙인다. 탭 버튼을 감싼 div 에 붙이면 중첩 인터랙티브가
          되고 탭마다 Tab 정지가 2개가 된다(B-17). 키보드: Space 로 잡고 ←/→ 로 옮긴 뒤 Space 로 놓는다. */}
      {editable && (
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          title="순서 변경 (끌거나 Space 후 화살표)"
          aria-label={`${panel.displayLabel} 순서 변경`}
          className="flex items-center self-stretch pl-1.5 pr-0.5 rounded-xl text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing touch-none"
        >
          <GripVertical className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      )}
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'page' : undefined}
        className={`flex items-center gap-1.5 py-1.5 text-sm rounded-xl transition-colors whitespace-nowrap ${
          editable ? 'pl-1 pr-12' : 'px-3'
        } ${
          active
            ? 'text-foreground font-semibold'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <Icon className="w-4 h-4 flex-shrink-0" />
        <span className="min-w-0">{panel.displayLabel}</span>
      </button>
      {editable && (
        <span className="absolute right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={onEdit}
            title={`${panel.displayLabel} 이름·아이콘 변경`}
            aria-label={`${panel.displayLabel} 이름·아이콘 변경`}
            className="p-0.5 rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            title={`${panel.displayLabel} 패널 제거`}
            aria-label={`${panel.displayLabel} 패널 제거`}
            className="p-0.5 rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </span>
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
  onEdit: (key: string) => void;
  onReorder: (keys: string[]) => void;
  onAdd: () => void;
  /** 패널 상한 도달 — '화면 추가' 를 막고 이유를 툴팁으로 알린다. */
  atCapacity: boolean;
}

/** 상단 pill 탭바 — SettingsPage 의 탭 바 룩을 따르고, 드래그로 순서를 바꾼다. */
export function IslandTabBar({
  panels, activeKey, editable, onSelect, onRemove, onEdit, onReorder, onAdd, atCapacity,
}: IslandTabBarProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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
          className="flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-xl text-muted-foreground hover:text-foreground hover:bg-card/60 transition-colors whitespace-nowrap disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground disabled:cursor-not-allowed"
        >
          <Plus className="w-4 h-4" />
          <span>화면 추가</span>
        </button>
      )}
    </div>
  );
}
