import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Settings, Pencil, Trash2, GripVertical, Clock, Lock, HelpCircle,
  Play, ScrollText, Loader2, AlertTriangle, XCircle, CheckCircle2, Server, PauseCircle,
  SlidersHorizontal,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { StatusDot, ConfirmDialog, useToast, Skeleton, EmptyState, ResizeGrip } from '@/components/common';
import { useModalA11y } from '@/components/common/useModalA11y';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import {
  useCheckMatrixGrid, useReorderCheckMatrixItems, useDeleteCheckMatrixItem, usePutClusterCron,
  useRunCheckMatrixCluster, useRunCheckMatrixItem, useRunCheckMatrixCell, useCheckMatrixActiveRuns,
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
  item, cell, onClick, onRunNow, running, minH,
}: {
  item: CheckMatrixItem; cell: CheckMatrixCell | undefined; onClick: () => void;
  /** 수동 입력 항목엔 실행 개념이 없어 전달되지 않는다 — undefined 면 ▶ 버튼 자체를 안 그린다. */
  onRunNow?: () => void; running?: boolean; minH: number;
}) {
  const empty = !cell || !cell.hasResult || !cell.status;
  const StatusIcon = !empty ? CELL_STATUS_ICON[cell.status!] : undefined;
  return (
    <div className="relative group w-full h-full">
      <button
        onClick={onClick}
        style={{ minHeight: minH }}
        className="w-full h-full flex items-center justify-center gap-1.5 px-2 rounded-md hover:bg-muted/60 transition-colors"
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
      {onRunNow && (
        <button
          onClick={(e) => { e.stopPropagation(); onRunNow(); }}
          disabled={running}
          title={`${item.name} 지금 실행`}
          aria-label={`${item.name} 지금 실행`}
          className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 p-0.5 rounded hover:bg-secondary disabled:opacity-100 transition-opacity"
        >
          {running ? (
            <Loader2 className="w-3 h-3 text-muted-foreground animate-spin" aria-hidden="true" />
          ) : (
            <Play className="w-3 h-3 text-primary" aria-hidden="true" />
          )}
        </button>
      )}
    </div>
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

// 행 높이 — 점검 항목이 늘어날수록 "한 줄이 너무 크다"는 불만이 커지므로 사용자가 직접
// 조절할 수 있게 3단계로 노출한다. 열 너비(useColumnWidths)와 달리 행은 개별 드래그가
// 아니라 전체 밀도 토글이 맞다 — 항목마다 따로 늘여야 할 이유가 없고, 토글 쪽이 한 번에
// "더 많이 보기"를 만족시킨다.
type RowDensity = 'compact' | 'normal' | 'comfortable';
const ROW_DENSITY_STORAGE_KEY = 'pep:checkMatrixRowDensity';
const ROW_DENSITY_OPTIONS: { value: RowDensity; label: string }[] = [
  { value: 'compact', label: '좁게' },
  { value: 'normal', label: '보통' },
  { value: 'comfortable', label: '넓게' },
];
const ROW_PAD_CLS: Record<RowDensity, string> = {
  compact: 'py-0.5',
  normal: 'py-1',
  comfortable: 'py-2',
};
// compact 는 minHeight 만으로는 실제로 줄지 않았다 — 라벨 셀이 2줄(이름/카테고리 + 소스뱃지/실행·수정·삭제)
// 구조라 콘텐츠 높이가 minHeight 를 이미 넘어서기 때문. compact 에서는 한 줄로 접어서 실제로 절반 가까이 줄인다.
const ROW_MIN_H: Record<RowDensity, number> = { compact: 22, normal: 36, comfortable: 48 };

function loadRowDensity(): RowDensity {
  try {
    const v = localStorage.getItem(ROW_DENSITY_STORAGE_KEY);
    if (v === 'compact' || v === 'normal' || v === 'comfortable') return v;
  } catch { /* ignore */ }
  return 'normal';
}

// 페이지당 표시 행 수 — 점검 항목이 늘어나도 스크롤 없이 한 눈에 볼 분량을 사용자가 정할 수 있게.
// 'all' 이 기본값(기존 동작 유지, 내부 스크롤로 전체 표시).
type PageSize = 10 | 20 | 30 | 'all';
const PAGE_SIZE_STORAGE_KEY = 'pep:checkMatrixPageSize';
const PAGE_SIZE_OPTIONS: { value: PageSize; label: string }[] = [
  { value: 'all', label: '전체' },
  { value: 10, label: '10행' },
  { value: 20, label: '20행' },
  { value: 30, label: '30행' },
];

function loadPageSize(): PageSize {
  try {
    const v = localStorage.getItem(PAGE_SIZE_STORAGE_KEY);
    if (v === 'all') return 'all';
    const n = Number(v);
    if (n === 10 || n === 20 || n === 30) return n;
  } catch { /* ignore */ }
  return 'all';
}

function MatrixDisplaySettings({
  density, onDensityChange, pageSize, onPageSizeChange, onResetWidths,
}: {
  density: RowDensity; onDensityChange: (d: RowDensity) => void;
  pageSize: PageSize; onPageSizeChange: (p: PageSize) => void;
  onResetWidths: () => void;
}) {
  const [open, setOpen] = useState(false);
  const popRef = useModalA11y(open, () => setOpen(false));
  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        title="표시 설정 — 행 높이 · 열 너비"
        aria-label="표시 설정 — 행 높이 · 열 너비"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`p-1.5 rounded-xl transition-colors ${open ? 'bg-secondary text-primary' : 'hover:bg-secondary text-muted-foreground'}`}
      >
        <SlidersHorizontal className="w-3.5 h-3.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            ref={popRef}
            role="dialog"
            aria-label="표시 설정"
            className="absolute z-50 top-full mt-1 right-0 w-52 bg-card border border-border rounded-md shadow-xl p-3 space-y-2.5"
          >
            <div className="space-y-1">
              <span className="text-[11px] text-muted-foreground">행 높이</span>
              <div className="flex items-center rounded-md bg-secondary/70 p-0.5 gap-px">
                {ROW_DENSITY_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => onDensityChange(o.value)}
                    className={`flex-1 px-2 py-1 text-xs font-medium rounded transition-colors ${
                      density === o.value
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1 border-t border-border/50 pt-2">
              <span className="text-[11px] text-muted-foreground">화면당 표시 행 수</span>
              <div className="grid grid-cols-4 gap-px rounded-md bg-secondary/70 p-0.5">
                {PAGE_SIZE_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => onPageSizeChange(o.value)}
                    className={`px-1 py-1 text-xs font-medium rounded transition-colors ${
                      pageSize === o.value
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={onResetWidths}
              className="w-full text-xs text-muted-foreground hover:text-foreground transition-colors text-center py-1 border-t border-border/50 pt-2"
            >
              열 너비 초기화
            </button>
          </div>
        </>
      )}
    </div>
  );
}

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

interface PlatformStatusMatrixProps {
  /** 지정하면 카드 안쪽 헤더 줄 대신 이 DOM 노드로 툴바를 portal — 상위(HomePage)가
   * 세그먼트 탭 줄과 한 줄로 합칠 때 쓴다. 없으면 기존처럼 카드 안에 단독 헤더 줄을 그린다. */
  toolbarSlot?: HTMLElement | null;
}

export function PlatformStatusMatrix({ toolbarSlot }: PlatformStatusMatrixProps = {}) {
  const navigate = useNavigate();
  const toast = useToast();
  const { data: grid, isLoading, isError, error, refetch } = useCheckMatrixGrid();
  const reorderMut = useReorderCheckMatrixItems();
  const deleteMut = useDeleteCheckMatrixItem();
  const runClusterMut = useRunCheckMatrixCluster();
  const runItemMut = useRunCheckMatrixItem();
  const runCellMut = useRunCheckMatrixCell();

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
  // 셀 단위 즉시실행 확인 팝업 — 클러스터/항목 일괄 실행과 동일하게 실제 명령이 나가므로 확인을 받는다.
  const [cellRunConfirm, setCellRunConfirm] = useState<{ item: CheckMatrixItem; cluster: CheckMatrixGridCluster } | null>(null);
  // 로그 패널은 두 가지로 쓰인다 — batch 가 있으면 방금 트리거한 일괄 수행 추적, 없으면 전체 로그.
  const [runLog, setRunLog] = useState<{ open: boolean; batchId?: string | null; label?: string | null }>(
    { open: false },
  );
  // 어느 열/행이 실행 중인지 — 버튼 스피너 표시용(mutation 은 전역 pending 만 주므로 대상 키를 따로 든다).
  const [runningKey, setRunningKey] = useState<string | null>(null);

  const items = grid?.items ?? [];
  const clusters = grid?.clusters ?? [];

  // 행 높이 밀도 — 3단계 토글, localStorage 영속화(다른 화면 표에도 이미 쓰는 pep: 접두어).
  const [rowDensity, setRowDensity] = useState<RowDensity>(loadRowDensity);
  useEffect(() => {
    try { localStorage.setItem(ROW_DENSITY_STORAGE_KEY, rowDensity); } catch { /* ignore */ }
  }, [rowDensity]);

  // 페이지당 표시 행 수 — 'all' 이면 기존처럼 내부 스크롤로 전체 표시.
  const [pageSize, setPageSize] = useState<PageSize>(loadPageSize);
  useEffect(() => {
    try { localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(pageSize)); } catch { /* ignore */ }
  }, [pageSize]);
  const [page, setPage] = useState(0);

  // 열 너비 — 항목 라벨 열 + 클러스터마다 하나씩, 드래그로 조정하고 더블클릭으로 기본값 복원.
  // 클러스터 목록이 늘어나면 새 컬럼도 기본 너비로 자동 반영된다(useColumnWidths 의 defaults 머지).
  const colDefaults = useMemo(
    () => ({ item: 200, ...Object.fromEntries(clusters.map((c) => [c.id, 130])) }),
    // clusters 는 grid?.clusters 의 파생값 — grid 자체를 넣으면 무관한 셀 데이터 변경에도 재계산된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grid?.clusters],
  );
  const colW = useColumnWidths('platform-status-matrix', { defaults: colDefaults, min: 90, max: 420 });

  const totalPages = pageSize === 'all' ? 1 : Math.max(1, Math.ceil(items.length / pageSize));
  useEffect(() => {
    if (page > totalPages - 1) setPage(Math.max(0, totalPages - 1));
  }, [totalPages, page]);
  const pagedItems = pageSize === 'all' ? items : items.slice(page * pageSize, page * pageSize + pageSize);

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

  const handleRunCell = async (item: CheckMatrixItem, cluster: CheckMatrixGridCluster) => {
    const key = `cell:${item.id}:${cluster.id}`;
    setRunningKey(key);
    try {
      await runCellMut.mutateAsync({ itemId: item.id, clusterId: cluster.id });
      toast.success(`"${item.name}" 을(를) ${cluster.name} 에서 실행했습니다.`);
    } catch (e) {
      toast.error('실행 실패', formatApiError(e));
    } finally {
      setRunningKey(null);
    }
  };

  const confirmCellRun = async () => {
    if (!cellRunConfirm) return;
    const { item, cluster } = cellRunConfirm;
    setCellRunConfirm(null);
    await handleRunCell(item, cluster);
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

  // 카드 안 단독 헤더 줄로 그릴 수도, 상위(HomePage)의 세그먼트 탭 줄에 portal 로 이식할
  // 수도 있어 내용을 한 번만 정의한다 — toolbarSlot 이 있으면 중복되는 "플랫폼 현황" 제목은
  // 뺀다(탭이 이미 보여주므로).
  const toolbarContent = (
    <>
      {!toolbarSlot && (
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground select-none">
          플랫폼 현황
        </span>
      )}
      <button
        onClick={() => setHelpOpen(true)}
        className="p-0.5 rounded-full text-muted-foreground hover:text-primary hover:bg-secondary transition-colors flex-shrink-0"
        title="사용법 도움말"
        aria-label="사용법 도움말"
      >
        <HelpCircle className="w-3.5 h-3.5" />
      </button>
      <span className="text-[11px] text-muted-foreground truncate">항목 × 클러스터 점검 매트릭스</span>
      {/* ml-auto 여백만으로는 "화면 정체성" 그룹과 "동작" 그룹의 경계가 옅어(약한 근접성) —
          구분선으로 명시(WorkItemBoardPage 필터 바에도 쓴 것과 동일한 패턴). */}
      <div className="ml-auto flex items-center gap-1.5 border-l border-border pl-2.5 flex-shrink-0">
        <MatrixDisplaySettings
          density={rowDensity} onDensityChange={setRowDensity}
          pageSize={pageSize} onPageSizeChange={(p) => { setPageSize(p); setPage(0); }}
          onResetWidths={colW.reset}
        />
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
    </>
  );

  return (
    <div className="flex flex-col gap-2 min-h-0 flex-1">
      {toolbarSlot && createPortal(toolbarContent, toolbarSlot)}
      <MacCard bodyPadding="p-0" rootClassName="min-h-0 flex-1 flex flex-col" className="flex-1 min-h-0 flex flex-col">
        {!toolbarSlot && (
          <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-border bg-surface-container-high">
            {toolbarContent}
          </div>
        )}

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
          <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 overflow-auto">
            {/* table-layout: fixed + colgroup → 열마다 독립적으로 드래그 리사이즈 가능(useColumnWidths).
                width: max-content 는 총 열 너비가 컨테이너보다 넓어지면 그만큼 늘어나 가로 스크롤이
                자연히 생기게 하고, minWidth: 100% 는 좁을 땐 컨테이너를 채운다(ClusterManagePage 와 동일 패턴). */}
            <table className="border-collapse text-sm" style={{ tableLayout: 'fixed', width: 'max-content', minWidth: '100%' }}>
              <colgroup>
                <col style={{ width: `${colW.getWidth('item')}px` }} />
                {clusters.map((cluster) => (
                  <col key={cluster.id} style={{ width: `${colW.getWidth(cluster.id)}px` }} />
                ))}
              </colgroup>
              <thead>
                <tr className="sticky top-0 z-20 bg-card">
                  <th className="relative sticky left-0 z-30 bg-card border-b border-r border-border text-left px-3 py-2">
                    점검 항목
                    <ResizeGrip onMouseDown={(e) => colW.beginResize('item', e)} onDoubleClick={() => colW.autoFit('item')} />
                  </th>
                  {clusters.map((cluster) => (
                    <th key={cluster.id} className="relative border-b border-border px-3 py-2 font-medium">
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
                      <ResizeGrip onMouseDown={(e) => colW.beginResize(cluster.id, e)} onDoubleClick={() => colW.autoFit(cluster.id)} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pagedItems.map((item, localIdx) => {
                  // 페이지네이션 시 pagedItems 는 items 의 부분집합이라 로컬 idx 를 그대로 쓰면
                  // 정렬/드래그가 페이지 안에서만 움직인다 — items 전체 기준 절대 idx 로 환산한다.
                  const idx = pageSize === 'all' ? localIdx : page * pageSize + localIdx;
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
                    <td className={`sticky left-0 z-10 bg-card group-hover:bg-muted/30 border-r border-b border-border px-2 ${ROW_PAD_CLS[rowDensity]}`}>
                      {(() => {
                        const grip = (
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
                        );
                        const categoryChip = item.category && (
                          <span
                            title={`영역: ${item.category}`}
                            className={`flex-shrink-0 px-1.5 py-px rounded border text-[9px] font-medium select-none ${
                              color ? color.chip : 'border-border text-muted-foreground'
                            }`}
                          >
                            {item.category}
                          </span>
                        );
                        const sourceMeta = (
                          <>
                            <SourceBadge sourceType={item.sourceType} />
                            {item.isSystem && (
                              <span title="시스템 항목" className="flex-shrink-0">
                                <Lock className="w-3 h-3 text-muted-foreground" />
                              </span>
                            )}
                          </>
                        );
                        const actions = (
                          <div className="flex items-center gap-0.5 flex-shrink-0">
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
                        );
                        const nameSpan = (
                          <span className="truncate flex-1 min-w-0" title={item.description ?? undefined}>
                            {item.name}
                          </span>
                        );

                        // compact 는 minHeight 만으로 실제 높이가 줄지 않아(콘텐츠가 2줄이라 항상
                        // minHeight 를 넘어섬) — 한 줄로 접어 실제로 절반 가까이 줄인다.
                        if (rowDensity === 'compact') {
                          return (
                            <div
                              role="group"
                              aria-label={`${item.name} 행`}
                              style={{ minHeight: ROW_MIN_H[rowDensity] }}
                              className={`flex items-center gap-1.5 min-w-0 rounded-md px-1.5 border-l-2 ${
                                color ? `${color.bg} ${color.bar}` : 'border-l-transparent'
                              }`}
                            >
                              {grip}
                              {nameSpan}
                              {categoryChip}
                              {sourceMeta}
                              {actions}
                            </div>
                          );
                        }
                        return (
                          <div
                            role="group"
                            aria-label={`${item.name} 행`}
                            style={{ minHeight: ROW_MIN_H[rowDensity] }}
                            className={`flex flex-col justify-center gap-0.5 min-w-0 rounded-md px-1.5 py-1 border-l-2 ${
                              color ? `${color.bg} ${color.bar}` : 'border-l-transparent'
                            }`}
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              {grip}
                              {nameSpan}
                              {categoryChip}
                            </div>
                            <div className="flex items-center gap-1 min-w-0 pl-5">
                              {sourceMeta}
                              <div className="ml-auto flex items-center gap-0.5 flex-shrink-0">
                                {actions}
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                    </td>
                    {clusters.map((cluster) => (
                      <td key={cluster.id} className="border-b border-border text-center">
                        <CellButton
                          item={item}
                          cell={grid?.cells[item.id]?.[cluster.id]}
                          onClick={() => setCellTarget({ item, cluster })}
                          onRunNow={item.sourceType === 'manual' ? undefined : () => setCellRunConfirm({ item, cluster })}
                          running={runningKey === `cell:${item.id}:${cluster.id}`}
                          minH={ROW_MIN_H[rowDensity]}
                        />
                      </td>
                    ))}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {pageSize !== 'all' && items.length > 0 && (
            <div className="flex-shrink-0 flex items-center justify-between gap-2 px-3 py-1.5 border-t border-border text-xs text-muted-foreground">
              <span>
                {page * pageSize + 1}–{Math.min(items.length, (page + 1) * pageSize)} / {items.length}행
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="px-2 py-1 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
                  title="이전 페이지"
                  aria-label="이전 페이지"
                >
                  이전
                </button>
                <span className="tabular-nums">{page + 1} / {totalPages}</span>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="px-2 py-1 rounded hover:bg-secondary disabled:opacity-30 transition-colors"
                  title="다음 페이지"
                  aria-label="다음 페이지"
                >
                  다음
                </button>
              </div>
            </div>
          )}
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
      {cellRunConfirm && (
        <ConfirmDialog
          open={!!cellRunConfirm}
          title="지금 실행"
          description={`"${cellRunConfirm.item.name}" 을(를) ${cellRunConfirm.cluster.name} 에서 지금 실행하시겠습니까? 실제 클러스터에 점검 명령이 나갑니다.`}
          danger
          confirmLabel="실행"
          onConfirm={confirmCellRun}
          onCancel={() => setCellRunConfirm(null)}
        />
      )}
    </div>
  );
}
