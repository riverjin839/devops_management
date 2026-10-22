import { create } from 'zustand';
import { Playbook } from '@/types';

interface PlaybookState {
  playbooks: Playbook[];
  runningIds: Set<string>;
  setPlaybooks: (playbooks: Playbook[]) => void;
  setRunning: (id: string) => void;
  clearRunning: (id: string) => void;
  /** 진행 중인 백그라운드 실행 — playbookId → runId(취소 버튼이 쓴다). */
  activeRuns: Record<string, string>;
  setActiveRun: (playbookId: string, runId: string | null) => void;
}

export const usePlaybookStore = create<PlaybookState>((set) => ({
  playbooks: [],
  runningIds: new Set(),
  activeRuns: {},

  setActiveRun: (playbookId, runId) =>
    set((state) => {
      const next = { ...state.activeRuns };
      if (runId) next[playbookId] = runId;
      else delete next[playbookId];
      return { activeRuns: next };
    }),

  setPlaybooks: (playbooks) => set({ playbooks }),

  setRunning: (id) =>
    set((state) => ({
      runningIds: new Set([...state.runningIds, id]),
    })),

  clearRunning: (id) =>
    set((state) => {
      const next = new Set(state.runningIds);
      next.delete(id);
      return { runningIds: next };
    }),
}));
