// frontend/src/components/batch-jobs/BatchJobSlideOver.RunHistory.tsx
import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { BatchJobRun } from '@/services/api';
import { LogViewer } from '@/components/common';
import { StatusPill } from './StatusPill';

interface RunHistoryProps {
  runs: BatchJobRun[];
  isLoading: boolean;
}

function formatShortDate(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19);
}

function RunDetail({ run }: { run: BatchJobRun }) {
  return (
    <div className="mt-2 space-y-2 bg-secondary/30 rounded-lg p-2">
      {run.executedCommand && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">command</p>
          <pre className="text-[10px] font-mono bg-background border border-border rounded p-2 overflow-auto whitespace-pre-wrap">
            {run.executedCommand}
          </pre>
        </div>
      )}
      <div>
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">stdout</p>
        <LogViewer text={run.stdout} maxHeight="max-h-[200px]" />
      </div>
      {run.stderr && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">stderr</p>
          <LogViewer text={run.stderr} maxHeight="max-h-[160px]" asError />
        </div>
      )}
      {run.error && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">error</p>
          <pre className="text-[10px] font-mono bg-red-500/10 border border-red-500/30 text-red-700 dark:text-red-400 rounded p-2 overflow-auto whitespace-pre-wrap">
            {run.error}
          </pre>
        </div>
      )}
    </div>
  );
}

export function RunHistory({ runs, isLoading }: RunHistoryProps) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (isLoading) {
    return <p className="text-xs text-muted-foreground py-2">이력 로딩 중…</p>;
  }
  if (runs.length === 0) {
    return <p className="text-xs text-muted-foreground py-2">아직 실행 이력이 없습니다.</p>;
  }

  const shown = runs.slice(0, 5);
  return (
    <div className="space-y-1">
      {shown.map((run) => {
        const open = openId === run.id;
        return (
          <div key={run.id} className="border border-border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setOpenId(open ? null : run.id)}
              className="w-full px-2.5 py-1.5 flex items-center gap-2 hover:bg-secondary/50 transition-colors text-left"
            >
              <StatusPill status={run.status} />
              <span className="flex-1 min-w-0 text-[11px] font-mono text-muted-foreground truncate">
                {formatShortDate(run.startedAt)}
              </span>
              <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
                {run.durationMs}ms
              </span>
              {open ? (
                <ChevronUp className="w-3 h-3 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-3 h-3 text-muted-foreground" />
              )}
            </button>
            {open && (
              <div className="px-2.5 pb-2 border-t border-border">
                <RunDetail run={run} />
              </div>
            )}
          </div>
        );
      })}
      {runs.length > 5 && (
        <p className="text-[10px] text-muted-foreground text-center pt-1">
          최근 5건만 표시 · 총 {runs.length}건
        </p>
      )}
    </div>
  );
}
