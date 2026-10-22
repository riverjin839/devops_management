import { useEffect, useRef, useState } from 'react';
import { PageHeader } from '@/components/common/PageHeader';
import { useClusterRouteParam } from '@/hooks/useClusterRouteParam';
import {
  Gauge, RefreshCw, AlertTriangle, Server, Layers, BarChart3, TrendingDown, FileBarChart,
} from 'lucide-react';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { SnapshotProgressBar, ExportMenu, SelectClusterEmptyState, PageShell, RunLogPanel } from '@/components/common';
import { useClusters } from '@/hooks/useCluster';
import {
  fetchAllocNamespaces, useAllocProgress, useForceAllocRefresh, useSoftAllocRefresh,
} from '@/hooks/useK8sAllocation';
import { useLogPref } from '@/hooks/useLogPref';
import { pollIntoRunLog, runLogged, useRunLog } from '@/hooks/useRunLog';
import { pickParam, useUrlParams } from '@/hooks/useUrlParams';
import {
  SummarySection, SummaryStrip, PodCapacityStatusCards, NodesView, NamespacesView, NsRankingView,
  EfficiencyTab, AllocDetailDialog, SegTabs, csvCluster, readSummaryDetailPref, writeSummaryDetailPref,
  allocPhaseText, allocAgeText, allocRunLines,
} from '@/components/k8s-allocation';
import type { AllocDetailTarget } from '@/components/k8s-allocation';

// NS 롤링 갱신 중인 클러스터는 자동갱신이 꺼져 있어도 이 간격으로 저장된 스냅샷을 다시 읽는다(비강제).
const ROLLING_READ_MS = 60_000;

// 자동갱신 간격 옵션 (ms). false = 끔.
const AUTO_OPTIONS: { label: string; ms: number | false }[] = [
  { label: '자동 다시 집계 끔', ms: false },
  { label: '15초', ms: 15_000 },
  { label: '30초', ms: 30_000 },
  { label: '1분', ms: 60_000 },
  { label: '5분', ms: 300_000 },
];

const VIEWS = ['nodes', 'namespaces', 'ns-ranking', 'efficiency'] as const;
type ViewMode = typeof VIEWS[number];
const VIEW_TABS = [
  ['nodes', <><Server className="w-4 h-4" aria-hidden="true" />노드별 자원</>],
  ['namespaces', <><Layers className="w-4 h-4" aria-hidden="true" />네임스페이스별 자원</>],
  ['ns-ranking', <><BarChart3 className="w-4 h-4" aria-hidden="true" />네임스페이스 비효율 랭킹</>],
  ['efficiency', <><TrendingDown className="w-4 h-4" aria-hidden="true" />효율화</>],
] as const;

const BTN = 'text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 px-2 py-1 rounded-xl border border-border bg-card';

export function K8sAllocationPage() {
  const { data: clusters = [] } = useClusters();
  // 클러스터 선택은 URL(`/k8s-allocation/:clusterId`)에 담기지만, 아일랜드 패널로 임베드되면
  // URL 이동이 앱 전체를 아일랜드 밖으로 끌고 나가므로 로컬 state 로 대체된다.
  const { clusterId, selectCluster } = useClusterRouteParam('/k8s-allocation', clusters);
  // 탭·"문제 노드만" 은 URL 쿼리(§12.13) — 새로고침·링크 공유·상세에서 돌아와도 그대로 남는다.
  const [params, setParams] = useUrlParams({ tab: 'nodes', problems: '' });
  const view = pickParam<ViewMode>(params.tab, VIEWS, 'nodes');
  const setView = (v: ViewMode) => setParams({ tab: v });
  const problemsOnly = params.problems === '1';
  const setProblemsOnly = (v: boolean) => setParams({ problems: v ? '1' : null });
  const [autoMs, setAutoMs] = useState<number | false>(false);
  // 요약은 압축 스트립이 기본 — 큰 카드는 선택적으로만 펼친다(탭을 화면 위쪽에 두기 위함).
  const [summaryDetail, setSummaryDetail] = useState<boolean>(() => readSummaryDetailPref());
  const setSummaryDetailPersist = (v: boolean) => { writeSummaryDetailPref(v); setSummaryDetail(v); };
  // 노드/네임스페이스 클릭 → 대상의 실제 리소스(워크로드·Pod·컨테이너) 할당 vs 사용 상세.
  // 세 탭이 같은 다이얼로그를 열도록 상태를 페이지에 둔다.
  const [detailTarget, setDetailTarget] = useState<AllocDetailTarget>(null);

  // 페이지 레벨은 진행 메타만 구독(select) — 1.5초 폴링마다 페이지 전체가 리렌더되지 않게.
  const progQ = useAllocProgress(clusterId);
  const prog = progQ.data;
  const { refresh: forceRefresh, run: forceRun, isPending: refreshPending, isError: refreshFailed } = useForceAllocRefresh(clusterId);
  const computing = prog?.status === 'computing';
  const phaseText = allocPhaseText(prog?.phase, prog?.processed);
  const failedNs = prog?.failedNamespaces ?? [];
  const rolling = !!prog?.rolling;
  const softRefresh = useSoftAllocRefresh(clusterId);
  const isFetching = progQ.isFetching || refreshPending;
  const clusterName = clusters.find((c) => c.id === clusterId)?.name;
  const contentRef = useRef<HTMLDivElement>(null);

  // "다시 집계" 실행 로그(§12.9.1) — 요청 → 집계 진행(단계·Pod 처리 수) → 완료 요약·실패 NS 를 한 줄씩.
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('k8s-allocation');
  const pollAbort = useRef<AbortController | null>(null);
  useEffect(() => () => pollAbort.current?.abort(), []);
  useEffect(() => { pollAbort.current?.abort(); }, [clusterId]);
  const reaggregate = async () => {
    if (!clusterId || refreshPending) return;
    pollAbort.current?.abort();
    const ac = new AbortController();
    pollAbort.current = ac;
    const target = clusterName ?? clusterId;
    const r = await runLogged(runLog, {
      title: `자원 다시 집계 · ${target}`,
      first: '네임스페이스·노드·Pod 집계 요청 전송',
      keepOpen: true,
      fn: () => forceRun(),
      summarize: (d) => [['info', `노드 ${d.n.items.length}개 응답`], ...allocRunLines(d.ns)],
    });
    if (!r.ok) return;
    if (r.data.ns.status !== 'computing') { r.run.end(); return; }
    // 대형 클러스터는 백그라운드에서 수 분 누적 집계한다 — 끝날 때까지 진행을 이어 쓴다.
    await pollIntoRunLog(r.run, {
      fetch: () => fetchAllocNamespaces(clusterId),
      describe: (s, p) => allocRunLines(s, p),
      isDone: (s) => s.status !== 'computing',
      intervalMs: 3000,
      timeoutMs: 600_000,
      signal: ac.signal,
    });
    softRefresh();
  };

  // 자동 갱신: 켜져 있으면(autoMs) 주기마다 강제 재집계. OFF 면 완료 결과를 그대로 유지.
  // NS 롤링 갱신 중이면 Celery 가 스냅샷을 계속 게시하므로 재집계 대신 저장된 결과만 다시 읽고,
  // 자동갱신이 꺼져 있어도 ROLLING_READ_MS 주기로 읽어 준실시간을 유지한다.
  // 타이머 실행은 사용자가 누른 실행이 아니라 실행 로그를 남기지 않는다(§12.9.1 예외 ④).
  // in-flight 여부는 ref 로 읽어 effect 의존성에서 뺀다 — 의존성에 넣으면 폴링/뮤테이션
  // 상태가 바뀔 때마다 타이머가 재생성되어 주기가 밀리고 화면이 흔들린다.
  const pendingRef = useRef(false);
  pendingRef.current = refreshPending;
  useEffect(() => {
    const ms = autoMs || (rolling ? ROLLING_READ_MS : false);
    if (!ms || !clusterId) return;
    const id = setInterval(() => {
      if (pendingRef.current) return;
      if (rolling) softRefresh();
      else void forceRefresh();
    }, ms);
    return () => clearInterval(id);
  }, [autoMs, clusterId, forceRefresh, rolling, softRefresh]);

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
        <div className="sticky top-2 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            onSelect={selectCluster}
            iconOnly
          />
        </div>

        <div ref={contentRef} className="flex-1 min-w-0 space-y-1.5">
          <div className="flex items-center gap-3 flex-wrap">
            <PageHeader
              back={{ to: '/cluster-overview', label: '클러스터 현황' }}
              icon={Gauge}
              title="K8s 자원 관리"
              description="노드 여유 대비 request·사용량(slack) 진단"
            />

            {clusterId && (
              <div className="ml-auto flex items-center gap-2" data-export-ignore>
                <a
                  href={`/daily-report?c=${clusterId}`}
                  target="_blank"
                  rel="noreferrer"
                  title="로그인 없이 볼 수 있는 일일 리포트(새 창)"
                  className={BTN}
                >
                  <FileBarChart className="w-3.5 h-3.5" aria-hidden="true" /> 일일 리포트
                </a>
                <ExportMenu targetRef={contentRef} filenameBase={`k8s-alloc-${csvCluster(clusterName)}`} />
                <button
                  type="button"
                  onClick={() => void reaggregate()}
                  disabled={refreshPending}
                  title={refreshFailed ? '직전 집계 실패 — 다시 시도' : '클러스터에서 노드·네임스페이스·Pod 를 다시 모읍니다(대형 클러스터는 수 분)'}
                  className={`${BTN} disabled:opacity-50 disabled:cursor-not-allowed min-w-[6.5rem] justify-center`}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} aria-hidden="true" /> 다시 집계
                  {refreshFailed && <span className="text-status-critical">(실패)</span>}
                </button>
                <select
                  value={autoMs === false ? 'off' : String(autoMs)}
                  onChange={(e) => setAutoMs(e.target.value === 'off' ? false : Number(e.target.value))}
                  className="text-sm px-2 py-1 rounded-xl border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  title="자동 다시 집계 간격"
                  aria-label="자동 다시 집계 간격"
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
            <div aria-live="polite">
              {computing ? (
                <SnapshotProgressBar
                  processed={prog?.processed ?? 0}
                  total={prog?.total ?? null}
                  progress={prog?.progress ?? null}
                  label={phaseText ? `자원 누적 집계 중 · ${phaseText}` : '자원 누적 집계 중'}
                />
              ) : (prog?.partial || prog?.stale) ? (
                <div className="flex items-center gap-1.5 text-xs text-status-warning py-1">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  {failedNs.length
                    ? `네임스페이스 ${failedNs.length}개의 수집이 실패·절단되어 그 값이 빠진 잠정 결과입니다 — ${failedNs.slice(0, 5).join(', ')}${failedNs.length > 5 ? ` 외 ${failedNs.length - 5}개` : ''}. '다시 집계'로 다시 모을 수 있습니다.`
                    : prog?.partial
                      ? '일부만 집계된 잠정 결과입니다 — API 응답 지연/절단으로 재집계가 자동으로 재시도됩니다.'
                      : '재집계 중이라 직전 스냅샷을 표시하고 있습니다.'}
                </div>
              ) : rolling ? (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground py-1">
                  <RefreshCw className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  {`NS 롤링 갱신 중 — 백그라운드가 오래된 네임스페이스부터 계속 다시 모으고 화면은 1분마다 읽습니다${
                    allocAgeText(prog?.nsOldestAt) ? ` · 가장 오래된 NS 데이터 ${allocAgeText(prog?.nsOldestAt)}` : ''}.`}
                </div>
              ) : null}
            </div>
          )}

          {clusterId && <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} />}

          {!clusterId ? (
            <SelectClusterEmptyState description="좌측에서 클러스터를 고르면 자원 현황이 표시됩니다." />
          ) : (
            <>
              <SummaryStrip
                clusterId={clusterId}
                expanded={summaryDetail}
                onToggle={() => setSummaryDetailPersist(!summaryDetail)}
                onShowProblemNodes={() => setParams({ tab: 'nodes', problems: '1' })}
                onShowPodStatus={() => setSummaryDetailPersist(true)}
                onShowNoRequest={() => setView('namespaces')}
              />
              {summaryDetail && (
                <>
                  <SummarySection clusterId={clusterId} />
                  <PodCapacityStatusCards clusterId={clusterId} />
                </>
              )}

              {/* 탭 바는 sticky — 긴 표를 스크롤해도 화면 전환이 항상 손 닿는 곳에 남는다. ←/→ 로 탭 이동. */}
              <div className="sticky top-0 z-20 py-1 bg-background" data-export-ignore>
                <SegTabs<ViewMode> mode="tabs" size="md" label="자원 보기" value={view} onChange={setView}
                  options={VIEW_TABS} />
              </div>

              {view === 'nodes' && (
                <NodesView clusterId={clusterId} clusterName={clusterName} onOpenDetail={setDetailTarget}
                  problemsOnly={problemsOnly} onProblemsOnly={setProblemsOnly} />
              )}
              {view === 'namespaces' && <NamespacesView clusterId={clusterId} clusterName={clusterName} onOpenDetail={setDetailTarget} />}
              {view === 'ns-ranking' && <NsRankingView clusterId={clusterId} onOpenDetail={setDetailTarget} />}
              {view === 'efficiency' && <EfficiencyTab clusterId={clusterId} clusterName={clusterName} />}

              <AllocDetailDialog
                clusterId={clusterId}
                target={detailTarget}
                clusterName={clusterName}
                onClose={() => setDetailTarget(null)}
              />
            </>
          )}
        </div>
      </PageShell>
    </div>
  );
}

export default K8sAllocationPage;
