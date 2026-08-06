/** CSV 내보내기 공용 유틸 — 엑셀 한글 호환을 위해 UTF-8 BOM 을 항상 포함한다. */

/** RFC 4180: 콤마/따옴표/개행 포함 시 따옴표로 감싸고 내부 따옴표는 이중화. */
export function escapeCsvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 헤더 + 행들을 CSV 문자열로 직렬화(각 셀 escape). */
export function buildCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const head = headers.map(escapeCsvCell).join(',');
  const body = rows.map((r) => r.map(escapeCsvCell).join(',')).join('\n');
  return body ? `${head}\n${body}\n` : `${head}\n`;
}

/** CSV 문자열을 파일로 다운로드(UTF-8 BOM 포함 → 엑셀에서 한글 정상).
 * 앵커를 DOM 에 붙였다가 클릭 후 제거하고, revoke 는 다음 이벤트 루프로 미룬다 —
 * 즉시 revoke 하면 다운로드가 시작되기 전에 URL 이 무효화되어 Firefox/구버전 Safari 에서
 * 다운로드가 조용히 실패하는 사례가 있다. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
