import { useEffect, useId, useRef } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';

/**
 * 모달/다이얼로그 공통 접근성 훅.
 *  - Escape 로 닫기
 *  - 포커스 트랩 (Tab/Shift+Tab 이 모달 밖으로 나가지 않음)
 *  - 열릴 때 초점 이동(모달 내부에 이미 포커스가 있으면 존중), 닫힐 때 트리거로 복원
 *  - (opt-in) 브라우저/폰 "뒤로가기"로 모달만 닫기 — historyClose:true
 *
 * 반환한 ref 를 모달 컨테이너에 연결하고, 컨테이너에는
 * `role="dialog" aria-modal="true"` (+ 가능하면 aria-labelledby)를 함께 부여한다.
 *
 * 사용 예:
 *   const ref = useModalA11y(open, onClose, { historyClose: true });
 *   <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="...">…</div>
 *
 * historyClose 동작(React Router 협조 · raw history 조작 없음):
 *   열릴 때 hash(`#m_<id>`)를 push → 뒤로가기(POP)로 hash 가 사라지면 onClose 호출.
 *   X/Escape 등 프로그램적으로 닫으면 남긴 hash 엔트리를 navigate(-1) 로 정리.
 *   hash 는 인스턴스별 고유값이라 중첩 모달도 각자만 닫힌다(상위 모달 오작동 없음).
 */
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

interface Options {
  /** 브라우저/폰 뒤로가기로 이 모달을 닫는다(히스토리에 임시 엔트리 push). 기본 false. */
  historyClose?: boolean;
}

export function useModalA11y(open: boolean, onClose: () => void, opts: Options = {}) {
  const ref = useRef<HTMLDivElement>(null);
  const historyClose = opts.historyClose ?? false;

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

  // ── (opt-in) 뒤로가기로 닫기 — hash 기반, React Router 협조 ────────────────
  const rawId = useId();
  const myHash = `#m${rawId.replace(/[^a-zA-Z0-9]/g, '')}`;
  const navigate = useNavigate();
  const location = useLocation();
  const navType = useNavigationType();
  const pushedRef = useRef(false);

  // 열릴 때 hash push, 닫힐 때(cleanup) 남은 hash 정리
  useEffect(() => {
    if (!open || !historyClose) return;
    pushedRef.current = true;
    navigate({ hash: myHash, search: window.location.search }, { replace: false });
    return () => {
      if (pushedRef.current && window.location.hash === myHash) {
        pushedRef.current = false;
        navigate(-1);
      }
    };
    // navigate/location.search 는 안정적이므로 open 토글에만 반응
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, historyClose]);

  // 뒤로가기(POP)로 내 hash 가 사라지면 닫기
  useEffect(() => {
    if (!open || !historyClose) return;
    if (pushedRef.current && navType === 'POP' && location.hash !== myHash) {
      pushedRef.current = false;
      onCloseRef.current();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, historyClose, location.hash, navType]);

  return ref;
}
