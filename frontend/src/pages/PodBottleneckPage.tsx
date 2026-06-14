import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Activity, Play, AlertCircle, ListTree } from 'lucide-react';
import { ClusterSidebar } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useClusters } from '@/hooks/useCluster';
import {
  useBottleneckRuns,
  useRunBottleneckAnalysis,
} from '@/hooks/usePodBottleneck';
import type { BottleneckRun, BottleneckStatus } from '@/types';

const STATUS_COLOR: Record<BottleneckStatus, string> = {
  healthy:  'border-emerald-500/40 bg-emerald-500/5',
  warning:  'border-amber-500/40 bg-amber-500/5',
  critical: 'border-red-500/40 bg-red-500/5',
  pending:  'border-slate-500/40 bg-slate-500/5',
};

const STATUS_TEXT: Record<BottleneckStatus, string> = {
  healthy: 'text-emerald-500',
  warning: 'text-amber-500',
  critical: 'text-red-500',
  pending: 'text-slate-400',
};

const STATUS_KR: Record<BottleneckStatus, string> = {
  healthy: '정상', warning: '경고', critical: '위험', pending: '미연결',
};

export function PodBottleneckPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { data: clusters = [] } = useClusters();

  // URL ?cluster=...&ns=...&src=...&dst=... — PacketFlowPage cross-link 시 prefill
  const prefillCluster = params.get('cluster') ?? '';
  const prefillNs = params.get('ns') ?? '';
  const prefillSrc = params.get('src') ?? '';
  const prefillDst = params.get('dst') ?? '';
  const prefillSvc = params.get('svc') ?? '';

  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(prefillCluster || null);
  const [namespace, setNamespace] = useState(prefillNs);
  const [sourcePod, setSourcePod] = useState(prefillSrc);
  const [destPod, setDestPod] = useState(prefillDst);
  const [destService, setDestService] = useState(prefillSvc);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // URL prefill 이 도착 후 cluster 가 바뀌면 sync
  useEffect(() => {
    if (prefillCluster && !selectedClusterId) {
      setSelectedClusterId(prefillCluster);
    }
  }, [prefillCluster, selectedClusterId]);

  const runMutation = useRunBottleneckAnalysis();

  const { data: runsData, isLoading: runsLoading, error: runsError } = useBottleneckRuns({
    clusterId: selectedClusterId ?? undefined,
    limit: 50,
  });
  const runs = useMemo(() => runsData?.data ?? [], [runsData?.data]);

  const handleRun = async () => {
    setSubmitError(null);
    if (!selectedClusterId) { setSubmitError('클러스터를 선택하세요.'); return; }
    if (!namespace.trim()) { setSubmitError('namespace 를 입력하세요.'); return; }
    if (!sourcePod.trim()) { setSubmitError('source pod 를 입력하세요.'); return; }
    if (!destPod.trim()) { setSubmitError('dest pod 를 입력하세요.'); return; }
    try {
      const { data } = await runMutation.mutateAsync({
        clusterId: selectedClusterId,
        namespace: namespace.trim(),
        sourcePod: sourcePod.trim(),
        destPod: destPod.trim(),
        destService: destService.trim() || null,
      });
      navigate(`/pod-bottleneck/${data.id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '진단 실패';
      setSubmitError(msg);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto px-4 lg:px-6 py-6 flex gap-3 max-w-[1600px]">
        <div className="sticky top-4 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={selectedClusterId}
            onSelect={setSelectedClusterId}
            allowAll
            allLabel="전체 클러스터"
            iconOnly
          />
        </div>

        <div className="flex-1 min-w-0 space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="w-9 h-9 rounded-md bg-primary/10 text-primary flex items-center justify-center">
              <Activity className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-[180px]">
              <h1 className="text-lg font-semibold">Pod 병목 진단</h1>
              <p className="text-sm text-muted-foreground">
                두 pod 사이 L4 TCP / L7 DNS / K8s endpoints 4축 통합 진단
              </p>
            </div>
          </div>

          {/* 진단 폼 */}
          <MacCard title="진단 폼">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              <FormField label="Namespace *" value={namespace} onChange={setNamespace}
                         placeholder="workbench" aria-label="namespace" />
              <FormField label="Source Pod *" value={sourcePod} onChange={setSourcePod}
                         placeholder="frontend-7f...-xyz" aria-label="source pod" mono />
              <FormField label="Dest Pod *" value={destPod} onChange={setDestPod}
                         placeholder="backend-5d...-abc" aria-label="dest pod" mono />
              <FormField label="Dest Service (옵션 — endpoints probe)" value={destService}
                         onChange={setDestService} placeholder="backend"
                         aria-label="dest service" mono className="md:col-span-2" />
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={handleRun}
                  disabled={!selectedClusterId || runMutation.isPending}
                  aria-label="병목 진단 실행"
                  className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
                >
                  <Play className="w-4 h-4" />
                  {runMutation.isPending ? '진단 중…' : '지금 진단'}
                </button>
              </div>
            </div>
            {submitError && (
              <div className="mt-3 text-sm text-red-500 bg-red-500/10 border border-red-500/30 rounded p-2">
                {submitError}
              </div>
            )}
            {!selectedClusterId && (
              <p className="mt-3 text-sm text-muted-foreground">좌측 사이드바에서 클러스터를 먼저 선택하세요.</p>
            )}
          </MacCard>

          {/* 최근 진단 결과 */}
          <MacCard title="최근 진단 결과">
            {runsError ? (
              <div className="flex items-start gap-2 text-sm text-red-500">
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-medium">진단 history 조회 실패</div>
                  <div className="text-sm text-muted-foreground">
                    {runsError instanceof Error ? runsError.message : 'API 오류'}
                  </div>
                </div>
              </div>
            ) : runsLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-12 rounded-md bg-muted/30 animate-pulse" />
                ))}
              </div>
            ) : runs.length === 0 ? (
              <div className="text-center py-10 text-sm text-muted-foreground">
                <ListTree className="w-8 h-8 mx-auto mb-2 text-muted-foreground/30" />
                <p>진단 결과가 없습니다. 위 폼에서 첫 진단을 실행하세요.</p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {runs.map((r) => (
                  <RunRow key={r.id} run={r} onClick={() => navigate(`/pod-bottleneck/${r.id}`)} />
                ))}
              </ul>
            )}
          </MacCard>
        </div>
      </main>
    </div>
  );
}

function FormField({
  label, value, onChange, placeholder, mono, className,
  'aria-label': ariaLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <label className={`block ${className ?? ''}`}>
      <span className="text-sm font-semibold text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={`mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm ${mono ? 'font-mono' : ''}`}
      />
    </label>
  );
}

function RunRow({ run, onClick }: { run: BottleneckRun; onClick: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-label={`${run.sourcePod}→${run.destPod} 진단 결과 상세`}
        className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-secondary/40 border-l-2 ${STATUS_COLOR[run.overallStatus]}`}
      >
        <span className={`text-sm font-semibold ${STATUS_TEXT[run.overallStatus]} w-12`}>
          {STATUS_KR[run.overallStatus]}
        </span>
        <span className="font-mono text-sm flex-1 truncate">
          <span className="text-muted-foreground">{run.namespace}/</span>
          {run.sourcePod}
          <span className="text-muted-foreground mx-1">→</span>
          {run.destPod}
        </span>
        <span className="text-xs text-muted-foreground">
          {new Date(run.createdAt).toLocaleString('ko-KR')}
        </span>
        <span className="text-xs font-mono text-muted-foreground">
          {run.durationMs}ms
        </span>
      </button>
    </li>
  );
}
