/** Blob 을 파일로 내려받는다. revoke 를 다음 틱으로 미루는 이유는 `lib/csv.ts` `downloadCsv` 와 같다
 *  (즉시 revoke 하면 일부 브라우저에서 다운로드가 조용히 실패한다). */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
