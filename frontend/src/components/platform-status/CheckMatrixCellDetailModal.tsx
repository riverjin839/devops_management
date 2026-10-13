import { useEffect, useId, useMemo, useState } from 'react';
import { X, Save, Play, Loader2, AlertTriangle, Info } from 'lucide-react';
import { StatusBadge, useToast } from '@/components/common';
import type { CheckMatrixCell, CheckMatrixItem, CheckMatrixGridCluster, Status } from '@/types';
import {
  usePostManualEntry, usePutSchedule, useCheckMatrixActiveRuns,
  useCheckMatrixRunbook, useRunCheckMatrixCell, useCheckMatrixRuns, useCheckMatrixRun,
} from '@/hooks/useCheckMatrix';
import { formatApiError, formatRelativeTime, parseUTC } from '@/lib/utils';
import { checkCron, formatWallClock, DEFAULT_CRON_TIMEZONE } from '@/lib/cron';
import { useModalA11y } from '@/components/common/useModalA11y';
import { useCanOperate } from '@/hooks/useCanOperate';
import { CheckMatrixRunbookPanel } from './CheckMatrixRunbookPanel';
import { CheckMatrixRunList, CheckMatrixRunDetailView } from './CheckMatrixRunLog';
import { CheckMatrixHistoryPanel } from './CheckMatrixHistoryPanel';
import { CronInput } from './CronInput';

interface Props {
  item: CheckMatrixItem;
  cluster: CheckMatrixGridCluster;
  /** 그리드의 이 셀 — 헤더 요약(현재 판정·마지막 점검·최근 실행 실패)과 주기 초기값에 쓴다. */
  cell?: CheckMatrixCell;
  /** cron 기준 시간대(디스패처와 동일) */
  timezone?: string;
  onClose: () => void;
}

const STATUS_OPTIONS: { value: Status; label: string }[] = [
  { value: 'healthy', label: '정상' },
  { value: 'warning', label: '경고' },
  { value: 'critical', label: '위험' },
  { value: 'pending', label: '대기 (판정 보류)' },
];

type Tab = 'manual' | 'history' | 'schedule' | 'runbook' | 'runs';

/**
 * 셀(항목 × 클러스터) 상세. 탭 이름은 화면 전체에서 같은 말로 통일한다 —
 * 추이·이력 / 실행 주기 / 실행 계획(무슨 명령이 나가는지) / 실행 기록(수행 로그).
 * 수동 입력 항목은 "값 입력" 이 첫 탭이다(예전엔 이력 탭 아래에 묻혀 있었다).
 */
export function CheckMatrixCellDetailModal({ item, cluster, cell, timezone = DEFAULT_CRON_TIMEZONE, onClose }: Props) {
  const toast = useToast();
  const titleId = useId();
  const dialogRef = useModalA11y(true, onClose);
  const isManual = item.sourceType === 'manual';
  const isCore = item.sourceType === 'core_bundle';
  const runnable = !isManual;

  const tabs = useMemo(() => {
    const out: { value: Tab; label: string }[] = [];
    if (isManual) out.push({ value: 'manual', label: '값 입력' });
    out.push({ value: 'history', label: '추이 · 이력' });
    if (!isManual) out.push({ value: 'schedule', label: '실행 주기' });
    if (!isManual) out.push({ value: 'runbook', label: '실행 계획' });
    out.push({ value: 'runs', label: '실행 기록' });
    return out;
  }, [isManual]);
  const [tab, setTab] = useState<Tab>(isManual ? 'manual' : 'history');

  const [cronDraft, setCronDraft] = useState(cell?.cronExpr ?? '');
  const [cronOn, setCronOn] = useState(cell?.scheduleEnabled ?? true);
  const putSchedule = usePutSchedule();
  const cronCheck = checkCron(cronDraft, timezone);

  const [manualStatus, setManualStatus] = useState<Status>('healthy');
  const [manualValue, setManualValue] = useState('');
  const [manualMessage, setManualMessage] = useState('');
  const postManual = usePostManualEntry();

  // 런북은 '실행 계획' 탭을 열었을 때만 받아온다 — 모달 오픈 비용을 늘리지 않기 위해.
  const { data: runbook, isLoading: runbookLoading } = useCheckMatrixRunbook(
    item.id, cluster.id, tab === 'runbook',
  );
  const runCell = useRunCheckMatrixCell();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // 이 셀이 지금 대기/실행 중인지 — 전역 activeRuns 캐시를 공유한다(추가 요청 없음).
  const { data: activeRuns } = useCheckMatrixActiveRuns();
  const activeRun = activeRuns?.runs.find((r) => r.itemId === item.id && r.clusterId === cluster.id);

  // 이 셀의 가장 최근 수행 — '실행 계획' 탭에 실제 결과 색을 입힌다. 진행 중일 때만 폴링한다
  // (예전엔 탭이 열려 있는 내내 3초마다 돌았다).
  const { data: recentRuns } = useCheckMatrixRuns(
    { itemId: item.id, clusterId: cluster.id, limit: 1 }, tab === 'runbook', activeRun ? 3000 : false,
  );
  const latestRunId = recentRuns?.runs[0]?.id;
  const { data: latestRun } = useCheckMatrixRun(tab === 'runbook' ? latestRunId : undefined);

  // 실행이 이 모달 밖(그리드·cron)에서 시작돼도 '실행 기록' 탭이 그 수행을 바로 펼치도록.
  useEffect(() => {
    if (activeRun && tab === 'runs' && !selectedRunId) setSelectedRunId(activeRun.id);
  }, [activeRun, tab, selectedRunId]);

  const handleSaveSchedule = async () => {
    try {
      await putSchedule.mutateAsync({
        itemId: item.id, clusterId: cluster.id,
        cronExpr: cronDraft.trim() || null, enabled: cronOn,
      });
      toast.success('실행 주기 저장됨', !cronDraft.trim()
        ? '자동 실행하지 않습니다(수동 실행만).'
        : !cronOn ? '자동 실행이 꺼져 있어 주기만 저장됐습니다.'
          : cronCheck.next[0] ? `다음 실행: ${formatWallClock(cronCheck.next[0])}` : undefined);
    } catch (e) {
      toast.error('실행 주기 저장 실패', formatApiError(e));
    }
  };

  const manualValueNum = manualValue.trim() === '' ? null : Number(manualValue);
  const manualValueInvalid = manualValueNum !== null && !Number.isFinite(manualValueNum);
  const handleSaveManualEntry = async () => {
    if (manualValueInvalid) return;
    try {
      await postManual.mutateAsync({
        itemId: item.id, clusterId: cluster.id, status: manualStatus,
        value: manualValueNum,
        message: manualMessage.trim() || null,
      });
      toast.success('값 기록됨', `${STATUS_OPTIONS.find((o) => o.value === manualStatus)?.label}${manualValueNum !== null ? ` · ${manualValueNum}${item.unit ?? ''}` : ''}`);
      setManualValue('');
      setManualMessage('');
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  // 셀 실행은 큐잉 후 즉시 돌아온다 — '실행 기록' 탭에서 그 수행의 진행 로그를 2초 간격으로 따라간다.
  const handleRunCell = async () => {
    try {
      const run = await runCell.mutateAsync({ itemId: item.id, clusterId: cluster.id });
      setTab('runs');
      setSelectedRunId(run.id);
      toast.info(
        run.deduplicated ? '이미 실행 중입니다' : '실행을 시작했습니다',
        run.deduplicated ? '진행 중인 실행의 로그를 보여줍니다.' : '아래 실행 로그가 실시간으로 갱신됩니다.',
      );
    } catch (e) {
      toast.error('실행 요청 실패', formatApiError(e));
    }
  };

  // D-082 — viewer·실행 권한 없는 테넌트 사용자는 버튼을 보되 누르지 못하고 사유를 본다.
  const { canOperate, withHint, ariaWithHint } = useCanOperate(cluster.id);

  const lastRunProblem = cell?.lastRunState === 'failed' || cell?.lastRunState === 'skipped'
    ? (!cell.checkedAt || (cell.lastRunAt && parseUTC(cell.lastRunAt) > parseUTC(cell.checkedAt)))
    : false;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`bg-card border border-border rounded-md shadow-xl w-full mx-4 max-h-[88vh] overflow-y-auto transition-[max-width] ${
          tab === 'runbook' || tab === 'runs' ? 'max-w-4xl' : 'max-w-2xl'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-border sticky top-0 bg-card rounded-t-2xl z-10 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-semibold truncate">{item.name}</h2>
              <p className="text-xs text-muted-foreground truncate">{cluster.name}</p>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {runnable && (
                <button
                  onClick={handleRunCell}
                  disabled={!canOperate || runCell.isPending || !!activeRun}
                  title={activeRun ? '이미 실행 중입니다 — 실행 기록 탭에서 진행을 확인하세요.' : withHint('이 셀만 지금 실행 (실행 로그가 바로 열립니다)')}
                  aria-label={ariaWithHint('이 셀만 지금 실행')}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {runCell.isPending || activeRun
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                    : <Play className="w-3.5 h-3.5" aria-hidden="true" />}
                  {activeRun ? (activeRun.runState === 'queued' ? '대기 중' : '실행 중') : '지금 실행'}
                </button>
              )}
              <button
                onClick={onClose}
                title="닫기"
                aria-label="닫기"
                className="p-1 hover:bg-secondary rounded-xl transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
          {/* 현재 판정 요약 — 셀에서 본 것을 모달에서도 같은 말로 다시 보여 준다. */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {cell?.status ? <StatusBadge variant={cell.status} size="sm" /> : (
              <span className="text-muted-foreground">아직 결과 없음</span>
            )}
            {cell?.value != null && <span className="font-medium tabular-nums">{cell.value}{item.unit ?? ''}</span>}
            {cell?.checkedAt && (
              <span className="text-muted-foreground" title={parseUTC(cell.checkedAt).toLocaleString('ko-KR')}>
                마지막 점검 {formatRelativeTime(cell.checkedAt)}
              </span>
            )}
            {lastRunProblem && (
              <button
                type="button"
                onClick={() => { setTab('runs'); setSelectedRunId(cell?.lastRunId ?? null); }}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-xl border border-status-warning/50 bg-status-warning-soft text-status-warning"
                title={cell?.lastRunMessage ?? undefined}
              >
                <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                최근 실행 {cell?.lastRunState === 'failed' ? '실패' : '건너뜀'} — 원인 보기
              </button>
            )}
            {cell?.message && !lastRunProblem && (
              <span className="text-muted-foreground truncate max-w-full" title={cell.message}>{cell.message}</span>
            )}
          </div>
        </div>

        <div role="tablist" aria-label="셀 상세" className="flex items-center gap-1 px-6 pt-3 border-b border-border">
          {tabs.map((t) => (
            <button
              key={t.value}
              role="tab"
              aria-selected={tab === t.value}
              onClick={() => setTab(t.value)}
              className={`px-3 py-1.5 text-xs font-medium rounded-t-lg border-b-2 transition-colors ${
                tab === t.value
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="p-6 space-y-6" role="tabpanel">
          {tab === 'manual' && (
            <section className="space-y-3">
              <p className="text-xs text-muted-foreground">
                이 항목은 자동 점검이 없습니다 — 확인한 결과를 직접 기록하면 추이·이력과 실행 기록에
                「수동 입력」 으로 남고, 누가 언제 넣었는지도 함께 보관됩니다.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="space-y-1">
                  <span className="block text-xs font-medium">판정</span>
                  <select
                    value={manualStatus}
                    onChange={(e) => setManualStatus(e.target.value as Status)}
                    className="w-full text-sm border border-border rounded-xl px-2 py-1.5 bg-background"
                  >
                    {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="block text-xs font-medium">값 (선택){item.unit ? ` · 단위 ${item.unit}` : ''}</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={manualValue}
                    onChange={(e) => setManualValue(e.target.value)}
                    aria-invalid={manualValueInvalid || undefined}
                    className="w-full text-sm border border-border rounded-xl px-2 py-1.5 bg-background"
                  />
                </label>
                <label className="space-y-1 sm:col-span-1">
                  <span className="block text-xs font-medium">메모 (선택)</span>
                  <input
                    type="text"
                    value={manualMessage}
                    onChange={(e) => setManualMessage(e.target.value)}
                    placeholder="예: 콘솔 확인 — 디스크 72%"
                    className="w-full text-sm border border-border rounded-xl px-2 py-1.5 bg-background"
                  />
                </label>
              </div>
              <div className="flex justify-end">
                <button
                  onClick={handleSaveManualEntry}
                  disabled={!canOperate || postManual.isPending || manualValueInvalid}
                  title={withHint('이 값을 기록')}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Save className="w-3.5 h-3.5" aria-hidden="true" /> {postManual.isPending ? '저장 중…' : '기록'}
                </button>
              </div>
            </section>
          )}

          {tab === 'history' && (
            <CheckMatrixHistoryPanel
              itemId={item.id} clusterId={cluster.id} unit={item.unit} seriesName={item.name}
            />
          )}

          {tab === 'schedule' && (
            isCore ? (
              <div className="flex items-start gap-2 rounded-md border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
                <Info className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
                <p>
                  이 항목은 클러스터 상태를 결정하는 핵심 점검이라 주기를 셀마다 두지 않고 <b className="text-foreground">클러스터 열 머리글의 주기 배지</b>에서
                  클러스터 단위로 설정합니다. 매트릭스에서 <b className="text-foreground">{cluster.name}</b> 열 이름 아래 배지를 누르세요.
                </p>
              </div>
            ) : (
              <section className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  이 셀(<b className="text-foreground">{item.name}</b> × <b className="text-foreground">{cluster.name}</b>)만의 자동 실행 주기입니다.
                  저장한 시각 이후의 다음 예정 시각부터 돕니다.
                </p>
                <CronInput value={cronDraft} onChange={setCronDraft} timezone={timezone} disabled={!canOperate} />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
                    <input type="checkbox" checked={cronOn} onChange={(e) => setCronOn(e.target.checked)} disabled={!canOperate} />
                    자동 실행 켜기 <span className="text-xs text-muted-foreground">(끄면 주기는 남고 실행만 멈춥니다)</span>
                  </label>
                  <button
                    onClick={handleSaveSchedule}
                    disabled={!canOperate || putSchedule.isPending || !cronCheck.ok}
                    title={!cronCheck.ok ? cronCheck.error : withHint('실행 주기 저장')}
                    className="px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
                  >
                    <Save className="w-3.5 h-3.5" aria-hidden="true" /> {putSchedule.isPending ? '저장 중…' : '저장'}
                  </button>
                </div>
              </section>
            )
          )}

          {tab === 'runbook' && (
            <CheckMatrixRunbookPanel
              runbook={runbook}
              isLoading={runbookLoading}
              editTarget={{ itemId: item.id, clusterId: cluster.id }}
              latestRun={latestRun}
            />
          )}

          {tab === 'runs' && (
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4">
              <CheckMatrixRunList
                filter={{ itemId: item.id, clusterId: cluster.id, limit: 30 }}
                live={activeRun ? 3000 : 15000}
                selectedId={selectedRunId}
                onSelect={(id) => setSelectedRunId((cur) => (cur === id ? null : id))}
                emptyText={runnable
                  ? "이 셀의 실행 기록이 아직 없습니다 — 상단 '지금 실행'으로 한 번 돌려보세요."
                  : '아직 기록된 값이 없습니다 — 값 입력 탭에서 기록하세요.'}
              />
              <div className="min-w-0 lg:border-l lg:border-border lg:pl-4">
                {selectedRunId ? (
                  <CheckMatrixRunDetailView key={selectedRunId} runId={selectedRunId} />
                ) : (
                  <p className="text-xs text-muted-foreground italic py-4">
                    왼쪽에서 실행을 고르면 단계별 진행 로그·실행된 명령·결과 상세가 여기 표시됩니다.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
