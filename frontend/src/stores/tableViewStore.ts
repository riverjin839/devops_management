import { create } from 'zustand';

// ── Types ──────────────────────────────────────────────────────────────────────
export type FontSize    = 'xs' | 'sm' | 'base';
export type Density     = 'compact' | 'normal' | 'comfortable';
export type BorderStyle = 'none' | 'light' | 'medium';
export type HeaderTheme = 'default' | 'blue' | 'indigo' | 'emerald';

export interface TableStyleConfig {
  fontSize:    FontSize;
  density:     Density;
  border:      BorderStyle;
  headerTheme: HeaderTheme;
  altRow:      boolean;
  monoFont:    boolean;
}

// ── Tailwind-safe class mappings ───────────────────────────────────────────────
// All values are complete class strings (no runtime concatenation) so Tailwind
// JIT can detect them during build.
export const TS = {
  fontSize: {
    xs:   'text-xs',
    sm:   'text-sm',
    base: 'text-base',
  },
  cellPad: {
    compact:     'px-2 py-1',
    normal:      'px-2.5 py-2',
    comfortable: 'px-4 py-3',
  },
  rowMinH: {
    compact:     32,
    normal:      40,
    comfortable: 56,
  },
  border: {
    none:   'border-transparent',
    light:  'border-border/40',
    medium: 'border-border/80',
  },
  headerBg: {
    default: 'bg-white/[0.06]',
    blue:    'bg-blue-500/[0.12]',
    indigo:  'bg-indigo-500/[0.12]',
    emerald: 'bg-status-healthy/[0.12]',
  },
  headerText: {
    default: 'text-foreground',
    blue:    'text-blue-300',
    indigo:  'text-indigo-300',
    emerald: 'text-status-healthy',
  },
} as const;

// ── Default ───────────────────────────────────────────────────────────────────
export const DEFAULT_TABLE_STYLE: TableStyleConfig = {
  fontSize:    'sm',
  density:     'normal',
  border:      'light',
  headerTheme: 'default',
  altRow:      false,
  monoFont:    false,
};

const STORAGE_KEY = 'k8s:table-style';

function load(): TableStyleConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TABLE_STYLE;
    return { ...DEFAULT_TABLE_STYLE, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_TABLE_STYLE;
  }
}

// ── Zustand store ─────────────────────────────────────────────────────────────
interface TableViewState {
  style: TableStyleConfig;
  setStyle: (s: TableStyleConfig) => void;
  patchStyle: (patch: Partial<TableStyleConfig>) => void;
}

export const useTableViewStore = create<TableViewState>((set) => ({
  style: load(),
  setStyle: (style) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(style));
    set({ style });
  },
  patchStyle: (patch) =>
    set((state) => {
      const next = { ...state.style, ...patch };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return { style: next };
    }),
}));
