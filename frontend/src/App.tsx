import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { Dashboard } from '@/pages/Dashboard';
import { PlaybooksPage } from '@/pages/PlaybooksPage';
import { WorkItemBoardPage } from '@/pages/WorkItemBoardPage';
import { WorkItemFormPage } from '@/pages/WorkItemFormPage';
import { WorkItemDetailPage } from '@/pages/WorkItemDetailPage';
import { JiraExcelImportPage } from '@/pages/JiraExcelImportPage';
import { TodoTodayPage } from '@/pages/TodoTodayPage';
import { SprintsPage } from '@/pages/SprintsPage';
import { MemberBoardPage } from '@/pages/MemberBoardPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { ClusterLinksPage } from '@/pages/ClusterLinksPage';
import { NodeLabelsPage } from '@/pages/NodeLabelsPage';
import { NodeImagesPage } from '@/pages/NodeImagesPage';
import { CidrCalculatorPage } from '@/pages/CidrCalculatorPage';
import { ClusterManagePage } from '@/pages/ClusterManagePage';
import { ClusterMetaFormPage } from '@/pages/ClusterMetaFormPage';
import { VersionsPage } from '@/pages/VersionsPage';
import { VersionGraphPage } from '@/pages/VersionGraphPage';
import { BulkExecPage } from '@/pages/BulkExecPage';
import { EtcdCtlPage } from '@/pages/EtcdCtlPage';
import { BatchJobsPage } from '@/pages/BatchJobsPage';
import { KernelParamsPage } from '@/pages/KernelParamsPage';
import { McClientPage } from '@/pages/McClientPage';
import { IsilonNfsPage } from '@/pages/IsilonNfsPage';
import { WorkflowBoardPage } from '@/pages/WorkflowBoardPage';
import { WorkGuidePage } from '@/pages/WorkGuidePage';
import { CommandsPage } from '@/pages/CommandsPage';
import { CommandFormPage } from '@/pages/CommandFormPage';
import { OpsNotesPage } from '@/pages/OpsNotesPage';
import { OpsNoteDetailPage } from '@/pages/OpsNoteDetailPage';
import { OpsNoteFormPage } from '@/pages/OpsNoteFormPage';
import { MindMapPage } from '@/pages/MindMapPage';
import { WbsFlowPage } from '@/pages/WbsFlowPage';
import { InfraTopologyPage } from '@/pages/InfraTopologyPage';
import { NodeSpecPage } from '@/pages/NodeSpecPage';
import { ServicesCatalogPage } from '@/pages/ServicesCatalogPage';
import { ServiceHubPage } from '@/pages/ServiceHubPage';
import { IncidentAnalysisPage } from '@/pages/IncidentAnalysisPage';
import { PacketFlowPage } from '@/pages/PacketFlowPage';
import { OntologyPage } from '@/pages/OntologyPage';
import { TrendDigestPage } from '@/pages/TrendDigestPage';
import { CiliumTracePage } from '@/pages/CiliumTracePage';
import { ServiceTopologyPage } from '@/pages/ServiceTopologyPage';
import { ArchitecturePage } from '@/pages/ArchitecturePage';
import { K8sEventsPage } from '@/pages/K8sEventsPage';
import { DailyCheckReviewPage } from '@/pages/DailyCheckReview';
import { DeepCheckSettingsPage } from '@/pages/DeepCheckSettings';
import { OpsCheckConsolePage } from '@/pages/OpsCheckConsolePage';
import { K8sLogsPage } from '@/pages/K8sLogsPage';
import { K8sManagePage } from '@/pages/K8sManagePage';
import { K8sAllocationPage } from '@/pages/K8sAllocationPage';
import { ClusterTrendsPage } from '@/pages/ClusterTrendsPage';
import { LakeServicesPage } from '@/pages/LakeServicesPage';
import { PepServicesPage } from '@/pages/PepServicesPage';
import { AppServicesPage } from '@/pages/AppServicesPage';
import { LakeServiceDetailPage } from '@/pages/LakeServiceDetailPage';
import { PodBottleneckPage } from '@/pages/PodBottleneckPage';
import { PodBottleneckDetailPage } from '@/pages/PodBottleneckDetailPage';
import { KnowledgeHubPage } from '@/pages/KnowledgeHubPage';
import { HomePage } from '@/pages/HomePage';
import { UsersPage } from '@/pages/UsersPage';
import { ChangePasswordPage } from '@/pages/ChangePasswordPage';
import { AgentChat } from '@/components/agent';
import { Sidebar, PageStyleProvider } from '@/components/layout';
import { ToastProvider } from '@/components/common';
import { AuthGate } from '@/components/auth/AuthGate';
import { useAuthStore } from '@/stores/authStore';
import { useFeatureAccess, canAccessFeature } from '@/hooks/useFeatureAccess';

function RedirectWithId({ to, suffix = '' }: { to: string; suffix?: string }) {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`${to}/${id ?? ''}${suffix}`} replace />;
}

/** Settings 등 admin 전용 라우트 가드 — 비-admin 은 홈으로. (추후 role/권한 세분화 예정) */
function RequireAdmin({ children }: { children: React.ReactNode }) {
  const role = useAuthStore((s) => s.user?.role);
  if (role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** 기능별 접근 제어 가드 — feature_access 설정에 따라 허용된 사용자만. */
function RequireFeature({ feature, children }: { feature: string; children: React.ReactNode }) {
  const { data, isLoading } = useFeatureAccess();
  const user = useAuthStore((s) => s.user);
  if (isLoading) return null;
  if (!canAccessFeature(data, feature, user)) return <Navigate to="/" replace />;
  return <>{children}</>;
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
      {/* Skip link — 키보드/스크린리더 사용자가 사이드바 내비게이션을 건너뛰고
          바로 본문(#main-content, PageStyleProvider 래퍼)으로 이동(W4 접근성 패스). */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-primary focus:text-primary-foreground focus:font-semibold focus:shadow-lg"
      >
        본문으로 건너뛰기
      </a>
      <Sidebar />
      {/* 업무 알람 종은 더 이상 전역 고정하지 않는다 — HomePage(업무 현황) 상단 스트립 우측에 배치. */}
      {/* PageStyleProvider — 본문 래퍼. 라우트별 "화면 UI 설정"(폰트/크기/색/배경) 적용. */}
      <PageStyleProvider>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/cluster-overview" element={<Dashboard />} />
              <Route path="/playbooks" element={<PlaybooksPage />} />
              {/* 업무 관리 — 정식 경로 */}
              {/* LAKE service monitoring (lake-service-monitoring PDCA) */}
              <Route path="/lake-services" element={<LakeServicesPage />} />
              <Route path="/lake-services/:id" element={<LakeServiceDetailPage />} />

              {/* PEP 서비스 / APP 서비스 — service-category-catalog PDCA (구 "지식/분석" 아이콘 자리 재정의 + 신규) */}
              <Route path="/pep-services" element={<PepServicesPage />} />
              <Route path="/app-services" element={<AppServicesPage />} />

              {/* Pod-to-pod bottleneck analyzer (pod-bottleneck-analyzer PDCA) */}
              <Route path="/pod-bottleneck" element={<PodBottleneckPage />} />
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
              <Route path="/links" element={<ClusterLinksPage />} />
              <Route path="/node-labels" element={<NodeLabelsPage />} />
              <Route path="/node-images" element={<NodeImagesPage />} />
              <Route path="/cidr" element={<CidrCalculatorPage />} />
              <Route path="/cluster-manage" element={<ClusterManagePage />} />
              <Route path="/cluster-manage/:id/edit" element={<ClusterMetaFormPage />} />
              <Route path="/versions" element={<VersionsPage />} />
              <Route path="/versions/:clusterId/graph" element={<VersionGraphPage />} />
              <Route path="/bulk-exec" element={<BulkExecPage />} />
              <Route path="/etcdctl" element={<EtcdCtlPage />} />
              <Route path="/batch-jobs" element={<BatchJobsPage />} />
              <Route path="/kernel-params" element={<KernelParamsPage />} />
              <Route path="/mc" element={<McClientPage />} />
              <Route path="/isilon-nfs" element={<IsilonNfsPage />} />
              <Route path="/infra-topology" element={<InfraTopologyPage />} />
              <Route path="/node-specs" element={<NodeSpecPage />} />
              <Route path="/services" element={<ServicesCatalogPage />} />
              <Route path="/services/:service" element={<ServiceHubPage />} />
              <Route path="/settings" element={<RequireAdmin><SettingsPage /></RequireAdmin>} />
              <Route path="/workflow" element={<WorkflowBoardPage />} />
              <Route path="/work-guides" element={<WorkGuidePage />} />
              <Route path="/work-guides/new" element={<WorkGuidePage />} />
              <Route path="/work-guides/:id" element={<WorkGuidePage />} />
              <Route path="/work-guides/:id/edit" element={<WorkGuidePage />} />
              <Route path="/commands" element={<CommandsPage />} />
              <Route path="/commands/new" element={<CommandFormPage />} />
              <Route path="/commands/:id/edit" element={<CommandFormPage />} />
              <Route path="/ops-notes" element={<OpsNotesPage />} />
              <Route path="/ops-notes/new" element={<OpsNoteFormPage />} />
              <Route path="/ops-notes/:id" element={<OpsNoteDetailPage />} />
              <Route path="/ops-notes/:id/edit" element={<OpsNoteDetailPage />} />
              <Route path="/mindmap" element={<MindMapPage />} />
              <Route path="/wbs" element={<RequireFeature feature="wbs"><WbsFlowPage /></RequireFeature>} />
              <Route path="/incident-analysis" element={<IncidentAnalysisPage />} />
              <Route path="/packet-flow" element={<PacketFlowPage />} />
              <Route path="/ontology" element={<OntologyPage />} />
              <Route path="/trends" element={<TrendDigestPage />} />
              <Route path="/cilium-trace" element={<CiliumTracePage />} />
              <Route path="/service-topology" element={<ServiceTopologyPage />} />
              <Route path="/architecture" element={<ArchitecturePage />} />
              <Route path="/k8s-events" element={<K8sEventsPage />} />
              <Route path="/daily-check/review/:clusterId" element={<DailyCheckReviewPage />} />
              <Route path="/daily-check/review" element={<DailyCheckReviewPage />} />
              <Route path="/daily-check/settings" element={<RequireAdmin><DeepCheckSettingsPage /></RequireAdmin>} />
              {/* 운영 점검 통합 콘솔 — 점검 항목 리스트 + 일괄/개별 실행 + 결과/로그 */}
              <Route path="/ops-checks/:clusterId" element={<OpsCheckConsolePage />} />
              <Route path="/ops-checks" element={<OpsCheckConsolePage />} />
              {/* OpenLens P0 — 파드 로그 스트리밍(읽기전용) */}
              <Route path="/k8s-logs/:clusterId" element={<K8sLogsPage />} />
              <Route path="/k8s-logs" element={<K8sLogsPage />} />
              {/* 구 /k8s-resources(리소스 탐색기)는 K8S 상세 관리로 통합·제거됨 → 리다이렉트 */}
              <Route path="/k8s-resources/:clusterId" element={<Navigate to="/k8s-manage" replace />} />
              <Route path="/k8s-resources" element={<Navigate to="/k8s-manage" replace />} />
              {/* Lens 식 K8S 상세 관리 — 리소스 탐색 + 쓰기 액션 + 터미널/이벤트/Helm/RBAC/CRD */}
              <Route path="/k8s-manage/:clusterId" element={<K8sManagePage />} />
              <Route path="/k8s-manage" element={<K8sManagePage />} />
              {/* K8S 자원 관리 — 노드/NS/워크로드/파드 단위 request vs 사용량(slack) 가시화 */}
              <Route path="/k8s-allocation/:clusterId" element={<K8sAllocationPage />} />
              <Route path="/k8s-allocation" element={<K8sAllocationPage />} />
              <Route path="/cluster-trends/:clusterId" element={<ClusterTrendsPage />} />
              <Route path="/cluster-trends" element={<ClusterTrendsPage />} />
              <Route path="/docs" element={<KnowledgeHubPage />} />
              <Route path="/settings/users" element={<RequireAdmin><UsersPage /></RequireAdmin>} />
              <Route path="/me/change-password" element={<ChangePasswordPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
      </PageStyleProvider>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <AuthGate>
            <AppShell />
            <AgentChat />
          </AuthGate>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}

export default App;
