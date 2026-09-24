import type { Accent, Theme } from '@/stores/themeStore';

/**
 * 각 테마의 대표 색(HSL 트리플, `hsl()` 없이) — 실제로 테마를 전환하지 않고도 사용자 메뉴
 * 목록(D-072 스와치)과 Settings "테마 갤러리"에서 미리보기를 보여주기 위한 정적 스냅샷이다.
 * `index.css` 의 각 테마 블록(`html.<theme>`) 에서 그대로 가져온 값 — 그 블록이 바뀌면
 * 여기도 함께 갱신해야 한다. `system` 은 OS 설정을 따라가 고정 색이 없으므로 제외.
 */
export const THEME_SWATCH: Partial<Record<Theme, { bg: string; primary: string; secondary: string }>> = {
  light:           { bg: '210 40% 98%', primary: '200 98% 32%',  secondary: '210 33% 95%' },
  dark:            { bg: '220 18% 7%',  primary: '212 100% 63%', secondary: '220 14% 16%' },
  comfort:         { bg: '60 15% 98%',  primary: '150 45% 24%',  secondary: '140 22% 95%' },
  'high-contrast': { bg: '0 0% 100%',   primary: '220 100% 30%', secondary: '0 0% 94%' },
  umber:           { bg: '8 14% 11%',   primary: '45 96% 52%',   secondary: '16 14% 21%' },
  'umber-light':   { bg: '40 28% 95%',  primary: '45 96% 52%',   secondary: '35 24% 90%' },
  plaster:         { bg: '42 32% 94%',  primary: '216 32% 40%',  secondary: '36 24% 90%' },
};

/** 강조색 대표 색(라이트 바탕 기준 primary) — index.css 의 `html.light[data-accent]` 블록과 같은 값. */
export const ACCENT_SWATCH: Record<Accent, string> = {
  blue:   '200 98% 32%',
  teal:   '182 75% 27%',
  green:  '150 50% 32%',
  amber:  '32 92% 33%',
  coral:  '12 70% 44%',
  violet: '265 60% 56%',
};

export const ACCENT_LABEL: Record<Accent, string> = {
  blue: '블루', teal: '틸', green: '그린', amber: '앰버', coral: '코랄', violet: '바이올렛',
};
