import { useSyncExternalStore } from 'react';

/**
 * 캔버스·WebGL(three.js)처럼 Tailwind 클래스를 쓸 수 없는 렌더러용 테마 토큰 색 (D-120).
 *
 * `--chart-*`·`--background` 같은 CSS 변수(`H S% L%` 형식)를 읽어 렌더러가 받는 색 문자열로 바꾼다.
 * 테마가 바뀌면 값이 달라지므로, 색을 계산하는 memo 의 의존성에 `useThemeColorKey()` 를 넣는다.
 */

const FALLBACK = '215 15% 50%'; // --chart-8 slate

interface TokenColorOpts {
  /** 0~1 불투명도. 주면 `hsla(...)` 를 반환한다. */
  alpha?: number;
  /** 명도 가감(%p). 같은 계열 안에서 두 종류를 구분할 때 쓴다(양수 = 밝게). */
  lighten?: number;
}

function readToken(token: string): string {
  if (typeof document === 'undefined') return FALLBACK;
  const v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return v || FALLBACK;
}

/** `cssVarColor('--chart-1')` → `hsl(217, 70%, 50%)`. 정의가 없으면 slate 로 폴백한다. */
export function cssVarColor(token: string | undefined, opts: TokenColorOpts = {}): string {
  const [h = '215', s = '15%', l = '50%'] = readToken(token ?? '--chart-8').split(/\s+/);
  let light = l;
  if (opts.lighten) {
    const n = Number.parseFloat(l);
    if (Number.isFinite(n)) light = `${Math.min(95, Math.max(5, n + opts.lighten))}%`;
  }
  return opts.alpha === undefined
    ? `hsl(${h}, ${s}, ${light})`
    : `hsla(${h}, ${s}, ${light}, ${opts.alpha})`;
}

// ── 테마 변경 감지: <html> 의 class(바탕 테마)·data-accent(강조색) 변화를 구독한다 ──
function subscribe(onChange: () => void): () => void {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-accent'] });
  return () => obs.disconnect();
}

function snapshot(): string {
  const el = document.documentElement;
  return `${el.className}|${el.getAttribute('data-accent') ?? ''}`;
}

/** 테마·강조색이 바뀔 때마다 달라지는 키 — 토큰 색 memo 의 의존성으로 쓴다. */
export function useThemeColorKey(): string {
  return useSyncExternalStore(subscribe, snapshot, () => '');
}
