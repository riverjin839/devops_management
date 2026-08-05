// frontend/src/components/batch-jobs/BatchJobLogDetail.tsx
// mc 클라이언트 콘솔(McClientPage ResultPanel)과 동일한 로그 상세 카드 패턴 —
// 상단 sticky 헤더(상태/트리거/실행자/호스트/exit/시간) + 단계 타임라인 + 실측 명령
// trace + ExecOutputTabs. RunForm(방금 실행한 결과)과 RunHistory(과거 이력 상세)가
// 이 한 컴포넌트를 공유한다.
import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { ExecOutputTabs } from '@/components/common';
import { ExecutionStepsTimeline } from '@/components/daily-check';
import type { BatchJobCommandTrace, BatchJobRun } from '@/services/api';
import type { DeepCheckStepPlanItem } from '@/types';
import { StatusPill } from './StatusPill';

const TRIGGER_LABEL: Record<string, string> = {
  manual: '수동 실행',
  schedule: '스케줄 실행',
  bulk: '일괄 실행',
};

function formatDateTime(iso: string): string {
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z');
  if (isNaN(d.getTime())) return iso.replace('T', ' ').slice(0, 19);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 실행자 라벨 — 수동/일괄은 사용자명, 스케줄은 "스케줄러". */
function actorLabel(run: BatchJobRun): string {
  if (run.triggeredByUsername) return run.triggeredByUsername;
  if (run.trigger === 'schedule') return '스케줄러';
  return '-';
}

/** 실측 명령 trace — 런북(설계) 대비 실제로 나간 명령을 exit/duration/출력 발췌와 함께.
 *  CheckMatrixRunLog 의 "실행된 명령" 렌더링을 소형화한 로컬 컴포넌트. */
function CommandTraceList({ commands }: { commands: BatchJobCommandTrace[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  if (commands.length === 0) return null;
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
        실행된 명령 ({commands.length})
      </p>
      <div className="space-y-1">
        {commands.map((c, i) => {
          const open = openIdx === i;
          const failed = c.exitCode !== 0 && c.exitCode !== null && c.exitCode !== undefined;
          const hasOutput = Boolean((c.stdout || '').trim() || (c.stderr || '').trim());
          return (
            <div key={i} className="border border-border rounded-lg overflow-hidden">
              <button
                type="button"
                onClick={() => hasOutput && setOpenIdx(open ? null : i)}
                className={`w-full px-2 py-1.5 flex items-center gap-2 text-left ${hasOutput ? 'hover:bg-secondary/50 cursor-pointer' : 'cursor-default'}`}
              >
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground uppercase flex-shrink-0">
                  {c.kind}
                </span>
                <code className="flex-1 min-w-0 text-xs font-mono truncate" title={c.command}>
                  {c.command}
                </code>
                <span className={`text-[10px] font-mono flex-shrink-0 ${failed ? 'text-red-500 font-semibold' : 'text-muted-foreground'}`}>
                  {c.exitCode === null || c.exitCode === undefined ? 'exit —' : `exit ${c.exitCode}`}
                </span>
                <span className="text-[10px] font-mono text-muted-foreground tabular-nums flex-shrink-0">
                  {c.durationMs}ms
                </span>
                {hasOutput && (open
                  ? <ChevronUp className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                  : <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />)}
              </button>
              {open && (
                <div className="px-2 pb-2 border-t border-border pt-2">
                  <ExecOutputTabs stdout={c.stdout || ''} stderr={c.stderr} maxHeight="max-h-[160px]" />
                  {c.truncated && (
                    <p className="mt-1 text-[10px] text-muted-foreground">… 출력이 길어 발췌만 저장됨</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface BatchJobLogDetailProps {
  run: BatchJobRun;
  /** 잡 타입의 정적 단계 계획 — 있으면 미계측 상태에서도 타임라인이 그려진다. */
  stepPlan?: DeepCheckStepPlanItem[];
  /** ExecOutputTabs 본문 높이. */
  maxHeight?: string;
  className?: string;
}

export function BatchJobLogDetail({ run, stepPlan, maxHeight = 'max-h-[320px]', className = '' }: BatchJobLogDetailProps) {
  const hasParams = run.paramsSnapshot && Object.keys(run.paramsSnapshot).length > 0;
  const steps = run.steps ?? [];
  const commands = run.commands ?? [];
  return (
    <div className={`border border-border rounded-xl overflow-hidden ${className}`}>
      <header className="px-3 py-2 border-b border-border bg-secondary/40 flex items-center gap-2 flex-wrap">
        <StatusPill status={run.status} />
        <span className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground">
          {TRIGGER_LABEL[run.trigger] ?? run.trigger}
        </span>
        <span className="text-xs text-muted-foreground">
          실행자 <span className="font-medium text-foreground">{actorLabel(run)}</span>
        </span>
        {run.host && <span className="text-xs font-mono text-muted-foreground truncate">{run.host}</span>}
        {run.exitCode !== null && run.exitCode !== undefined && (
          <span className="text-xs font-mono text-muted-foreground">exit {run.exitCode}</span>
        )}
        <span className="text-xs font-mono text-muted-foreground">{run.durationMs}ms</span>
        <span className="text-xs font-mono text-muted-foreground/70 ml-auto">{formatDateTime(run.startedAt)}</span>
      </header>
      <div className="p-2.5 space-y-2.5">
        {/* 단계별 진행 상태 — 어느 단계에서 무엇을 하다 실패했는지 한눈에 */}
        {(steps.length > 0 || (stepPlan?.length ?? 0) > 0) && (
          <ExecutionStepsTimeline stepPlan={stepPlan} steps={steps} />
        )}
        {commands.length > 0 ? (
          <CommandTraceList commands={commands} />
        ) : run.executedCommand ? (
          // 구버전 run (steps/commands 없음) fallback
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">command</p>
            <pre className="text-xs font-mono bg-background border border-border rounded p-2 overflow-auto whitespace-pre-wrap break-all">
              {run.executedCommand}
            </pre>
          </div>
        ) : null}
        <ExecOutputTabs stdout={run.stdout} stderr={run.stderr} maxHeight={maxHeight} />
        {run.error && (
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">error</p>
            <pre className="text-xs font-mono bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-400 rounded p-2 overflow-auto whitespace-pre-wrap">
              {run.error}
            </pre>
          </div>
        )}
        {hasParams && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer hover:text-foreground uppercase tracking-wider">
              실행 파라미터 (admin 감사용 스냅샷)
            </summary>
            <pre className="mt-1 font-mono bg-background border border-border rounded p-2 overflow-auto whitespace-pre-wrap">
              {JSON.stringify(run.paramsSnapshot, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
