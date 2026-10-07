import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Activity, Play, AlertCircle, ListTree, Loader2, ExternalLink } from 'lucide-react';
import { ClusterSidebar, NamespaceSingleSelect, PodSingleSelect, RunLogPanel } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useClusters } from '@/hooks/useCluster';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useBottleneckRunsPaged } from '@/hooks/usePodBottleneck';
import { BOTTLENECK_STATUS_META } from '@/components/pod-bottleneck';
import { useRunLog, toRunLogLevel } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { postSse } from '@/lib/sse';
import { podBottleneckStreamUrl } from '@/services/api';
import type { BottleneckRun, BottleneckStatus } from '@/types';
import { formatApiError, parseUTC } from '@/lib/utils';

const STATUS_COLOR: Record<BottleneckStatus, string> = {
  healthy:  'border-status-healthy/40 bg-status-healthy/5',
  warning:  'border-status-warning/40 bg-status-warning/5',
  critical: 'border-status-critical/40 bg-status-critical/5',
  pending:  'border-status-unknown/40 bg-status-unknown/5',
};

const STATUS_TEXT: Record<BottleneckStatus, string> = {
  healthy: 'text-status-healthy',
  warning: 'text-status-warning',
  critical: 'text-status-critical',
  pending: 'text-status-unknown',
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

  // D-094 — prefill 은 초기 state 로만 쓴다. 예전 effect 는 "전체 클러스터"(null)를 고르면 prefill 클러스터로
  // 되돌려 그 선택지를 죽였다. 클러스터를 바꾸면 그 클러스터에 속한 namespace·pod 선택을 비운다.
  const selectCluster = (id: string | null) => {
    if (id === selectedClusterId) return;
    setSelectedClusterId(id);
    setNamespace('');
    setSourcePod('');
    setDestPod('');
    setSubmitError(null);
  };

  const qc = useQueryClient();
  const fid = useId();
  // D-089 — "지금 진단" 은 SSE 로 probe 가 끝나는 순서대로 단계·로그를 받는다.
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('pod-bottleneck');
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 화면을 떠나면 진행 중 스트림을 끊는다(연결이 끊기면 서버도 그 진단을 중단해 저장하지 않는다).
  useEffect(() => () => abortRef.current?.abort(), []);
  const { canOperate, withHint } = useCanOperate(selectedClusterId);

  const {
    data: runsData, isLoading: runsLoading, error: runsError,
    fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useBottleneckRunsPaged({ clusterId: selectedClusterId ?? undefined });
  const runs = useMemo(() => runsData?.pages.flatMap((p) => p.data) ?? [], [runsData]);
  const runsTotal = runsData?.pages[0]?.total ?? 0;
  const clusterName = useMemo(() => {
    const m = new Map(clusters.map((c) => [c.id, c.name]));
    return (id: string) => m.get(id) ?? id.slice(0, 8);
  }, [clusters]);

  const handleRun = async () => {
    setSubmitError(null);
    if (!selectedClusterId) { setSubmitError('클러스터를 선택하세요.'); return; }
    if (!namespace.trim()) { setSubmitError('namespace 를 입력하세요.'); return; }
    if (!sourcePod.trim()) { setSubmitError('source pod 를 입력하세요.'); return; }
    if (!destPod.trim()) { setSubmitError('dest pod 를 입력하세요.'); return; }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLastRunId(null);
    runLog.begin('병목 진단', '진단 요청 전송');
    // 콜백 안에서 채우므로 객체로 둔다(let 은 TS 가 null 로 좁혀 버린다).
    const out: { runId: string | null; error: string | null } = { runId: null, error: null };
    try {
      await postSse(
        podBottleneckStreamUrl,
        {
          cluster_id: selectedClusterId,
          namespace: namespace.trim(),
          source_pod: sourcePod.trim(),
          dest_pod: destPod.trim(),
          dest_service: destService.trim() || null,
        },
        (evt) => {
          if (evt.type === 'log') runLog.log(toRunLogLevel(evt.level), String(evt.message ?? ''));
          else if (evt.type === 'step') {
            const st = evt.status === 'failed' ? 'failed' : evt.status === 'done' ? 'done' : 'running';
            runLog.setStep(String(evt.name ?? ''), String(evt.label ?? evt.name ?? ''), st);
          } else if (evt.type === 'result') out.runId = String(evt.run_id ?? '') || null;
          else if (evt.type === 'error') out.error = String(evt.message ?? '진단 실패');
        },
        ac.signal,
      );
    } catch (e) {
      if (!ac.signal.aborted) out.error = e instanceof Error ? e.message : String(e);
    } finally {
      runLog.end();
      abortRef.current = null;
    }
    if (out.error) {
      runLog.log('error', out.error);
      setSubmitError(out.error);
      return;
    }
    void qc.invalidateQueries({ queryKey: ['bottleneckRuns'] });
    const runId = out.runId;
    if (runId) {
      setLastRunId(runId);
      // 로그를 접어 둔 사용자는 예전처럼 곧바로 결과 상세로 간다. 펼쳐 둔 사용자는 로그를 보고 직접 이동.
      if (!showLog) navigate(`/pod-bottleneck/${runId}`);
    }
  };

  const running = runLog.running;

  return (
    <div className="app-min-h-screen bg-background">
      <main className="pr-3 py-3 flex gap-3">
        <div className="sticky top-4 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={selectedClusterId}
            onSelect={selectCluster}
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
            {/* <form> 이라 Enter 로도 실행되고, 각 입력에 <label htmlFor> 가 연결된다(D-095) */}
            <form
              onSubmit={(e) => { e.preventDefault(); if (!running && canOperate) void handleRun(); }}
              className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3"
            >
              <div className="flex flex-col gap-1 text-sm">
                <label htmlFor={`${fid}-ns`} className="text-muted-foreground">Namespace *</label>
                <NamespaceSingleSelect
                  id={`${fid}-ns`}
                  clusterId={selectedClusterId ?? ''}
                  value={namespace}
                  onChange={(ns) => { setNamespace(ns); setSourcePod(''); setDestPod(''); }}
                />
              </div>
              <div className="flex flex-col gap-1 text-sm">
                <label htmlFor={`${fid}-src`} className="text-muted-foreground">Source Pod *</label>
                <PodSingleSelect id={`${fid}-src`} clusterId={selectedClusterId ?? ''} namespace={namespace} value={sourcePod} onChange={setSourcePod} />
              </div>
              <div className="flex flex-col gap-1 text-sm">
                <label htmlFor={`${fid}-dst`} className="text-muted-foreground">Dest Pod *</label>
                <PodSingleSelect id={`${fid}-dst`} clusterId={selectedClusterId ?? ''} namespace={namespace} value={destPod} onChange={setDestPod} />
              </div>
              <FormField label="Dest Service (옵션 — endpoints probe)" value={destService}
                         onChange={setDestService} placeholder="backend"
                         mono className="md:col-span-2" />
              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={!selectedClusterId || running || !canOperate}
                  title={withHint('병목 진단 실행')}
                  aria-label={withHint('병목 진단 실행')}
                  className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3 py-2 text-sm font-semibold hover:opacity-90 disabled:opacity-50"
                >
                  <Play className="w-4 h-4" />
                  {running ? '진단 중…' : '지금 진단'}
                </button>
              </div>
            </form>
            {submitError && (
              <div className="mt-3 text-sm text-status-critical bg-status-critical/10 border border-status-critical/30 rounded-md p-2">
                {submitError}
              </div>
            )}
            {!selectedClusterId && (
              <p className="mt-3 text-sm text-muted-foreground">좌측 사이드바에서 클러스터를 먼저 선택하세요.</p>
            )}
            <div className="mt-3">
              <RunLogPanel
                run={runLog}
                show={showLog}
                onShowChange={setShowLog}
                actions={lastRunId && !running ? (
                  <button
                    type="button"
                    onClick={() => navigate(`/pod-bottleneck/${lastRunId}`)}
                    className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded-xl border border-border bg-background hover:bg-secondary"
                  >
                    <ExternalLink className="w-3.5 h-3.5" /> 결과 상세 보기
                  </button>
                ) : null}
              />
            </div>
          </MacCard>

          {/* 최근 진단 결과 */}
          <MacCard title="최근 진단 결과">
            {runsError ? (
              <div className="flex items-start gap-2 text-sm text-status-critical">
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <div>
                  <div className="font-medium">진단 history 조회 실패</div>
                  <div className="text-sm text-muted-foreground">
                    {formatApiError(runsError, 'API 오류')}
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
              <>
                <ul className="divide-y divide-border">
                  {runs.map((r) => (
                    <RunRow
                      key={r.id}
                      run={r}
                      // 전체 클러스터 보기에서는 어느 클러스터의 진단인지 행마다 보여준다.
                      clusterLabel={selectedClusterId ? null : clusterName(r.clusterId)}
                      onClick={() => navigate(`/pod-bottleneck/${r.id}`)}
                    />
                  ))}
                </ul>
                <div className="flex items-center justify-between gap-2 pt-3 text-xs text-muted-foreground">
                  <span>{runs.length} / {runsTotal}건</span>
                  {hasNextPage && (
                    <button
                      type="button"
                      onClick={() => fetchNextPage()}
                      disabled={isFetchingNextPage}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-secondary px-3 py-1.5 text-sm text-foreground hover:bg-secondary/80 disabled:opacity-50"
                    >
                      {isFetchingNextPage && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      더 보기
                    </button>
                  )}
                </div>
              </>
            )}
          </MacCard>
        </div>
      </main>
    </div>
  );
}

function FormField({
  label, value, onChange, placeholder, mono, className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  className?: string;
}) {
  // 접근성 이름은 감싸는 <label> 의 보이는 텍스트를 그대로 쓴다(별도 aria-label 로 덮어쓰지 않는다, D-095)
  return (
    <label className={`block ${className ?? ''}`}>
      <span className="text-sm font-semibold text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm ${mono ? 'font-mono' : ''}`}
      />
    </label>
  );
}

function RunRow({ run, clusterLabel, onClick }: { run: BottleneckRun; clusterLabel: string | null; onClick: () => void }) {
  const StatusIcon = (BOTTLENECK_STATUS_META[run.overallStatus] ?? BOTTLENECK_STATUS_META.pending).icon;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-label={`${run.sourcePod}→${run.destPod} 진단 결과 상세`}
        className={`w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-secondary/40 border-l-2 ${STATUS_COLOR[run.overallStatus]}`}
      >
        <span className={`text-sm font-semibold ${STATUS_TEXT[run.overallStatus]} w-20 flex-shrink-0 inline-flex items-center gap-1`}>
          <StatusIcon className="w-3.5 h-3.5" aria-hidden />
          {STATUS_KR[run.overallStatus]}
        </span>
        {clusterLabel && (
          <span className="text-xs px-1.5 py-0.5 rounded-md bg-secondary text-muted-foreground flex-shrink-0 max-w-[10rem] truncate" title={clusterLabel}>
            {clusterLabel}
          </span>
        )}
        <span className="font-mono text-sm flex-1 truncate">
          <span className="text-muted-foreground">{run.namespace}/</span>
          {run.sourcePod}
          <span className="text-muted-foreground mx-1">→</span>
          {run.destPod}
        </span>
        <span className="text-xs text-muted-foreground">
          {parseUTC(run.createdAt).toLocaleString('ko-KR')}
        </span>
        <span className="text-xs font-mono text-muted-foreground">
          {run.durationMs != null ? `${run.durationMs}ms` : '—'}
        </span>
      </button>
    </li>
  );
}
