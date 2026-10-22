// 최근 실행 이력 — 행 클릭 시 상세(단계 + 로그) 펼침.
import { useState } from 'react';
import { EmptyState, ErrorState, Skeleton } from '@/components/common';
import { useEffRuns } from '@/hooks/useK8sEfficiency';
import { EfficiencyRunLog, RunStatePill } from './EfficiencyRunLog';
import { RUN_TYPE_LABEL, TRIGGER_LABEL, fmtTs } from './effUtils';

export function EfficiencyRunPanel({ clusterId, onRollback, rollbackPending }: {
  clusterId: string; onRollback: (runId: string) => void; rollbackPending: boolean;
}) {
  const q = useEffRuns(clusterId);
  const [open, setOpen] = useState<string | null>(null);
  const items = q.data?.items ?? [];
  return (
    <div className="min-h-24">
      {q.isLoading && !q.data ? <Skeleton className="h-24 w-full" />
        : q.isError && !items.length ? <ErrorState error={q.error} title="실행 이력을 불러오지 못했습니다" onRetry={() => void q.refetch()} compact />
        : !items.length ? <EmptyState compact title="실행 이력 없음" description="지금 수집 · 선택 적용 · 롤백을 실행하면 여기에 쌓이고, 행을 펼쳐 단계와 로그를 볼 수 있습니다." />
        : (
          <div className="divide-y divide-border">
            {items.map((r) => (
              <div key={r.id}>
                <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted/10 text-left">
                  <RunStatePill state={r.runState} />
                  <span className="font-medium">{RUN_TYPE_LABEL[r.runType] ?? r.runType}</span>
                  {r.dryRun && <span className="text-xs px-1.5 py-0.5 rounded bg-status-info/10 text-status-info">드라이런</span>}
                  <span className="text-xs text-muted-foreground">{TRIGGER_LABEL[r.trigger] ?? r.trigger} · {r.triggeredBy ?? '—'}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">대상 {r.targets?.length ?? 0}</span>
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">{fmtTs(r.queuedAt)}</span>
                </button>
                {open === r.id && (
                  <div className="px-3 pb-3">
                    <EfficiencyRunLog runId={r.id} onRollback={onRollback} rollbackPending={rollbackPending} embedded />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
