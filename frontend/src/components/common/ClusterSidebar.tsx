import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Server, CheckCircle, AlertTriangle, XCircle, WifiOff, LayoutGrid, GripVertical, ArrowDownUp } from 'lucide-react';
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, useSortable, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Cluster, Status } from '@/types';
import { useSidebarStore } from '@/stores/sidebarStore';
import { resolveClusterIcon } from '@/lib/clusterIcons';
import { ResizeHandle } from './ResizeHandle';

interface ClusterSidebarProps {
  clusters: Cluster[];
  /** 현재 선택 — null 이면 전체(All), 문자열이면 해당 cluster.id */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  title?: string;
  /** 지금 선택된 클러스터가 상단 고정 (풀 배경) */
  highlightActive?: boolean;
  /** 최상단에 "전체" 선택지 (Dashboard 에 유용) */
  allowAll?: boolean;
  /** "전체" 표시 라벨 */
  allLabel?: string;
  /** 정렬 모드 토글 + 드래그 앤 드랍 활성화. onReorder 가 주어지면 기능 노출. */
  onReorder?: (orderedClusterIds: string[]) => void;
  /** 다중 선택 모드 — 활성화 시 selectedIds/onMultiSelectChange 가 우선한다.
   *  noop pages 영향 없음: 기본 false. */
  multiSelect?: boolean;
  /** multiSelect 모드일 때 현재 선택된 클러스터 id 들 */
  selectedIds?: string[];
  /** multiSelect 모드일 때 선택 변경 콜백 */
  onMultiSelectChange?: (ids: string[]) => void;
  /** 아이콘 전용 레일 모드 — 메인 사이드바처럼 좁은 폭에 아이콘만 표시하고 호버 시 클러스터 이름 툴팁.
   *  multiSelect / onReorder 와 함께 쓰지 않는다 (Dashboard 같이 단일 선택 페이지 전용). */
  iconOnly?: boolean;
}

const ICON_RAIL_WIDTH = 56;

const STATUS_ICON: Record<Status, React.ComponentType<{ className?: string }>> = {
  healthy: CheckCircle,
  warning: AlertTriangle,
  critical: XCircle,
  pending: WifiOff,
};

const STATUS_DOT: Record<Status, string> = {
  healthy:  'bg-emerald-500',
  warning:  'bg-amber-500',
  critical: 'bg-red-500',
  pending:  'bg-slate-400',
};

interface RowProps {
  cluster: Cluster;
  active: boolean;
  sortMode: boolean;
  onSelect: () => void;
  /** 다중 선택 모드 — true 면 좌측에 체크박스 노출 */
  multiSelect?: boolean;
  checked?: boolean;
}

function ClusterRow({ cluster, active, sortMode, onSelect, multiSelect, checked }: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: cluster.id,
    disabled: !sortMode,
  });
  const Icon = STATUS_ICON[cluster.status] ?? Server;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className={`group flex items-center gap-1.5 rounded-lg transition-colors ${
        active && !sortMode
          ? 'bg-primary/10 text-primary border border-primary/30'
          : 'hover:bg-secondary text-foreground border border-transparent'
      }`}
    >
      {sortMode && (
        <button
          {...attributes}
          {...listeners}
          className="px-1 py-1.5 text-muted-foreground hover:text-foreground cursor-grab active:cursor-grabbing"
          aria-label="드래그하여 순서 변경"
        >
          <GripVertical className="w-3.5 h-3.5" />
        </button>
      )}
      {multiSelect && !sortMode && (
        <input
          type="checkbox"
          checked={!!checked}
          onChange={onSelect}
          aria-label={`${cluster.name} 선택`}
          className="ml-2 w-4 h-4 accent-primary flex-shrink-0"
        />
      )}
      <button
        onClick={sortMode ? undefined : onSelect}
        disabled={sortMode}
        className={`flex-1 flex items-center gap-2 ${sortMode ? 'pl-1' : 'pl-2'} pr-2 py-1.5 text-left min-w-0 disabled:cursor-default`}
      >
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[cluster.status] ?? 'bg-slate-400'}`} />
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium truncate">{cluster.name}</span>
          {(cluster.region || cluster.operationLevel) && (
            <span className="block text-[11px] text-muted-foreground truncate">
              {cluster.region}{cluster.region && cluster.operationLevel ? ' · ' : ''}{cluster.operationLevel}
            </span>
          )}
        </span>
        {!sortMode && (
          <Icon className={`w-3 h-3 flex-shrink-0 ${active ? 'text-primary' : 'text-muted-foreground/70'}`} />
        )}
      </button>
    </div>
  );
}

// ── 아이콘 전용 레일 버튼 — 메인 Sidebar 의 RailIconButton 패턴을 차용. ────────
interface IconRailButtonProps {
  label: string;
  /** 우측 상단 작은 상태 도트 색상 (Tailwind class). 미지정 시 도트 미표시. */
  dotClass?: string;
  /** 표시할 lucide 컴포넌트. 다른 표시 옵션이 없을 때 사용. */
  Icon?: React.ComponentType<{ className?: string }>;
  /** 표시할 텍스트(주로 emoji 1자). 우선순위: imageSrc > emojiText > Icon. */
  emojiText?: string;
  /** 표시할 이미지 URL / data URL — 사용자가 업로드한 커스텀 아이콘. */
  imageSrc?: string;
  active?: boolean;
  onClick: () => void;
}

function IconRailButton({ label, dotClass, Icon, emojiText, imageSrc, active, onClick }: IconRailButtonProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // viewport 좌표 — 부모 overflow 를 회피하기 위해 portal 로 렌더한다.
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);

  const showTooltip = () => {
    const el = buttonRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setTooltipPos({ top: rect.top + rect.height / 2, left: rect.right + 8 });
  };
  const hideTooltip = () => setTooltipPos(null);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        onClick={onClick}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        className={`relative flex items-center justify-center w-10 h-10 rounded-md transition-colors ${
          active
            ? 'bg-primary/15 text-primary'
            : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
        }`}
      >
        {active && (
          <span aria-hidden className="absolute left-0 top-1.5 -translate-x-[3px] w-1 h-7 bg-primary rounded-r" />
        )}
        {imageSrc
          ? <img src={imageSrc} alt="" className="w-6 h-6 rounded object-cover" />
          : emojiText
            ? <span className="text-lg leading-none select-none" aria-hidden>{emojiText}</span>
            : Icon
              ? <Icon className="w-5 h-5" />
              : <Server className="w-5 h-5" />}
        {dotClass && (
          <span
            aria-hidden
            className={`absolute top-1 right-1 w-1.5 h-1.5 rounded-full ring-1 ring-card ${dotClass}`}
          />
        )}
      </button>
      {tooltipPos && createPortal(
        <span
          role="tooltip"
          style={{ top: tooltipPos.top, left: tooltipPos.left, transform: 'translateY(-50%)' }}
          className="fixed px-2 py-1 text-xs font-medium whitespace-nowrap bg-zinc-700 text-white rounded shadow-lg pointer-events-none z-[60]"
        >
          {label}
        </span>,
        document.body,
      )}
    </>
  );
}

/** 좌측 클러스터 선택 사이드바 — 드래그로 폭 조절 가능.
 *  부모가 flex row 레이아웃을 잡아주면, 이 컴포넌트는 자기 폭을 가짐.
 *  onReorder 가 주어지면 정렬 모드 토글 버튼이 노출되고, 모드에서 드래그로 seq 를 재할당한다.
 */
function ClusterSidebarIconRail({
  clusters, selectedId, onSelect, highlightActive, allowAll, allLabel,
  multiSelect, selectedIds, onMultiSelectChange,
}: Pick<ClusterSidebarProps,
  'clusters' | 'selectedId' | 'onSelect' | 'highlightActive' | 'allowAll' | 'allLabel'
  | 'multiSelect' | 'selectedIds' | 'onMultiSelectChange'
>) {
  const selectedSet = multiSelect ? new Set(selectedIds ?? []) : null;
  const isAllActive = multiSelect
    ? (selectedSet?.size ?? 0) === 0
    : selectedId === null;

  // 사이드바에서는 아이콘 변경을 허용하지 않는다. 변경은 시스템 등록된 클러스터 관리 화면
  // (/cluster-manage) 의 테이블 첫 컬럼에서만 가능하도록 권한을 한정.

  // multiSelect 에서 "전체" 클릭 → 선택 비우기 (=전체로 간주). 단일 모드에서는 onSelect(null).
  const handleAllClick = () => {
    if (multiSelect && onMultiSelectChange) onMultiSelectChange([]);
    else onSelect(null);
  };

  // multiSelect 에서 개별 클릭 → 토글. 단일 모드에서는 onSelect(id).
  const handleClusterClick = (id: string) => {
    if (multiSelect && onMultiSelectChange) {
      const next = new Set(selectedSet ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // 원본 cluster 순서를 유지해서 내려준다.
      onMultiSelectChange(clusters.map((c) => c.id).filter((cid) => next.has(cid)));
    } else {
      onSelect(id);
    }
  };

  return (
    <aside
      style={{ width: ICON_RAIL_WIDTH }}
      className="flex-shrink-0 bg-card border border-border rounded-xl py-2 h-fit sticky top-4"
    >
      <div className="flex flex-col items-center gap-1">
        {allowAll && (
          <IconRailButton
            label={multiSelect
              ? `${allLabel ?? '전체'} — 선택 비우기 (${selectedSet?.size ?? 0}/${clusters.length})`
              : `${allLabel ?? '전체'} (${clusters.length})`}
            Icon={LayoutGrid}
            active={isAllActive && (highlightActive ?? true)}
            onClick={handleAllClick}
          />
        )}
        {clusters.length === 0 ? (
          <p className="px-1 py-3 text-[10px] text-muted-foreground/70 text-center">없음</p>
        ) : (
          clusters.map((c) => {
            const subtitle = [c.region, c.operationLevel].filter(Boolean).join(' · ');
            const isActive = multiSelect
              ? !!selectedSet?.has(c.id)
              : (highlightActive ?? true) && c.id === selectedId;
            const baseTooltip = subtitle ? `${c.name} · ${subtitle}` : c.name;
            const tooltip = multiSelect
              ? `${baseTooltip}${isActive ? ' (선택됨 — 클릭하면 해제)' : ' (클릭하면 선택)'}`
              : baseTooltip;

            // 사용자 지정 아이콘이 있으면 그걸 사용, 없으면 status 기반 fallback.
            const resolved = resolveClusterIcon(c.icon);
            const FallbackIcon = STATUS_ICON[c.status] ?? Server;
            const lucideIcon: React.ComponentType<{ className?: string }> =
              resolved?.kind === 'lucide' ? resolved.Component : FallbackIcon;
            const emojiText = resolved?.kind === 'text' ? resolved.value : undefined;
            const imageSrc = resolved?.kind === 'image' ? resolved.value : undefined;

            return (
              <IconRailButton
                key={c.id}
                label={tooltip}
                Icon={lucideIcon}
                emojiText={emojiText}
                imageSrc={imageSrc}
                dotClass={STATUS_DOT[c.status] ?? 'bg-slate-400'}
                active={isActive}
                onClick={() => handleClusterClick(c.id)}
              />
            );
          })
        )}
      </div>
    </aside>
  );
}

export function ClusterSidebar({
  clusters, selectedId, onSelect, title = '클러스터',
  highlightActive = true, allowAll = false, allLabel = '전체 클러스터',
  onReorder,
  multiSelect = false, selectedIds, onMultiSelectChange,
  iconOnly = false,
}: ClusterSidebarProps) {
  // hooks-order: 모든 훅은 어떤 early return 보다도 위에 있어야 한다.
  const width = useSidebarStore((s) => s.clusterSidebarWidth);
  const setWidth = useSidebarStore((s) => s.setClusterSidebarWidth);
  const reset = useSidebarStore((s) => s.resetClusterSidebar);
  const [sortMode, setSortMode] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // 아이콘 레일 모드 — 메인 사이드바 스타일. multiSelect 와 함께 쓰일 수 있음 (PlaybooksPage).
  // onReorder 와 같이 쓰는 경우는 현재 없음 — 사용 시 정렬 토글은 노출되지 않음.
  if (iconOnly) {
    return (
      <ClusterSidebarIconRail
        clusters={clusters}
        selectedId={selectedId}
        onSelect={onSelect}
        highlightActive={highlightActive}
        allowAll={allowAll}
        allLabel={allLabel}
        multiSelect={multiSelect}
        selectedIds={selectedIds}
        onMultiSelectChange={onMultiSelectChange}
      />
    );
  }

  const selectedSet = multiSelect ? new Set(selectedIds ?? []) : null;
  const toggleMulti = (id: string) => {
    if (!multiSelect || !onMultiSelectChange) return;
    const next = new Set(selectedSet ?? []);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // 클러스터 정렬 순서를 유지하기 위해 원본 배열 순서로 정렬해서 내려준다.
    const ordered = clusters.map((c) => c.id).filter((cid) => next.has(cid));
    onMultiSelectChange(ordered);
  };
  const toggleAllMulti = () => {
    if (!multiSelect || !onMultiSelectChange) return;
    const all = clusters.map((c) => c.id);
    if ((selectedSet?.size ?? 0) === all.length) onMultiSelectChange([]);
    else onMultiSelectChange(all);
  };
  const totalN = clusters.length;

  const handleDragEnd = (e: DragEndEvent) => {
    if (!onReorder) return;
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = clusters.findIndex((c) => c.id === active.id);
    const newIndex = clusters.findIndex((c) => c.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(clusters, oldIndex, newIndex);
    onReorder(reordered.map((c) => c.id));
  };

  return (
    <aside
      style={{ width }}
      className="flex-shrink-0 bg-card border border-border rounded-xl p-2 h-fit sticky top-4 relative"
    >
      <div className="flex items-center justify-between px-2 py-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
          <span className="ml-1 text-muted-foreground/70">
            {multiSelect ? `(${selectedSet?.size ?? 0}/${totalN})` : `(${totalN})`}
          </span>
        </p>
        {multiSelect && !sortMode && totalN > 0 && (
          <button
            onClick={toggleAllMulti}
            className="text-[10px] text-primary hover:text-primary/80"
          >
            {(selectedSet?.size ?? 0) === totalN ? '전체 해제' : '전체 선택'}
          </button>
        )}
        {onReorder && (
          <button
            onClick={() => setSortMode((v) => !v)}
            className={`p-1 rounded text-[10px] inline-flex items-center gap-1 ${
              sortMode ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
            }`}
            title={sortMode ? '정렬 모드 종료' : '드래그로 순서 변경'}
          >
            <ArrowDownUp className="w-3 h-3" />
            {sortMode && <span>완료</span>}
          </button>
        )}
      </div>

      {allowAll && !sortMode && !multiSelect && (
        <button
          onClick={() => onSelect(null)}
          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors mb-0.5 ${
            selectedId === null && highlightActive
              ? 'bg-primary/10 text-primary border border-primary/30'
              : 'hover:bg-secondary text-foreground border border-transparent'
          }`}
        >
          <LayoutGrid className={`w-3.5 h-3.5 flex-shrink-0 ${selectedId === null ? 'text-primary' : 'text-muted-foreground/70'}`} />
          <span className="flex-1 min-w-0 text-sm font-medium truncate">{allLabel}</span>
          {totalN > 0 && (
            <span className="text-[11px] text-muted-foreground/70 flex-shrink-0">{totalN}</span>
          )}
        </button>
      )}

      <div className="space-y-0.5">
        {clusters.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground/70">등록된 클러스터 없음</p>
        ) : (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={clusters.map((c) => c.id)} strategy={verticalListSortingStrategy}>
              {clusters.map((c) => (
                <ClusterRow
                  key={c.id}
                  cluster={c}
                  active={multiSelect
                    ? !!selectedSet?.has(c.id)
                    : highlightActive && c.id === selectedId}
                  sortMode={sortMode}
                  onSelect={multiSelect ? () => toggleMulti(c.id) : () => onSelect(c.id)}
                  multiSelect={multiSelect}
                  checked={multiSelect ? selectedSet?.has(c.id) : undefined}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
      </div>

      <ResizeHandle width={width} onResize={setWidth} onReset={reset} />
    </aside>
  );
}
