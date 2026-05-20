import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ClusterSidebar, ViewModeBar, DoubleScrollX} from '@/components/common';
import { Plus, Download, ListTodo, Search, X, CalendarDays, List, ChevronUp, ChevronDown, ArrowUpDown, Kanban } from 'lucide-react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { WorkItemCalendar, WorkItemKanban, WorkItemTableRow, AddWorkItemRow } from '@/components/work-items';
import { ResizeGrip } from '@/components/common';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { MODULE_CONFIG, WORK_ITEM_TYPE_CONFIG, WORK_ITEM_TYPE_ORDER } from '@/components/work-items/workItemKanbanUtils';
import { useWorkItems, useCreateWorkItem, useDeleteWorkItem } from '@/hooks/useWorkItems';
import { useClusters } from '@/hooks/useCluster';
import { useClusterStore } from '@/stores/clusterStore';
import { workItemsApi } from '@/services/api';
import { useLocalOrder } from '@/hooks/useLocalOrder';
import { WorkItem, WorkItemModule, WorkItemType } from '@/types';

type ViewMode = 'table' | 'calendar' | 'kanban';

type WorkItemSortKey = 'kanbanStatus' | 'priority' | 'assignee' | 'clusterName' | 'category' | 'startedAt' | 'closedAt';

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

function SortTh({
  label,
  col,
  sortKey,
  sortDir,
  onSort,
  className,
  onResizeMouseDown,
  onResizeDoubleClick,
}: {
  label: string;
  col: WorkItemSortKey;
  sortKey: WorkItemSortKey | '';
  sortDir: 'asc' | 'desc';
  onSort: (col: WorkItemSortKey) => void;
  className?: string;
  onResizeMouseDown?: (e: React.MouseEvent) => void;
  onResizeDoubleClick?: () => void;
}) {
  const isActive = sortKey === col;
  return (
    <th
      onClick={() => onSort(col)}
      className={`relative px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap cursor-pointer select-none group hover:text-foreground transition-colors ${className ?? ''}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive ? (
          sortDir === 'asc' ? (
            <ChevronUp className="w-3 h-3 text-primary" />
          ) : (
            <ChevronDown className="w-3 h-3 text-primary" />
          )
        ) : (
          <ArrowUpDown className="w-3 h-3 opacity-0 group-hover:opacity-40 transition-opacity" />
        )}
      </span>
      {onResizeMouseDown && <ResizeGrip onMouseDown={onResizeMouseDown} onDoubleClick={onResizeDoubleClick} />}
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
  const [sortKey, setSortKey] = useState<WorkItemSortKey | ''>('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const colW = useColumnWidths('item-board-table', {
    defaults: {
      drag: 28, status: 100, priority: 90, assignee: 200, cluster: 140, category: 120,
      content: 280, result: 280,
      startedAt: 130, closedAt: 130, remarks: 160, actions: 110,
    },
    min: 60, max: 800,
  });

  const { clusters } = useClusterStore();
  useClusters();

  const filters = {
    type: typeFilter === 'all' ? undefined : typeFilter,
    clusterId: filterClusterId || undefined,
    assignee: filterAssignee || undefined,
    category: filterCategory || undefined,
    priority: filterPriority || undefined,
    module: filterModule || undefined,
    startedFrom: filterFrom || undefined,
    startedTo: filterTo || undefined,
  };

  const { data, isLoading } = useWorkItems(filters);
  const items = data?.data ?? [];

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

  const handleDelete = (item: WorkItem) => {
    if (!confirm(`"${item.category}" 업무를 삭제하시겠습니까?`)) return;
    deleteTask.mutate(item.id);
    localStorage.removeItem('k8s:img:work-item:' + item.id);
  };

  // 행/카드의 ✏️ 버튼 — 수정 라우트로 진입.
  const handleEdit = (item: WorkItem) => {
    navigate(`/tasks-mgmt/${item.id}/edit`);
  };

  // 하위 작업 등록.
  const handleAddSubItem = (item: WorkItem) => {
    navigate(`/tasks-mgmt/new?parentId=${item.id}`);
  };

  // 신규 등록 — type tab 의 현재 값으로 기본 type 결정 (전체 탭이면 task 가 기본).
  const handleCreateNew = () => {
    const t = typeFilter === 'all' ? 'task' : typeFilter;
    navigate(`/tasks-mgmt/new?type=${t}`);
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

  const clearFilters = () => {
    setFilterClusterId('');
    setFilterAssignee('');
    setFilterCategory('');
    setFilterPriority('');
    setFilterModule('');
    setFilterFrom('');
    setFilterTo('');
  };

  const hasFilters = filterClusterId || filterAssignee || filterCategory || filterPriority || filterModule || filterFrom || filterTo;

  const inProgressCount = items.filter((t) => t.kanbanStatus === 'in_progress').length;
  const doneCount = items.filter((t) => t.kanbanStatus === 'done').length;

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto px-4 lg:px-6 py-6 flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={filterClusterId || null}
          onSelect={(id) => setFilterClusterId(id ?? '')}
          allowAll
          allLabel="전체 업무"
          iconOnly
        />
        <div className="flex-1 min-w-0">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <ListTodo className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">업무 관리 게시판</h1>
            {items.length > 0 && (
              <div className="flex items-center gap-2 ml-4">
                <span className="text-xs px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-400 border border-slate-500/30">
                  전체 {items.length}
                </span>
                {inProgressCount > 0 && (
                  <span className={`text-xs px-2 py-0.5 rounded-full border ${
                    inProgressCount >= 2
                      ? 'bg-red-500/15 text-red-400 border-red-500/30'
                      : 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                  }`}>
                    WIP {inProgressCount}/2
                    {inProgressCount >= 2 && ' ⚠'}
                  </span>
                )}
                {doneCount > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
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

        {/* Type 탭 — 전체 / 작업 / 이슈 / 회의 / 교육 / 기타 */}
        <div className="flex items-center gap-1.5 mb-3 flex-wrap">
          <button
            onClick={() => setTypeFilter('all')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
              typeFilter === 'all'
                ? 'bg-primary/10 text-primary border-primary/30'
                : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            전체
          </button>
          {WORK_ITEM_TYPE_ORDER.map((key) => {
            const cfg = WORK_ITEM_TYPE_CONFIG[key];
            const isActive = typeFilter === key;
            return (
              <button
                key={key}
                onClick={() => setTypeFilter(key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors inline-flex items-center gap-1.5 ${
                  isActive
                    ? `${cfg.cls} border-current`
                    : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                <cfg.Icon className="w-3.5 h-3.5" />
                {cfg.label}
              </button>
            );
          })}
        </div>

        {/* 모듈 뷰 탭 */}
        <div className="flex items-center gap-1.5 mb-4 flex-wrap">
          <button
            onClick={() => setFilterModule('')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
              filterModule === ''
                ? 'bg-primary/10 text-primary border-primary/30'
                : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            전체 흐름
          </button>
          {(Object.entries(MODULE_CONFIG) as [WorkItemModule, { label: string; cls: string }][]).map(([key, cfg]) => (
            <button
              key={key}
              onClick={() => setFilterModule(filterModule === key ? '' : key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                filterModule === key
                  ? `${cfg.cls} border-current`
                  : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {cfg.label}
            </button>
          ))}
        </div>

        {/* Filter Bar */}
        <div className="bg-card border border-border rounded-xl p-4 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Search className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">필터</span>
            {hasFilters && (
              <button
                onClick={clearFilters}
                className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-3 h-3" />
                초기화
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <input
              type="text"
              value={filterAssignee}
              onChange={(e) => setFilterAssignee(e.target.value)}
              placeholder="담당자 검색"
              className="px-3 py-2 text-sm bg-background border border-border rounded-lg"
            />

            <input
              type="text"
              value={filterCategory}
              onChange={(e) => setFilterCategory(e.target.value)}
              placeholder="분류 검색"
              className="px-3 py-2 text-sm bg-background border border-border rounded-lg"
            />

            <select
              value={filterPriority}
              onChange={(e) => setFilterPriority(e.target.value)}
              className="px-3 py-2 text-sm bg-background border border-border rounded-lg"
            >
              <option value="">전체 우선순위</option>
              <option value="high">높음</option>
              <option value="medium">보통</option>
              <option value="low">낮음</option>
            </select>

            <input
              type="date"
              value={filterFrom}
              onChange={(e) => setFilterFrom(e.target.value)}
              className="px-3 py-2 text-sm bg-background border border-border rounded-lg"
              title="예정일 시작"
            />

            <input
              type="date"
              value={filterTo}
              onChange={(e) => setFilterTo(e.target.value)}
              className="px-3 py-2 text-sm bg-background border border-border rounded-lg"
              title="예정일 종료"
            />
          </div>
        </div>

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
              {hasFilters ? '검색 조건에 해당하는 작업이 없습니다.' : '등록된 작업이 없습니다.'}
            </p>
            {!hasFilters && (
              <button
                onClick={handleCreateNew}
                className="px-4 py-2 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded-lg transition-colors"
              >
                + 첫 번째 작업 등록
              </button>
            )}
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <DoubleScrollX>
              <table className="text-sm" style={{ tableLayout: 'fixed', width: 'max-content', minWidth: '100%' }}>
                <colgroup>
                  {(['drag', 'status', 'priority', 'assignee', 'cluster', 'category', 'content', 'result', 'startedAt', 'closedAt', 'remarks', 'actions'] as const).map((k) => (
                    <col key={k} style={{ width: `${colW.getWidth(k)}px` }} />
                  ))}
                </colgroup>
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th />
                    <SortTh label="상태" col="kanbanStatus" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}
                      onResizeMouseDown={(e) => colW.beginResize('status', e)} onResizeDoubleClick={() => colW.autoFit('status')} />
                    <SortTh label="우선순위" col="priority" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}
                      onResizeMouseDown={(e) => colW.beginResize('priority', e)} onResizeDoubleClick={() => colW.autoFit('priority')} />
                    <SortTh label="담당자(정/부)" col="assignee" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}
                      onResizeMouseDown={(e) => colW.beginResize('assignee', e)} onResizeDoubleClick={() => colW.autoFit('assignee')} />
                    <SortTh label="대상 클러스터" col="clusterName" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}
                      onResizeMouseDown={(e) => colW.beginResize('cluster', e)} onResizeDoubleClick={() => colW.autoFit('cluster')} />
                    <SortTh label="작업 분류" col="category" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}
                      onResizeMouseDown={(e) => colW.beginResize('category', e)} onResizeDoubleClick={() => colW.autoFit('category')} />
                    <th className="relative px-4 py-3 text-left font-medium text-muted-foreground">작업 내용
                      <ResizeGrip onMouseDown={(e) => colW.beginResize('content', e)} onDoubleClick={() => colW.autoFit('content')} />
                    </th>
                    <th className="relative px-4 py-3 text-left font-medium text-muted-foreground">작업 결과
                      <ResizeGrip onMouseDown={(e) => colW.beginResize('result', e)} onDoubleClick={() => colW.autoFit('result')} />
                    </th>
                    <SortTh label="예정일" col="startedAt" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}
                      onResizeMouseDown={(e) => colW.beginResize('startedAt', e)} onResizeDoubleClick={() => colW.autoFit('startedAt')} />
                    <SortTh label="완료일" col="closedAt" sortKey={sortKey} sortDir={sortDir} onSort={handleSort}
                      onResizeMouseDown={(e) => colW.beginResize('closedAt', e)} onResizeDoubleClick={() => colW.autoFit('closedAt')} />
                    <th className="relative px-4 py-3 text-left font-medium text-muted-foreground">비고
                      <ResizeGrip onMouseDown={(e) => colW.beginResize('remarks', e)} onDoubleClick={() => colW.autoFit('remarks')} />
                    </th>
                    <th className="relative px-4 py-3 text-center font-medium text-muted-foreground whitespace-nowrap">작업
                      <ResizeGrip onMouseDown={(e) => colW.beginResize('actions', e)} onDoubleClick={() => colW.autoFit('actions')} />
                    </th>
                  </tr>
                </thead>
                <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={(e: DragEndEvent) => { if (e.over) dndHandleDragEnd(String(e.active.id), String(e.over.id)); }}>
                  <SortableContext items={sortedTasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                  <tbody>
                  {sortedTasks.map((item) => (
                    <WorkItemTableRow
                      key={item.id}
                      item={item}
                      clusters={clusters}
                      isDragDisabled={!!sortKey}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                      onAddSubItem={handleAddSubItem}
                    />
                  ))}
                  <AddWorkItemRow
                    clusters={clusters}
                    defaultClusterId={filterClusterId || undefined}
                    defaultAssignee={filterAssignee || undefined}
                    onCreate={(data) => createTask.mutate(data)}
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

    </div>
  );
}
