import { useState, useMemo, useEffect } from 'react';
import { Plus, Play, BookOpen, Download, ArrowUpDown, LayoutGrid, List } from 'lucide-react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { PlaybookCard, PlaybookListRow, PlaybookLogDialog, AddPlaybookModal, RunCredsModal } from '@/components/playbooks';
import type { PlaybookFormSubmit } from '@/components/playbooks/AddPlaybookModal';
import type { PlaybookSshCreds } from '@/types';
import { ClusterSidebar } from '@/components/common';
import { RoleGate } from '@/components/auth/RoleGate';
import { usePlaybooks, useCreatePlaybook, useUpdatePlaybook, useDeletePlaybook, useRunPlaybook, useToggleDashboard } from '@/hooks/usePlaybook';
import { playbooksApi } from '@/services/api';
import { usePlaybookStore } from '@/stores/playbookStore';
import { useClusters } from '@/hooks/useCluster';
import { useClusterStore } from '@/stores/clusterStore';
import { useLocalOrder } from '@/hooks/useLocalOrder';
import { Playbook } from '@/types';

type PlaybookSortKey = 'name' | 'status' | 'lastRunAt';
type ViewMode = 'list' | 'card';
const STATUS_ORDER: Record<string, number> = { critical: 0, warning: 1, healthy: 2, unknown: 3 };
// localStorage 캐시는 하지 않는다 — 페이지 진입 시 항상 리스트가 기본.
// 과거 'k8s:playbooks:view-mode' 키에 'card' 가 저장된 사용자도 잔존 캐시를 무력화하기 위해
// 마운트 시 한 번 삭제. 카드 보기는 우상단 토글로 일시적으로만 사용.
const LEGACY_VIEW_MODE_KEY = 'k8s:playbooks:view-mode';

function SortableCardCell({ playbook, isRunning, onRun, onEdit, onDelete, onToggleDashboard }: {
  playbook: Playbook; isRunning: boolean;
  onRun: () => void; onEdit: () => void; onDelete: () => void; onToggleDashboard: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: playbook.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  return (
    <div ref={setNodeRef} style={style} className="relative group/card">
      <button
        {...attributes} {...listeners}
        className="absolute top-2 left-2 z-10 cursor-grab active:cursor-grabbing p-1 rounded text-muted-foreground/30 opacity-0 group-hover/card:opacity-100 hover:text-muted-foreground hover:bg-secondary transition-all"
        title="드래그하여 순서 변경"
      >
        ⠿
      </button>
      <PlaybookCard playbook={playbook} isRunning={isRunning} onRun={onRun} onEdit={onEdit} onDelete={onDelete} onToggleDashboard={onToggleDashboard} />
    </div>
  );
}

const SESSION_CREDS_KEY = 'k8s:playbook-ssh-creds';

function readSessionCreds(): PlaybookSshCreds | null {
  try {
    const raw = sessionStorage.getItem(SESSION_CREDS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PlaybookSshCreds & { authMode?: string };
    // 비어있는 객체는 자격증명으로 취급하지 않음
    if (!parsed.ssh_username && !parsed.ssh_password && !parsed.ssh_private_key) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function PlaybooksPage() {
  const [showAdd, setShowAdd] = useState(false);
  const [editPlaybook, setEditPlaybook] = useState<Playbook | null>(null);
  // 다중 선택 — 빈 배열 = 전체 클러스터.
  const [selectedClusterIds, setSelectedClusterIds] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<PlaybookSortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  // 단일 실행 시 자격증명 모달용 — 어떤 playbook 을 실행할지 보관.
  const [credsTarget, setCredsTarget] = useState<Playbook | null>(null);
  // 상세 로그 다이얼로그 — 클릭한 playbook 보관.
  const [logTarget, setLogTarget] = useState<Playbook | null>(null);

  const { clusters } = useClusterStore();
  useClusters(); // fetch

  // 항상 전체 fetch — 클라이언트 측에서 selectedClusterIds 로 필터.
  const { isLoading } = usePlaybooks(undefined);
  const { playbooks, runningIds } = usePlaybookStore();

  const createPlaybook = useCreatePlaybook();
  const updatePlaybook = useUpdatePlaybook();
  const deletePlaybook = useDeletePlaybook();
  const runPlaybook = useRunPlaybook();
  const toggleDashboard = useToggleDashboard();

  // 사이드바에서 선택한 클러스터(들) 만 보여주기. 빈 배열이면 전체.
  const selectedClusterSet = useMemo(() => new Set(selectedClusterIds), [selectedClusterIds]);
  const basePlaybooks = useMemo(() => {
    if (selectedClusterIds.length === 0) return playbooks;
    return playbooks.filter((p) => selectedClusterSet.has(p.clusterId));
  }, [playbooks, selectedClusterIds, selectedClusterSet]);

  // 정렬 순서 보존 키 — 선택 조합이 바뀌면 별도 순서로 관리.
  const orderKey = useMemo(
    () => `k8s:order:playbooks:${selectedClusterIds.length === 0 ? '__all__' : [...selectedClusterIds].sort().join(',')}`,
    [selectedClusterIds],
  );
  const { orderedItems: dndPlaybooks, handleDragEnd: dndHandleDragEnd } = useLocalOrder(basePlaybooks, orderKey);
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // 과거에 'card' 로 저장된 사용자가 있을 수 있으므로 마운트 시 캐시를 한 번 정리한다.
  useEffect(() => {
    try { localStorage.removeItem(LEGACY_VIEW_MODE_KEY); } catch { /* ignore */ }
  }, []);

  // cluster id → name 맵 (다중 선택 시 행 옆에 라벨로 표시)
  const clusterNameMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of clusters) m[c.id] = c.name;
    return m;
  }, [clusters]);
  const showClusterLabel = selectedClusterIds.length === 0 || selectedClusterIds.length > 1;

  // 정렬 적용
  const filteredPlaybooks = useMemo(() => {
    const sorted = [...dndPlaybooks].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') {
        cmp = a.name.localeCompare(b.name);
      } else if (sortKey === 'status') {
        cmp = (STATUS_ORDER[a.status ?? 'unknown'] ?? 3) - (STATUS_ORDER[b.status ?? 'unknown'] ?? 3);
      } else if (sortKey === 'lastRunAt') {
        cmp = (a.lastRunAt ?? '').localeCompare(b.lastRunAt ?? '');
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [dndPlaybooks, sortKey, sortDir]);

  const handleCreate = (data: PlaybookFormSubmit) => {
    createPlaybook.mutate({
      name: data.name,
      description: data.description || undefined,
      playbookFileId: data.playbookFileId,
      inventoryId: data.inventoryId,
      playbookPath: data.playbookPath,
      inventoryPath: data.inventoryPath,
      tags: data.tags || undefined,
      clusterId: data.clusterId,
    });
  };

  const handleUpdate = (data: PlaybookFormSubmit) => {
    if (!editPlaybook) return;
    updatePlaybook.mutate({
      id: editPlaybook.id,
      data: {
        name: data.name,
        description: data.description || undefined,
        // 모드 전환 시 반대편 필드를 비워줘야 backend 에서 충돌 안 남
        playbookFileId: data.playbookFileId ?? null,
        inventoryId: data.inventoryId ?? null,
        playbookPath: data.playbookPath ?? null,
        inventoryPath: data.inventoryPath ?? null,
        tags: data.tags || undefined,
        clusterId: data.clusterId,
      },
    });
    setEditPlaybook(null);
  };

  const handleOpenEdit = (playbook: Playbook) => {
    setEditPlaybook(playbook);
    setShowAdd(true);
  };

  const handleModalClose = () => {
    setShowAdd(false);
    setEditPlaybook(null);
  };

  // 카드의 ▶ 버튼 클릭 — 세션에 저장된 자격증명이 있으면 그대로 실행, 없으면 모달.
  const handleRunOne = (pb: Playbook) => {
    if (runningIds.has(pb.id)) return;
    const cached = readSessionCreds();
    if (cached) {
      runPlaybook.mutate({ id: pb.id, creds: cached });
    } else {
      setCredsTarget(pb);
    }
  };

  const handleRunAll = () => {
    const cached = readSessionCreds();
    filteredPlaybooks.forEach((p) => {
      if (!runningIds.has(p.id)) {
        runPlaybook.mutate({ id: p.id, creds: cached ?? undefined });
      }
    });
  };

  const handleExportReport = async () => {
    try {
      // 단일 클러스터 선택 시에만 cluster 한정 export. 여러 개 / 전체는 전체 export.
      const exportClusterId = selectedClusterIds.length === 1 ? selectedClusterIds[0] : undefined;
      const { data } = await playbooksApi.exportReport(exportClusterId);
      const blob = data instanceof Blob ? data : new Blob([data], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const today = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `k8s-daily-report-${today}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Export failed:', e);
    }
  };

  // 새 playbook 등록 모달의 default cluster — 하나만 선택돼 있으면 그것, 아니면 첫 번째.
  const defaultClusterId = selectedClusterIds.length === 1 ? selectedClusterIds[0] : (clusters[0]?.id ?? '');

  // 상태별 카운트
  const statusCounts = {
    total: filteredPlaybooks.length,
    healthy: filteredPlaybooks.filter((p) => p.status === 'healthy').length,
    warning: filteredPlaybooks.filter((p) => p.status === 'warning').length,
    critical: filteredPlaybooks.filter((p) => p.status === 'critical').length,
  };

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto px-4 lg:px-6 py-6 flex gap-3">
        {/* 좌측 클러스터 사이드바 — 다중 선택. 빈 배열 = 전체. */}
        <ClusterSidebar
          clusters={clusters}
          selectedId={null}
          onSelect={() => { /* multiSelect 모드라 미사용 */ }}
          allowAll
          allLabel="전체 클러스터"
          iconOnly
          multiSelect
          selectedIds={selectedClusterIds}
          onMultiSelectChange={setSelectedClusterIds}
        />

        <div className="flex-1 min-w-0">
          {/* Page Header */}
          <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
            <div className="flex items-center gap-3 min-w-0">
              <BookOpen className="w-6 h-6 text-primary flex-shrink-0" />
              <h1 className="text-xl font-bold">Ansible Playbooks</h1>
              {statusCounts.total > 0 && (
                <div className="flex items-center gap-2 ml-2">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                    {statusCounts.healthy} OK
                  </span>
                  {statusCounts.warning > 0 && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30">
                      {statusCounts.warning} Changed
                    </span>
                  )}
                  {statusCounts.critical > 0 && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30">
                      {statusCounts.critical} Failed
                    </span>
                  )}
                </div>
              )}
              <span className="text-xs text-muted-foreground">
                {selectedClusterIds.length === 0
                  ? `· 전체 (${clusters.length}개 클러스터)`
                  : `· ${selectedClusterIds.length}개 클러스터 선택됨`}
              </span>
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              {/* View Mode Toggle */}
              <div className="inline-flex items-center bg-background border border-border rounded-lg p-0.5">
                <button
                  onClick={() => setViewMode('list')}
                  className={`px-2 py-1.5 text-xs rounded inline-flex items-center gap-1 transition-colors ${
                    viewMode === 'list' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title="리스트 보기"
                  aria-label="리스트 보기"
                  aria-pressed={viewMode === 'list'}
                >
                  <List className="w-4 h-4" />
                  <span className="hidden sm:inline">List</span>
                </button>
                <button
                  onClick={() => setViewMode('card')}
                  className={`px-2 py-1.5 text-xs rounded inline-flex items-center gap-1 transition-colors ${
                    viewMode === 'card' ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title="카드 보기"
                  aria-label="카드 보기"
                  aria-pressed={viewMode === 'card'}
                >
                  <LayoutGrid className="w-4 h-4" />
                  <span className="hidden sm:inline">Card</span>
                </button>
              </div>

              {/* Sort Controls */}
              <div className="flex items-center gap-1.5">
                <ArrowUpDown className="w-4 h-4 text-muted-foreground" />
                <select
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as PlaybookSortKey)}
                  className="px-2 py-1.5 text-xs bg-background border border-border rounded-lg"
                >
                  <option value="name">이름순</option>
                  <option value="status">상태순</option>
                  <option value="lastRunAt">최근 실행순</option>
                </select>
                <button
                  onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                  className="px-2 py-1.5 text-xs bg-background border border-border rounded-lg hover:bg-secondary transition-colors"
                  title={sortDir === 'asc' ? '오름차순' : '내림차순'}
                >
                  {sortDir === 'asc' ? '↑' : '↓'}
                </button>
              </div>

              {filteredPlaybooks.length > 0 && (
                <>
                  <button
                    onClick={handleExportReport}
                    className="px-4 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors flex items-center gap-2"
                  >
                    <Download className="w-4 h-4" />
                    Export .md
                  </button>
                  <RoleGate allow={['admin', 'operator']}>
                    <button
                      onClick={handleRunAll}
                      className="px-4 py-2 text-sm font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors flex items-center gap-2"
                    >
                      <Play className="w-4 h-4" />
                      Run All
                    </button>
                  </RoleGate>
                </>
              )}

              <RoleGate allow={['admin', 'operator']}>
                <button
                  onClick={() => { setEditPlaybook(null); setShowAdd(true); }}
                  className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors flex items-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  Register Playbook
                </button>
              </RoleGate>
            </div>
          </div>

          {/* Content */}
          {isLoading ? (
            viewMode === 'list' ? (
              <div className="space-y-2">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="bg-card border border-border rounded-lg h-12 animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="bg-card border border-border rounded-xl p-5 h-48 animate-pulse" />
                ))}
              </div>
            )
          ) : filteredPlaybooks.length === 0 ? (
            <div className="text-center py-16">
              <BookOpen className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
              <p className="text-muted-foreground mb-4">
                {selectedClusterIds.length === 0
                  ? 'No playbooks registered yet'
                  : '선택한 클러스터에 등록된 playbook이 없습니다'}
              </p>
              <RoleGate allow={['admin', 'operator']}>
                <button
                  onClick={() => { setEditPlaybook(null); setShowAdd(true); }}
                  className="px-4 py-2 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded-lg transition-colors"
                >
                  + Register your first playbook
                </button>
              </RoleGate>
            </div>
          ) : viewMode === 'list' ? (
            <DndContext
              sensors={dndSensors}
              collisionDetection={closestCenter}
              onDragEnd={(e: DragEndEvent) => { if (e.over) dndHandleDragEnd(String(e.active.id), String(e.over.id)); }}
            >
              <SortableContext items={filteredPlaybooks.map((p) => p.id)} strategy={verticalListSortingStrategy}>
                <div className="space-y-1.5">
                  {filteredPlaybooks.map((playbook) => (
                    <PlaybookListRow
                      key={playbook.id}
                      playbook={playbook}
                      isRunning={runningIds.has(playbook.id)}
                      clusterName={showClusterLabel ? clusterNameMap[playbook.clusterId] : undefined}
                      onRun={() => handleRunOne(playbook)}
                      onEdit={() => handleOpenEdit(playbook)}
                      onDelete={() => {
                        if (confirm(`Delete playbook "${playbook.name}"?`)) {
                          deletePlaybook.mutate(playbook.id);
                        }
                      }}
                      onToggleDashboard={() => toggleDashboard.mutate(playbook.id)}
                      onViewLog={() => setLogTarget(playbook)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          ) : (
            <DndContext
              sensors={dndSensors}
              collisionDetection={closestCenter}
              onDragEnd={(e: DragEndEvent) => { if (e.over) dndHandleDragEnd(String(e.active.id), String(e.over.id)); }}
            >
              <SortableContext items={filteredPlaybooks.map((p) => p.id)} strategy={rectSortingStrategy}>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {filteredPlaybooks.map((playbook) => (
                    <SortableCardCell
                      key={playbook.id}
                      playbook={playbook}
                      isRunning={runningIds.has(playbook.id)}
                      onRun={() => handleRunOne(playbook)}
                      onEdit={() => handleOpenEdit(playbook)}
                      onDelete={() => {
                        if (confirm(`Delete playbook "${playbook.name}"?`)) {
                          deletePlaybook.mutate(playbook.id);
                        }
                      }}
                      onToggleDashboard={() => toggleDashboard.mutate(playbook.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </main>

      {/* Modal (add / edit) */}
      <AddPlaybookModal
        isOpen={showAdd}
        onClose={handleModalClose}
        onSubmit={editPlaybook ? handleUpdate : handleCreate}
        clusters={clusters}
        defaultClusterId={defaultClusterId}
        initialData={editPlaybook}
      />

      {/* SSH 자격증명 모달 — 단일 실행 시 자동 표시. */}
      <RunCredsModal
        open={!!credsTarget}
        playbookName={credsTarget?.name ?? ''}
        onClose={() => setCredsTarget(null)}
        onRun={(creds) => {
          if (credsTarget) {
            runPlaybook.mutate({ id: credsTarget.id, creds });
            setCredsTarget(null);
          }
        }}
      />

      {/* 실행 로그 상세 다이얼로그 */}
      <PlaybookLogDialog playbook={logTarget} onClose={() => setLogTarget(null)} />
    </div>
  );
}
