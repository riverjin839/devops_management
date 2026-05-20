import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { Dashboard } from '@/pages/Dashboard';
import { PlaybooksPage } from '@/pages/PlaybooksPage';
import { WorkItemBoardPage } from '@/pages/WorkItemBoardPage';
import { WorkItemFormPage } from '@/pages/WorkItemFormPage';
import { WorkItemDetailPage } from '@/pages/WorkItemDetailPage';
import { TodoTodayPage } from '@/pages/TodoTodayPage';
import { WorkSummaryPage } from '@/pages/WorkSummaryPage';
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
import { DailyCheckReviewPage } from '@/pages/DailyCheckReview';
import { DeepCheckSettingsPage } from '@/pages/DeepCheckSettings';
import { KnowledgeHubPage } from '@/pages/KnowledgeHubPage';
import { HomePage } from '@/pages/HomePage';
import { UsersPage } from '@/pages/UsersPage';
import { AuditLogsPage } from '@/pages/AuditLogsPage';
import { ChangePasswordPage } from '@/pages/ChangePasswordPage';
import { AgentChat } from '@/components/agent';
import { Sidebar } from '@/components/layout';
import { NAV_WIDTH } from '@/stores/sidebarStore';
import { ToastProvider } from '@/components/common';
import { AuthGate } from '@/components/auth/AuthGate';

function RedirectWithId({ to, suffix = '' }: { to: string; suffix?: string }) {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`${to}/${id ?? ''}${suffix}`} replace />;
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
      <Sidebar />
      <div
        className="flex-1 min-w-0"
        style={{ marginLeft: NAV_WIDTH }}
      >
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/cluster-overview" element={<Dashboard />} />
              <Route path="/playbooks" element={<PlaybooksPage />} />
              {/* 업무 관리 — 정식 경로 */}
              <Route path="/tasks-mgmt" element={<WorkItemBoardPage />} />
              <Route path="/tasks-mgmt/new" element={<WorkItemFormPage />} />
              <Route path="/tasks-mgmt/:id" element={<WorkItemDetailPage />} />
              <Route path="/tasks-mgmt/:id/edit" element={<WorkItemDetailPage />} />
              {/* 레거시 경로 — /tasks-mgmt 로 리다이렉트 (북마크/외부 링크 호환) */}
              <Route path="/work-items" element={<Navigate to="/tasks-mgmt" replace />} />
              <Route path="/work-items/new" element={<Navigate to="/tasks-mgmt/new" replace />} />
              <Route path="/work-items/:id" element={<RedirectWithId to="/tasks-mgmt" />} />
              <Route path="/work-items/:id/edit" element={<RedirectWithId to="/tasks-mgmt" suffix="/edit" />} />
              <Route path="/issues" element={<Navigate to="/tasks-mgmt" replace />} />
              <Route path="/tasks" element={<Navigate to="/tasks-mgmt" replace />} />
              <Route path="/todo-today" element={<TodoTodayPage />} />
              <Route path="/work-summary" element={<WorkSummaryPage />} />
              <Route path="/members" element={<MemberBoardPage />} />
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
              <Route path="/infra-topology" element={<InfraTopologyPage />} />
              <Route path="/node-specs" element={<NodeSpecPage />} />
              <Route path="/services" element={<ServicesCatalogPage />} />
              <Route path="/services/:service" element={<ServiceHubPage />} />
              <Route path="/settings" element={<SettingsPage />} />
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
              <Route path="/wbs" element={<WbsFlowPage />} />
              <Route path="/incident-analysis" element={<IncidentAnalysisPage />} />
              <Route path="/packet-flow" element={<PacketFlowPage />} />
              <Route path="/ontology" element={<OntologyPage />} />
              <Route path="/trends" element={<TrendDigestPage />} />
              <Route path="/cilium-trace" element={<CiliumTracePage />} />
              <Route path="/daily-check/review/:clusterId" element={<DailyCheckReviewPage />} />
              <Route path="/daily-check/review" element={<DailyCheckReviewPage />} />
              <Route path="/daily-check/settings" element={<DeepCheckSettingsPage />} />
              <Route path="/docs" element={<KnowledgeHubPage />} />
              <Route path="/settings/users" element={<UsersPage />} />
              <Route path="/settings/audit-logs" element={<AuditLogsPage />} />
              <Route path="/me/change-password" element={<ChangePasswordPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
      </div>
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
