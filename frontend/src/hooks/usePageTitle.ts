import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useNavCatalog } from '@/hooks/useNavCatalog';
import { useUiSettings } from '@/hooks/useUiSettings';
import { DEFAULT_TITLE } from '@/components/layout/navConfig';

const PRODUCT_FULL_NAME = 'Platform Engineering Portal';

/**
 * D-075 — 라우트마다 `document.title` 을 "화면명 · 앱 제목" 으로 맞춘다. 브라우저 탭·히스토리·
 * 북마크에서 어느 화면인지 구분되게 하는 것이 목적이다.
 *
 * - 화면명은 `NAV_MAP` 최장 접두 일치 + 관리자 라벨 오버라이드(`useNavCatalog().getLabel`)를
 *   따르므로 사이드바에 보이는 이름과 항상 같다(`/clusters/:id` → "클러스터 상세").
 * - 앱 제목은 Settings 의 `appTitle`(기본 `PEP`).
 * - NAV_MAP 에 없는 경로(비밀번호 변경 등)는 "앱 제목 — Platform Engineering Portal" 로 둔다.
 * - k9s/SSH 팝업은 AppShell 밖에서 렌더되며 자기 제목을 직접 설정하므로 여기 영향을 받지 않는다.
 */
export function usePageTitle() {
  const location = useLocation();
  const { navMap, getLabel } = useNavCatalog();
  const { data: settings } = useUiSettings();
  const appTitle = settings?.appTitle?.trim() || DEFAULT_TITLE;

  useEffect(() => {
    const path = location.pathname;
    const match = path === '/'
      ? '/'
      : Object.keys(navMap)
          .filter((p) => p !== '/' && (path === p || path.startsWith(`${p}/`)))
          .sort((a, b) => b.length - a.length)[0];
    document.title = match
      ? `${getLabel(match)} · ${appTitle}`
      : `${appTitle} — ${PRODUCT_FULL_NAME}`;
  }, [location.pathname, navMap, getLabel, appTitle]);
}
