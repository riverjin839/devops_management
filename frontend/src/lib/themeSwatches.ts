import type { Theme } from '@/stores/themeStore';

/**
 * 각 테마의 대표 색(HSL 트리플, `hsl()` 없이) — 실제로 테마를 전환하지 않고도 사용자 메뉴
 * 목록(D-072 스와치)과 Settings "테마 갤러리"에서 미리보기를 보여주기 위한 정적 스냅샷이다.
 * `index.css` 의 각 테마 블록(`html.<theme>`) 에서 그대로 가져온 값 — 그 블록이 바뀌면
 * 여기도 함께 갱신해야 한다. `system` 은 OS 설정을 따라가 고정 색이 없으므로 제외.
 */
export const THEME_SWATCH: Partial<Record<Theme, { bg: string; primary: string; secondary: string }>> = {
  default:            { bg: '36 38% 96%',  primary: '17 60% 45%',  secondary: '35 30% 92%'  },
  light:               { bg: '210 40% 98%', primary: '200 98% 32%', secondary: '210 33% 95%' },
  dark:                { bg: '220 18% 7%',  primary: '212 100% 63%', secondary: '220 14% 16%' },
  comfort:             { bg: '60 15% 98%',  primary: '150 45% 24%', secondary: '140 22% 95%' },
  'burnt-sienna':      { bg: '40 30% 98%',  primary: '10 70% 47%',  secondary: '32 40% 94%'  },
  'tuscan-sunset':     { bg: '28 40% 98%',  primary: '10 70% 47%',  secondary: '28 55% 94%'  },
  electropop:          { bg: '260 25% 8%',  primary: '299 100% 60%', secondary: '260 18% 16%' },
  'summer-breeze':     { bg: '35 45% 96%',  primary: '5 85% 68%',   secondary: '198 55% 90%' },
  'wildflower-meadow': { bg: '54 60% 97%',  primary: '42 95% 48%',  secondary: '198 55% 90%' },
  'tropical-punch':    { bg: '50 60% 97%',  primary: '20 90% 60%',  secondary: '350 70% 93%' },
};
