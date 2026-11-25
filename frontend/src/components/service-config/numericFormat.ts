// 수치형 설정 값 해석·표시 — 막대(NumericBars)와 표가 같이 쓴다.
export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;

export function parseNum(v: string | null | undefined): number | null {
  if (v == null || v.trim() === '' || !/^-?\d+(\.\d+)?$/.test(v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 표시 문자열 — size(bytes)는 GiB·MiB, 그 외는 천 단위 구분. */
export function formatNum(n: number, size: boolean): string {
  if (size) {
    if (Math.abs(n) >= GIB) return `${+(n / GIB).toFixed(2)} GiB`;
    if (Math.abs(n) >= MIB) return `${+(n / MIB).toFixed(1)} MiB`;
    return `${n.toLocaleString()} B`;
  }
  return n.toLocaleString();
}

