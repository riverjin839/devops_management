// 실행 로그 패널 — run 을 폴링해 단계 타임라인 + LogViewer 로 실시간 표시(CLAUDE.md "실행 버튼 = 실시간 로그").
// "로그 보기" 토글로 접고 펼칠 수 있고 선택은 localStorage 에 기억한다.
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, RotateCcw, X } from 'lucide-react';
import { ConfirmDialog, ErrorState, LoadingState, LogViewer } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { ExecutionStepsTimeline } from '@/components/daily-check';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useEffRun } from '@/hooks/useK8sEfficiency';
import type { DeepCheckExecStep, EffRun, EffRunState } from '@/types';
import { RUN_TYPE_LABEL, TRIGGER_LABEL, fmtTs, readLogPref, writeLogPref } from './effUtils';

const STATE_META: Record<EffRunState, { label: string; cls: string }> = {
  queued: { label: '대기', cls: 'bg-muted text-muted-foreground border-border' },
  running: { label: '실행 중', cls: 'bg-status-info/10 text-status-info border-status-info/30' },
  succeeded: { label: '성공', cls: 'bg-secondary text-muted-foreground border-border' },
  partial: { label: '부분 성공', cls: 'bg-status-warning/10 text-status-warning border-status-warning/30' },
  failed: { label: '실패', cls: 'bg-status-critical/10 text-status-critical border-status-critical/30' },
  skipped: { label: '건너뜀', cls: 'bg-muted text-muted-foreground border-border' },
};

export function RunStatePill({ state }: { state: EffRunState }) {
  const m = STATE_META[state] ?? STATE_META.queued;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border ${m.cls}`}>
      {(state === 'running' || state === 'queued') && <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />}
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

const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
const resText = (v: unknown): string => {
  if (!v || typeof v !== 'object') return '—';
  const o = v as Record<string, unknown>;
  const parts = [o.cpu != null ? `CPU ${str(o.cpu)}` : '', o.memory != null ? `MEM ${str(o.memory)}` : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : '—';
};

/** 롤백 확인 창의 대상 한 줄 — 백엔드 `rollback_targets` 와 같은 짝(targets[i] ↔ before[i])으로 읽는다. */
function rollbackRows(run: EffRun): { key: string; label: string; now: string; restore: string }[] {
  const before: Record<string, unknown> = run.before ?? {};
  return run.targets.flatMap((t, i) => {
    const b = before[String(i)];
    if (!b || typeof b !== 'object') return [];
    const bo = b as Record<string, unknown>;
    if (t.type === 'workload') {
      return [{
        key: String(i),
        label: `${str(t.kind)}/${str(t.namespace)}/${str(t.name)}:${str(t.container)}`,
        now: resText(t.requests), restore: resText(bo.requests),
      }];
    }
    return [{ key: String(i), label: `${str(t.type)} ${str(t.namespace)}/${str(t.name)}`, now: '현재 값', restore: '이전 값' }];
  });
}

export function EfficiencyRunLog({ runId, onClose, onRollback, rollbackPending, embedded = false }: {
  runId: string; onClose?: () => void; onRollback?: (runId: string) => void; rollbackPending?: boolean;
  /** 다른 카드(실행 이력) 안에 펼칠 때 — 카드 안 카드가 되지 않게 비카드 면으로 그린다(D-122). */
  embedded?: boolean;
}) {
  const { data: run, isLoading, isError, error, refetch } = useEffRun(runId);
  const { canOperate, withHint, ariaWithHint } = useCanOperate(run?.clusterId);
  const [showLog, setShowLog] = useState<boolean>(() => readLogPref());
  const [confirmRollback, setConfirmRollback] = useState(false);
  useEffect(() => { writeLogPref(showLog); }, [showLog]);

  if (isLoading && !run) return <LoadingState label="실행 로그 불러오는 중…" compact />;
  if (isError || !run) return <ErrorState error={error} title="실행 로그를 불러오지 못했습니다" onRetry={() => void refetch()} compact />;
  const { plan, steps } = toTimeline(run);
  const canRollback = !run.dryRun && (run.runState === 'succeeded' || run.runState === 'partial')
    && run.runType !== 'collect' && run.runType !== 'recommend' && !!onRollback;

  const title = RUN_TYPE_LABEL[run.runType] ?? run.runType;
  const meta = (
    <>
      <span className="text-xs text-muted-foreground">
        {TRIGGER_LABEL[run.trigger] ?? run.trigger} · {run.triggeredBy ?? '—'} · {fmtTs(run.queuedAt)}
        {run.dryRun && <span className="ml-1 px-1.5 py-0.5 rounded bg-status-info/10 text-status-info">드라이런</span>}
        {run.rollbackOf && <span className="ml-1">· 실행 {run.rollbackOf.slice(0, 8)} 의 롤백</span>}
      </span>
      {run.durationMs > 0 && <span className="text-xs text-muted-foreground tabular-nums">{(run.durationMs / 1000).toFixed(1)}초</span>}
    </>
  );
  const rows = canRollback ? rollbackRows(run) : [];
  const actions = (
    <>
      {canRollback && (
        <button type="button" onClick={() => setConfirmRollback(true)} disabled={rollbackPending || !canOperate}
          title={withHint('이 실행의 이전 값으로 되돌리기')} aria-label={ariaWithHint('롤백')}
          className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-50">
          <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> 롤백
        </button>
      )}
      <button type="button" onClick={() => setShowLog((v) => !v)} aria-pressed={showLog}
        title={showLog ? '로그 숨기기' : '로그 보기'} aria-label={showLog ? '로그 숨기기' : '로그 보기'}
        className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-xl border border-border bg-card hover:bg-secondary">
        {showLog ? <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />} 로그 보기
      </button>
      {onClose && (
        <button type="button" onClick={onClose} title="닫기" aria-label="닫기"
          className="p-1 rounded-xl text-muted-foreground hover:bg-secondary hover:text-foreground">
          <X className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      )}
    </>
  );
  const body = (
    <>
      {run.error && <div className="px-3 py-2 text-sm text-status-critical border-b border-border" role="alert">{run.error}</div>}
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
    </>
  );
  const dialog = confirmRollback && (
    <ConfirmDialog open danger title={`롤백 — ${title}`} confirmLabel="롤백 실행" busy={rollbackPending}
      description="아래 대상을 이 실행 전 값으로 다시 패치합니다. 워크로드는 롤링 재시작이 발생할 수 있습니다. 롤백도 새 실행으로 기록되고 실시간 로그가 남습니다."
      onCancel={() => setConfirmRollback(false)}
      onConfirm={() => { setConfirmRollback(false); onRollback?.(run.id); }}>
      {rows.length > 0 ? (
        <div className="max-h-56 overflow-auto rounded-lg border border-border text-xs">
          {rows.map((r) => (
            <div key={r.key} className="px-2 py-1.5 border-b border-border/60 last:border-b-0">
              <div className="font-mono truncate" title={r.label}>{r.label}</div>
              <div className="text-muted-foreground tabular-nums">
                <span className="line-through">{r.now}</span> → <b className="text-foreground">{r.restore}</b>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">되돌릴 이전 값이 기록되지 않은 실행입니다. 롤백해도 바뀌는 대상이 없을 수 있습니다.</p>
      )}
    </ConfirmDialog>
  );

  if (embedded) {
    return (
      <div className="rounded-md border border-border bg-secondary/40">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-wrap">
          <RunStatePill state={run.runState} />
          <span className="text-sm font-medium">{title}</span>
          {meta}
          <div className="ml-auto flex items-center gap-2">{actions}</div>
        </div>
        {body}
        {dialog}
      </div>
    );
  }

  return (
    <MacCard
      title={title}
      titleExtra={<><RunStatePill state={run.runState} />{meta}</>}
      actions={actions}
      bodyPadding="p-0"
    >
      {body}
      {dialog}
    </MacCard>
  );
}
