import { Link } from 'react-router-dom';
import { useClusterRouteParam } from '@/hooks/useClusterRouteParam';
import { ArrowLeft, ClipboardCheck, LayoutGrid, Settings } from 'lucide-react';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { useClusters } from '@/hooks/useCluster';
import { ClusterOpsCheckPanel } from '@/components/ops-check';

export function OpsCheckConsolePage() {
  const { data: clusters = [] } = useClusters();
  // 클러스터 선택은 URL(`/ops-checks/:clusterId`)에 담기지만, 아일랜드 패널로 임베드되면
  // URL 이동이 앱 전체를 아일랜드 밖으로 끌고 나가므로 로컬 state 로 대체된다.
  const { clusterId, selectCluster } = useClusterRouteParam('/ops-checks', clusters);

  const cluster = clusters.find((c) => c.id === clusterId);

  return (
    <div className="app-min-h-screen bg-background py-3 pr-3">
      <div className="flex gap-3">
        <div className="sticky top-4 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            onSelect={selectCluster}
            iconOnly
          />
        </div>

        <div className="flex-1 min-w-0 space-y-4">
          {/* header */}
          <div className="flex items-center gap-3 flex-wrap">
            <Link to="/" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted">
              <ArrowLeft className="w-3.5 h-3.5" /> 대시보드
            </Link>
            <h1 className="text-lg font-semibold flex-1 min-w-[200px]">
              {cluster ? `${cluster.name} — 운영 점검` : '운영 점검'}
            </h1>
            {clusterId && (
              <>
                <Link to={`/clusters/${clusterId}`} className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted">
                  <LayoutGrid className="w-3.5 h-3.5" /> 클러스터 상세
                </Link>
                <Link to={`/daily-check/review/${clusterId}`} className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted">
                  <ClipboardCheck className="w-3.5 h-3.5" /> 결과 리뷰
                </Link>
                <Link to="/daily-check/settings" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted">
                  <Settings className="w-3.5 h-3.5" /> 점검 항목 관리
                </Link>
              </>
            )}
          </div>

          <ClusterOpsCheckPanel clusterId={clusterId} clusterName={cluster?.name} />
        </div>
      </div>
    </div>
  );
}
