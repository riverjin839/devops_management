import { X, ArrowRight, Loader2, AlertTriangle } from 'lucide-react';
import { EmptyState, useModalA11y } from '@/components/common';
import { diffFieldLabel, renderDiffValue } from './diffFormat';

export interface DiffRow {
  field: string;
  current: unknown;
  proposed: unknown;
  changed: boolean;
}

interface Props {
  open: boolean;
  clusterName: string;
  diff: DiffRow[];
  warnings: string[];
  applying: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  /** 실행 로그(RunLogPanel) — 모달이 페이지의 로그 패널을 가리므로 적용 진행·실패를 모달 안에서 보여준다(D-135). */
  logSlot?: React.ReactNode;
}

export function ClusterUpdateDiffDialog({
  open, clusterName, diff, warnings, applying, onCancel, onConfirm, logSlot,
}: Props) {
  // ESC 닫기(적용 중엔 무시) · 포커스 트랩 · 초점 복원 (공용 훅)
  const dialogRef = useModalA11y(open, () => { if (!applying) onCancel(); });

  if (!open) return null;

  const changed = diff.filter((d) => d.changed);
  const unchanged = diff.filter((d) => !d.changed);

  return (
    <div ref={dialogRef} className="fixed inset-0 z-50 flex items-center justify-center" role="dialog" aria-modal="true" aria-label={`재수집 미리보기 — ${clusterName}`}>
      <div className="absolute inset-0 bg-black/60" onClick={() => !applying && onCancel()} />
      <div className="relative bg-card border border-border rounded-md shadow-2xl w-full max-w-3xl mx-4 overflow-hidden">
        {/* 변경이 있다는 것 자체는 위험 신호가 아니다 — 일상적인 갱신이라 아이콘 타일 없이 중립 헤더 */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-border bg-muted/30">
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold">재수집 미리보기 — {clusterName}</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {changed.length > 0
                ? `${changed.length}개 필드가 바뀝니다. 적용하면 서버가 한 번 더 수집해 반영하고, 미리보기와 달라진 값은 실행 로그에 따로 표시합니다.`
                : '바뀌는 필드가 없습니다.'}
            </p>
          </div>
          <button onClick={onCancel} disabled={applying} title="닫기" aria-label="닫기"
            className="p-1 rounded-xl hover:bg-secondary text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto">
          {warnings.length > 0 && (
            <div className="px-5 py-3 border-b border-border bg-status-warning/5">
              <p className="text-sm font-medium text-status-warning mb-1 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" aria-hidden /> 경고 {warnings.length}건
              </p>
              <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
                {warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          {changed.length > 0 && (
            <div className="px-5 py-3">
              <p className="text-xs font-medium text-muted-foreground mb-2">변경 예정</p>
              {/* 값은 자르지 않는다 — ciliumConfig 같은 긴 값을 tooltip 으로만 보여주면 검토할 수 없다.
                  셀마다 높이 상한 + 내부 스크롤로 표 전체 높이만 제한한다. */}
              <table className="w-full text-sm table-fixed">
                <colgroup>
                  <col className="w-40" />
                  <col />
                  <col className="w-6" />
                  <col />
                </colgroup>
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="py-1.5 font-medium">필드</th>
                    <th className="py-1.5 font-medium">기존 값</th>
                    <th className="py-1.5 font-medium"><span className="sr-only">변경 방향</span></th>
                    <th className="py-1.5 font-medium">신규 값</th>
                  </tr>
                </thead>
                <tbody>
                  {changed.map((d) => (
                    <tr key={d.field} className="border-b border-border/50 align-top">
                      <td className="py-1.5 pr-2 text-sm font-medium text-foreground">
                        {diffFieldLabel(d.field)}
                      </td>
                      <td className="py-1.5 pr-2">
                        <div className="max-h-32 overflow-y-auto font-mono text-xs text-muted-foreground whitespace-pre-wrap break-all">
                          {renderDiffValue(d.current, d.field)}
                        </div>
                      </td>
                      <td className="py-1.5"><ArrowRight className="w-3 h-3 text-muted-foreground" aria-hidden /></td>
                      <td className="py-1.5">
                        <div className="max-h-32 overflow-y-auto font-mono text-xs text-foreground whitespace-pre-wrap break-all">
                          {renderDiffValue(d.proposed, d.field)}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {unchanged.length > 0 && (
            <details className="px-5 py-3 border-t border-border">
              <summary className="text-xs text-muted-foreground cursor-pointer">
                변경 없음 {unchanged.length}건 보기
              </summary>
              <ul className="mt-2 text-xs text-muted-foreground space-y-0.5 font-mono break-all">
                {unchanged.map((d) => (
                  <li key={d.field}>
                    {diffFieldLabel(d.field)}: {renderDiffValue(d.current, d.field)}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {diff.length === 0 && (
            <EmptyState compact title="수집된 정보가 없습니다." description="kubeconfig 접근은 성공했으나 추출 가능한 필드가 없습니다." />
          )}
        </div>

        {logSlot && <div className="px-5 py-3 border-t border-border">{logSlot}</div>}

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/10">
          <button onClick={onCancel} disabled={applying}
            className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl disabled:opacity-40">
            취소
          </button>
          <button onClick={onConfirm} disabled={applying || changed.length === 0}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50">
            {applying && <Loader2 className="w-3 h-3 animate-spin" />}
            {changed.length > 0 ? `${changed.length}개 필드 적용` : '적용'}
          </button>
        </div>
      </div>
    </div>
  );
}
