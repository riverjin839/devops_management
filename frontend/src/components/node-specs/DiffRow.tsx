/* eslint-disable react-refresh/only-export-components -- ACTION_LABEL/ACTION_BADGE_CLS shared alongside DiffRow/ActionCountPills, same pattern as StatusBadge.tsx */
/**
 * CSV 업로드 / 엑셀 붙여넣기 두 모달이 동일하게 쓰는 diff 행 렌더러.
 * 예전엔 두 모달에 각각 복제돼 있었다 — 하나만 고치면 다른 쪽이 드리프트했다.
 */
import type { NodeSpecCsvDiff } from '@/types';

export const ACTION_LABEL: Record<string, string> = {
  insert: '신규', update: '업데이트', skip: '변경없음', error: '오류',
};

// 토큰 기반 — 테마 7종에서 색이 깨지지 않도록 emerald/amber/slate/red 같은 고정
// 팔레트 대신 --status-* 토큰을 쓴다. insert=healthy(신규 긍정), update=warning(변경
// 주의), skip=unknown(중립), error=critical.
export const ACTION_BADGE_CLS: Record<string, string> = {
  insert: 'bg-status-healthy/10 text-status-healthy border-status-healthy/30',
  update: 'bg-status-warning/10 text-status-warning border-status-warning/30',
  skip:   'bg-status-unknown/10 text-status-unknown border-status-unknown/30',
  error:  'bg-status-critical/10 text-status-critical border-status-critical/30',
};

export function ActionCountPills({ preview }: {
  preview: { insertCount: number; updateCount: number; skipCount: number; errorCount: number };
}) {
  return (
    <>
      <span className={`px-2 py-0.5 rounded-full border ${ACTION_BADGE_CLS.insert}`}>
        신규 {preview.insertCount}
      </span>
      <span className={`px-2 py-0.5 rounded-full border ${ACTION_BADGE_CLS.update}`}>
        업데이트 {preview.updateCount}
      </span>
      <span className={`px-2 py-0.5 rounded-full border ${ACTION_BADGE_CLS.skip}`}>
        변경없음 {preview.skipCount}
      </span>
      {preview.errorCount > 0 && (
        <span className={`px-2 py-0.5 rounded-full border ${ACTION_BADGE_CLS.error}`}>
          오류 {preview.errorCount}
        </span>
      )}
    </>
  );
}

export function DiffRow({ d }: { d: NodeSpecCsvDiff }) {
  const changeKeys = Object.keys(d.changes);
  return (
    <tr className="border-b border-border align-top">
      <td className="px-2 py-1.5 text-xs text-muted-foreground">{d.rowIndex + 1}</td>
      <td className="px-2 py-1.5">
        <span className={`inline-block text-xs px-1.5 py-0.5 rounded-full border ${ACTION_BADGE_CLS[d.action] ?? ''}`}>
          {ACTION_LABEL[d.action] ?? d.action}
        </span>
      </td>
      <td className="px-2 py-1.5 font-mono text-sm">{d.hostname}</td>
      <td className="px-2 py-1.5 text-xs">
        {d.action === 'error' ? (
          <span className="text-status-critical">{d.error ?? '-'}</span>
        ) : changeKeys.length === 0 ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <details>
            <summary className="cursor-pointer text-muted-foreground">
              {changeKeys.length}개 필드 {d.action === 'insert' ? '신규' : '변경'}
            </summary>
            <table className="mt-1 text-xs font-mono w-full">
              <tbody>
                {changeKeys.map((k) => (
                  <tr key={k} className="border-t border-border/40">
                    <td className="pr-2 text-muted-foreground/80">{k}</td>
                    <td className="pr-2 text-status-critical/80 line-through max-w-[180px] truncate">
                      {String(d.changes[k].old ?? '—')}
                    </td>
                    <td className="pr-2 text-status-healthy max-w-[200px] truncate">
                      → {String(d.changes[k].new ?? '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </td>
    </tr>
  );
}
