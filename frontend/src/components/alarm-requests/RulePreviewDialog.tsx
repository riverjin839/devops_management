import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ErrorState, LoadingState } from '@/components/common/EmptyState';
import { LogViewer } from '@/components/common/LogViewer';
import { useAlarmRulePreview } from '@/hooks/useAlarmRequests';
import { cn } from '@/lib/utils';
import { BTN_SM } from './styles';

/** 적용하면 클러스터마다 만들어질 PrometheusRule YAML — 조회만 하고 클러스터에는 아무것도 보내지 않는다. */
export function RulePreviewDialog({ requestId, code, open, onClose }: {
  requestId: number; code: string; open: boolean; onClose: () => void;
}) {
  const q = useAlarmRulePreview(requestId, open);
  const [idx, setIdx] = useState(0);
  const items = q.data ?? [];
  const cur = items[Math.min(idx, Math.max(items.length - 1, 0))];

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{code} PrometheusRule 미리보기</DialogTitle>
          <DialogDescription>
            「클러스터에 적용」을 누르면 아래 리소스가 만들어지거나 교체됩니다. 네임스페이스·라벨은 「적용 설정」에서 바꿉니다.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 px-5 pb-5">
          {q.isLoading ? <LoadingState label="미리보기를 만드는 중" compact /> : q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} compact />
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="클러스터">
                {items.map((it, i) => (
                  <button key={it.clusterId} type="button" aria-pressed={cur?.clusterId === it.clusterId}
                    className={cn(BTN_SM, cur?.clusterId === it.clusterId && 'border-primary text-primary bg-primary/10')}
                    onClick={() => setIdx(i)}>
                    {it.clusterName}
                  </button>
                ))}
              </div>
              {cur && (
                <>
                  <p className="text-xs text-muted-foreground">
                    <span className="font-mono text-foreground">{cur.namespace}/{cur.name}</span>
                  </p>
                  <LogViewer text={cur.yaml} maxHeight="max-h-[50vh]" popoutTitle={`${code} ${cur.clusterName} PrometheusRule`} />
                </>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
