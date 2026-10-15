import { useEffect, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { usePepArchitectureGraph, useClusterAddonGraph } from '@/hooks/useArchitecture';
import { ClusterSidebar, EmptyState, SelectClusterEmptyState, LoadingState, PageHeader, PageShell } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { FlowDiagram, STATUS_COLOR } from '@/components/architecture';
import { statusToVariant, type StatusVariant } from '@/components/common/StatusBadge';

type Tab = 'pep' | 'cluster';

export function ArchitecturePage() {
  const [tab, setTab] = useState<Tab>('pep');
  const { data: clusters = [] } = useClusters();
  const [clusterId, setClusterId] = useState('');

  useEffect(() => {
    if (!clusterId && clusters.length > 0) setClusterId(clusters[0].id);
  }, [clusters, clusterId]);

  const pep = usePepArchitectureGraph();
  const selectedCluster = clusters.find((c) => c.id === clusterId);
  const clusterGraph = useClusterAddonGraph(
    clusterId,
    selectedCluster?.name ?? '',
    statusToVariant(selectedCluster?.status),
  );

  return (
    <div className="app-min-h-screen bg-background flex">
      {tab === 'cluster' && (
        <ClusterSidebar
          clusters={clusters}
          selectedId={clusterId || null}
          onSelect={(id) => setClusterId(id ?? '')}
          iconOnly
        />
      )}

      {/* D-123: 클러스터 탭에서 ClusterSidebar 가 붙으므로 console 밀도 — PEP 탭은 사이드바 없음 → pl-3 */}
      <PageShell density="console" sidebar={tab === 'cluster'} className="space-y-4">
        <PageHeader
          icon={GitBranch}
          title="서비스 모듈 관계도"
          description="PEP 아키텍처와 클러스터 애드온 관계를 실시간 상태와 함께 흐름으로 보여 줍니다."
        />

        <div className="flex items-center rounded-lg border border-border overflow-hidden text-sm w-fit">
          <TabSeg active={tab === 'pep'} onClick={() => setTab('pep')} label="PEP 아키텍처" />
          <TabSeg active={tab === 'cluster'} onClick={() => setTab('cluster')} label="클러스터 토폴로지" border />
        </div>

        {tab === 'pep' ? (
          <MacCard title="PEP 서비스 모듈 흐름" bodyPadding="p-4">
            {pep.isLoading ? (
              <LoadingState />
            ) : (
              <FlowDiagram nodes={pep.nodes} edges={pep.edges} width={pep.width} height={pep.height} />
            )}
            <Legend />
          </MacCard>
        ) : (
          <MacCard
            title={selectedCluster ? `${selectedCluster.name} 애드온 관계` : '클러스터 애드온 관계'}
            bodyPadding="p-4"
          >
            {!clusterId ? (
              <SelectClusterEmptyState />
            ) : clusterGraph.isLoading ? (
              <LoadingState />
            ) : clusterGraph.addons.length === 0 ? (
              <EmptyState title="등록된 애드온이 없습니다." description="클러스터 관리에서 애드온을 등록하면 관계도가 그려집니다." />
            ) : (
              <FlowDiagram
                nodes={clusterGraph.nodes}
                edges={clusterGraph.edges}
                width={clusterGraph.width}
                height={clusterGraph.height}
              />
            )}
            <Legend />
          </MacCard>
        )}
      </PageShell>
    </div>
  );
}

function TabSeg({ active, onClick, label, border }: { active: boolean; onClick: () => void; label: string; border?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 transition-colors ${border ? 'border-l border-border' : ''} ${
        active ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground'
      }`}
    >
      {label}
    </button>
  );
}

const LEGEND_ITEMS: { variant: StatusVariant; label: string }[] = [
  { variant: 'healthy', label: '정상' },
  { variant: 'warning', label: '경고' },
  { variant: 'critical', label: '위험' },
  { variant: 'neutral', label: '라이브 상태 미지원 (구조만 표시)' },
];

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 pt-3 border-t border-border text-xs text-muted-foreground">
      {LEGEND_ITEMS.map((item) => (
        <span key={item.variant} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: STATUS_COLOR[item.variant] }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}
