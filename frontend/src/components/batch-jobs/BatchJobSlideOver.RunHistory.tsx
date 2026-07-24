// frontend/src/components/batch-jobs/BatchJobSlideOver.RunHistory.tsx
import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { BatchJobRun } from '@/services/api';
import { StatusPill } from './StatusPill';
import { BatchJobLogDetail } from './BatchJobLogDetail';

interface RunHistoryProps {
  runs: BatchJobRun[];
  isLoading: boolean;
}

function formatShortDate(iso: string): string {
  // Backend stores UTC without 'Z'. Append 'Z' so JS Date parses as UTC,
  // then display in browser local timezone.
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z');
  if (isNaN(d.getTime())) return iso.replace('T', ' ').slice(0, 19);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const TRIGGER_LABEL: Record<string, string> = {
  manual: '수동',
  schedule: '스케줄',
  bulk: '일괄',
};

export function RunHistory({ runs, isLoading }: RunHistoryProps) {
  const [openId, setOpenId] = useState<string | null>(null);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground py-2">이력 로딩 중…</p>;
  }
  if (runs.length === 0) {
    return <p className="text-sm text-muted-foreground py-2">아직 실행 이력이 없습니다.</p>;
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
              <span
                className="text-xs px-1.5 py-0.5 rounded bg-secondary text-muted-foreground"
                title={run.triggeredByUsername ? `실행자: ${run.triggeredByUsername}` : undefined}
              >
                {TRIGGER_LABEL[run.trigger] ?? run.trigger}
              </span>
              <span className="flex-1 min-w-0 text-xs font-mono text-muted-foreground truncate">
                {formatShortDate(run.startedAt)}
              </span>
              <span className="text-xs font-mono text-muted-foreground tabular-nums">
                {run.durationMs}ms
              </span>
              {open ? (
                <ChevronUp className="w-3 h-3 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-3 h-3 text-muted-foreground" />
              )}
            </button>
            {open && (
              <div className="px-2.5 pb-2 border-t border-border pt-2">
                <BatchJobLogDetail run={run} maxHeight="max-h-[240px]" />
              </div>
            )}
          </div>
        );
      })}
      {runs.length > 5 && (
        <p className="text-xs text-muted-foreground text-center pt-1">
          최근 5건만 표시 · 총 {runs.length}건
        </p>
      )}
    </div>
  );
}
