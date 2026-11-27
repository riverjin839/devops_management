import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AlarmRequestThreshold, AlarmSeverity } from '@/types';
import { CODE_INPUT, DURATION_RE, INPUT, SEVERITY_CLS, SEVERITY_LABEL, SEVERITY_ORDER } from './styles';

interface Props {
  rows: AlarmRequestThreshold[];
  /** 주면 편집 모드 — 수정 임계치(expr·for)와 심각도를 고친다. */
  onChange?: (rows: AlarmRequestThreshold[]) => void;
  /** 편집 모드에서 기본 임계치 칸도 고칠 수 있게(카탈로그에 없는 신규 알람). */
  baseEditable?: boolean;
}

const changed = (a: string, b: string) => a.trim() !== b.trim();

/**
 * 임계치 표 — 심각도별 한 행, 열은 `기본 임계치 [expr | for]` · `수정 임계치 [expr | for]`.
 * 기본값과 달라진 수정 칸은 경고 면색으로 표시한다(무엇을 바꾸는 요청인지 한눈에).
 */
export function ThresholdTable({ rows, onChange, baseEditable = false }: Props) {
  const editable = Boolean(onChange);
  const set = (i: number, patch: Partial<AlarmRequestThreshold>) =>
    onChange?.(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const used = new Set(rows.map((r) => r.severity));

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm border-collapse">
        <thead className="bg-secondary/60 text-xs text-muted-foreground">
          <tr>
            <th rowSpan={2} className="px-2 py-1.5 text-left font-medium w-[112px] whitespace-nowrap">심각도</th>
            <th colSpan={2} className="px-2 py-1.5 font-semibold text-foreground border-l border-border">기본 임계치</th>
            <th colSpan={2} className="px-2 py-1.5 font-semibold text-foreground border-l border-border">수정 임계치</th>
            {editable && <th rowSpan={2} className="w-9"><span className="sr-only">삭제</span></th>}
          </tr>
          <tr className="border-t border-border">
            <th className="px-2 py-1 text-left font-medium border-l border-border">expr</th>
            <th className="px-2 py-1 text-left font-medium w-[92px] whitespace-nowrap">for(지속)</th>
            <th className="px-2 py-1 text-left font-medium border-l border-border">expr</th>
            <th className="px-2 py-1 text-left font-medium w-[92px] whitespace-nowrap">for(지속)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const ce = changed(r.baseExpr, r.newExpr) && r.newExpr.trim() !== '';
            const cf = changed(r.baseFor, r.newFor) && r.newFor.trim() !== '';
            const badFor = !DURATION_RE.test(r.newFor.trim());
            const badBaseFor = !DURATION_RE.test(r.baseFor.trim());
            if (!editable) {
              return (
                <tr key={r.severity} className="border-t border-border align-top">
                  <td className={cn('px-2 py-1.5 text-xs font-semibold', SEVERITY_CLS[r.severity])}>{SEVERITY_LABEL[r.severity]}</td>
                  <td className="px-2 py-1.5 font-mono text-xs text-muted-foreground break-all border-l border-border">{r.baseExpr || '—'}</td>
                  <td className="px-2 py-1.5 font-mono text-xs text-muted-foreground tabular-nums">{r.baseFor || '—'}</td>
                  <td className={cn('px-2 py-1.5 font-mono text-xs break-all border-l border-border', ce && 'bg-status-warning/15')}>
                    {r.newExpr || <span className="text-muted-foreground">기본값 유지</span>}
                  </td>
                  <td className={cn('px-2 py-1.5 font-mono text-xs tabular-nums', cf && 'bg-status-warning/15')}>{r.newFor || '—'}</td>
                </tr>
              );
            }
            return (
              <tr key={i} className="border-t border-border">
                <td className="px-1.5 py-1.5 min-w-[104px]">
                  <select
                    className={cn(INPUT, 'text-xs', SEVERITY_CLS[r.severity])}
                    value={r.severity}
                    aria-label={`${i + 1}행 심각도`}
                    onChange={(e) => set(i, { severity: e.target.value as AlarmSeverity })}
                  >
                    {SEVERITY_ORDER.map((s) => (
                      <option key={s} value={s} disabled={s !== r.severity && used.has(s)}>{SEVERITY_LABEL[s]}</option>
                    ))}
                  </select>
                </td>
                <td className="px-1.5 py-1.5 border-l border-border min-w-[180px]">
                  <input className={CODE_INPUT} value={r.baseExpr} readOnly={!baseEditable} aria-label={`${i + 1}행 기본 expr`}
                    placeholder={baseEditable ? '없으면 비움' : ''}
                    onChange={(e) => set(i, { baseExpr: e.target.value })} />
                </td>
                <td className="px-1.5 py-1.5">
                  <input className={cn(CODE_INPUT, badBaseFor && 'ring-1 ring-status-critical')} value={r.baseFor} readOnly={!baseEditable}
                    aria-label={`${i + 1}행 기본 for`} aria-invalid={badBaseFor || undefined}
                    onChange={(e) => set(i, { baseFor: e.target.value })} />
                </td>
                <td className={cn('px-1.5 py-1.5 border-l border-border min-w-[180px]', ce && 'bg-status-warning/15')}>
                  <input className={CODE_INPUT} value={r.newExpr} aria-label={`${i + 1}행 수정 expr`} placeholder="예: cnpg_pg_replication_lag > 60"
                    onChange={(e) => set(i, { newExpr: e.target.value })} />
                </td>
                <td className={cn('px-1.5 py-1.5', cf && 'bg-status-warning/15')}>
                  <input className={cn(CODE_INPUT, badFor && 'ring-1 ring-status-critical')} value={r.newFor} placeholder="5m"
                    aria-label={`${i + 1}행 수정 for`} aria-invalid={badFor || undefined}
                    onChange={(e) => set(i, { newFor: e.target.value })} />
                </td>
                <td className="px-1 py-1.5 text-center">
                  <button type="button" title="행 삭제" aria-label={`${i + 1}행 삭제`}
                    className="inline-flex items-center justify-center w-7 h-7 rounded-xl text-muted-foreground hover:text-status-critical hover:bg-secondary"
                    onClick={() => onChange?.(rows.filter((_, j) => j !== i))}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
