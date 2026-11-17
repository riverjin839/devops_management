// 일괄 등록 미리보기의 행 내용 — 오류는 열·사유, 변경은 이전 → 이후, 추가는 요약. 전체 양식·서버 일괄 등록 공용.
import type { DcImportRow } from '@/types';

function cell(v: string | number | boolean | null | undefined): string {
  return v === null || v === undefined || v === '' ? '(빈 값)' : String(v);
}

export function ImportRowDetail({ row }: { row: DcImportRow }) {
  if (row.action === 'error') {
    return (
      <ul className="space-y-0.5">
        {(row.errors ?? []).map((e, i) => (
          <li key={i}>
            {e.column && <span className="font-semibold">{e.column} — </span>}
            {e.message}
          </li>
        ))}
      </ul>
    );
  }
  if (row.action === 'update') {
    return (
      <span>
        {(row.changes ?? []).map((c, i) => (
          <span key={c.column}>
            {i > 0 && ' · '}
            {c.column} <span className="font-mono text-xs">{cell(c.old)} → {cell(c.new)}</span>
          </span>
        ))}
      </span>
    );
  }
  return <span className="text-muted-foreground">{row.summary}</span>;
}

