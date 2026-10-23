import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation, useNavigate } from 'react-router-dom';
import { PlaybooksPage } from '@/pages/PlaybooksPage';
import { WorkItemBoardPage } from '@/pages/WorkItemBoardPage';
import { WorkItemFormPage } from '@/pages/WorkItemFormPage';
import { WorkItemDetailPage } from '@/pages/WorkItemDetailPage';
import { JiraExcelImportPage } from '@/pages/JiraExcelImportPage';
import { WeeklyReportPage } from '@/pages/WeeklyReportPage';
import { TodoTodayPage } from '@/pages/TodoTodayPage';
import { SprintsPage } from '@/pages/SprintsPage';
import { MemberBoardPage } from '@/pages/MemberBoardPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { ClusterLinksPage } from '@/pages/ClusterLinksPage';
import { NodeLabelsPage } from '@/pages/NodeLabelsPage';
import { NsMigrationPage } from '@/pages/NsMigrationPage';
import { CidrCalculatorPage } from '@/pages/CidrCalculatorPage';
import { ClusterManagePage } from '@/pages/ClusterManagePage';
import { ClusterMetaFormPage } from '@/pages/ClusterMetaFormPage';
import { VersionGraphPage } from '@/pages/VersionGraphPage';
import { BulkExecPage } from '@/pages/BulkExecPage';
import { McClientPage } from '@/pages/McClientPage';
import { IsilonNfsPage } from '@/pages/IsilonNfsPage';
import { WorkflowBoardPage } from '@/pages/WorkflowBoardPage';
import { WorkGuidePage } from '@/pages/WorkGuidePage';
import { DocumentsPage } from '@/pages/DocumentsPage';
import { CommandsPage } from '@/pages/CommandsPage';
import { ScriptsPage } from '@/pages/ScriptsPage';
import { CommandFormPage } from '@/pages/CommandFormPage';
import { OpsNotesPage } from '@/pages/OpsNotesPage';
import { OpsNoteDetailPage } from '@/pages/OpsNoteDetailPage';
import { OpsNoteFormPage } from '@/pages/OpsNoteFormPage';
import { MindMapPage } from '@/pages/MindMapPage';
import { WbsFlowPage } from '@/pages/WbsFlowPage';
import { InfraTopologyPage } from '@/pages/InfraTopologyPage';
import { NodeSpecPage } from '@/pages/NodeSpecPage';
import { OntologyPage } from '@/pages/OntologyPage';
import { TrendDigestPage } from '@/pages/TrendDigestPage';
import { ServiceTopologyPage } from '@/pages/ServiceTopologyPage';
import { ServiceArchitecturePage } from '@/pages/ServiceArchitecturePage';
import { ArchitecturePage } from '@/pages/ArchitecturePage';
import { AlertInboxPage } from '@/pages/AlertInboxPage';
import { DeepCheckSettingsPage } from '@/pages/DeepCheckSettings';
import { CheckItemDetailPage } from '@/pages/CheckItemDetailPage';
import { K9sPage } from '@/pages/K9sPage';
import { K9sPopupPage } from '@/pages/K9sPopupPage';
import { NodeSshPage } from '@/pages/NodeSshPage';
import { NodeSshPopupPage } from '@/pages/NodeSshPopupPage';
import { LakeServicesPage } from '@/pages/LakeServicesPage';
import { LakeServiceDetailPage } from '@/pages/LakeServiceDetailPage';
import { PodBottleneckDetailPage } from '@/pages/PodBottleneckDetailPage';
import { KnowledgeHubPage } from '@/pages/KnowledgeHubPage';
import { K8sHubPage } from '@/pages/K8sHubPage';
import { HomePage } from '@/pages/HomePage';
import { IslandPage } from '@/pages/IslandPage';
import { ChangePasswordPage } from '@/pages/ChangePasswordPage';
import { OidcCallbackPage } from '@/pages/OidcCallbackPage';
import { DailyReportPage } from '@/pages/DailyReportPage';
import { ExternalServicesPage } from '@/pages/ExternalServicesPage';
import { AgentChat } from '@/components/agent';
import { Sidebar, PageStyleProvider } from '@/components/layout';
import { ToastProvider, LoadingState } from '@/components/common';
import { AuthGate } from '@/components/auth/AuthGate';
import { useAuthStore } from '@/stores/authStore';
import { useFeatureAccess, canAccessFeature } from '@/hooks/useFeatureAccess';
import { useRecentPathsStore } from '@/stores/recentPathsStore';
import { useClusters } from '@/hooks/useCluster';
import { NAV_MAP } from '@/components/layout/navConfig';

function RedirectWithId({ to, suffix = '' }: { to: string; suffix?: string }) {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`${to}/${id ?? ''}${suffix}`} replace />;
}

/**
 * 옛 per-cluster K8s 화면 URL → K8s 클러스터 허브(`/k8s/:clusterId/:view`) 서브뷰(D-240).
 * `:clusterId` 와 쿼리(`?namespace=&pod=`·`?tab=` 등)를 그대로 넘긴다 — `RedirectWithId` 는 쿼리를 버린다.
 * 클러스터 없이 들어온 bare URL(`/k8s-manage`)은 첫 클러스터로 보낸다(각 화면이 하던 "첫 클러스터로
 * replace" 와 같은 동작). 클러스터가 하나도 없으면 허브가 안내한다.
 */
function RedirectToHub({ view }: { view: string }) {
  const { clusterId: pathClusterId } = useParams<{ clusterId: string }>();
  const { search } = useLocation();
  const { data: clusters, isLoading } = useClusters();
  // 쿼리로 클러스터를 들고 있던 옛 화면(`/k8s-rbac?cluster=…&tab=…`·`/k8s-events?cluster=…`)의 링크도 그 클러스터로 —
  // 허브에선 클러스터가 경로에 있으므로 `cluster` 키는 쿼리에서 뺀다.
  const qs = new URLSearchParams(search);
  const queryClusterId = qs.get('cluster') ?? '';
  qs.delete('cluster');
  const rest = qs.toString() ? `?${qs.toString()}` : '';
  const clusterId = pathClusterId || queryClusterId;
  if (clusterId) return <Navigate to={`/k8s/${clusterId}/${view}${rest}`} replace />;
  if (isLoading && !clusters) return <LoadingState />;
  const first = clusters?.[0]?.id;
  return <Navigate to={first ? `/k8s/${first}/${view}${rest}` : '/k8s'} replace />;
}

/** Settings 등 admin 전용 라우트 가드 — 비-admin 은 홈으로. (추후 role/권한 세분화 예정) */
function RequireAdmin({ children }: { children: React.ReactNode }) {
  const role = useAuthStore((s) => s.user?.role);
  if (role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

/**
 * 화면별 접근 제어(Settings "접근 제어") 전역 가드 — 사이드바 메뉴는 이미 `featureAllowed`
 * 로 숨기지만, 주소를 알면 그냥 들어가진다. 라우트 하나하나를 감싸는 대신 모든 라우트 전환을
 * 지켜보다가 현재 경로에 해당하는 NAV_MAP 항목이 막혀 있으면 홈으로 돌려보낸다.
 *
 * NAV_MAP 키 중 현재 경로와 정확히 같거나 그 하위 경로(`/base/...`)인 것 중 **가장 긴 것**을
 * 매치로 쓴다 — `/daily-check/review` 와 `/daily-check/settings` 처럼 접두어를 공유하는
 * 경로끼리 서로 잘못 매치되지 않도록. RequireAdmin 이 이미 막는 admin 전용 라우트
 * (`/settings`, `/daily-check/settings`)는 feature_access 규칙이 없으면 그대로 통과되므로
 * 서로 간섭하지 않는다.
 */
function RouteAccessGate() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: featureAccess, isLoading } = useFeatureAccess();
  const user = useAuthStore((s) => s.user);
  const recordVisit = useRecentPathsStore((s) => s.recordVisit);

  useEffect(() => {
    if (isLoading || !user) return;
    const path = location.pathname;
    const match = Object.keys(NAV_MAP)
      .filter((p) => p !== '/' && (path === p || path.startsWith(`${p}/`)))
      .sort((a, b) => b.length - a.length)[0];
    if (match && !canAccessFeature(featureAccess, match, user)) {
      navigate('/', { replace: true });
      return;
    }
    // 최근 방문 — 즐겨찾기 드롭다운이 소비. 상세 페이지(`/tasks-mgmt/:id`)도 캐노니컬
    // 화면 경로(`/tasks-mgmt`)로 기록돼 목록이 파라미터로 흩어지지 않는다.
    if (match) recordVisit(match);
  }, [location.pathname, featureAccess, isLoading, user, navigate, recordVisit]);

  return null;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30, // 30초
      retry: 1,
    },
  },
});

function AppShell() {
  return (
    <div className="flex min-h-screen bg-background">
      <RouteAccessGate />
      {/* Skip link — 키보드/스크린리더 사용자가 사이드바 내비게이션을 건너뛰고
          바로 본문(#main-content, PageStyleProvider 래퍼)으로 이동(W4 접근성 패스). */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-primary focus:text-primary-foreground focus:font-semibold focus:shadow-lg"
      >
        본문으로 건너뛰기
      </a>
      <Sidebar />
      {/* PageStyleProvider — 전역 상단바(AppTopBar, 업무 알람 종 포함) + 라우트별
          "화면 UI 설정"(폰트/크기/색/배경)이 적용된 본문 래퍼. */}
      <PageStyleProvider>
            <Routes>
              <Route path="/" element={<HomePage />} />
              {/* Your Island — 사용자 커스텀 화면. islandId 없이 들어오면 마지막에 보던 것으로 리다이렉트 */}
              <Route path="/island" element={<IslandPage />} />
              <Route path="/island/:islandId" element={<IslandPage />} />
              <Route path="/cluster-overview" element={<Navigate to="/clusters" replace />} />
              {/* K8s 클러스터 허브(D-240) — 클러스터 레일 하나 + 탭으로 per-cluster K8s 화면을 모은다.
                  아래 옛 경로들(/clusters·/k8s-manage·/k8s-allocation·/cluster-trends·/observability·/k8s-events·
                  /k8s-logs·/incident-analysis·/daily-check/review, 2단계: /k8s-rbac·/node-images·/versions·/etcdctl·/kernel-params)은
                  해당 뷰로 redirect(클러스터·쿼리 보존). 3단계: /pod-bottleneck·/cilium-trace·/packet-flow·/ops-checks.
                  /node-labels(전체 클러스터 모드)·/k9s·/node-ssh(전체 높이 터미널)·/pod-bottleneck/:id(실행 상세)는 단독 유지. */}
              <Route path="/k8s" element={<K8sHubPage />} />
              <Route path="/k8s/:clusterId/:view?" element={<K8sHubPage />} />
              <Route path="/playbooks" element={<PlaybooksPage />} />
              {/* 업무 관리 — 정식 경로 */}
              {/* LAKE service monitoring (lake-service-monitoring PDCA) */}
              <Route path="/lake-services" element={<LakeServicesPage />} />
              <Route path="/lake-services/:id" element={<LakeServiceDetailPage />} />

              {/* Pod-to-pod bottleneck analyzer (pod-bottleneck-analyzer PDCA) */}
              <Route path="/pod-bottleneck" element={<RedirectToHub view="bottleneck" />} />
              <Route path="/pod-bottleneck/:id" element={<PodBottleneckDetailPage />} />

              <Route path="/tasks-mgmt" element={<WorkItemBoardPage />} />
              <Route path="/tasks-mgmt/new" element={<WorkItemFormPage />} />
              <Route path="/tasks-mgmt/:id" element={<WorkItemDetailPage />} />
              {/* 별도 수정 페이지 폐지 — 옛 /edit 딥링크/북마크는 상세 페이지의 편집 모드(?edit=1)로 리다이렉트 */}
              <Route path="/tasks-mgmt/:id/edit" element={<RedirectWithId to="/tasks-mgmt" suffix="?edit=1" />} />
              {/* 레거시 경로 — /tasks-mgmt 로 리다이렉트 (북마크/외부 링크 호환) */}
              <Route path="/work-items" element={<Navigate to="/tasks-mgmt" replace />} />
              <Route path="/work-items/new" element={<Navigate to="/tasks-mgmt/new" replace />} />
              <Route path="/work-items/:id" element={<RedirectWithId to="/tasks-mgmt" />} />
              <Route path="/work-items/:id/edit" element={<RedirectWithId to="/tasks-mgmt" suffix="?edit=1" />} />
              <Route path="/issues" element={<Navigate to="/tasks-mgmt" replace />} />
              <Route path="/tasks" element={<Navigate to="/tasks-mgmt" replace />} />
              <Route path="/todo-today" element={<TodoTodayPage />} />
              <Route path="/sprints" element={<SprintsPage />} />
              <Route path="/members" element={<MemberBoardPage />} />
              <Route path="/jira-import" element={<JiraExcelImportPage />} />
              <Route path="/weekly-report" element={<WeeklyReportPage />} />
              <Route path="/links" element={<ClusterLinksPage />} />
              <Route path="/node-labels" element={<NodeLabelsPage />} />
              <Route path="/k8s-rbac" element={<RedirectToHub view="rbac" />} />
              <Route path="/ns-migration" element={<NsMigrationPage />} />
              <Route path="/node-images" element={<RedirectToHub view="node-images" />} />
              <Route path="/cidr" element={<CidrCalculatorPage />} />
              <Route path="/cluster-manage" element={<ClusterManagePage />} />
              <Route path="/cluster-manage/:id/edit" element={<ClusterMetaFormPage />} />
              <Route path="/versions" element={<RedirectToHub view="versions" />} />
              <Route path="/versions/:clusterId/graph" element={<VersionGraphPage />} />
              <Route path="/bulk-exec" element={<BulkExecPage />} />
              <Route path="/etcdctl" element={<RedirectToHub view="etcdctl" />} />
              {/* 홈 화면 "플랫폼 현황" 탭의 배치잡 서브탭으로 병합됨 — 기존 링크/북마크가 홈 첫 탭이 아니라
                  배치잡 서브탭에 바로 떨어지도록 쿼리로 탭/서브뷰를 넘긴다(HomePage 가 읽고 지움, D-129). */}
              <Route path="/batch-jobs" element={<Navigate to="/?tab=platform&view=batch" replace />} />
              <Route path="/kernel-params" element={<RedirectToHub view="kernel-params" />} />
              <Route path="/mc" element={<McClientPage />} />
              <Route path="/isilon-nfs" element={<IsilonNfsPage />} />
              <Route path="/infra-topology" element={<InfraTopologyPage />} />
              <Route path="/node-specs" element={<NodeSpecPage />} />
              <Route path="/settings" element={<RequireAdmin><SettingsPage /></RequireAdmin>} />
              <Route path="/workflow" element={<WorkflowBoardPage />} />
              <Route path="/documents" element={<DocumentsPage />} />
              <Route path="/work-guides" element={<WorkGuidePage />} />
              <Route path="/work-guides/new" element={<WorkGuidePage />} />
              <Route path="/work-guides/:id" element={<WorkGuidePage />} />
              <Route path="/work-guides/:id/edit" element={<WorkGuidePage />} />
              <Route path="/commands" element={<CommandsPage />} />
              <Route path="/commands/new" element={<CommandFormPage />} />
              <Route path="/commands/:id/edit" element={<CommandFormPage />} />
              <Route path="/scripts" element={<ScriptsPage />} />
              <Route path="/ops-notes" element={<OpsNotesPage />} />
              <Route path="/ops-notes/new" element={<OpsNoteFormPage />} />
              <Route path="/ops-notes/:id" element={<OpsNoteDetailPage />} />
              <Route path="/ops-notes/:id/edit" element={<OpsNoteDetailPage />} />
              <Route path="/mindmap" element={<MindMapPage />} />
              {/* /wbs 의 접근 제어는 더 이상 라우트별 개별 가드가 아니라 RouteAccessGate 가
                  NAV_MAP 을 통해 범용으로 처리한다(Settings "접근 제어"). */}
              <Route path="/wbs" element={<WbsFlowPage />} />
              <Route path="/incident-analysis" element={<RedirectToHub view="incident" />} />
              <Route path="/incident-analysis/:clusterId" element={<RedirectToHub view="incident" />} />
              <Route path="/packet-flow" element={<RedirectToHub view="packet-flow" />} />
              <Route path="/ontology" element={<OntologyPage />} />
              <Route path="/ontology/:clusterId" element={<OntologyPage />} />
              <Route path="/trends" element={<TrendDigestPage />} />
              <Route path="/cilium-trace" element={<RedirectToHub view="cilium" />} />
              <Route path="/service-topology" element={<ServiceTopologyPage />} />
              <Route path="/service-architecture" element={<ServiceArchitecturePage />} />
              <Route path="/service-architecture/:clusterId" element={<ServiceArchitecturePage />} />
              <Route path="/architecture" element={<ArchitecturePage />} />
              <Route path="/k8s-events" element={<RedirectToHub view="events" />} />
              {/* Observability — 관측 스택(kube-prometheus-stack 등) 개별 지표 dense 대시보드 → 허브 metrics 뷰 */}
              <Route path="/observability/:clusterId" element={<RedirectToHub view="metrics" />} />
              <Route path="/observability" element={<RedirectToHub view="metrics" />} />
              {/* 알람 인박스 — Alertmanager / alert-forwarder 수신 인시던트 알람 */}
              <Route path="/alerts" element={<AlertInboxPage />} />
              <Route path="/daily-check/review/:clusterId" element={<RedirectToHub view="review" />} />
              <Route path="/daily-check/review" element={<RedirectToHub view="review" />} />
              <Route path="/daily-check/settings" element={<RequireAdmin><DeepCheckSettingsPage /></RequireAdmin>} />
              {/* 클러스터 상세 — 종합 상태(원인) + 점검 카탈로그. 매트릭스 클러스터명 클릭이 여기로 → 허브 overview 뷰. */}
              <Route path="/clusters/:clusterId" element={<RedirectToHub view="overview" />} />
              <Route path="/clusters" element={<RedirectToHub view="overview" />} />
              {/* 항목 상세(R-4 6차 라운드 4단계) — 정의·테스트·적용·실행방식·로그·히스토리.
                  매트릭스 항목명 클릭이 여기로. /daily-check/settings 는 전 항목 검색/일괄 관리용으로 별도 유지. */}
              <Route path="/checks/:itemId" element={<CheckItemDetailPage />} />
              {/* 운영 점검 통합 콘솔(레거시) — 같은 패널을 종합 상태까지 보여 주는 허브 개요 뷰로 redirect(D-240 3단계).
                  페이지 컴포넌트는 아일랜드 패널 호환으로 남는다. */}
              <Route path="/ops-checks/:clusterId" element={<RedirectToHub view="overview" />} />
              <Route path="/ops-checks" element={<RedirectToHub view="overview" />} />
              {/* OpenLens P0 — 파드 로그 스트리밍(읽기전용) */}
              <Route path="/k8s-logs/:clusterId" element={<RedirectToHub view="logs" />} />
              <Route path="/k8s-logs" element={<RedirectToHub view="logs" />} />
              {/* 구 /k8s-resources(리소스 탐색기)는 K8S 상세 관리로 통합·제거됨 → 리다이렉트 */}
              <Route path="/k8s-resources/:clusterId" element={<Navigate to="/k8s-manage" replace />} />
              <Route path="/k8s-resources" element={<Navigate to="/k8s-manage" replace />} />
              {/* Lens 식 K8S 상세 관리 — 리소스 탐색 + 쓰기 액션 + 터미널/이벤트/Helm/RBAC/CRD */}
              <Route path="/k8s-manage/:clusterId" element={<RedirectToHub view="manage" />} />
              <Route path="/k8s-manage" element={<RedirectToHub view="manage" />} />
              {/* K8S 자원 관리 — 노드/NS/워크로드/파드 단위 request vs 사용량(slack) 가시화 */}
              <Route path="/k8s-allocation/:clusterId" element={<RedirectToHub view="allocation" />} />
              <Route path="/k8s-allocation" element={<RedirectToHub view="allocation" />} />
              {/* k9s 콘솔 — control-plane 서버 내장 k9s 를 SSH 로 웹 터미널 스트리밍 */}
              <Route path="/k9s/:clusterId" element={<K9sPage />} />
              <Route path="/k9s" element={<K9sPage />} />
              {/* 노드 SSH 터미널 — 개별 노드에 로그인 셸을 열어 웹 터미널로 스트리밍 */}
              <Route path="/node-ssh/:clusterId" element={<NodeSshPage />} />
              <Route path="/node-ssh" element={<NodeSshPage />} />
              <Route path="/cluster-trends/:clusterId" element={<RedirectToHub view="trends" />} />
              <Route path="/cluster-trends" element={<RedirectToHub view="trends" />} />
              <Route path="/docs" element={<KnowledgeHubPage />} />
              {/* 사용자 관리(로그인 계정)는 Settings ▸ 시스템 담당자 ▸ 로그인 계정 서브탭으로 통합됨 */}
              <Route path="/settings/users" element={<Navigate to="/settings?tab=assignee" replace />} />
              <Route path="/me/change-password" element={<ChangePasswordPage />} />
              {/* SSO 콜백 — 미로그인 땐 LoginPage 가 그린다. 이미 로그인된 탭으로 돌아온 경우만 여기. */}
              <Route path="/auth/callback" element={<OidcCallbackPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
      </PageStyleProvider>
    </div>
  );
}

/** 인증 후 최상위 — 터미널 팝업 라우트(`/k9s/popup`, `/node-ssh/popup`)는 사이드바/네비
 *  없는 전체창(별도 브라우저 창)으로 분기하고, 그 외에는 메인 셸(AppShell)을 그대로
 *  렌더한다. AppShell 을 Route 로 감싸지 않아 기존 라우팅 컨텍스트에 영향이 없다. */
function AuthedRoot() {
  const location = useLocation();
  if (location.pathname === '/k9s/popup') return <K9sPopupPage />;
  if (location.pathname === '/node-ssh/popup') return <NodeSshPopupPage />;
  return (
    <>
      <AppShell />
      <AgentChat />
    </>
  );
}

/** 로그인 없이 여는 공개 화면 — AuthGate 바깥에서 분기한다(사이드바·셸 없음).
 *  데이터도 비인증 공개 API(`/public/...`)만 쓴다. 화면 간 링크는 `components/public-pages`. */
const PUBLIC_ROUTES: Record<string, () => JSX.Element> = {
  '/daily-report': DailyReportPage,
  '/external-services': ExternalServicesPage,
};

function PublicOrAuthed() {
  const location = useLocation();
  const PublicPage = PUBLIC_ROUTES[location.pathname];
  if (PublicPage) return <PublicPage />;
  return (
    <AuthGate>
      <AuthedRoot />
    </AuthGate>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <PublicOrAuthed />
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

export default App;
