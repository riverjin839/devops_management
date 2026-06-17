import { create } from 'zustand';
import type { TerminalEnv } from '@/types';

/**
 * 현재 화면이 '개발' / '운영' 중 무엇을 다루는지 전역으로 공유한다.
 * 터미널 Appearance 가 'auto' 모드일 때 LogViewer 가 어떤 프로파일을 적용할지
 * 이 값으로 결정한다. 클러스터 선택형 페이지가 선택 클러스터의 운영등급에 따라
 * setCurrentEnv 를 호출해 갱신한다.
 */
interface TerminalEnvState {
  currentEnv: TerminalEnv | null;
  setCurrentEnv: (env: TerminalEnv | null) => void;
}

export const useTerminalEnvStore = create<TerminalEnvState>((set) => ({
  currentEnv: null,
  setCurrentEnv: (env) => set({ currentEnv: env }),
}));
