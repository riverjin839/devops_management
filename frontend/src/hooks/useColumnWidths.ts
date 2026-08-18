import { useCallback, useEffect, useRef, useState } from 'react';

/** 컬럼 너비 관리 hook — localStorage 자동 영속화.
 *
 * 사용:
 *   const { widths, getWidth, beginResize } = useColumnWidths('cluster-table', defaults);
 *   <th style={{ width: getWidth('hostname') }}>
 *     호스트명
 *     <ResizeGrip onMouseDown={(e) => beginResize('hostname', e)} />
 *   </th>
 */
export interface UseColumnWidthsOpts {
  /** 컬럼 별 기본 너비 (px). 사용자 저장값이 있으면 무시됨. */
  defaults: Record<string, number>;
  /** 최소 / 최대 너비 (px) */
  min?: number;
  max?: number;
}

export function useColumnWidths(storageKey: string, opts: UseColumnWidthsOpts) {
  const min = opts.min ?? 60;
  const max = opts.max ?? 1200;
  const fullKey = `k8s:colw:${storageKey}`;

  const [widths, setWidths] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem(fullKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, number>;
        if (parsed && typeof parsed === 'object') {
          // defaults + saved 머지 (새 컬럼 추가됐을 때 기본값 적용)
          return { ...opts.defaults, ...parsed };
        }
      }
    } catch { /* ignore */ }
    return { ...opts.defaults };
  });

  // 저장 (debounced via rAF)
  const saveRef = useRef<number | null>(null);
  useEffect(() => {
    if (saveRef.current !== null) cancelAnimationFrame(saveRef.current);
    saveRef.current = requestAnimationFrame(() => {
      try { localStorage.setItem(fullKey, JSON.stringify(widths)); } catch { /* ignore */ }
    });
    return () => {
      if (saveRef.current !== null) cancelAnimationFrame(saveRef.current);
    };
  }, [widths, fullKey]);

  /** rAF 디바운스를 건너뛰고 지금 상태를 즉시 저장 — "설정 저장" 같은 명시적 액션용. */
  const saveNow = useCallback(() => {
    if (saveRef.current !== null) { cancelAnimationFrame(saveRef.current); saveRef.current = null; }
    try { localStorage.setItem(fullKey, JSON.stringify(widths)); } catch { /* ignore */ }
  }, [widths, fullKey]);

  const getWidth = useCallback((col: string): number => {
    return widths[col] ?? opts.defaults[col] ?? 120;
  }, [widths, opts.defaults]);

  const setWidth = useCallback((col: string, w: number) => {
    setWidths((m) => ({ ...m, [col]: Math.max(min, Math.min(max, Math.round(w))) }));
  }, [min, max]);

  const reset = useCallback(() => {
    setWidths({ ...opts.defaults });
    try { localStorage.removeItem(fullKey); } catch { /* ignore */ }
  }, [opts.defaults, fullKey]);

  /** mousedown 핸들러 — 드래그 시작. ResizeGrip 의 onMouseDown 에 직접 연결. */
  const beginResize = useCallback((col: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[col] ?? opts.defaults[col] ?? 120;

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      setWidth(col, startW + delta);
    };
    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [widths, opts.defaults, setWidth]);

  /** double-click → auto-fit (기본값 복원) */
  const autoFit = useCallback((col: string) => {
    setWidths((m) => {
      const next = { ...m };
      delete next[col];
      const def = opts.defaults[col];
      if (def !== undefined) next[col] = def;
      return next;
    });
  }, [opts.defaults]);

  return { widths, getWidth, setWidth, beginResize, autoFit, reset, saveNow };
}
