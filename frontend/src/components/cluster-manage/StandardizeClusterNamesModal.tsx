import { useEffect, useId, useState } from 'react';
import { X, Wand2, ArrowRight, Loader2, Check, Server } from 'lucide-react';
import type { Cluster } from '@/types';
import { clustersApi } from '@/services/api';
import { ConfirmDialog, EmptyState, RunLogPanel, useToast } from '@/components/common';
import { useModalA11y } from '@/components/common/useModalA11y';
import { runLogged, type RunLog } from '@/hooks/useRunLog';
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
  /** 페이지 실행 로그 — 이름 변경(단건·일괄)의 대상별 결과를 남긴다. 모달이 페이지 패널을 가리므로 모달 안에도 그린다. */
  runLog: RunLog;
  showLog: boolean;
  onShowLogChange: (v: boolean) => void;
}

type Pending = { cluster: Cluster; next: string };

export function StandardizeClusterNamesModal({ open, clusters, onClose, onRenamed, runLog, showLog, onShowLogChange }: Props) {
  const toast = useToast();
  const [edits, setEdits] = useState<Record<string, Parts>>({});
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  // 연결된 업무 표시 이름까지 동기화되는 파급 효과가 있는 변경이라 각주 고지만으로
  // 즉시 적용하지 않고 확인을 받는다. 일괄 적용은 한 번의 확인으로 대상 전체를 보여주고 받는다
  // (클러스터마다 확인을 받으면 30개에 60번 넘게 눌러야 했다).
  const [confirmTargets, setConfirmTargets] = useState<Pending[] | null>(null);
  const titleId = useId();
  const dialogRef = useModalA11y(open, onClose);

  // 30초 폴링이 `clusters` 참조를 매번 갈아끼우므로, 참조 변경마다 통째로 초기화하면
  // 모달이 열린 동안 입력·완료 표시가 주기적으로 날아간다 (D-046). 닫힐 때 비우고,
  // 열려 있는 동안의 재실행(리페치)은 사용자가 만진 항목을 보존한 채 새 항목만 채운다.
  useEffect(() => {
    if (!open) {
      setEdits({});
      setDoneIds(new Set());
      return;
    }
    setEdits((prev) => {
      const next: Record<string, Parts> = {};
      clusters.forEach((c) => { next[c.id] = prev[c.id] ?? parseName(c.name); });
      return next;
    });
  }, [open, clusters]);

  if (!open) return null;

  const setPart = (id: string, k: keyof Parts, v: string) =>
    setEdits((e) => ({ ...e, [id]: { ...(e[id] ?? { biz: '', ops: '', attr: '' }), [k]: v } }));

  const pending: Pending[] = clusters
    .map((c) => ({ cluster: c, next: compose(edits[c.id] ?? parseName(c.name)) }))
    .filter(({ cluster, next }) => !!next && next !== cluster.name);

  const applyAll = async (targets: Pending[]) => {
    setBusyIds(new Set(targets.map((t) => t.cluster.id)));
    const r = await runLogged(runLog, {
      title: targets.length === 1 ? `이름 변경 — ${targets[0].cluster.name}` : `이름 표준화 — ${targets.length}개`,
      first: targets.length === 1 ? `${targets[0].cluster.name} → ${targets[0].next}` : `대상 ${targets.length}개 순서대로 변경`,
      heartbeatMs: 0,
      fn: async (run) => {
        let ok = 0;
        let fail = 0;
        for (const { cluster, next } of targets) {
          run.setStep(cluster.id, cluster.name, 'running');
          try {
            await clustersApi.update(cluster.id, { name: next });
            ok += 1;
            run.setStep(cluster.id, cluster.name, 'done');
            run.log('info', `${cluster.name} → ${next}`);
            setDoneIds((s) => new Set(s).add(cluster.id));
          } catch (e) {
            fail += 1;
            run.setStep(cluster.id, cluster.name, 'failed');
            run.log('error', `${cluster.name} 변경 실패 — ${formatApiError(e)}`);
          }
          setBusyIds((s) => { const n = new Set(s); n.delete(cluster.id); return n; });
        }
        return { ok, fail };
      },
      summarize: (res) => [[res.fail ? 'warn' : 'info', `성공 ${res.ok} · 실패 ${res.fail}`]],
    });
    setBusyIds(new Set());
    onRenamed();
    if (!r.ok) {
      toast.error('이름 변경 실패', formatApiError(r.error));
    } else if (r.data.fail > 0) {
      toast.warning('일부 이름 변경 실패', `성공 ${r.data.ok} · 실패 ${r.data.fail} — 상세는 실행 로그`);
    } else {
      toast.success('이름 변경됨', targets.length === 1 ? `${targets[0].cluster.name} → ${targets[0].next}` : `${r.data.ok}개 변경`);
    }
  };

  const confirmApply = async () => {
    const targets = confirmTargets;
    setConfirmTargets(null);
    if (targets?.length) await applyAll(targets);
  };

  const inputCls = 'min-w-0 px-2 py-1.5 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:border-primary/50';
  const hasRunLog = runLog.running || runLog.lines.length > 0;
  const anyBusy = busyIds.size > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="relative w-full max-w-3xl max-h-[85vh] flex flex-col rounded-md border border-border bg-card shadow-2xl"
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-5 py-3 border-b border-border">
          <Wand2 className="w-4 h-4 text-muted-foreground" aria-hidden />
          <h2 id={titleId} className="text-sm font-semibold">클러스터 이름 표준화</h2>
          <span className="text-xs text-muted-foreground">현재 이름을 [업무명]-[운영타입]-[속성] 으로 정리</span>
          <button onClick={onClose} className="ml-auto p-1 rounded-xl hover:bg-secondary text-muted-foreground" title="닫기" aria-label="닫기">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 divide-y divide-border">
          {clusters.length === 0 && (
            <EmptyState compact icon={Server} title="클러스터가 없습니다." description="클러스터를 먼저 등록하면 이름 표준화를 적용할 수 있습니다." />
          )}
          {clusters.map((c) => {
            const p = edits[c.id] ?? parseName(c.name);
            const next = compose(p);
            const changed = !!next && next !== c.name;
            const done = doneIds.has(c.id);
            const busy = busyIds.has(c.id);
            return (
              <div key={c.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2 mb-2 text-sm">
                  <span className="font-mono text-muted-foreground truncate">{c.name}</span>
                  {changed && (
                    <>
                      <ArrowRight className="w-3 h-3 text-muted-foreground flex-shrink-0" aria-hidden />
                      <span className="font-mono font-semibold text-foreground truncate">{next}</span>
                    </>
                  )}
                  {done && <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground"><Check className="w-3 h-3" aria-hidden />변경됨</span>}
                </div>
                {/* 좁은 폭에서는 줄바꿈 — 입력 2개 + 선택 + 버튼이 한 줄에 끼면 입력칸이 0 폭으로 찌그러진다 */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <input
                    value={p.biz}
                    onChange={(e) => setPart(c.id, 'biz', e.target.value)}
                    placeholder="업무명"
                    aria-label={`${c.name} 업무명`}
                    className={`${inputCls} flex-1 basis-40`}
                  />
                  <span className="text-muted-foreground font-mono" aria-hidden>-</span>
                  <select value={p.ops} onChange={(e) => setPart(c.id, 'ops', e.target.value)} aria-label={`${c.name} 운영타입`} className={`${inputCls} w-24`}>
                    <option value="">운영타입</option>
                    {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                  <span className="text-muted-foreground font-mono" aria-hidden>-</span>
                  <input
                    value={p.attr}
                    onChange={(e) => setPart(c.id, 'attr', e.target.value)}
                    placeholder="속성"
                    aria-label={`${c.name} 속성`}
                    className={`${inputCls} flex-1 basis-32`}
                  />
                  <button
                    type="button"
                    onClick={() => setConfirmTargets([{ cluster: c, next }])}
                    disabled={!changed || busy || anyBusy}
                    // busy 중 내용이 스피너만 남으면 스크린리더가 버튼 이름을 잃는다 — aria-label 유지
                    aria-label={`${c.name} 이름 변경`}
                    className="flex-shrink-0 px-3 py-1.5 text-sm font-medium bg-secondary border border-border hover:bg-secondary/80 rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
                  >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '변경'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {hasRunLog && (
          <div className="px-5 py-3 border-t border-border">
            <RunLogPanel run={runLog} show={showLog} onShowChange={onShowLogChange} maxHeight="max-h-40" />
          </div>
        )}

        <div className="px-5 py-3 border-t border-border flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">이름 변경 시 연결된 업무의 표시 이름도 자동 동기화됩니다.</p>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-xl border border-border bg-secondary hover:bg-secondary/80 transition-colors">
              닫기
            </button>
            <button
              type="button"
              onClick={() => setConfirmTargets(pending)}
              disabled={pending.length === 0 || anyBusy}
              className="px-3 py-1.5 text-sm font-semibold rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1"
            >
              {anyBusy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />}
              {pending.length > 0 ? `바뀐 ${pending.length}개 모두 적용` : '바뀐 이름 없음'}
            </button>
          </div>
        </div>
      </div>
      {confirmTargets && (
        <ConfirmDialog
          open
          title={confirmTargets.length === 1 ? '클러스터 이름 변경' : `클러스터 이름 ${confirmTargets.length}개 변경`}
          description={confirmTargets.length === 1
            ? `"${confirmTargets[0].cluster.name}" → "${confirmTargets[0].next}"`
            : '아래 이름을 순서대로 변경합니다.'}
          confirmLabel={confirmTargets.length === 1 ? '변경' : `${confirmTargets.length}개 변경`}
          onConfirm={confirmApply}
          onCancel={() => setConfirmTargets(null)}
        >
          <div className="space-y-2 text-muted-foreground">
            {confirmTargets.length > 1 && (
              <ul className="max-h-48 overflow-y-auto space-y-0.5 font-mono text-xs">
                {confirmTargets.map(({ cluster, next }) => (
                  <li key={cluster.id}>{cluster.name} → <span className="text-foreground">{next}</span></li>
                ))}
              </ul>
            )}
            <p>연결된 업무의 표시 이름도 함께 동기화됩니다.</p>
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}
