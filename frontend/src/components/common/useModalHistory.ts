import { useEffect, useId, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { MODAL_HASH_PREFIX, openModalEntry, stripStaleModalHash } from './modalHistory';

stripStaleModalHash();

/**
 * 브라우저/폰 "뒤로가기"로 모달만 닫는 훅 (D-029).
 *
 * `open` 인 동안 hash 기록(`#modal-<id>`)을 하나 push 하고, 사용자가 뒤로가기로 그 기록을 지우면
 * `onClose` 를 부른다. X·Escape·저장 등으로 닫혀 `open` 이 false 가 되거나 언마운트되면 남은 기록을
 * 회수한다(다른 코드가 replace 로 그 기록을 실제 화면 상태로 바꿔 놓았으면 회수하지 않고 보존).
 * 기록 관리·직렬화는 `./modalHistory` 가 맡는다.
 *
 * - `useModalA11y` 는 이 훅을 내장한다(`historyClose` 옵션). 직접 쓰는 곳은 포커스 트랩이 따로 있는
 *   UI — `ui/dialog` 의 `Dialog` 래퍼(Base UI), 자체 Escape 를 가진 포털 팝오버(`ClusterIconPicker`) 등.
 * - 조건부로 마운트되는 UI 는 `useModalHistory(true, onClose)` 로 쓴다(언마운트 = 닫힘).
 * - `onClose` 가 닫기를 거부하면(실행 중 등) `open` 이 그대로이므로 기록을 다시 push 한다.
 *
 * @param enabled false 면 기록을 쓰지 않는다(팝오버·팔레트처럼 닫은 뒤 바로 다른 화면으로 이동하는 UI).
 */
export function useModalHistory(open: boolean, onClose: () => void, enabled = true) {
  const rawId = useId();
  const myHash = `${MODAL_HASH_PREFIX}${rawId.replace(/[^a-zA-Z0-9]/g, '')}`;
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  // onClose·open 최신값을 effect 재실행 없이 참조
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!open || !enabled) return;
    return openModalEntry(
      () => navigateRef.current({ hash: myHash, search: window.location.search }, { replace: false }),
      { close: () => onCloseRef.current(), stillOpen: () => openRef.current },
    );
  }, [open, enabled, myHash]);
}
