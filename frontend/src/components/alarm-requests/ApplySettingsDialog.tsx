import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { LoadingState } from '@/components/common/EmptyState';
import { useToast } from '@/components/common/Toast';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useAlarmApplySettings, useSaveAlarmApplySettings } from '@/hooks/useAlarmRequests';
import { useClusters } from '@/hooks/useCluster';
import { cn, formatApiError } from '@/lib/utils';
import type { AlarmApplySettings, AlarmLabelPair } from '@/types';
import { BTN, BTN_PRIMARY, BTN_SM, INPUT } from './styles';

/** `key=value` 줄 ↔ 라벨 쌍 */
const toText = (pairs: AlarmLabelPair[]) => pairs.map((p) => `${p.key}=${p.value}`).join('\n');
const fromText = (text: string): AlarmLabelPair[] =>
  text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const i = l.indexOf('=');
    return i < 0 ? { key: l, value: '' } : { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
  });

interface Draft {
  namespace: string;
  namePrefix: string;
  ruleLabels: string;
  alertLabels: string;
  markAppliedOnSuccess: boolean;
  overrides: { clusterId: string; namespace: string; ruleLabels: string }[];
}

const toDraft = (s: AlarmApplySettings): Draft => ({
  namespace: s.namespace, namePrefix: s.namePrefix, ruleLabels: toText(s.ruleLabels), alertLabels: toText(s.alertLabels),
  markAppliedOnSuccess: s.markAppliedOnSuccess,
  overrides: s.clusterOverrides.map((o) => ({ clusterId: o.clusterId, namespace: o.namespace ?? '', ruleLabels: toText(o.ruleLabels) })),
});

/**
 * PrometheusRule 적용 설정(운영자 이상) — 어느 네임스페이스에, Prometheus ruleSelector 가 고르는 어떤 라벨로 만들지.
 * 설치마다 달라 화면에서 고친다(UI-First). 클러스터별 재정의 가능.
 */
export function ApplySettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const perm = useCanOperate();
  const q = useAlarmApplySettings(open);
  const save = useSaveAlarmApplySettings();
  const { data: clusters = [] } = useClusters();
  const [draft, setDraft] = useState<Draft | null>(null);
  const d = draft ?? (q.data ? toDraft(q.data) : null);
  const set = (patch: Partial<Draft>) => d && setDraft({ ...d, ...patch });
  const setOv = (i: number, patch: Partial<Draft['overrides'][number]>) =>
    d && set({ overrides: d.overrides.map((o, j) => (j === i ? { ...o, ...patch } : o)) });

  const close = () => { setDraft(null); onClose(); };
  const onSave = () => {
    if (!d) return;
    save.mutate({
      namespace: d.namespace.trim(), namePrefix: d.namePrefix.trim(),
      ruleLabels: fromText(d.ruleLabels), alertLabels: fromText(d.alertLabels),
      markAppliedOnSuccess: d.markAppliedOnSuccess,
      clusterOverrides: d.overrides.filter((o) => o.clusterId).map((o) => ({
        clusterId: o.clusterId, namespace: o.namespace.trim() || null, ruleLabels: fromText(o.ruleLabels),
      })),
    }, {
      onSuccess: () => { toast.success('PrometheusRule 적용 설정을 저장했습니다'); close(); },
      onError: (e) => toast.error('저장하지 못했습니다', formatApiError(e)),
    });
  };
  const ro = !perm.canOperate;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !save.isPending) close(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>PrometheusRule 적용 설정</DialogTitle>
          <DialogDescription>
            「클러스터에 적용」이 PrometheusRule 을 만들 위치와 라벨입니다. Prometheus 의 ruleSelector 가 고르는 라벨을 넣어야 규칙이 로드됩니다.
          </DialogDescription>
        </DialogHeader>
        {!d ? <LoadingState label="설정을 불러오는 중" compact /> : (
          <div className="grid gap-3 px-5 pb-5 max-h-[70vh] overflow-y-auto">
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="grid gap-1">
                <span className="text-xs font-semibold">네임스페이스</span>
                <input id="ar-apply-ns" className={cn(INPUT, 'font-mono')} value={d.namespace} disabled={ro} onChange={(e) => set({ namespace: e.target.value })} />
              </label>
              <label className="grid gap-1">
                <span className="text-xs font-semibold">리소스 이름 접두사</span>
                <input id="ar-apply-prefix" className={cn(INPUT, 'font-mono')} value={d.namePrefix} disabled={ro} onChange={(e) => set({ namePrefix: e.target.value })} />
                <span className="text-xs text-muted-foreground">이름: 접두사-서비스-알람 항목(소문자)</span>
              </label>
            </div>
            <label className="grid gap-1">
              <span className="text-xs font-semibold">PrometheusRule 라벨 <span className="font-normal text-muted-foreground">(한 줄에 key=value)</span></span>
              <textarea id="ar-apply-rule-labels" className={cn(INPUT, 'font-mono text-xs')} rows={3} value={d.ruleLabels} disabled={ro}
                placeholder="release=kube-prometheus-stack" onChange={(e) => set({ ruleLabels: e.target.value })} />
              <span className="text-xs text-muted-foreground">kube-prometheus-stack 기본은 release=&lt;헬름 릴리스 이름&gt;, prometheus-operator 예제는 prometheus=k8s 입니다.</span>
            </label>
            <label className="grid gap-1">
              <span className="text-xs font-semibold">알람 라벨 <span className="font-normal text-muted-foreground">(모든 규칙에 추가 — 알림 라우팅용)</span></span>
              <textarea id="ar-apply-alert-labels" className={cn(INPUT, 'font-mono text-xs')} rows={2} value={d.alertLabels} disabled={ro}
                placeholder="team=platform" onChange={(e) => set({ alertLabels: e.target.value })} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-primary" checked={d.markAppliedOnSuccess} disabled={ro}
                onChange={(e) => set({ markAppliedOnSuccess: e.target.checked })} />
              모든 클러스터에 성공하면 「진행」 요청을 「완료」로 바꾸기
            </label>

            <div className="grid gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">클러스터별 재정의</span>
                <button type="button" className={BTN_SM} disabled={ro}
                  onClick={() => set({ overrides: [...d.overrides, { clusterId: '', namespace: '', ruleLabels: '' }] })}>
                  <Plus className="w-3.5 h-3.5" /> 추가
                </button>
              </div>
              {d.overrides.length === 0 && <p className="text-xs text-muted-foreground">없음 — 모든 클러스터가 위 값을 씁니다.</p>}
              {d.overrides.map((o, i) => (
                <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] gap-1.5 items-start rounded-md border border-border p-2">
                  <select className={cn(INPUT, 'text-xs')} value={o.clusterId} disabled={ro} aria-label="클러스터"
                    onChange={(e) => setOv(i, { clusterId: e.target.value })}>
                    <option value="">클러스터 선택</option>
                    {clusters.map((c) => (
                      <option key={c.id} value={c.id} disabled={c.id !== o.clusterId && d.overrides.some((x) => x.clusterId === c.id)}>{c.name}</option>
                    ))}
                  </select>
                  <input className={cn(INPUT, 'font-mono text-xs')} value={o.namespace} placeholder="네임스페이스(비우면 기본)" disabled={ro}
                    aria-label="재정의 네임스페이스" onChange={(e) => setOv(i, { namespace: e.target.value })} />
                  <button type="button" title="재정의 삭제" aria-label="재정의 삭제" disabled={ro}
                    className="inline-flex items-center justify-center w-7 h-7 rounded-xl text-muted-foreground hover:text-status-critical hover:bg-secondary"
                    onClick={() => set({ overrides: d.overrides.filter((_, j) => j !== i) })}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  <textarea className={cn(INPUT, 'font-mono text-xs col-span-2')} rows={2} value={o.ruleLabels} disabled={ro}
                    placeholder="PrometheusRule 라벨 key=value (비우면 기본)" aria-label="재정의 PrometheusRule 라벨"
                    onChange={(e) => setOv(i, { ruleLabels: e.target.value })} />
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className={BTN} onClick={close} disabled={save.isPending}>닫기</button>
              <button type="button" className={BTN_PRIMARY} onClick={onSave} disabled={ro || save.isPending}
                title={perm.withHint('저장')} aria-label={perm.ariaWithHint('저장')}>
                {save.isPending ? '저장 중…' : '저장'}
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
