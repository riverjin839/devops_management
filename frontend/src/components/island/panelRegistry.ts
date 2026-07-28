import type { ComponentType } from 'react';

import { Dashboard } from '@/pages/Dashboard';
import { K8sManagePage } from '@/pages/K8sManagePage';
import { K8sAllocationPage } from '@/pages/K8sAllocationPage';
import { ClusterTrendsPage } from '@/pages/ClusterTrendsPage';
import { OpsCheckConsolePage } from '@/pages/OpsCheckConsolePage';
import { K8sLogsPage } from '@/pages/K8sLogsPage';
import { DailyCheckReviewPage } from '@/pages/DailyCheckReview';
import { LakeServicesPage } from '@/pages/LakeServicesPage';
import { PodBottleneckPage } from '@/pages/PodBottleneckPage';
import { KnowledgeHubPage } from '@/pages/KnowledgeHubPage';
import { ServicesCatalogPage } from '@/pages/ServicesCatalogPage';
import { PepServicesPage } from '@/pages/PepServicesPage';
import { AppServicesPage } from '@/pages/AppServicesPage';
import { PlaybooksPage } from '@/pages/PlaybooksPage';
import { WorkItemBoardPage } from '@/pages/WorkItemBoardPage';
import { TodoTodayPage } from '@/pages/TodoTodayPage';
import { SprintsPage } from '@/pages/SprintsPage';
import { MemberBoardPage } from '@/pages/MemberBoardPage';
import { ClusterManagePage } from '@/pages/ClusterManagePage';
import { VersionsPage } from '@/pages/VersionsPage';
import { BulkExecPage } from '@/pages/BulkExecPage';
import { EtcdCtlPage } from '@/pages/EtcdCtlPage';
import { BatchJobsPage } from '@/pages/BatchJobsPage';
import { McClientPage } from '@/pages/McClientPage';
import { IsilonNfsPage } from '@/pages/IsilonNfsPage';
import { KernelParamsPage } from '@/pages/KernelParamsPage';
import { InfraTopologyPage } from '@/pages/InfraTopologyPage';
import { NodeSpecPage } from '@/pages/NodeSpecPage';
import { ClusterLinksPage } from '@/pages/ClusterLinksPage';
import { NodeLabelsPage } from '@/pages/NodeLabelsPage';
import { NodeImagesPage } from '@/pages/NodeImagesPage';
import { CidrCalculatorPage } from '@/pages/CidrCalculatorPage';
import { K8sEventsPage } from '@/pages/K8sEventsPage';
import { IncidentAnalysisPage } from '@/pages/IncidentAnalysisPage';
import { PacketFlowPage } from '@/pages/PacketFlowPage';
import { CiliumTracePage } from '@/pages/CiliumTracePage';
import { ServiceTopologyPage } from '@/pages/ServiceTopologyPage';
import { ServiceArchitecturePage } from '@/pages/ServiceArchitecturePage';
import { ArchitecturePage } from '@/pages/ArchitecturePage';
import { OntologyPage } from '@/pages/OntologyPage';
import { TrendDigestPage } from '@/pages/TrendDigestPage';
import { WorkGuidePage } from '@/pages/WorkGuidePage';
import { CommandsPage } from '@/pages/CommandsPage';
import { OpsNotesPage } from '@/pages/OpsNotesPage';
import { WbsFlowPage } from '@/pages/WbsFlowPage';
import { MindMapPage } from '@/pages/MindMapPage';
import { WorkflowBoardPage } from '@/pages/WorkflowBoardPage';
import { JiraExcelImportPage } from '@/pages/JiraExcelImportPage';

/**
 * Your Island 패널로 임베드 가능한 화면 — 라우트 경로 → 페이지 컴포넌트.
 *
 * App.tsx 가 이미 모든 페이지를 정적 import 하므로 `React.lazy` 를 써도 청크가 갈라지지
 * 않는다. 그래서 여기서도 정적 import 로 두고, 대신 이 파일은 **컴포넌트를 export 하지
 * 않는다**(상수만) — `react-refresh/only-export-components` 경고를 피하기 위함.
 *
 * NAV_MAP 에 있으나 여기에 없는 경로는 패널 카탈로그에서 자동으로 빠진다. 그래서 App.tsx 에
 * 새 라우트가 생겨도 아일랜드가 깨지지 않고, 담을 수 없는 화면은 조용히 목록에서 제외된다.
 * 라우트 파라미터가 필요한 화면(`/services/:key` 등)도 같은 이유로 여기 넣지 않는다 —
 * 임베드 시 파라미터를 받을 수 없어 빈 화면이 되기 때문.
 */
export const PANEL_COMPONENTS: Record<string, ComponentType> = {
  '/cluster-overview': Dashboard,
  '/k8s-manage': K8sManagePage,
  '/k8s-allocation': K8sAllocationPage,
  '/cluster-trends': ClusterTrendsPage,
  '/ops-checks': OpsCheckConsolePage,
  '/k8s-logs': K8sLogsPage,
  '/daily-check/review': DailyCheckReviewPage,
  '/lake-services': LakeServicesPage,
  '/pod-bottleneck': PodBottleneckPage,
  '/docs': KnowledgeHubPage,
  '/services': ServicesCatalogPage,
  '/pep-services': PepServicesPage,
  '/app-services': AppServicesPage,
  '/playbooks': PlaybooksPage,
  '/tasks-mgmt': WorkItemBoardPage,
  '/todo-today': TodoTodayPage,
  '/sprints': SprintsPage,
  '/members': MemberBoardPage,
  '/cluster-manage': ClusterManagePage,
  '/versions': VersionsPage,
  '/bulk-exec': BulkExecPage,
  '/etcdctl': EtcdCtlPage,
  '/batch-jobs': BatchJobsPage,
  '/mc': McClientPage,
  '/isilon-nfs': IsilonNfsPage,
  '/kernel-params': KernelParamsPage,
  '/infra-topology': InfraTopologyPage,
  '/node-specs': NodeSpecPage,
  '/links': ClusterLinksPage,
  '/node-labels': NodeLabelsPage,
  '/node-images': NodeImagesPage,
  '/cidr': CidrCalculatorPage,
  '/k8s-events': K8sEventsPage,
  '/incident-analysis': IncidentAnalysisPage,
  '/packet-flow': PacketFlowPage,
  '/cilium-trace': CiliumTracePage,
  '/service-topology': ServiceTopologyPage,
  '/service-architecture': ServiceArchitecturePage,
  '/architecture': ArchitecturePage,
  '/ontology': OntologyPage,
  '/trends': TrendDigestPage,
  '/work-guides': WorkGuidePage,
  '/commands': CommandsPage,
  '/ops-notes': OpsNotesPage,
  '/wbs': WbsFlowPage,
  '/mindmap': MindMapPage,
  '/workflow': WorkflowBoardPage,
  '/jira-import': JiraExcelImportPage,
};

/**
 * 임베드가 부적절해 카탈로그에서 제외하는 경로.
 * - `/k9s`: WebSocket + xterm 전체화면 터미널 — 패널 안에서 정상 동작하지 않는다.
 * - `/settings`, `/daily-check/settings`: admin 전용 관리 화면(RequireAdmin).
 * - `/`: 홈 자신, `/island`: 아일랜드 자신 — 중첩 방지.
 */
export const ISLAND_DENYLIST = new Set<string>([
  '/k9s',
  '/settings',
  '/daily-check/settings',
  '/',
  '/island',
]);

/** 아일랜드 하나가 담을 수 있는 패널 수 상한.
 *  백엔드 `app/schemas/island.py` 의 `MAX_PANELS` 와 반드시 같아야 한다 — 어긋나면 프론트가
 *  허용한 추가가 서버에서 422 로 거절된다. */
export const MAX_PANELS = 20;

/** 해당 경로를 아일랜드 패널로 담을 수 있는가. */
export function isEmbeddable(path: string): boolean {
  return !ISLAND_DENYLIST.has(path) && path in PANEL_COMPONENTS;
}

/** 패널 경로별로 추가 권한 확인이 필요한 feature 키 (App.tsx 의 RequireFeature 와 동일). */
export const PANEL_FEATURE_GUARD: Record<string, string> = {
  '/wbs': 'wbs',
};
