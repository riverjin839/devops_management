// frontend/src/components/batch-jobs/BatchJobLogDetail.tsx
// mc 클라이언트 콘솔(McClientPage ResultPanel)과 동일한 로그 상세 카드 패턴 —
// 상단 sticky 헤더(상태/트리거/실행자/호스트/exit/시간) + 실행 명령 + ExecOutputTabs.
// RunForm(방금 실행한 결과)과 RunHistory(과거 이력 상세)가 이 한 컴포넌트를 공유한다.
import { ExecOutputTabs } from '@/components/common';
import type { BatchJobRun } from '@/services/api';
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

interface BatchJobLogDetailProps {
  run: BatchJobRun;
  /** ExecOutputTabs 본문 높이. */
  maxHeight?: string;
  className?: string;
}

export function BatchJobLogDetail({ run, maxHeight = 'max-h-[320px]', className = '' }: BatchJobLogDetailProps) {
  const hasParams = run.paramsSnapshot && Object.keys(run.paramsSnapshot).length > 0;
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
        {run.executedCommand && (
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">command</p>
            <pre className="text-xs font-mono bg-background border border-border rounded p-2 overflow-auto whitespace-pre-wrap break-all">
              {run.executedCommand}
            </pre>
          </div>
        )}
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
