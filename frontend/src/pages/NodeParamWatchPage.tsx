// OS 파라미터 감시 — 노드 에이전트(DaemonSet)가 보고한 sysctl 값의 변경·기준값 위반·영구 설정 불일치.
// K8s 클러스터 허브 ▸ 점검 ▸ OS 파라미터 감시(`/k8s/:clusterId/os-param-watch`). 아일랜드 패널로도 임베드된다.
// 실행 버튼이 없는 조회·설정 화면이다 — 값 수집은 에이전트가, 알람은 백엔드가 한다(알람 인박스로 간다).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useK8sHub } from '@/lib/k8sHub';
import { useNodeParamChanges, useNodeParamNodes, useNodeParamRules } from '@/hooks/useNodeParamWatch';
import {
  ClusterSidebar, ErrorState, LoadingState, PageShell, SegTabs, SelectClusterEmptyState,
} from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import {
  NodeParamChangesCard, NodeParamInstallCard, NodeParamNodesCard, NodeParamRulesCard,
} from '@/components/node-param-watch';

type Tab = 'nodes' | 'changes' | 'rules' | 'install';

export function NodeParamWatchPage() {
  const { data: clusters = [], isLoading: clustersLoading } = useClusters();
  const hub = useK8sHub();
  const [selected, setSelected] = useState('');
  const clusterId = hub ? hub.clusterId : (selected || clusters[0]?.id || '');
  const clusterName = clusters.find((c) => c.id === clusterId)?.name ?? '';
  const [tab, setTab] = useState<Tab>('nodes');

  const nodesQ = useNodeParamNodes(clusterId);
  const changesQ = useNodeParamChanges(clusterId);
  const rulesQ = useNodeParamRules(clusterId);

  const nodes = nodesQ.data?.nodes ?? [];
  const problems = nodes.filter((n) => n.violationCount + n.mismatchCount > 0 || n.state === 'offline' || n.state === 'late').length;

  const tabs = [
    ['nodes', problems ? `노드 상태 (문제 ${problems})` : '노드 상태'],
    ['changes', '변경 이력'],
    ['rules', '감시 규칙'],
    ['install', '에이전트 설치'],
  ] as const;

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
        <ClusterSidebar clusters={clusters} selectedId={clusterId || null} onSelect={(id) => setSelected(id ?? '')} iconOnly />
        <div className="flex-1 min-w-0 space-y-4">
          <PageHeader
            icon={ShieldCheck}
            title="OS 파라미터 감시"
            description="노드 에이전트가 보고한 커널 파라미터의 변경·기준값 위반·영구 설정 불일치를 보여준다. 알람은 알람 인박스로 간다."
            titleExtra={clusterName ? (
              <span className="text-sm text-muted-foreground">— <span className="font-medium text-foreground">{clusterName}</span></span>
            ) : undefined}
            actions={<Link to="/alerts" className="text-sm text-primary hover:underline">알람 인박스</Link>}
          />
          {clustersLoading ? (
            <LoadingState />
          ) : !clusterId ? (
            <SelectClusterEmptyState />
          ) : (
            <>
              <SegTabs mode="tabs" size="md" label="OS 파라미터 감시 보기" value={tab} onChange={setTab} options={tabs} />
              {tab === 'nodes' && (
                nodesQ.isLoading ? <LoadingState />
                  : nodesQ.isError ? <ErrorState error={nodesQ.error} title="노드 상태를 불러오지 못했습니다" onRetry={() => { void nodesQ.refetch(); }} />
                    : <NodeParamNodesCard clusterId={clusterId} nodes={nodes} intervalSec={nodesQ.data?.intervalSec ?? 60} onShowInstall={() => setTab('install')} />
              )}
              {tab === 'changes' && (
                changesQ.isLoading ? <LoadingState />
                  : changesQ.isError ? <ErrorState error={changesQ.error} title="변경 이력을 불러오지 못했습니다" onRetry={() => { void changesQ.refetch(); }} />
                    : <NodeParamChangesCard changes={changesQ.data ?? []} />
              )}
              {tab === 'rules' && (
                rulesQ.isLoading ? <LoadingState />
                  : rulesQ.isError ? <ErrorState error={rulesQ.error} title="감시 규칙을 불러오지 못했습니다" onRetry={() => { void rulesQ.refetch(); }} />
                    : <NodeParamRulesCard clusterId={clusterId} clusterName={clusterName} rules={rulesQ.data?.items ?? []} />
              )}
              {tab === 'install' && <NodeParamInstallCard clusterId={clusterId} clusterName={clusterName} />}
            </>
          )}
        </div>
      </PageShell>
    </div>
  );
}
