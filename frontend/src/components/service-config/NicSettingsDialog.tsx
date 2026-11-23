// NIC 설정(admin, 모든 클러스터 공통) — 수집 대상(에이전트에 전달, 다음 보고 주기부터)과 판정 기준(저장 즉시 반영).
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { LoadingState, useToast } from '@/components/common';
import { useNicWatchSettings, useUpdateNicWatchSettings } from '@/hooks/useNicWatch';
import { formatApiError } from '@/lib/utils';
import type { NicWatchSettings } from '@/types';

const INPUT = 'w-full px-2.5 py-1.5 rounded-xl border border-border bg-card text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60';
const KIND_LABEL: Record<string, string> = { physical: '물리', bond: '본딩', vlan: 'VLAN', tunnel: '터널(VXLAN·Geneve)', bridge: '브리지', virtual: '기타 가상' };

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
      {help && <span className="block mt-1 text-muted-foreground">{help}</span>}
    </label>
  );
}

const splitList = (v: string) => v.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

export function NicSettingsDialog({ open, isAdmin, onClose }: { open: boolean; isAdmin: boolean; onClose: () => void }) {
  const toast = useToast();
  const q = useNicWatchSettings(open);
  const save = useUpdateNicWatchSettings();
  const [form, setForm] = useState<NicWatchSettings | null>(null);
  const [incText, setIncText] = useState('');
  const [excText, setExcText] = useState('');
  useEffect(() => {
    if (open && q.data) {
      setForm(q.data);
      setIncText(q.data.includeNames.join(', '));
      setExcText(q.data.excludeNames.join(', '));
    }
  }, [open, q.data]);
  const set = (p: Partial<NicWatchSettings>) => setForm((f) => (f ? { ...f, ...p } : f));
  const opts = q.data?.options;
  const dis = !isAdmin;

  const onSave = async () => {
    if (!form) return;
    try {
      await save.mutateAsync({ ...form, includeNames: splitList(incText), excludeNames: splitList(excText) });
      toast.success('NIC 설정을 저장했습니다');
      onClose();
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  const num = (key: keyof NicWatchSettings, label: string, help: string, min: number, max: number) => (
    <Field label={label} help={help}>
      <input type="number" min={min} max={max} className={INPUT} disabled={dis} value={form ? Number(form[key]) : 0}
        onChange={(e) => set({ [key]: Number(e.target.value) || 0 } as Partial<NicWatchSettings>)} aria-label={label} />
    </Field>
  );

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !save.isPending) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>NIC 설정</DialogTitle>
          <DialogDescription>모든 클러스터 공통 · {isAdmin ? '관리자만 바꿀 수 있습니다' : '관리자만 바꿀 수 있습니다(읽기 전용)'}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[64vh] overflow-y-auto space-y-3 px-5 pb-3">
          {!form || !opts ? <LoadingState /> : (
            <>
              <p className="text-xs font-semibold text-foreground">수집 대상 <span className="font-normal text-muted-foreground">· 에이전트의 다음 보고부터 반영</span></p>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" disabled={dis} checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
                NIC 상태 수집 켜기(노드 파라미터 에이전트 1.2.0 이상)
              </label>
              <fieldset className="text-xs">
                <legend className="text-muted-foreground">수집할 인터페이스 종류</legend>
                <div className="mt-1 flex flex-wrap gap-3">
                  {opts.kinds.map((k) => (
                    <label key={k} className="flex items-center gap-1.5 text-sm">
                      <input type="checkbox" disabled={dis} checked={form.includeKinds.includes(k)}
                        onChange={(e) => set({ includeKinds: e.target.checked ? [...form.includeKinds, k] : form.includeKinds.filter((x) => x !== k) })} />
                      {KIND_LABEL[k] ?? k}
                    </label>
                  ))}
                </div>
              </fieldset>
              <Field label="종류와 상관없이 넣을 이름(glob, 쉼표)" help="예: cilium_host, cilium_vxlan — overlay MTU 를 함께 보려면 넣는다.">
                <input className={INPUT} disabled={dis} value={incText} onChange={(e) => setIncText(e.target.value)} aria-label="포함할 인터페이스 이름" />
              </Field>
              <Field label="제외할 이름(glob, 쉼표)" help="제외가 포함보다 우선한다. 사용하지 않는 포트(eno3 등)를 넣으면 '링크 없음' 참고가 사라진다.">
                <input className={INPUT} disabled={dis} value={excText} onChange={(e) => setExcText(e.target.value)} aria-label="제외할 인터페이스 이름" />
              </Field>

              <p className="pt-2 text-xs font-semibold text-foreground">본딩 / LACP 기대 값 <span className="font-normal text-muted-foreground">· 비우면 검사하지 않는다</span></p>
              <div className="grid grid-cols-3 gap-2">
                <Field label="본딩 모드">
                  <select className={INPUT} disabled={dis} value={form.expectedBondMode} onChange={(e) => set({ expectedBondMode: e.target.value })} aria-label="기대 본딩 모드">
                    {opts.bondModes.map((m) => <option key={m} value={m}>{m || '검사 안 함'}</option>)}
                  </select>
                </Field>
                <Field label="해시 정책">
                  <select className={INPUT} disabled={dis} value={form.expectedHashPolicy} onChange={(e) => set({ expectedHashPolicy: e.target.value })} aria-label="기대 해시 정책">
                    {opts.hashPolicies.map((m) => <option key={m} value={m}>{m || '검사 안 함'}</option>)}
                  </select>
                </Field>
                <Field label="LACP rate">
                  <select className={INPUT} disabled={dis} value={form.expectedLacpRate} onChange={(e) => set({ expectedLacpRate: e.target.value })} aria-label="기대 LACP rate">
                    {opts.lacpRates.map((m) => <option key={m} value={m}>{m || '검사 안 함'}</option>)}
                  </select>
                </Field>
              </div>

              <p className="pt-2 text-xs font-semibold text-foreground">링크 · 카운터 임계치 <span className="font-normal text-muted-foreground">· 0 이면 검사하지 않는다</span></p>
              <div className="grid grid-cols-3 gap-2">
                {num('minSpeedMbps', '최소 링크 속도(Mb/s)', '물리 인터페이스가 이보다 낮게 협상되면 경고.', 0, 800000)}
                {num('rateWindowMinutes', '증가율 계산 창(분)', '5 ~ 60. 이 시간 동안 늘어난 값으로 판정한다.', 5, 60)}
                {num('dropWarnPerMin', '수신 드롭(분당)', 'NIC·드라이버 드롭(rx_missed 등) 분당 건수.', 0, 10000000)}
                {num('crcWarnCount', 'CRC 오류(창 동안)', '케이블·광모듈 불량 신호.', 0, 1000000)}
                {num('flapWarnCount', '링크 끊김(창 동안)', 'carrier 변화 횟수.', 0, 1000)}
                {num('staleMinutes', '보고 끊김(분)', '마지막 보고 뒤 이 시간이 지나면 경고.', 1, 1440)}
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" disabled={dis} checked={form.crossNodeCheck} onChange={(e) => set({ crossNodeCheck: e.target.checked })} />
                노드 간 비교 — 같은 이름 인터페이스의 MTU·속도·본딩 설정·offload 가 다수와 다르면 경고
              </label>

              <p className="pt-2 text-xs font-semibold text-foreground">offload 기대 값</p>
              <ul className="space-y-1.5">
                {form.offloadExpect.map((o, i) => (
                  <li key={`${o.name}-${i}`} className="flex items-center gap-2">
                    <select className={`${INPUT} flex-1`} disabled={dis} value={o.name} aria-label="offload 기능"
                      onChange={(e) => set({ offloadExpect: form.offloadExpect.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}>
                      {opts.features.map((f) => <option key={f.name} value={f.name}>{f.label} ({f.name})</option>)}
                    </select>
                    <select className={`${INPUT} w-24`} disabled={dis} value={o.on ? 'on' : 'off'} aria-label={`${o.name} 기대 값`}
                      onChange={(e) => set({ offloadExpect: form.offloadExpect.map((x, j) => (j === i ? { ...x, on: e.target.value === 'on' } : x)) })}>
                      <option value="on">on</option><option value="off">off</option>
                    </select>
                    <Button size="icon" variant="ghost" disabled={dis} title="기대 값 지우기" aria-label={`${o.name} 기대 값 지우기`}
                      onClick={() => set({ offloadExpect: form.offloadExpect.filter((_, j) => j !== i) })}><Trash2 /></Button>
                  </li>
                ))}
              </ul>
              <Button size="sm" variant="outline" disabled={dis} onClick={() => set({ offloadExpect: [...form.offloadExpect, { name: 'rx-gro', on: true }] })}>
                <Plus /> 기대 값 추가
              </Button>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>닫기</Button>
          {isAdmin && <Button onClick={() => { void onSave(); }} disabled={!form || save.isPending}>{save.isPending ? '저장 중…' : '저장'}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
