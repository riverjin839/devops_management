// 엑셀·구글 시트에서 복사한 표(TSV) 또는 CSV 텍스트 → 2차원 배열. 따옴표 안의 줄바꿈·구분자도 처리한다.
// 노드 서버스펙 붙여넣기와 DC 인벤토리 서버 일괄 등록이 같이 쓴다.
// Excel 복사본은 기본 TSV (\t 구분). Google Sheets 도 동일.
// CSV 처럼 쉼표 기반도 감지해서 파싱.
export function parseTabular(text: string): { rows: string[][]; delim: '\t' | ',' } {
  // 머리글 위에 제목 줄(탭 없음)이 있는 표도 있으므로 첫 줄만 보지 않고 앞쪽 10줄에 탭이 있는지 본다.
  const head = text.split(/\r?\n/).slice(0, 10);
  const delim: '\t' | ',' = head.some((l) => l.includes('\t')) ? '\t' : ',';

  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuote = false;
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuote = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuote = true; i++; continue; }
    if (c === delim) { cur.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  return { rows: rows.filter((r) => r.some((v) => v.trim() !== '')), delim };
}
