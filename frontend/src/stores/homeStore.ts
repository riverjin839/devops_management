import { create } from 'zustand';

/** 홈(`/`) 본문에서 보여줄 탭. 예전엔 사이드바 전체를 게이팅하는 "모드"였지만(D-054),
 *  지금은 홈 화면 로컬 세그먼트 탭일 뿐이다 — 사이드바·상단바 노출 범위와 무관하다. */
export type HomeTab = 'work' | 'platform';
/** 업무 현황 스케줄 패널 배경 — 흰색(기본) / 크림(웜 페이퍼). */
export type ScheduleBg = 'white' | 'cream';

const STORAGE_KEY = 'pep:homeTab';
const LEGACY_STORAGE_KEY = 'pep:homeMode';
const SCHEDULE_BG_KEY = 'pep:scheduleBg';
const WEEKLY_BAR_OPACITY_KEY = 'pep:weeklyBarOpacity';
const WEEKLY_BAR_TEXT_COLOR_KEY = 'pep:weeklyBarTextColor';
const DEFAULT_WEEKLY_BAR_OPACITY = 100;
const DEFAULT_WEEKLY_BAR_TEXT_COLOR = '#ffffff';

function loadHomeTab(): HomeTab {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'platform' || stored === 'work') return stored;
    // 구 키(pep:homeMode) 1회 마이그레이션 — 기존 사용자의 선호를 보존한다.
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy === 'platform' || legacy === 'work') {
      localStorage.setItem(STORAGE_KEY, legacy);
      return legacy;
    }
    return 'work';
  } catch {
    return 'work';
  }
}

function loadScheduleBg(): ScheduleBg {
  try {
    return localStorage.getItem(SCHEDULE_BG_KEY) === 'cream' ? 'cream' : 'white';
  } catch {
    return 'white';
  }
}

function loadWeeklyBarOpacity(): number {
  try {
    const raw = localStorage.getItem(WEEKLY_BAR_OPACITY_KEY);
    if (raw === null) return DEFAULT_WEEKLY_BAR_OPACITY;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_WEEKLY_BAR_OPACITY;
  } catch {
    return DEFAULT_WEEKLY_BAR_OPACITY;
  }
}

function loadWeeklyBarTextColor(): string {
  try {
    const v = localStorage.getItem(WEEKLY_BAR_TEXT_COLOR_KEY);
    return v && /^#[0-9a-fA-F]{6}$/.test(v) ? v : DEFAULT_WEEKLY_BAR_TEXT_COLOR;
  } catch {
    return DEFAULT_WEEKLY_BAR_TEXT_COLOR;
  }
}

interface HomeStore {
  homeTab: HomeTab;
  setHomeTab: (t: HomeTab) => void;
  scheduleBg: ScheduleBg;
  setScheduleBg: (bg: ScheduleBg) => void;
  /** 담당자별 진행 현황(주간) 스윔레인 상태 막대 배경 투명도 — 0(완전 투명)~100(불투명). */
  weeklyBarOpacity: number;
  setWeeklyBarOpacity: (v: number) => void;
  /** 위 상태 막대 안에 표시되는 텍스트 색상 (hex). */
  weeklyBarTextColor: string;
  setWeeklyBarTextColor: (hex: string) => void;
}

export const useHomeStore = create<HomeStore>((set) => ({
  homeTab: loadHomeTab(),
  setHomeTab: (t: HomeTab) => {
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch { /* ignore persistence failure */ }
    set({ homeTab: t });
  },
  scheduleBg: loadScheduleBg(),
  setScheduleBg: (bg: ScheduleBg) => {
    try {
      localStorage.setItem(SCHEDULE_BG_KEY, bg);
    } catch { /* ignore persistence failure */ }
    set({ scheduleBg: bg });
  },
  weeklyBarOpacity: loadWeeklyBarOpacity(),
  setWeeklyBarOpacity: (v: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(v)));
    try {
      localStorage.setItem(WEEKLY_BAR_OPACITY_KEY, String(clamped));
    } catch { /* ignore persistence failure */ }
    set({ weeklyBarOpacity: clamped });
  },
  weeklyBarTextColor: loadWeeklyBarTextColor(),
  setWeeklyBarTextColor: (hex: string) => {
    try {
      localStorage.setItem(WEEKLY_BAR_TEXT_COLOR_KEY, hex);
    } catch { /* ignore persistence failure */ }
    set({ weeklyBarTextColor: hex });
  },
}));
