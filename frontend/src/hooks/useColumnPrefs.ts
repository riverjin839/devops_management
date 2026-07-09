import { useCallback, useState } from 'react';

/**
 * 테이블 컬럼 show/hide 영속화 (freelens 파리티) — localStorage `pep:k8s:cols:{key}`.
 * 저장 형식: 숨긴 컬럼 key 의 JSON 배열. 항목이 없으면 전체 표시.
 */
export function useColumnPrefs(tableKey: string) {
  const storageKey = `pep:k8s:cols:${tableKey}`;
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* 손상된 값 → 기본 */ }
    return new Set();
  });

  const toggle = useCallback((colKey: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(colKey)) next.delete(colKey);
      else next.add(colKey);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch { /* quota 초과 등 → 무시(세션 내 상태는 유지) */ }
      return next;
    });
  }, [storageKey]);

  const isHidden = useCallback((colKey: string) => hidden.has(colKey), [hidden]);

  return { hidden, toggle, isHidden };
}
