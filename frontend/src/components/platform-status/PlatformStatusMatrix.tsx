import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Settings, Pencil, Trash2, GripVertical, Clock, Lock, HelpCircle,
  Play, ScrollText, Loader2, AlertTriangle, XCircle, CheckCircle2, Server, PauseCircle,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { StatusDot, ConfirmDialog, useToast, Skeleton, EmptyState } from '@/components/common';
import { useModalA11y } from '@/components/common/useModalA11y';
import {
  useCheckMatrixGrid, useReorderCheckMatrixItems, useDeleteCheckMatrixItem, usePutClusterCron,
  useRunCheckMatrixCluster, useRunCheckMatrixItem, useCheckMatrixActiveRuns,
} from '@/hooks/useCheckMatrix';
import type { CheckMatrixCell, CheckMatrixItem, CheckMatrixGridCluster, Status } from '@/types';
import { formatApiError } from '@/lib/utils';
import { CheckMatrixCellDetailModal } from './CheckMatrixCellDetailModal';
import { CheckMatrixItemFormModal } from './CheckMatrixItemFormModal';
import { CheckMatrixSettingsModal } from './CheckMatrixSettingsModal';
import { CheckMatrixHelpPanel } from './CheckMatrixHelpPanel';
import { CheckMatrixRunLogPanel } from './CheckMatrixRunLogPanel';
import { rowColor } from './rowColors';

const STATUS_LABEL: Record<Status, string> = {
  healthy: '정상', warning: '경고', critical: '위험', pending: '대기',
};

// 행이 어떻게 실행되는지 한눈에 — "왜 이 행엔 실행 버튼이 없지?"(수동 입력)의 답을 그리드에서 준다.
const SOURCE_BADGE: Record<CheckMatrixItem['sourceType'], { label: string; hint: string }> = {
  core_bundle: { label: '핵심', hint: '핵심 점검 번들 — 클러스터 열 cron 으로 자동 실행, Cluster 상태 산정에 사용' },
  deep_check: { label: 'Deep', hint: 'Deep Check 자동 점검 — 셀 cron 또는 ▶ 로 실행' },
  addon: { label: 'Addon', hint: '애드온 헬스 체크 — 셀 cron 또는 ▶ 로 실행' },
  manual: { label: '수동', hint: '수동 입력 항목 — 자동 실행 없음. 셀을 클릭해 값을 직접 입력합니다. 자동 점검으로 바꾸려면 연필(수정)에서 실행 방식을 변경하세요.' },
};

function SourceBadge({ sourceType }: { sourceType: CheckMatrixItem['sourceType'] }) {
  const meta = SOURCE_BADGE[sourceType];
  if (!meta) return null;
  return (
    <span
      title={meta.hint}
      className="flex-shrink-0 px-1 py-px rounded border border-border text-[9px] font-medium text-muted-foreground select-none"
    >
      {meta.label}
    </span>
  );
}

// 경고/위험은 색상(StatusDot) 만으로 전달하지 않는다 — 값이 표시될 때도 상태를 알 수 있도록
// 형태가 다른 아이콘을 함께 준다(색맹·저채도 화면에서도 구분 가능).
const CELL_STATUS_ICON: Partial<Record<Status, typeof AlertTriangle>> = {
  warning: AlertTriangle,
  critical: XCircle,
};

// 빈 셀("—")이 미실행/예약 대기/수동 미입력을 전부 뭉개 보여주던 것을 조금이라도 구분한다 —
// 백엔드가 "왜 비었는지" 사유 코드를 따로 안 주므로 가진 필드(sourceType/cronExpr/message)로
// 추론 가능한 만큼만 안내한다.
function emptyCellHint(item: CheckMatrixItem, cell: CheckMatrixCell | undefined): string {
  if (cell?.message) return cell.message;
  if (item.sourceType === 'manual') return '수동 입력 항목 — 아직 값이 입력되지 않았습니다. 클릭해 입력하세요.';
  if (cell?.scheduleEnabled && cell.cronExpr) return '아직 실행되지 않았습니다 — 예약된 cron 을 기다리는 중입니다.';
  return '아직 실행되지 않았습니다 — 클릭해 지금 실행할 수 있습니다.';
}

function CellButton({
  item, cell, onClick,
}: { item: CheckMatrixItem; cell: CheckMatrixCell | undefined; onClick: () => void }) {
  const empty = !cell || !cell.hasResult || !cell.status;
  const StatusIcon = !empty ? CELL_STATUS_ICON[cell.status!] : undefined;
  return (
    <button
      onClick={onClick}
      className="w-full h-full min-h-[36px] flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md hover:bg-muted/60 transition-colors"
      title={empty ? emptyCellHint(item, cell) : (cell?.message || undefined)}
    >
      {empty ? (
        <span className="text-muted-foreground/50 text-xs">—</span>
      ) : (
        <>
          <StatusDot variant={cell.status!} />
          {StatusIcon && <StatusIcon className="w-3 h-3 flex-shrink-0" aria-hidden="true" />}
          <span className="text-xs font-medium tabular-nums">
            {cell.value != null ? `${cell.value}${item.unit ?? ''}` : STATUS_LABEL[cell.status!]}
          </span>
        </>
      )}
    </button>
  );
}

// 'unset' = cron 을 저장한 적 없음(진짜 미설정) / 'off' = cron 은 저장돼 있지만 스위치로
// 꺼둠 — 이 둘을 구분해야 "미설정으로만 보이는" 이전의 일관성 없는 표시가 해소된다.
type CronTone = 'unset' | 'off' | 'running' | 'healthy' | 'warning' | 'critical';

// 색만으로 실행중/중지중/정상/비정상을 구분할 수 있게 — 토큰만 사용(고정 hex 금지).
const CRON_TONE_CLS: Record<CronTone, string> = {
  unset: 'text-muted-foreground border-border/60',
  off: 'text-muted-foreground border-border/60 opacity-60',
  running: 'text-status-info border-status-info/50 bg-status-info-soft animate-pulse',
  healthy: 'text-status-healthy border-status-healthy/50 bg-status-healthy-soft',
  warning: 'text-status-warning border-status-warning/50 bg-status-warning-soft',
  critical: 'text-status-critical border-status-critical/50 bg-status-critical-soft',
};
const CRON_TONE_HINT: Record<CronTone, string> = {
  unset: '미설정 — 저장된 cron 이 없습니다(수동 실행만 가능).',
  off: '꺼짐 — cron 은 저장돼 있지만 스위치가 꺼져 있어 실행되지 않습니다.',
  running: '실행 중 — 지금 이 클러스터의 점검이 돌고 있습니다.',
  healthy: '정상 — 핵심 점검이 최근 정상 완료됐습니다.',
  warning: '경고 — 핵심 점검 결과가 주의가 필요합니다.',
  critical: '위험 — 핵심 점검 결과가 비정상입니다.',
};
// 색상 배경만으로 정상/경고/위험/실행중을 구분하지 않도록 톤별로 다른 아이콘을 쓴다.
const CRON_TONE_ICON: Record<CronTone, typeof Clock> = {
  unset: Clock,
  off: PauseCircle,
  running: Loader2,
  healthy: CheckCircle2,
  warning: AlertTriangle,
  critical: XCircle,
};

function ClusterCronBadge({
  cluster, isRunning, coreHealth,
}: { cluster: CheckMatrixGridCluster; isRunning: boolean; coreHealth: Status | null }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(cluster.checkCronExpr ?? '');
  const [enabled, setEnabled] = useState(cluster.checkCronEnabled);
  const mutation = usePutClusterCron();
  // 다른 팝오버/모달과 동일한 접근성(Escape 로 닫기 + 포커스 트랩/복원) — 이 배지만 backdrop
  // 클릭에만 의존해 Escape 가 안 먹던 이탈을 다른 화면들과 통일한다.
  const popRef = useModalA11y(open, () => setOpen(false));

  const handleSave = async () => {
    try {
      await mutation.mutateAsync({
        clusterId: cluster.id, checkCronExpr: value.trim() || null, checkCronEnabled: enabled,
      });
      toast.success('클러스터 cron 을 저장했습니다.');
      setOpen(false);
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  const tone: CronTone = !cluster.checkCronExpr
    ? 'unset'
    : !cluster.checkCronEnabled
      ? 'off'
      : isRunning
        ? 'running'
        : coreHealth === 'critical' ? 'critical' : coreHealth === 'warning' ? 'warning' : 'healthy';

  const ToneIcon = CRON_TONE_ICON[tone];

  return (
    <div className="relative inline-block">
      <button
        onClick={() => {
          setValue(cluster.checkCronExpr ?? '');
          setEnabled(cluster.checkCronEnabled);
          setOpen((v) => !v);
        }}
        title={`${cluster.checkCronExpr || '미설정'} — ${CRON_TONE_HINT[tone]}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`inline-flex items-center gap-1 text-[10px] font-mono transition-colors px-1.5 py-0.5 rounded border hover:brightness-95 max-w-[140px] ${CRON_TONE_CLS[tone]}`}
      >
        <ToneIcon className={`w-2.5 h-2.5 flex-shrink-0 ${tone === 'running' ? 'animate-spin' : ''}`} aria-hidden="true" />
        <span className="truncate">{cluster.checkCronExpr || '미설정'}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            ref={popRef}
            role="dialog"
            aria-label={`${cluster.name} 핵심 점검 cron 설정`}
            className="absolute z-50 top-full mt-1 left-1/2 -translate-x-1/2 w-56 bg-card border border-border rounded-md shadow-xl p-3 space-y-2"
          >
            <p className="text-[11px] text-muted-foreground">핵심 점검(API 응답시간 등) cron. 5분 미만 간격 불가.</p>
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0 9,13,18 * * *"
              className="w-full text-xs font-mono border border-border rounded-xl px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
              <input type="checkbox" className="rounded border-border" checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)} />
              자동 실행 (끄면 cron 은 남고 실행만 멈춥니다)
            </label>
            <div className="flex justify-end gap-1.5">
              <button
                onClick={() => setOpen(false)}
                className="px-2 py-1 text-xs bg-secondary hover:bg-secondary/80 border border-border rounded-xl"
              >
                취소
              </button>
              <button
                onClick={handleSave}
                disabled={mutation.isPending}
                className="px-2 py-1 text-xs font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50"
              >
                저장
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function PlatformStatusMatrix() {
  const navigate = useNavigate();
  const toast = useToast();
  const { data: grid, isLoading, isError, error, refetch } = useCheckMatrixGrid();
  const reorderMut = useReorderCheckMatrixItems();
  const deleteMut = useDeleteCheckMatrixItem();
  const runClusterMut = useRunCheckMatrixCluster();
  const runItemMut = useRunCheckMatrixItem();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [formItem, setFormItem] = useState<CheckMatrixItem | null | 'new'>(null);
  const [deleteTarget, setDeleteTarget] = useState<CheckMatrixItem | null>(null);
  // 프로덕션 클러스터에 실제 명령이 나가는 일괄 실행(클러스터/항목 전체)은 확인을 받는다 —
  // 로컬 메타데이터 삭제보다 마찰이 낮으면 안 된다.
  const [runConfirm, setRunConfirm] = useState<
    { type: 'cluster'; cluster: CheckMatrixGridCluster } | { type: 'item'; item: CheckMatrixItem } | null
  >(null);
  const [cellTarget, setCellTarget] = useState<{ item: CheckMatrixItem; cluster: CheckMatrixGridCluster } | null>(null);
  // 로그 패널은 두 가지로 쓰인다 — batch 가 있으면 방금 트리거한 일괄 수행 추적, 없으면 전체 로그.
  const [runLog, setRunLog] = useState<{ open: boolean; batchId?: string | null; label?: string | null }>(
    { open: false },
  );
  // 어느 열/행이 실행 중인지 — 버튼 스피너 표시용(mutation 은 전역 pending 만 주므로 대상 키를 따로 든다).
  const [runningKey, setRunningKey] = useState<string | null>(null);

  const items = grid?.items ?? [];
  const clusters = grid?.clusters ?? [];

  // 클러스터 cron 배지 색상 — "실행중" 판정은 전역 활성 수행(대기열+실행중) 한 번의 가벼운
  // 폴링으로 공유하고, "정상/경고/위험"은 핵심 점검(core_bundle) 행의 최근 셀 상태로 판정한다.
  const { data: activeRuns } = useCheckMatrixActiveRuns(clusters.length > 0);
  const runningClusterIds = useMemo(
    () => new Set((activeRuns?.runs ?? []).map((r) => r.clusterId)),
    [activeRuns],
  );
  const coreBundleItem = items.find((i) => i.sourceType === 'core_bundle');

  const handleRunCluster = async (cluster: CheckMatrixGridCluster) => {
    setRunningKey(`cluster:${cluster.id}`);
    try {
      const res = await runClusterMut.mutateAsync(cluster.id);
      toast.success(`${cluster.name} 전체 점검을 시작했습니다.`, `${res.queued}/${res.total}건 큐잉`);
      setRunLog({ open: true, batchId: res.batchId, label: `${cluster.name} 전체 실행` });
    } catch (e) {
      toast.error('실행 실패', formatApiError(e));
    } finally {
      setRunningKey(null);
    }
  };

  const handleRunItem = async (item: CheckMatrixItem) => {
    setRunningKey(`item:${item.id}`);
    try {
      const res = await runItemMut.mutateAsync(item.id);
      toast.success(`"${item.name}" 전 클러스터 점검을 시작했습니다.`, `${res.queued}/${res.total}건 큐잉`);
      setRunLog({ open: true, batchId: res.batchId, label: `${item.name} · 전 클러스터` });
    } catch (e) {
      toast.error('실행 실패', formatApiError(e));
    } finally {
      setRunningKey(null);
    }
  };

  const confirmRun = async () => {
    if (!runConfirm) return;
    if (runConfirm.type === 'cluster') await handleRunCluster(runConfirm.cluster);
    else await handleRunItem(runConfirm.item);
    setRunConfirm(null);
  };

  // 행 드래그 정렬 — HTML5 DnD. 그립 핸들에서 시작하고 행 위로 드롭한다.
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const endDrag = () => { setDragIdx(null); setOverIdx(null); };
  const handleDrop = (targetIdx: number) => {
    if (dragIdx === null || dragIdx === targetIdx) { endDrag(); return; }
    const reordered = [...items];
    const [moved] = reordered.splice(dragIdx, 1);
    reordered.splice(targetIdx, 0, moved);
    reorderMut.mutate(reordered.map((i) => i.id));
    endDrag();
  };
  // 그립 핸들은 마우스 드래그 전용이었다 — 포커스는 가능해도 순서를 바꿀 방법이 없는
  // "가짜 버튼"이었던 것을 화살표 위/아래로 실제 이동시켜 해소한다.
  const moveItem = (idx: number, dir: -1 | 1) => {
    const targetIdx = idx + dir;
    if (targetIdx < 0 || targetIdx >= items.length) return;
    const reordered = [...items];
    const [moved] = reordered.splice(idx, 1);
    reordered.splice(targetIdx, 0, moved);
    reorderMut.mutate(reordered.map((i) => i.id));
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMut.mutateAsync(deleteTarget.id);
      toast.success('항목을 삭제했습니다.');
    } catch (e) {
      toast.error('삭제 실패', formatApiError(e));
    } finally {
      setDeleteTarget(null);
    }
  };

  return (
    <div className="flex flex-col gap-2 min-h-0 flex-1">
      <MacCard bodyPadding="p-0" rootClassName="min-h-0 flex-1 flex flex-col" className="flex-1 min-h-0 flex flex-col">
        <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-border bg-surface-container-high">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground select-none">
            플랫폼 현황
          </span>
          <button
            onClick={() => setHelpOpen(true)}
            className="p-0.5 rounded-full text-muted-foreground hover:text-primary hover:bg-secondary transition-colors"
            title="사용법 도움말"
            aria-label="사용법 도움말"
          >
            <HelpCircle className="w-3.5 h-3.5" />
          </button>
          <span className="text-[11px] text-muted-foreground">항목 × 클러스터 점검 매트릭스</span>
          {/* ml-auto 여백만으로는 "화면 정체성" 그룹과 "동작" 그룹의 경계가 옅어(약한 근접성) —
              구분선으로 명시(WorkItemBoardPage 필터 바에도 쓴 것과 동일한 패턴). */}
          <div className="ml-auto flex items-center gap-1.5 border-l border-border pl-2.5">
            <button
              onClick={() => setRunLog({ open: true, batchId: null })}
              className="relative inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-xl hover:bg-secondary transition-colors"
              title={runningClusterIds.size > 0 ? `모든 수행의 실행 로그 — 지금 ${runningClusterIds.size}개 클러스터 실행 중` : '모든 수행의 실행 로그'}
              aria-label={runningClusterIds.size > 0 ? `모든 수행의 실행 로그 — 지금 ${runningClusterIds.size}개 클러스터 실행 중` : '모든 수행의 실행 로그'}
            >
              <ScrollText className="w-3.5 h-3.5" /> 수행 로그
              {/* 패널을 열지 않아도 "지금 뭔가 돌고 있다"는 걸 알 수 있게 — 확인하러 열어야만
                  아는 상태가 아니라 상시 곁눈질로 파악 가능한 상태로. */}
              {runningClusterIds.size > 0 && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-status-info animate-pulse" aria-hidden="true" />
              )}
            </button>
            <button
              onClick={() => setFormItem('new')}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-xl hover:bg-secondary transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> 항목 추가
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="p-1.5 rounded-xl hover:bg-secondary transition-colors text-muted-foreground"
              title="매트릭스 설정"
              aria-label="매트릭스 설정"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </div>

        {isLoading ? (
          // 실제 매트릭스 구조(항목 라벨 열 + 클러스터 셀 그리드)를 흉내낸 skeleton — 로드 전환 시 시프트 최소화
          <div className="flex-1 min-h-0 overflow-auto p-3 space-y-2" aria-busy="true" aria-label="점검 매트릭스 불러오는 중">
            {Array.from({ length: 6 }).map((_, r) => (
              <div key={r} className="flex items-center gap-3">
                <Skeleton height={14} width="20%" className="flex-shrink-0" />
                <div className="flex-1 flex gap-3">
                  {Array.from({ length: 5 }).map((_, c) => (
                    <Skeleton key={c} height={24} className="flex-1" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : isError ? (
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-center text-sm p-6">
            <AlertTriangle className="w-5 h-5 text-status-critical" aria-hidden="true" />
            <p className="text-status-critical font-medium">매트릭스를 불러오지 못했습니다.</p>
            <p className="text-xs text-muted-foreground">{formatApiError(error)}</p>
            <button
              onClick={() => refetch()}
              className="mt-1 px-3 py-1.5 text-xs font-medium rounded-xl border border-border hover:bg-secondary transition-colors"
            >
              다시 시도
            </button>
          </div>
        ) : items.length === 0 || clusters.length === 0 ? (
          // 다음 행동을 문장으로 안내만 하지 않고 실제 버튼으로 제시 — "우측 상단에서
          // 추가하세요"를 읽고 직접 찾아가야 했던 것을 한 클릭으로 줄인다.
          <div className="flex-1 min-h-0 flex items-center justify-center">
            {clusters.length === 0 ? (
              <EmptyState
                icon={Server}
                title="등록된 클러스터가 없습니다"
                description="클러스터를 등록해야 점검 매트릭스를 구성할 수 있습니다."
                action={{ label: 'Settings 에서 클러스터 등록', onClick: () => navigate('/settings?tab=clusters') }}
              />
            ) : (
              <EmptyState
                icon={Plus}
                title="점검 항목이 없습니다"
                description="행(점검 항목)을 추가하면 등록된 클러스터마다 열이 자동으로 채워집니다."
                action={{ label: '항목 추가', onClick: () => setFormItem('new') }}
              />
            )}
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="sticky top-0 z-20 bg-card">
                  <th className="sticky left-0 z-30 bg-card border-b border-r border-border text-left px-3 py-2 min-w-[200px]">
                    점검 항목
                  </th>
                  {clusters.map((cluster) => (
                    <th key={cluster.id} className="border-b border-border px-3 py-2 min-w-[130px] font-medium">
                      <div className="flex flex-col items-center gap-1">
                        <div className="flex items-center gap-1 min-w-0">
                          <span className="truncate max-w-[120px]">{cluster.name}</span>
                          <button
                            onClick={() => setRunConfirm({ type: 'cluster', cluster })}
                            disabled={runningKey === `cluster:${cluster.id}`}
                            title={`${cluster.name} 의 모든 점검 항목을 지금 실행`}
                            aria-label={`${cluster.name} 전체 점검 실행`}
                            className="p-0.5 rounded text-muted-foreground hover:text-primary hover:bg-secondary transition-colors disabled:opacity-50 flex-shrink-0"
                          >
                            {runningKey === `cluster:${cluster.id}`
                              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              : <Play className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                        <ClusterCronBadge
                          cluster={cluster}
                          isRunning={runningClusterIds.has(cluster.id)}
                          coreHealth={
                            coreBundleItem ? (grid?.cells[coreBundleItem.id]?.[cluster.id]?.status ?? null) : null
                          }
                        />
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item, idx) => {
                  const color = rowColor(item.color);
                  return (
                  <tr
                    key={item.id}
                    onDragOver={(e) => { if (dragIdx !== null) { e.preventDefault(); setOverIdx(idx); } }}
                    onDrop={() => handleDrop(idx)}
                    className={`group hover:bg-muted/30 ${
                      dragIdx !== null && overIdx === idx && dragIdx !== idx ? 'bg-primary/5' : ''
                    } ${dragIdx === idx ? 'opacity-50' : ''}`}
                  >
                    <td className="sticky left-0 z-10 bg-card group-hover:bg-muted/30 border-r border-b border-border px-2 py-1">
                      <div
                        role="group"
                        aria-label={`${item.name} 행`}
                        className={`flex flex-col gap-0.5 min-w-0 rounded-md px-1.5 py-1 border-l-2 ${
                          color ? `${color.bg} ${color.bar}` : 'border-l-transparent'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <button
                            draggable
                            onDragStart={(e) => { setDragIdx(idx); e.dataTransfer.effectAllowed = 'move'; }}
                            onDragEnd={endDrag}
                            onKeyDown={(e) => {
                              if (e.key === 'ArrowUp') { e.preventDefault(); moveItem(idx, -1); }
                              else if (e.key === 'ArrowDown') { e.preventDefault(); moveItem(idx, 1); }
                            }}
                            disabled={reorderMut.isPending}
                            className="flex-shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground/60 hover:text-foreground focus-visible:text-foreground disabled:opacity-30"
                            title="드래그하거나 화살표 위/아래로 순서 변경"
                            aria-label={`${item.name} 순서 변경 — 드래그하거나 화살표 위/아래 키`}
                          >
                            <GripVertical className="w-3.5 h-3.5" />
                          </button>
                          <span className="truncate flex-1 min-w-0" title={item.description ?? undefined}>
                            {item.name}
                          </span>
                          {item.category && (
                            <span
                              title={`영역: ${item.category}`}
                              className={`flex-shrink-0 px-1.5 py-px rounded border text-[9px] font-medium select-none ${
                                color ? color.chip : 'border-border text-muted-foreground'
                              }`}
                            >
                              {item.category}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 min-w-0 pl-5">
                          <SourceBadge sourceType={item.sourceType} />
                          {item.isSystem && (
                            <span title="시스템 항목" className="flex-shrink-0">
                              <Lock className="w-3 h-3 text-muted-foreground" />
                            </span>
                          )}
                          <div className="ml-auto flex items-center gap-0.5 flex-shrink-0">
                            {/* 실행 ▶ 는 hover 없이 항상 노출 — hover 전용이면 "버튼이 없다"고 오인된다. */}
                            {item.sourceType !== 'manual' && (
                              <button
                                onClick={() => setRunConfirm({ type: 'item', item })}
                                disabled={runningKey === `item:${item.id}`}
                                className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-primary disabled:opacity-50"
                                title="모든 클러스터에서 이 항목 실행"
                                aria-label="모든 클러스터에서 이 항목 실행"
                              >
                                {runningKey === `item:${item.id}`
                                  ? <Loader2 className="w-3 h-3 animate-spin" />
                                  : <Play className="w-3 h-3" />}
                              </button>
                            )}
                            {/* 상시 은은하게 노출(opacity-40) — hover 전용이면 터치 기기에서 도달 불가하고
                                포커스만으로는 opacity-0 상태라 키보드 사용자에게 보이지 않았다. */}
                            <div className="flex items-center gap-0.5 opacity-40 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                              <button
                                onClick={() => setFormItem(item)}
                                className="p-1 rounded hover:bg-secondary text-muted-foreground"
                                title="수정"
                                aria-label={`${item.name} 수정`}
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                              {!item.isSystem && (
                                <button
                                  onClick={() => setDeleteTarget(item)}
                                  className="p-1 rounded hover:bg-secondary text-status-critical"
                                  title="삭제"
                                  aria-label={`${item.name} 삭제`}
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </td>
                    {clusters.map((cluster) => (
                      <td key={cluster.id} className="border-b border-border text-center">
                        <CellButton
                          item={item}
                          cell={grid?.cells[item.id]?.[cluster.id]}
                          onClick={() => setCellTarget({ item, cluster })}
                        />
                      </td>
                    ))}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </MacCard>

      <CheckMatrixSettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <CheckMatrixHelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} />
      <CheckMatrixRunLogPanel
        open={runLog.open}
        onClose={() => setRunLog({ open: false })}
        batchId={runLog.batchId}
        batchLabel={runLog.label}
      />
      <CheckMatrixItemFormModal
        isOpen={formItem !== null}
        onClose={() => setFormItem(null)}
        editingItem={formItem === 'new' ? null : formItem}
      />
      {cellTarget && (
        <CheckMatrixCellDetailModal
          item={cellTarget.item}
          cluster={cellTarget.cluster}
          cronExpr={grid?.cells[cellTarget.item.id]?.[cellTarget.cluster.id]?.cronExpr ?? null}
          scheduleEnabled={grid?.cells[cellTarget.item.id]?.[cellTarget.cluster.id]?.scheduleEnabled ?? false}
          onClose={() => setCellTarget(null)}
        />
      )}
      {deleteTarget && (
        <ConfirmDialog
          open={!!deleteTarget}
          title="항목 삭제"
          description={`"${deleteTarget.name}" 항목을 삭제할까요? 이력도 함께 삭제됩니다.`}
          danger
          confirmLabel="삭제"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {runConfirm && (
        <ConfirmDialog
          open={!!runConfirm}
          title={runConfirm.type === 'cluster' ? '클러스터 전체 점검 실행' : '항목 전체 클러스터 실행'}
          description={
            runConfirm.type === 'cluster'
              ? `"${runConfirm.cluster.name}" 클러스터의 점검 항목 ${items.length}건을 지금 실행합니다. 실제 클러스터에 점검 명령이 나갑니다.`
              : `"${runConfirm.item.name}" 항목을 등록된 클러스터 ${clusters.length}곳에서 지금 실행합니다. 실제 클러스터에 점검 명령이 나갑니다.`
          }
          danger
          confirmLabel="실행"
          onConfirm={confirmRun}
          onCancel={() => setRunConfirm(null)}
        />
      )}
    </div>
  );
}
