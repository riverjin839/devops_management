import { useCallback, useMemo, type ComponentType } from 'react';
import { NAV_MAP, GROUPS, type GroupId } from '@/components/layout/navConfig';
import { useUiSettings } from './useUiSettings';
import { useServiceCatalog } from './useServiceCatalog';
import { useFeatureAccess, canAccessFeature } from './useFeatureAccess';
import { useAuthStore } from '@/stores/authStore';

export interface NavEntry {
  defaultLabel: string;
  icon: ComponentType<{ className?: string }>;
  iconColor?: string;
  iconSize?: string;
}

export interface NavCatalog {
  /** 정적 NAV_MAP 위에 ui_settings 의 서비스 카탈로그(`/services/:key`)를 덧씌운 맵. */
  navMap: Record<string, NavEntry>;
  /** 동적으로 추가된 서비스 경로들 (`/services/:key`). */
  servicePaths: string[];
  /** ui_settings 의 navLabels 오버라이드를 반영한 표시 라벨. */
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
 */
export function useNavCatalog(): NavCatalog {
  const { data: settings } = useUiSettings();
  const services = useServiceCatalog();
  const currentUser = useAuthStore((s) => s.user);
  const { data: featureAccess } = useFeatureAccess();

  const navLabels = useMemo(() => settings?.navLabels || {}, [settings?.navLabels]);

  const navMap = useMemo(() => {
    const m: Record<string, NavEntry> = { ...NAV_MAP };
    for (const s of services) {
      if (s.key === 'other') continue;
      m[`/services/${s.key}`] = { defaultLabel: s.label, icon: s.icon };
    }
    return m;
  }, [services]);

  const servicePaths = useMemo(
    () => services.filter((s) => s.key !== 'other').map((s) => `/services/${s.key}`),
    [services],
  );

  const getLabel = useCallback(
    (path: string) => navLabels[path] || navMap[path]?.defaultLabel || path,
    [navLabels, navMap],
  );

  const featureAllowed = useCallback(
    (path: string) => path !== '/wbs' || canAccessFeature(featureAccess, 'wbs', currentUser),
    [featureAccess, currentUser],
  );

  return { navMap, servicePaths, getLabel, featureAllowed };
}

/** 경로 → 소속 그룹 라벨. 패널 피커에서 화면을 그룹별로 묶을 때 사용. */
export function groupLabelForPath(path: string): { id: GroupId; label: string } | null {
  if (path.startsWith('/services/')) {
    const g = GROUPS.find((x) => x.id === 'services');
    return g ? { id: g.id, label: g.label } : null;
  }
  for (const g of GROUPS) {
    if (g.paths.includes(path)) return { id: g.id, label: g.label };
  }
  return null;
}
