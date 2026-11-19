import { useCallback, useEffect, useLayoutEffect, useRef, type FocusEvent, type PointerEvent, type RefObject } from 'react';
import type { NavStyle } from '@/stores/navStyleStore';

/**
 * 메인 레일 활성 표시(스포트라이트 / 글로우 노치) — 표시자 1개를 레일 위에서 `translateY` 로 옮긴다.
 *
 * 위치는 `<aside>` 의 CSS 변수 `--nav-ind-y`(px, 레일 상단 기준 아이콘 중심) 하나로만 전달하고,
 * 상태는 data 속성으로 둔다 — 마우스 이동마다 React 를 다시 그리지 않으려고 DOM 에 직접 쓴다.
 *   - `data-nav-ind="on|off"` : 표시자 보임 여부(활성 아이콘이 없거나 스크롤로 가려지면 off)
 *   - `data-nav-following`    : 마우스를 연속으로 따라가는 중(짧은 transition)
 *   - `data-nav-ready`        : 첫 배치가 끝남(그 전엔 transition 없음 — 로드 때 위에서 미끄러져 오지 않게)
 * 그리는 쪽은 `RailIndicator.tsx`, 모양·색·transition 은 `index.css` 의 "메인 레일 활성 표시" 블록, 규격은 DESIGN_SYSTEM.md §12.15.
 *
 * 마우스 따라가기는 연속 고정이다: 메뉴 영역(`[data-rail-item]` 첫 아이콘 ~ 마지막 아이콘 중심) 안에서
 * 포인터 높이를 그대로 따라가다가 SETTLE_MS 동안 멈추면 가장 가까운 아이콘에 붙고, 레일을 벗어나면 현재
 * 페이지 위치로 돌아간다. 페이지 이동은 여전히 클릭으로만 한다. 모션 줄이기 환경에서는 아이콘 단위로 즉시 이동.
 */

const ITEM_SELECTOR = '[data-rail-item]';
const ACTIVE_SELECTOR = '[data-rail-item][aria-current="page"]';
const SETTLE_MS = 160;

function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

interface UseRailIndicatorArgs {
  railRef: RefObject<HTMLElement | null>;
  navRef: RefObject<HTMLElement | null>;
  navStyle: NavStyle;
  /** 활성 아이콘이 바뀌는 기준(현재 경로). */
  activeKey: string;
  /** 레일 아이콘 구성이 바뀌는 기준(설치 앱 목록 등) — 바뀌면 위치를 다시 잰다. */
  layoutKey: string;
}

export function useRailIndicator({ railRef, navRef, navStyle, activeKey, layoutKey }: UseRailIndicatorArgs) {
  const enabled = navStyle !== 'classic';
  const settleTimer = useRef<number | undefined>(undefined);
  const previewing = useRef(false);

  const clearSettle = () => {
    if (settleTimer.current !== undefined) { window.clearTimeout(settleTimer.current); settleTimer.current = undefined; }
  };

  const write = useCallback((y: number | null, following = false) => {
    const rail = railRef.current;
    if (!rail) return;
    if (y === null) {
      rail.dataset.navInd = 'off';
    } else {
      rail.dataset.navInd = 'on';
      rail.style.setProperty('--nav-ind-y', `${Math.round(y * 10) / 10}px`);
    }
    if (following) rail.dataset.navFollowing = '';
    else delete rail.dataset.navFollowing;
  }, [railRef]);

  const centerOf = useCallback((el: Element) => {
    const rail = railRef.current;
    if (!rail) return 0;
    const r = el.getBoundingClientRect();
    return r.top - rail.getBoundingClientRect().top + r.height / 2;
  }, [railRef]);

  /** 현재 페이지 아이콘 위치로. 아이콘이 없거나 메뉴 스크롤 밖이면 숨긴다. */
  const place = useCallback(() => {
    const nav = navRef.current;
    if (!enabled || !nav) { write(null); return; }
    const active = nav.querySelector(ACTIVE_SELECTOR);
    if (!active) { write(null); return; }
    const nr = nav.getBoundingClientRect();
    const ar = active.getBoundingClientRect();
    if (ar.bottom < nr.top || ar.top > nr.bottom) { write(null); return; }
    write(centerOf(active));
  }, [enabled, navRef, centerOf, write]);

  useLayoutEffect(() => {
    if (!previewing.current) place();
  }, [place, activeKey, layoutKey]);

  // 첫 배치 이후에만 transition 을 켠다.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const id = window.requestAnimationFrame(() => { rail.dataset.navReady = ''; });
    return () => window.cancelAnimationFrame(id);
  }, [railRef]);

  // 창 크기·메뉴 스크롤이 바뀌면 다시 잰다(따라가는 중엔 포인터가 위치를 정한다).
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const onChange = () => { if (!previewing.current) place(); };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onChange) : null;
    ro?.observe(nav);
    nav.addEventListener('scroll', onChange, { passive: true });
    window.addEventListener('resize', onChange);
    return () => {
      ro?.disconnect();
      nav.removeEventListener('scroll', onChange);
      window.removeEventListener('resize', onChange);
    };
  }, [navRef, place]);

  useEffect(() => clearSettle, []);

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const nav = navRef.current;
    const rail = railRef.current;
    if (!enabled || !nav || !rail || e.pointerType === 'touch') return;
    const centers = Array.from(nav.querySelectorAll(ITEM_SELECTOR)).map(centerOf);
    if (centers.length === 0) return;
    const y = e.clientY - rail.getBoundingClientRect().top;
    const nearest = centers.reduce((best, c) => (Math.abs(c - y) < Math.abs(best - y) ? c : best), centers[0]);
    previewing.current = true;
    clearSettle();
    if (prefersReducedMotion()) { write(nearest); return; }
    const min = centers[0];
    const max = centers[centers.length - 1];
    write(Math.min(max, Math.max(min, y)), true);
    settleTimer.current = window.setTimeout(() => { settleTimer.current = undefined; write(nearest); }, SETTLE_MS);
  };

  const onPointerLeave = () => {
    previewing.current = false;
    clearSettle();
    place();
  };

  // 키보드 포커스도 같은 방식으로 미리 보여준다.
  const onFocus = (e: FocusEvent<HTMLElement>) => {
    if (!enabled) return;
    const item = (e.target as HTMLElement).closest(ITEM_SELECTOR);
    if (!item) return;
    previewing.current = true;
    clearSettle();
    write(centerOf(item));
  };

  const onBlur = (e: FocusEvent<HTMLElement>) => {
    if (navRef.current?.contains(e.relatedTarget as Node | null)) return;
    previewing.current = false;
    place();
  };

  return { onPointerMove, onPointerLeave, onFocus, onBlur };
}
