import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/common/PageHeader';
import { useClusterRouteParam } from '@/hooks/useClusterRouteParam';
import { ClipboardCheck, LayoutGrid, Settings } from 'lucide-react';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { PageShell } from '@/components/common/PageShell';
import { useClusters } from '@/hooks/useCluster';
import { ClusterOpsCheckPanel } from '@/components/ops-check';
import { useK8sHub } from '@/lib/k8sHub';

/**
 * 점검 항목(운영 점검 콘솔) — K8s 허브 점검 ▸ 점검 항목(`/k8s/:clusterId/checks`)으로 마운트된다.
 * 옛 `/ops-checks(/:clusterId)` 는 그 뷰로 redirect. 아일랜드 패널(`/ops-checks`)로도 단독 렌더된다.
 */
export function OpsCheckConsolePage() {
  const { data: clusters = [] } = useClusters();
  // 클러스터 선택은 URL(`/ops-checks/:clusterId`)에 담기지만, 아일랜드 패널로 임베드되면
  // URL 이동이 앱 전체를 아일랜드 밖으로 끌고 나가므로 로컬 state 로 대체된다.
  const { clusterId, selectCluster } = useClusterRouteParam('/ops-checks', clusters);

  const cluster = clusters.find((c) => c.id === clusterId);
  const hub = useK8sHub();

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" as="div" className="flex gap-3">
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
            <PageHeader
              back={{ to: '/', label: '홈' }}
              title={cluster && !hub ? `${cluster.name} — 점검 항목` : '점검 항목'}
              description='등록된 점검(심층 점검·애드온·SSH·Ansible)을 골라 실행하고 결과를 확인합니다. 클러스터 전체를 한 번에 돌리려면 개요의 「전체 점검」을 씁니다.'
              className="flex-1 min-w-[200px]"
            />
            {clusterId && (
              <>
                {!hub && (<>
                <Link to={`/k8s/${clusterId}/overview`} className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted">
                  <LayoutGrid className="w-3.5 h-3.5" /> 클러스터 상세
                </Link>
                <Link to={`/k8s/${clusterId}/review`} className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted">
                  <ClipboardCheck className="w-3.5 h-3.5" /> 결과 리뷰
                </Link>
                </>)}
                <Link to="/daily-check/settings" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted">
                  <Settings className="w-3.5 h-3.5" /> 점검 항목 관리
                </Link>
              </>
            )}
          </div>

          <ClusterOpsCheckPanel clusterId={clusterId} clusterName={cluster?.name} />
        </div>
      </PageShell>
    </div>
  );
}
