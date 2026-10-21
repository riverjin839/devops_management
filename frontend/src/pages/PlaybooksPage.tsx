import { useState, useMemo, useEffect } from 'react';
import { Plus, Play, BookOpen, Download, ArrowUpDown, ArrowUp, ArrowDown, LayoutGrid, List, GripVertical } from 'lucide-react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { PlaybookCard, PlaybookListRow, PlaybookLogDialog, AddPlaybookModal, RunCredsModal, playbookRunLines } from '@/components/playbooks';
import type { PlaybookFormSubmit } from '@/components/playbooks/AddPlaybookModal';
import type { PlaybookSshCreds } from '@/types';
import { ClusterSidebar, ConfirmDialog, EmptyState, ErrorState, Skeleton, PageShell, RunLogPanel } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { useCanOperate, useMyClusterAccess } from '@/hooks/useCanOperate';
import { usePlaybooks, useCreatePlaybook, useUpdatePlaybook, useDeletePlaybook, useRunPlaybook, useToggleDashboard } from '@/hooks/usePlaybook';
import { playbooksApi } from '@/services/api';
import { usePlaybookStore } from '@/stores/playbookStore';
import { useClusters } from '@/hooks/useCluster';
import { useClusterStore } from '@/stores/clusterStore';
import { useAuthStore } from '@/stores/authStore';
import { useLocalOrder } from '@/hooks/useLocalOrder';
import { runLogged, useRunLog, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { useUrlParams, pickParam } from '@/hooks/useUrlParams';
import { formatApiError } from '@/lib/utils';
import type { PlaybookRunResult } from '@/types';
import { Playbook } from '@/types';

// manual = 드래그로 정한 순서(useLocalOrder). 다른 기준이면 정렬이 드래그 순서를 덮으므로, 드래그하면 manual 로 바뀐다.
type PlaybookSortKey = 'manual' | 'name' | 'status' | 'lastRunAt';
const SORT_KEYS: PlaybookSortKey[] = ['manual', 'name', 'status', 'lastRunAt'];
type ViewMode = 'list' | 'card';
const STATUS_ORDER: Record<string, number> = { critical: 0, warning: 1, healthy: 2, unknown: 3 };
// localStorage 캐시는 하지 않는다 — 페이지 진입 시 항상 리스트가 기본.
// 과거 'k8s:playbooks:view-mode' 키에 'card' 가 저장된 사용자도 잔존 캐시를 무력화하기 위해
// 마운트 시 한 번 삭제. 카드 보기는 우상단 토글로 일시적으로만 사용.
const LEGACY_VIEW_MODE_KEY = 'k8s:playbooks:view-mode';

function SortableCardCell({ playbook, isRunning, clusterName, onRun, onEdit, onDelete, onToggleDashboard, onViewLog }: {
  playbook: Playbook; isRunning: boolean; clusterName?: string;
  onRun: () => void; onEdit: () => void; onDelete: () => void; onToggleDashboard: () => void; onViewLog: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: playbook.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  return (
    <div ref={setNodeRef} style={style} className="group/card">
      <PlaybookCard
        playbook={playbook} isRunning={isRunning} clusterName={clusterName}
        onRun={onRun} onEdit={onEdit} onDelete={onDelete} onToggleDashboard={onToggleDashboard} onViewLog={onViewLog}
        dragHandle={
          <button
            {...attributes} {...listeners}
            className="cursor-grab active:cursor-grabbing p-1 rounded-md text-muted-foreground/40 hover:text-muted-foreground hover:bg-secondary transition"
            title="드래그하여 순서 변경"
            aria-label={`${playbook.name} 드래그하여 순서 변경`}
          >
            <GripVertical className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        }
      />
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
  // 클러스터 다중 선택·정렬·보기 모드는 URL 쿼리에 둔다(D-029) — 새로고침·링크 공유에도 유지.
  const [urlParams, setUrlParams] = useUrlParams({ cluster: '', sort: 'name', dir: 'asc', view: 'list' });
  // 다중 선택 — 빈 배열 = 전체 클러스터. 쿼리는 쉼표 구분.
  const selectedClusterIds = useMemo(
    () => (urlParams.cluster ? urlParams.cluster.split(',').filter(Boolean) : []),
    [urlParams.cluster],
  );
  const setSelectedClusterIds = (ids: string[]) => setUrlParams({ cluster: ids.join(',') });
  const sortKey = pickParam<PlaybookSortKey>(urlParams.sort, SORT_KEYS, 'name');
  const setSortKey = (k: PlaybookSortKey) => setUrlParams({ sort: k });
  const sortDir = pickParam(urlParams.dir, ['asc', 'desc'] as const, 'asc');
  const viewMode = pickParam<ViewMode>(urlParams.view, ['list', 'card'], 'list');
  const setViewMode = (v: ViewMode) => setUrlParams({ view: v });
  // 단일 실행 시 자격증명 모달용 — 어떤 playbook 을 실행할지 보관.
  const [credsTarget, setCredsTarget] = useState<Playbook | null>(null);
  // 상세 로그 다이얼로그 — 클릭한 playbook 보관.
  const [logTarget, setLogTarget] = useState<Playbook | null>(null);

  const { clusters } = useClusterStore();
  useClusters(); // fetch

  // 항상 전체 fetch — 클라이언트 측에서 selectedClusterIds 로 필터.
  const playbooksQ = usePlaybooks(undefined);
  const { isLoading } = playbooksQ;
  // 조회 실패를 빈 상태로 보여주지 않는다(D-137) — 캐시가 없을 때만 오류 자리표시(백그라운드 재조회 실패는 목록 유지).
  const loadFailed = playbooksQ.isError && !playbooksQ.data;
  const { playbooks, runningIds } = usePlaybookStore();

  const createPlaybook = useCreatePlaybook();
  const updatePlaybook = useUpdatePlaybook();
  const deletePlaybook = useDeletePlaybook();
  const runPlaybook = useRunPlaybook();
  const toggleDashboard = useToggleDashboard();
  // §12.9 — 등록·전체 실행은 operator 이상. 숨기지 않고 비활성+사유(D-145). 행·카드 버튼은 컴포넌트가 클러스터별로 판정.
  const { canOperate, withHint, ariaWithHint } = useCanOperate();
  // 전체 실행은 클러스터마다 operate 권한을 따로 본다(테넌트 바인딩) — 없는 클러스터의 플레이북은 보내지 않는다.
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const clusterAccess = useMyClusterAccess(!isAdmin);
  const canOperateCluster = (clusterId: string) => {
    const level = clusterAccess.data?.[clusterId];
    return level === undefined || level === 'operate';
  };
  // 실행·삭제 확인(D-141·D-142) — 무엇을 어디에 실행/삭제하는지 보여준 뒤 진행한다.
  const [runConfirm, setRunConfirm] = useState<{ pb: Playbook; creds: PlaybookSshCreds } | null>(null);
  const [runAllConfirm, setRunAllConfirm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Playbook | null>(null);
  // 플레이북 실행 로그(D-135) — 단건 ▶ · 자격증명 모달 · Run All · 리포트 내보내기가 공유한다.
  const runLog = useRunLog();
  const [showRunLog, setShowRunLog] = useLogPref('playbooks-run');

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
  const { orderedItems: dndPlaybooks, handleDragEnd: dndHandleDragEnd, setOrder: setManualOrder } = useLocalOrder(basePlaybooks, orderKey);
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
    if (sortKey === 'manual') return sortDir === 'asc' ? dndPlaybooks : [...dndPlaybooks].reverse();
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

  // 드래그 = 보이는 순서를 그대로 옮긴다. 정렬 기준이 켜져 있으면 지금 화면 순서를 사용자 지정 순서로 먼저
  // 저장하고 manual 로 바꾼다 — 그러지 않으면 정렬이 드래그 결과를 바로 덮어 아무 일도 안 일어난 것처럼 보였다.
  const handlePlaybookDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const activeId = String(e.active.id);
    const overId = String(e.over.id);
    if (sortKey === 'manual' && sortDir === 'asc') {
      dndHandleDragEnd(activeId, overId);
      return;
    }
    const ids = filteredPlaybooks.map((p) => p.id);
    const from = ids.indexOf(activeId);
    const to = ids.indexOf(overId);
    if (from < 0 || to < 0) return;
    setManualOrder(arrayMove(ids, from, to));
    setUrlParams({ sort: 'manual', dir: 'asc' });
  };

  // 모달이 결과를 기다린다(D-143) — Promise 를 그대로 돌려줘 실패 시 모달 안에 사유를 띄운다.
  const handleCreate = (data: PlaybookFormSubmit) =>
    createPlaybook.mutateAsync({
      name: data.name,
      description: data.description.trim() || undefined,
      playbookFileId: data.playbookFileId,
      inventoryId: data.inventoryId,
      playbookPath: data.playbookPath,
      inventoryPath: data.inventoryPath,
      tags: data.tags.trim() || undefined,
      timeoutSeconds: data.timeoutSeconds,
      clusterId: data.clusterId,
    });

  const handleUpdate = (data: PlaybookFormSubmit) => {
    if (!editPlaybook) return Promise.resolve();
    return updatePlaybook.mutateAsync({
      id: editPlaybook.id,
      data: {
        name: data.name,
        // 지운 값은 null 로 보내 서버가 컬럼을 비우게 한다(D-144) — undefined 는 "변경 없음".
        description: data.description.trim() || null,
        // 모드 전환 시 반대편 필드를 비워줘야 backend 에서 충돌 안 남
        playbookFileId: data.playbookFileId ?? null,
        inventoryId: data.inventoryId ?? null,
        playbookPath: data.playbookPath ?? null,
        inventoryPath: data.inventoryPath ?? null,
        tags: data.tags.trim() || null,
        timeoutSeconds: data.timeoutSeconds,
        clusterId: data.clusterId,
      },
    });
    // 성공 시 모달의 onClose(handleModalClose)가 editPlaybook 을 비운다.
  };

  const handleDelete = (pb: Playbook) => setDeleteTarget(pb);

  // 실패 토스트는 useDeletePlaybook 의 onError 가 띄운다(D-143) — 여기선 다이얼로그만 정리한다.
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deletePlaybook.mutateAsync(deleteTarget.id);
    } catch { /* hook onError 토스트 */ }
    setDeleteTarget(null);
  };

  // 실패 토스트는 useToggleDashboard 의 onError 가 띄운다(D-143).
  const handleToggleDashboard = (pb: Playbook) => toggleDashboard.mutate(pb.id);

  const handleOpenEdit = (playbook: Playbook) => {
    setEditPlaybook(playbook);
    setShowAdd(true);
  };

  const handleModalClose = () => {
    setShowAdd(false);
    setEditPlaybook(null);
  };

  // 단건 실행 — 실행 로그에 요청·대기·상태/통계·실패 사유를 남긴다(실패해도 throw 하지 않음).
  const runOneLogged = (pb: Playbook, creds?: PlaybookSshCreds) => runLogged(runLog, {
    title: `플레이북 실행 — ${pb.name}`,
    first: `${pb.name} — ${clusterNameMap[pb.clusterId] ?? pb.clusterId} 대상 실행 요청${creds?.ssh_username ? ` (SSH ${creds.ssh_username})` : ''}`,
    fn: () => runPlaybook.mutateAsync({ id: pb.id, creds }),
    summarize: ({ data }) => playbookRunLines(data),
  });

  // 카드의 ▶ 버튼 클릭 — 세션에 저장된 자격증명이 있으면 확인 다이얼로그(D-141) 후 실행, 없으면 자격증명 모달
  // (모달 자체가 대상·자격증명을 확인하는 단계다).
  const handleRunOne = (pb: Playbook) => {
    if (runningIds.has(pb.id)) return;
    const cached = readSessionCreds();
    if (cached) {
      setRunConfirm({ pb, creds: cached });
    } else {
      setCredsTarget(pb);
    }
  };

  // Run All 확인 문구용 — 대상(실행 중 제외)과 클러스터별 건수.
  const runAllTargets = filteredPlaybooks.filter((p) => !runningIds.has(p.id) && canOperateCluster(p.clusterId));
  const runAllNoAccess = filteredPlaybooks.filter((p) => !runningIds.has(p.id) && !canOperateCluster(p.clusterId)).length;
  const runAllByCluster = (() => {
    const m = new Map<string, number>();
    for (const p of runAllTargets) m.set(p.clusterId, (m.get(p.clusterId) ?? 0) + 1);
    return [...m.entries()].map(([id, n]) => ({ id, name: clusterNameMap[id] ?? id, n }));
  })();
  const runAllCreds = runAllConfirm ? readSessionCreds() : null;
  // 확인 창이 열린 사이 대상이 0개가 되면(전부 실행 중) 창을 닫는다 — 예전엔 busy 로 "처리 중"에 굳었다.
  const noRunAllTargets = runAllTargets.length === 0;
  useEffect(() => {
    if (runAllConfirm && noRunAllTargets) setRunAllConfirm(false);
  }, [runAllConfirm, noRunAllTargets]);

  // Run All — 표시 중인 플레이북을 병렬 실행. 한 개 실패가 나머지를 막지 않는다(allSettled).
  const handleRunAll = async () => {
    const cached = readSessionCreds();
    const targets = runAllTargets;
    if (targets.length === 0) return;
    const results: { status: string | null }[] = [];
    await runLogged(runLog, {
      title: `플레이북 일괄 실행 — ${targets.length}개`,
      first: `플레이북 ${targets.length}개 병렬 실행 요청${cached ? ` (세션 자격증명 ${cached.ssh_username ?? ''})` : ' (세션 자격증명 없음)'}${
        runAllNoAccess > 0 ? ` · 실행 권한 없는 클러스터의 ${runAllNoAccess}개 제외` : ''}`,
      fn: () => Promise.allSettled(targets.map(async (p) => {
        runLog.setStep(p.id, p.name, 'running');
        try {
          const { data } = await runPlaybook.mutateAsync({ id: p.id, creds: cached ?? undefined });
          runLog.setStep(p.id, p.name, data.status === 'critical' ? 'failed' : 'done');
          for (const [lv, msg] of playbookRunLines(data, p.name).slice(0, 2)) runLog.log(lv, msg);
          results.push({ status: data.status });
          return data;
        } catch (e) {
          runLog.setStep(p.id, p.name, 'failed');
          runLog.log('error', `[${p.name}] 실패 — ${formatApiError(e)}`);
          results.push({ status: null });
          throw e;
        }
      })),
      summarize: (settled: PromiseSettledResult<PlaybookRunResult>[]): RunLogEntry[] => {
        const healthy = results.filter((r) => r.status === 'healthy').length;
        const failed = results.filter((r) => r.status === null || r.status === 'critical').length;
        const other = settled.length - healthy - failed;
        return [[
          failed > 0 ? 'error' : other > 0 ? 'warn' : 'info',
          `합계 · 대상 ${settled.length} · 정상 ${healthy} · 경고 ${other} · 실패 ${failed}`,
        ]];
      },
    });
  };

  const handleExportReport = async () => {
    // 단일 클러스터 선택 시에만 cluster 한정 export. 여러 개 / 전체는 전체 export.
    const exportClusterId = selectedClusterIds.length === 1 ? selectedClusterIds[0] : undefined;
    await runLogged(runLog, {
      title: '리포트 내보내기',
      first: `${exportClusterId ? clusterNameMap[exportClusterId] ?? exportClusterId : '전체 클러스터'} 플레이북 리포트(.md) 요청`,
      fn: () => playbooksApi.exportReport(exportClusterId),
      summarize: ({ data }) => {
        const blob = data instanceof Blob ? data : new Blob([data], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const today = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `playbook-report-${today}.md`;
        a.click();
        URL.revokeObjectURL(url);
        return [['info', `${a.download} 내려받기 · ${blob.size} bytes`]];
      },
    });
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
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
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
          <PageHeader
            icon={BookOpen}
            title="Ansible 플레이북"
            className="mb-6"
            titleExtra={
            <>
              {statusCounts.total > 0 && (
                <div className="flex items-center gap-2 ml-2">
                  <span className="text-sm px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">
                    정상 {statusCounts.healthy}
                  </span>
                  {statusCounts.warning > 0 && (
                    <span className="text-sm px-2 py-0.5 rounded-full bg-status-warning/15 text-status-warning border border-status-warning/30">
                      변경 {statusCounts.warning}
                    </span>
                  )}
                  {statusCounts.critical > 0 && (
                    <span className="text-sm px-2 py-0.5 rounded-full bg-status-critical/15 text-status-critical border border-status-critical/30">
                      실패 {statusCounts.critical}
                    </span>
                  )}
                </div>
              )}
              <span className="text-sm text-muted-foreground">
                {selectedClusterIds.length === 0
                  ? `· 전체 (${clusters.length}개 클러스터)`
                  : `· ${selectedClusterIds.length}개 클러스터 선택됨`}
              </span>
            </>
            }
            actions={
            <div className="flex items-center gap-3 flex-wrap">
              {/* View Mode Toggle */}
              <div className="inline-flex items-center bg-background border border-border rounded-xl p-0.5">
                <button
                  onClick={() => setViewMode('list')}
                  className={`px-2 py-1.5 text-sm rounded-lg inline-flex items-center gap-1 transition-colors ${
                    viewMode === 'list' ? 'bg-secondary text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title="목록 보기"
                  aria-label="목록 보기"
                  aria-pressed={viewMode === 'list'}
                >
                  <List className="w-4 h-4" />
                  <span className="hidden sm:inline">목록</span>
                </button>
                <button
                  onClick={() => setViewMode('card')}
                  className={`px-2 py-1.5 text-sm rounded-lg inline-flex items-center gap-1 transition-colors ${
                    viewMode === 'card' ? 'bg-secondary text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'
                  }`}
                  title="카드 보기"
                  aria-label="카드 보기"
                  aria-pressed={viewMode === 'card'}
                >
                  <LayoutGrid className="w-4 h-4" />
                  <span className="hidden sm:inline">카드</span>
                </button>
              </div>

              {/* Sort Controls */}
              <div className="flex items-center gap-1.5">
                <ArrowUpDown className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
                <select
                  aria-label="정렬 기준"
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as PlaybookSortKey)}
                  className="px-2 py-1.5 text-sm bg-background border border-border rounded-xl"
                >
                  <option value="manual">사용자 지정 순서</option>
                  <option value="name">이름순</option>
                  <option value="status">상태순</option>
                  <option value="lastRunAt">최근 실행순</option>
                </select>
                <button
                  onClick={() => setUrlParams({ dir: sortDir === 'asc' ? 'desc' : 'asc' })}
                  className="px-2 py-1.5 text-sm bg-background border border-border rounded-xl hover:bg-secondary transition-colors"
                  title={sortDir === 'asc' ? '오름차순' : '내림차순'}
                  aria-label={sortDir === 'asc' ? '오름차순' : '내림차순'}
                >
                  {sortDir === 'asc' ? <ArrowUp className="w-4 h-4" aria-hidden="true" /> : <ArrowDown className="w-4 h-4" aria-hidden="true" />}
                </button>
              </div>

              {filteredPlaybooks.length > 0 && (
                <>
                  <button
                    onClick={handleExportReport}
                    className="px-4 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-2"
                  >
                    <Download className="w-4 h-4" />
                    리포트 내보내기(.md)
                  </button>
                  <button
                    onClick={() => setRunAllConfirm(true)}
                    disabled={!canOperate || runAllTargets.length === 0}
                    title={withHint(runAllTargets.length === 0
                      ? (runAllNoAccess > 0 ? '실행할 수 있는 플레이북이 없습니다(실행 중이거나 클러스터 실행 권한 없음)' : '모든 플레이북이 이미 실행 중입니다')
                      : '표시 중인 플레이북 전체 실행')}
                    aria-label={ariaWithHint('전체 실행')}
                    className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Play className="w-4 h-4" />
                    전체 실행
                  </button>
                </>
              )}

              <button
                onClick={() => { setEditPlaybook(null); setShowAdd(true); }}
                disabled={!canOperate}
                title={withHint('플레이북 등록')}
                aria-label={ariaWithHint('플레이북 등록')}
                className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Plus className="w-4 h-4" />
                플레이북 등록
              </button>
            </div>
            }
          />

          {(runLog.running || runLog.lines.length > 0) && (
            <div className="mb-4">
              <RunLogPanel run={runLog} show={showRunLog} onShowChange={setShowRunLog} />
            </div>
          )}

          {/* Content */}
          {isLoading ? (
            viewMode === 'list' ? (
              <div className="space-y-2">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="block w-full h-12 rounded-lg" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="block w-full h-48 rounded-md" />
                ))}
              </div>
            )
          ) : loadFailed ? (
            <ErrorState error={playbooksQ.error} title="플레이북 목록을 불러오지 못했습니다" onRetry={() => void playbooksQ.refetch()} />
          ) : filteredPlaybooks.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title={selectedClusterIds.length === 0 ? '등록된 플레이북이 없습니다.' : '선택한 클러스터에 등록된 플레이북이 없습니다.'}
              description="Ansible 플레이북을 등록하면 클러스터별로 실행하고 결과를 남길 수 있습니다."
            >
              {/* §12.9 예외 — 빈 상태의 단독 주 액션은 viewer 에게 생략(헤더의 비활성 버튼이 사유를 보여준다). */}
              {canOperate && (
                <button
                  type="button"
                  onClick={() => { setEditPlaybook(null); setShowAdd(true); }}
                  className="mt-4 px-3.5 py-1.5 text-sm font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  플레이북 등록
                </button>
              )}
            </EmptyState>
          ) : viewMode === 'list' ? (
            <DndContext
              sensors={dndSensors}
              collisionDetection={closestCenter}
              onDragEnd={handlePlaybookDragEnd}
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
                      onDelete={() => handleDelete(playbook)}
                      onToggleDashboard={() => handleToggleDashboard(playbook)}
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
              onDragEnd={handlePlaybookDragEnd}
            >
              <SortableContext items={filteredPlaybooks.map((p) => p.id)} strategy={rectSortingStrategy}>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {filteredPlaybooks.map((playbook) => (
                    <SortableCardCell
                      key={playbook.id}
                      playbook={playbook}
                      isRunning={runningIds.has(playbook.id)}
                      clusterName={showClusterLabel ? clusterNameMap[playbook.clusterId] : undefined}
                      onRun={() => handleRunOne(playbook)}
                      onEdit={() => handleOpenEdit(playbook)}
                      onDelete={() => handleDelete(playbook)}
                      onToggleDashboard={() => handleToggleDashboard(playbook)}
                      onViewLog={() => setLogTarget(playbook)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </PageShell>

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
            // 모달은 제출 즉시 닫히므로 실행 로그는 페이지 패널에 남긴다.
            void runOneLogged(credsTarget, creds);
            setCredsTarget(null);
          }
        }}
      />

      {/* 실행 로그 상세 다이얼로그 */}
      <PlaybookLogDialog playbook={logTarget} onClose={() => setLogTarget(null)} />

      {/* 단건 실행 확인(D-141) — 세션 자격증명으로 모달 없이 바로 나가던 경로 */}
      <ConfirmDialog
        open={!!runConfirm}
        title="플레이북 실행"
        description={runConfirm
          ? `"${runConfirm.pb.name}" 을(를) ${clusterNameMap[runConfirm.pb.clusterId] ?? runConfirm.pb.clusterId} 클러스터 대상으로 실행합니다. 인벤토리의 호스트에 ansible-playbook 이 바로 실행됩니다.`
          : undefined}
        confirmLabel="실행"
        danger
        busy={!!runConfirm && runningIds.has(runConfirm.pb.id)}
        onConfirm={() => {
          if (!runConfirm) return;
          const { pb, creds } = runConfirm;
          setRunConfirm(null);
          void runOneLogged(pb, creds);
        }}
        onCancel={() => setRunConfirm(null)}
      >
        {runConfirm && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">인벤토리</dt>
            <dd className="font-mono truncate">{runConfirm.pb.inventoryName || runConfirm.pb.inventoryPath || '기본 인벤토리'}</dd>
            <dt className="text-muted-foreground">플레이북</dt>
            <dd className="font-mono truncate">{runConfirm.pb.playbookFileName || runConfirm.pb.playbookPath || '—'}</dd>
            <dt className="text-muted-foreground">자격증명</dt>
            <dd>세션에 저장된 SSH 자격증명{runConfirm.creds.ssh_username ? ` (${runConfirm.creds.ssh_username})` : ''}</dd>
          </dl>
        )}
      </ConfirmDialog>

      {/* 전체 실행 확인(D-141) — 클러스터 미선택 = 전체 클러스터라 범위를 강조한다 */}
      <ConfirmDialog
        open={runAllConfirm}
        title="플레이북 전체 실행"
        description={`표시 중인 플레이북 ${runAllTargets.length}개를 ${
          selectedClusterIds.length === 0 ? `전체 ${runAllByCluster.length}개 클러스터` : `${runAllByCluster.length}개 클러스터`
        }에서 병렬로 실행합니다. 각 인벤토리의 호스트에 ansible-playbook 이 바로 실행됩니다.`}
        confirmLabel={`${runAllTargets.length}개 실행`}
        danger
        onConfirm={() => {
          setRunAllConfirm(false);
          void handleRunAll();
        }}
        onCancel={() => setRunAllConfirm(false)}
      >
        <div className="space-y-2 text-sm">
          {selectedClusterIds.length === 0 && (
            <p className="font-semibold text-status-warning">클러스터를 고르지 않아 전체 클러스터가 대상입니다.</p>
          )}
          {runAllNoAccess > 0 && (
            <p className="text-muted-foreground">실행 권한이 없는 클러스터(테넌트 바인딩)의 플레이북 {runAllNoAccess}개는 제외합니다.</p>
          )}
          <ul className="max-h-40 overflow-y-auto space-y-0.5">
            {runAllByCluster.map((c) => (
              <li key={c.id} className="flex justify-between gap-3">
                <span className="truncate">{c.name}</span>
                <span className="tabular-nums text-muted-foreground">{c.n}개</span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            자격증명: {runAllCreds ? `세션에 저장된 SSH 자격증명${runAllCreds.ssh_username ? ` (${runAllCreds.ssh_username})` : ''}` : '세션 자격증명 없음 — 인벤토리/서버 기본값 사용'}
          </p>
        </div>
      </ConfirmDialog>

      {/* 삭제 확인(D-142) — native confirm() 대체 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="플레이북 삭제"
        description={deleteTarget
          ? `"${deleteTarget.name}" 플레이북을 삭제합니다. 실행 이력(playbook_runs)도 함께 삭제되며 되돌릴 수 없습니다.`
          : undefined}
        confirmLabel="삭제"
        danger
        busy={deletePlaybook.isPending}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
