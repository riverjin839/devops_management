import { useEffect, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { usePepArchitectureGraph, useClusterAddonGraph } from '@/hooks/useArchitecture';
import { ClusterSidebar } from '@/components/common';
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
    <div className="app-min-h-screen bg-background p-5">
      <div className="flex gap-4 max-w-[1600px] mx-auto">
        {tab === 'cluster' && (
          <div className="sticky top-4 self-start">
            <ClusterSidebar
              clusters={clusters}
              selectedId={clusterId || null}
              onSelect={(id) => setClusterId(id ?? '')}
              iconOnly
            />
          </div>
        )}

        <div className="flex-1 min-w-0 space-y-4">
          <div className="flex items-center gap-3">
            <GitBranch className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">서비스 모듈 관계도</h1>
            <span className="text-sm text-muted-foreground">
              PEP 아키텍처와 클러스터 애드온 관계를 실시간 상태와 함께 흐름으로 시각화
            </span>
          </div>

          <div className="flex items-center rounded-lg border border-border overflow-hidden text-sm w-fit">
            <TabSeg active={tab === 'pep'} onClick={() => setTab('pep')} label="PEP 아키텍처" />
            <TabSeg active={tab === 'cluster'} onClick={() => setTab('cluster')} label="클러스터 토폴로지" border />
          </div>

          {tab === 'pep' ? (
            <MacCard title="PEP 서비스 모듈 흐름" bodyPadding="p-4">
              {pep.isLoading ? (
                <EmptyState text="상태 확인 중..." />
              ) : (
                <FlowDiagram nodes={pep.nodes} edges={pep.edges} width={pep.width} height={pep.height} />
              )}
              <Legend />
            </MacCard>
          ) : (
            <MacCard
              title={selectedCluster ? `${selectedCluster.name} 애드온 관계` : '클러스터를 선택하세요'}
              bodyPadding="p-4"
            >
              {!clusterId ? (
                <EmptyState text="좌측에서 클러스터를 선택하세요." />
              ) : clusterGraph.isLoading ? (
                <EmptyState text="애드온 조회 중..." />
              ) : clusterGraph.addons.length === 0 ? (
                <EmptyState text="등록된 애드온이 없습니다." />
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
        </div>
      </div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="py-16 text-center text-sm text-muted-foreground">{text}</div>;
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
