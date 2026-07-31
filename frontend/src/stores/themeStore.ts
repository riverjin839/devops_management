import { create } from 'zustand';

/**
 * 테마 모드.
 * - `default`       : 기본 테마 — Anthropic Claude 브랜드 톤 (따뜻한 페이퍼 배경 +
 *                     큰 radius + 은은한 그림자 + 코랄 #D97757 accent). 신규 사용자
 *                     첫 진입 시 보이는 화면.
 * - `comfort`       : 크림 배경 + 딥그린 액센트 + 화이트 카드 + 큰 radius(16px) —
 *                     부드럽고 편안한 대시보드 톤 (Donezo-inspired).
 * - `light` / `dark`: Databricks-leaning 라이트 / 다크 (대안).
 * - `system`        : OS 환경설정 따라가는 라이트/다크.
 */
export type Theme = 'default' | 'comfort' | 'dark' | 'light' | 'system';

function getSystemPreference(): 'dark' | 'light' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const ALL_CLASSES = ['light', 'dark', 'default', 'comfort'] as const;

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  // 기존 모드 클래스 제거
  for (const c of ALL_CLASSES) root.classList.remove(c);

  if (theme === 'default' || theme === 'comfort') {
    root.classList.add(theme);
  } else {
    const resolved = theme === 'system' ? getSystemPreference() : theme;
    root.classList.add(resolved);
  }
  localStorage.setItem('k8s:theme', theme);
}

// Apply theme immediately on module load (before React renders)
// 레거시 'claude' 값은 'default' 로 자동 마이그레이션 (호환성).
let _stored = localStorage.getItem('k8s:theme');
if (_stored === 'claude') {
  _stored = 'default';
  localStorage.setItem('k8s:theme', 'default');
}
const _initial: Theme = (
  _stored === 'default' || _stored === 'comfort' || _stored === 'dark' || _stored === 'light' || _stored === 'system'
    ? _stored
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
