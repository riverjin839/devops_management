import { useEffect, useState } from 'react';
import {
  ChevronRight, Terminal, User, CalendarClock, AlertTriangle,
} from 'lucide-react';
import { LogViewer, StatusBadge, Skeleton } from '@/components/common';
import { ExecutionStepsTimeline } from '@/components/daily-check/ExecutionStepsTimeline';
import { useCheckMatrixRun, useCheckMatrixRuns, type CheckMatrixRunFilter } from '@/hooks/useCheckMatrix';
import { parseUTC } from '@/lib/utils';
import type { CheckMatrixRun } from '@/types';
import { CheckMatrixRunbookPanel } from './CheckMatrixRunbookPanel';
import { RunStateBadge, TRIGGER_LABEL } from './CheckMatrixRunBadges';

export { RunStateBadge } from './CheckMatrixRunBadges';

function RunRow({
  run, selected, showCell, onClick,
}: { run: CheckMatrixRun; selected: boolean; showCell: boolean; onClick: () => void }) {
  return (
    <li>
      <button
        onClick={onClick}
        className={`w-full text-left px-2.5 py-2 rounded-md border transition-colors ${
          selected ? 'border-primary bg-secondary' : 'border-transparent hover:bg-muted/50'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <RunStateBadge state={run.runState} />
          {run.status && <StatusBadge variant={run.status} size="sm" />}
          {(run.status === 'warning' || run.status === 'critical') && (
            <span title="완료됐지만 점검 결과가 정상이 아닙니다 — 클릭해 상세 로그에서 원인을 확인하세요." className="flex-shrink-0">
              <AlertTriangle className="w-3 h-3 text-status-warning" />
            </span>
          )}
          <span className="text-[11px] text-muted-foreground tabular-nums ml-auto flex-shrink-0">
            {parseUTC(run.queuedAt).toLocaleString('ko-KR')}
          </span>
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        </div>
        {showCell && (
          <div className="text-xs font-medium truncate mt-1">
            {run.itemName ?? '(삭제된 항목)'}
            <span className="text-muted-foreground font-normal"> · {run.clusterName ?? '(삭제된 클러스터)'}</span>
          </div>
        )}
        <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground min-w-0">
          <span className="flex-shrink-0">{TRIGGER_LABEL[run.trigger] ?? run.trigger}</span>
          {run.triggeredBy && (
            <span className="flex items-center gap-0.5 flex-shrink-0">
              <User className="w-3 h-3" />{run.triggeredBy}
            </span>
          )}
          {run.durationMs != null && (
            <span className="tabular-nums flex-shrink-0">{run.durationMs}ms</span>
          )}
          {(run.message || run.error) && (
            <span className="truncate" title={run.error || run.message || undefined}>{run.error || run.message}</span>
          )}
        </div>
      </button>
    </li>
  );
}

/** 수행 로그 목록. `showCell` 이면 항목/클러스터 이름을 함께 보여준다(전역 로그 뷰). */
export function CheckMatrixRunList({
  filter, live, showCell = false, selectedId, onSelect, emptyText = '수행 기록이 없습니다.',
}: {
  filter: CheckMatrixRunFilter;
  live?: boolean;
  showCell?: boolean;
  selectedId?: string | null;
  onSelect: (runId: string) => void;
  emptyText?: string;
}) {
  const { data, isLoading } = useCheckMatrixRuns(filter, true, live);

  if (isLoading) {
    return (
      <div className="space-y-2" aria-busy="true">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} height={44} />)}
      </div>
    );
  }
  if (!data || data.runs.length === 0) {
    return <p className="text-sm text-muted-foreground italic py-4">{emptyText}</p>;
  }
  return (
    <>
      <ul className="space-y-1">
        {data.runs.map((r) => (
          <RunRow
            key={r.id}
            run={r}
            showCell={showCell}
            selected={selectedId === r.id}
            onClick={() => onSelect(r.id)}
          />
        ))}
      </ul>
      {data.total > data.runs.length && (
        <p className="text-[11px] text-muted-foreground mt-2">
          최근 {data.runs.length}건 표시 (전체 {data.total}건)
        </p>
      )}
    </>
  );
}

function CommandTrace({
  commands,
}: {
  commands: { kind: string; command: string; exitCode?: number | null; durationMs?: number; stdout?: string; stderr?: string; truncated?: boolean }[];
}) {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <ol className="space-y-2">
      {commands.map((c, i) => {
        const failed = c.exitCode != null && c.exitCode !== 0;
        const expanded = open === i;
        return (
          <li key={i} className="rounded-md border border-border overflow-hidden">
            <button
              onClick={() => setOpen(expanded ? null : i)}
              className="w-full text-left px-2.5 py-2 bg-secondary/30 hover:bg-secondary/60 transition-colors"
            >
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1">
                <Terminal className="w-3 h-3" />
                <span>{c.kind}</span>
                <span
                  className={`tabular-nums ${failed ? 'text-status-critical font-medium' : ''}`}
                >
                  exit={c.exitCode ?? '—'}
                </span>
                {c.durationMs != null && <span className="tabular-nums">{c.durationMs}ms</span>}
                <ChevronRight
                  className={`w-3.5 h-3.5 ml-auto transition-transform ${expanded ? 'rotate-90' : ''}`}
                />
              </div>
              <code className="block text-xs font-mono break-all text-foreground/90">{c.command}</code>
            </button>
            {expanded && (
              <div className="p-2 space-y-2 border-t border-border">
                {c.stdout ? (
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">stdout</p>
                    <LogViewer text={c.stdout} maxHeight="max-h-56" collapsible />
                  </div>
                ) : null}
                {c.stderr ? (
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">stderr</p>
                    <LogViewer text={c.stderr} maxHeight="max-h-40" asError collapsible />
                  </div>
                ) : null}
                {!c.stdout && !c.stderr && (
                  <p className="text-xs text-muted-foreground italic">출력이 없습니다.</p>
                )}
                {c.truncated && (
                  <p className="text-[10px] text-muted-foreground">
                    출력이 길어 앞부분만 보관합니다.
                  </p>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** 수행 1건 상세 — 단계 타임라인, 실제 나간 명령과 출력, 그때의 실행 계획, 결과 상세. */
export function CheckMatrixRunDetailView({ runId }: { runId: string }) {
  const { data: run, isLoading } = useCheckMatrixRun(runId);
  const [showRunbook, setShowRunbook] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  // 완료했지만 결과가 위험/경고이거나 아예 실패한 수행은 "왜?"가 가장 궁금한 순간이라
  // 결과 상세(raw JSON)를 처음부터 펼쳐 보여준다. runId 가 바뀔 때만 재평가 — 폴링으로
  // 같은 run 이 갱신될 때마다 사용자가 접어둔 걸 다시 펼치지 않는다.
  useEffect(() => {
    if (run && (run.status === 'warning' || run.status === 'critical' || run.runState === 'failed')) {
      setShowRaw(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id]);

  if (isLoading) return <div className="py-6 text-sm text-muted-foreground">불러오는 중…</div>;
  if (!run) return <div className="py-6 text-sm text-muted-foreground">실행 로그를 찾을 수 없습니다.</div>;

  const rawKeys = Object.keys(run.details ?? {});
  const needsExplanation = run.status === 'warning' || run.status === 'critical' || run.runState === 'failed';

  return (
    <div className="space-y-4">
      <section className="rounded-md border border-border bg-secondary/30 p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <RunStateBadge state={run.runState} />
          {run.status && <StatusBadge variant={run.status} size="sm" />}
          <span className="text-xs text-muted-foreground">
            {TRIGGER_LABEL[run.trigger] ?? run.trigger}
          </span>
          {run.triggeredBy && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <User className="w-3 h-3" />{run.triggeredBy}
            </span>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <CalendarClock className="w-3 h-3" /> 큐잉 {parseUTC(run.queuedAt).toLocaleString('ko-KR')}
          </span>
          {run.startedAt && <span>시작 {parseUTC(run.startedAt).toLocaleString('ko-KR')}</span>}
          {run.finishedAt && <span>종료 {parseUTC(run.finishedAt).toLocaleString('ko-KR')}</span>}
          {run.durationMs != null && <span className="tabular-nums">소요 {run.durationMs}ms</span>}
        </div>
        {needsExplanation ? (
          <div className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning-soft px-2.5 py-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-status-warning" />
            <div className="min-w-0 space-y-0.5">
              {run.message && <p className="text-sm break-all">{run.message}</p>}
              {run.error && <p className="text-sm text-status-critical break-all">{run.error}</p>}
              {!run.message && !run.error && (
                <p className="text-sm text-muted-foreground italic">
                  이 수행에는 별도 사유 메시지가 없습니다 — 아래 &quot;결과 상세&quot;에서 원본 필드를 확인하세요.
                </p>
              )}
              <p className="text-[11px] text-muted-foreground">
                더 자세한 원인은 아래 &quot;결과 상세&quot;(자동으로 펼쳐짐)와, 계측됐다면 &quot;실행된 명령&quot;의 출력에서 확인할 수 있습니다.
              </p>
            </div>
          </div>
        ) : (
          <>
            {run.message && <p className="text-sm">{run.message}</p>}
            {run.error && <p className="text-sm text-status-critical break-all">{run.error}</p>}
          </>
        )}
      </section>

      {(run.steps.length > 0 || run.stepPlan.length > 0) && (
        <ExecutionStepsTimeline stepPlan={run.stepPlan} steps={run.steps} />
      )}

      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          실행된 명령
        </h3>
        {run.commands.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">
            이 수행에서 계측된 명령 기록이 없습니다 — K8s API(SDK) 호출만으로 수행된 점검이거나,
            대상이 없어 건너뛴 수행입니다. 설계상 어떤 호출이 나가는지는 아래 실행 계획에서 확인하세요.
          </p>
        ) : (
          <CommandTrace commands={run.commands} />
        )}
      </section>

      {run.runbook && (
        <section>
          <button
            onClick={() => setShowRunbook((v) => !v)}
            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showRunbook ? 'rotate-90' : ''}`} />
            이 수행 시점의 실행 계획
          </button>
          {showRunbook && (
            <div className="mt-2">
              <CheckMatrixRunbookPanel runbook={run.runbook} />
            </div>
          )}
        </section>
      )}

      {rawKeys.length > 0 && (
        <section>
          <button
            onClick={() => setShowRaw((v) => !v)}
            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showRaw ? 'rotate-90' : ''}`} />
            결과 상세 ({rawKeys.length}개 필드)
          </button>
          {showRaw && (
            <div className="mt-2">
              <LogViewer text={JSON.stringify(run.details, null, 2)} maxHeight="max-h-80" collapsible />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
