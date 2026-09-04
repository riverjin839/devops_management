// 실행 로그 패널 — run 을 폴링해 단계 타임라인 + LogViewer 로 실시간 표시(CLAUDE.md "실행 버튼 = 실시간 로그").
// "로그 보기" 토글로 접고 펼칠 수 있고 선택은 localStorage 에 기억한다.
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RotateCcw, X } from 'lucide-react';
import { LogViewer } from '@/components/common';
import { ExecutionStepsTimeline } from '@/components/daily-check';
import { RoleGate } from '@/components/auth/RoleGate';
import { useEffRun } from '@/hooks/useK8sEfficiency';
import type { DeepCheckExecStep, EffRun, EffRunState } from '@/types';
import { RUN_TYPE_LABEL, fmtTs, readLogPref, writeLogPref } from './effUtils';

const STATE_META: Record<EffRunState, { label: string; cls: string }> = {
  queued: { label: '대기', cls: 'bg-muted text-muted-foreground border-border' },
  running: { label: '실행 중', cls: 'bg-status-info/10 text-status-info border-status-info/30' },
  succeeded: { label: '성공', cls: 'bg-status-healthy/10 text-status-healthy border-status-healthy/30' },
  partial: { label: '부분 성공', cls: 'bg-status-warning/10 text-status-warning border-status-warning/30' },
  failed: { label: '실패', cls: 'bg-status-critical/10 text-status-critical border-status-critical/30' },
};
const TRIGGER_LABEL: Record<EffRun['trigger'], string> = { manual: '수동', auto: '자동', rollback: '롤백', schedule: '스케줄' };

export function RunStatePill({ state }: { state: EffRunState }) {
  const m = STATE_META[state] ?? STATE_META.queued;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${m.cls}`}>
      {(state === 'running' || state === 'queued') && <Loader2 className="w-3 h-3 animate-spin" />}
      {m.label}
    </span>
  );
}

/** run.steps → ExecutionStepsTimeline 입력(pending 은 plan 에만). */
function toTimeline(run: EffRun): { plan: { id: string; label: string }[]; steps: DeepCheckExecStep[] } {
  const plan = run.steps.map((s) => ({ id: s.id, label: s.label }));
  const steps: DeepCheckExecStep[] = run.steps
    .filter((s) => s.status !== 'pending')
    .map((s) => ({ id: s.id, label: s.label, status: s.status as DeepCheckExecStep['status'], detail: s.detail,
      startedMs: s.startedMs, durationMs: s.durationMs }));
  return { plan, steps };
}

export function EfficiencyRunLog({ runId, onClose, onRollback, rollbackPending }: {
  runId: string; onClose?: () => void; onRollback?: (runId: string) => void; rollbackPending?: boolean;
}) {
  const { data: run, isLoading, isError } = useEffRun(runId);
  const [showLog, setShowLog] = useState<boolean>(() => readLogPref());
  useEffect(() => { writeLogPref(showLog); }, [showLog]);

  if (isLoading && !run) return <div className="text-sm text-muted-foreground p-3">실행 로그 불러오는 중…</div>;
  if (isError || !run) return <div className="text-sm text-status-critical p-3">실행 로그를 불러오지 못했습니다.</div>;
  const { plan, steps } = toTimeline(run);
  const canRollback = !run.dryRun && (run.runState === 'succeeded' || run.runState === 'partial')
    && run.runType !== 'collect' && run.runType !== 'recommend' && !!onRollback;

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-wrap">
        <RunStatePill state={run.runState} />
        <span className="text-sm font-medium">{RUN_TYPE_LABEL[run.runType] ?? run.runType}</span>
        <span className="text-xs text-muted-foreground">
          {TRIGGER_LABEL[run.trigger] ?? run.trigger} · {run.triggeredBy ?? '-'} · {fmtTs(run.queuedAt)}
          {run.dryRun && <span className="ml-1 px-1.5 py-0.5 rounded bg-status-info/10 text-status-info">dry-run</span>}
          {run.rollbackOf && <span className="ml-1">· 롤백 of {run.rollbackOf.slice(0, 8)}</span>}
        </span>
        {run.durationMs > 0 && <span className="text-xs text-muted-foreground tabular-nums">{(run.durationMs / 1000).toFixed(1)}s</span>}
        <div className="ml-auto flex items-center gap-2">
          {canRollback && (
            <RoleGate allow={['admin', 'operator']}>
              <button type="button" onClick={() => onRollback?.(run.id)} disabled={rollbackPending}
                title="이 실행의 before 값으로 되돌리기" aria-label="롤백"
                className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-50">
                <RotateCcw className="w-3.5 h-3.5" /> 롤백
              </button>
            </RoleGate>
          )}
          <button type="button" onClick={() => setShowLog((v) => !v)} aria-pressed={showLog}
            title={showLog ? '로그 숨기기' : '로그 보기'} aria-label={showLog ? '로그 숨기기' : '로그 보기'}
            className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-xl border border-border bg-card hover:bg-secondary">
            {showLog ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} 로그 보기
          </button>
          {onClose && (
            <button type="button" onClick={onClose} title="닫기" aria-label="닫기"
              className="p-1 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      {run.error && <div className="px-3 py-2 text-sm text-status-critical border-b border-border">{run.error}</div>}
      {plan.length > 0 && (
        <div className="px-3 py-2 border-b border-border">
          <ExecutionStepsTimeline stepPlan={plan} steps={steps} />
        </div>
      )}
      {showLog && (
        <div className="p-2">
          <LogViewer text={run.logLines || '(아직 로그가 없습니다)'} maxHeight="max-h-72" />
        </div>
      )}
    </div>
  );
}
