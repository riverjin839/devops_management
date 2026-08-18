import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { arrayMove } from '@dnd-kit/sortable';

/** 컬럼 순서 + 표시여부 개인화 hook — localStorage 자동 영속화.
 *
 * `useColumnWidths` 와 같은 패턴(저장값 ⊕ defaults 머지, rAF 디바운스 저장)을 따른다.
 * 새 컬럼이 코드에 추가되면 저장값에 없어도 기본 순서/표시값으로 자동 편입된다.
 */
export interface UseColumnLayoutOpts<K extends string> {
  /** 전체 컬럼의 기본 순서 (숨김 컬럼 포함). */
  defaultOrder: K[];
  /** 기본 표시(visible) 컬럼. 나머지는 기본 숨김. */
  defaultVisible: K[];
  /** 숨길 수 없는 컬럼 (토글 무시, 항상 표시). */
  alwaysVisible?: K[];
}

function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** 저장 순서에서 유효 키만 남기고, 누락된 기본 키(신규 컬럼)는 뒤에 덧붙인다. */
function mergeOrder<K extends string>(saved: K[] | null, def: K[]): K[] {
  if (!Array.isArray(saved)) return [...def];
  const defSet = new Set(def);
  const kept = saved.filter((k) => defSet.has(k));
  const keptSet = new Set(kept);
  const missing = def.filter((k) => !keptSet.has(k));
  return [...kept, ...missing];
}

export function useColumnLayout<K extends string>(storageKey: string, opts: UseColumnLayoutOpts<K>) {
  const orderKey = `k8s:colorder:${storageKey}`;
  const visKey = `k8s:colvis:${storageKey}`;
  const always = useMemo(() => new Set<K>(opts.alwaysVisible ?? []), [opts.alwaysVisible]);

  const defaultVisibleMap = useMemo(() => {
    const visSet = new Set(opts.defaultVisible);
    return Object.fromEntries(opts.defaultOrder.map((k) => [k, visSet.has(k)])) as Record<K, boolean>;
  }, [opts.defaultOrder, opts.defaultVisible]);

  const [order, setOrder] = useState<K[]>(() => mergeOrder(loadJson<K[]>(orderKey), opts.defaultOrder));
  const [visible, setVisible] = useState<Record<K, boolean>>(() => ({
    ...defaultVisibleMap,
    ...(loadJson<Record<K, boolean>>(visKey) ?? {}),
  }));

  // 저장 (debounced via rAF)
  const saveRef = useRef<number | null>(null);
  useEffect(() => {
    if (saveRef.current !== null) cancelAnimationFrame(saveRef.current);
    saveRef.current = requestAnimationFrame(() => {
      try {
        localStorage.setItem(orderKey, JSON.stringify(order));
        localStorage.setItem(visKey, JSON.stringify(visible));
      } catch { /* ignore */ }
    });
    return () => {
      if (saveRef.current !== null) cancelAnimationFrame(saveRef.current);
    };
  }, [order, visible, orderKey, visKey]);

  /** rAF 디바운스를 건너뛰고 지금 상태를 즉시 저장 — "설정 저장" 같은 명시적 액션용. */
  const saveNow = useCallback(() => {
    if (saveRef.current !== null) { cancelAnimationFrame(saveRef.current); saveRef.current = null; }
    try {
      localStorage.setItem(orderKey, JSON.stringify(order));
      localStorage.setItem(visKey, JSON.stringify(visible));
    } catch { /* ignore */ }
  }, [order, visible, orderKey, visKey]);

  const isVisible = useCallback(
    (k: K): boolean => always.has(k) || visible[k] !== false,
    [always, visible],
  );

  const visibleOrder = useMemo(() => order.filter((k) => isVisible(k)), [order, isVisible]);

  const toggleVisible = useCallback(
    (k: K) => {
      if (always.has(k)) return;
      setVisible((m) => ({ ...m, [k]: m[k] === false ? true : false }));
    },
    [always],
  );

  /** 드래그 정렬 — activeKey 를 overKey 위치로 이동 (전체 order 기준). */
  const reorder = useCallback((activeKey: K, overKey: K) => {
    setOrder((prev) => {
      const from = prev.indexOf(activeKey);
      const to = prev.indexOf(overKey);
      if (from === -1 || to === -1 || from === to) return prev;
      return arrayMove(prev, from, to);
    });
  }, []);

  const reset = useCallback(() => {
    setOrder([...opts.defaultOrder]);
    setVisible({ ...defaultVisibleMap });
    try {
      localStorage.removeItem(orderKey);
      localStorage.removeItem(visKey);
    } catch { /* ignore */ }
  }, [opts.defaultOrder, defaultVisibleMap, orderKey, visKey]);

  return { order, visibleOrder, isVisible, toggleVisible, reorder, reset, saveNow };
}
