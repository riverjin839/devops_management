import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Trash2, AlertCircle } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ConfirmDialog } from '@/components/common';
import { ProbeResultCard } from '@/components/pod-bottleneck';
import {
  useBottleneckRun,
  useBottleneckProbes,
  useDeleteBottleneckRun,
} from '@/hooks/usePodBottleneck';
import type { BottleneckStatus } from '@/types';

const STATUS_BADGE: Record<BottleneckStatus, { label: string; cls: string }> = {
  healthy:  { label: '정상',  cls: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30' },
  warning:  { label: '경고',  cls: 'bg-amber-500/10 text-amber-500 border-amber-500/30' },
  critical: { label: '위험',  cls: 'bg-red-500/10 text-red-500 border-red-500/30' },
  pending:  { label: '미연결', cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30' },
};

export function PodBottleneckDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: run, isLoading, error } = useBottleneckRun(id || undefined);
  const { data: probes = [] } = useBottleneckProbes();
  const del = useDeleteBottleneckRun();

  const probeMetaMap = useMemo(
    () => Object.fromEntries(probes.map((p) => [p.probeKey, p])),
    [probes],
  );

  const doDelete = () => {
    setConfirmDelete(false);
    del.mutate(id, { onSuccess: () => navigate('/pod-bottleneck') });
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-[1400px] mx-auto space-y-3">
          <div className="h-8 w-64 bg-muted/30 animate-pulse rounded" />
          <div className="h-32 bg-muted/30 animate-pulse rounded-md" />
        </div>
      </div>
    );
  }

  if (error || !run) {
    return (
      <div className="min-h-screen bg-background p-6">
        <div className="max-w-[800px] mx-auto rounded-md border border-red-500/40 bg-red-500/5 p-4 text-sm text-red-500 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-medium">진단 결과 조회 실패</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {error instanceof Error ? error.message : '결과를 찾을 수 없습니다.'}
            </div>
            <Link to="/pod-bottleneck" className="inline-block mt-2 text-xs underline">
              진단 목록으로
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const status = STATUS_BADGE[run.overallStatus] ?? STATUS_BADGE.pending;
  // 4 axis 고정 표시 순서
  const orderedKeys: Array<keyof typeof run.probes> = ['tcp_state', 'tcp_perf', 'dns_latency', 'endpoints'];

  return (
    <div className="min-h-screen bg-background p-5">
      <div className="max-w-[1400px] mx-auto space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <Link
            to="/pod-bottleneck"
            aria-label="진단 목록으로"
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            목록
          </Link>
          <div className="flex-1 min-w-[200px]">
            <h1 className="text-lg font-semibold font-mono">
              <span className="text-muted-foreground">{run.namespace}/</span>
              {run.sourcePod}
              <span className="text-muted-foreground mx-2">→</span>
              {run.destPod}
              {run.destService && (
                <span className="text-xs text-muted-foreground ml-2">(svc: {run.destService})</span>
              )}
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {new Date(run.createdAt).toLocaleString('ko-KR')}
              {run.triggeredByUser && ` · ${run.triggeredByUser}`}
              {run.durationMs != null && ` · ${run.durationMs}ms`}
            </p>
          </div>
          <span
            className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${status.cls}`}
            aria-label={`전체 상태: ${status.label}`}
          >
            {status.label}
          </span>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            aria-label="진단 결과 삭제"
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-xs text-red-500 hover:bg-red-500/10"
          >
            <Trash2 className="w-3.5 h-3.5" />
            삭제
          </button>
        </div>

        {/* 4 Probe 결과 — grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {orderedKeys.map((k) => {
            const result = run.probes[k];
            const meta = probeMetaMap[k];
            if (!result) {
              return (
                <MacCard key={k} title={meta?.label ?? String(k)}>
                  <p className="text-xs text-muted-foreground italic">
                    이 probe 는 실행되지 않았습니다.
                  </p>
                </MacCard>
              );
            }
            return (
              <ProbeResultCard
                key={k}
                probeKey={String(k)}
                label={meta?.label ?? String(k)}
                axis={meta?.axis ?? '—'}
                result={result}
              />
            );
          })}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="진단 결과 삭제"
        description="이 병목 진단 결과를 삭제하시겠습니까? history 에서 영구 제거됩니다."
        confirmLabel="삭제"
        cancelLabel="취소"
        danger
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
