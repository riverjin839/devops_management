import { useCallback, type ComponentType } from 'react';
import { NAV_MAP, GROUPS, type GroupId } from '@/components/layout/navConfig';
import type { NavGroupKey } from '@/i18n/resources/ko';
import { useNavLabel } from '@/i18n/useNavLabel';
import { useFeatureAccess, canAccessFeature } from './useFeatureAccess';
import { useAuthStore } from '@/stores/authStore';

export interface NavEntry {
  defaultLabel: string;
  icon: ComponentType<{ className?: string }>;
  iconColor?: string;
  iconSize?: string;
}

export interface NavCatalog {
  navMap: Record<string, NavEntry>;
  /** 표시 라벨 — 관리자 커스텀 라벨(ui_settings.navLabels)이 우선, 없으면 현재 로케일의 `nav.page.*` 번역. */
  getLabel: (path: string) => string;
  /** 기능별 접근 제어 통과 여부. */
  featureAllowed: (path: string) => boolean;
}

/**
 * 사이드바와 Your Island 패널 피커가 공유하는 네비게이션 카탈로그.
 *
 * 원래 Sidebar.tsx 안에만 있던 동적 navMap / getLabel / featureAllowed 를 추출한 것으로,
 * 두 화면이 같은 라벨 오버라이드와 같은 권한 필터를 쓰도록 보장한다 — 그래야 관리자가
 * 메뉴명을 바꾸거나 기능을 숨겼을 때 아일랜드 카탈로그에서 새어나가지 않는다.
 *
 * R-6 — `getLabel` 은 셸과 같은 `useNavLabel()` 경로다(커스텀 라벨 → 로케일 번역).
 */
export function useNavCatalog(): NavCatalog {
  const currentUser = useAuthStore((s) => s.user);
  const { data: featureAccess } = useFeatureAccess();
  const getLabel = useNavLabel();

  // feature_access 맵의 키는 라우트 경로 자체다(예: '/wbs') — Settings "접근 제어"에서
  // 화면 하나를 끄면 이 한 줄로 사이드바 메뉴/Island 화면추가 피커/이미 담긴 Island 패널까지
  // 동시에 막힌다. 규칙이 없는 경로는 canAccessFeature 가 기본 허용을 돌려준다.
  const featureAllowed = useCallback(
    (path: string) => canAccessFeature(featureAccess, path, currentUser),
    [featureAccess, currentUser],
  );

  return { navMap: NAV_MAP, getLabel, featureAllowed };
}

/**
 * 경로 → 소속 그룹(id + 한국어 기본 라벨 + 번역 키). 패널 피커에서 화면을 그룹별로 묶을 때 사용.
 * 화면에 그릴 때 로케일을 따르려면 `t(\`nav.group.${labelKey}\`)` 를 쓴다.
 */
export function groupLabelForPath(path: string): { id: GroupId; label: string; labelKey: NavGroupKey } | null {
  for (const g of GROUPS) {
    if (g.paths.includes(path)) return { id: g.id, label: g.label, labelKey: g.labelKey };
  }
  return null;
}
