import { create } from 'zustand';

/**
 * 점검 매트릭스 실행 로그 패널 상태 — 셀/행/열/항목 상세/등록 마법사 어디서 실행하든
 * 같은 패널 하나로 실시간 로그를 본다(CLAUDE.md: 모든 "실행" 에 상세·실시간 로그 + "로그 보기" 선택).
 *
 * - `autoOpen`: 실행 직후 로그 패널을 자동으로 열지 — 사용자가 표시 설정에서 고른다(기본 on).
 *   끄면 실행 토스트의 "로그 보기" 로만 연다. 브라우저 단위 편의 설정이라 localStorage.
 * - `target`: 지금 패널이 보여줄 대상 — 단일 수행(runId) 또는 일괄 수행(batchId).
 */
export interface CheckMatrixLogTarget {
  runId?: string | null;
  batchId?: string | null;
  label?: string | null;
}

interface CheckMatrixLogState {
  autoOpen: boolean;
  open: boolean;
  target: CheckMatrixLogTarget | null;
  setAutoOpen: (v: boolean) => void;
  show: (target?: CheckMatrixLogTarget | null) => void;
  close: () => void;
}

const AUTO_OPEN_KEY = 'pep:checkMatrixAutoOpenLog';

function loadAutoOpen(): boolean {
  try {
    return localStorage.getItem(AUTO_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

export const useCheckMatrixLogStore = create<CheckMatrixLogState>((set) => ({
  autoOpen: loadAutoOpen(),
  open: false,
  target: null,
  setAutoOpen: (v) => {
    try {
      localStorage.setItem(AUTO_OPEN_KEY, v ? '1' : '0');
    } catch {
      /* 저장 실패는 이번 세션 값만 유지 */
    }
    set({ autoOpen: v });
  },
  show: (target = null) => set({ open: true, target }),
  close: () => set({ open: false }),
}));
