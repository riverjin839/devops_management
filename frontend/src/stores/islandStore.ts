import { create } from 'zustand';

// 아일랜드 정의(이름/패널/레이아웃)는 백엔드에 있고, 여기 담는 건 "기기별 취향"뿐이다 —
// 마지막으로 연 아일랜드와 아일랜드별 활성 패널. 서버로 올리면 다른 기기에서 보던 탭이
// 따라와버려 오히려 방해가 된다.
const LAST_ISLAND_KEY = 'pep:lastIslandId';
const ACTIVE_PANEL_KEY = 'pep:islandActivePanel';

function loadLastIslandId(): string | null {
  try {
    return localStorage.getItem(LAST_ISLAND_KEY);
  } catch {
    return null;
  }
}

function loadActivePanels(): Record<string, string> {
  try {
    const raw = localStorage.getItem(ACTIVE_PANEL_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

interface IslandStore {
  /** 마지막으로 연 아일랜드 id — `/island` 진입 시 여기로 리다이렉트. */
  lastIslandId: string | null;
  setLastIslandId: (id: string | null) => void;
  /** 아일랜드 id → 활성 패널 key. */
  activePanels: Record<string, string>;
  setActivePanel: (islandId: string, panelKey: string) => void;
}

export const useIslandStore = create<IslandStore>((set, get) => ({
  lastIslandId: loadLastIslandId(),
  setLastIslandId: (id) => {
    try {
      if (id) localStorage.setItem(LAST_ISLAND_KEY, id);
      else localStorage.removeItem(LAST_ISLAND_KEY);
    } catch { /* ignore persistence failure */ }
    set({ lastIslandId: id });
  },
  activePanels: loadActivePanels(),
  setActivePanel: (islandId, panelKey) => {
    const next = { ...get().activePanels, [islandId]: panelKey };
    try {
      localStorage.setItem(ACTIVE_PANEL_KEY, JSON.stringify(next));
    } catch { /* ignore persistence failure */ }
    set({ activePanels: next });
  },
}));
