import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type PageDensity = 'console' | 'hub' | 'doc';

interface PageShellProps {
  /**
   * 화면 성격 — DESIGN_SYSTEM.md §12.12-5(D-123).
   * - `console`: exec·표·매트릭스. 폭 제한 없음, `py-3 pr-3`(좌측은 ClusterSidebar 에 flush).
   * - `hub`: 목록·대시보드·허브. `px-6 py-5`, `max-w-[1600px]` 좌정렬.
   * - `doc`: 상세·폼·가이드 읽기. `max-w-4xl mx-auto px-8 py-8`.
   */
  density: PageDensity;
  /** console 전용 — 좌측에 ClusterSidebar 가 없으면 false 로 줘서 `pl-3` 을 더한다(기본 true). */
  sidebar?: boolean;
  /** 렌더 태그(기본 `main`). 페이지 안에 이미 `<main>` 이 있으면 `div`. */
  as?: 'main' | 'div' | 'section';
  className?: string;
  children: ReactNode;
}

const DENSITY_CLS: Record<PageDensity, string> = {
  console: 'py-3 pr-3',
  hub: 'px-6 py-5 max-w-[1600px]',
  doc: 'max-w-4xl mx-auto px-8 py-8',
};

/**
 * 페이지 본문 컨테이너 — 루트 패딩·폭을 밀도 3종으로만 고정한다(D-123).
 * 이전엔 루트 패딩 16종·폭 11종(1200~2400px)이 페이지마다 손으로 흩어져 있었다.
 * 페이지 루트(`app-min-h-screen bg-background` + ClusterSidebar flex 행)는 그대로 두고,
 * 패딩을 갖던 본문 컨테이너를 이것으로 바꾼다. 세로 간격(`space-y-*`)·flex 는 className 으로.
 */
export function PageShell({ density, sidebar = true, as: Tag = 'main', className, children }: PageShellProps) {
  return (
    <Tag
      className={cn(
        'flex-1 min-w-0 w-full',
        DENSITY_CLS[density],
        density === 'console' && !sidebar && 'pl-3',
        className,
      )}
    >
      {children}
    </Tag>
  );
}
