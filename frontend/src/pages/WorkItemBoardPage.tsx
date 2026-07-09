import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ViewModeBar, DoubleScrollX, ConfirmDialog, useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { Plus, Download, ListTodo, X, CalendarDays, List, ChevronUp, ChevronDown, ArrowUpDown, Kanban, AlertCircle, GripVertical, ListFilter, DownloadCloud, Clock, CalendarRange } from 'lucide-react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { WorkItemCalendar, WorkItemKanban, WorkItemTableRow, AddWorkItemRow, ColumnSettingsMenu, WorkItemFormModal } from '@/components/work-items';
import { WORK_ITEM_COLUMNS, DEFAULT_COLUMN_ORDER, DEFAULT_VISIBLE_COLUMNS, ALWAYS_VISIBLE_COLUMNS, COLUMN_WIDTH_DEFAULTS, type WorkItemColumnKey, type WorkItemSortKey } from '@/components/work-items';
import { ResizeGrip } from '@/components/common';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { useColumnLayout } from '@/hooks/useColumnLayout';
import { WorkItemCustomFieldsManager } from '@/components/work-items/WorkItemCustomFieldsManager';
import { JiraImportModal } from '@/components/work-items/JiraImportModal';
import { useJiraConfig } from '@/hooks/useJira';
import { Settings2 } from 'lucide-react';
import { MODULE_CONFIG, WORK_ITEM_TYPE_CONFIG, WORK_ITEM_TYPE_ORDER } from '@/components/work-items/workItemKanbanUtils';
import { useWorkItems, useCreateWorkItem, useDeleteWorkItem } from '@/hooks/useWorkItems';
import { useClusters } from '@/hooks/useCluster';
import { useProjects } from '@/hooks/useProjects';
import { useSprints } from '@/hooks/useSprints';
import { useClusterStore } from '@/stores/clusterStore';
import { workItemsApi } from '@/services/api';
import { useLocalOrder } from '@/hooks/useLocalOrder';
import { WorkItem, WorkItemModule, WorkItemType } from '@/types';

type ViewMode = 'table' | 'calendar' | 'kanban';

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** 컬럼 헤더 — 드래그 핸들(순서 변경) + 정렬 토글 + 우측 리사이즈 그립. */
/** 업무 분류(유형) 필터 — 6개 탭을 버튼 하나 + 드롭다운으로 접어 한 줄에 들어오게. */
function TypeFilterDropdown({
  value, onChange,
}: {
  value: WorkItemType | 'all';
  onChange: (v: WorkItemType | 'all') => void;
}) {
  const [open, setOpen] = useState(false);
  const current = value === 'all' ? null : WORK_ITEM_TYPE_CONFIG[value];
  const active = value !== 'all';
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors inline-flex items-center gap-1.5 ${
          active ? `${current!.cls} border-current` : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
        }`}
      >
        {current ? <current.Icon className="w-3.5 h-3.5" /> : <ListFilter className="w-3.5 h-3.5" />}
        {current ? current.label : '업무 분류'}
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1 z-40 bg-card border border-border rounded-lg mac-shadow p-1 min-w-[140px]" role="listbox">
            <button
              type="button"
              onClick={() => { onChange('all'); setOpen(false); }}
              className={`w-full text-left px-2 py-1.5 rounded-md text-sm inline-flex items-center gap-1.5 transition-colors ${
                value === 'all' ? 'bg-primary/10 text-primary' : 'hover:bg-secondary text-foreground'
              }`}
            >
              <ListFilter className="w-3.5 h-3.5" /> 전체 유형
            </button>
            {WORK_ITEM_TYPE_ORDER.map((key) => {
              const cfg = WORK_ITEM_TYPE_CONFIG[key];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => { onChange(key); setOpen(false); }}
                  className={`w-full text-left px-2 py-1.5 rounded-md text-sm inline-flex items-center gap-1.5 transition-colors ${
                    value === key ? 'bg-primary/10 text-primary' : 'hover:bg-secondary text-foreground'
                  }`}
                >
                  <cfg.Icon className="w-3.5 h-3.5" /> {cfg.label}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function DraggableSortHeader({
  colKey,
  sortKey,
  sortDir,
  onSort,
  colW,
}: {
  colKey: WorkItemColumnKey;
  sortKey: WorkItemSortKey | '';
  sortDir: 'asc' | 'desc';
  onSort: (col: WorkItemSortKey) => void;
  colW: ReturnType<typeof useColumnWidths>;
}) {
  const meta = WORK_ITEM_COLUMNS[colKey];
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: colKey });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 };
  const sortable = !!meta.sortKey;
  const isActive = sortable && sortKey === meta.sortKey;
  return (
    <th
      ref={setNodeRef}
      style={style}
      className="relative px-4 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap select-none bg-muted/30 group"
    >
      <span className={`inline-flex items-center gap-1 ${meta.headerAlign === 'center' ? 'w-full justify-center' : ''}`}>
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground -ml-1 touch-none"
          title="드래그하여 컬럼 순서 변경"
          aria-label="컬럼 이동"
        >
          <GripVertical className="w-3 h-3" />
        </button>
        {sortable ? (
          <button
            type="button"
            onClick={() => onSort(meta.sortKey!)}
            className="inline-flex items-center gap-1 cursor-pointer hover:text-foreground transition-colors"
          >
            {meta.label}
            {isActive ? (
              sortDir === 'asc' ? <ChevronUp className="w-3 h-3 text-primary" /> : <ChevronDown className="w-3 h-3 text-primary" />
            ) : (
              <ArrowUpDown className="w-3 h-3 opacity-0 group-hover:opacity-40 transition-opacity" />
            )}
          </button>
        ) : (
          <span>{meta.label}</span>
        )}
      </span>
      <ResizeGrip onMouseDown={(e) => colW.beginResize(colKey, e)} onDoubleClick={() => colW.autoFit(colKey)} />
    </th>
  );
}

export function WorkItemBoardPage() {
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [typeFilter, setTypeFilter] = useState<WorkItemType | 'all'>('all');
  const [filterClusterId, setFilterClusterId] = useState('');
  const [filterAssignee, setFilterAssignee] = useState('');
  const [filterCategory, setFilterCategory] = useState('');
  const [filterPriority, setFilterPriority] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [filterModule, setFilterModule] = useState<WorkItemModule | ''>('');
  // 스프린트 페이지의 '게시판에서 보기' 딥링크(?sprint=...) 를 초기 필터로 반영.
  const [searchParams] = useSearchParams();
  const [filterSprintId, setFilterSprintId] = useState(searchParams.get('sprint') ?? '');
  const [sortKey, setSortKey] = useState<WorkItemSortKey | ''>('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  // 시작일/완료일 시간 표시 토글 (기본 off = 날짜만). localStorage 영속.
  const [showTime, setShowTime] = useState<boolean>(() => {
    try { return localStorage.getItem('k8s:item-board:show-time') === '1'; } catch { return false; }
  });
  const toggleShowTime = () => setShowTime((v) => {
    const next = !v;
    try { localStorage.setItem('k8s:item-board:show-time', next ? '1' : '0'); } catch { /* ignore */ }
    return next;
  });

  const colW = useColumnWidths('item-board-table', {
    defaults: COLUMN_WIDTH_DEFAULTS,
    min: 60, max: 800,
  });

  // 컬럼 순서 / 표시여부 개인화 (localStorage 영속).
  const colLayout = useColumnLayout<WorkItemColumnKey>('item-board-table', {
    defaultOrder: DEFAULT_COLUMN_ORDER,
    defaultVisible: DEFAULT_VISIBLE_COLUMNS,
    alwaysVisible: ALWAYS_VISIBLE_COLUMNS,
  });
  const visibleCols = colLayout.visibleOrder;
  const headerSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const { clusters } = useClusterStore();
  useClusters();

  // 프로젝트명(읽기전용 컬럼) 매핑 — projectId → name.
  const projectsQuery = useProjects();
  const projectNameById = useMemo(
    () => new Map((projectsQuery.data?.data ?? []).map((p) => [p.id, p.name])),
    [projectsQuery.data],
  );

  // 스프린트 — 필터 드롭다운 + 읽기전용 컬럼(sprintId → name) 매핑.
  const sprintsQuery = useSprints();
  const sprintList = useMemo(() => sprintsQuery.data?.data ?? [], [sprintsQuery.data]);
  const sprintNameById = useMemo(
    () => new Map(sprintList.map((s) => [s.id, s.name])),
    [sprintList],
  );

  const filters = {
    type: typeFilter === 'all' ? undefined : typeFilter,
    clusterId: filterClusterId || undefined,
    assignee: filterAssignee || undefined,
    category: filterCategory || undefined,
    priority: filterPriority || undefined,
    module: filterModule || undefined,
    sprintId: filterSprintId || undefined,
    startedFrom: filterFrom || undefined,
    startedTo: filterTo || undefined,
  };

  const { data, isLoading, error } = useWorkItems(filters);
  const items = data?.data ?? [];
  // G-I9: ConfirmDialog state — window.confirm 대체
  const [confirmDelete, setConfirmDelete] = useState<WorkItem | null>(null);
  const [customFieldsOpen, setCustomFieldsOpen] = useState(false);
  const [jiraOpen, setJiraOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createParent, setCreateParent] = useState<WorkItem | null>(null);
  const { data: jiraConfig } = useJiraConfig();

  const { orderedItems: dndTasks, handleDragEnd: dndHandleDragEnd } = useLocalOrder(items, 'k8s:order:items');
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleSort = (col: WorkItemSortKey) => {
    if (sortKey === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(col);
      setSortDir('asc');
    }
  };

  // Column sort overrides DnD order; when no sort active, use DnD order
  const sortedTasks = sortKey
    ? [...items].sort((a, b) => {
        let cmp = 0;
        if (sortKey === 'kanbanStatus') {
          const ORDER: Record<string, number> = { backlog: 0, todo: 1, in_progress: 2, review_test: 3, done: 4 };
          cmp = (ORDER[a.kanbanStatus ?? 'todo'] ?? 1) - (ORDER[b.kanbanStatus ?? 'todo'] ?? 1);
        } else if (sortKey === 'priority') {
          cmp = (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1);
        } else if (sortKey === 'assignee') {
          cmp = a.assignee.localeCompare(b.assignee);
        } else if (sortKey === 'clusterName') {
          cmp = (a.clusterName ?? '').localeCompare(b.clusterName ?? '');
        } else if (sortKey === 'category') {
          cmp = a.category.localeCompare(b.category);
        } else if (sortKey === 'startedAt') {
          cmp = a.startedAt.localeCompare(b.startedAt);
        } else if (sortKey === 'closedAt') {
          cmp = (a.closedAt ?? '').localeCompare(b.closedAt ?? '');
        }
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : dndTasks;

  const deleteTask = useDeleteWorkItem();
  const createTask = useCreateWorkItem();
  const toast = useToast();

  const handleDelete = (item: WorkItem) => setConfirmDelete(item);
  const doDelete = () => {
    if (!confirmDelete) return;
    const id = confirmDelete.id;
    const label = confirmDelete.title?.trim() || confirmDelete.category || '업무';
    setConfirmDelete(null);
    deleteTask.mutate(id, {
      onSuccess: () => {
        localStorage.removeItem('k8s:img:work-item:' + id);
        toast.success('업무 삭제됨', `"${label}" 업무를 삭제했습니다.`);
      },
      onError: (err: unknown) => {
        // 백엔드 detail 은 string 또는 {message,...} dict 두 형태 모두 가능.
        const resp = (err as { response?: { data?: { detail?: unknown }; status?: number } })?.response;
        const detail = resp?.data?.detail;
        const msg =
          typeof detail === 'string'
            ? detail
            : (detail as { message?: string })?.message
              ?? (resp?.status === 403
                ? '본인이 등록했거나 담당인 업무만 삭제할 수 있습니다.'
                : '업무 삭제 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
        toast.error('삭제 실패', msg);
      },
    });
  };

  // 행/카드의 ✏️ 버튼 — 상세 페이지를 편집 모드로 바로 연다 (별도 수정 페이지 없음).
  const handleEdit = (item: WorkItem) => {
    navigate(`/tasks-mgmt/${item.id}?edit=1`);
  };

  // 하위 업무 등록 — 페이지 전환 없이 팝업으로.
  const handleAddSubItem = (item: WorkItem) => {
    setCreateParent(item);
    setCreateOpen(true);
  };

  // 신규 등록 — type tab 의 현재 값으로 기본 type 결정 (전체 탭이면 task 가 기본). 팝업으로 등록.
  const handleCreateNew = () => {
    setCreateParent(null);
    setCreateOpen(true);
  };

  // 행 / 카드 클릭 — read 라우트로 진입.
  const openTaskDetail = (item: WorkItem) => {
    navigate(`/tasks-mgmt/${item.id}`);
  };

  const handleExportCsv = async () => {
    try {
      const { data: blobData } = await workItemsApi.exportCsv(filters);
      const blob = blobData instanceof Blob ? blobData : new Blob([blobData], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `items-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('CSV export failed:', e);
    }
  };

  // 이번주(월~일) 시작일 범위로 필터 설정.
  const fmtDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  // 현재 from~to 가 이번주(월~일)와 정확히 일치하는지(버튼 활성 표시용).
  const isThisWeek = (() => {
    const now = new Date();
    const diffToMon = (now.getDay() + 6) % 7;
    const mon = new Date(now); mon.setDate(now.getDate() - diffToMon);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return filterFrom === fmtDate(mon) && filterTo === fmtDate(sun);
  })();
  // 이번주 버튼 토글 — 이미 이번주 범위면 해제(범위 비움), 아니면 이번주(월~일)로 설정.
  const toggleThisWeek = () => {
    if (isThisWeek) {
      setFilterFrom('');
      setFilterTo('');
      return;
    }
    const now = new Date();
    const diffToMon = (now.getDay() + 6) % 7;   // 0=Sun..6=Sat → 월요일까지 거슬러 갈 일수
    const mon = new Date(now); mon.setDate(now.getDate() - diffToMon);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    setFilterFrom(fmtDate(mon));
    setFilterTo(fmtDate(sun));
  };

  const clearFilters = () => {
    setFilterClusterId('');
    setFilterAssignee('');
    setFilterCategory('');
    setFilterPriority('');
    setFilterModule('');
    setFilterSprintId('');
    setFilterFrom('');
    setFilterTo('');
  };

  const hasFilters = filterClusterId || filterAssignee || filterCategory || filterPriority || filterModule || filterSprintId || filterFrom || filterTo;

  const inProgressCount = items.filter((t) => t.kanbanStatus === 'in_progress').length;
  const doneCount = items.filter((t) => t.kanbanStatus === 'done').length;

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto px-4 lg:px-6 py-4">
        <div className="min-w-0">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <ListTodo className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">업무 관리 게시판</h1>
            {items.length > 0 && (
              <div className="flex items-center gap-2 ml-4">
                <span className="text-sm px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-400 border border-slate-500/30">
                  전체 {items.length}
                </span>
                {inProgressCount > 0 && (
                  <span className={`text-sm px-2 py-0.5 rounded-full border ${
                    inProgressCount >= 2
                      ? 'bg-red-500/15 text-red-400 border-red-500/30'
                      : 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                  }`}>
                    WIP {inProgressCount}/2
                    {inProgressCount >= 2 && ' ⚠'}
                  </span>
                )}
                {doneCount > 0 && (
                  <span className="text-sm px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                    Done {doneCount}
                  </span>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            {/* View mode toggle */}
            <ViewModeBar
              modes={[
                { id: 'table',    label: '목록', icon: <List        className="w-3.5 h-3.5" /> },
                { id: 'calendar', label: '달력', icon: <CalendarDays className="w-3.5 h-3.5" /> },
                { id: 'kanban',   label: '칸반', icon: <Kanban      className="w-3.5 h-3.5" /> },
              ]}
              active={viewMode}
              onChange={(v) => setViewMode(v as ViewMode)}
              showStylePanel={false}
            />

            {jiraConfig?.enabled && (
              <button
                onClick={() => setJiraOpen(true)}
                className="px-4 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors flex items-center gap-2"
                title="Jira 이슈를 work item 으로 가져오기"
              >
                <DownloadCloud className="w-4 h-4" />
                Jira 가져오기
              </button>
            )}
            {viewMode !== 'calendar' && items.length > 0 && (
              <button
                onClick={handleExportCsv}
                className="px-4 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors flex items-center gap-2"
              >
                <Download className="w-4 h-4" />
                CSV 추출
              </button>
            )}
            <button
              onClick={handleCreateNew}
              className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              업무 등록
            </button>
          </div>
        </div>

        {/* 업무 분류 드롭다운 (좌) + 검색/컬럼 컨트롤 (우) — 유형 탭을 버튼 하나로 접어 한 줄로 통합 */}
        <div className="flex items-center justify-between gap-3 mb-3 flex-nowrap">
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <TypeFilterDropdown value={typeFilter} onChange={setTypeFilter} />
          </div>

          {/* 검색 컨트롤 — 라인 패턴(rounded-lg · bg-secondary · border)으로 통일. 모듈 필터도 여기 드롭다운으로 통합(2줄→1줄) */}
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            <input
              type="text"
              value={filterAssignee}
              onChange={(e) => setFilterAssignee(e.target.value)}
              placeholder="담당자"
              aria-label="담당자 필터"
              className="w-24 px-3 py-1.5 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50"
            />
            <input
              type="text"
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              placeholder="분류"
              aria-label="분류 필터"
              className="w-24 px-3 py-1.5 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50"
            />
            <select
              value={filterPriority}
              onChange={(e) => setFilterPriority(e.target.value)}
              aria-label="우선순위 필터"
              className="px-3 py-1.5 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50"
            >
              <option value="">우선순위</option>
              <option value="high">높음</option>
              <option value="medium">보통</option>
              <option value="low">낮음</option>
            </select>
            <select
              value={filterModule}
              onChange={(e) => setFilterModule(e.target.value as WorkItemModule | '')}
              aria-label="모듈 필터"
              className="px-3 py-1.5 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50"
            >
              <option value="">전체 모듈</option>
              {(Object.entries(MODULE_CONFIG) as [WorkItemModule, { label: string; cls: string }][]).map(([key, cfg]) => (
                <option key={key} value={key}>{cfg.label}</option>
              ))}
            </select>
            {sprintList.length > 0 && (
              <select
                value={filterSprintId}
                onChange={(e) => setFilterSprintId(e.target.value)}
                aria-label="스프린트 필터"
                className="px-3 py-1.5 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50"
              >
                <option value="">전체 스프린트</option>
                {sprintList.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}{s.status === 'active' ? ' (진행중)' : ''}</option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={toggleThisWeek}
              aria-pressed={isThisWeek}
              title={isThisWeek ? '이번주 필터 해제' : '이번주(월~일) 시작 업무만 보기'}
              className={`px-2.5 py-1.5 text-sm rounded-lg border transition-colors inline-flex items-center gap-1 ${
                isThisWeek ? 'bg-primary/10 text-primary border-primary/40' : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              <CalendarRange className="w-3.5 h-3.5" /> 이번주
            </button>
            <input
              type="date"
              value={filterFrom}
              onChange={(e) => setFilterFrom(e.target.value)}
              aria-label="시작일 (이후)"
              title="시작일 (이후)"
              className="px-2 py-1.5 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50 font-mono"
            />
            <span className="text-muted-foreground text-sm">~</span>
            <input
              type="date"
              value={filterTo}
              onChange={(e) => setFilterTo(e.target.value)}
              aria-label="시작일 (이전)"
              title="시작일 (이전)"
              className="px-2 py-1.5 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50 font-mono"
            />
            {hasFilters && (
              <button
                type="button"
                onClick={clearFilters}
                aria-label="필터 초기화"
                className="px-2 py-1.5 text-sm rounded-lg border border-border bg-secondary text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
              >
                <X className="w-3 h-3" />
                초기화
              </button>
            )}
            <button
              type="button"
              onClick={toggleShowTime}
              aria-pressed={showTime}
              title={showTime ? '시작일/완료일에서 시간 숨기기' : '시작일/완료일에 시간 표시'}
              className={`px-2.5 py-1.5 text-sm rounded-lg border transition-colors inline-flex items-center gap-1 ${
                showTime ? 'bg-primary/10 text-primary border-primary/40' : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              <Clock className="w-3.5 h-3.5" /> 시간
            </button>
            <button
              type="button"
              onClick={() => setCustomFieldsOpen(true)}
              title="업무 사용자 정의 필드 관리"
              className="px-2.5 py-1.5 text-sm rounded-lg border border-border bg-secondary text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1"
            >
              <Settings2 className="w-3.5 h-3.5" /> 필드
            </button>
            <ColumnSettingsMenu
              order={colLayout.order}
              isVisible={colLayout.isVisible}
              onToggle={colLayout.toggleVisible}
              onReset={colLayout.reset}
            />
          </div>
        </div>

        {/* G-U2: error state 분기 — 이전엔 isLoading 만 있고 error 는 empty 로 흡수됐음 */}
        {error && (
          <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/5 p-3 flex items-start gap-2 text-sm text-red-600 dark:text-red-400">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>
              <div className="font-medium">업무 목록 조회 실패</div>
              <div className="text-sm text-muted-foreground mt-0.5">
                {error instanceof Error ? error.message : 'API 호출 중 오류'} — 페이지를 새로고침하거나 잠시 후 다시 시도하세요.
              </div>
            </div>
          </div>
        )}

        {/* Kanban view */}
        {viewMode === 'kanban' && (
          isLoading ? (
            <div className="grid grid-cols-3 gap-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-64 rounded-xl bg-muted/30 animate-pulse" />
              ))}
            </div>
          ) : (
            <WorkItemKanban
              items={sortedTasks}
              onItemClick={openTaskDetail}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          )
        )}

        {/* Table / Calendar view */}
        {viewMode !== 'kanban' && (viewMode === 'calendar' ? (
          <div className="bg-card border border-border rounded-xl p-6">
            {isLoading ? (
              <div className="grid grid-cols-7 gap-0">
                {[...Array(35)].map((_, i) => (
                  <div key={i} className="h-[88px] border border-border animate-pulse bg-muted/20" />
                ))}
              </div>
            ) : (
              <WorkItemCalendar items={items} onItemClick={openTaskDetail} />
            )}
          </div>
        ) : isLoading ? (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-14 border-b border-border last:border-b-0 animate-pulse bg-muted/30" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-20">
            <ListTodo className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
            <p className="text-muted-foreground mb-4">
              {hasFilters ? '검색 조건에 해당하는 업무가 없습니다.' : '등록된 업무가 없습니다.'}
            </p>
            {!hasFilters && (
              <button
                onClick={handleCreateNew}
                className="px-4 py-2 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded-lg transition-colors"
              >
                + 첫 번째 업무 등록
              </button>
            )}
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <DoubleScrollX>
              <table className="text-sm" style={{ tableLayout: 'fixed', width: 'max-content', minWidth: '100%' }}>
                <colgroup>
                  <col style={{ width: `${colW.getWidth('drag')}px` }} />
                  {visibleCols.map((k) => (
                    <col key={k} style={{ width: `${colW.getWidth(k)}px` }} />
                  ))}
                </colgroup>
                <thead>
                  <DndContext
                    sensors={headerSensors}
                    collisionDetection={closestCenter}
                    onDragEnd={(e: DragEndEvent) => {
                      if (e.over && e.active.id !== e.over.id) {
                        colLayout.reorder(e.active.id as WorkItemColumnKey, e.over.id as WorkItemColumnKey);
                      }
                    }}
                  >
                    <SortableContext items={visibleCols} strategy={horizontalListSortingStrategy}>
                      <tr className="border-b border-border bg-muted/30">
                        <th />
                        {visibleCols.map((k) => (
                          <DraggableSortHeader
                            key={k}
                            colKey={k}
                            sortKey={sortKey}
                            sortDir={sortDir}
                            onSort={handleSort}
                            colW={colW}
                          />
                        ))}
                      </tr>
                    </SortableContext>
                  </DndContext>
                </thead>
                <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={(e: DragEndEvent) => { if (e.over) dndHandleDragEnd(String(e.active.id), String(e.over.id)); }}>
                  <SortableContext items={sortedTasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                  <tbody>
                  {sortedTasks.map((item) => (
                    <WorkItemTableRow
                      key={item.id}
                      item={item}
                      clusters={clusters}
                      columns={visibleCols}
                      projectNameById={projectNameById}
                      sprintNameById={sprintNameById}
                      isDragDisabled={!!sortKey}
                      showTime={showTime}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                      onAddSubItem={handleAddSubItem}
                      onOpenDetail={openTaskDetail}
                    />
                  ))}
                  <AddWorkItemRow
                    clusters={clusters}
                    colSpan={visibleCols.length + 1}
                    defaultClusterId={filterClusterId || undefined}
                    defaultAssignee={filterAssignee || undefined}
                    onCreate={(data) => createTask.mutate(data, {
                      onSuccess: () => toast.success('업무 등록됨'),
                      onError: (err) => toast.error('등록 실패', formatApiError(err, '업무를 등록할 수 없습니다.')),
                    })}
                  />
                </tbody>
                </SortableContext>
                </DndContext>
              </table>
            </DoubleScrollX>
          </div>
        ))}
        </div>
      </main>

      <WorkItemCustomFieldsManager open={customFieldsOpen} onClose={() => setCustomFieldsOpen(false)} />

      <JiraImportModal open={jiraOpen} onClose={() => setJiraOpen(false)} defaultProjectKey={jiraConfig?.defaultProjectKey} />

      <WorkItemFormModal
        open={createOpen}
        defaultType={createParent ? undefined : (typeFilter === 'all' ? 'task' : typeFilter)}
        parentItem={createParent}
        onClose={() => { setCreateOpen(false); setCreateParent(null); }}
        onSaved={() => setCreateParent(null)}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        title="업무 삭제"
        description={confirmDelete ? `"${confirmDelete.category}" 업무를 삭제하시겠습니까?` : ''}
        confirmLabel="삭제"
        cancelLabel="취소"
        danger
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
