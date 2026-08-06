import { useEffect, useRef, useState, type ReactNode } from 'react';

interface DoubleScrollXProps {
  children: ReactNode;
  /** wrapper 의 추가 클래스 — border / rounded / 등 outer 스타일링 */
  className?: string;
  /** 상단 스크롤 레일 높이(px). 기본 12px (OS 기본 스크롤바 두께 정도). */
  topRailHeight?: number;
  /**
   * 본문 스크롤 컨테이너의 추가 클래스. `max-h-*` 를 주면 세로로도 스크롤되므로
   * 안쪽 `thead` 에 `sticky top-0` 을 걸어 헤더를 고정할 수 있다 (미지정 시 기존처럼
   * 페이지 스크롤을 따라가고 헤더 고정은 동작하지 않는다).
   */
  bodyClassName?: string;
}

/**
 * 가로 스크롤이 필요한 표/리스트를 감싸 **위·아래 양쪽에 스크롤바**를 노출하는 래퍼.
 *
 * - 본문은 ``overflow-x-auto`` 컨테이너에 그대로 렌더 (기존 패턴과 동일).
 * - 본문 위에 1px 높이의 더미 div 를 가진 별도 스크롤 컨테이너를 두고, 본문의
 *   ``scrollWidth`` 만큼 더미 폭을 맞춰 OS 가 상단 스크롤바를 그리도록 한다.
 * - 두 컨테이너의 ``scrollLeft`` 를 양방향으로 동기화 (재귀 방지 lock).
 * - 본문이 실제로 overflow 하지 않으면 상단 레일을 숨김 (height: 0) — wide 가 아닌
 *   상태에서 빈 회색 바가 보이지 않도록.
 *
 * 사용:
 * ```tsx
 * <DoubleScrollX className="rounded-xl border border-border">
 *   <table>...</table>
 * </DoubleScrollX>
 * ```
 */
export function DoubleScrollX({
  children,
  className = '',
  topRailHeight = 12,
  bodyClassName = '',
}: DoubleScrollXProps) {
  const topRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const [innerWidth, setInnerWidth] = useState(0);
  const [scrollable, setScrollable] = useState(false);

  // 위·아래 scrollLeft 동기화 — 재귀 호출을 막기 위해 lock 사용.
  useEffect(() => {
    const top = topRef.current;
    const bottom = bottomRef.current;
    if (!top || !bottom) return;

    let lock = false;
    const onTop = () => {
      if (lock) return;
      lock = true;
      bottom.scrollLeft = top.scrollLeft;
      // 다음 tick 에 unlock — bottom 의 scroll 이벤트가 다시 들어오지 않도록.
      requestAnimationFrame(() => { lock = false; });
    };
    const onBottom = () => {
      if (lock) return;
      lock = true;
      top.scrollLeft = bottom.scrollLeft;
      requestAnimationFrame(() => { lock = false; });
    };

    top.addEventListener('scroll', onTop, { passive: true });
    bottom.addEventListener('scroll', onBottom, { passive: true });
    return () => {
      top.removeEventListener('scroll', onTop);
      bottom.removeEventListener('scroll', onBottom);
    };
  }, []);

  // 본문 scrollWidth / clientWidth 를 추적해 상단 더미 폭과 노출 여부 갱신.
  useEffect(() => {
    const bottom = bottomRef.current;
    if (!bottom) return;
    const update = () => {
      const sw = bottom.scrollWidth;
      const cw = bottom.clientWidth;
      const nextScrollable = sw > cw + 1;
      // 변경 없을 때 setState 를 건너뛰어 ResizeObserver 측정 피드백 루프를 차단.
      setInnerWidth((prev) => (prev === sw ? prev : sw));
      setScrollable((prev) => (prev === nextScrollable ? prev : nextScrollable));
    };
    update();
    // RO 콜백 안에서 동기 레이아웃 변경을 피하려고 rAF 로 한 틱 미룬다
    // ("ResizeObserver loop ..." 경고 및 무한 측정 방지).
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    });
    ro.observe(bottom);
    // 행 추가/삭제 같은 자식 변화도 반영
    const mo = new MutationObserver(update);
    mo.observe(bottom, { childList: true, subtree: true, attributes: true });
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  return (
    <div className={className}>
      {/* 상단 스크롤 레일 — overflow 가 실제로 발생할 때만 노출 */}
      <div
        ref={topRef}
        className="overflow-x-auto"
        style={{
          height: scrollable ? topRailHeight : 0,
          transition: 'height 80ms linear',
        }}
        aria-hidden
      >
        <div style={{ width: innerWidth || 1, height: 1 }} />
      </div>
      <div ref={bottomRef} className={`overflow-x-auto ${bodyClassName}`}>
        {children}
      </div>
    </div>
  );
}
