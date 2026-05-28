import { create } from 'zustand';

export type HomeMode = 'work' | 'platform';

const STORAGE_KEY = 'pep:homeMode';

function loadMode(): HomeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'platform' ? 'platform' : 'work';
  } catch {
    return 'work';
  }
}

interface HomeStore {
  mode: HomeMode;
  toggle: () => void;
  setMode: (m: HomeMode) => void;
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
}));
