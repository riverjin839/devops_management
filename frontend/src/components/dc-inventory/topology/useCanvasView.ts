// 캔버스 화면 이동·확대 — 빈 곳을 끌면 이동, 휠로 커서 기준 확대/축소, "화면 맞춤" 으로 전체가 한 화면에.
// 좌표 변환(화면 → 캔버스)도 여기서 한다. 휠은 기본 스크롤을 막아야 해서 passive:false 로 직접 등록한다.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

export interface View { x: number; y: number; k: number }
export const MIN_K = 0.25;
export const MAX_K = 2;

const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

export function useCanvasView(contentW: number, contentH: number) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const pan = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const fitted = useRef(false);

  // 상자 크기 추적 — 화면 맞춤·미니맵 시야 사각형에 쓴다.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (size.w === 0 || contentW === 0) return;
    const k = clampK(Math.min((size.w - 24) / contentW, (size.h - 24) / contentH, 1));
    setView({ k, x: (size.w - contentW * k) / 2, y: 12 });
  }, [size.w, size.h, contentW, contentH]);

  // 처음 열 때 한 번 자동 맞춤.
  useEffect(() => {
    if (!fitted.current && size.w > 0 && contentW > 0) { fitted.current = true; fit(); }
  }, [fit, size.w, contentW]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    setView((v) => {
      const k = clampK(v.k * factor);
      const px = cx ?? size.w / 2;
      const py = cy ?? size.h / 2;
      return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
    });
  }, [size.w, size.h]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
  }, [view]);

  /** 미니맵에서 누른 캔버스 좌표가 화면 가운데에 오게. */
  const centerOn = useCallback((cx: number, cy: number) => {
    setView((v) => ({ ...v, x: size.w / 2 - cx * v.k, y: size.h / 2 - cy * v.k }));
  }, [size.w, size.h]);

  const panStart = (e: ReactPointerEvent) => {
    pan.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    setPanning(true);
  };
  const panMove = (e: ReactPointerEvent): boolean => {
    if (!pan.current) return false;
    const p = pan.current;
    setView((v) => ({ ...v, x: p.ox + e.clientX - p.sx, y: p.oy + e.clientY - p.sy }));
    return true;
  };
  const panEnd = () => { pan.current = null; setPanning(false); };

  return { boxRef, view, size, fit, zoomAt, toCanvas, centerOn, panStart, panMove, panEnd, panning };
}
