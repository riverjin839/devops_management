import { create } from 'zustand';

export type HomeMode = 'work' | 'platform';
/** 업무 현황 스케줄 패널 배경 — 흰색(기본) / 크림(웜 페이퍼). */
export type ScheduleBg = 'white' | 'cream';

const STORAGE_KEY = 'pep:homeMode';
const SCHEDULE_BG_KEY = 'pep:scheduleBg';

function loadMode(): HomeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'platform' ? 'platform' : 'work';
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

interface HomeStore {
  mode: HomeMode;
  toggle: () => void;
  setMode: (m: HomeMode) => void;
  scheduleBg: ScheduleBg;
  setScheduleBg: (bg: ScheduleBg) => void;
}

export const useHomeStore = create<HomeStore>((set, get) => ({
  mode: loadMode(),
  toggle: () => {
    const next: HomeMode = get().mode === 'work' ? 'platform' : 'work';
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch { /* ignore persistence failure */ }
    set({ mode: next });
  },
  setMode: (m: HomeMode) => {
    try {
      localStorage.setItem(STORAGE_KEY, m);
    } catch { /* ignore persistence failure */ }
    set({ mode: m });
  },
  scheduleBg: loadScheduleBg(),
  setScheduleBg: (bg: ScheduleBg) => {
    try {
      localStorage.setItem(SCHEDULE_BG_KEY, bg);
    } catch { /* ignore persistence failure */ }
    set({ scheduleBg: bg });
  },
}));
