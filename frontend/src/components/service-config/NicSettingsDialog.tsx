// NIC 설정(admin) — 수집 대상(에이전트에 전달, 다음 보고 주기부터)과 판정 기준(저장 즉시 반영).
// 공통 기준(모든 클러스터의 기본값) + 이 클러스터 재정의. 이름(bond0·ens192·eth0 …)은 입력하지 않아도 종류별로 자동 수집되므로,
// 클러스터마다 다른 것은 주로 판정 기준(본딩 모드·최소 속도·임계치)이다 — "관측 값으로 채우기"가 보고된 구성에서 제안한다.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, LoadingState, SegTabs, useToast } from '@/components/common';
import {
  useClearNicClusterSettings, useNicClusterSettings, useNicObserved, useNicOverrides, useNicWatchSettings,
  useUpdateNicClusterSettings, useUpdateNicWatchSettings,
} from '@/hooks/useNicWatch';
import { formatApiError } from '@/lib/utils';
import type { NicWatchSettings } from '@/types';

const INPUT = 'w-full px-2.5 py-1.5 rounded-xl border border-border bg-card text-sm font-mono text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60';
const KIND_LABEL: Record<string, string> = { physical: '물리', bond: '본딩', vlan: 'VLAN', tunnel: '터널(VXLAN·Geneve)', bridge: '브리지', virtual: '기타 가상' };

type Scope = 'cluster' | 'global';
type FieldKey = keyof NicWatchSettings;
const FIELD_LABEL: Record<FieldKey, string> = {
  enabled: '수집', includeKinds: '수집 종류', includeNames: '포함 이름', excludeNames: '제외 이름',
  expectedBondMode: '본딩 모드', expectedHashPolicy: '해시 정책', expectedLacpRate: 'LACP rate', minSpeedMbps: '최소 링크 속도',
  crossNodeCheck: '노드 간 비교', rateWindowMinutes: '증가율 창', dropWarnPerMin: '드롭 경고', crcWarnCount: 'CRC 경고',
  flapWarnCount: '링크 끊김 경고', offloadExpect: 'offload 기대 값', staleMinutes: '보고 끊김',
};
const FIELD_KEYS = Object.keys(FIELD_LABEL) as FieldKey[];
// 서버(재정의 목록·reset_fields)는 필드명을 snake_case 로 주고받는다 — 값은 응답 변환을 타지 않는다.
const toSnake = (k: string) => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
const toCamel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function fmt(v: NicWatchSettings[FieldKey]): string {
  if (typeof v === 'boolean') return v ? '켬' : '끔';
  if (typeof v === 'number') return v === 0 ? '0 (검사 안 함)' : String(v);
  if (typeof v === 'string') return v || '검사 안 함';
  if (v.length === 0) return '없음';
  const items = v.map((x) => (typeof x === 'string' ? x : `${x.name}=${x.on ? 'on' : 'off'}`));
  return items.length > 4 ? `${items.slice(0, 4).join(', ')} 외 ${items.length - 4}개` : items.join(', ');
}

function Field({ label, help, children, note }: { label: string; help?: string; children: ReactNode; note?: ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
      {help && <span className="block mt-1 text-muted-foreground">{help}</span>}
      {note}
    </label>
  );
}

const splitList = (v: string) => v.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

export function NicSettingsDialog({ open, isAdmin, clusterId, onClose }: { open: boolean; isAdmin: boolean; clusterId: string; onClose: () => void }) {
  const toast = useToast();
  const [scope, setScope] = useState<Scope>('cluster');
  const gq = useNicWatchSettings(open);
  const cq = useNicClusterSettings(clusterId, open);
  const oq = useNicObserved(clusterId, open && scope === 'cluster');
  const ovq = useNicOverrides(open && scope === 'global');
  const saveG = useUpdateNicWatchSettings();
  const saveC = useUpdateNicClusterSettings(clusterId);
  const clearC = useClearNicClusterSettings(clusterId);
  const [form, setForm] = useState<NicWatchSettings | null>(null);
  const [overridden, setOverridden] = useState<Set<FieldKey>>(new Set());
  const [incText, setIncText] = useState('');
  const [excText, setExcText] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const scoped = scope === 'cluster';
  const src = scoped ? cq.data?.effective : gq.data;
  const opts = (scoped ? cq.data : gq.data)?.options;
  const globalCfg = cq.data?.global;
  const serverOverridden = cq.data?.overridden;
  const dis = !isAdmin;
  const busy = saveG.isPending || saveC.isPending || clearC.isPending;

  useEffect(() => {
    if (!open || !src) return;
    setForm(src);
    setIncText(src.includeNames.join(', '));
    setExcText(src.excludeNames.join(', '));
    setOverridden(scoped ? new Set((serverOverridden ?? []).map(toCamel).filter((k): k is FieldKey => (FIELD_KEYS as string[]).includes(k))) : new Set());
  }, [open, src, scoped, serverOverridden]);

  /** 값을 바꾸면 이 클러스터에서는 그 항목이 재정의로 표시된다(공통 기준 탭에서는 표시 없음). */
  const mark = (keys: FieldKey[]) => {
    if (scoped) setOverridden((prev) => new Set([...prev, ...keys]));
  };
  const set = (p: Partial<NicWatchSettings>) => {
    setForm((f) => (f ? { ...f, ...p } : f));
    mark(Object.keys(p) as FieldKey[]);
  };
  const revert = (k: FieldKey) => {
    if (!globalCfg) return;
    setForm((f) => (f ? { ...f, [k]: globalCfg[k] } : f));
    if (k === 'includeNames') setIncText(globalCfg.includeNames.join(', '));
    if (k === 'excludeNames') setExcText(globalCfg.excludeNames.join(', '));
    setOverridden((prev) => { const n = new Set(prev); n.delete(k); return n; });
  };

  /** 항목 아래 한 줄 — 공통 값과 재정의 여부, 되돌리기. 클러스터 탭에서만 보인다. */
  const note = (k: FieldKey): ReactNode => {
    if (!scoped || !globalCfg) return null;
    const on = overridden.has(k);
    return (
      <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>공통 값: {fmt(globalCfg[k])}</span>
        {on ? (
          <>
            <span className="rounded-md bg-secondary px-1.5 py-0.5 font-medium text-foreground">재정의</span>
            {!dis && <button type="button" className="text-primary underline" onClick={(e) => { e.preventDefault(); revert(k); }}>공통으로 되돌리기</button>}
          </>
        ) : <span>공통 따름</span>}
      </span>
    );
  };

  const applyObserved = () => {
    const sug = oq.data?.suggest;
    if (!sug || !globalCfg) return;
    const changed: FieldKey[] = [];
    const same: FieldKey[] = [];
    for (const [k, v] of Object.entries(sug)) {
      const key = k as FieldKey;
      (globalCfg[key] === v ? same : changed).push(key);
    }
    setForm((f) => (f ? { ...f, ...sug } : f));
    setOverridden((prev) => { const n = new Set(prev); changed.forEach((k) => n.add(k)); same.forEach((k) => n.delete(k)); return n; });
    toast.success('관측 값을 채웠습니다', '저장해야 적용됩니다');
  };

  const onSave = async () => {
    if (!form) return;
    const next = { ...form, includeNames: splitList(incText), excludeNames: splitList(excText) };
    try {
      if (scoped) {
        const patch: Partial<NicWatchSettings> = {};
        overridden.forEach((k) => { (patch as Record<string, unknown>)[k] = next[k]; });
        const before = new Set((serverOverridden ?? []).map(toCamel));
        const resetFields = [...before].filter((k) => !overridden.has(k as FieldKey)).map(toSnake);
        await saveC.mutateAsync({ ...patch, resetFields });
        toast.success('이 클러스터의 NIC 기준을 저장했습니다');
      } else {
        await saveG.mutateAsync(next);
        toast.success('공통 NIC 기준을 저장했습니다');
      }
      onClose();
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  const onClear = async () => {
    try {
      await clearC.mutateAsync();
      toast.success('이 클러스터의 재정의를 모두 지웠습니다', '공통 기준을 따릅니다');
      setConfirmClear(false);
      onClose();
    } catch (e) {
      toast.error('초기화 실패', formatApiError(e));
    }
  };

  const num = (key: 'minSpeedMbps' | 'rateWindowMinutes' | 'dropWarnPerMin' | 'crcWarnCount' | 'flapWarnCount' | 'staleMinutes',
    label: string, help: string, min: number, max: number) => (
    <Field label={label} help={help} note={note(key)}>
      <input type="number" min={min} max={max} className={INPUT} disabled={dis} value={form ? Number(form[key]) : 0}
        onChange={(e) => set({ [key]: Number(e.target.value) || 0 } as Partial<NicWatchSettings>)} aria-label={label} />
    </Field>
  );

  const ob = oq.data;
  const obsKinds = ob ? Object.entries(ob.interfaces) : [];

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>NIC 판정 기준</DialogTitle>
            <DialogDescription>
              {scoped ? '이 클러스터에만 적용 · 바꾸지 않은 항목은 공통 기준을 따릅니다' : '재정의하지 않은 모든 클러스터의 기본값'} · {isAdmin ? '관리자만 바꿀 수 있습니다' : '관리자만 바꿀 수 있습니다(읽기 전용)'}
            </DialogDescription>
          </DialogHeader>
          <div className="px-5">
            <SegTabs<Scope> mode="tabs" label="적용 범위" value={scope} onChange={setScope} size="md"
              options={[['cluster', `이 클러스터${scoped && overridden.size > 0 ? ` · 재정의 ${overridden.size}` : ''}`], ['global', '공통 기준']]} />
          </div>
          <div className="max-h-[60vh] overflow-y-auto space-y-3 px-5 pb-3 pt-3">
            {!form || !opts ? <LoadingState /> : (
              <>
                {scoped && (
                  <div className="rounded-md border border-border bg-secondary/40 p-3 text-xs">
                    {!ob || ob.nodeCount === 0 ? (
                      <p className="text-muted-foreground">아직 NIC 를 보고한 노드가 없습니다. 에이전트가 보고하면 구성을 자동으로 확인해 기준을 제안합니다.</p>
                    ) : (
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <p className="font-medium text-foreground">이 클러스터에서 자동 확인된 구성 · 노드 {ob.nodeCount}대 보고</p>
                          <p className="text-muted-foreground">
                            {obsKinds.map(([k, names]) => `${KIND_LABEL[k] ?? k} ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` 외 ${names.length - 4}` : ''}`).join(' · ') || '인터페이스 없음'}
                          </p>
                          <p className="text-muted-foreground">
                            제안: {ob.bondCount === 0 ? '본딩 없음 — 본딩 기준 검사 안 함' : `본딩 ${ob.suggest.expectedBondMode ?? '?'} / ${ob.suggest.expectedHashPolicy ?? '?'} / ${ob.suggest.expectedLacpRate ?? '?'}`}
                            {ob.suggest.minSpeedMbps ? ` · 최소 속도 ${ob.suggest.minSpeedMbps} Mb/s` : ''}
                          </p>
                        </div>
                        <Button size="sm" variant="outline" disabled={dis} onClick={applyObserved}
                          title={dis ? '관리자만 바꿀 수 있습니다' : '보고된 구성에서 뽑은 값을 아래에 채웁니다(저장 전 확인)'}>관측 값으로 채우기</Button>
                      </div>
                    )}
                  </div>
                )}

                <p className="text-xs font-semibold text-foreground">수집 대상 <span className="font-normal text-muted-foreground">· 에이전트의 다음 보고부터 반영 · 이름이 아니라 종류로 자동 수집</span></p>
                <div>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" disabled={dis} checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
                    NIC 상태 수집 켜기(노드 에이전트 1.2.0 이상)
                  </label>
                  {note('enabled')}
                </div>
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
                  {note('includeKinds')}
                </fieldset>
                <Field label="종류와 상관없이 넣을 이름(glob, 쉼표)" help="예: cilium_host, cilium_vxlan — overlay MTU 를 함께 보려면 넣는다." note={note('includeNames')}>
                  <input className={INPUT} disabled={dis} value={incText} aria-label="포함할 인터페이스 이름"
                    onChange={(e) => { setIncText(e.target.value); mark(['includeNames']); }} />
                </Field>
                <Field label="제외할 이름(glob, 쉼표)" help="제외가 포함보다 우선한다. 사용하지 않는 포트(eno3 등)를 넣으면 '링크 없음' 참고가 사라진다." note={note('excludeNames')}>
                  <input className={INPUT} disabled={dis} value={excText} aria-label="제외할 인터페이스 이름"
                    onChange={(e) => { setExcText(e.target.value); mark(['excludeNames']); }} />
                </Field>

                <p className="pt-2 text-xs font-semibold text-foreground">본딩 / LACP 기대 값 <span className="font-normal text-muted-foreground">· 비우면 검사하지 않는다(본딩이 없는 클러스터는 비워 둔다)</span></p>
                <div className="grid grid-cols-3 gap-2">
                  <Field label="본딩 모드" note={note('expectedBondMode')}>
                    <select className={INPUT} disabled={dis} value={form.expectedBondMode} onChange={(e) => set({ expectedBondMode: e.target.value })} aria-label="기대 본딩 모드">
                      {opts.bondModes.map((m) => <option key={m} value={m}>{m || '검사 안 함'}</option>)}
                    </select>
                  </Field>
                  <Field label="해시 정책" note={note('expectedHashPolicy')}>
                    <select className={INPUT} disabled={dis} value={form.expectedHashPolicy} onChange={(e) => set({ expectedHashPolicy: e.target.value })} aria-label="기대 해시 정책">
                      {opts.hashPolicies.map((m) => <option key={m} value={m}>{m || '검사 안 함'}</option>)}
                    </select>
                  </Field>
                  <Field label="LACP rate" note={note('expectedLacpRate')}>
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
                <div>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" disabled={dis} checked={form.crossNodeCheck} onChange={(e) => set({ crossNodeCheck: e.target.checked })} />
                    노드 간 비교 — 같은 이름 인터페이스의 MTU·속도·본딩 설정·offload 가 다수와 다르면 경고
                  </label>
                  {note('crossNodeCheck')}
                </div>

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
                {note('offloadExpect')}

                {!scoped && (
                  <div className="rounded-md border border-border p-3 text-xs">
                    <p className="font-medium text-foreground">공통 기준을 재정의한 클러스터</p>
                    {ovq.isLoading ? <p className="mt-1 text-muted-foreground">불러오는 중…</p> : (ovq.data ?? []).length === 0 ? (
                      <p className="mt-1 text-muted-foreground">없음 — 모든 클러스터가 공통 기준을 따릅니다.</p>
                    ) : (
                      <ul className="mt-1 space-y-0.5">
                        {(ovq.data ?? []).map((o) => (
                          <li key={o.clusterId} className="text-muted-foreground">
                            <span className="font-medium text-foreground">{o.clusterName}</span>
                            {' — '}{o.fields.map((f) => FIELD_LABEL[toCamel(f) as FieldKey] ?? f).join(', ')}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            {scoped && isAdmin && (serverOverridden?.length ?? 0) > 0 && (
              <Button variant="outline" className="mr-auto" disabled={busy} onClick={() => setConfirmClear(true)}>재정의 모두 지우기</Button>
            )}
            <Button variant="outline" onClick={onClose} disabled={busy}>닫기</Button>
            {isAdmin && <Button onClick={() => { void onSave(); }} disabled={!form || busy}>{busy ? '저장 중…' : '저장'}</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={confirmClear} danger title="이 클러스터의 재정의를 모두 지울까요?"
        description="이 클러스터가 공통 기준을 따르게 됩니다. 공통 기준과 다른 클러스터에는 영향이 없습니다."
        confirmLabel="모두 지우기" busy={clearC.isPending} onConfirm={() => { void onClear(); }} onCancel={() => setConfirmClear(false)} />
    </>
  );
}
