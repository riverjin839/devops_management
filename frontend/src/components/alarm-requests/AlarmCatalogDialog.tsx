import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/components/common/Toast';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useAlarmCatalog, useDeleteAlarmCatalogItem, useSaveAlarmCatalogItem } from '@/hooks/useAlarmRequests';
import { cn, formatApiError } from '@/lib/utils';
import type { AlarmCatalogItem, AlarmCatalogItemInput, AlarmSeverity } from '@/types';
import { BTN, BTN_DANGER, BTN_PRIMARY, BTN_SM, CODE_INPUT, DURATION_RE, INPUT, SEVERITY_CLS, SEVERITY_LABEL, SEVERITY_ORDER } from './styles';

const blank = (service: string): AlarmCatalogItemInput => ({ service, metricName: '', meaning: '', thresholds: [], enabled: true });
const toInput = (c: AlarmCatalogItem): AlarmCatalogItemInput => ({
  service: c.service, metricName: c.metricName, meaning: c.meaning ?? '', thresholds: c.thresholds.map((t) => ({ ...t })), enabled: c.enabled,
});

/**
 * 알람 카탈로그 편집(운영자 이상) — 서비스별 알람 항목·의미·기본 임계치.
 * 요청서의 「기본 임계치」가 여기서 온다. 요청이 완료되면 그 수정 임계치로 자동 갱신된다.
 */
export function AlarmCatalogDialog({ open, onClose, services }: { open: boolean; onClose: () => void; services: string[] }) {
  const toast = useToast();
  const perm = useCanOperate();
  const { data: items = [] } = useAlarmCatalog(true);
  const save = useSaveAlarmCatalogItem();
  const del = useDeleteAlarmCatalogItem();
  const [svc, setSvc] = useState<string>('all');
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState<AlarmCatalogItemInput | null>(null);

  const shown = useMemo(() => items.filter((i) => svc === 'all' || i.service === svc), [items, svc]);
  const select = (c: AlarmCatalogItem) => { setEditId(c.id); setForm(toInput(c)); };
  const startNew = () => { setEditId(null); setForm(blank(svc === 'all' ? services[0] ?? 'k8s' : svc)); };
  const setF = (patch: Partial<AlarmCatalogItemInput>) => form && setForm({ ...form, ...patch });

  const invalid = !form || !form.service.trim() || !form.metricName.trim()
    || form.thresholds.some((t) => !t.expr.trim() || !DURATION_RE.test(t.for.trim()));

  const onSave = () => {
    if (!form || invalid) return;
    save.mutate({ id: editId, data: form }, {
      onSuccess: (item) => { toast.success('알람 카탈로그를 저장했습니다', item.metricName); setEditId(item.id); },
      onError: (e) => toast.error('저장하지 못했습니다', formatApiError(e)),
    });
  };
  const onDelete = () => {
    if (!editId) return;
    del.mutate(editId, {
      onSuccess: () => { toast.success('알람 항목을 삭제했습니다'); setEditId(null); setForm(null); },
      onError: (e) => toast.error('삭제하지 못했습니다', formatApiError(e)),
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !save.isPending) onClose(); }}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>알람 카탈로그</DialogTitle>
          <DialogDescription>
            서비스별 알람 항목과 기본 임계치입니다. 요청서에서 항목을 고르면 여기 값이 기본 임계치로 채워집니다.
          </DialogDescription>
        </DialogHeader>
        <div className="grid md:grid-cols-[minmax(0,280px)_minmax(0,1fr)] gap-4 px-5 pb-5">
          <div className="grid gap-2 content-start min-w-0">
            <div className="flex gap-2">
              <select className={cn(INPUT, 'text-xs')} value={svc} aria-label="서비스" onChange={(e) => setSvc(e.target.value)}>
                <option value="all">전체 서비스</option>
                {services.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button type="button" className={BTN_SM} onClick={startNew} disabled={!perm.canOperate} title={perm.withHint('새 항목')}>
                <Plus className="w-3.5 h-3.5" /> 새 항목
              </button>
            </div>
            <ul className="max-h-[56vh] overflow-y-auto rounded-md border border-border divide-y divide-border">
              {shown.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => select(c)}
                    className={cn('w-full text-left px-2.5 py-1.5 hover:bg-secondary', editId === c.id && 'bg-primary/10')}>
                    <div className="font-mono text-xs truncate">{c.metricName}</div>
                    <div className="text-xs text-muted-foreground">
                      {c.service} · {c.thresholds.length}개 심각도{c.enabled ? '' : ' · 사용 안 함'}
                    </div>
                  </button>
                </li>
              ))}
              {shown.length === 0 && <li className="px-2.5 py-3 text-xs text-muted-foreground">항목이 없습니다.</li>}
            </ul>
          </div>

          {form ? (
            <div className="grid gap-3 content-start min-w-0">
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="grid gap-1">
                  <span className="text-xs font-semibold">서비스 명</span>
                  <input className={INPUT} list="ar-cat-services" value={form.service} onChange={(e) => setF({ service: e.target.value })} />
                  <datalist id="ar-cat-services">{services.map((s) => <option key={s} value={s}>{s}</option>)}</datalist>
                </label>
                <label className="grid gap-1">
                  <span className="text-xs font-semibold">알람 항목</span>
                  <input className={cn(INPUT, 'font-mono')} value={form.metricName} onChange={(e) => setF({ metricName: e.target.value })} />
                </label>
              </div>
              <label className="grid gap-1">
                <span className="text-xs font-semibold">알람 의미</span>
                <textarea className={INPUT} rows={2} value={form.meaning ?? ''} onChange={(e) => setF({ meaning: e.target.value })} />
              </label>
              <div className="grid gap-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold">기본 임계치</span>
                  <button type="button" className={BTN_SM}
                    disabled={form.thresholds.length >= SEVERITY_ORDER.length}
                    onClick={() => {
                      const sev = SEVERITY_ORDER.find((s) => !form.thresholds.some((t) => t.severity === s));
                      if (sev) setF({ thresholds: [...form.thresholds, { severity: sev, expr: '', for: '5m' }] });
                    }}>
                    <Plus className="w-3.5 h-3.5" /> 행 추가
                  </button>
                </div>
                {form.thresholds.map((t, i) => (
                  <div key={i} className="grid grid-cols-[96px_minmax(0,1fr)_80px_32px] gap-1.5 items-center">
                    <select className={cn(INPUT, 'text-xs', SEVERITY_CLS[t.severity])} value={t.severity} aria-label="심각도"
                      onChange={(e) => setF({ thresholds: form.thresholds.map((x, j) => (j === i ? { ...x, severity: e.target.value as AlarmSeverity } : x)) })}>
                      {SEVERITY_ORDER.map((s) => (
                        <option key={s} value={s} disabled={s !== t.severity && form.thresholds.some((x) => x.severity === s)}>{SEVERITY_LABEL[s]}</option>
                      ))}
                    </select>
                    <input className={CODE_INPUT} value={t.expr} placeholder="expr" aria-label="expr"
                      onChange={(e) => setF({ thresholds: form.thresholds.map((x, j) => (j === i ? { ...x, expr: e.target.value } : x)) })} />
                    <input className={cn(CODE_INPUT, !DURATION_RE.test(t.for.trim()) && 'ring-1 ring-status-critical')} value={t.for}
                      placeholder="for" aria-label="for(지속)"
                      onChange={(e) => setF({ thresholds: form.thresholds.map((x, j) => (j === i ? { ...x, for: e.target.value } : x)) })} />
                    <button type="button" title="행 삭제" aria-label="행 삭제"
                      className="inline-flex items-center justify-center w-7 h-7 rounded-xl text-muted-foreground hover:text-status-critical hover:bg-secondary"
                      onClick={() => setF({ thresholds: form.thresholds.filter((_, j) => j !== i) })}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-primary" checked={form.enabled} onChange={(e) => setF({ enabled: e.target.checked })} />
                요청서 목록에 표시
              </label>
              <div className="flex flex-wrap justify-between gap-2 pt-1">
                <button type="button" className={BTN_DANGER} onClick={onDelete} disabled={!editId || del.isPending || !perm.canOperate}
                  title={perm.withHint('삭제')}>삭제</button>
                <div className="flex gap-2">
                  <button type="button" className={BTN} onClick={() => { setForm(null); setEditId(null); }}>닫기</button>
                  <button type="button" className={BTN_PRIMARY} onClick={onSave} disabled={invalid || save.isPending || !perm.canOperate}
                    title={perm.withHint('저장')} aria-label={perm.ariaWithHint('저장')}>
                    {save.isPending ? '저장 중…' : '저장'}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground self-center text-center">왼쪽에서 항목을 고르거나 새 항목을 추가하세요.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
