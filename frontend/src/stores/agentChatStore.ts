import { create } from 'zustand';

interface AgentChatStore {
  open: boolean;
  toggle: () => void;
  setOpen: (v: boolean) => void;
}

/** AI 어시스턴트 패널 열림 상태 — 트리거(사이드바 하단 레일 아이콘)와 패널(AgentChat)이
 *  서로 다른 컴포넌트 트리에 있어 Zustand 로 공유한다. */
export const useAgentChatStore = create<AgentChatStore>((set) => ({
  open: false,
  toggle: () => set((s) => ({ open: !s.open })),
  setOpen: (v: boolean) => set({ open: v }),
}));
