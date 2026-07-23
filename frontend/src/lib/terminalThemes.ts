import type { CSSProperties } from 'react';
import type {
  TerminalPalette,
  TerminalTemplate,
  TerminalProfile,
  TerminalAppearance,
  TerminalEnv,
} from '@/types';

/**
 * 모든 로그 출력 화면(LogViewer)이 공유하는 터미널 Appearance 유틸.
 *
 * 색상은 CSS 변수(--log-*)로 LogViewer 컨테이너에 주입되고, 토큰 하이라이트
 * 클래스(text-[color:var(--log-red)] 등)가 이를 참조한다. 따라서 기본 팔레트는
 * 현재 테마 색상과 동일하게 맞춰 두어, 사용자가 템플릿을 고르지 않으면 기존
 * 화면과 동일하게 보이도록 한다.
 */

export const PALETTE_KEYS: (keyof TerminalPalette)[] = [
  'bg', 'fg', 'red', 'green', 'amber', 'sky', 'purple', 'cyan', 'muted',
];

export const PALETTE_LABELS: Record<keyof TerminalPalette, string> = {
  bg: '배경',
  fg: '기본 글자',
  red: '에러/위험 (red)',
  green: '정상/성공 (green)',
  amber: '경고/숫자 (amber)',
  sky: '정보/IP (sky)',
  purple: 'UUID/해시 (purple)',
  cyan: '경로 (cyan)',
  muted: '흐림/디버그 (muted)',
};

// 기본 팔레트 — 현재 Tailwind 토큰 색과 동일. bg/fg 는 비워 두어 테마 클래스
// (bg-background / text-foreground)에 위임한다(라이트/다크 자동 대응).
export const DEFAULT_PALETTE: TerminalPalette = {
  bg: '',
  fg: '',
  red: '#ef4444',
  green: '#10b981',
  amber: '#f59e0b',
  sky: '#0ea5e9',
  purple: '#c084fc',
  cyan: '#06b6d4',
  muted: 'hsl(var(--muted-foreground))',
};

export const DEFAULT_FONT_SIZE = 13;
export const FONT_SIZE_MIN = 9;
export const FONT_SIZE_MAX = 28;

export const TERMINAL_FONT_OPTIONS: { label: string; value: string }[] = [
  { label: '기본 모노스페이스', value: '' },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", ui-monospace, "Courier New", monospace' },
  { label: 'Cascadia Code', value: '"Cascadia Code", "Cascadia Mono", ui-monospace, monospace' },
  { label: 'Consolas', value: 'Consolas, "Courier New", ui-monospace, monospace' },
  { label: 'Courier New', value: '"Courier New", Courier, monospace' },
  { label: 'D2Coding (한글 고정폭)', value: '"D2Coding", "Nanum Gothic Coding", ui-monospace, monospace' },
];

// ── 내장 색상 템플릿 (PuTTY / SecureCRT / Tera Term + 인기 테마) ──────────────
export const BUILTIN_TEMPLATES: TerminalTemplate[] = [
  {
    id: '', name: '기본 (테마 색상)', group: '기본',
    palette: { ...DEFAULT_PALETTE },
  },
  {
    id: 'putty-default', name: 'PuTTY (기본)', group: 'PuTTY',
    palette: {
      bg: '#000000', fg: '#d0d0d0', red: '#ff5f5f', green: '#5fd75f',
      amber: '#ffd75f', sky: '#5fafff', purple: '#d75fff', cyan: '#5fd7d7', muted: '#808080',
    },
  },
  {
    id: 'putty-light', name: 'PuTTY (흰 배경)', group: 'PuTTY',
    palette: {
      bg: '#ffffff', fg: '#1a1a1a', red: '#c0392b', green: '#1e7e34',
      amber: '#b8860b', sky: '#1565c0', purple: '#8e24aa', cyan: '#00838f', muted: '#6b6b6b',
    },
  },
  {
    id: 'securecrt-dark', name: 'SecureCRT (다크)', group: 'SecureCRT',
    palette: {
      bg: '#14161b', fg: '#cdd3de', red: '#e06c75', green: '#98c379',
      amber: '#e5c07b', sky: '#61afef', purple: '#c678dd', cyan: '#56b6c2', muted: '#7f848e',
    },
  },
  {
    id: 'securecrt-classic', name: 'SecureCRT (클래식 블루)', group: 'SecureCRT',
    palette: {
      bg: '#001b33', fg: '#cfe2f3', red: '#ff6b6b', green: '#6bd66b',
      amber: '#ffd24d', sky: '#4da6ff', purple: '#c77dff', cyan: '#4dd2d2', muted: '#6f8aa6',
    },
  },
  {
    id: 'teraterm-green', name: 'Tera Term (그린 스크린)', group: 'Tera Term',
    palette: {
      bg: '#001100', fg: '#33ff33', red: '#ff5555', green: '#66ff66',
      amber: '#ffcc00', sky: '#44ddff', purple: '#ff66ff', cyan: '#00ffff', muted: '#228822',
    },
  },
  {
    id: 'teraterm-classic', name: 'Tera Term (블랙)', group: 'Tera Term',
    palette: {
      bg: '#000000', fg: '#e0e0e0', red: '#ff4d4d', green: '#4dff4d',
      amber: '#ffff4d', sky: '#4d9fff', purple: '#ff4dff', cyan: '#4dffff', muted: '#9a9a9a',
    },
  },
  {
    id: 'solarized-dark', name: 'Solarized Dark', group: '인기 테마',
    palette: {
      bg: '#002b36', fg: '#93a1a1', red: '#dc322f', green: '#859900',
      amber: '#b58900', sky: '#268bd2', purple: '#6c71c4', cyan: '#2aa198', muted: '#586e75',
    },
  },
  {
    id: 'monokai', name: 'Monokai', group: '인기 테마',
    palette: {
      bg: '#272822', fg: '#f8f8f2', red: '#f92672', green: '#a6e22e',
      amber: '#fd971f', sky: '#66d9ef', purple: '#ae81ff', cyan: '#a1efe4', muted: '#75715e',
    },
  },
  {
    id: 'dracula', name: 'Dracula', group: '인기 테마',
    palette: {
      bg: '#282a36', fg: '#f8f8f2', red: '#ff5555', green: '#50fa7b',
      amber: '#f1fa8c', sky: '#8be9fd', purple: '#bd93f9', cyan: '#8be9fd', muted: '#6272a4',
    },
  },
];

export const DEFAULT_PROFILE: TerminalProfile = {
  templateId: '', fontSize: DEFAULT_FONT_SIZE, fontFamily: '', colors: {},
};

// 기본 Appearance — 개발(dev)은 Monokai, 운영(ops)은 기본(테마 색상)으로 시작해
// 화면만 봐도 개발/운영 콘솔이 구분되게 한다. 사용자가 Settings 에서 프로파일별로
// 템플릿/색/글꼴을 저장하면(개인화) 그 값이 우선한다.
export const DEFAULT_APPEARANCE: TerminalAppearance = {
  mode: 'auto',
  profiles: {
    dev: { ...DEFAULT_PROFILE, templateId: 'monokai' },
    ops: { ...DEFAULT_PROFILE },
  },
  customTemplates: [],
};

/** 클러스터 운영등급 → 'dev' | 'ops' (production 계열만 운영). */
export function envForOperationLevel(level: string | null | undefined): TerminalEnv {
  const v = (level || '').toLowerCase();
  if (!v) return 'dev';
  if (v.includes('prod') || v === 'dr') return 'ops';
  return 'dev';
}

/** mode 와 현재 컨텍스트 env 로 실제 활성 프로파일 환경을 결정. */
export function resolveActiveEnv(
  appearance: TerminalAppearance | undefined,
  currentEnv: TerminalEnv | null,
): TerminalEnv {
  const mode = appearance?.mode ?? 'auto';
  if (mode === 'dev' || mode === 'ops') return mode;
  return currentEnv ?? 'dev';
}

export function findTemplate(
  id: string,
  custom: TerminalTemplate[] = [],
  shared: TerminalTemplate[] = [],
): TerminalTemplate | undefined {
  return [...BUILTIN_TEMPLATES, ...shared, ...custom].find((t) => t.id === id);
}

/** 프로파일 → 최종 팔레트 + 글꼴 (기본 ← 템플릿 ← 개인 색상 오버라이드 순 병합). */
export function resolveProfileTheme(
  profile: TerminalProfile | undefined,
  custom: TerminalTemplate[] = [],
  shared: TerminalTemplate[] = [],
): { palette: TerminalPalette; fontSize: number; fontFamily: string } {
  const p = profile ?? DEFAULT_PROFILE;
  const tpl = findTemplate(p.templateId, custom, shared);
  const palette: TerminalPalette = {
    ...DEFAULT_PALETTE,
    ...(tpl?.palette ?? {}),
    ...(p.colors ?? {}),
  };
  return {
    palette,
    fontSize: p.fontSize || DEFAULT_FONT_SIZE,
    fontFamily: p.fontFamily || '',
  };
}

type CssVarStyle = CSSProperties & Record<`--${string}`, string>;

/** 팔레트/글꼴 → LogViewer 컨테이너 inline style (CSS 변수 포함). */
export function themeToCss(
  palette: TerminalPalette,
  fontSize?: number,
  fontFamily?: string,
): CSSProperties {
  const style: CssVarStyle = {
    '--log-red': palette.red,
    '--log-green': palette.green,
    '--log-amber': palette.amber,
    '--log-sky': palette.sky,
    '--log-purple': palette.purple,
    '--log-cyan': palette.cyan,
    '--log-muted': palette.muted,
  };
  if (palette.bg) {
    style['--log-bg'] = palette.bg;
    style.backgroundColor = palette.bg;
  }
  if (palette.fg) {
    style['--log-fg'] = palette.fg;
    style.color = palette.fg;
  }
  if (fontSize) style.fontSize = `${fontSize}px`;
  if (fontFamily) style.fontFamily = fontFamily;
  return style;
}
