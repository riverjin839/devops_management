// NS 담당자 설정(admin) — 규칙(NS 패턴 → 담당자·연락처, 위에서부터 첫 일치)과 NS 라벨 자동 매핑.
// 라벨은 하루 한 번(일일 롤업)·외부 서비스 수집 때 자동으로 다시 읽고, "라벨 다시 읽기"로 바로 읽을 수 있다
// (실행 로그 실시간 표시 + 로그 보기 토글 — CLAUDE.md 실행 버튼 규칙).
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { RunLogPanel, useToast } from '@/components/common';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useClusters } from '@/hooks/useCluster';
import { useNsOwners, useSaveNsOwners } from '@/hooks/useDailyReport';
import { useLogPref } from '@/hooks/useLogPref';
import { applyRunEvent, useRunLog } from '@/hooks/useRunLog';
import { postSse } from '@/lib/sse';
import { formatApiError } from '@/lib/utils';
import { dailyReportApi } from '@/services/api';
import type { NsOwnersSettings } from '@/types';

const INPUT = 'w-full text-sm px-2 py-1 rounded-xl border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary';
const BTN = 'text-sm inline-flex items-center gap-1 px-3 py-1 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-50';
const ICON_BTN = 'inline-flex items-center justify-center w-7 h-7 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-40';
const BTN_PRIMARY = 'text-sm inline-flex items-center gap-1 px-3 py-1 rounded-xl bg-primary text-primary-foreground disabled:opacity-50';

type Rule = NsOwnersSettings['rules'][number];

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="mt-0.5">{children}</div>
      {help && <span className="block text-[11px] text-muted-foreground mt-0.5 leading-snug">{help}</span>}
    </label>
  );
}

export function NsOwnersDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const { data, refetch } = useNsOwners(open);
  const { data: clusters = [] } = useClusters();
  const save = useSaveNsOwners();
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('ns-owners-refresh');
  const [rules, setRules] = useState<Rule[]>([]);
  const [keysText, setKeysText] = useState('');
  const [showContact, setShowContact] = useState(true);

  useEffect(() => {
    if (open && data) {
      setRules(data.rules);
      setKeysText(data.labelKeys.join(', '));
      setShowContact(data.showContact);
    }
  }, [open, data]);

  const setRule = (i: number, patch: Partial<Rule>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) => setRules((rs) => {
    const next = [...rs];
    const j = i + d;
    if (j < 0 || j >= next.length) return rs;
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const onSave = async () => {
    try {
      await save.mutateAsync({
        rules: rules.filter((r) => r.pattern.trim() && r.owner.trim()),
        labelKeys: keysText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
        showContact,
      });
      toast.success('NS 담당자 설정 저장됨');
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  const onRefresh = async () => {
    const run = runLog.begin('NS 담당자 라벨 다시 읽기', '공개 대상 클러스터의 네임스페이스 라벨을 읽는다');
    let error: string | null = null;
    try {
      await postSse(dailyReportApi.ownersRefreshStreamUrl, {}, (evt) => {
        if (evt.type === 'error') error = String(evt.message ?? '실패');
        else if (evt.type !== 'result') applyRunEvent(run, evt);
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (error) {
      run.log('error', error);
      toast.error('라벨 다시 읽기 실패', error);
    }
    run.end();
    void refetch();
  };

  const cacheCount = Object.values(data?.labelCache ?? {}).reduce((n, v) => n + v.count, 0);
  const clusterName = (id: string) => clusters.find((c) => c.id === id)?.name ?? id.slice(0, 8);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !save.isPending && !runLog.running) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>NS 담당자</DialogTitle>
          <DialogDescription>
            일일 리포트·외부 서비스에 네임스페이스 담당자를 붙인다. 규칙이 먼저(위에서부터 첫 일치), 없으면 NS 라벨 값을 쓴다.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 max-h-[60vh] overflow-y-auto px-5 pb-3">
          <section className="space-y-2" aria-label="담당자 규칙">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">규칙 {rules.length}개 — 패턴은 glob(`pay-*`, `team-?-api`)</span>
              <button type="button" className={BTN} onClick={() => setRules([...rules, { pattern: '', owner: '', contact: '', clusterId: null }])}>
                <Plus className="w-4 h-4" /> 규칙 추가
              </button>
            </div>
            {rules.length === 0 && <p className="text-xs text-muted-foreground">규칙이 없다 — NS 라벨만 쓴다.</p>}
            {rules.map((r, i) => (
              <div key={i} className="grid grid-cols-12 gap-1.5 items-center">
                <input className={`${INPUT} col-span-3 font-mono`} placeholder="NS 패턴" aria-label={`규칙 ${i + 1} NS 패턴`}
                  value={r.pattern} onChange={(e) => setRule(i, { pattern: e.target.value })} />
                <input className={`${INPUT} col-span-3`} placeholder="담당 팀/사람" aria-label={`규칙 ${i + 1} 담당자`}
                  value={r.owner} onChange={(e) => setRule(i, { owner: e.target.value })} />
                <input className={`${INPUT} col-span-2`} placeholder="연락처(선택)" aria-label={`규칙 ${i + 1} 연락처`}
                  value={r.contact ?? ''} onChange={(e) => setRule(i, { contact: e.target.value })} />
                <select className={`${INPUT} col-span-2`} aria-label={`규칙 ${i + 1} 적용 클러스터`}
                  value={r.clusterId ?? ''} onChange={(e) => setRule(i, { clusterId: e.target.value || null })}>
                  <option value="">모든 클러스터</option>
                  {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <div className="col-span-2 flex gap-1 justify-end">
                  <button type="button" className={ICON_BTN} onClick={() => move(i, -1)} disabled={i === 0} title="위로" aria-label="위로">
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" className={ICON_BTN} onClick={() => move(i, 1)} disabled={i === rules.length - 1} title="아래로" aria-label="아래로">
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" className={ICON_BTN} onClick={() => setRules(rules.filter((_, j) => j !== i))} title="삭제" aria-label="규칙 삭제">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </section>
          <div className="grid grid-cols-2 gap-3">
            <Field label="담당자 라벨 키" help="NS 라벨 또는 어노테이션에서 이 키들의 값을 담당자로 쓴다(쉼표 구분, 앞쪽 우선).">
              <input className={`${INPUT} font-mono`} value={keysText} onChange={(e) => setKeysText(e.target.value)} placeholder="owner, team" />
            </Field>
            <label className="flex items-start gap-2 text-sm pt-4">
              <input type="checkbox" className="accent-primary mt-0.5" checked={showContact} onChange={(e) => setShowContact(e.target.checked)} />
              <span>
                공개 화면에 연락처 표시
                <span className="block text-[11px] text-muted-foreground leading-snug">끄면 담당자 이름만 보인다.</span>
              </span>
            </label>
          </div>
          <section className="space-y-2" aria-label="라벨 캐시">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={BTN} onClick={() => void onRefresh()} disabled={runLog.running}>
                <RefreshCw className={runLog.running ? 'w-4 h-4 animate-spin' : 'w-4 h-4'} /> 라벨 다시 읽기
              </button>
              <span className="text-xs text-muted-foreground">
                읽어 둔 담당자 라벨 {cacheCount}개
                {Object.entries(data?.labelCache ?? {}).map(([cid, v]) => ` · ${clusterName(cid)} ${v.count}`).join('')}
                {' '}— 저장한 라벨 키로 읽으려면 먼저 저장한다
              </span>
            </div>
            <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-48" />
          </section>
        </div>
        <DialogFooter>
          <button type="button" className={BTN} onClick={onClose} disabled={save.isPending}>닫기</button>
          <button type="button" className={BTN_PRIMARY} onClick={() => void onSave()} disabled={save.isPending}>
            {save.isPending ? '저장 중…' : '저장'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
