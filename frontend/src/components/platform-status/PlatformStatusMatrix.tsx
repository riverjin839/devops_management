import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Plus, Settings, Pencil, Trash2, GripVertical, Clock, Lock, HelpCircle,
  Play, ScrollText, Loader2, AlertTriangle, XCircle, CheckCircle2, Server, PauseCircle,
  SlidersHorizontal, ChevronRight, SkipForward, EyeOff, RefreshCw,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { StatusDot, ConfirmDialog, useToast, Skeleton, EmptyState, ResizeGrip } from '@/components/common';
import { useModalA11y } from '@/components/common/useModalA11y';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { useCanOperate, useMyClusterAccess, CLUSTER_OPERATE_REQUIRED_HINT } from '@/hooks/useCanOperate';
import {
  checkMatrixKeys,
  useCheckMatrixGrid, useReorderCheckMatrixItems, useDeleteCheckMatrixItem, usePutClusterCron,
  useRunCheckMatrixCluster, useRunCheckMatrixItem, useRunCheckMatrixCell, useCheckMatrixActiveRuns,
} from '@/hooks/useCheckMatrix';
import { useCheckMatrixLogStore } from '@/stores/checkMatrixLogStore';
import type { CheckMatrixCell, CheckMatrixItem, CheckMatrixGridCluster, CheckMatrixRunState, Status } from '@/types';
import { formatApiError, formatRelativeTime, parseUTC } from '@/lib/utils';
import { checkCron, describeCron, DEFAULT_CRON_TIMEZONE, formatWallClock, nextRuns } from '@/lib/cron';
import { CheckMatrixCellDetailModal } from './CheckMatrixCellDetailModal';
import { CheckMatrixItemFormModal } from './CheckMatrixItemFormModal';
import { CheckMatrixSettingsModal } from './CheckMatrixSettingsModal';
import { CheckMatrixHelpPanel } from './CheckMatrixHelpPanel';
import { CheckMatrixRunLogPanel } from './CheckMatrixRunLogPanel';
import { CronInput } from './CronInput';
import { ExecTechBadge } from './ExecTechBadge';
import { TargetDuplicateBadge } from './TargetDuplicateBadge';
import { rowColor } from './rowColors';
import { useRunFeedback } from './useRunFeedback';

const STATUS_LABEL: Record<Status, string> = {
  healthy: '정상', warning: '경고', critical: '위험', pending: '대기',
};

// 경고/위험은 색상(StatusDot) 만으로 전달하지 않는다 — 값이 표시될 때도 상태를 알 수 있도록
// 형태가 다른 아이콘을 함께 준다(색맹·저채도 화면에서도 구분 가능).
const CELL_STATUS_ICON: Partial<Record<Status, typeof AlertTriangle>> = {
  warning: AlertTriangle,
  critical: XCircle,
};

const ACTIVE_STATES = new Set<CheckMatrixRunState>(['queued', 'running']);

// ── 결과 신선도 ─────────────────────────────────────────────────────────────
// 7일 전 "정상" 이 방금 "정상" 과 똑같이 보이면 안 된다. 주기가 있으면 그 주기 최대 간격의 2배,
// 주기가 없으면 7일을 넘긴 결과를 "오래됨" 으로 흐리게 표시한다. cron 해석은 식마다 한 번만.
const STALE_NO_SCHEDULE_MS = 7 * 24 * 3600 * 1000;
const staleWindowCache = new Map<string, number>();
function staleWindowMs(cronExpr: string | null | undefined, enabled: boolean, tz: string): number {
  if (!cronExpr || !enabled) return STALE_NO_SCHEDULE_MS;
  const key = `${tz}|${cronExpr}`;
  const hit = staleWindowCache.get(key);
  if (hit !== undefined) return hit;
  let windowMs = STALE_NO_SCHEDULE_MS;
  try {
    const runs = nextRuns(cronExpr, 12, tz);
    let maxGap = 0;
    for (let i = 1; i < runs.length; i += 1) maxGap = Math.max(maxGap, runs[i].getTime() - runs[i - 1].getTime());
    if (maxGap > 0) windowMs = Math.max(maxGap * 2, 60 * 60 * 1000);
  } catch { /* 해석 불가한 식은 기본값 */ }
  staleWindowCache.set(key, windowMs);
  return windowMs;
}

interface CellView {
  empty: boolean;
  stale: boolean;
  /** 최근 실행이 실패/건너뜀이고, 그게 지금 보이는 값보다 새롭다 */
  lastRunProblem: 'failed' | 'skipped' | null;
}

function cellView(cell: CheckMatrixCell | undefined, tz: string): CellView {
  const empty = !cell || !cell.hasResult || !cell.status;
  const checked = cell?.checkedAt ? parseUTC(cell.checkedAt).getTime() : null;
  const stale = !empty && checked !== null
    && Date.now() - checked > staleWindowMs(cell?.cronExpr, !!cell?.scheduleEnabled, tz);
  let lastRunProblem: CellView['lastRunProblem'] = null;
  if (cell?.lastRunState === 'failed' || cell?.lastRunState === 'skipped') {
    const lastAt = cell.lastRunAt ? parseUTC(cell.lastRunAt).getTime() : 0;
    if (checked === null || lastAt > checked) lastRunProblem = cell.lastRunState;
  }
  return { empty, stale, lastRunProblem };
}

function cellTitle(item: CheckMatrixItem, cell: CheckMatrixCell | undefined, view: CellView, active?: CheckMatrixRunState): string {
  const lines: string[] = [];
  if (active) lines.push(active === 'queued' ? '실행 대기 중' : '지금 실행 중');
  if (view.empty) {
    if (item.sourceType === 'manual') lines.push('수동 입력 항목 — 아직 값이 없습니다. 눌러서 기록하세요.');
    else if (cell?.scheduleEnabled && cell.cronExpr) lines.push(`아직 결과 없음 — 예약된 주기(${cell.cronExpr})를 기다리는 중`);
    else lines.push('아직 결과 없음 — 눌러서 지금 실행하거나 주기를 정하세요.');
  } else if (cell?.status) {
    lines.push(`판정: ${STATUS_LABEL[cell.status]}${cell.value != null ? ` · ${cell.value}${item.unit ?? ''}` : ''}`);
    if (cell.checkedAt) {
      lines.push(`마지막 점검: ${formatRelativeTime(cell.checkedAt)} (${parseUTC(cell.checkedAt).toLocaleString('ko-KR')})${view.stale ? ' — 오래된 결과' : ''}`);
    }
    if (cell.message) lines.push(cell.message);
  }
  if (view.lastRunProblem) {
    lines.push(`최근 실행 ${view.lastRunProblem === 'failed' ? '실패' : '건너뜀'}${cell?.lastRunAt ? ` (${formatRelativeTime(cell.lastRunAt)})` : ''}: ${cell?.lastRunMessage ?? '사유 없음'}`);
  }
  lines.push('눌러서 상세·실행 기록 보기');
  return lines.join('\n');
}

function CellButton({
  item, cell, view, active, onClick, onRunNow, minH, runDisabledHint,
}: {
  item: CheckMatrixItem; cell: CheckMatrixCell | undefined; view: CellView;
  active?: CheckMatrixRunState;
  onClick: () => void;
  /** 수동 입력 항목엔 실행 개념이 없어 전달되지 않는다 — undefined 면 ▶ 버튼 자체를 안 그린다. */
  onRunNow?: () => void;
  minH: number;
  /** D-082 — 실행 권한이 없으면 ▶ 를 비활성 + 사유(title). */
  runDisabledHint?: string;
}) {
  const StatusIcon = !view.empty ? CELL_STATUS_ICON[cell!.status!] : undefined;
  return (
    <div className="relative group/cell w-full h-full">
      <button
        onClick={onClick}
        style={{ minHeight: minH }}
        className={`w-full h-full flex items-center justify-center gap-1.5 px-2 rounded-md hover:bg-muted transition-colors ${
          view.stale ? 'opacity-50' : ''
        } ${active ? 'ring-1 ring-inset ring-status-info/60' : ''}`}
        title={cellTitle(item, cell, view, active)}
        aria-label={`${item.name} 셀 — ${cellTitle(item, cell, view, active).replace(/\n/g, '. ')}`}
      >
        {active && <Loader2 className="w-3 h-3 flex-shrink-0 animate-spin text-status-info" aria-hidden="true" />}
        {view.empty ? (
          <span className="text-muted-foreground text-xs">
            {active ? (active === 'queued' ? '대기' : '실행 중') : view.lastRunProblem === 'skipped' ? '건너뜀' : '—'}
          </span>
        ) : (
          <>
            <StatusDot variant={cell!.status!} />
            {StatusIcon && <StatusIcon className="w-3 h-3 flex-shrink-0" aria-hidden="true" />}
            <span className="text-xs font-medium tabular-nums">
              {cell!.value != null ? `${cell!.value}${item.unit ?? ''}` : STATUS_LABEL[cell!.status!]}
            </span>
          </>
        )}
      </button>
      {/* 최근 실행 실패/건너뜀 — 값은 이전 결과라도 "최근엔 못 돌았다" 를 놓치지 않게 모서리 표식 */}
      {view.lastRunProblem && !active && (
        <span
          className={`pointer-events-none absolute bottom-0.5 left-0.5 ${
            view.lastRunProblem === 'failed' ? 'text-status-critical' : 'text-muted-foreground'
          }`}
          aria-hidden="true"
        >
          {view.lastRunProblem === 'failed' ? <XCircle className="w-2.5 h-2.5" /> : <SkipForward className="w-2.5 h-2.5" />}
        </span>
      )}
      {onRunNow && !active && (
        <button
          onClick={(e) => { e.stopPropagation(); onRunNow(); }}
          disabled={!!runDisabledHint}
          title={runDisabledHint ?? `${item.name} — 이 셀만 지금 실행`}
          aria-label={runDisabledHint ? `${item.name} 이 셀만 실행 — ${runDisabledHint}` : `${item.name} 이 셀만 실행`}
          className="absolute top-0.5 right-0.5 opacity-0 group-hover/cell:opacity-100 group-focus-within/cell:opacity-100 focus:opacity-100 p-0.5 rounded hover:bg-secondary disabled:group-hover/cell:opacity-40 disabled:cursor-not-allowed transition-opacity"
        >
          <Play className={`w-3 h-3 ${runDisabledHint ? 'text-muted-foreground' : 'text-primary'}`} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

// ── 범례 ────────────────────────────────────────────────────────────────────
// 셀·배지 기호의 뜻이 툴팁이나 도움말을 열어야만 보이던 것을 화면 안에 한 줄로 상시 노출한다.
function MatrixLegend({ onHide }: { onHide: () => void }) {
  const item = (node: React.ReactNode, label: string) => (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">{node}<span>{label}</span></span>
  );
  return (
    <div className="flex-shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 border-b border-border text-[11px] text-muted-foreground bg-card">
      <span className="font-semibold text-foreground">범례</span>
      {item(<StatusDot variant="healthy" />, '정상')}
      {item(<><StatusDot variant="warning" /><AlertTriangle className="w-3 h-3" aria-hidden="true" /></>, '경고')}
      {item(<><StatusDot variant="critical" /><XCircle className="w-3 h-3" aria-hidden="true" /></>, '위험')}
      {item(<StatusDot variant="pending" />, '대기(판정 보류)')}
      {item(<span className="font-medium">—</span>, '아직 결과 없음')}
      {item(<Loader2 className="w-3 h-3 text-status-info" aria-hidden="true" />, '실행 중')}
      {item(<span className="opacity-50 font-medium">정상</span>, '오래된 결과')}
      {item(<XCircle className="w-2.5 h-2.5 text-status-critical" aria-hidden="true" />, '최근 실행 실패')}
      {item(<Lock className="w-3 h-3" aria-hidden="true" />, '핵심 항목(삭제 불가)')}
      <span className="hidden xl:inline">· 셀을 누르면 상세·실행 기록, 항목 이름을 누르면 항목 상세로 이동</span>
      <button
        onClick={onHide}
        className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded-xl hover:bg-secondary"
        title="범례 숨기기 — 표시 설정에서 다시 켤 수 있습니다"
        aria-label="범례 숨기기"
      >
        <EyeOff className="w-3 h-3" aria-hidden="true" /> 숨기기
      </button>
    </div>
  );
}

// ── 클러스터 열 머리글: 상태(점)와 주기(배지)를 분리 ──────────────────────────
// 예전엔 하나의 배지가 "주기 꺼짐(회색)" 과 "클러스터 위험(빨강)" 을 동시에 표현해 주기가 꺼진
// 위험 클러스터가 회색으로 보였다. 상태는 이름 옆 점, 배지는 주기만 말한다.
type CronTone = 'unset' | 'off' | 'running' | 'on';
const CRON_TONE_CLS: Record<CronTone, string> = {
  unset: 'text-muted-foreground border-dashed border-border',
  off: 'text-muted-foreground border-border opacity-70',
  running: 'text-status-info border-status-info/50 bg-status-info-soft',
  on: 'text-foreground border-border bg-secondary/60',
};
const CRON_TONE_ICON: Record<CronTone, typeof Clock> = {
  unset: Clock, off: PauseCircle, running: Loader2, on: Clock,
};

function ClusterCronBadge({
  cluster, isRunning, editDisabledHint, timezone,
}: { cluster: CheckMatrixGridCluster; isRunning: boolean; editDisabledHint?: string; timezone: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(cluster.checkCronExpr ?? '');
  const [enabled, setEnabled] = useState(cluster.checkCronEnabled);
  const mutation = usePutClusterCron();
  const popRef = useModalA11y(open, () => setOpen(false));
  const valid = checkCron(value, timezone).ok;

  const handleSave = async () => {
    try {
      await mutation.mutateAsync({
        clusterId: cluster.id, checkCronExpr: value.trim() || null, checkCronEnabled: enabled,
      });
      toast.success(`${cluster.name} 핵심 점검 주기 저장됨`);
      setOpen(false);
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  const tone: CronTone = !cluster.checkCronExpr ? 'unset' : !cluster.checkCronEnabled ? 'off' : isRunning ? 'running' : 'on';
  const ToneIcon = CRON_TONE_ICON[tone];
  const human = cluster.checkCronExpr ? describeCron(cluster.checkCronExpr) : undefined;
  let nextText = '';
  if (tone === 'on' || tone === 'running') {
    try {
      const n = nextRuns(cluster.checkCronExpr!, 1, timezone)[0];
      if (n) nextText = ` · 다음 ${formatWallClock(n)}`;
    } catch { /* 해석 불가 — 서버가 저장 시 검증 */ }
  }
  const label = tone === 'unset' ? '주기 없음' : tone === 'off' ? '주기 꺼짐' : (human ?? cluster.checkCronExpr!);
  const hint = tone === 'unset'
    ? '핵심 점검 주기가 없습니다 — 수동 실행만 됩니다.'
    : tone === 'off'
      ? `주기(${cluster.checkCronExpr})는 저장돼 있지만 꺼져 있어 자동 실행되지 않습니다.`
      : `핵심 점검 주기: ${cluster.checkCronExpr}${human ? ` (${human})` : ''}${nextText}${isRunning ? ' — 지금 실행 중' : ''}`;

  return (
    <div className="relative inline-block max-w-full">
      <button
        onClick={() => {
          setValue(cluster.checkCronExpr ?? '');
          setEnabled(cluster.checkCronEnabled);
          setOpen((v) => !v);
        }}
        disabled={!!editDisabledHint}
        title={editDisabledHint ? `${hint} — ${editDisabledHint}` : `${hint}\n눌러서 주기 변경`}
        aria-label={`${cluster.name} 핵심 점검 주기 — ${hint}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`inline-flex items-center gap-1 text-[11px] transition-colors px-1.5 py-0.5 rounded-xl border hover:brightness-95 disabled:cursor-not-allowed max-w-[150px] ${CRON_TONE_CLS[tone]}`}
      >
        <ToneIcon className={`w-2.5 h-2.5 flex-shrink-0 ${tone === 'running' ? 'animate-spin' : ''}`} aria-hidden="true" />
        <span className="truncate">{label}</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            ref={popRef}
            role="dialog"
            aria-label={`${cluster.name} 핵심 점검 주기 설정`}
            className="absolute z-50 top-full mt-1 left-1/2 -translate-x-1/2 w-80 bg-card border border-border rounded-md shadow-xl p-3 space-y-2 text-left font-normal"
          >
            <p className="text-[11px] text-muted-foreground">
              핵심 점검(API 서버·컴포넌트·노드·시스템 파드)의 클러스터 단위 주기입니다. 클러스터 상태(사이드바 색)를 결정합니다.
            </p>
            <CronInput value={value} onChange={setValue} timezone={timezone} hidePresets={false} autoFocus />
            <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
              <input type="checkbox" className="rounded border-border" checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)} />
              자동 실행 켜기 (끄면 주기는 남고 실행만 멈춥니다)
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
                disabled={mutation.isPending || !valid}
                className="px-2 py-1 text-xs font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50"
              >
                {mutation.isPending ? '저장 중…' : '저장'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// 행 높이 — 3단계 토글(열 너비는 드래그).
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
const ROW_MIN_H: Record<RowDensity, number> = { compact: 22, normal: 36, comfortable: 48 };

function loadPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch { /* ignore */ }
  return fallback;
}
function savePref(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

// 영역(카테고리)별 그룹 — 대소문자 구분 없이 묶는다("K8s" 와 "k8s" 가 따로 놀던 문제).
const UNCATEGORIZED_GROUP = '__uncategorized__';
const CATEGORY_ORDER = ['k8s', 'network', 'storage', 'os', 'app'];
const CATEGORY_LABEL: Record<string, string> = {
  k8s: 'K8s', network: '네트워크', storage: '스토리지', os: 'OS', app: '애플리케이션',
};
// 펼친 그룹을 저장한다(접힌 그룹이 아니라) — 나중에 생긴 영역은 기본값(문제 있으면 펼침)을 따른다.
const GROUP_EXPANDED_STORAGE_KEY = 'pep:checkMatrixExpandedGroups';
const GROUP_BADGE_CLS: Record<'critical' | 'warning' | 'healthy', string> = {
  critical: 'text-status-critical bg-status-critical-soft border-status-critical/40',
  warning: 'text-status-warning bg-status-warning-soft border-status-warning/40',
  healthy: 'text-muted-foreground bg-secondary border-border',
};

function loadExpandedGroups(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(GROUP_EXPANDED_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Record<string, boolean>;
  } catch { /* ignore */ }
  return {};
}

interface DisplaySettingsProps {
  density: RowDensity; onDensityChange: (d: RowDensity) => void;
  onExpandAllGroups: () => void; onCollapseAllGroups: () => void;
  onResetWidths: () => void;
  showDisabled: boolean; onShowDisabledChange: (v: boolean) => void; disabledCount: number;
  showLegend: boolean; onShowLegendChange: (v: boolean) => void;
}

function MatrixDisplaySettings(p: DisplaySettingsProps) {
  const [open, setOpen] = useState(false);
  const popRef = useModalA11y(open, () => setOpen(false));
  const autoOpenLog = useCheckMatrixLogStore((s) => s.autoOpen);
  const setAutoOpenLog = useCheckMatrixLogStore((s) => s.setAutoOpen);
  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        title="표시 설정 — 행 높이 · 범례 · 실행 로그 · 비활성 항목"
        aria-label="표시 설정"
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
            className="absolute z-50 top-full mt-1 right-0 w-64 bg-card border border-border rounded-md shadow-xl p-3 space-y-2.5"
          >
            <div className="space-y-1">
              <span className="text-[11px] text-muted-foreground">행 높이</span>
              <div className="flex items-center rounded-xl bg-secondary/70 p-0.5 gap-px" role="group" aria-label="행 높이">
                {ROW_DENSITY_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    onClick={() => p.onDensityChange(o.value)}
                    aria-pressed={p.density === o.value}
                    className={`flex-1 px-2 py-1 text-xs font-medium rounded-xl transition-colors ${
                      p.density === o.value
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5 border-t border-border/50 pt-2">
              <label className="flex items-start gap-2 text-xs cursor-pointer select-none">
                <input type="checkbox" className="mt-0.5" checked={autoOpenLog} onChange={(e) => setAutoOpenLog(e.target.checked)} />
                <span>
                  실행하면 실행 로그 창 자동으로 열기
                  <span className="block text-[11px] text-muted-foreground">끄면 실행 알림의 「로그 보기」 로 엽니다.</span>
                </span>
              </label>
              <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                <input type="checkbox" checked={p.showLegend} onChange={(e) => p.onShowLegendChange(e.target.checked)} />
                범례 표시
              </label>
              <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                <input type="checkbox" checked={p.showDisabled} onChange={(e) => p.onShowDisabledChange(e.target.checked)} />
                비활성 항목도 표시 {p.disabledCount > 0 && <span className="text-muted-foreground">({p.disabledCount})</span>}
              </label>
            </div>
            <div className="space-y-1 border-t border-border/50 pt-2">
              <span className="text-[11px] text-muted-foreground">영역 그룹</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={p.onExpandAllGroups}
                  className="flex-1 px-2 py-1 text-xs font-medium rounded-xl bg-secondary/70 hover:bg-secondary transition-colors"
                >
                  모두 펼치기
                </button>
                <button
                  onClick={p.onCollapseAllGroups}
                  className="flex-1 px-2 py-1 text-xs font-medium rounded-xl bg-secondary/70 hover:bg-secondary transition-colors"
                >
                  모두 접기
                </button>
              </div>
            </div>
            <button
              onClick={p.onResetWidths}
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

// ── 목록 보기(표 대체) ───────────────────────────────────────────────────────
// 표는 "항목 × 클러스터" 를 한눈에 보기 좋지만, 좁은 화면·스크린리더에서는 가로 스크롤과 2차원
// 탐색이 부담이다. 같은 데이터를 영역 → 항목 → 클러스터별 칩의 1차원 목록으로 보여 준다
// (1024px 미만에서는 기본값, 넓은 화면에서도 툴바에서 고를 수 있다).
type MatrixView = 'table' | 'list';

interface ListGroup {
  key: string; label: string;
  entries: { item: CheckMatrixItem; idx: number }[];
  counts: { healthy: number; warning: number; critical: number };
}

function MatrixListView({
  groups, clusters, cells, timezone, activeByCell, isExpanded, toggleGroup, onOpenCell, onOpenItem,
}: {
  groups: ListGroup[];
  clusters: CheckMatrixGridCluster[];
  cells: Record<string, Record<string, CheckMatrixCell>> | undefined;
  timezone: string;
  activeByCell: Map<string, CheckMatrixRunState>;
  isExpanded: (g: ListGroup) => boolean;
  toggleGroup: (g: ListGroup) => void;
  onOpenCell: (item: CheckMatrixItem, cluster: CheckMatrixGridCluster) => void;
  onOpenItem: (item: CheckMatrixItem) => void;
}) {
  return (
    <div className="flex-1 min-h-0 overflow-auto p-2 space-y-2" role="list" aria-label="점검 항목 목록">
      {groups.map((g) => {
        const expanded = isExpanded(g);
        return (
          <section key={g.key} role="listitem" aria-label={`${g.label} 영역`} className="rounded-md border border-border">
            <button
              onClick={() => toggleGroup(g)}
              aria-expanded={expanded}
              className="w-full flex items-center gap-1.5 px-3 py-2 bg-surface-container-high rounded-t-md text-left"
            >
              <ChevronRight className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden="true" />
              <span className="text-xs font-semibold">{g.label}</span>
              <span className="text-[11px] text-muted-foreground">{g.entries.length}개</span>
              <span className="ml-auto flex items-center gap-1">
                {g.counts.critical > 0 && <span className={`px-1 rounded border text-[11px] font-semibold ${GROUP_BADGE_CLS.critical}`}>위험 {g.counts.critical}</span>}
                {g.counts.warning > 0 && <span className={`px-1 rounded border text-[11px] font-semibold ${GROUP_BADGE_CLS.warning}`}>경고 {g.counts.warning}</span>}
              </span>
            </button>
            {expanded && (
              <ul className="divide-y divide-border">
                {g.entries.map(({ item }) => (
                  <li key={item.id} className={`px-3 py-2 space-y-1.5 ${item.enabled ? '' : 'opacity-60'}`}>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <button
                        onClick={() => onOpenItem(item)}
                        className="text-sm font-medium truncate text-left hover:text-primary hover:underline underline-offset-2"
                        title="항목 상세로 이동"
                      >
                        {item.name}
                      </button>
                      <ExecTechBadge execTech={item.execTech} />
                      {item.isSystem && <Lock className="w-3 h-3 text-muted-foreground" aria-label="핵심 항목" />}
                      {!item.enabled && <span className="px-1 rounded border border-border text-[11px] text-muted-foreground">꺼짐</span>}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {clusters.map((cluster) => {
                        const cell = cells?.[item.id]?.[cluster.id];
                        const view = cellView(cell, timezone);
                        const active = activeByCell.get(`${item.id}:${cluster.id}`);
                        const label = active
                          ? (active === 'queued' ? '대기' : '실행 중')
                          : view.empty
                            ? (view.lastRunProblem === 'skipped' ? '건너뜀' : '결과 없음')
                            : cell!.value != null ? `${cell!.value}${item.unit ?? ''}` : STATUS_LABEL[cell!.status!];
                        return (
                          <button
                            key={cluster.id}
                            onClick={() => onOpenCell(item, cluster)}
                            title={cellTitle(item, cell, view, active)}
                            className={`inline-flex items-center gap-1 px-2 py-1 rounded-xl border text-xs transition-colors hover:bg-muted ${
                              view.stale ? 'opacity-50' : ''
                            } ${view.lastRunProblem === 'failed' ? 'border-status-critical/50' : 'border-border'}`}
                          >
                            {active
                              ? <Loader2 className="w-3 h-3 animate-spin text-status-info" aria-hidden="true" />
                              : !view.empty && <StatusDot variant={cell!.status!} />}
                            <span className="text-muted-foreground">{cluster.name}</span>
                            <span className="font-medium tabular-nums">{label}</span>
                            {view.lastRunProblem === 'failed' && !active && (
                              <XCircle className="w-3 h-3 text-status-critical" aria-label="최근 실행 실패" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

const PROBLEM_STATUSES = new Set<Status>(['warning', 'critical']);

interface PlatformStatusMatrixProps {
  /** 지정하면 카드 안쪽 헤더 줄 대신 이 DOM 노드로 툴바를 portal — 상위(HomePage)가
   * 세그먼트 탭 줄과 한 줄로 합칠 때 쓴다. `null` 은 "슬롯이 곧 생긴다" 는 뜻이라 툴바를 아직
   * 그리지 않는다(첫 렌더에 카드 안 헤더가 잠깐 그려졌다 사라지는 깜빡임 방지).
   * `undefined`(미지정)면 기존처럼 카드 안에 단독 헤더 줄을 그린다. */
  toolbarSlot?: HTMLElement | null;
}

type RunConfirm =
  | { type: 'cluster'; cluster: CheckMatrixGridCluster }
  | { type: 'item'; item: CheckMatrixItem }
  | { type: 'cell'; item: CheckMatrixItem; cluster: CheckMatrixGridCluster };

export function PlatformStatusMatrix({ toolbarSlot }: PlatformStatusMatrixProps = {}) {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: grid, isLoading, isError, error, refetch, isFetching } = useCheckMatrixGrid();
  const reorderMut = useReorderCheckMatrixItems();
  const deleteMut = useDeleteCheckMatrixItem();
  const runClusterMut = useRunCheckMatrixCluster();
  const runItemMut = useRunCheckMatrixItem();
  const runCellMut = useRunCheckMatrixCell();
  const feedback = useRunFeedback();
  const showLog = useCheckMatrixLogStore((s) => s.show);
  const timezone = grid?.timezone || DEFAULT_CRON_TIMEZONE;

  // 권한 — 역할(viewer 면 전부 비활성 + 사유)과 테넌트 바인딩(클러스터별 operate 여부)을 함께 본다.
  // 예전엔 클러스터 없이 판정해 읽기 전용 바인딩 클러스터에서도 ▶ 가 눌려 403 이 났다.
  const { canOperate, role, hint: operateHint, withHint, ariaWithHint } = useCanOperate();
  const { data: myAccess } = useMyClusterAccess(canOperate && role !== 'admin');
  const clusterHint = (clusterId: string): string | undefined => {
    if (operateHint) return operateHint;
    const level = myAccess?.[clusterId];
    return level !== undefined && level !== 'operate' ? CLUSTER_OPERATE_REQUIRED_HINT : undefined;
  };

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [formItem, setFormItem] = useState<CheckMatrixItem | null | 'new'>(null);
  const [deleteTarget, setDeleteTarget] = useState<CheckMatrixItem | null>(null);
  // 실제 운영 클러스터에 명령이 나가는 실행(셀·행·열)은 모두 확인을 받는다.
  const [runConfirm, setRunConfirm] = useState<RunConfirm | null>(null);
  const [cellTarget, setCellTarget] = useState<{ item: CheckMatrixItem; cluster: CheckMatrixGridCluster } | null>(null);
  // HTTP 요청이 진행 중인 실행 키들 — 응답 후엔 activeRuns(서버 기준 대기/실행 중)가 이어받는다.
  const [requesting, setRequesting] = useState<Set<string>>(() => new Set());
  const mark = (key: string, on: boolean) => setRequesting((prev) => {
    const next = new Set(prev);
    if (on) next.add(key); else next.delete(key);
    return next;
  });

  const allItems = useMemo(() => grid?.items ?? [], [grid?.items]);
  const clusters = useMemo(() => grid?.clusters ?? [], [grid?.clusters]);

  const [rowDensity, setRowDensity] = useState<RowDensity>(() => loadPref(ROW_DENSITY_STORAGE_KEY, ['compact', 'normal', 'comfortable'] as const, 'normal'));
  useEffect(() => { savePref(ROW_DENSITY_STORAGE_KEY, rowDensity); }, [rowDensity]);
  const [showLegend, setShowLegend] = useState(() => loadPref('pep:checkMatrixLegend', ['1', '0'] as const, '1') === '1');
  useEffect(() => { savePref('pep:checkMatrixLegend', showLegend ? '1' : '0'); }, [showLegend]);
  // 비활성 항목은 기본으로 숨긴다 — 예전엔 "비활성 = 숨김" 이라 해 놓고 그대로 그려 혼란을 줬다.
  const [showDisabled, setShowDisabled] = useState(() => loadPref('pep:checkMatrixShowDisabled', ['1', '0'] as const, '0') === '1');
  useEffect(() => { savePref('pep:checkMatrixShowDisabled', showDisabled ? '1' : '0'); }, [showDisabled]);
  const disabledCount = allItems.filter((i) => !i.enabled).length;
  // "문제만 보기" — 경고·위험 셀이 있거나 최근 실행이 실패한 항목만. 항목이 수십 개가 되면 정상 행이
  // 화면 대부분을 차지해 정작 볼 행을 찾기 어렵다.
  const [problemsOnly, setProblemsOnly] = useState(() => loadPref('pep:checkMatrixProblemsOnly', ['1', '0'] as const, '0') === '1');
  useEffect(() => { savePref('pep:checkMatrixProblemsOnly', problemsOnly ? '1' : '0'); }, [problemsOnly]);
  const items = useMemo(() => {
    let out = showDisabled ? allItems : allItems.filter((i) => i.enabled);
    if (problemsOnly) {
      out = out.filter((i) => Object.values(grid?.cells[i.id] ?? {}).some(
        (c) => (c.status && PROBLEM_STATUSES.has(c.status)) || c.lastRunState === 'failed',
      ));
    }
    return out;
  }, [allItems, showDisabled, problemsOnly, grid?.cells]);

  // 표/목록 — 사용자가 고른 값이 있으면 그것, 없으면 1024px 미만에서 목록.
  const narrowQuery = '(max-width: 1023px)';
  const [narrow, setNarrow] = useState(() => {
    try { return window.matchMedia(narrowQuery).matches; } catch { return false; }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try { mq = window.matchMedia(narrowQuery); } catch { return undefined; }
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const [viewPref, setViewPref] = useState<MatrixView | 'auto'>(() => loadPref('pep:checkMatrixView', ['table', 'list', 'auto'] as const, 'auto'));
  useEffect(() => { savePref('pep:checkMatrixView', viewPref); }, [viewPref]);
  const view: MatrixView = viewPref === 'auto' ? (narrow ? 'list' : 'table') : viewPref;

  // 지금 대기/실행 중인 셀 — 셀 스피너, 클러스터 배지, 중복 실행 방지가 모두 이 한 쿼리를 본다.
  const { data: activeRuns } = useCheckMatrixActiveRuns(clusters.length > 0);
  const activeByCell = useMemo(() => {
    const m = new Map<string, CheckMatrixRunState>();
    for (const r of activeRuns?.runs ?? []) {
      if (ACTIVE_STATES.has(r.runState)) {
        const key = `${r.itemId}:${r.clusterId}`;
        if (m.get(key) !== 'running') m.set(key, r.runState);
      }
    }
    return m;
  }, [activeRuns]);
  const runningClusterIds = useMemo(
    () => new Set((activeRuns?.runs ?? []).map((r) => r.clusterId)),
    [activeRuns],
  );
  const runningItemIds = useMemo(
    () => new Set((activeRuns?.runs ?? []).map((r) => r.itemId)),
    [activeRuns],
  );
  // 실행이 끝나 활성 수가 줄면 셀 결과가 바로 보이도록 그리드를 갱신한다 — 예전엔 로그 패널을
  // 열어 둔 배치에서만 갱신돼, 패널을 닫으면 최대 60초 동안 이전 값이 남았다.
  const prevActive = useRef(0);
  useEffect(() => {
    const n = activeRuns?.total ?? 0;
    if (n < prevActive.current) qc.invalidateQueries({ queryKey: checkMatrixKeys.grid });
    prevActive.current = n;
  }, [activeRuns?.total, qc]);

  const groups = useMemo(() => {
    const map = new Map<string, {
      key: string; label: string;
      entries: { item: CheckMatrixItem; idx: number }[];
      counts: { healthy: number; warning: number; critical: number };
    }>();
    items.forEach((item) => {
      const raw = item.category?.trim() || '';
      const key = raw ? raw.toLowerCase() : UNCATEGORIZED_GROUP;
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          label: key === UNCATEGORIZED_GROUP ? '미분류' : (CATEGORY_LABEL[key] ?? raw),
          entries: [],
          counts: { healthy: 0, warning: 0, critical: 0 },
        };
        map.set(key, g);
      }
      g.entries.push({ item, idx: allItems.indexOf(item) });
      if (!item.enabled) return;
      clusters.forEach((cluster) => {
        const status = grid?.cells[item.id]?.[cluster.id]?.status;
        if (status === 'healthy') g!.counts.healthy += 1;
        else if (status === 'warning') g!.counts.warning += 1;
        else if (status === 'critical') g!.counts.critical += 1;
      });
    });
    const orderOf = (key: string) => {
      const i = CATEGORY_ORDER.indexOf(key);
      if (i !== -1) return i;
      return key === UNCATEGORIZED_GROUP ? 999 : 500;
    };
    return Array.from(map.values()).sort((a, b) => {
      const oa = orderOf(a.key), ob = orderOf(b.key);
      return oa !== ob ? oa - ob : a.label.localeCompare(b.label);
    });
  }, [items, allItems, clusters, grid?.cells]);

  // 그룹 펼침 — 사용자가 고른 그룹은 그 선택을, 아직 고르지 않은 그룹은 "문제(경고/위험) 있으면 펼침".
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(loadExpandedGroups);
  useEffect(() => { savePref(GROUP_EXPANDED_STORAGE_KEY, JSON.stringify(expandedGroups)); }, [expandedGroups]);
  const isExpanded = (g: (typeof groups)[number]) =>
    expandedGroups[g.key] ?? (g.counts.critical > 0 || g.counts.warning > 0 || groups.length === 1);
  const toggleGroup = (g: (typeof groups)[number]) =>
    setExpandedGroups((prev) => ({ ...prev, [g.key]: !isExpanded(g) }));
  const expandAllGroups = () => setExpandedGroups(Object.fromEntries(groups.map((g) => [g.key, true])));
  const collapseAllGroups = () => setExpandedGroups(Object.fromEntries(groups.map((g) => [g.key, false])));

  const colDefaults = useMemo(
    () => ({ item: 240, ...Object.fromEntries(clusters.map((c) => [c.id, 130])) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grid?.clusters],
  );
  const colW = useColumnWidths('platform-status-matrix', { defaults: colDefaults, min: 90, max: 420 });

  // ── 실행 ──────────────────────────────────────────────────────────────────
  const runnableItemsForCluster = allItems.filter((i) => i.enabled && i.sourceType !== 'manual').length;
  const operableClusterCount = clusters.filter((c) => !clusterHint(c.id)).length;

  const doRun = async (target: RunConfirm) => {
    if (target.type === 'cluster') {
      const key = `cluster:${target.cluster.id}`;
      mark(key, true);
      try {
        const res = await runClusterMut.mutateAsync(target.cluster.id);
        feedback.batchQueued(res, `${target.cluster.name} 전체 점검`);
      } catch (e) {
        toast.error('실행 요청 실패', formatApiError(e));
      } finally {
        mark(key, false);
      }
    } else if (target.type === 'item') {
      const key = `item:${target.item.id}`;
      mark(key, true);
      try {
        const res = await runItemMut.mutateAsync(target.item.id);
        feedback.batchQueued(res, `${target.item.name} · 전 클러스터`);
      } catch (e) {
        toast.error('실행 요청 실패', formatApiError(e));
      } finally {
        mark(key, false);
      }
    } else {
      const key = `cell:${target.item.id}:${target.cluster.id}`;
      mark(key, true);
      try {
        const run = await runCellMut.mutateAsync({ itemId: target.item.id, clusterId: target.cluster.id });
        feedback.cellQueued(run, `${target.item.name} · ${target.cluster.name}`);
      } catch (e) {
        toast.error('실행 요청 실패', formatApiError(e));
      } finally {
        mark(key, false);
      }
    }
  };

  // 확인창은 요청을 보내기 전에 닫는다 — 닫히기 전 연타/Enter 로 같은 실행이 두 번 나가지 않게.
  const confirmRun = () => {
    if (!runConfirm) return;
    const target = runConfirm;
    setRunConfirm(null);
    void doRun(target);
  };

  // ── 행 순서 — 같은 영역 그룹 안에서만 움직인다 ───────────────────────────────
  // 예전엔 전체 목록 기준 인덱스로 옮겨, 화면에선 그룹으로 나뉘어 보이는데 다른 그룹 항목과 자리를
  // 바꿔 "눌렀는데 아무 일도 없는" 것처럼 보였다(서버 순서만 바뀜).
  const [drag, setDrag] = useState<{ id: string; group: string } | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const endDrag = () => { setDrag(null); setOverId(null); };
  const reorderTo = (movingId: string, targetId: string) => {
    if (movingId === targetId) return;
    const ids = allItems.map((i) => i.id);
    const from = ids.indexOf(movingId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, movingId);
    reorderMut.mutate(ids, {
      onError: (e) => toast.error('순서 변경 실패', formatApiError(e)),
    });
  };
  const handleDrop = (groupKey: string, targetId: string) => {
    if (!drag) return;
    if (drag.group !== groupKey) {
      toast.warning('같은 영역 안에서만 옮길 수 있습니다', '다른 영역으로 옮기려면 항목 수정에서 영역을 바꾸세요.');
    } else {
      reorderTo(drag.id, targetId);
    }
    endDrag();
  };
  const moveWithinGroup = (entries: { item: CheckMatrixItem }[], pos: number, dir: -1 | 1) => {
    const neighbor = entries[pos + dir];
    if (!neighbor) return;
    reorderTo(entries[pos].item.id, neighbor.item.id);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    try {
      await deleteMut.mutateAsync(target.id);
      toast.success('항목 삭제됨', target.name);
    } catch (e) {
      toast.error('삭제 실패', formatApiError(e));
    }
  };

  const activeCount = activeRuns?.total ?? 0;
  const toolbarContent = (
    <>
      {toolbarSlot === undefined && (
        <span className="text-xs font-semibold text-muted-foreground select-none">
          플랫폼 현황
        </span>
      )}
      <button
        onClick={() => setHelpOpen(true)}
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-xl text-[11px] text-muted-foreground hover:text-primary hover:bg-secondary transition-colors flex-shrink-0"
        title="사용법 도움말"
        aria-label="사용법 도움말"
      >
        <HelpCircle className="w-3.5 h-3.5" /> 사용법
      </button>
      <span className="text-[11px] text-muted-foreground truncate hidden md:inline">
        행 = 점검 항목 · 열 = 클러스터 · 셀 = 최근 판정
      </span>
      {isError && grid && (
        <span className="inline-flex items-center gap-1 text-[11px] text-status-warning" role="status">
          <AlertTriangle className="w-3 h-3" aria-hidden="true" /> 최신화 실패 — 마지막으로 받은 값 표시 중
          <button onClick={() => refetch()} className="underline underline-offset-2 hover:text-foreground">다시 시도</button>
        </span>
      )}
      <div className="ml-auto flex items-center gap-1.5 border-l border-border pl-2.5 flex-shrink-0">
        <button
          onClick={() => setProblemsOnly((v) => !v)}
          aria-pressed={problemsOnly}
          title={problemsOnly ? '모든 항목 보기' : '경고·위험이거나 최근 실행이 실패한 항목만 보기'}
          className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-xl border transition-colors ${
            problemsOnly ? 'border-status-warning/60 bg-status-warning-soft text-status-warning' : 'border-transparent hover:bg-secondary text-muted-foreground'
          }`}
        >
          <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" /> 문제만
        </button>
        <div className="inline-flex items-center rounded-xl border border-border overflow-hidden" role="group" aria-label="보기 방식">
          {(['table', 'list'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setViewPref(v)}
              aria-pressed={view === v}
              title={v === 'table' ? '표 보기 — 항목 × 클러스터' : '목록 보기 — 좁은 화면·스크린리더에 맞춘 1열 목록'}
              className={`px-2 py-1 text-xs transition-colors ${view === v ? 'bg-secondary text-foreground font-medium' : 'text-muted-foreground hover:bg-secondary/60'}`}
            >
              {v === 'table' ? '표' : '목록'}
            </button>
          ))}
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="p-1.5 rounded-xl hover:bg-secondary text-muted-foreground disabled:opacity-50"
          title="지금 새로고침 (자동 갱신: 60초)"
          aria-label="매트릭스 새로고침"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
        <MatrixDisplaySettings
          density={rowDensity} onDensityChange={setRowDensity}
          onExpandAllGroups={expandAllGroups} onCollapseAllGroups={collapseAllGroups}
          onResetWidths={colW.reset}
          showDisabled={showDisabled} onShowDisabledChange={setShowDisabled} disabledCount={disabledCount}
          showLegend={showLegend} onShowLegendChange={setShowLegend}
        />
        <button
          onClick={() => showLog(null)}
          className="relative inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-xl hover:bg-secondary transition-colors"
          title={activeCount > 0 ? `실행 로그 — 지금 ${activeCount}건 대기·실행 중` : '모든 실행의 로그(자동·수동)'}
          aria-label={activeCount > 0 ? `실행 로그 — 지금 ${activeCount}건 대기·실행 중` : '실행 로그'}
        >
          <ScrollText className="w-3.5 h-3.5" /> 실행 로그
          {activeCount > 0 && (
            <span className="inline-flex items-center gap-0.5 px-1 rounded-full bg-status-info-soft text-status-info text-[11px] tabular-nums">
              <Loader2 className="w-2.5 h-2.5 animate-spin" aria-hidden="true" />{activeCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setFormItem('new')}
          disabled={!canOperate}
          title={withHint('점검 항목 추가')}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus className="w-3.5 h-3.5" /> 항목 추가
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          disabled={!canOperate}
          className="p-1.5 rounded-xl hover:bg-secondary transition-colors text-muted-foreground disabled:opacity-50 disabled:cursor-not-allowed"
          title={withHint('매트릭스 설정 — 이력 보관 기간')}
          aria-label={ariaWithHint('매트릭스 설정')}
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </>
  );

  const confirmText = (() => {
    if (!runConfirm) return { title: '', description: '' };
    if (runConfirm.type === 'cluster') {
      return {
        title: `${runConfirm.cluster.name} — 전체 점검 실행`,
        description: `이 클러스터의 자동 점검 항목 ${runnableItemsForCluster}건을 지금 실행합니다(수동 입력·비활성 항목 제외, 이미 실행 중인 셀은 건너뜀). 실제 클러스터에 점검 명령이 나갑니다.`,
      };
    }
    if (runConfirm.type === 'item') {
      return {
        title: `${runConfirm.item.name} — 전 클러스터 실행`,
        description: `실행 권한이 있는 클러스터 ${operableClusterCount}곳에서 이 항목을 지금 실행합니다(이미 실행 중인 셀은 건너뜀). 실제 클러스터에 점검 명령이 나갑니다.`,
      };
    }
    return {
      title: '이 셀만 지금 실행',
      description: `"${runConfirm.item.name}" 을(를) ${runConfirm.cluster.name} 에서 실행합니다. 실제 클러스터에 점검 명령이 나가며, 실행 로그로 진행을 볼 수 있습니다.`,
    };
  })();

  const selectedCell = cellTarget ? grid?.cells[cellTarget.item.id]?.[cellTarget.cluster.id] : undefined;

  return (
    <div className="flex flex-col gap-2 min-h-0 flex-1">
      {toolbarSlot && createPortal(toolbarContent, toolbarSlot)}
      <MacCard bodyPadding="p-0" rootClassName="min-h-0 flex-1 flex flex-col" className="flex-1 min-h-0 flex flex-col">
        {toolbarSlot === undefined && (
          <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-border bg-surface-container-high">
            {toolbarContent}
          </div>
        )}

        {isLoading ? (
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
        ) : isError && !grid ? (
          // 데이터가 아예 없을 때만 전체 오류 화면 — 백그라운드 갱신 1회 실패로 표 전체를 지우지 않는다.
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
          <div className="flex-1 min-h-0 flex items-center justify-center">
            {clusters.length === 0 ? (
              <EmptyState
                icon={Server}
                title="보이는 클러스터가 없습니다"
                description={canOperate
                  ? '클러스터를 등록하면 열이 자동으로 생깁니다. 이미 등록돼 있다면 테넌트 바인딩으로 이 계정에 가려져 있을 수 있습니다.'
                  : '등록된 클러스터가 없거나 이 계정에 공개된 클러스터가 없습니다 — 관리자에게 요청하세요.'}
                action={canOperate ? { label: '클러스터 관리로 이동', onClick: () => navigate('/cluster-manage') } : undefined}
              />
            ) : (
              problemsOnly ? (
                <EmptyState
                  icon={CheckCircle2}
                  title="문제 있는 항목이 없습니다"
                  description="경고·위험 셀이나 최근 실행 실패가 없습니다. 모든 항목을 보려면 툴바의 「문제만」 을 끄세요."
                  action={{ label: '모든 항목 보기', onClick: () => setProblemsOnly(false) }}
                />
              ) : (
              <EmptyState
                icon={Plus}
                title={disabledCount > 0 && !showDisabled ? '활성화된 점검 항목이 없습니다' : '점검 항목이 없습니다'}
                description={disabledCount > 0 && !showDisabled
                  ? `비활성 항목 ${disabledCount}개가 숨겨져 있습니다 — 표시 설정에서 "비활성 항목도 표시" 를 켜거나 새 항목을 추가하세요.`
                  : '행(점검 항목)을 추가하면 등록된 클러스터마다 열이 자동으로 채워집니다.'}
                action={canOperate ? { label: '항목 추가', onClick: () => setFormItem('new') } : undefined}
              />
              )
            )}
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col">
          {showLegend && <MatrixLegend onHide={() => setShowLegend(false)} />}
          {view === 'list' ? (
            <MatrixListView
              groups={groups}
              clusters={clusters}
              cells={grid?.cells}
              timezone={timezone}
              activeByCell={activeByCell}
              isExpanded={isExpanded}
              toggleGroup={toggleGroup}
              onOpenCell={(item, cluster) => setCellTarget({ item, cluster })}
              onOpenItem={(item) => navigate(`/checks/${item.id}`)}
            />
          ) : (
          <div className="flex-1 min-h-0 overflow-auto">
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
                    <span className="block">점검 항목</span>
                    <span className="block text-[11px] font-normal text-muted-foreground">{items.length}개 · 영역별 묶음</span>
                    <ResizeGrip onMouseDown={(e) => colW.beginResize('item', e)} onDoubleClick={() => colW.autoFit('item')} />
                  </th>
                  {clusters.map((cluster) => {
                    const hint = clusterHint(cluster.id);
                    const requestingCluster = requesting.has(`cluster:${cluster.id}`);
                    return (
                    <th key={cluster.id} className="relative border-b border-border px-2 py-2 font-medium">
                      <div className="flex flex-col items-center gap-1 min-w-0">
                        <div className="flex items-center gap-1 min-w-0 max-w-full">
                          <span title={`클러스터 상태: ${cluster.status ? STATUS_LABEL[cluster.status] : '미확인'}`} className="flex-shrink-0">
                            <StatusDot variant={cluster.status ?? 'pending'} />
                          </span>
                          <button
                            onClick={() => navigate(`/clusters/${cluster.id}`)}
                            className="truncate hover:text-primary hover:underline underline-offset-2"
                            title={`${cluster.name} — 상태 원인·점검 카탈로그 보기`}
                          >
                            {cluster.name}
                          </button>
                        </div>
                        <div className="flex items-center gap-1 max-w-full">
                          <ClusterCronBadge
                            cluster={cluster}
                            isRunning={runningClusterIds.has(cluster.id)}
                            editDisabledHint={hint}
                            timezone={timezone}
                          />
                          <button
                            onClick={() => setRunConfirm({ type: 'cluster', cluster })}
                            disabled={!!hint || requestingCluster}
                            title={hint ?? `${cluster.name} 의 모든 자동 점검을 지금 실행`}
                            aria-label={hint ? `${cluster.name} 전체 실행 — ${hint}` : `${cluster.name} 전체 실행`}
                            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] rounded-xl border border-border text-muted-foreground hover:text-primary hover:border-primary/50 hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                          >
                            {requestingCluster
                              ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                              : <Play className="w-3 h-3" aria-hidden="true" />}
                            전체
                          </button>
                        </div>
                      </div>
                      <ResizeGrip onMouseDown={(e) => colW.beginResize(cluster.id, e)} onDoubleClick={() => colW.autoFit(cluster.id)} />
                    </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const expanded = isExpanded(g);
                  return (
                  <Fragment key={g.key}>
                    <tr className="bg-surface-container-high">
                      <td className="sticky left-0 z-10 bg-surface-container-high px-2 py-1.5 border-b border-r border-border">
                        <button
                          onClick={() => toggleGroup(g)}
                          aria-expanded={expanded}
                          className="w-full flex items-center gap-1.5 text-left min-w-0"
                          title={expanded ? '영역 접기' : '영역 펼치기'}
                        >
                          <ChevronRight
                            className={`w-3.5 h-3.5 flex-shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
                            aria-hidden="true"
                          />
                          <span className="text-xs font-semibold text-foreground truncate">{g.label}</span>
                          <span className="text-[11px] text-muted-foreground flex-shrink-0">{g.entries.length}개</span>
                          {/* 상태 카운트는 이름 바로 옆 — 클러스터가 많아 가로 스크롤해도 첫 열에 남는다. */}
                          <span className="flex items-center gap-1 flex-shrink-0 ml-auto">
                            {g.counts.critical > 0 && (
                              <span title={`위험 셀 ${g.counts.critical}개`} className={`inline-flex items-center gap-0.5 px-1 py-px rounded border text-[11px] font-semibold tabular-nums ${GROUP_BADGE_CLS.critical}`}>
                                <XCircle className="w-2.5 h-2.5" aria-hidden="true" />{g.counts.critical}
                              </span>
                            )}
                            {g.counts.warning > 0 && (
                              <span title={`경고 셀 ${g.counts.warning}개`} className={`inline-flex items-center gap-0.5 px-1 py-px rounded border text-[11px] font-semibold tabular-nums ${GROUP_BADGE_CLS.warning}`}>
                                <AlertTriangle className="w-2.5 h-2.5" aria-hidden="true" />{g.counts.warning}
                              </span>
                            )}
                            {g.counts.healthy > 0 && (
                              <span title={`정상 셀 ${g.counts.healthy}개`} className={`inline-flex items-center gap-0.5 px-1 py-px rounded border text-[11px] font-semibold tabular-nums ${GROUP_BADGE_CLS.healthy}`}>
                                <CheckCircle2 className="w-2.5 h-2.5" aria-hidden="true" />{g.counts.healthy}
                              </span>
                            )}
                          </span>
                        </button>
                      </td>
                      <td colSpan={clusters.length} className="border-b border-border bg-surface-container-high" aria-hidden="true">
                        <span className="sr-only">{g.label}</span>
                      </td>
                    </tr>
                    {expanded && g.entries.map(({ item }, pos) => {
                  const color = rowColor(item.color);
                  const itemRequesting = requesting.has(`item:${item.id}`);
                  const itemActive = runningItemIds.has(item.id);
                  const isDragOver = !!drag && overId === item.id && drag.id !== item.id && drag.group === g.key;
                  return (
                  <tr
                    key={item.id}
                    onDragOver={(e) => { if (drag) { e.preventDefault(); setOverId(item.id); } }}
                    onDrop={(e) => { e.preventDefault(); handleDrop(g.key, item.id); }}
                    className={`group ${isDragOver ? 'bg-primary/5' : ''} ${drag?.id === item.id ? 'opacity-50' : ''} ${
                      item.enabled ? '' : 'opacity-60'
                    }`}
                  >
                    <td className={`sticky left-0 z-10 bg-card group-hover:bg-muted border-r border-b border-border px-2 ${ROW_PAD_CLS[rowDensity]}`}>
                      {(() => {
                        const grip = (
                          <span
                            role="button"
                            tabIndex={canOperate ? 0 : -1}
                            draggable={canOperate && !reorderMut.isPending}
                            onDragStart={(e) => {
                              e.dataTransfer.setData('text/plain', item.id); // Firefox 는 데이터가 있어야 드래그를 시작한다
                              e.dataTransfer.effectAllowed = 'move';
                              setDrag({ id: item.id, group: g.key });
                            }}
                            onDragEnd={endDrag}
                            onKeyDown={(e) => {
                              if (!canOperate) return;
                              if (e.key === 'ArrowUp') { e.preventDefault(); moveWithinGroup(g.entries, pos, -1); }
                              else if (e.key === 'ArrowDown') { e.preventDefault(); moveWithinGroup(g.entries, pos, 1); }
                            }}
                            aria-disabled={!canOperate || undefined}
                            className={`flex-shrink-0 text-muted-foreground hover:text-foreground focus-visible:text-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary rounded ${
                              canOperate ? 'cursor-grab active:cursor-grabbing' : 'opacity-30 cursor-not-allowed'
                            }`}
                            title={withHint('드래그하거나 위/아래 화살표 키로 영역 안에서 순서 변경')}
                            aria-label={operateHint ? `${item.name} 순서 변경 — ${operateHint}` : `${item.name} 순서 변경 — 위/아래 화살표 키`}
                          >
                            <GripVertical className="w-3.5 h-3.5" />
                          </span>
                        );
                        const sourceMeta = (
                          <>
                            <ExecTechBadge execTech={item.execTech} />
                            <TargetDuplicateBadge item={item} />
                            {item.isSystem && (
                              <span title="핵심 항목 — 클러스터 상태 계산에 쓰여 삭제할 수 없습니다(숨기기만 가능)" className="flex-shrink-0">
                                <Lock className="w-3 h-3 text-muted-foreground" aria-hidden="true" />
                              </span>
                            )}
                            {!item.enabled && (
                              <span className="flex-shrink-0 px-1 py-px rounded border border-border text-[11px] text-muted-foreground" title="비활성 — 자동·일괄 실행에서 제외됩니다">
                                꺼짐
                              </span>
                            )}
                          </>
                        );
                        const actions = (
                          <div className="flex items-center gap-0.5 flex-shrink-0">
                            {item.sourceType !== 'manual' && item.enabled && (
                              <button
                                onClick={() => setRunConfirm({ type: 'item', item })}
                                disabled={!canOperate || itemRequesting}
                                className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] rounded-xl border border-transparent text-muted-foreground hover:text-primary hover:border-primary/40 hover:bg-secondary disabled:opacity-50 disabled:cursor-not-allowed"
                                title={withHint('실행 권한이 있는 모든 클러스터에서 이 항목을 지금 실행')}
                                aria-label={ariaWithHint(`${item.name} — 전 클러스터 실행`)}
                              >
                                {itemRequesting || itemActive
                                  ? <Loader2 className={`w-3 h-3 ${itemActive ? 'text-status-info' : ''} animate-spin`} aria-hidden="true" />
                                  : <Play className="w-3 h-3" aria-hidden="true" />}
                                <span className={rowDensity === 'compact' ? 'sr-only' : ''}>전 클러스터</span>
                              </button>
                            )}
                            <div className="flex items-center gap-0.5 opacity-40 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                              <button
                                onClick={() => setFormItem(item)}
                                disabled={!canOperate}
                                className="p-1 rounded-xl hover:bg-secondary text-muted-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                                title={withHint('항목 수정 — 이름·실행 소스·설정·표시')}
                                aria-label={operateHint ? `${item.name} 수정 — ${operateHint}` : `${item.name} 수정`}
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                              {!item.isSystem && (
                                <button
                                  onClick={() => setDeleteTarget(item)}
                                  disabled={!canOperate}
                                  className="p-1 rounded-xl hover:bg-secondary text-status-critical disabled:opacity-50 disabled:cursor-not-allowed"
                                  title={withHint('항목 삭제')}
                                  aria-label={operateHint ? `${item.name} 삭제 — ${operateHint}` : `${item.name} 삭제`}
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          </div>
                        );
                        const nameSpan = (
                          <button
                            onClick={() => navigate(`/checks/${item.id}`)}
                            className="truncate flex-1 min-w-0 text-left hover:text-primary hover:underline underline-offset-2"
                            title={`${item.name}${item.description ? ` — ${item.description}` : ''}\n눌러서 항목 상세(정의·테스트·주기·기록)로 이동`}
                          >
                            {item.name}
                          </button>
                        );

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
                    {clusters.map((cluster) => {
                      const cell = grid?.cells[item.id]?.[cluster.id];
                      const key = `${item.id}:${cluster.id}`;
                      const active = activeByCell.get(key) ?? (requesting.has(`cell:${key}`) ? 'queued' : undefined);
                      return (
                      <td key={cluster.id} className="border-b border-border text-center">
                        <CellButton
                          item={item}
                          cell={cell}
                          view={cellView(cell, timezone)}
                          active={active}
                          onClick={() => setCellTarget({ item, cluster })}
                          onRunNow={item.sourceType === 'manual' || !item.enabled
                            ? undefined
                            : () => setRunConfirm({ type: 'cell', item, cluster })}
                          minH={ROW_MIN_H[rowDensity]}
                          runDisabledHint={clusterHint(cluster.id)}
                        />
                      </td>
                      );
                    })}
                  </tr>
                  );
                })}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}
          </div>
        )}
      </MacCard>

      <CheckMatrixSettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <CheckMatrixHelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} />
      <CheckMatrixRunLogPanel />
      <CheckMatrixItemFormModal
        isOpen={formItem !== null}
        onClose={() => setFormItem(null)}
        editingItem={formItem === 'new' ? null : formItem}
      />
      {cellTarget && (
        <CheckMatrixCellDetailModal
          item={cellTarget.item}
          cluster={cellTarget.cluster}
          cell={selectedCell}
          timezone={timezone}
          onClose={() => setCellTarget(null)}
        />
      )}
      <ConfirmDialog
        open={!!deleteTarget}
        title="항목 삭제"
        description={deleteTarget
          ? `"${deleteTarget.name}" 항목을 삭제할까요? 이 항목의 셀 값·이력·주기·실행 기록이 함께 삭제되며 되돌릴 수 없습니다. 잠시 빼 두려면 항목 수정에서 "비활성" 으로 바꾸세요.`
          : ''}
        danger
        confirmLabel="삭제"
        busy={deleteMut.isPending}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
      <ConfirmDialog
        open={!!runConfirm}
        title={confirmText.title}
        description={confirmText.description}
        danger
        confirmLabel="실행"
        onConfirm={confirmRun}
        onCancel={() => setRunConfirm(null)}
      />
    </div>
  );
}
