import { useEffect, useRef } from 'react';

/**
 * 모달/다이얼로그 공통 접근성 훅.
 *  - Escape 로 닫기
 *  - 포커스 트랩 (Tab/Shift+Tab 이 모달 밖으로 나가지 않음)
 *  - 열릴 때 초점 이동(모달 내부에 이미 포커스가 있으면 존중), 닫힐 때 트리거로 복원
 *
 * 반환한 ref 를 모달 컨테이너에 연결하고, 컨테이너에는
 * `role="dialog" aria-modal="true"` (+ 가능하면 aria-labelledby)를 함께 부여한다.
 *
 * 사용 예:
 *   const ref = useModalA11y(open, onClose);
 *   <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="...">…</div>
 */
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function useModalA11y(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);

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

    // 초기 포커스 — 이미 모달 내부에 포커스가 있으면(예: autoFocus) 존중
    if (!container?.contains(document.activeElement)) {
      const initial =
        container?.querySelector<HTMLElement>('[data-autofocus]') ?? focusables()[0] ?? container;
      initial?.focus();
    }

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
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
      // 닫힐 때 트리거 요소로 포커스 복원(존재·연결돼 있을 때만)
      if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) {
        prevFocus.focus();
      }
    };
  }, [open, onClose]);

  return ref;
}
