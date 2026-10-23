import { create } from 'zustand';
import { Cluster, Addon, CheckLog, SummaryStats, Status } from '@/types';

interface ClusterState {
  // State
  clusters: Cluster[];
  addons: Record<string, Addon[]>;
  logs: CheckLog[];
  summary: SummaryStats;
  isLoading: boolean;
  isChecking: boolean;
  lastCheckTime: string | null;

  // Actions
  setClusters: (clusters: Cluster[]) => void;
  setAddons: (clusterId: string, addons: Addon[]) => void;
  setLogs: (logs: CheckLog[]) => void;
  addLog: (log: CheckLog) => void;
  setSummary: (summary: SummaryStats) => void;
  setIsLoading: (isLoading: boolean) => void;
  setIsChecking: (isChecking: boolean) => void;
  setLastCheckTime: (time: string) => void;
  updateClusterStatus: (clusterId: string, status: Status) => void;
  updateAddonStatus: (clusterId: string, addonId: string, status: Status) => void;
}

export const useClusterStore = create<ClusterState>((set) => ({
  // Initial state
  clusters: [],
  addons: {},
  logs: [],
  summary: {
    totalClusters: 0,
    healthy: 0,
    warning: 0,
    critical: 0,
  },
  isLoading: false,
  isChecking: false,
  lastCheckTime: null,

  // Actions
  setClusters: (clusters) => set({ clusters }),

  setAddons: (clusterId, addons) =>
    set((state) => ({
      addons: { ...state.addons, [clusterId]: addons },
    })),

  setLogs: (logs) => set({ logs }),

  addLog: (log) =>
    set((state) => ({
      logs: [log, ...state.logs].slice(0, 100), // 최근 100개만 유지
    })),

  setSummary: (summary) => set({
    summary: (summary && typeof summary === 'object' && 'totalClusters' in summary)
      ? summary
      : { totalClusters: 0, healthy: 0, warning: 0, critical: 0 },
  }),

  setIsLoading: (isLoading) => set({ isLoading }),

  setIsChecking: (isChecking) => set({ isChecking }),

  setLastCheckTime: (time) => set({ lastCheckTime: time }),

  updateClusterStatus: (clusterId, status) =>
    set((state) => ({
      clusters: state.clusters.map((c) =>
        c.id === clusterId ? { ...c, status } : c
      ),
    })),

  updateAddonStatus: (clusterId, addonId, status) =>
    set((state) => ({
      addons: {
        ...state.addons,
        [clusterId]: (state.addons[clusterId] || []).map((a) =>
          a.id === addonId ? { ...a, status } : a
        ),
      },
    })),
}));
