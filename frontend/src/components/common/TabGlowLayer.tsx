import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * 탭 글로우 노치 — 화면 안의 모든 가로 탭 목록(`[role="tablist"]`)에서 마우스를 따라가는 빛나는 아치.
 *
 * 앱 셸에 **한 번만** 마운트한다(`App.tsx` AppShell). 페이지·탭 컴포넌트는 고치지 않는다 — 탭 목록이
 * `role="tablist"` + `role="tab"` + `aria-selected` 만 지키면(공용 `SegTabs mode="tabs"`·직접 만든 탭 모두) 적용된다.
 *
 * 동작(메인 레일의 글로우 노치와 같은 규칙, DESIGN_SYSTEM.md §12.16):
 *   - 탭 목록 위에 마우스가 들어오면 아래 테두리에 빛나는 선이 나타나고, 현재 탭에서 출발한 아치가 포인터를
 *     연속으로 따라간다(첫 탭 ~ 마지막 탭 중심 범위). SETTLE_MS 멈추면 가장 가까운 탭에 붙어 그 폭으로 감싼다.
 *   - 탭 목록을 벗어나면 아치가 현재 탭으로 돌아간 뒤 사라진다. 탭 전환은 여전히 클릭·키보드로만 한다.
 *   - 키보드 포커스(:focus-visible)가 탭에 오면 그 탭을 감싼다.
 *   - 세로 탭 목록(`aria-orientation="vertical"`)·터치 포인터는 건너뛴다. 모션 줄이기면 애니메이션 없이 바로 붙는다.
 *
 * 그리기는 body 포털의 고정 SVG 1개(pointer-events 없음)이고, 위치·모양은 rAF 루프가 DOM 에 직접 쓴다 —
 * 마우스 이동마다 React 를 다시 그리지 않는다. 색은 `--primary` 토큰(테마·강조색을 따름), 모양은 index.css "탭 글로우 노치".
 */

const PAD = 8; // 글로우가 잘리지 않게 탭 목록 사각형 밖으로 둘 여백(px)
const SETTLE_MS = 160;
const LEAVE_HIDE_MS = 320;
const EASE = 0.22; // 프레임당 목표값으로 다가가는 비율(따라가기 부드러움)

interface TabBox { cx: number; half: number }

function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

function tabsOf(list: Element): HTMLElement[] {
  return Array.from(list.querySelectorAll<HTMLElement>('[role="tab"]'))
    .filter((t) => t.closest('[role="tablist"]') === list && t.offsetParent !== null);
}

function boxOf(tab: Element, listRect: DOMRect): TabBox {
  const r = tab.getBoundingClientRect();
  return { cx: r.left - listRect.left + r.width / 2, half: r.width / 2 };
}

function eligible(list: Element | null): list is HTMLElement {
  return !!list && list.getAttribute('aria-orientation') !== 'vertical' && tabsOf(list).length > 1;
}

export function TabGlowLayer() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fillRef = useRef<SVGPathElement | null>(null);
  const lineRef = useRef<SVGPathElement | null>(null);

  useEffect(() => {
    const svg = svgRef.current;
    const fillEl = fillRef.current;
    const lineEl = lineRef.current;
    if (!svg || !fillEl || !lineEl) return;

    let list: HTMLElement | null = null; // 지금 그리고 있는 탭 목록
    let target: TabBox | null = null;
    let cur: TabBox | null = null;
    let raf = 0;
    let settleTimer: number | undefined;
    let hideTimer: number | undefined;
    let leaving = false; // 벗어나는 중 — 바깥에서 마우스가 계속 움직여도 타이머를 다시 걸지 않는다

    const clearTimers = () => {
      if (settleTimer !== undefined) { window.clearTimeout(settleTimer); settleTimer = undefined; }
      if (hideTimer !== undefined) { window.clearTimeout(hideTimer); hideTimer = undefined; }
    };

    const draw = () => {
      if (!list || !cur) return;
      const lr = list.getBoundingClientRect();
      const w = lr.width;
      const h = lr.height;
      svg.style.left = `${lr.left - PAD}px`;
      svg.style.top = `${lr.top - PAD}px`;
      svg.setAttribute('width', String(w + PAD * 2));
      svg.setAttribute('height', String(h + PAD * 2));
      // 탭 목록 좌표 → SVG 좌표(+PAD). 바닥선은 모서리 둥글기만큼 안쪽에서 시작한다.
      const inset = Math.min(10, h / 2);
      const y0 = PAD + h - 0.75; // 아래 테두리
      const yt = PAD + 0.75; // 아치 꼭대기(위 테두리)
      const cx = PAD + cur.cx;
      const a = cur.half + 2; // 탭보다 살짝 넓게 감싼다
      const s = Math.min(12, h * 0.45); // 어깨(바닥선 → 아치로 꺾이는 구간)
      const left = PAD + inset;
      const right = PAD + w - inset;
      const x1 = Math.max(left, cx - a - s);
      const x2 = Math.min(right, cx + a + s);
      const arch = `C${x1 + s * 0.9},${y0} ${cx - a + 1},${yt} ${cx},${yt} C${cx + a - 1},${yt} ${x2 - s * 0.9},${y0} ${x2},${y0}`;
      lineEl.setAttribute('d', `M${left},${y0} L${x1},${y0} ${arch} L${right},${y0}`);
      fillEl.setAttribute('d', `M${x1},${y0} ${arch} Z`);
    };

    const tick = () => {
      raf = 0;
      if (!list || !target) return;
      if (!cur || prefersReducedMotion()) {
        cur = { ...target };
      } else {
        cur = { cx: cur.cx + (target.cx - cur.cx) * EASE, half: cur.half + (target.half - cur.half) * EASE };
        if (Math.abs(target.cx - cur.cx) < 0.3 && Math.abs(target.half - cur.half) < 0.3) cur = { ...target };
      }
      draw();
      if (cur.cx !== target.cx || cur.half !== target.half) raf = window.requestAnimationFrame(tick);
    };
    const kick = () => { if (!raf) raf = window.requestAnimationFrame(tick); };

    const show = (next: HTMLElement) => {
      if (list !== next) {
        list = next;
        // 새 탭 목록 — 현재 탭(없으면 첫 탭)에서 출발한다.
        const lr = next.getBoundingClientRect();
        const tabs = tabsOf(next);
        const sel = tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0];
        cur = boxOf(sel, lr);
        target = { ...cur };
        draw();
      }
      leaving = false;
      svg.dataset.on = '';
    };

    const hide = () => {
      list = null; target = null; cur = null; leaving = false;
      delete svg.dataset.on;
    };

    /** 현재 탭으로 돌아간 뒤 사라진다. */
    const leave = () => {
      if (!list || leaving) return;
      leaving = true;
      clearTimers();
      const lr = list.getBoundingClientRect();
      const sel = tabsOf(list).find((t) => t.getAttribute('aria-selected') === 'true');
      if (sel) { target = boxOf(sel, lr); kick(); }
      hideTimer = window.setTimeout(() => { hideTimer = undefined; delete svg.dataset.on; }, LEAVE_HIDE_MS);
      settleTimer = window.setTimeout(() => { settleTimer = undefined; if (!svg.hasAttribute('data-on')) hide(); }, LEAVE_HIDE_MS + 250);
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = e.target instanceof Element ? e.target : null;
      const next = el?.closest('[role="tablist"]') ?? null;
      if (!eligible(next)) { leave(); return; }
      clearTimers();
      show(next);
      const lr = next.getBoundingClientRect();
      const boxes = tabsOf(next).map((t) => boxOf(t, lr));
      const x = e.clientX - lr.left;
      const nearest = boxes.reduce((b, c) => (Math.abs(c.cx - x) < Math.abs(b.cx - x) ? c : b), boxes[0]);
      const min = boxes[0].cx;
      const max = boxes[boxes.length - 1].cx;
      target = { cx: Math.min(max, Math.max(min, x)), half: nearest.half };
      kick();
      settleTimer = window.setTimeout(() => { settleTimer = undefined; target = { ...nearest }; kick(); }, SETTLE_MS);
    };

    // 키보드 — 포커스가 탭에 오면 그 탭을 감싼다(마우스 클릭 포커스는 :focus-visible 이 아니라 무시).
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (!el || el.getAttribute('role') !== 'tab' || !el.matches(':focus-visible')) return;
      const next = el.closest('[role="tablist"]');
      if (!eligible(next)) return;
      clearTimers();
      show(next);
      target = boxOf(el, next.getBoundingClientRect());
      kick();
    };
    const onFocusOut = (e: FocusEvent) => {
      const to = e.relatedTarget instanceof Element ? e.relatedTarget : null;
      if (list && to && list.contains(to)) return;
      leave();
    };
    // 스크롤·크기 변경 — 보이는 동안 위치를 다시 잰다.
    const onReflow = () => { if (list) draw(); };

    document.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', leave);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    window.addEventListener('scroll', onReflow, { passive: true, capture: true });
    window.addEventListener('resize', onReflow);
    return () => {
      clearTimers();
      if (raf) window.cancelAnimationFrame(raf);
      document.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', leave);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      window.removeEventListener('scroll', onReflow, { capture: true });
      window.removeEventListener('resize', onReflow);
    };
  }, []);

  return createPortal(
    <svg ref={svgRef} aria-hidden focusable="false" className="tab-glow">
      <path ref={fillRef} className="tab-glow-fill" />
      <path ref={lineRef} className="tab-glow-line" />
    </svg>,
    document.body,
  );
}
