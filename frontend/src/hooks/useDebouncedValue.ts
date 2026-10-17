import { useEffect, useState } from 'react';

/** 값이 N ms 동안 안정되면 그 시점의 값을 반환한다 — 검색어처럼 타이핑마다 refetch 가
 *  나가지 않게 할 때 쓴다(쿼리에는 `placeholderData: keepPreviousData` 를 함께 준다). */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
