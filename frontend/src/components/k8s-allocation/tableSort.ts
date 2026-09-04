// 표 정렬/페이징 훅·헬퍼 — 컴포넌트가 아닌 export 는 react-refresh 규칙상 별도 파일에 둔다.
import { useMemo, useRef } from 'react';

export type SortDir = 'asc' | 'desc';
export interface SortState { key: string; dir: SortDir }

const nameOf = <T extends { name?: string; namespace?: string }>(r: T) => (r.name ?? r.namespace ?? '') as string;

/** rows 를 accessors[sort.key] 기준 정렬(숫자/문자). 동일값은 name tiebreak. null 은 말단.
 *
 * frozen=true(집계 중) 이면 직전 순서를 고정하고 새로 들어온 행만 뒤에 붙인다 — 1.5초
 * 폴링마다 부분 결과가 갱신될 때 행이 위아래로 뛰어다니는 "화면이 계속 바뀌는" 현상을
 * 막는다. 집계가 끝나면(frozen=false) 정상 정렬로 복귀한다. */
export function useTableSort<T extends { name?: string; namespace?: string }>(
  rows: T[], accessors: Record<string, (r: T) => number | string | null>, sort: SortState,
  frozen = false,
): T[] {
  const sorted = useMemo(() => {
    const acc = accessors[sort.key];
    if (!acc) return rows;
    const mul = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = acc(a); const vb = acc(b);
      // null/undefined 는 항상 뒤로
      if (va == null && vb == null) return nameOf(a).localeCompare(nameOf(b));
      if (va == null) return 1;
      if (vb == null) return -1;
      let c: number;
      if (typeof va === 'number' && typeof vb === 'number') c = va - vb;
      else c = String(va).localeCompare(String(vb));
      if (c === 0) return nameOf(a).localeCompare(nameOf(b));
      return c * mul;
    });
  }, [rows, accessors, sort]);
  const orderRef = useRef<string[] | null>(null);
  return useMemo(() => {
    if (!frozen || !orderRef.current) {
      orderRef.current = sorted.map(nameOf);
      return sorted;
    }
    const idx = new Map(orderRef.current.map((k, i) => [k, i]));
    const known = sorted.filter((r) => idx.has(nameOf(r)))
      .sort((a, b) => (idx.get(nameOf(a)) ?? 0) - (idx.get(nameOf(b)) ?? 0));
    const fresh = sorted.filter((r) => !idx.has(nameOf(r)));
    const out = [...known, ...fresh];
    orderRef.current = out.map(nameOf);
    return out;
  }, [sorted, frozen]);
}

export function nextSort(prev: SortState, k: string, numeric: boolean): SortState {
  if (prev.key === k) return { key: k, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
  return { key: k, dir: numeric ? 'desc' : 'asc' };
}


/** rows 를 page/pageSize 로 잘라 현재 페이지 행과 메타를 돌려준다. page 범위는 자동 보정. */
export function paginate<T>(rows: T[], page: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  return { totalPages, safePage, start, pageRows: rows.slice(start, start + pageSize) };
}

