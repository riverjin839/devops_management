import type { ComponentType } from 'react';
import {
  LayoutGrid, Boxes, Gauge, TrendingUp, Activity, Bell, ScrollText, Zap, ClipboardCheck,
  KeyRound, Tags, Package, GitCommit, Database, Cpu, TerminalSquare,
} from 'lucide-react';
import { ClusterDetailPage } from '@/pages/ClusterDetailPage';
import { K8sManagePage } from '@/pages/K8sManagePage';
import { K8sAllocationPage } from '@/pages/K8sAllocationPage';
import { ClusterTrendsPage } from '@/pages/ClusterTrendsPage';
import { ObservabilityPage } from '@/pages/ObservabilityPage';
import { K8sEventsPage } from '@/pages/K8sEventsPage';
import { K8sLogsPage } from '@/pages/K8sLogsPage';
import { IncidentAnalysisPage } from '@/pages/IncidentAnalysisPage';
import { DailyCheckReviewPage } from '@/pages/DailyCheckReview';
import { K8sRbacPage } from '@/pages/K8sRbacPage';
import { NodeLabelsPage } from '@/pages/NodeLabelsPage';
import { NodeImagesPage } from '@/pages/NodeImagesPage';
import { VersionsPage } from '@/pages/VersionsPage';
import { EtcdCtlPage } from '@/pages/EtcdCtlPage';
import { KernelParamsPage } from '@/pages/KernelParamsPage';
import { HubTerminalsView } from './HubTerminalsView';

/** 허브 카테고리 탭(1행). 순서가 곧 탭 순서다. */
export type HubCategory = 'overview' | 'resources' | 'allocation' | 'observe' | 'logs' | 'checks' | 'config' | 'console';

export const HUB_CATEGORIES: ReadonlyArray<{ id: HubCategory; label: string }> = [
  { id: 'overview', label: '개요' },
  { id: 'resources', label: '리소스' },
  { id: 'allocation', label: '자원' },
  { id: 'observe', label: '관측' },
  { id: 'logs', label: '로그' },
  { id: 'checks', label: '점검' },
  { id: 'config', label: '구성' },
  { id: 'console', label: '콘솔' },
];

export interface HubView {
  /** URL 세그먼트 `/k8s/:clusterId/<id>`. */
  id: string;
  category: HubCategory;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /**
   * 이 뷰가 흡수한 옛 화면의 NAV_MAP 경로. 접근 제어(Settings ▸ 접근 제어 `feature_access`)와
   * 관리자 라벨 오버라이드는 이 키로 계속 동작한다 — 허브 URL(`/k8s/...`)은 longest-prefix 게이트가
   * `/k8s` 만 매치하므로, 뷰 단위 게이팅은 허브가 이 키로 직접 한다(홈 배치잡 서브탭과 같은 방식).
   */
  navKey: string;
  /** 한 뷰가 여러 옛 화면을 대신할 때(콘솔 ▸ 터미널 = k9s + 노드 SSH) — 하나라도 허용이면 탭을 보인다. */
  extraNavKeys?: readonly string[];
  component: ComponentType;
}

/**
 * K8s 클러스터 허브 서브뷰 레지스트리 — 기존 per-cluster 화면을 **그대로** 마운트한다.
 * 화면 쪽은 `lib/k8sHub.ts` 컨텍스트로 레일·헤더·셸을 허브에 넘기고, 클러스터 선택은
 * `useClusterRouteParam` 분기로 허브 값을 받는다.
 *
 * 2단계(2026-10-23)로 구성(RBAC·노드 라벨·노드 이미지·버전)·콘솔(etcdctl·커널 파라미터·터미널 실행 카드)을 더했다.
 * 노드 라벨은 단독 화면(`/node-labels`, 전체 클러스터 모드)도 유지한다 — 허브 뷰는 선택 클러스터만.
 * k9s·노드 SSH 는 전체 높이 웹 터미널이라 임베드하지 않고 `HubTerminalsView` 가 단독 화면으로 연다.
 * 3단계(진단)는 후속 — 이 목록에 항목을 더하고 App.tsx 의 옛 라우트를 `RedirectToHub` 로 바꾸면 된다.
 */
export const HUB_VIEWS: readonly HubView[] = [
  { id: 'overview', category: 'overview', label: '클러스터 상세', icon: LayoutGrid, navKey: '/clusters', component: ClusterDetailPage },
  { id: 'manage', category: 'resources', label: 'K8s 상세 관리', icon: Boxes, navKey: '/k8s-manage', component: K8sManagePage },
  { id: 'allocation', category: 'allocation', label: 'K8s 자원 관리', icon: Gauge, navKey: '/k8s-allocation', component: K8sAllocationPage },
  { id: 'trends', category: 'observe', label: '클러스터 추이', icon: TrendingUp, navKey: '/cluster-trends', component: ClusterTrendsPage },
  { id: 'metrics', category: 'observe', label: '관측 지표', icon: Activity, navKey: '/observability', component: ObservabilityPage },
  { id: 'events', category: 'observe', label: '실시간 이벤트', icon: Bell, navKey: '/k8s-events', component: K8sEventsPage },
  { id: 'logs', category: 'logs', label: '파드 로그', icon: ScrollText, navKey: '/k8s-logs', component: K8sLogsPage },
  { id: 'incident', category: 'logs', label: 'AI 장애 분석', icon: Zap, navKey: '/incident-analysis', component: IncidentAnalysisPage },
  { id: 'review', category: 'checks', label: '점검 결과 리뷰', icon: ClipboardCheck, navKey: '/daily-check/review', component: DailyCheckReviewPage },
  { id: 'rbac', category: 'config', label: '접근 권한', icon: KeyRound, navKey: '/k8s-rbac', component: K8sRbacPage },
  { id: 'node-labels', category: 'config', label: '노드 라벨', icon: Tags, navKey: '/node-labels', component: NodeLabelsPage },
  { id: 'node-images', category: 'config', label: '노드 이미지', icon: Package, navKey: '/node-images', component: NodeImagesPage },
  { id: 'versions', category: 'config', label: '버전 / 설정', icon: GitCommit, navKey: '/versions', component: VersionsPage },
  { id: 'etcdctl', category: 'console', label: 'etcdctl', icon: Database, navKey: '/etcdctl', component: EtcdCtlPage },
  { id: 'kernel-params', category: 'console', label: '커널 파라미터', icon: Cpu, navKey: '/kernel-params', component: KernelParamsPage },
  { id: 'terminals', category: 'console', label: '터미널', icon: TerminalSquare, navKey: '/k9s', extraNavKeys: ['/node-ssh'], component: HubTerminalsView },
];

export const DEFAULT_HUB_VIEW = 'overview';

/** 뷰의 접근 제어 판정 — 대표 경로 또는 추가 경로 중 하나라도 허용이면 보인다. */
export function hubViewAllowed(v: HubView, featureAllowed: (path: string) => boolean): boolean {
  return featureAllowed(v.navKey) || (v.extraNavKeys ?? []).some(featureAllowed);
}

export function findHubView(id: string | undefined): HubView | undefined {
  return HUB_VIEWS.find((v) => v.id === id);
}

/** 옛 경로 → 허브 뷰 id (App.tsx 의 리다이렉트가 쓴다). */
export function hubViewForNavKey(navKey: string): HubView | undefined {
  return HUB_VIEWS.find((v) => v.navKey === navKey);
}
