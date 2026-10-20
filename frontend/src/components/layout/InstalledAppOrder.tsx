import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, rectSortingStrategy, sortableKeyboardCoordinates, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useInstallableAppText, type InstallableApp } from './installableApps';

interface InstalledAppOrderProps {
  /** 이 창(사이드바 또는 상단바)에 해당하는 설치 항목 — 표시 순서대로. */
  apps: InstallableApp[];
  /** `id` 를 `before` 앞으로(없으면 맨 끝) — 서버의 원자적 move 연산으로 이어진다. */
  onMove: (id: string, before: string | null) => void;
}

function OrderChip({ app }: { app: InstallableApp }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: app.id });
  const { t } = useTranslation();
  const label = useInstallableAppText().appLabel(app);
  return (
    <div
      ref={setNodeRef}
      // dnd-kit 이 매 프레임 계산하는 위치라 Tailwind 클래스로 표현할 수 없다(ClusterSidebar 와 같은 예외).
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`inline-flex items-center gap-1 pl-1 pr-2.5 py-1 rounded-xl border text-xs bg-card ${
        isDragging ? 'border-primary/60 opacity-60' : 'border-border'
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t('apps.order.dragLabel', { label })}
        title={t('apps.order.dragHint')}
        className="p-0.5 rounded text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing"
      >
        <GripVertical className="w-3.5 h-3.5" aria-hidden />
      </button>
      <app.icon className={`w-3.5 h-3.5 ${app.iconColor || 'text-muted-foreground'}`} />
      {label}
    </div>
  );
}

/** "앱 추가" 창 상단 — 설치된 항목을 끌어서 레일/상단바 표시 순서를 바꾼다(키보드로도 가능). */
export function InstalledAppOrder({ apps, onMove }: InstalledAppOrderProps) {
  const { t } = useTranslation();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const ids = apps.map((a) => a.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    // 아래(뒤)로 옮기면 놓은 항목의 "다음" 앞에, 위(앞)로 옮기면 놓은 항목 앞에 들어간다.
    const before = from < to ? (ids[to + 1] ?? null) : ids[to];
    onMove(String(active.id), before);
  };

  if (apps.length < 2) return null;
  return (
    <div>
      <p className="px-0.5 pb-1.5 text-xs font-medium text-muted-foreground">
        {t('apps.order.title')}
      </p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={apps.map((a) => a.id)} strategy={rectSortingStrategy}>
          <div className="flex flex-wrap gap-1.5">
            {apps.map((app) => <OrderChip key={app.id} app={app} />)}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
