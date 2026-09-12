import { create } from 'zustand';

/**
 * D-073 — 커맨드 팔레트(Ctrl/⌘+K 화면 검색) 열림 상태. 전역 단축키(PageStyleProvider),
 * 상단바 검색 버튼, 사이드바 "도움말·지원 ▸ 화면 검색" 세 진입점이 같은 상태를 공유한다.
 */
interface CommandPaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
