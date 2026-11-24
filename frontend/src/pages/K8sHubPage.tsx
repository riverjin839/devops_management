import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Lock, ShipWheel } from 'lucide-react';
import { PageHeader, PageShell, EmptyState, ErrorState, LoadingState, SelectClusterEmptyState, StatusBadge, statusToVariant } from '@/components/common';
import { HubTabs, HubClusterSwitcher, HUB_VIEWS, DEFAULT_HUB_VIEW, findHubView, hubViewAllowed } from '@/components/k8s-hub';
import { useClusters } from '@/hooks/useCluster';
import { useNavCatalog } from '@/hooks/useNavCatalog';
import { K8sHubContext, type K8sHubEmbed } from '@/lib/k8sHub';

/**
 * K8s 클러스터 허브 — `/k8s/:clusterId/:view?`.
 *
 * 클러스터 선택은 사이드바 레일 "K8s 클러스터" flyout 과 헤더 「클러스터 전환」(`HubClusterSwitcher`)이 맡는다 —
 * 2026-11-23(D-243)에 허브 안의 클러스터 레일(`ClusterSidebar`)을 없앴다(같은 목록이 두 군데 보이던 중복).
 *
 * 흩어져 있던 per-cluster K8s 화면(클러스터 상세·K8s 상세 관리·자원 관리·추이·관측 지표·이벤트·
 * 파드 로그·AI 장애 분석·점검 결과 리뷰)을 **클러스터 레일 하나 + 카테고리 탭**으로 모은다.
 * 클러스터를 한 번 고르면 뷰를 바꿔도 유지되고(URL 이 들고 있다), 옛 URL 은 App.tsx 에서 해당 뷰로
 * 리다이렉트된다. 서브뷰는 기존 페이지 컴포넌트를 그대로 마운트한다 — 레일·h1·`<main>` 은 허브가
 * 하나만 그리고, 페이지 쪽 레일/헤더/셸은 `K8sHubContext`(`lib/k8sHub.ts`)로 비활성화된다
 * (지식 허브 `/docs` 와 홈 배치잡 서브탭의 "페이지를 탭 안에 마운트" 패턴).
 *
 * 뷰 전환은 path 세그먼트라 history 에 남고(뒤로가기 = 이전 뷰), 뷰 내부의 `?tab=`·`?view=` 쿼리는
 * 각 페이지가 그대로 쓴다(허브는 쿼리 키를 갖지 않는다). 접근 제어는 뷰마다 흡수한 옛 경로
 * (`HubView.navKey`)로 판정한다 — 허브 URL 은 `RouteAccessGate` 의 longest-prefix 가 `/k8s` 만 보기 때문.
 */
export function K8sHubPage() {
  const { clusterId = '', view: viewParam } = useParams<{ clusterId: string; view: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: clusters = [], isLoading, isError, error, refetch } = useClusters();
  const { featureAllowed, getLabel } = useNavCatalog();

  const viewId = viewParam ?? DEFAULT_HUB_VIEW;
  const allowedViews = useMemo(() => HUB_VIEWS.filter((v) => hubViewAllowed(v, featureAllowed)), [featureAllowed]);
  const view = findHubView(viewId);
  const cluster = clusters.find((c) => c.id === clusterId);

  // 클러스터 미지정(`/k8s`) → 첫 클러스터로 replace. 다른 per-cluster 화면과 같은 동작.
  useEffect(() => {
    if (clusterId || clusters.length === 0) return;
    navigate(`/k8s/${clusters[0].id}/${viewId}${location.search}`, { replace: true });
  }, [clusterId, clusters, viewId, location.search, navigate]);

  // 레일에서 클러스터를 바꾸면 뷰·쿼리는 유지하고 클러스터만 바꾼다(클러스터 추이 D-190 ⑨ 와 동일).
  const selectCluster = useCallback((id: string | null) => {
    if (!id || id === clusterId) return;
    navigate(`/k8s/${id}/${viewId}${location.search}`);
  }, [clusterId, viewId, location.search, navigate]);

  // 2행 탭 옆 자리 — 화면이 포털로 컨트롤을 꽂는다(SSH 대상 노드 선택).
  const [toolbarSlot, setToolbarSlot] = useState<HTMLElement | null>(null);
  const embed = useMemo<K8sHubEmbed>(() => ({ clusterId, selectCluster, toolbarSlot }), [clusterId, selectCluster, toolbarSlot]);

  // 옛 "터미널" 실행 카드 뷰(D-243 에서 k9s·노드 SSH 뷰로 대체) → k9s.
  if (clusterId && viewId === 'terminals') {
    return <Navigate to={`/k8s/${clusterId}/k9s${location.search}`} replace />;
  }
  // 모르는 뷰 → 개요로.
  if (clusterId && !view) {
    return <Navigate to={`/k8s/${clusterId}/${DEFAULT_HUB_VIEW}`} replace />;
  }

  const activeView = view ?? findHubView(DEFAULT_HUB_VIEW)!;
  const activeAllowed = allowedViews.some((v) => v.id === activeView.id);
  const ViewComponent = activeView.component;

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console">
        <div className="flex-1 min-w-0 space-y-3">
          <PageHeader
            icon={ShipWheel}
            title={cluster ? cluster.name : getLabel('/k8s')}
            titleExtra={
              <span className="inline-flex items-center gap-2">
                {cluster && <StatusBadge variant={statusToVariant(cluster.status)} size="sm" />}
                {clusters.length > 0 && <HubClusterSwitcher />}
              </span>
            }
            description={cluster ? `${getLabel('/k8s')} · ${activeView.label}` : undefined}
          />

          {clusterId && <HubTabs clusterId={clusterId} views={allowedViews} active={activeView} slotRef={setToolbarSlot} />}

          {!clusterId ? (
            isError ? <ErrorState error={error} onRetry={() => { void refetch(); }} />
            : isLoading ? <LoadingState /> : <SelectClusterEmptyState description="등록된 클러스터가 없습니다. 클러스터 관리에서 먼저 등록해 주세요." />
          ) : !activeAllowed ? (
            <EmptyState
              icon={Lock}
              title="접근 권한이 없습니다"
              description={`"${getLabel(activeView.navKey)}" 화면에 대한 접근 권한이 없습니다. 관리자에게 문의하세요.`}
            />
          ) : (
            // 임베드 표식 — 페이지의 레일/헤더/셸을 허브가 대신하고, 전체 높이 셸(.island-embed)을 무력화한다.
            <div className="island-embed">
              <K8sHubContext.Provider value={embed}>
                <ViewComponent key={activeView.keepAcrossClusters ? activeView.id : `${clusterId}:${activeView.id}`} />
              </K8sHubContext.Provider>
            </div>
          )}
        </div>
      </PageShell>
    </div>
  );
}
