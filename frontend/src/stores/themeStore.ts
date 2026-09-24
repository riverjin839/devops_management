import { create } from 'zustand';

/**
 * 바탕 테마 (P2, 2026-09 — 11종 → 4종 + 시스템).
 * - `light`         : **기본 테마** — 슬레이트 + 강조색(기본 블루) (Databricks-leaning).
 * - `dark`          : Databricks-leaning 다크. 강조색 적용 대상.
 * - `comfort`       : 화이트 계열 배경 + 딥그린 + 큰 radius(16px) + 소프트 카드 섀도. 자체 색 고정.
 * - `high-contrast` : 관제실 대형 화면·빔프로젝터용 고대비. 자체 색 고정.
 * - `umber`         : 입체미래주의풍 유화에서 추출한 팔레트 — 움버 바탕 + 오커 강조 + 핑크 차트(다크). 자체 색 고정.
 * - `umber-light`   : 같은 팔레트의 라이트 변형 — 크림 바탕 + 움버 사이드바. 자체 색 고정.
 * - `journal`       : 입체주의 정물화(〈아침 식사〉) 팔레트 — 검정 바탕 + 코발트 강조 + 크림슨 사이드바(다크). 자체 색 고정.
 * - `relief`        : 석재 부조 팔레트 — 스톤 베이지 바탕 + 슬레이트 강조 + 녹청 초록(라이트). 자체 색 고정.
 * - `plaster`       : 흰 벽 입체주의 풍경화 팔레트 — 크림 석고 바탕 + 슬레이트 블루 강조 + 액자 브라운 사이드바. 자체 색 고정.
 * - `system`        : OS 환경설정 따라가는 라이트/다크.
 *
 * 색 취향은 테마가 아니라 **강조색(Accent)** 으로 고른다 — 버튼·링크·선택 탭·활성 메뉴·포커스 링만
 * 바뀌고 배경·상태색은 바탕 테마가 정한다. 라이트/다크(시스템 포함)에만 적용된다.
 */
export type Theme = 'light' | 'dark' | 'comfort' | 'high-contrast' | 'umber' | 'umber-light' | 'plaster' | 'journal' | 'relief' | 'system';
export type Accent = 'blue' | 'teal' | 'green' | 'amber' | 'coral' | 'violet';

export const THEMES: readonly Theme[] = ['light', 'dark', 'comfort', 'high-contrast', 'umber', 'umber-light', 'plaster', 'journal', 'relief', 'system'];
export const ACCENTS: readonly Accent[] = ['blue', 'teal', 'green', 'amber', 'coral', 'violet'];

/** 자체 완결 토큰 세트를 가진 바탕 — light/dark 로 해석하지 않고 그대로 `<html>` 클래스로 적용. */
const STANDALONE_THEMES = ['comfort', 'high-contrast', 'umber', 'umber-light', 'plaster', 'journal', 'relief'] as const;
type StandaloneTheme = (typeof STANDALONE_THEMES)[number];

function isStandaloneTheme(theme: Theme): theme is StandaloneTheme {
  return (STANDALONE_THEMES as readonly string[]).includes(theme);
}

function getSystemPreference(): 'dark' | 'light' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const ALL_CLASSES = ['light', 'dark', ...STANDALONE_THEMES] as const;

const THEME_KEY = 'k8s:theme';
const ACCENT_KEY = 'k8s:accent';

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

function applyTheme(theme: Theme, accent: Accent) {
  const root = document.documentElement;
  for (const c of ALL_CLASSES) root.classList.remove(c);

  if (isStandaloneTheme(theme)) {
    root.classList.add(theme);
  } else {
    const resolved = theme === 'system' ? getSystemPreference() : theme;
    root.classList.add(resolved);
  }
  // 강조색 — blue 는 기본값이라 속성을 두지 않는다(index.css 에 blue 블록 없음).
  if (accent === 'blue') root.removeAttribute('data-accent');
  else root.setAttribute('data-accent', accent);

  safeSet(THEME_KEY, theme);
  safeSet(ACCENT_KEY, accent);
}

/** 신규 사용자 기본값. */
const DEFAULT_THEME: Theme = 'light';
const DEFAULT_ACCENT: Accent = 'blue';

/**
 * P2 에서 없앤 테마 → (바탕, 강조색). 저장값이 옛 테마면 로드 때 이 표대로 옮긴다.
 * `default`(코랄)는 P0 의 1회 이전(default→light) 뒤에 사용자가 다시 고른 경우라 코랄로 보존한다.
 */
const LEGACY_THEME_MAP: Record<string, { theme: Theme; accent: Accent }> = {
  claude:              { theme: 'light', accent: 'blue' },
  default:             { theme: 'light', accent: 'coral' },
  'burnt-sienna':      { theme: 'light', accent: 'coral' },
  'tuscan-sunset':     { theme: 'light', accent: 'coral' },
  'summer-breeze':     { theme: 'light', accent: 'coral' },
  'wildflower-meadow': { theme: 'light', accent: 'amber' },
  'tropical-punch':    { theme: 'light', accent: 'teal' },
  electropop:          { theme: 'dark',  accent: 'violet' },
};

// P0 — 기본 테마가 코랄(default) → 슬레이트(light) 로 바뀌면서 저장값 'default' 를 1회만 light 로
// 옮겼다(첫 로드 때 자동 저장된 'default' 와 직접 고른 코랄을 구분할 수 없어서). 그 이전을 아직
// 거치지 않은 브라우저는 여기서도 먼저 같은 규칙을 적용한다.
const LIGHT_DEFAULT_MIGRATION_KEY = 'k8s:theme-migrated-light-default';

function resolveInitial(): { theme: Theme; accent: Accent } {
  let stored = safeGet(THEME_KEY);
  if (safeGet(LIGHT_DEFAULT_MIGRATION_KEY) !== '1') {
    if (stored === 'default') stored = DEFAULT_THEME;
    safeSet(LIGHT_DEFAULT_MIGRATION_KEY, '1');
  }
  const storedAccent = safeGet(ACCENT_KEY);
  const accent: Accent = storedAccent && (ACCENTS as readonly string[]).includes(storedAccent)
    ? (storedAccent as Accent)
    : DEFAULT_ACCENT;
  if (stored && LEGACY_THEME_MAP[stored]) return LEGACY_THEME_MAP[stored];
  const theme: Theme = stored && (THEMES as readonly string[]).includes(stored) ? (stored as Theme) : DEFAULT_THEME;
  return { theme, accent };
}

// Apply theme immediately on module load (before React renders)
const _initial = resolveInitial();
applyTheme(_initial.theme, _initial.accent);

// Listen for system preference changes when theme is 'system'
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  const { theme, accent } = useThemeStore.getState();
  if (theme === 'system') applyTheme('system', accent);
});

interface ThemeState {
  theme: Theme;
  accent: Accent;
  setTheme: (theme: Theme) => void;
  setAccent: (accent: Accent) => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: _initial.theme,
  accent: _initial.accent,
  setTheme: (theme) => {
    applyTheme(theme, get().accent);
    set({ theme });
  },
  setAccent: (accent) => {
    applyTheme(get().theme, accent);
    set({ accent });
  },
}));

/** 강조색이 적용되는 바탕인지 — comfort/high-contrast/umber(-light)/plaster/journal/relief 는 자체 색 고정이라 강조색을 무시한다. */
export function accentApplies(theme: Theme): boolean {
  return !isStandaloneTheme(theme);
}
