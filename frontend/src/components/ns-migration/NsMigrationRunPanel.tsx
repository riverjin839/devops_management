// 실행 결과 패널 — run 을 폴링해 단계 타임라인 + 실시간 로그(로그 보기 토글) + 리소스별 계획/diff 를 보여준다.
// CLAUDE.md "실행 버튼 = 상세·실시간 로그 + 로그 보기 옵션" 규칙.
import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { LogViewer } from '@/components/common';
import { ExecutionStepsTimeline } from '@/components/daily-check';
import { RunStatePill } from '@/components/k8s-allocation/EfficiencyRunLog';
import { MacCard } from '@/components/ui/MacCard';
import { useLogPref } from '@/hooks/useLogPref';
import { useNsMigRun } from '@/hooks/useNsMigration';
import { formatDateTime } from '@/lib/utils';
import type { DeepCheckExecStep, NsMigItem, NsMigRun } from '@/types';

const ACTION_LABEL: Record<NsMigItem['action'], string> = {
  create: '생성', update: '갱신', unchanged: '동일', error: '오류',
};

function timeline(run: NsMigRun) {
  const plan = run.steps.map((s) => ({ id: s.id, label: s.label }));
  const steps: DeepCheckExecStep[] = run.steps
    .filter((s) => s.status !== 'pending')
    .map((s) => ({ id: s.id, label: s.label, status: s.status as DeepCheckExecStep['status'], detail: s.detail,
      startedMs: s.startedMs, durationMs: s.durationMs }));
  return { plan, steps };
}

function ResultTable({ items }: { items: NsMigItem[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (items.length === 0) return null;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-muted-foreground border-b border-border">
          <th className="text-left font-normal px-3 py-1.5">종류</th>
          <th className="text-left font-normal px-3 py-1.5">이름</th>
          <th className="text-left font-normal px-3 py-1.5">계획</th>
          <th className="text-left font-normal px-3 py-1.5">결과</th>
        </tr>
      </thead>
      <tbody>
        {items.map((it) => {
          const key = `${it.kind}/${it.name}`;
          const expandable = !!it.diff || it.notes.length > 0 || !!it.message;
          const isOpen = open === key;
          return (
            <Fragment key={key}>
              <tr className="border-b border-border/60">
                <td className="px-3 py-1.5 text-muted-foreground">{it.kind}</td>
                <td className="px-3 py-1.5">
                  {expandable ? (
                    <button type="button" onClick={() => setOpen(isOpen ? null : key)} aria-expanded={isOpen}
                      className="inline-flex items-center gap-1 hover:underline text-left">
                      {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      {it.name}
                    </button>
                  ) : <span className="pl-[18px]">{it.name}</span>}
                </td>
                <td className="px-3 py-1.5">{ACTION_LABEL[it.action]}</td>
                <td className={`px-3 py-1.5 ${it.status === 'failed' ? 'text-status-critical' : 'text-muted-foreground'}`}>
                  {it.status === 'failed' ? '실패' : it.message || '정상'}
                </td>
              </tr>
              {isOpen && (
                <tr className="border-b border-border/60">
                  <td colSpan={4} className="px-3 py-2 space-y-2">
                    {it.message && it.status === 'failed' && (
                      <p className="text-xs text-status-critical break-all">{it.message}</p>
                    )}
                    {it.notes.length > 0 && (
                      <p className="text-xs text-muted-foreground">치환: {it.notes.join(' · ')}</p>
                    )}
                    {it.diff && <LogViewer text={it.diff} maxHeight="max-h-80" />}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

export function NsMigrationRunPanel({ runId, clusterName, onClose }: {
  runId: string;
  clusterName: (id: string) => string;
  onClose?: () => void;
}) {
  const { data: run, isLoading, isError } = useNsMigRun(runId);
  const [showLog, setShowLog] = useLogPref('ns-migration');
  const [showSkipped, setShowSkipped] = useState(false);

  if (isLoading && !run) return <MacCard title="실행 결과"><p className="text-sm text-muted-foreground">불러오는 중…</p></MacCard>;
  if (isError || !run) return <MacCard title="실행 결과"><p className="text-sm text-status-critical">실행 기록을 불러오지 못했습니다.</p></MacCard>;

  const { plan, steps } = timeline(run);
  const items = run.items?.resources ?? [];
  const skipped = run.items?.skipped ?? [];
  const s = run.summary;

  return (
    <MacCard
      title={run.mode === 'apply' ? '운영 적용' : '계획(dry-run)'}
      titleExtra={<RunStatePill state={run.runState} />}
      description={
        <span className="tabular-nums">
          {clusterName(run.sourceClusterId)}/{run.sourceNamespace} → {clusterName(run.targetClusterId)}/{run.targetNamespace}
          {' · '}{run.triggeredBy ?? '—'} · {run.queuedAt ? formatDateTime(run.queuedAt) : '-'}
          {run.durationMs > 0 && ` · ${(run.durationMs / 1000).toFixed(1)}s`}
        </span>
      }
      actions={
        <>
          <button type="button" onClick={() => setShowLog(!showLog)} aria-pressed={showLog}
            title={showLog ? '로그 숨기기' : '로그 보기'} aria-label={showLog ? '로그 숨기기' : '로그 보기'}
            className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-xl border border-border bg-card hover:bg-secondary">
            {showLog ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />} 로그 보기
          </button>
          {onClose && (
            <button type="button" onClick={onClose} title="닫기" aria-label="닫기"
              className="p-1 rounded-xl text-muted-foreground hover:bg-secondary hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </>
      }
      bodyPadding="p-0"
    >
      {run.error && <div className="px-3 py-2 text-sm text-status-critical border-b border-border">{run.error}</div>}
      <div className="px-3 py-2 border-b border-border">
        <ExecutionStepsTimeline stepPlan={plan} steps={steps} />
      </div>
      {s && (
        <div className="px-3 py-2 border-b border-border text-sm flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
          <span>생성 {s.create}</span>
          <span>갱신 {s.update}</span>
          <span className="text-muted-foreground">동일 {s.unchanged}</span>
          <span className={s.failed > 0 ? 'text-status-critical' : 'text-muted-foreground'}>실패 {s.failed}</span>
          <button type="button" onClick={() => setShowSkipped((v) => !v)} aria-expanded={showSkipped}
            className="text-muted-foreground hover:underline">제외 {s.skipped}</button>
        </div>
      )}
      {showSkipped && skipped.length > 0 && (
        <ul className="px-3 py-2 border-b border-border text-xs text-muted-foreground space-y-0.5">
          {skipped.map((k) => <li key={`${k.kind}/${k.name}`}>{k.kind}/{k.name} — {k.reason}</li>)}
        </ul>
      )}
      {showLog && (
        <div className="p-2 border-b border-border">
          <LogViewer text={run.logLines || '(아직 로그가 없습니다)'} maxHeight="max-h-72" />
        </div>
      )}
      <ResultTable items={items} />
    </MacCard>
  );
}
