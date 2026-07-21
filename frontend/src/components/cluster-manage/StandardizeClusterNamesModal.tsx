import { useEffect, useId, useState } from 'react';
import { X, Wand2, ArrowRight, Loader2, CheckCircle2 } from 'lucide-react';
import type { Cluster } from '@/types';
import { clustersApi } from '@/services/api';
import { useToast } from '@/components/common';
import { useModalA11y } from '@/components/common/useModalA11y';
import { formatApiError } from '@/lib/utils';
import { CLUSTER_NAME_OPS as OPS, parseClusterName } from '@/lib/clusterName';

interface Parts { biz: string; ops: string; attr: string; }

/** 현재 이름을 [업무명]-[운영타입]-[속성] 으로 분해(추정). 표준 형식이 아니면 전체를 업무명에. */
function parseName(name: string): Parts {
  return parseClusterName(name) ?? { biz: name, ops: '', attr: '' };
}
function compose(p: Parts): string {
  return [p.biz, p.ops, p.attr].map((s) => s.trim()).filter(Boolean).join('-');
}

interface Props {
  open: boolean;
  clusters: Cluster[];
  onClose: () => void;
  onRenamed: () => void;
}

export function StandardizeClusterNamesModal({ open, clusters, onClose, onRenamed }: Props) {
  const toast = useToast();
  const [edits, setEdits] = useState<Record<string, Parts>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const titleId = useId();
  const dialogRef = useModalA11y(open, onClose);

  useEffect(() => {
    if (!open) return;
    const init: Record<string, Parts> = {};
    clusters.forEach((c) => { init[c.id] = parseName(c.name); });
    setEdits(init);
    setDoneIds(new Set());
  }, [open, clusters]);

  if (!open) return null;

  const setPart = (id: string, k: keyof Parts, v: string) =>
    setEdits((e) => ({ ...e, [id]: { ...(e[id] ?? { biz: '', ops: '', attr: '' }), [k]: v } }));

  const apply = async (c: Cluster) => {
    const next = compose(edits[c.id] ?? parseName(c.name));
    if (!next || next === c.name) return;
    setBusyId(c.id);
    try {
      await clustersApi.update(c.id, { name: next });
      toast.success('이름 변경됨', `${c.name} → ${next}`);
      setDoneIds((s) => new Set(s).add(c.id));
      onRenamed();
    } catch (e) {
      toast.error('변경 실패', formatApiError(e));
    } finally {
      setBusyId(null);
    }
  };

  const inputCls = 'min-w-0 px-2 py-1.5 bg-secondary border border-border rounded-md text-sm focus:outline-none focus:border-primary/50';

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="w-full max-w-3xl max-h-[85vh] flex flex-col rounded-2xl border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border">
          <Wand2 className="w-4 h-4 text-primary" />
          <h2 id={titleId} className="text-sm font-semibold">클러스터 이름 표준화</h2>
          <span className="text-xs text-muted-foreground">현재 이름을 [업무명]-[운영타입]-[속성] 으로 정리</span>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:bg-secondary text-muted-foreground" aria-label="닫기">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {clusters.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-8">클러스터가 없습니다.</p>
          )}
          {clusters.map((c) => {
            const p = edits[c.id] ?? parseName(c.name);
            const next = compose(p);
            const changed = !!next && next !== c.name;
            const done = doneIds.has(c.id);
            return (
              <div key={c.id} className="rounded-lg border border-border p-3">
                <div className="flex items-center gap-2 mb-2 text-sm">
                  <span className="font-mono text-muted-foreground truncate">{c.name}</span>
                  {changed && (
                    <>
                      <ArrowRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                      <span className="font-mono font-semibold text-primary truncate">{next}</span>
                    </>
                  )}
                  {done && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 ml-1" />}
                </div>
                <div className="flex items-center gap-1.5">
                  <input
                    value={p.biz}
                    onChange={(e) => setPart(c.id, 'biz', e.target.value)}
                    placeholder="업무명"
                    className={`${inputCls} flex-1`}
                  />
                  <span className="text-muted-foreground font-mono">-</span>
                  <select value={p.ops} onChange={(e) => setPart(c.id, 'ops', e.target.value)} className={`${inputCls} w-24`}>
                    <option value="">운영타입</option>
                    {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                  <span className="text-muted-foreground font-mono">-</span>
                  <input
                    value={p.attr}
                    onChange={(e) => setPart(c.id, 'attr', e.target.value)}
                    placeholder="속성"
                    className={`${inputCls} flex-1`}
                  />
                  <button
                    type="button"
                    onClick={() => apply(c)}
                    disabled={!changed || busyId === c.id}
                    className="flex-shrink-0 px-3 py-1.5 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
                  >
                    {busyId === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '변경'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-between">
          <p className="text-xs text-muted-foreground">이름 변경 시 연결된 업무의 표시 이름도 자동 동기화됩니다.</p>
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-lg border border-border bg-secondary hover:bg-secondary/80 transition-colors">
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
