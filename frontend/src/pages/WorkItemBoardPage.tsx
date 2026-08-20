import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ViewModeBar, DoubleScrollX, ConfirmDialog, useToast } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { formatApiError } from '@/lib/utils';
import { Plus, Download, ListTodo, X, CalendarDays, List, ChevronUp, ChevronDown, ArrowUpDown, Kanban, ListTree, AlertCircle, AlertTriangle, GripVertical, ListFilter, DownloadCloud, CalendarRange, UserRound, Search, Save, Settings } from 'lucide-react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { WorkItemCalendar, WorkItemKanban, WorkItemTableRow, WorkItemEpicView, ColumnSettingsMenu, JiraProvisionModal, JiraLinkDialog } from '@/components/work-items';
import { WORK_ITEM_COLUMNS, DEFAULT_COLUMN_ORDER, DEFAULT_VISIBLE_COLUMNS, ALWAYS_VISIBLE_COLUMNS, COLUMN_WIDTH_DEFAULTS, type WorkItemColumnKey, type WorkItemSortKey } from '@/components/work-items';
import { ResizeGrip } from '@/components/common';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { useColumnLayout } from '@/hooks/useColumnLayout';
import { JiraImportModal } from '@/components/work-items/JiraImportModal';
import { ConfluenceLinkModal } from '@/components/work-items/ConfluenceLinkModal';
import { WorkItemBoardSettingsModal } from '@/components/work-items/WorkItemBoardSettingsModal';
import { QuickAddTaskModal } from '@/components/dashboard/QuickAddTaskModal';
import { useJiraConfig, useJiraRefreshItem, useJiraPush, useConfluenceSync } from '@/hooks/useJira';
import { MODULE_CONFIG, WORK_ITEM_TYPE_CONFIG, WORK_ITEM_TYPE_ORDER, KANBAN_COLUMNS } from '@/components/work-items/workItemKanbanUtils';
import { useWorkItems, useDeleteWorkItem } from '@/hooks/useWorkItems';
import { useClusters } from '@/hooks/useCluster';
import { useProjects } from '@/hooks/useProjects';
import { useSprints } from '@/hooks/useSprints';
import { useClusterStore } from '@/stores/clusterStore';
import { workItemsApi } from '@/services/api';
import { useLocalOrder } from '@/hooks/useLocalOrder';
import { useAuthStore, hasRole } from '@/stores/authStore';
import { useWorkItemBoardSettings } from '@/hooks/useUiSettings';
import { WorkItem, WorkItemModule, WorkItemType, JiraFieldChange, KanbanStatus } from '@/types';

type ViewMode = 'table' | 'calendar' | 'kanban' | 'epic';

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

// ── 필터 개인화 — 로그인 사용자가 마지막으로 쓴 필터 조건을 기억한다(사용자별로 분리
// 저장해 같은 브라우저를 여러 계정이 쓸 때 서로 값이 섞이지 않게 한다). ──────────────
interface WorkItemFilterPrefs {
  type: WorkItemType | 'all';
  assignee: string;
  priority: string;
  status: KanbanStatus | 'all';
  /** 등록 타입 — Jira 이슈 종류(Task/Sub-task/Bug/...). 빈 문자열 = 전체. */
  jiraType: string;
  module: WorkItemModule | '';
  sprintId: string;
  from: string;
  to: string;
  searchTitle: string;
  onlyMine: boolean;
}

// 기본 필터링은 아무것도 없는 상태(전체 담당자 · 전체 유형/상태 · 조건 없음)로 시작한다.
// "필터 저장" 버튼을 눌러야 이 값이 사용자별로 덮어써진다 — 매 키 입력마다 자동 저장하지 않는다.
const EMPTY_FILTER_PREFS: WorkItemFilterPrefs = {
  type: 'all', assignee: '', priority: '', status: 'all', jiraType: '', module: '', sprintId: '', from: '', to: '', searchTitle: '', onlyMine: false,
};

function filterPrefsKey(username: string): string {
  return `k8s:item-board:filters:${username}`;
}

function loadFilterPrefs(username: string): WorkItemFilterPrefs {
  if (!username) return EMPTY_FILTER_PREFS;
  try {
    const raw = localStorage.getItem(filterPrefsKey(username));
    if (!raw) return EMPTY_FILTER_PREFS;
    return { ...EMPTY_FILTER_PREFS, ...JSON.parse(raw) };
  } catch {
    return EMPTY_FILTER_PREFS;
  }
}

/** 컬럼 헤더 — 드래그 핸들(순서 변경) + 정렬 토글 + 우측 리사이즈 그립. */
/** 업무 분류(유형) 필터 — 4개 탭(이슈 대응/회의/운영 대응/기타)을 버튼 하나 + 드롭다운으로 접어 한 줄에 들어오게. */
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

/** 상태(칸반) 필터 — TypeFilterDropdown 과 동일한 패턴, KANBAN_COLUMNS 기준. */
function StatusFilterDropdown({
  value, onChange,
}: {
  value: KanbanStatus | 'all';
  onChange: (v: KanbanStatus | 'all') => void;
}) {
  const [open, setOpen] = useState(false);
  const current = value === 'all' ? null : KANBAN_COLUMNS.find((c) => c.key === value) ?? null;
  const active = value !== 'all';
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors inline-flex items-center gap-1.5 ${
          active ? 'bg-primary/10 text-primary border-primary/40' : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
        }`}
      >
        {current ? <span className={`w-2 h-2 rounded-full ${current.dotCls}`} /> : <ListFilter className="w-3.5 h-3.5" />}
        {current ? current.label : '상태'}
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
              <ListFilter className="w-3.5 h-3.5" /> 전체 상태
            </button>
            {KANBAN_COLUMNS.map((col) => (
              <button
                key={col.key}
                type="button"
                onClick={() => { onChange(col.key); setOpen(false); }}
                className={`w-full text-left px-2 py-1.5 rounded-md text-sm inline-flex items-center gap-1.5 transition-colors ${
                  value === col.key ? 'bg-primary/10 text-primary' : 'hover:bg-secondary text-foreground'
                }`}
              >
                <span className={`w-2 h-2 rounded-full ${col.dotCls}`} /> {col.label}
              </button>
            ))}
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
      className={`relative py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap select-none bg-muted/30 group ${
        meta.tightRight ? 'pl-4 pr-1' : 'px-4'
      }`}
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
  const currentUser = useAuthStore((s) => s.user);
  const myName = (currentUser?.displayName?.trim() || currentUser?.username || '').trim();
  const myUsername = currentUser?.username || '';
  // 필터 개인화 — 로그인 사용자가 마지막으로 "필터 저장" 을 눌렀을 때의 조건을 이번
  // 마운트에서 딱 1번만 읽는다(저장 버튼을 누르지 않으면 다음 방문은 항상 빈 필터로
  // 시작한다). 사용자가 바뀌어도(재로그인) 컴포넌트가 다시 마운트되므로 그 시점 값을
  // 다시 읽는다.
  const savedFilters = useMemo(() => loadFilterPrefs(myUsername), [myUsername]);

  const [viewMode, setViewMode] = useState<ViewMode>('table');
  // 업무 관리 게시판 공통 설정(admin 전용) — 뷰 노출/기본 뷰, 헤더 배지 노출.
  const { data: boardSettings } = useWorkItemBoardSettings();
  const isAdmin = hasRole(currentUser, 'admin');
  // 서버 기본 뷰는 최초 로드 시 1번만 적용 — 이후 리페치로 사용자가 이미 바꾼 뷰를
  // 덮어쓰지 않는다 (HomePage.tsx 의 appliedServerDefault 패턴과 동일).
  const appliedDefaultView = useRef(false);
  useEffect(() => {
    if (appliedDefaultView.current || boardSettings === undefined) return;
    appliedDefaultView.current = true;
    setViewMode(boardSettings.defaultView);
  }, [boardSettings]);
  const [typeFilter, setTypeFilter] = useState<WorkItemType | 'all'>(savedFilters.type);
  const [filterClusterId, setFilterClusterId] = useState('');
  const [filterAssignee, setFilterAssignee] = useState(savedFilters.assignee);
  const [filterPriority, setFilterPriority] = useState(savedFilters.priority);
  const [filterFrom, setFilterFrom] = useState(savedFilters.from);
  const [filterTo, setFilterTo] = useState(savedFilters.to);
  const [filterModule, setFilterModule] = useState<WorkItemModule | ''>(savedFilters.module);
  const [filterKanbanStatus, setFilterKanbanStatus] = useState<KanbanStatus | 'all'>(savedFilters.status);
  const [filterJiraType, setFilterJiraType] = useState(savedFilters.jiraType);
  // 제목 검색 — 서버사이드 ILIKE(title/content). 타이핑 중 매 키 입력마다 재조회하지
  // 않도록 300ms 디바운스 후 실제 필터(debouncedSearchTitle)에 반영.
  const [searchTitle, setSearchTitle] = useState(savedFilters.searchTitle);
  const [debouncedSearchTitle, setDebouncedSearchTitle] = useState(savedFilters.searchTitle);
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearchTitle(searchTitle), 300);
    return () => window.clearTimeout(t);
  }, [searchTitle]);
  // 스프린트 페이지의 '게시판에서 보기' 딥링크(?sprint=...) 를 초기 필터로 반영. 딥링크가
  // 없으면 아래 useEffect 가 현재(진행중) 스프린트로 기본값을 채운다(개인화 저장 대상에서는
  // 제외 — 그 기본값 effect 가 항상 덮어써 저장해봐야 의미가 없다).
  const [searchParams] = useSearchParams();
  // 스프린트 페이지의 '게시판에서 보기' 딥링크(?sprint=...)가 저장된 필터보다 우선한다.
  const [filterSprintId, setFilterSprintId] = useState(searchParams.get('sprint') || savedFilters.sprintId);
  // 기본 정렬 = 시작일 최신순(기존 백엔드 정렬과 동일 — 사용자가 다른 컬럼을 클릭하면 바뀐다).
  const [sortKey, setSortKey] = useState<WorkItemSortKey | ''>('startedAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  // "내 업무" 토글 — 기본은 꺼짐(전체 담당자). "필터 저장" 을 눌러야 다음 방문에도 유지된다.
  const [onlyMine, setOnlyMine] = useState<boolean>(savedFilters.onlyMine);
  const toggleOnlyMine = () => setOnlyMine((v) => !v);

  // 컬럼 폭/순서/표시여부 개인화 — 필터와 동일하게 사용자별로 분리 저장한다(로그인 전
  // 짧은 순간은 공용 키로 폴백, loadFilterPrefs 와 같은 guard 패턴).
  // v2 — 기본 컬럼 순서/표시여부를 재정의(DL/WIKI/상위업무/이슈종류 기본 노출)하면서 키를
  // 올렸다. v3 — 상위업무 기본 숨김 전환, 담당자 단일화로 폭 축소(200→130), 등록
  // 타입/DL#/WIKI 기본폭을 칩 크기에 맞게 축소(오른쪽 여백 버그 수정)하면서 다시 올렸다.
  // 이전에 방문해 구 기본값이 이미 저장된 사용자도 새 기본값을 그대로 받게 하기 위함 —
  // 키를 그대로 두면 저장된 값이 새 기본값을 덮어써 컬럼 설정에서 수동으로 "기본값으로
  // 복원"을 누르기 전까지 새 기본 배치가 전혀 반영되지 않는다.
  const colStorageKey = myUsername ? `item-board-table-v3:${myUsername}` : 'item-board-table-v3';
  const colW = useColumnWidths(colStorageKey, {
    defaults: COLUMN_WIDTH_DEFAULTS,
    min: 60, max: 800,
  });

  const colLayout = useColumnLayout<WorkItemColumnKey>(colStorageKey, {
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

  // 담당자 입력칸에 직접 값을 넣으면 그쪽이 우선 — "내 업무" 는 비어 있을 때의 기본값이다.
  const effectiveAssignee = filterAssignee || (onlyMine && myName ? myName : '');

  const filters = {
    type: typeFilter === 'all' ? undefined : typeFilter,
    clusterId: filterClusterId || undefined,
    assignee: effectiveAssignee || undefined,
    priority: filterPriority || undefined,
    kanbanStatus: filterKanbanStatus === 'all' ? undefined : filterKanbanStatus,
    jiraIssueType: filterJiraType || undefined,
    module: filterModule || undefined,
    sprintId: filterSprintId || undefined,
    startedFrom: filterFrom || undefined,
    startedTo: filterTo || undefined,
    q: debouncedSearchTitle.trim() || undefined,
  };

  const { data, isLoading, error } = useWorkItems(filters);
  const items = data?.data ?? [];
  // "등록 타입" 드롭다운 옵션 — Jira 이슈 종류는 프로젝트마다 값이 달라 고정 enum 이 아니다.
  // 지금까지 어떤 필터 조합으로든 조회에 걸려든 값을 계속 누적해 옵션으로 쓴다 — 등록
  // 타입으로 좁혀 걸었을 때 그 값 하나만 남아 다른 옵션이 사라지는 걸 막기 위함(한 번이라도
  // 넓게 조회된 적이 있으면 계속 선택지에 남는다).
  const [seenJiraTypes, setSeenJiraTypes] = useState<string[]>([]);
  useEffect(() => {
    const found = Array.from(new Set(items.map((i) => i.jiraIssueType).filter((t): t is string => !!t)));
    if (found.some((t) => !seenJiraTypes.includes(t))) {
      setSeenJiraTypes((prev) => Array.from(new Set([...prev, ...found])).sort());
    }
    // seenJiraTypes 를 deps 에 넣으면 갱신 직후 다시 실행되며 무한 루프가 될 수 있어 제외 —
    // items 가 바뀔 때만 "새로 본 값이 있는지" 확인하면 충분하다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  // G-I9: ConfirmDialog state — window.confirm 대체
  const [confirmDelete, setConfirmDelete] = useState<WorkItem | null>(null);
  const [jiraOpen, setJiraOpen] = useState(false);
  const [confluenceOpen, setConfluenceOpen] = useState(false);
  const [boardSettingsOpen, setBoardSettingsOpen] = useState(false);
  // 업무 등록/수정/하위 업무 등록 — 홈 화면 "업무 등록"과 동일한 팝업(QuickAddTaskModal)
  // 하나로 통일. initial 이 있으면 수정 모드, subItemParent 가 있으면 하위 업무 등록
  // 모드(상위 업무를 읽기전용으로 보여줌), 둘 다 없으면 신규(상위) 등록.
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<WorkItem | null>(null);
  const [subItemParent, setSubItemParent] = useState<WorkItem | null>(null);
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
        } else if (sortKey === 'dueDate') {
          // 마감일 없는 항목은 항상 맨 뒤로 — 오름차순 정렬 시 지연 업무가 위로 모이게.
          cmp = (a.dueDate ?? '9999-99-99').localeCompare(b.dueDate ?? '9999-99-99');
        } else if (sortKey === 'jiraEpic') {
          // Epic 이 없으면 상위 이슈로 대체 — 표에 보이는 값과 같은 기준으로 정렬한다.
          const epic = (t: WorkItem) => t.jiraEpicKey || t.jiraParentKey || t.jiraEpic || '';
          cmp = epic(a).localeCompare(epic(b));
        } else if (sortKey === 'jiraType') {
          cmp = (a.jiraIssueType ?? '').localeCompare(b.jiraIssueType ?? '');
        }
        return sortDir === 'asc' ? cmp : -cmp;
      })
    : dndTasks;

  const deleteTask = useDeleteWorkItem();
  const toast = useToast();

  // 필터 저장 — 자동 저장 대신 이 버튼을 눌러야 다음 방문에 그대로 복원된다(기본 필터는
  // 항상 빈 상태로 시작 — EMPTY_FILTER_PREFS).
  const saveFilterPrefs = () => {
    if (!myUsername) return;
    const prefs: WorkItemFilterPrefs = {
      type: typeFilter, assignee: filterAssignee, priority: filterPriority, status: filterKanbanStatus,
      jiraType: filterJiraType, module: filterModule, sprintId: filterSprintId, from: filterFrom, to: filterTo,
      searchTitle: debouncedSearchTitle, onlyMine,
    };
    try {
      localStorage.setItem(filterPrefsKey(myUsername), JSON.stringify(prefs));
      toast.success('필터 저장됨', '지금 설정을 다음 방문에도 그대로 사용합니다.');
    } catch {
      toast.error('필터 저장 실패', '브라우저 저장 공간을 확인해주세요.');
    }
  };

  // 컬럼 순서/표시여부/폭은 이미 바뀔 때마다 자동 저장되지만(디바운스), "지금 이대로
  // 저장됐다"를 사용자가 확인할 방법이 없었다 — 컬럼 설정 박스의 "저장" 버튼은 디바운스를
  // 건너뛰고 즉시 저장 + 토스트로 확인해준다. "기본값으로 복원"은 순서/표시여부만 되돌리던
  // 것을 폭까지 함께 되돌리도록 같이 고쳤다(그동안 폭만 안 돌아가는 게 실질적인 버그였음).
  const saveColumnPrefs = () => {
    colLayout.saveNow();
    colW.saveNow();
    toast.success('컬럼 설정 저장됨', '지금 순서·표시여부·폭을 다음 방문에도 그대로 사용합니다.');
  };
  const resetColumnPrefs = () => {
    colLayout.reset();
    colW.reset();
  };

  // Jira 연결 업무의 행 단위 동기화 — 다시 가져오기 / 수정 내용 보내기.
  const jiraRefresh = useJiraRefreshItem();
  const jiraPush = useJiraPush();
  const [jiraBusyId, setJiraBusyId] = useState<string | null>(null);
  // Confluence 연결 업무의 행 단위 동기화(반영) — Jira "보내기"와 동일한 패턴.
  const confluenceSync = useConfluenceSync();
  const [confluenceBusyId, setConfluenceBusyId] = useState<string | null>(null);
  // 업무 생성 직후 Jira·Confluence 자동 생성 모달을 띄운다(연동이 켜져 있을 때만).
  const [provisionItem, setProvisionItem] = useState<WorkItem | null>(null);
  // Jira 연결 관리(해제/변경/삭제) — 재가져오기가 "Jira 에 없음"으로 끝나면 사유와 함께 자동으로 연다.
  const [linkItem, setLinkItem] = useState<WorkItem | null>(null);
  const [linkMissingDetail, setLinkMissingDetail] = useState<string | undefined>();

  const openJiraLink = (item: WorkItem, missingDetail?: string) => {
    setLinkMissingDetail(missingDetail);
    setLinkItem(item);
  };

  const handleJiraRefresh = async (item: WorkItem) => {
    setJiraBusyId(item.id);
    try {
      const { data } = await jiraRefresh.mutateAsync(item.id);
      if (data.status === 'missing') {
        // 이슈가 지워졌거나 권한이 없다 — 토스트로 끝내면 사용자가 할 수 있는 게 없으므로
        // 연결을 해제/변경할 수 있는 다이얼로그를 바로 띄운다.
        openJiraLink(item, data.detail);
        return;
      }
      if (data.status !== 'ok') {
        toast.error('Jira 재가져오기 실패', data.detail);
        return;
      }
      const changed = data.items[0]?.changes ?? [];
      toast.success(
        changed.length ? `${item.jiraIssueKey} 갱신됨` : `${item.jiraIssueKey} 변경 없음`,
        changed.length ? changed.map((c: JiraFieldChange) => c.label || c.field).join(', ') : data.detail,
      );
    } catch (err) {
      toast.error('Jira 재가져오기 실패', formatApiError(err));
    } finally {
      setJiraBusyId(null);
    }
  };

  const handleJiraPush = async (item: WorkItem) => {
    setJiraBusyId(item.id);
    try {
      const { data } = await jiraPush.mutateAsync({ itemId: item.id, data: { pushFields: true } });
      if (data.status === 'conflict') {
        toast.show({
          variant: 'error',
          title: 'Jira 쪽이 더 최신입니다',
          description: data.detail,
          action: { label: '다시 가져오기', onClick: () => void handleJiraRefresh(item) },
        });
        return;
      }
      if (data.status !== 'ok') {
        toast.error('Jira 반영 실패', data.detail);
        return;
      }
      const parts = [
        data.fieldsUpdated.length ? `필드 ${data.fieldsUpdated.join(', ')}` : '',
        data.transitioned ? '상태 전이' : '',
      ].filter(Boolean);
      toast.success(`${item.jiraIssueKey} 반영 완료`, parts.join(' · ') || data.detail);
    } catch (err) {
      toast.error('Jira 반영 실패', formatApiError(err));
    } finally {
      setJiraBusyId(null);
    }
  };

  const handleConfluenceSync = async (item: WorkItem) => {
    setConfluenceBusyId(item.id);
    try {
      const { data } = await confluenceSync.mutateAsync(item.id);
      if (data.status !== 'ok') {
        toast.error('Confluence 반영 실패', data.detail);
        return;
      }
      toast.success('Confluence 문서 반영 완료', data.detail);
    } catch (err) {
      toast.error('Confluence 반영 실패', formatApiError(err));
    } finally {
      setConfluenceBusyId(null);
    }
  };


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

  // 행/카드의 ✏️ 버튼 — "업무 등록"과 동일한 팝업(QuickAddTaskModal)을 수정 모드로 연다.
  // 본문(리치텍스트)·모듈·서비스 등 이 팝업이 다루지 않는 필드는 팝업의 "상세 수정" 링크로 이동.
  const handleEdit = (item: WorkItem) => {
    setEditingItem(item);
  };

  // 하위 업무 등록 — 페이지 전환 없이 팝업으로 (QuickAddTaskModal 을 parentItem 과 함께 재사용).
  const handleAddSubItem = (item: WorkItem) => {
    setSubItemParent(item);
  };

  // 신규 등록 — 홈 "업무 현황"의 "업무 등록"과 동일한 QuickAddTaskModal 팝업으로 통일.
  const handleCreateNew = () => {
    setQuickAddOpen(true);
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
      toast.error('CSV 추출 실패', formatApiError(e));
    }
  };

  // 이번주 → 2주(이번주+다음주) → 이번달 → 해제, 4단계 순환 시작일 범위 필터.
  const fmtDate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const DATE_RANGE_MODES = ['week', 'twoWeek', 'month'] as const;
  const DATE_FILTER_LABELS: Record<(typeof DATE_RANGE_MODES)[number], string> = {
    week: '이번주', twoWeek: '2주', month: '이번달',
  };
  // 오늘 기준 이번주(월~일)/2주(이번주 월~다음주 일)/이번달(1일~말일) 후보 범위.
  const dateRanges = (() => {
    const now = new Date();
    const diffToMon = (now.getDay() + 6) % 7; // 0=Sun..6=Sat → 월요일까지 거슬러 갈 일수
    const mon = new Date(now); mon.setDate(now.getDate() - diffToMon);
    const weekSun = new Date(mon); weekSun.setDate(mon.getDate() + 6);
    const twoWeekSun = new Date(mon); twoWeekSun.setDate(mon.getDate() + 13);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return {
      week: [fmtDate(mon), fmtDate(weekSun)] as const,
      twoWeek: [fmtDate(mon), fmtDate(twoWeekSun)] as const,
      month: [fmtDate(monthStart), fmtDate(monthEnd)] as const,
    };
  })();
  // 현재 from~to 가 후보 범위 중 하나와 정확히 일치하면 그 단계, 아니면(직접 입력 등) null.
  const dateFilterMode = DATE_RANGE_MODES.find(
    (m) => filterFrom === dateRanges[m][0] && filterTo === dateRanges[m][1],
  ) ?? null;
  // 버튼 클릭 시 다음 단계로 순환 — null→이번주→2주→이번달→null(해제).
  const cycleDateFilter = () => {
    const idx = dateFilterMode ? DATE_RANGE_MODES.indexOf(dateFilterMode) : -1;
    const next = DATE_RANGE_MODES[idx + 1];
    if (!next) {
      setFilterFrom('');
      setFilterTo('');
    } else {
      setFilterFrom(dateRanges[next][0]);
      setFilterTo(dateRanges[next][1]);
    }
  };

  const clearFilters = () => {
    setFilterClusterId('');
    setFilterAssignee('');
    setFilterPriority('');
    setFilterKanbanStatus('all');
    setFilterJiraType('');
    setFilterModule('');
    setFilterSprintId('');
    setFilterFrom('');
    setFilterTo('');
    setSearchTitle('');
  };

  // "내 업무"(기본값)는 초기화 대상이 아니다 — 빈 목록이 떴을 때 안내 문구를 고르는 데만 쓴다.
  const hasFilters = !!(filterClusterId || filterAssignee || filterPriority
    || filterKanbanStatus !== 'all' || filterJiraType || filterModule || filterSprintId || filterFrom || filterTo || searchTitle);
  const isFilteredView = hasFilters || (onlyMine && !!myName);

  const inProgressCount = items.filter((t) => t.kanbanStatus === 'in_progress').length;
  const doneCount = items.filter((t) => t.kanbanStatus === 'done').length;
  // 칸반 뷰(WorkItemKanban)와 동일한 값을 참조 — 헤더/칸반이 서로 다른 임계값으로
  // "위험"을 보고하면 사용자가 어느 쪽을 믿어야 할지 학습 비용이 든다.
  const wipLimit = KANBAN_COLUMNS.find((c) => c.key === 'in_progress')?.wipLimit ?? 2;
  // 마감일 컬럼에만 있던 지연 강조를 헤더에서도 볼 수 있게 — dueDate 를 스크롤해서
  // 우연히 보지 않는 한 지연이 쌓이고 있다는 걸 알 방법이 없었다.
  const todayStr = new Date().toISOString().slice(0, 10);
  const overdueCount = items.filter(
    (t) => !!t.dueDate && t.kanbanStatus !== 'done' && t.dueDate.slice(0, 10) < todayStr,
  ).length;
  const focusOverdue = () => {
    setViewMode('table');
    setSortKey('dueDate');
    setSortDir('asc');
  };

  return (
    <div className="app-min-h-screen bg-background">
      <main className="mx-auto px-4 lg:px-6 py-4">
        <div className="min-w-0">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <ListTodo className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">업무 관리 게시판</h1>
            {isAdmin && (
              <button
                type="button"
                onClick={() => setBoardSettingsOpen(true)}
                title="업무 관리 게시판 설정"
                aria-label="업무 관리 게시판 설정"
                className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              >
                <Settings className="w-4 h-4" />
              </button>
            )}
            {items.length > 0 && (
              <div className="flex items-center gap-2 ml-4">
                {boardSettings?.badgeVisibility.total && (
                  <span className="text-sm px-2 py-0.5 rounded-full bg-status-unknown/15 text-status-unknown border border-status-unknown/30">
                    전체 {items.length}
                  </span>
                )}
                {boardSettings?.badgeVisibility.wip && inProgressCount > 0 && (
                  <span className={`inline-flex items-center gap-1 text-sm px-2 py-0.5 rounded-full border ${
                    inProgressCount > wipLimit
                      ? 'bg-status-critical/15 text-status-critical border-status-critical/30'
                      : 'bg-status-warning/15 text-status-warning border-status-warning/30'
                  }`}>
                    WIP {inProgressCount}/{wipLimit}
                    {inProgressCount > wipLimit && (
                      <AlertTriangle className="w-3.5 h-3.5" aria-label="WIP 권장 한도 초과" />
                    )}
                  </span>
                )}
                {boardSettings?.badgeVisibility.done && doneCount > 0 && (
                  <span className="text-sm px-2 py-0.5 rounded-full bg-status-healthy/15 text-status-healthy border border-status-healthy/30">
                    Done {doneCount}
                  </span>
                )}
                {boardSettings?.badgeVisibility.overdue && overdueCount > 0 && (
                  <button
                    type="button"
                    onClick={focusOverdue}
                    title="지연된 업무만 마감일순으로 보기"
                    className="inline-flex items-center gap-1 text-sm px-2 py-0.5 rounded-full border bg-status-critical/15 text-status-critical border-status-critical/30 hover:bg-status-critical/25 transition-colors"
                  >
                    <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                    지연 {overdueCount}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            {/* View mode toggle */}
            <ViewModeBar
              modes={[
                { id: 'table',    label: '목록',   icon: <List        className="w-3.5 h-3.5" /> },
                { id: 'calendar', label: '달력',   icon: <CalendarDays className="w-3.5 h-3.5" /> },
                { id: 'kanban',   label: '칸반',   icon: <Kanban      className="w-3.5 h-3.5" /> },
                { id: 'epic',     label: '에픽뷰', icon: <ListTree    className="w-3.5 h-3.5" /> },
              ].filter((m) => !boardSettings || boardSettings.viewVisibility[m.id as ViewMode])}
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
                <Download className="w-4 h-4" />
                JIRA
              </button>
            )}
            {jiraConfig?.confluenceBaseUrl && (
              <button
                onClick={() => setConfluenceOpen(true)}
                className="px-4 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors flex items-center gap-2"
                title="Confluence 문서를 work item 으로 가져오기"
              >
                <DownloadCloud className="w-4 h-4" />
                Confluence
              </button>
            )}
            {viewMode !== 'calendar' && items.length > 0 && (
              <button
                onClick={handleExportCsv}
                className="px-4 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors flex items-center gap-2"
                title="현재 목록을 CSV 로 추출"
              >
                <Download className="w-4 h-4" />
                CSV
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

        {/* 필터 바 — 모든 조건을 한 줄에 인라인으로 노출한다("필터 더보기" 팝오버로 묶지
            않음). 기본 필터링은 항상 비어 있고(EMPTY_FILTER_PREFS), "필터 저장" 을 눌러야
            지금 조합이 다음 방문에도 그대로 복원된다. */}
        <div className="flex items-center gap-1.5 flex-wrap mb-3">
          <TypeFilterDropdown value={typeFilter} onChange={setTypeFilter} />
          <StatusFilterDropdown value={filterKanbanStatus} onChange={setFilterKanbanStatus} />
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={searchTitle}
              onChange={(e) => setSearchTitle(e.target.value)}
              placeholder="제목 검색"
              aria-label="제목 검색"
              className="w-32 pl-8 pr-3 py-1.5 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50"
            />
          </div>
          {myName && (
            <button
              type="button"
              onClick={toggleOnlyMine}
              aria-pressed={onlyMine}
              title={onlyMine ? `내 업무(${myName})만 보는 중 — 눌러서 전체 보기` : '내 업무만 보기'}
              className={`px-2.5 py-1.5 text-sm rounded-lg border transition-colors inline-flex items-center gap-1 ${
                onlyMine ? 'bg-primary/10 text-primary border-primary/40' : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              <UserRound className="w-3.5 h-3.5" /> 내 업무
            </button>
          )}
          <input
            type="text"
            value={filterAssignee}
            onChange={(e) => setFilterAssignee(e.target.value)}
            placeholder={onlyMine && myName ? myName : '담당자'}
            aria-label="담당자"
            className="w-24 px-2.5 py-1.5 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50"
          />
          <select
            value={filterPriority}
            onChange={(e) => setFilterPriority(e.target.value)}
            aria-label="우선순위"
            className="px-2 py-1.5 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50"
          >
            <option value="">전체 우선순위</option>
            <option value="high">높음</option>
            <option value="medium">보통</option>
            <option value="low">낮음</option>
          </select>
          {seenJiraTypes.length > 0 && (
            <select
              value={filterJiraType}
              onChange={(e) => setFilterJiraType(e.target.value)}
              aria-label="등록 타입"
              className="px-2 py-1.5 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50"
            >
              <option value="">전체 등록 타입</option>
              {seenJiraTypes.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          )}
          <select
            value={filterModule}
            onChange={(e) => setFilterModule(e.target.value as WorkItemModule | '')}
            aria-label="모듈"
            className="px-2 py-1.5 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50"
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
              aria-label="스프린트"
              className="max-w-[140px] px-2 py-1.5 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50"
            >
              <option value="">전체 스프린트</option>
              {sprintList.map((s) => (
                <option key={s.id} value={s.id}>{s.name}{s.status === 'active' ? ' (진행중)' : ''}</option>
              ))}
            </select>
          )}
          <button
            type="button"
            onClick={cycleDateFilter}
            aria-pressed={dateFilterMode !== null}
            title={
              dateFilterMode === null ? '이번주(월~일) 시작 업무만 보기 — 다시 누르면 2주, 이번달 순으로 넓어지고 그다음엔 해제됩니다.'
                : dateFilterMode === 'week' ? '2주(이번주+다음주)로 넓히기'
                : dateFilterMode === 'twoWeek' ? '이번달로 넓히기'
                : '날짜 필터 해제'
            }
            className={`px-2.5 py-1.5 text-sm rounded-lg border transition-colors inline-flex items-center gap-1 flex-shrink-0 ${
              dateFilterMode !== null ? 'bg-primary/10 text-primary border-primary/40' : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            <CalendarRange className="w-3.5 h-3.5" /> {dateFilterMode !== null ? DATE_FILTER_LABELS[dateFilterMode] : '이번주'}
          </button>
          <input
            type="date"
            value={filterFrom}
            onChange={(e) => setFilterFrom(e.target.value)}
            aria-label="시작일 (이후)"
            title="시작일 (이후)"
            className="w-[130px] px-2 py-1.5 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50 font-mono"
          />
          <span className="text-muted-foreground text-sm">~</span>
          <input
            type="date"
            value={filterTo}
            onChange={(e) => setFilterTo(e.target.value)}
            aria-label="시작일 (이전)"
            title="시작일 (이전)"
            className="w-[130px] px-2 py-1.5 text-sm bg-secondary border border-border rounded-lg focus:outline-none focus:border-primary/50 font-mono"
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
            onClick={saveFilterPrefs}
            title="지금 설정한 필터를 다음 방문에도 그대로 사용"
            className="px-2.5 py-1.5 text-sm rounded-lg border border-border bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors inline-flex items-center gap-1"
          >
            <Save className="w-3.5 h-3.5" /> 필터 저장
          </button>
          <div className="ml-auto flex items-center gap-1.5 flex-wrap border-l border-border pl-2">
            <ColumnSettingsMenu
              order={colLayout.order}
              isVisible={colLayout.isVisible}
              onToggle={colLayout.toggleVisible}
              onReset={resetColumnPrefs}
              onSave={saveColumnPrefs}
            />
          </div>
        </div>

        {/* G-U2: error state 분기 — 이전엔 isLoading 만 있고 error 는 empty 로 흡수됐음 */}
        {error && (
          <div className="mb-4 rounded-md border border-status-critical/40 bg-status-critical/5 p-3 flex items-start gap-2 text-sm text-status-critical">
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
            // 실제 칸반 컬럼 구조(헤더 + 카드 스택)를 반영한 skeleton — 로드 시 컬럼 수/레이아웃 시프트 방지
            <div className="flex gap-3 overflow-x-auto pb-2" aria-busy="true" aria-label="칸반 보드 불러오는 중">
              {KANBAN_COLUMNS.map((col) => (
                <div key={col.key} className="flex-1 min-w-[240px] flex flex-col gap-2">
                  <div className={`flex items-center gap-2 px-3 py-2 rounded-md border ${col.headerCls}`}>
                    <span className={`w-2.5 h-2.5 rounded-full ${col.dotCls}`} />
                    <span className="text-sm font-semibold">{col.label}</span>
                  </div>
                  {[...Array(3)].map((_, i) => (
                    <div key={i} className="h-24 rounded-md border border-border bg-muted/20 animate-pulse" />
                  ))}
                </div>
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

        {/* Calendar view */}
        {viewMode === 'calendar' && (
          <MacCard bodyPadding="p-6">
            {isLoading ? (
              <div className="grid grid-cols-7 gap-0">
                {[...Array(35)].map((_, i) => (
                  <div key={i} className="h-[88px] border border-border animate-pulse bg-muted/20" />
                ))}
              </div>
            ) : (
              <WorkItemCalendar items={items} onItemClick={openTaskDetail} />
            )}
          </MacCard>
        )}

        {/* Epic view — Epic → Task → Sub-task 계층 (기본 펼침, 접기/펼치기 가능) */}
        {viewMode === 'epic' && (
          isLoading ? (
            <MacCard bodyPadding="p-0" rootClassName="overflow-hidden">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-14 border-b border-border last:border-b-0 animate-pulse bg-muted/30" />
              ))}
            </MacCard>
          ) : items.length === 0 ? (
            <div className="text-center py-20">
              <ListTodo className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
              <p className="text-muted-foreground mb-4">
                {onlyMine && myName && !hasFilters
                  ? `${myName} 담당 업무가 없습니다 — "내 업무" 를 끄면 전체를 볼 수 있습니다.`
                  : isFilteredView ? '검색 조건에 해당하는 업무가 없습니다.' : '등록된 업무가 없습니다.'}
              </p>
              {!isFilteredView && (
                <button
                  onClick={handleCreateNew}
                  className="px-4 py-2 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded-lg transition-colors"
                >
                  + 첫 번째 업무 등록
                </button>
              )}
            </div>
          ) : (
            <MacCard bodyPadding="p-0" rootClassName="overflow-hidden">
              <WorkItemEpicView
                items={items}
                onItemClick={openTaskDetail}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onAddSubItem={handleAddSubItem}
                onJiraRefresh={handleJiraRefresh}
                onJiraPush={handleJiraPush}
                jiraBusyId={jiraBusyId}
                onJiraProvision={jiraConfig?.enabled ? setProvisionItem : undefined}
                onJiraLink={(t) => openJiraLink(t)}
                onConfluenceSync={handleConfluenceSync}
                confluenceBusyId={confluenceBusyId}
              />
            </MacCard>
          )
        )}

        {/* Table view */}
        {viewMode === 'table' && (
          isLoading ? (
            <MacCard bodyPadding="p-0" rootClassName="overflow-hidden">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-14 border-b border-border last:border-b-0 animate-pulse bg-muted/30" />
              ))}
            </MacCard>
          ) : items.length === 0 ? (
            <div className="text-center py-20">
              <ListTodo className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
              <p className="text-muted-foreground mb-4">
                {onlyMine && myName && !hasFilters
                  ? `${myName} 담당 업무가 없습니다 — "내 업무" 를 끄면 전체를 볼 수 있습니다.`
                  : isFilteredView ? '검색 조건에 해당하는 업무가 없습니다.' : '등록된 업무가 없습니다.'}
              </p>
              {!isFilteredView && (
                <button
                  onClick={handleCreateNew}
                  className="px-4 py-2 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded-lg transition-colors"
                >
                  + 첫 번째 업무 등록
                </button>
              )}
            </div>
          ) : (
            <MacCard bodyPadding="p-0" rootClassName="overflow-hidden">
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
                          <th><span className="sr-only">정렬</span></th>
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
                        onEdit={handleEdit}
                        onDelete={handleDelete}
                        onAddSubItem={handleAddSubItem}
                        onOpenDetail={openTaskDetail}
                        onJiraRefresh={handleJiraRefresh}
                        onJiraPush={handleJiraPush}
                        jiraBusy={jiraBusyId === item.id}
                        onJiraProvision={jiraConfig?.enabled ? setProvisionItem : undefined}
                        onJiraLink={(t) => openJiraLink(t)}
                        onConfluenceSync={handleConfluenceSync}
                        confluenceBusy={confluenceBusyId === item.id}
                      />
                    ))}
                  </tbody>
                  </SortableContext>
                  </DndContext>
                </table>
              </DoubleScrollX>
            </MacCard>
          )
        )}
        </div>
      </main>

      <JiraImportModal open={jiraOpen} onClose={() => setJiraOpen(false)} defaultProjectKey={jiraConfig?.defaultProjectKey} />
      <ConfluenceLinkModal open={confluenceOpen} onClose={() => setConfluenceOpen(false)} />
      {isAdmin && (
        <WorkItemBoardSettingsModal open={boardSettingsOpen} onClose={() => setBoardSettingsOpen(false)} />
      )}
      <JiraProvisionModal open={!!provisionItem} onClose={() => setProvisionItem(null)} item={provisionItem} />
      <JiraLinkDialog
        open={!!linkItem}
        onClose={() => { setLinkItem(null); setLinkMissingDetail(undefined); }}
        item={linkItem}
        missingDetail={linkMissingDetail}
      />

      {/* 업무 등록/수정/하위 업무 등록 — 홈 "업무 현황"과 동일한 팝업. initial 지정 시 수정
          모드, subItemParent 지정 시 하위 업무 등록 모드(상위 업무 읽기전용 표시 + Jira/
          Confluence 자동 생성 체이닝은 모달 내부에서 자체 처리). */}
      <QuickAddTaskModal
        open={quickAddOpen || !!editingItem || !!subItemParent}
        initial={editingItem}
        parentItem={subItemParent}
        onClose={() => { setQuickAddOpen(false); setEditingItem(null); setSubItemParent(null); }}
        onSaved={() => setEditingItem(null)}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        title="업무 삭제"
        description={(() => {
          if (!confirmDelete) return '';
          // 성공 토스트 라벨(title || category)과 동일 계산식. 값이 없으면 빈 따옴표 노출 방지.
          const label = confirmDelete.title?.trim() || confirmDelete.category;
          return label ? `"${label}" 업무를 삭제하시겠습니까?` : '이 업무를 삭제하시겠습니까?';
        })()}
        confirmLabel="삭제"
        cancelLabel="취소"
        danger
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
