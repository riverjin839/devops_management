import { useCallback, useEffect, useRef, useState } from 'react';

/** 컬럼 너비 관리 hook — localStorage 자동 영속화.
 *
 * 사용:
 *   const { widths, getWidth, beginResize } = useColumnWidths('cluster-table', defaults);
 *   <th style={{ width: getWidth('hostname') }}>
 *     호스트명
 *     <ResizeGrip onMouseDown={(e) => beginResize('hostname', e)} />
 *   </th>
 *
 * 컬럼 너비를 하드코딩된 기본값(defaults)에만 의존하면, 실제 값이 짧은 컬럼(배지/칩 하나
 * 뿐인 셀)도 기본폭이 넉넉하면 계속 오른쪽 여백이 남는다 — 그때마다 defaults 숫자를 수동
 * 조정해야 했다. `autoFit`/`autoFitMissing` 은 실제 렌더된 셀(`data-col="<col>"` 마크된
 * `<td>`/`<th>`)의 `scrollWidth` 를 측정해 **내용 기준으로 폭을 잡고 그대로 저장(고정)
 * 한다** — 한 번 계산되면 이후 렌더마다 다시 재는 게 아니라 저장된 값을 그대로 쓴다.
 */
export interface UseColumnWidthsOpts {
  /** 컬럼 별 기본 너비 (px). 사용자 저장값이 있으면 무시됨. */
  defaults: Record<string, number>;
  /** 최소 / 최대 너비 (px) */
  min?: number;
  max?: number;
}

/** `[data-col="col"]` 로 마크된 모든 셀(헤더 포함) 중 가장 넓은 실제 콘텐츠 폭(px).
 *  `scrollWidth` 는 `overflow: visible` 인 요소에서도 자식이 넘친 실제 크기를 반영하므로,
 *  `table-layout: fixed` 로 컬럼폭이 강제된 상태에서도 "내용이 필요로 하는" 폭을 그대로
 *  잰다. 매칭되는 요소가 없으면(컬럼이 화면에 없음/접힘) 0.*/
function measureContentWidth(col: string, root: ParentNode): number {
  const nodes = root.querySelectorAll<HTMLElement>(`[data-col="${col}"]`);
  let max = 0;
  nodes.forEach((el) => { if (el.scrollWidth > max) max = el.scrollWidth; });
  return max;
}

export function useColumnWidths(storageKey: string, opts: UseColumnWidthsOpts) {
  const min = opts.min ?? 60;
  const max = opts.max ?? 1200;
  const fullKey = `k8s:colw:${storageKey}`;

  // localStorage 에 실제로 저장돼 있던(= 사용자가 드래그했거나 이전에 자동맞춤한) 컬럼
  // 키 집합 — "아직 아무도 손대지 않아 하드코딩 기본폭을 그대로 쓰는 중" 인 컬럼을
  // 구분하는 데 쓴다(autoFitOnce 가 이 집합에 없는 컬럼만 내용 기준으로 다시 잰다).
  const knownKeysRef = useRef<Set<string>>(new Set());

  const [widths, setWidths] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem(fullKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, number>;
        if (parsed && typeof parsed === 'object') {
          knownKeysRef.current = new Set(Object.keys(parsed));
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
    knownKeysRef.current.add(col);
    setWidths((m) => ({ ...m, [col]: Math.max(min, Math.min(max, Math.round(w))) }));
  }, [min, max]);

  const reset = useCallback(() => {
    setWidths({ ...opts.defaults });
    knownKeysRef.current = new Set();
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

  /** double-click(리사이즈 그립) → 지금 렌더된 실제 콘텐츠 폭에 맞춰 다시 재고 그 값으로
   *  고정·저장한다. 측정 대상이 화면에 없으면(컬럼이 숨겨졌거나 행이 0개) 안전하게
   *  하드코딩 기본값으로 되돌린다. */
  const autoFit = useCallback((col: string, root?: ParentNode | null) => {
    const measured = measureContentWidth(col, root ?? document);
    if (measured > 0) {
      setWidth(col, measured + 2);
      return;
    }
    knownKeysRef.current.delete(col);
    setWidths((m) => {
      const next = { ...m };
      delete next[col];
      const def = opts.defaults[col];
      if (def !== undefined) next[col] = def;
      return next;
    });
  }, [opts.defaults, setWidth]);

  /** 아직 한 번도 (드래그로든 자동맞춤으로든) 손대지 않은 컬럼만 골라 내용 기준 폭으로
   *  맞추고 저장한다 — 데이터가 처음 로드된 직후 한 번 호출하면, 하드코딩 defaults 대신
   *  "실제 값 기준으로 여백 없는" 폭이 새 기본값처럼 자리잡는다. 이미 손댄(known) 컬럼은
   *  건드리지 않으므로 반복 호출해도 사용자가 맞춰둔 폭을 덮어쓰지 않는다. */
  const autoFitMissing = useCallback((cols: string[], root?: ParentNode | null) => {
    const scope = root ?? document;
    for (const col of cols) {
      if (knownKeysRef.current.has(col)) continue;
      const measured = measureContentWidth(col, scope);
      if (measured > 0) setWidth(col, measured + 2);
    }
  }, [setWidth]);

  return { widths, getWidth, setWidth, beginResize, autoFit, autoFitMissing, reset, saveNow };
}
