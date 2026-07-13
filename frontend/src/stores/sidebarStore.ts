import { create } from 'zustand';

// Sidebar width is fixed in the new design — no resize handle, no icon-only.
// The resize-related localStorage keys (k8s:sidebar-width-v2) are ignored.
const CLUSTER_KEY = 'k8s:cluster-sidebar-width';
const NAV_GROUPS_KEY = 'k8s:sidebar-collapsed-groups-v1';
const ICON_RAIL_SIZE_KEY = 'k8s:cluster-icon-rail-size';

// 아이콘 전용 레일 — 호버 툴팁 + 클릭 popover 디자인. 패널은 클릭한 아이콘 우측에 컴팩트하게 떠서 폭/높이 자동.
export const NAV_WIDTH = 56;

export const CLUSTER_DEFAULT = 240;
export const CLUSTER_MIN = 180;
export const CLUSTER_MAX = 380;

function loadInt(key: string, fallback: number, min: number, max: number): number {
  try {
    const v = localStorage.getItem(key);
    if (!v) return fallback;
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  } catch {
    return fallback;
  }
}

export type ClusterIconRailSize = 'sm' | 'md' | 'lg';
const ICON_RAIL_SIZE_DEFAULT: ClusterIconRailSize = 'md';

function loadIconRailSize(): ClusterIconRailSize {
  try {
    const v = localStorage.getItem(ICON_RAIL_SIZE_KEY);
    if (v === 'sm' || v === 'md' || v === 'lg') return v;
  } catch { /* ignore */ }
  return ICON_RAIL_SIZE_DEFAULT;
}

function loadCollapsedGroups(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(NAV_GROUPS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, boolean>;
    }
  } catch { /* ignore */ }
  // 기본값: 모든 그룹 접기 — 사용자가 그룹 제목만 보고 클릭해 펼치도록.
  return {
    monitoring: true,
    work: true,
    cluster: true,
    analysis: true,
    docs: true,
    system: true,
  };
}

interface SidebarState {
  clusterSidebarWidth: number;
  setClusterSidebarWidth: (w: number) => void;
  resetClusterSidebar: () => void;

  /** ClusterSidebar iconOnly 레일의 아이콘 크기 프리셋(sm/md/lg). */
  clusterIconRailSize: ClusterIconRailSize;
  setClusterIconRailSize: (size: ClusterIconRailSize) => void;

  /** 그룹 ID → 접힘 여부. true = 접힘(자식 항목 숨김). */
  collapsedGroups: Record<string, boolean>;
  toggleGroup: (id: string) => void;
  setGroupCollapsed: (id: string, collapsed: boolean) => void;
  collapseAllGroups: () => void;
  expandAllGroups: () => void;
}

export const useSidebarStore = create<SidebarState>()((set) => ({
  clusterSidebarWidth: loadInt(CLUSTER_KEY, CLUSTER_DEFAULT, CLUSTER_MIN, CLUSTER_MAX),
  setClusterSidebarWidth: (w) => {
    const clamped = Math.max(CLUSTER_MIN, Math.min(CLUSTER_MAX, Math.round(w)));
    try { localStorage.setItem(CLUSTER_KEY, String(clamped)); } catch { /* ignore */ }
    set({ clusterSidebarWidth: clamped });
  },
  resetClusterSidebar: () => {
    try { localStorage.setItem(CLUSTER_KEY, String(CLUSTER_DEFAULT)); } catch { /* ignore */ }
    set({ clusterSidebarWidth: CLUSTER_DEFAULT });
  },

  clusterIconRailSize: loadIconRailSize(),
  setClusterIconRailSize: (size) => {
    try { localStorage.setItem(ICON_RAIL_SIZE_KEY, size); } catch { /* ignore */ }
    set({ clusterIconRailSize: size });
  },

  collapsedGroups: loadCollapsedGroups(),
  toggleGroup: (id) => set((s) => {
    const next = { ...s.collapsedGroups, [id]: !s.collapsedGroups[id] };
    try { localStorage.setItem(NAV_GROUPS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    return { collapsedGroups: next };
  }),
  setGroupCollapsed: (id, collapsed) => set((s) => {
    const next = { ...s.collapsedGroups, [id]: collapsed };
    try { localStorage.setItem(NAV_GROUPS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    return { collapsedGroups: next };
  }),
  collapseAllGroups: () => set(() => {
    const next = { monitoring: true, work: true, cluster: true, analysis: true, docs: true, system: true };
    try { localStorage.setItem(NAV_GROUPS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    return { collapsedGroups: next };
  }),
  expandAllGroups: () => set(() => {
    const next = { monitoring: false, work: false, cluster: false, analysis: false, docs: false, system: false };
    try { localStorage.setItem(NAV_GROUPS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
    return { collapsedGroups: next };
  }),
}));
