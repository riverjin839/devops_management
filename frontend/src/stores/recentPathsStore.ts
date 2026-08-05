import { create } from 'zustand';

// 최근 방문 화면 — 기기 로컬(브라우저)에서만 의미가 있다(islandStore.ts 의
// lastIslandId 와 동일한 성격 — 서버로 올리면 다른 기기의 방문 이력이 섞여 오히려 방해된다).
const STORAGE_KEY = 'pep:recentPaths';
const MAX_RECENT = 5;

function loadRecentPaths(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

interface RecentPathsStore {
  paths: string[];
  /** 경로 방문 기록 — 최신이 맨 앞, 중복 제거, 최대 5개 유지. */
  recordVisit: (path: string) => void;
}

export const useRecentPathsStore = create<RecentPathsStore>((set, get) => ({
  paths: loadRecentPaths(),
  recordVisit: (path) => {
    const next = [path, ...get().paths.filter((p) => p !== path)].slice(0, MAX_RECENT);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch { /* ignore persistence failure */ }
    set({ paths: next });
  },
}));
