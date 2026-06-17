import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { NAV_WIDTH } from '@/stores/sidebarStore';
import { useUiSettings } from '@/hooks/useUiSettings';
import { resolvePageStyle, pageStyleToCss } from '@/lib/pageStyles';

/**
 * 본문 영역 래퍼 — 현재 라우트에 대한 "화면 UI 설정"(페이지별 폰트/크기/글자색/배경색)을
 * 적용한다. 전 페이지 공통 기본(__default__) 위에 해당 경로 오버라이드를 병합해서 inline 으로 입힌다.
 * 사이드바는 이 래퍼 밖(fixed)이라 영향받지 않는다.
 */
export function PageStyleProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const { data: settings } = useUiSettings();
  const eff = resolvePageStyle(settings?.pageStyles, location.pathname);

  return (
    <div
      className="flex-1 min-w-0"
      style={{ marginLeft: NAV_WIDTH, ...pageStyleToCss(eff) }}
    >
      {children}
    </div>
  );
}
