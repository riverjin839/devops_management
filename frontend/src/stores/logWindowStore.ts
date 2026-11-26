import { create } from 'zustand';

/**
 * 실행 로그 표시 위치 — 전역 기본 설정(브라우저 단위, localStorage).
 *
 * - `window`(기본): "로그 보기" 가 켜진 실행 로그를 화면 안이 아니라 우측 상단의 새 창(팝업)에 띄운다.
 * - `inline`: 예전처럼 화면 안(실행 버튼 아래/우측 패널)에 펼친다.
 *
 * 화면별 "로그 보기"(useLogPref) 는 그대로 — 이 설정은 "어디에" 보일지만 정한다.
 * `showCommands` 는 관리자에게만 의미가 있다 — 실제로 노드에 나간 명령(CMD 줄)을 보일지(RunLogPanel "명령" 토글).
 * 바꾸는 곳: Settings → 화면 UI 설정 → 실행 로그 표시, 또는 각 로그 패널 헤더의 창 전환 버튼.
 */
export type LogDisplayMode = 'window' | 'inline';

const KEY = 'pep.runlog.displayMode';

function load(): LogDisplayMode {
  try {
    return localStorage.getItem(KEY) === 'inline' ? 'inline' : 'window';
  } catch {
    return 'window';
  }
}

const CMD_KEY = 'pep.runlog.showCommands';

function loadShowCommands(): boolean {
  try {
    return localStorage.getItem(CMD_KEY) !== '0';
  } catch {
    return true;
  }
}

interface LogWindowState {
  mode: LogDisplayMode;
  setMode: (m: LogDisplayMode) => void;
  /** 관리자 — 실행 로그에 실제로 나간 명령(CMD 줄)을 보일지. 기본 켬(전 화면 공통). */
  showCommands: boolean;
  setShowCommands: (v: boolean) => void;
}

export const useLogWindowStore = create<LogWindowState>((set) => ({
  mode: load(),
  setMode: (mode) => {
    try { localStorage.setItem(KEY, mode); } catch { /* 이번 세션 값만 유지 */ }
    set({ mode });
  },
  showCommands: loadShowCommands(),
  setShowCommands: (showCommands) => {
    try { localStorage.setItem(CMD_KEY, showCommands ? '1' : '0'); } catch { /* 이번 세션 값만 유지 */ }
    set({ showCommands });
  },
}));
