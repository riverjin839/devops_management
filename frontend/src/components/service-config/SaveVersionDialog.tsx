// 저장 전 확인 — 직접 바꾼 값 / 권장(체크해서 함께 저장) / 필수 조건(위반이면 저장 잠금) / 영향 / 변경 메모.
// 저장은 새 설정 버전을 만들 뿐 노드에는 아무것도 하지 않는다(적용은 따로).
import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ServiceConfigRuleResult } from '@/types';

const TH = 'text-left px-2 py-1.5 text-xs font-medium text-muted-foreground border-b border-border';
const TD = 'px-2 py-1.5 border-b border-border align-top text-sm';

export interface DraftChange {
  key: string;
  before: string;
  after: string;
}

interface Props {
  open: boolean;
  scopeLabel: string;
  nextVersionNo: number;
  changes: DraftChange[];
  results: ServiceConfigRuleResult[];
  evaluating: boolean;
  busy: boolean;
  onClose: () => void;
  /** accepted = 함께 저장할 제안 {키: 값}. */
  onSave: (note: string, accepted: Record<string, string>) => void;
}

export function SaveVersionDialog({ open, scopeLabel, nextVersionNo, changes, results, evaluating, busy, onClose, onSave }: Props) {
  // 이 화면에서 제안값으로 고칠 수 있는 권장·필수 항목 — 체크하면 함께 저장된다.
  const fixes = useMemo(() => results.filter((r) => (r.kind === 'recommend' || r.kind === 'require') && r.fixableHere && r.targetKey), [results]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');

  useEffect(() => {
    if (open) {
      setChecked(new Set(fixes.map((r) => r.ruleId)));
    }
  }, [open, fixes]);
  useEffect(() => {
    if (open) setNote('');
  }, [open]);

  const accepted = useMemo(() => {
    const out: Record<string, string> = {};
    for (const r of fixes) if (checked.has(r.ruleId) && r.targetKey && r.suggested != null) out[r.targetKey] = r.suggested;
    return out;
  }, [fixes, checked]);
  // 필수 위반 중 이번 저장에서 제안으로 고치지 않는 것이 남으면 저장 불가
  const unresolved = results.filter((r) => r.blocking && !(r.targetKey && accepted[r.targetKey] != null));
  const requiresInfo = results.filter((r) => r.kind === 'require' && !r.blocking);
  const impacts = results.filter((r) => r.kind === 'impact');
  const total = changes.length + Object.keys(accepted).filter((k) => !changes.some((c) => c.key === k)).length;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>저장 전 확인 — {scopeLabel}</DialogTitle>
          <DialogDescription>
            저장하면 새 버전 V{nextVersionNo} 이 생깁니다. 노드에는 아직 아무것도 바뀌지 않고, 적용은 따로 합니다.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 max-h-[60vh] overflow-y-auto px-5 pb-3">
          <section aria-label="직접 바꾼 값">
            <h3 className="text-sm font-semibold mb-1">직접 바꾼 값 <span className="text-xs font-normal text-muted-foreground">{changes.length}건</span></h3>
            <table className="w-full">
              <thead><tr><th className={TH}>키</th><th className={TH}>이전</th><th className={TH}>새 값</th></tr></thead>
              <tbody>
                {changes.map((c) => (
                  <tr key={c.key}>
                    <td className={`${TD} font-mono text-xs break-all`}>{c.key}</td>
                    <td className={`${TD} font-mono text-xs text-muted-foreground`}>{c.before || '(없음)'}</td>
                    <td className={`${TD} font-mono text-xs font-semibold`}>{c.after || '(없음)'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {evaluating ? (
            <p className="text-xs text-muted-foreground">의존 관계를 확인하는 중…</p>
          ) : (
            <>
              {fixes.length > 0 && (
                <section aria-label="같이 바꿀 값">
                  <h3 className="text-sm font-semibold mb-1">같이 바꾸기를 권하는 값 <span className="text-xs font-normal text-muted-foreground">체크한 것만 저장에 포함</span></h3>
                  <table className="w-full">
                    <thead><tr><th className={`${TH} w-8`}><span className="sr-only">포함</span></th><th className={TH}>키</th><th className={TH}>현재</th><th className={TH}>제안</th><th className={TH}>이유</th></tr></thead>
                    <tbody>
                      {fixes.map((r) => (
                        <tr key={r.ruleId}>
                          <td className={TD}>
                            <input type="checkbox" className="accent-primary" aria-label={`${r.targetKey} 제안 포함`}
                              checked={checked.has(r.ruleId)}
                              onChange={(e) => setChecked((s) => {
                                const next = new Set(s);
                                if (e.target.checked) next.add(r.ruleId); else next.delete(r.ruleId);
                                return next;
                              })} />
                          </td>
                          <td className={`${TD} font-mono text-xs break-all`}>
                            {r.targetKey}
                            <span className={`block font-sans ${r.kind === 'require' ? 'text-status-critical' : 'text-muted-foreground'}`}>{r.kind === 'require' ? '필수' : '권장'}</span>
                          </td>
                          <td className={`${TD} font-mono text-xs`}>{r.targetValue ?? '(없음)'}</td>
                          <td className={`${TD} font-mono text-xs font-semibold`}>{r.suggested}</td>
                          <td className={`${TD} text-xs text-muted-foreground`}>{r.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              )}
              <section aria-label="필수 조건">
                <h3 className="text-sm font-semibold mb-1">지켜야 저장되는 조건</h3>
                {unresolved.length === 0 && requiresInfo.length === 0 ? (
                  <p className="text-sm text-muted-foreground">이번 변경과 관련된 위반이 없습니다.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {unresolved.map((r) => (
                      <li key={r.ruleId} className="text-status-critical">
                        <span className="font-mono text-xs">{r.targetKey}</span> — {r.reason}{r.suggested == null ? ' (값을 직접 입력하세요)' : ''}
                      </li>
                    ))}
                    {requiresInfo.map((r) => (
                      <li key={r.ruleId} className="text-status-warning">
                        <span className="font-mono text-xs">{r.targetService?.toUpperCase()} {r.targetKey}</span> — {r.reason}
                        <span className="text-muted-foreground"> (이번 저장은 막지 않음{r.targetService && r.targetService !== r.sourceService ? ' — 해당 서비스에서 고치세요' : ''})</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              {impacts.length > 0 && (
                <section aria-label="영향">
                  <h3 className="text-sm font-semibold mb-1">적용할 때 일어나는 일</h3>
                  <ul className="list-disc pl-5 space-y-1 text-sm text-muted-foreground">
                    {impacts.map((r) => <li key={r.ruleId}>{r.reason}</li>)}
                  </ul>
                </section>
              )}
            </>
          )}

          <label className="block">
            <span className="text-xs font-semibold">변경 메모</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} aria-label="변경 메모" placeholder="왜 바꾸는지 — 적용·되돌리기 때 이 메모를 본다"
              className="mt-1 w-full min-h-[64px] px-2.5 py-1.5 rounded-xl border border-border bg-card text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
          </label>
        </div>
        <DialogFooter>
          <span className="mr-auto text-xs text-muted-foreground">저장 대상 {total}건</span>
          <Button variant="outline" onClick={onClose} disabled={busy}>뒤로</Button>
          <Button onClick={() => onSave(note.trim(), accepted)} disabled={busy || evaluating || unresolved.length > 0}
            title={unresolved.length > 0 ? '지켜야 하는 조건을 어긴 값이 있습니다' : undefined}>
            {busy ? '저장 중…' : `V${nextVersionNo} 로 저장 (적용은 따로)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
