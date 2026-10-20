import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { NAV_MAP } from '@/components/layout/navConfig';
import { useUiSettings } from '@/hooks/useUiSettings';

/**
 * 메뉴 표시 라벨(로케일 반영) — 관리자가 Settings ▸ 메뉴 이름 편집(`NavMenuManager`)에서 지정한
 * 커스텀 라벨이 있으면 그것이 우선이고 번역하지 않는다(조직이 고른 이름). 없을 때만 `nav.page.*` 번역.
 *
 * 커스텀 라벨이 한국어 기본값과 글자까지 같으면(기본값을 그대로 저장한 경우) 오버라이드로 보지 않는다 —
 * 그래야 영어 화면에서 한국어로 고정되지 않는다.
 *
 * `useNavCatalog().getLabel` 은 아직 한국어 기본 라벨을 돌려준다(아일랜드 피커·Settings 등 비셸 화면용).
 */
export function useNavLabel(): (path: string) => string {
  const { t } = useTranslation();
  const { data: settings } = useUiSettings();
  const navLabels = settings?.navLabels;
  return useCallback(
    (path: string) => {
      const entry = NAV_MAP[path];
      const override = navLabels?.[path];
      if (override && override !== entry?.defaultLabel) return override;
      return entry ? t(`nav.page.${entry.labelKey}`) : path;
    },
    [navLabels, t],
  );
}
