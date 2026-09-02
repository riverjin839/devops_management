// 최근 실행 이력 — 행 클릭 시 상세(단계 + 로그) 펼침.
import { useState } from 'react';
import { EmptyState, Skeleton } from '@/components/common';
import { useEffRuns } from '@/hooks/useK8sEfficiency';
import { EfficiencyRunLog, RunStatePill } from './EfficiencyRunLog';
import { RUN_TYPE_LABEL, fmtTs } from './effUtils';

export function EfficiencyRunPanel({ clusterId, onRollback, rollbackPending }: {
  clusterId: string; onRollback: (runId: string) => void; rollbackPending: boolean;
}) {
  const q = useEffRuns(clusterId);
  const [open, setOpen] = useState<string | null>(null);
  const items = q.data?.items ?? [];
  return (
    <div className="min-h-24">
      {q.isLoading && !q.data ? <Skeleton className="h-24 w-full" />
        : !items.length ? <EmptyState title="실행 이력 없음" description="수집/적용/롤백 실행이 여기 쌓입니다." />
        : (
          <div className="divide-y divide-border">
            {items.map((r) => (
              <div key={r.id}>
                <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/10 text-left">
                  <RunStatePill state={r.runState} />
                  <span className="font-medium">{RUN_TYPE_LABEL[r.runType] ?? r.runType}</span>
                  {r.dryRun && <span className="text-[11px] px-1.5 py-0.5 rounded bg-status-info/10 text-status-info">dry-run</span>}
                  <span className="text-xs text-muted-foreground">{r.trigger} · {r.triggeredBy ?? '-'}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">대상 {r.targets?.length ?? 0}</span>
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">{fmtTs(r.queuedAt)}</span>
                </button>
                {open === r.id && (
                  <div className="px-3 pb-3">
                    <EfficiencyRunLog runId={r.id} onRollback={onRollback} rollbackPending={rollbackPending} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
