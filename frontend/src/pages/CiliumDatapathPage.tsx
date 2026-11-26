// Cilium 데이터패스 — Rust 노드 에이전트(pep-bpf-agent)가 고정 BPF 맵을 읽기 전용으로 세어 보고한 사용률·프로그램 목록.
// K8s 클러스터 허브 ▸ 진단 ▸ Cilium 데이터패스(`/k8s/:clusterId/cilium-datapath`). 아일랜드 패널로도 임베드된다.
// 「지금 수집」 은 에이전트에 작업을 보내고(long-poll) 노드별 단계 로그를 SSE 로 실시간 표시한다 — "로그 보기" 는 사용자가 정한다.
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Binary, RefreshCw } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useK8sHub } from '@/lib/k8sHub';
import { pickParam, useUrlParams } from '@/hooks/useUrlParams';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useLogPref } from '@/hooks/useLogPref';
import { streamLogged, useRunLog } from '@/hooks/useRunLog';
import { ciliumDatapathKeys, useCiliumDatapath } from '@/hooks/useCiliumDatapath';
import { ciliumDatapathApi } from '@/services/api';
import { formatRelativeTime } from '@/lib/utils';
import {
  ClusterSidebar, EmptyState, ErrorState, LoadingState, PageShell, RunLogPanel, SegTabs, SelectClusterEmptyState, useToast,
} from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/ui/button';
import { CiliumAgentsView, CiliumInstallCard, CiliumMapPressureView } from '@/components/cilium-datapath';
import type { CiliumDatapathRun } from '@/types';

const TABS = ['maps', 'agents', 'install'] as const;
type Tab = typeof TABS[number];

const RUN_STATUS: Record<CiliumDatapathRun['status'], string> = {
  running: '실행 중', succeeded: '성공', partial: '일부 노드 응답 없음', failed: '실패',
};

export function CiliumDatapathPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: clusters = [], isLoading: clustersLoading } = useClusters();
  const hub = useK8sHub();
  const [selected, setSelected] = useState('');
  const clusterId = hub ? hub.clusterId : (selected || clusters[0]?.id || '');
  const clusterName = clusters.find((c) => c.id === clusterId)?.name ?? '';
  const [params, setParams] = useUrlParams({ tab: 'maps' });
  const tab: Tab = pickParam(params.tab, TABS, 'maps');
  const setTab = (t: Tab) => setParams({ tab: t });

  const viewQ = useCiliumDatapath(clusterId);
  const view = viewQ.data;
  const { canOperate, withHint, ariaWithHint } = useCanOperate(clusterId);
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('cilium-datapath-collect');
  const abortRef = useRef<AbortController | null>(null);

  const reporting = view?.summary.reporting ?? 0;

  const collect = async () => {
    const ac = new AbortController();
    abortRef.current = ac;
    const res = await streamLogged<{ run: CiliumDatapathRun }>(runLog, {
      title: `${clusterName} BPF 맵 수집`,
      first: `수집 요청 — 보고 중인 노드 ${reporting}개에 작업 전달`,
      url: ciliumDatapathApi.collectStreamUrl(clusterId),
      body: { nodes: null },
      signal: ac.signal,
      summarize: ({ run }) => {
        const s = run.summary;
        return [[run.status === 'succeeded' ? 'info' : 'warn',
          `${RUN_STATUS[run.status]} · ${run.doneNodes.length}/${run.targetNodes.length} 노드 · 위험 ${s.critical ?? 0} · 주의 ${s.warning ?? 0}`
          + (s.missing?.length ? ` · 응답 없음 ${s.missing.join(', ')}` : '')]];
      },
    });
    abortRef.current = null;
    void qc.invalidateQueries({ queryKey: ciliumDatapathKeys.view(clusterId) });
    if (res.ok) {
      const { run } = res.data;
      if (run.status === 'succeeded') toast.success('BPF 맵 수집 완료', `${run.doneNodes.length}개 노드`);
      else toast.warning('BPF 맵 수집 — 일부 노드 응답 없음', (run.summary.missing ?? []).join(', '));
    } else if (!res.aborted) {
      toast.error('BPF 맵 수집 실패', res.error instanceof Error ? res.error.message : String(res.error));
    }
  };

  const crit = view?.summary.critical ?? 0;
  const tabs = [
    ['maps', crit ? `맵 용량 (위험 ${crit})` : '맵 용량'],
    ['agents', '프로그램·에이전트'],
    ['install', '에이전트 설치'],
  ] as const;
  const last = view?.lastRun;

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
        <ClusterSidebar clusters={clusters} selectedId={clusterId || null} onSelect={(id) => setSelected(id ?? '')} iconOnly />
        <div className="flex-1 min-w-0 space-y-4">
          <PageHeader
            icon={Binary}
            title="Cilium 데이터패스"
            description="노드마다 뜨는 pep-bpf-agent 가 Cilium 이 고정한 BPF 맵을 읽기 전용으로 열어 센 사용률과 붙어 있는 프로그램이다. 임계치를 넘으면 알람 인박스로 간다."
            titleExtra={clusterName ? (
              <span className="text-sm text-muted-foreground">— <span className="font-medium text-foreground">{clusterName}</span></span>
            ) : undefined}
            actions={(
              <div className="flex items-center gap-2">
                <Link to="/alerts" className="text-sm text-primary hover:underline">알람 인박스</Link>
                {runLog.running && (
                  <Button size="sm" variant="outline" onClick={() => abortRef.current?.abort()}
                    title="로그 따라가기 중지 — 에이전트 쪽 수집은 끝까지 진행된다">중지</Button>
                )}
                <Button size="sm" disabled={!canOperate || runLog.running || !clusterId || reporting === 0}
                  onClick={() => { void collect(); }}
                  title={withHint(reporting === 0 ? '보고 중인 에이전트가 없습니다 — 에이전트 설치 탭 참고' : '보고 중인 모든 노드에서 지금 바로 BPF 맵을 다시 센다')}
                  aria-label={ariaWithHint('지금 수집')}>
                  <RefreshCw className={runLog.running ? 'animate-spin' : ''} /> 지금 수집
                </Button>
              </div>
            )}
          />
          {clustersLoading ? (
            <LoadingState />
          ) : !clusterId ? (
            <SelectClusterEmptyState />
          ) : (
            <>
              {view && (
                <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>에이전트 <span className="font-medium text-foreground">{view.summary.reporting} / {view.summary.agents}</span> 보고 중</span>
                  <span>보고 주기 {view.settings.intervalSec}초 · 맵당 예산 {view.settings.mapBudgetMs}ms</span>
                  <span>판정 주의 {view.settings.warnPct}% · 위험 {view.settings.critPct}%{view.settings.alertsEnabled ? '' : ' (알람 꺼짐)'}</span>
                  {last && (
                    <span>
                      마지막 「지금 수집」 {last.createdAt ? formatRelativeTime(last.createdAt) : ''} · {RUN_STATUS[last.status]}
                      {last.requestedBy ? ` · ${last.requestedBy}` : ''}
                    </span>
                  )}
                </p>
              )}
              <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-72" />
              <SegTabs mode="tabs" size="md" label="Cilium 데이터패스 보기" value={tab} onChange={setTab} options={tabs} />
              {tab === 'install' ? (
                <CiliumInstallCard clusterId={clusterId} clusterName={clusterName} />
              ) : viewQ.isLoading ? (
                <LoadingState />
              ) : viewQ.isError || !view ? (
                <ErrorState error={viewQ.error} title="Cilium 데이터패스를 불러오지 못했습니다" onRetry={() => { void viewQ.refetch(); }} />
              ) : view.agents.length === 0 ? (
                <EmptyState
                  icon={Binary}
                  title="보고한 에이전트가 없습니다"
                  description={view.tokenConfigured
                    ? '이 클러스터에 pep-bpf-agent DaemonSet 을 설치하면 노드마다 맵 사용률이 나타난다.'
                    : 'backend 환경변수 CILIUM_BPF_AGENT_TOKEN 이 비어 있어 보고가 거부되고 있다. 토큰을 설정한 뒤 에이전트를 설치한다.'}
                  action={{ label: '에이전트 설치로', onClick: () => setTab('install') }}
                />
              ) : tab === 'maps' ? (
                view.columns.length === 0 ? (
                  <EmptyState icon={Binary} title="보고된 Cilium 맵이 없습니다"
                    description="에이전트는 보고 중이지만 고정 경로에서 맵을 찾지 못했다. 프로그램·에이전트 탭의 오류와 설정의 고정 경로를 확인한다."
                    action={{ label: '프로그램·에이전트 보기', onClick: () => setTab('agents') }} />
                ) : <CiliumMapPressureView view={view} clusterId={clusterId} />
              ) : (
                <CiliumAgentsView view={view} clusterId={clusterId} onInstall={() => setTab('install')} />
              )}
            </>
          )}
        </div>
      </PageShell>
    </div>
  );
}
