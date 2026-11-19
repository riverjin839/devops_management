// 모달을 닫으면서 URL 을 바꿀 때 — 모달은 열릴 때 `#modal-` 기록을 push 하고 닫힐 때 `history.back()` 으로 회수한다
// (`common/modalHistory.ts`). 닫는 순간 `useUrlParams` 로 쿼리를 바꾸면 그 기록이 회수되며 방금 바꾼 쿼리까지 되돌아가므로,
// 모달 기록이 사라진 뒤(최대 1초)에 바꾼다.
import { MODAL_HASH_PREFIX } from '@/components/common/modalHistory';

export function afterModalClose(fn: () => void): void {
  const tick = (n: number) => {
    if (!window.location.hash.startsWith(MODAL_HASH_PREFIX) || n >= 20) fn();
    else window.setTimeout(() => tick(n + 1), 50);
  };
  window.setTimeout(() => tick(0), 0);
}
