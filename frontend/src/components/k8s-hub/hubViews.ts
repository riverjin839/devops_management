import type { ComponentType } from 'react';
import {
  LayoutGrid, Boxes, Gauge, TrendingUp, Activity, Bell, ScrollText, Zap, ClipboardCheck,
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

/** 허브 카테고리 탭(1행). 순서가 곧 탭 순서다. */
export type HubCategory = 'overview' | 'resources' | 'allocation' | 'observe' | 'logs' | 'checks';

export const HUB_CATEGORIES: ReadonlyArray<{ id: HubCategory; label: string }> = [
  { id: 'overview', label: '개요' },
  { id: 'resources', label: '리소스' },
  { id: 'allocation', label: '자원' },
  { id: 'observe', label: '관측' },
  { id: 'logs', label: '로그' },
  { id: 'checks', label: '점검' },
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
  component: ComponentType;
}

/**
 * K8s 클러스터 허브 서브뷰 레지스트리 — 기존 per-cluster 화면을 **그대로** 마운트한다.
 * 화면 쪽은 `lib/k8sHub.ts` 컨텍스트로 레일·헤더·셸을 허브에 넘기고, 클러스터 선택은
 * `useClusterRouteParam` 분기로 허브 값을 받는다.
 *
 * 2단계(구성·콘솔: RBAC·노드 라벨·노드 이미지·버전·etcdctl·커널 파라미터·k9s/노드 SSH 실행 카드)와
 * 3단계(진단)는 후속 PR — 이 목록에 항목을 더하고 App.tsx 의 옛 라우트를 `RedirectToHub` 로 바꾸면 된다.
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
];

export const DEFAULT_HUB_VIEW = 'overview';

export function findHubView(id: string | undefined): HubView | undefined {
  return HUB_VIEWS.find((v) => v.id === id);
}

/** 옛 경로 → 허브 뷰 id (App.tsx 의 리다이렉트가 쓴다). */
export function hubViewForNavKey(navKey: string): HubView | undefined {
  return HUB_VIEWS.find((v) => v.navKey === navKey);
}
