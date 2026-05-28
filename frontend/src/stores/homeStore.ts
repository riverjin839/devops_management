import { create } from 'zustand';

export type HomeMode = 'work' | 'platform';

const STORAGE_KEY = 'pep:homeMode';

function loadMode(): HomeMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'platform' ? 'platform' : 'work';
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
    localStorage.setItem(STORAGE_KEY, next);
    set({ mode: next });
  },
  setMode: (m) => {
    localStorage.setItem(STORAGE_KEY, m);
    set({ mode: m });
  },
}));
