import { useEffect, useId, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { MODAL_HASH_PREFIX, openModalEntry, stripStaleModalHash } from './modalHistory';

stripStaleModalHash();

/**
 * 모달/다이얼로그 공통 접근성 훅.
 *  - Escape 로 닫기
 *  - 포커스 트랩 (Tab/Shift+Tab 이 모달 밖으로 나가지 않음)
 *  - 열릴 때 초점 이동(모달 내부에 이미 포커스가 있으면 존중), 닫힐 때 트리거로 복원
 *  - 브라우저/폰 "뒤로가기"로 모달만 닫기 (기본 켬, D-029) — 팝오버·팔레트처럼 닫은 뒤 바로
 *    다른 화면으로 이동하는 UI 는 `historyClose: false` 로 끈다.
 *
 * 반환한 ref 를 모달 컨테이너에 연결하고, 컨테이너에는
 * `role="dialog" aria-modal="true"` (+ 가능하면 aria-labelledby)를 함께 부여한다.
 *
 * 사용 예:
 *   const ref = useModalA11y(open, onClose);
 *   <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="...">…</div>
 *
 * 뒤로가기 동작(`./modalHistory`): 열릴 때 hash(`#modal-<id>`) 기록을 push → 뒤로가기로 그 기록이
 * 사라지면 onClose. X·Escape·저장 등으로 닫으면 남은 기록을 회수한다. 판정은 router 의
 * `history.state.idx` 로 하고 history 조작은 큐로 직렬화해, 중첩·연속 모달과 열린 채 URL 필터를
 * 바꾸는 경우에도 기록이 꼬이지 않는다. 실행 중이라 닫기를 무시하는 모달은 기록을 다시 push 한다.
 */
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

interface Options {
  /** 브라우저/폰 뒤로가기로 이 모달을 닫는다(히스토리에 임시 기록 push). 기본 true. */
  historyClose?: boolean;
}

export function useModalA11y(open: boolean, onClose: () => void, opts: Options = {}) {
  const ref = useRef<HTMLDivElement>(null);
  const historyClose = opts.historyClose ?? true;

  // onClose 최신값을 effect 재실행 없이 참조
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // ── 포커스 트랩 + Escape + 초점 복원 ──────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const container = ref.current;
    const prevFocus = document.activeElement as HTMLElement | null;

    const focusables = () =>
      container
        ? Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
            (el) => el.offsetParent !== null || el === document.activeElement,
          )
        : [];

    if (!container?.contains(document.activeElement)) {
      const initial =
        container?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? container;
      initial?.focus();
    }

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab') {
        const items = focusables();
        if (items.length === 0) {
          e.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && (active === first || !container?.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => {
      document.removeEventListener('keydown', handler, true);
      if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) {
        prevFocus.focus();
      }
    };
  }, [open]);

  // ── 뒤로가기로 닫기 — 기록 관리는 modalHistory 가 맡는다 ─────────────────────
  const rawId = useId();
  const myHash = `${MODAL_HASH_PREFIX}${rawId.replace(/[^a-zA-Z0-9]/g, '')}`;
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (!open || !historyClose) return;
    return openModalEntry(
      () => navigateRef.current({ hash: myHash, search: window.location.search }, { replace: false }),
      { close: () => onCloseRef.current(), stillOpen: () => openRef.current },
    );
  }, [open, historyClose, myHash]);

  return ref;
}
