// 일일 리포트 설정 — 공개 여부·보관 일수(과거 조회 범위 = 롤업 데이터 양)·랭킹 기준·공개 클러스터.
// UI-First: 부하/노출 범위는 코드가 아니라 여기서 조절한다. 변경은 admin 만(서버 require_admin).
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useToast } from '@/components/common';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useClusters } from '@/hooks/useCluster';
import { useDailyReportSettings, useSaveDailyReportSettings } from '@/hooks/useDailyReport';
import { formatApiError } from '@/lib/utils';
import type { DailyReportSettings } from '@/types';

const INPUT = 'w-full text-sm px-2 py-1 rounded-xl border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary';
const BTN = 'text-sm inline-flex items-center gap-1 px-3 py-1 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-50';
const BTN_PRIMARY = 'text-sm inline-flex items-center gap-1 px-3 py-1 rounded-xl bg-primary text-primary-foreground disabled:opacity-50';
const MI = 1024 ** 2;

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="mt-0.5">{children}</div>
      {help && <span className="block text-[11px] text-muted-foreground mt-0.5 leading-snug">{help}</span>}
    </label>
  );
}

function Check({ checked, onChange, label, help }: { checked: boolean; onChange: (v: boolean) => void; label: string; help?: string }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-primary mt-0.5" />
      <span>
        {label}
        {help && <span className="block text-[11px] text-muted-foreground leading-snug">{help}</span>}
      </span>
    </label>
  );
}

export function DailyReportSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const { data } = useDailyReportSettings(open);
  const { data: clusters = [] } = useClusters();
  const save = useSaveDailyReportSettings();
  const [form, setForm] = useState<DailyReportSettings | null>(null);

  useEffect(() => {
    if (open && data) setForm(data);
  }, [open, data]);

  const set = <K extends keyof DailyReportSettings>(k: K, v: DailyReportSettings[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f));

  const toggleCluster = (id: string, on: boolean) => {
    if (!form) return;
    const next = on ? [...form.publicClusterIds, id] : form.publicClusterIds.filter((x) => x !== id);
    set('publicClusterIds', next);
  };

  const onSave = async () => {
    if (!form) return;
    try {
      await save.mutateAsync(form);
      toast.success('일일 리포트 설정 저장됨');
      onClose();
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !save.isPending) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>일일 리포트 설정</DialogTitle>
          <DialogDescription>
            로그인 없이 보는 공개 화면의 노출 범위와 과거 조회 범위를 정한다. 지난 날짜는 매일 00:20 에 일 단위로 롤업된다.
          </DialogDescription>
        </DialogHeader>
        {!form ? (
          <p className="text-sm text-muted-foreground px-5 py-6 text-center">불러오는 중…</p>
        ) : (
          <div className="space-y-3 max-h-[60vh] overflow-y-auto px-5 pb-3">
            <Check checked={form.publicEnabled} onChange={(v) => set('publicEnabled', v)}
              label="공개 페이지 사용" help="끄면 /daily-report 와 공개 API 가 404 를 돌려준다." />
            <div className="grid grid-cols-2 gap-3">
              <Field label="보관·조회 일수" help="오늘 기준 과거 N 일까지 이동·보관한다. 지난 롤업은 매일 정리된다(1~400).">
                <input type="number" min={1} max={400} className={INPUT} value={form.retentionDays}
                  onChange={(e) => set('retentionDays', Number(e.target.value))} />
              </Field>
              <Field label="랭킹 개수" help="비효율 랭킹 표시 개수(1~50).">
                <input type="number" min={1} max={50} className={INPUT} value={form.topN}
                  onChange={(e) => set('topN', Number(e.target.value))} />
              </Field>
              <Field label="최소 CPU request (m)" help="당일 평균 request 가 이보다 작은 NS 는 CPU 랭킹에서 뺀다.">
                <input type="number" min={0} className={INPUT} value={form.minCpuReqM}
                  onChange={(e) => set('minCpuReqM', Number(e.target.value))} />
              </Field>
              <Field label="최소 메모리 request (Mi)" help="메모리 랭킹 노이즈 컷.">
                <input type="number" min={0} className={INPUT} value={Math.round(form.minMemReqB / MI)}
                  onChange={(e) => set('minMemReqB', Number(e.target.value) * MI)} />
              </Field>
            </div>
            <Check checked={form.excludeSystemNamespaces} onChange={(v) => set('excludeSystemNamespaces', v)}
              label="시스템 네임스페이스 제외" help="효율화 정책 기본값의 시스템 NS 목록(kube-system 등)을 랭킹에서 뺀다." />
            <Field label="공개 클러스터"
              help="아무것도 고르지 않으면 테넌트에 묶이지 않은 클러스터 전체가 공개된다. 고르면 고른 것만 공개된다.">
              <div className="max-h-40 overflow-y-auto rounded-xl border border-border p-2 space-y-1">
                {clusters.map((c) => (
                  <Check key={c.id} checked={form.publicClusterIds.includes(c.id)}
                    onChange={(v) => toggleCluster(c.id, v)} label={c.name} />
                ))}
                {clusters.length === 0 && <span className="text-xs text-muted-foreground">등록된 클러스터 없음</span>}
              </div>
            </Field>
          </div>
        )}
        <DialogFooter>
          <button type="button" className={BTN} onClick={onClose} disabled={save.isPending}>취소</button>
          <button type="button" className={BTN_PRIMARY} onClick={() => void onSave()} disabled={!form || save.isPending}>
            {save.isPending ? '저장 중…' : '저장'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
