import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useClusterRouteParam } from '@/hooks/useClusterRouteParam';
import {
  ArrowLeft, Gauge, RefreshCw, AlertTriangle, Server, Layers, BarChart3, Sparkles,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { EmptyState, SnapshotProgressBar, ExportMenu } from '@/components/common';
import { useClusters } from '@/hooks/useCluster';
import { useAllocProgress, useForceAllocRefresh } from '@/hooks/useK8sAllocation';
import {
  SummarySection, PodCapacityStatusCards, NodesView, NamespacesView, NsRankingView, EfficiencyTab, csvCluster,
} from '@/components/k8s-allocation';

// 자동갱신 간격 옵션 (ms). false = 끔.
const AUTO_OPTIONS: { label: string; ms: number | false }[] = [
  { label: '자동갱신 끔', ms: false },
  { label: '15초', ms: 15_000 },
  { label: '30초', ms: 30_000 },
  { label: '1분', ms: 60_000 },
  { label: '5분', ms: 300_000 },
];

type ViewMode = 'nodes' | 'namespaces' | 'ns-ranking' | 'efficiency';

export function K8sAllocationPage() {
  const { data: clusters = [] } = useClusters();
  // 클러스터 선택은 URL(`/k8s-allocation/:clusterId`)에 담기지만, 아일랜드 패널로 임베드되면
  // URL 이동이 앱 전체를 아일랜드 밖으로 끌고 나가므로 로컬 state 로 대체된다.
  const { clusterId, selectCluster } = useClusterRouteParam('/k8s-allocation', clusters);
  const [view, setView] = useState<ViewMode>('nodes');
  const [autoMs, setAutoMs] = useState<number | false>(false);

  // 페이지 레벨은 진행 메타만 구독(select) — 1.5초 폴링마다 페이지 전체가 리렌더되지 않게.
  const progQ = useAllocProgress(clusterId);
  const prog = progQ.data;
  const { refresh: forceRefresh, isPending: refreshPending, isError: refreshFailed } = useForceAllocRefresh(clusterId);
  const computing = prog?.status === 'computing';
  const isFetching = progQ.isFetching || refreshPending;
  const clusterName = clusters.find((c) => c.id === clusterId)?.name;
  const contentRef = useRef<HTMLDivElement>(null);

  // 자동 갱신: 켜져 있으면(autoMs) 주기마다 강제 재집계. OFF 면 완료 결과를 그대로 유지.
  // in-flight 여부는 ref 로 읽어 effect 의존성에서 뺀다 — 의존성에 넣으면 폴링/뮤테이션
  // 상태가 바뀔 때마다 타이머가 재생성되어 주기가 밀리고 화면이 흔들린다.
  const pendingRef = useRef(false);
  pendingRef.current = refreshPending;
  useEffect(() => {
    if (!autoMs || !clusterId) return;
    const id = setInterval(() => { if (!pendingRef.current) void forceRefresh(); }, autoMs);
    return () => clearInterval(id);
  }, [autoMs, clusterId, forceRefresh]);

  return (
    <div className="app-min-h-screen bg-background py-3 pr-3">
      <div className="flex gap-3">
        <div className="sticky top-3 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            onSelect={selectCluster}
            iconOnly
          />
        </div>

        <div ref={contentRef} className="flex-1 min-w-0 space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <Link to="/cluster-overview" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
              <ArrowLeft className="w-4 h-4" /> 클러스터 현황
            </Link>
            <h1 className="text-lg font-semibold flex items-center gap-2">
              <Gauge className="w-5 h-5 text-status-warning" /> K8S 자원 관리
            </h1>
            <span className="text-sm text-muted-foreground">노드 여유 대비 request·사용량(slack) 진단</span>

            {clusterId && (
              <div className="ml-auto flex items-center gap-2" data-export-ignore>
                <ExportMenu targetRef={contentRef} filenameBase={`k8s-alloc-${csvCluster(clusterName)}`} />
                <button
                  type="button"
                  onClick={() => void forceRefresh()}
                  disabled={refreshPending}
                  title={refreshFailed ? '직전 새로고침 실패 — 다시 시도' : '새로고침'}
                  className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-border bg-card disabled:opacity-50 disabled:cursor-not-allowed min-w-[6.5rem] justify-center"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} /> 새로고침
                  {refreshFailed && <span className="text-status-critical">(실패)</span>}
                </button>
                <select
                  value={autoMs === false ? 'off' : String(autoMs)}
                  onChange={(e) => setAutoMs(e.target.value === 'off' ? false : Number(e.target.value))}
                  className="text-sm px-2 py-1 rounded-lg border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  title="자동 갱신 간격"
                  aria-label="자동 갱신 간격"
                >
                  {AUTO_OPTIONS.map((o) => (
                    <option key={o.label} value={o.ms === false ? 'off' : String(o.ms)}>{o.label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* 진행률/안내 슬롯 — 높이를 항상 확보해 두고 내용만 바꾼다(조건부 mount 로 아래
              내용이 위아래로 밀리던 흔들림 방지). 집계 중엔 진행바, 아니면 partial/stale 안내. */}
          {clusterId && (
            <div className="min-h-8" aria-live="polite">
              {computing ? (
                <SnapshotProgressBar
                  processed={prog?.processed ?? 0}
                  total={prog?.total ?? null}
                  progress={prog?.progress ?? null}
                  label="자원 누적 집계 중"
                />
              ) : (prog?.partial || prog?.stale) ? (
                <div className="flex items-center gap-1.5 text-xs text-status-warning h-8">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {prog?.partial
                    ? '일부만 집계된 잠정 결과입니다 — API 응답 지연/절단으로 재집계가 자동으로 재시도됩니다.'
                    : '재집계 중이라 직전 스냅샷을 표시하고 있습니다.'}
                </div>
              ) : null}
            </div>
          )}

          {!clusterId ? (
            <MacCard><EmptyState title="클러스터를 선택하세요" description="좌측에서 클러스터를 고르면 자원 현황이 표시됩니다." /></MacCard>
          ) : (
            <>
              <SummarySection clusterId={clusterId} />
              <PodCapacityStatusCards clusterId={clusterId} />

              <div className="inline-flex rounded-xl border border-border bg-card p-1">
                {([
                  ['nodes', '노드별 자원', <Server key="i" className="w-4 h-4" />],
                  ['namespaces', '네임스페이스별 자원', <Layers key="i" className="w-4 h-4" />],
                  ['ns-ranking', '네임스페이스 비효율 랭킹', <BarChart3 key="i" className="w-4 h-4" />],
                  ['efficiency', '효율화', <Sparkles key="i" className="w-4 h-4" />],
                ] as [ViewMode, string, ReactNode][]).map(([k, l, icon]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setView(k)}
                    className={`px-3 py-1.5 rounded-lg text-sm flex items-center gap-1.5 ${view === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {icon} {l}
                  </button>
                ))}
              </div>

              {view === 'nodes' && <NodesView clusterId={clusterId} clusterName={clusterName} />}
              {view === 'namespaces' && <NamespacesView clusterId={clusterId} clusterName={clusterName} />}
              {view === 'ns-ranking' && <NsRankingView clusterId={clusterId} />}
              {view === 'efficiency' && <EfficiencyTab clusterId={clusterId} clusterName={clusterName} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default K8sAllocationPage;
