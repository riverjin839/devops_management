import { create } from 'zustand';

/**
 * 테마 모드.
 * - `default`        : 기본 테마 — Anthropic Claude 브랜드 톤 (따뜻한 페이퍼 배경 +
 *                      큰 radius + 은은한 그림자 + 코랄 #D97757 accent). 신규 사용자
 *                      첫 진입 시 보이는 화면.
 * - `comfort`        : 크림 배경 + 딥그린 액센트 + 화이트 카드 + 큰 radius(16px) —
 *                      부드럽고 편안한 대시보드 톤 (Donezo-inspired).
 * - `burnt-sienna`   : 테라코타/베이지/샌드/시에나 — 따뜻한 대지색 팔레트 (Figma
 *                      색상 조합 라이브러리 "Burnt Sienna" 참고).
 * - `tuscan-sunset`  : 테라코타/피치/모브/러스트 — 노을톤 팔레트 ("Tuscan Sunset" 참고).
 * - `electropop`     : 인디고/라임/오렌지/마젠타 네온 액센트의 비비드 다크 테마
 *                      ("Electropop" 참고) — 이 앱에서 유일한 비비드 다크 테마.
 * - `summer-breeze`   : 옐로우/코랄/스카이블루/샌드 — 여름 해변 톤 ("Summer Breeze" 참고).
 * - `wildflower-meadow`: 데이지화이트/버터컵앰버/스카이블루/그라스그린 — 봄 들판 톤
 *                      ("Wildflower Meadow" 참고).
 * - `tropical-punch`  : 망고오렌지/파파야핑크/파인애플옐로우/딥틸 — 트로피컬 톤
 *                      ("Tropical Punch" 참고).
 * - `light` / `dark` : Databricks-leaning 라이트 / 다크 (대안).
 * - `system`         : OS 환경설정 따라가는 라이트/다크.
 */
export type Theme =
  | 'default' | 'comfort' | 'burnt-sienna' | 'tuscan-sunset' | 'electropop'
  | 'summer-breeze' | 'wildflower-meadow' | 'tropical-punch'
  | 'dark' | 'light' | 'system';

/** `system` 을 제외하고, 자체 완결된 토큰 세트를 가진 테마 — light/dark 로 해석하지 않고
 *  그대로 `<html>` 클래스로 적용한다. */
const STANDALONE_THEMES = [
  'default', 'comfort', 'burnt-sienna', 'tuscan-sunset', 'electropop',
  'summer-breeze', 'wildflower-meadow', 'tropical-punch',
] as const;
type StandaloneTheme = (typeof STANDALONE_THEMES)[number];

function isStandaloneTheme(theme: Theme): theme is StandaloneTheme {
  return (STANDALONE_THEMES as readonly string[]).includes(theme);
}

function getSystemPreference(): 'dark' | 'light' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const ALL_CLASSES = ['light', 'dark', ...STANDALONE_THEMES] as const;

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  // 기존 모드 클래스 제거
  for (const c of ALL_CLASSES) root.classList.remove(c);

  if (isStandaloneTheme(theme)) {
    root.classList.add(theme);
  } else {
    const resolved = theme === 'system' ? getSystemPreference() : theme;
    root.classList.add(resolved);
  }
  localStorage.setItem('k8s:theme', theme);
}

const VALID_THEMES: readonly Theme[] = [...STANDALONE_THEMES, 'dark', 'light', 'system'];

// Apply theme immediately on module load (before React renders)
// 레거시 'claude' 값은 'default' 로 자동 마이그레이션 (호환성).
let _stored = localStorage.getItem('k8s:theme');
if (_stored === 'claude') {
  _stored = 'default';
  localStorage.setItem('k8s:theme', 'default');
}
const _initial: Theme = (
  _stored && (VALID_THEMES as readonly string[]).includes(_stored)
    ? (_stored as Theme)
    : 'default'
);
applyTheme(_initial);

// Listen for system preference changes when theme is 'system'
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const current = (localStorage.getItem('k8s:theme') as Theme | null) ?? 'default';
  if (current === 'system') applyTheme('system');
});

interface ThemeState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: _initial,
  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },
}));
