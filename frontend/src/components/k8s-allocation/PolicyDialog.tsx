// 정책 설정 다이얼로그 — 전역 기본값(admin) / 네임스페이스 정책(operator, opt-in) / 수집 스케줄(admin).
// UI-First: 임계값·제외 목록·CR 어댑터 등 환경 차이는 전부 여기서 편집한다(코드 수정 없음).
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Download, Plus, Trash2, X } from 'lucide-react';
import { RoleGate } from '@/components/auth/RoleGate';
import { Skeleton, useToast, useModalA11y } from '@/components/common';
import {
  effErrMsg, useEffMutations, useEffPolicies, useEffPolicyDefaults, useEffQuotas, useEffSchedule, useEffSummary,
} from '@/hooks/useK8sEfficiency';
import type { EffCustomTarget, EffNamespacePolicy, EffPolicyDefaults } from '@/types';

type Tab = 'defaults' | 'namespace' | 'schedule';

const INPUT = 'w-full text-sm px-2 py-1 rounded-xl border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary';
const BTN = 'text-sm inline-flex items-center gap-1 px-3 py-1 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-50';
const BTN_PRIMARY = 'text-sm inline-flex items-center gap-1 px-3 py-1 rounded-xl bg-primary text-primary-foreground disabled:opacity-50';

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="text-muted-foreground">{label}</span>
      <div className="mt-0.5">{children}</div>
      {help && <span className="block text-[11px] text-muted-foreground/80 mt-0.5 leading-snug">{help}</span>}
    </label>
  );
}

function Num({ value, onChange, step = 1, min, placeholder }: {
  value: number | null | undefined; onChange: (v: number | null) => void; step?: number; min?: number; placeholder?: string;
}) {
  return (
    <input type="number" step={step} min={min} placeholder={placeholder} className={INPUT}
      value={value == null ? '' : value}
      onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />
  );
}

function Toggle({ checked, onChange, label, help }: { checked: boolean; onChange: (v: boolean) => void; label: string; help?: string }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-primary mt-0.5" />
      <span>
        {label}
        {help && <span className="block text-[11px] text-muted-foreground/80 leading-snug">{help}</span>}
      </span>
    </label>
  );
}

const MI = 1024 ** 2;
const GI = 1024 ** 3;

// ── 전역 기본값 탭 ──────────────────────────────────────────────────────────────
function DefaultsTab() {
  const q = useEffPolicyDefaults();
  const { saveDefaults } = useEffMutations('');
  const toast = useToast();
  const [form, setForm] = useState<EffPolicyDefaults | null>(null);
  useEffect(() => { if (q.data && !form) setForm(q.data); }, [q.data, form]);
  if (!form) return <Skeleton className="h-40 w-full" />;
  const set = <K extends keyof EffPolicyDefaults>(k: K, v: EffPolicyDefaults[K]) => setForm({ ...form, [k]: v });
  const setQ = <K extends keyof EffPolicyDefaults['quota']>(k: K, v: EffPolicyDefaults['quota'][K]) =>
    setForm({ ...form, quota: { ...form.quota, [k]: v } });
  const save = async () => {
    try {
      await saveDefaults.mutateAsync(form);
      toast.success('전역 기본값 저장됨', undefined);
    } catch (e) { toast.error('저장 실패', effErrMsg(e)); }
  };
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-status-warning/40 bg-status-warning/5 p-2 space-y-1.5">
        <Toggle checked={form.automationEnabled} onChange={(v) => set('automationEnabled', v)}
          label="자동 적용 마스터 스위치"
          help="꺼져 있으면 NS 가 opt-in 해도 추천만 냅니다. NS 정책·롤백 검증 후에 켜세요. 모든 자동 적용은 실행 로그 + 감사 로그에 남습니다." />
        <Field label="자동 적용 허용 시간대(cron, 비우면 항상)" help="예: '0-30 2 * * *' → 매일 02:00~02:30 에만 자동 적용">
          <input className={INPUT} value={form.maintenanceCron ?? ''} onChange={(e) => set('maintenanceCron', e.target.value || null)} placeholder="항상" />
        </Field>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Field label="사용률 소스" help="auto: Prometheus 우선 → metrics-server 샘플 → 데이터 부족">
          <select className={INPUT} value={form.usageSource} onChange={(e) => set('usageSource', e.target.value as EffPolicyDefaults['usageSource'])}>
            <option value="auto">auto</option><option value="prometheus">prometheus</option><option value="metrics">metrics</option>
          </select>
        </Field>
        <Field label="백분위(p)" help="관측 사용량의 상위 백분위(기본 95)"><Num value={form.percentile} min={50} onChange={(v) => set('percentile', v ?? 95)} /></Field>
        <Field label="관측 창(일)" help="p95 를 계산하는 기간"><Num value={form.windowDays} min={1} onChange={(v) => set('windowDays', v ?? 7)} /></Field>
        <Field label="여유율 headroom(%)" help="목표 = p95 × (1 + headroom)"><Num value={form.headroomPct} min={0} onChange={(v) => set('headroomPct', v ?? 30)} /></Field>
        <Field label="CPU 하한(m)" help="이 아래로는 추천하지 않음"><Num value={form.floorCpuM} min={1} onChange={(v) => set('floorCpuM', v ?? 50)} /></Field>
        <Field label="MEM 하한(Mi)"><Num value={Math.round(form.floorMemB / MI)} min={1} onChange={(v) => set('floorMemB', (v ?? 64) * MI)} /></Field>
        <Field label="임계 비율" help="현재 request > 목표 × 비율 일 때만 추천"><Num value={form.thresholdRatio} step={0.05} min={1} onChange={(v) => set('thresholdRatio', v ?? 1.25)} /></Field>
        <Field label="최소 절감 CPU(m, 파드당)"><Num value={form.minSavingsCpuM} min={0} onChange={(v) => set('minSavingsCpuM', v ?? 100)} /></Field>
        <Field label="최소 절감 MEM(Mi, 파드당)"><Num value={Math.round(form.minSavingsMemB / MI)} min={0} onChange={(v) => set('minSavingsMemB', (v ?? 128) * MI)} /></Field>
        <Field label="최소 샘플 수" help="DB 샘플 소스일 때(10분 주기 = 시간당 6)"><Num value={form.minSamples} min={0} onChange={(v) => set('minSamples', v ?? 12)} /></Field>
        <Field label="최소 관측 기간(시간)" help="DB 샘플 소스일 때"><Num value={form.minCoverageHours} min={0} onChange={(v) => set('minCoverageHours', v ?? 24)} /></Field>
        <Field label="쿨다운(분)" help="같은 NS 자동 적용 간 최소 간격"><Num value={form.cooldownMinutes} min={0} onChange={(v) => set('cooldownMinutes', v ?? 1440)} /></Field>
        <Field label="1회 최대 감소폭(%)" help="자동 적용 시 request 를 이 비율 이상 한 번에 내리지 않음"><Num value={form.maxStepPct} min={1} onChange={(v) => set('maxStepPct', v ?? 20)} /></Field>
        <Field label="run 당 최대 대상 수"><Num value={form.maxTargetsPerRun} min={1} onChange={(v) => set('maxTargetsPerRun', v ?? 20)} /></Field>
        <Field label="opt-out annotation 키" help='값이 off/false 면 NS·워크로드 제외'><input className={INPUT} value={form.optoutAnnotation} onChange={(e) => set('optoutAnnotation', e.target.value)} /></Field>
      </div>
      <Field label="시스템 네임스페이스(쉼표 구분, 항상 제외)">
        <textarea className={`${INPUT} min-h-14`} value={form.systemNamespaces.join(', ')}
          onChange={(e) => set('systemNamespaces', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
      </Field>
      <div className="flex flex-wrap gap-4">
        <Toggle checked={form.includeDaemonsets} onChange={(v) => set('includeDaemonsets', v)} label="DaemonSet 도 추천 대상에 포함" />
        <Toggle checked={form.keepGuaranteed} onChange={(v) => set('keepGuaranteed', v)} label="Guaranteed(req=lim) 유지 — limit 도 같이 내림" />
      </div>
      <div className="rounded-lg border border-border p-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">ResourceQuota 탄력 기본값</div>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
          <Field label="확장 임계(used/hard)"><Num value={form.quota.upThreshold} step={0.05} min={0.1} onChange={(v) => setQ('upThreshold', v ?? 0.85)} /></Field>
          <Field label="회수 임계(used/hard)"><Num value={form.quota.lowThreshold} step={0.05} min={0} onChange={(v) => setQ('lowThreshold', v ?? 0.5)} /></Field>
          <Field label="회수 지속(시간)" help="이 시간 내내 낮아야 회수"><Num value={form.quota.sustainHours} min={0} onChange={(v) => setQ('sustainHours', v ?? 24)} /></Field>
          <Field label="회수 후 배율" help="새 한도 = 최대 사용 × 배율"><Num value={form.quota.lowerFactor} step={0.1} min={1} onChange={(v) => setQ('lowerFactor', v ?? 1.3)} /></Field>
          <Field label="확장 폭(%)"><Num value={form.quota.stepPct} min={1} onChange={(v) => setQ('stepPct', v ?? 25)} /></Field>
          <Field label="쿨다운(분)"><Num value={form.quota.cooldownMinutes} min={0} onChange={(v) => setQ('cooldownMinutes', v ?? 60)} /></Field>
        </div>
      </div>
      <div className="flex justify-end">
        <RoleGate allow={['admin']} fallback={<span className="text-xs text-muted-foreground">전역 기본값 변경은 admin 만 가능합니다.</span>}>
          <button type="button" className={BTN_PRIMARY} onClick={() => void save()} disabled={saveDefaults.isPending}>저장</button>
        </RoleGate>
      </div>
    </div>
  );
}

// ── 네임스페이스 정책 탭 ────────────────────────────────────────────────────────
const EMPTY_TARGET: EffCustomTarget = { label: '', enabled: true, group: '', version: 'v1', plural: '', name: '', jsonpath: 'spec.replicas', min: 1, max: 10, current: null };

type NsForm = {
  autoRightsize: boolean; quotaElastic: boolean; quotaName: string;
  cpuMin: number | null; cpuMax: number | null; memMin: number | null; memMax: number | null;
  headroomPct: number | null; cooldownMinutes: number | null; maxStepPct: number | null;
  upThreshold: number | null; lowThreshold: number | null; sustainHours: number | null;
  targets: EffCustomTarget[];
};
const fromPolicy = (p: EffNamespacePolicy | null): NsForm => ({
  autoRightsize: p?.autoRightsize ?? false, quotaElastic: p?.quotaElastic ?? false, quotaName: p?.quotaName ?? '',
  cpuMin: p?.quotaCpuMinM == null ? null : p.quotaCpuMinM / 1000, cpuMax: p?.quotaCpuMaxM == null ? null : p.quotaCpuMaxM / 1000,
  memMin: p?.quotaMemMinB == null ? null : +(p.quotaMemMinB / GI).toFixed(2), memMax: p?.quotaMemMaxB == null ? null : +(p.quotaMemMaxB / GI).toFixed(2),
  headroomPct: (p?.rightsizeParams?.headroomPct as number | undefined) ?? null,
  cooldownMinutes: (p?.rightsizeParams?.cooldownMinutes as number | undefined) ?? null,
  maxStepPct: (p?.rightsizeParams?.maxStepPct as number | undefined) ?? null,
  upThreshold: p?.quotaParams?.upThreshold ?? null, lowThreshold: p?.quotaParams?.lowThreshold ?? null, sustainHours: p?.quotaParams?.sustainHours ?? null,
  targets: p?.customTargets ?? [],
});

function NamespaceTab({ clusterId, initialNamespace }: { clusterId: string; initialNamespace?: string }) {
  const summaryQ = useEffSummary(clusterId);
  const policiesQ = useEffPolicies(clusterId);
  const [loadQuotas, setLoadQuotas] = useState(false);
  const quotasQ = useEffQuotas(clusterId, loadQuotas);
  const { savePolicy, deletePolicy } = useEffMutations(clusterId);
  const toast = useToast();
  const namespaces = useMemo(() => {
    const s = new Set<string>((summaryQ.data?.items ?? []).map((i) => i.namespace));
    (policiesQ.data?.items ?? []).forEach((p) => s.add(p.namespace));
    return [...s].sort();
  }, [summaryQ.data, policiesQ.data]);
  const [ns, setNs] = useState(initialNamespace ?? '');
  useEffect(() => { if (!ns && namespaces.length) setNs(namespaces[0]); }, [ns, namespaces]);
  const existing = (policiesQ.data?.items ?? []).find((p) => p.namespace === ns) ?? null;

  const [form, setForm] = useState<NsForm>(() => fromPolicy(null));
  const [loadedFor, setLoadedFor] = useState<string>('');
  useEffect(() => {
    const key = `${ns}:${existing?.updatedAt ?? 'none'}`;
    if (ns && loadedFor !== key) { setForm(fromPolicy(existing)); setLoadedFor(key); }
  }, [ns, existing, loadedFor]);
  const set = <K extends keyof NsForm>(k: K, v: NsForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setTarget = (i: number, patch: Partial<EffCustomTarget>) =>
    setForm((f) => ({ ...f, targets: f.targets.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));

  const liveQuota = (quotasQ.data?.items ?? []).find((q) => q.namespace === ns);
  const prefillQuota = () => {
    if (!liveQuota) { toast.warning('이 NS 에 ResourceQuota 가 없습니다', undefined); return; }
    setForm((f) => ({
      ...f, quotaName: liveQuota.name,
      cpuMin: f.cpuMin ?? (liveQuota.hardCpuM == null ? null : +(liveQuota.hardCpuM / 1000 / 2).toFixed(2)),
      cpuMax: f.cpuMax ?? (liveQuota.hardCpuM == null ? null : +(liveQuota.hardCpuM / 1000 * 2).toFixed(2)),
      memMin: f.memMin ?? (liveQuota.hardMemB == null ? null : +(liveQuota.hardMemB / GI / 2).toFixed(2)),
      memMax: f.memMax ?? (liveQuota.hardMemB == null ? null : +(liveQuota.hardMemB / GI * 2).toFixed(2)),
    }));
  };

  const save = async () => {
    if (!ns) return;
    const rs: Record<string, number | boolean | null> = {};
    if (form.headroomPct != null) rs.headroomPct = form.headroomPct;
    if (form.cooldownMinutes != null) rs.cooldownMinutes = form.cooldownMinutes;
    if (form.maxStepPct != null) rs.maxStepPct = form.maxStepPct;
    const qp: Record<string, number | null> = {};
    if (form.upThreshold != null) qp.upThreshold = form.upThreshold;
    if (form.lowThreshold != null) qp.lowThreshold = form.lowThreshold;
    if (form.sustainHours != null) qp.sustainHours = form.sustainHours;
    try {
      await savePolicy.mutateAsync({ namespace: ns, body: {
        autoRightsize: form.autoRightsize, quotaElastic: form.quotaElastic, quotaName: form.quotaName || null,
        quotaCpuMinM: form.cpuMin == null ? null : Math.round(form.cpuMin * 1000), quotaCpuMaxM: form.cpuMax == null ? null : Math.round(form.cpuMax * 1000),
        quotaMemMinB: form.memMin == null ? null : Math.round(form.memMin * GI), quotaMemMaxB: form.memMax == null ? null : Math.round(form.memMax * GI),
        rightsizeParams: Object.keys(rs).length ? rs : null, quotaParams: Object.keys(qp).length ? qp : null,
        customTargets: form.targets.filter((t) => t.group && t.plural && t.name),
      } });
      toast.success(`${ns} 정책 저장됨`, undefined);
    } catch (e) { toast.error('저장 실패', effErrMsg(e)); }
  };
  const remove = async () => {
    if (!existing) return;
    try { await deletePolicy.mutateAsync(ns); toast.success(`${ns} 정책 삭제됨`, undefined); }
    catch (e) { toast.error('삭제 실패', effErrMsg(e)); }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-3">
      <div className="space-y-1">
        <Field label="네임스페이스">
          <select className={INPUT} value={ns} onChange={(e) => setNs(e.target.value)}>
            {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <div className="text-[11px] text-muted-foreground">정책 있는 NS</div>
        <ul className="text-xs max-h-64 overflow-auto rounded-lg border border-border divide-y divide-border">
          {(policiesQ.data?.items ?? []).map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => setNs(p.namespace)}
                className={`w-full text-left px-2 py-1 hover:bg-muted/10 ${p.namespace === ns ? 'bg-primary/5' : ''}`}>
                <span className="truncate block">{p.namespace}</span>
                <span className="text-[10px] text-muted-foreground">
                  {p.autoRightsize ? 'auto-rightsize ' : ''}{p.quotaElastic ? 'quota ' : ''}{p.customTargets.length ? `CR×${p.customTargets.length}` : ''}
                </span>
              </button>
            </li>
          ))}
          {!(policiesQ.data?.items ?? []).length && <li className="px-2 py-2 text-muted-foreground">없음(전부 추천만)</li>}
        </ul>
      </div>
      <div className="space-y-3">
        {!ns ? <Skeleton className="h-32 w-full" /> : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <Toggle checked={form.autoRightsize} onChange={(v) => set('autoRightsize', v)} label="자동 right-size(opt-in)"
                help="수집 사이클마다 open 추천을 쿨다운·최대 감소폭 안에서 자동 적용. 전역 마스터 스위치가 켜져 있어야 동작." />
              <Toggle checked={form.quotaElastic} onChange={(v) => set('quotaElastic', v)} label="ResourceQuota 탄력(opt-in)"
                help="used/hard 가 임계 이상이면 한도 확장, 지속적으로 낮으면 회수(min/max 안에서)." />
            </div>
            <div className="rounded-lg border border-border p-2 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">ResourceQuota</span>
                <button type="button" className={BTN} onClick={() => { setLoadQuotas(true); if (quotasQ.data) prefillQuota(); }}
                  disabled={quotasQ.isFetching} title="클러스터에서 현재 Quota 를 읽어 기본값 채우기">
                  <Download className="w-3.5 h-3.5" /> 라이브 Quota 불러오기
                </button>
                {liveQuota && <span className="text-[11px] text-muted-foreground">현재 {liveQuota.name}: CPU {liveQuota.hardCpuM == null ? '-' : `${liveQuota.hardCpuM / 1000}코어`} · MEM {liveQuota.hardMemB == null ? '-' : `${(liveQuota.hardMemB / GI).toFixed(1)}Gi`}</span>}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                <Field label="Quota 이름"><input className={INPUT} value={form.quotaName} onChange={(e) => set('quotaName', e.target.value)} placeholder="자동 감지" /></Field>
                <Field label="CPU 최소(코어)"><Num value={form.cpuMin} step={0.5} min={0} onChange={(v) => set('cpuMin', v)} /></Field>
                <Field label="CPU 최대(코어)"><Num value={form.cpuMax} step={0.5} min={0} onChange={(v) => set('cpuMax', v)} /></Field>
                <Field label="MEM 최소(Gi)"><Num value={form.memMin} step={0.5} min={0} onChange={(v) => set('memMin', v)} /></Field>
                <Field label="MEM 최대(Gi)"><Num value={form.memMax} step={0.5} min={0} onChange={(v) => set('memMax', v)} /></Field>
                <Field label="확장 임계(오버라이드)"><Num value={form.upThreshold} step={0.05} min={0.1} onChange={(v) => set('upThreshold', v)} placeholder="전역" /></Field>
                <Field label="회수 임계(오버라이드)"><Num value={form.lowThreshold} step={0.05} min={0} onChange={(v) => set('lowThreshold', v)} placeholder="전역" /></Field>
                <Field label="회수 지속 시간(오버라이드)"><Num value={form.sustainHours} min={0} onChange={(v) => set('sustainHours', v)} placeholder="전역" /></Field>
              </div>
            </div>
            <div className="rounded-lg border border-border p-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">right-size 오버라이드(비우면 전역)</div>
              <div className="grid grid-cols-3 gap-2">
                <Field label="headroom(%)"><Num value={form.headroomPct} min={0} onChange={(v) => set('headroomPct', v)} placeholder="전역" /></Field>
                <Field label="쿨다운(분)"><Num value={form.cooldownMinutes} min={0} onChange={(v) => set('cooldownMinutes', v)} placeholder="전역" /></Field>
                <Field label="1회 최대 감소폭(%)"><Num value={form.maxStepPct} min={1} onChange={(v) => set('maxStepPct', v)} placeholder="전역" /></Field>
              </div>
            </div>
            <div className="rounded-lg border border-border p-2 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">오퍼레이터 CR 어댑터</span>
                <span className="text-[11px] text-muted-foreground">예: StarRocks CN — starrocks.com / v1 / starrocksclusters / spec.starRocksCnSpec.replicas</span>
                <button type="button" className={`${BTN} ml-auto`} onClick={() => set('targets', [...form.targets, { ...EMPTY_TARGET }])}>
                  <Plus className="w-3.5 h-3.5" /> 추가
                </button>
              </div>
              {form.targets.map((t, i) => (
                <div key={i} className="grid grid-cols-2 md:grid-cols-9 gap-1.5 items-end rounded-lg border border-border/60 p-1.5">
                  <Field label="라벨"><input className={INPUT} value={t.label ?? ''} onChange={(e) => setTarget(i, { label: e.target.value })} /></Field>
                  <Field label="group"><input className={INPUT} value={t.group} onChange={(e) => setTarget(i, { group: e.target.value })} placeholder="starrocks.com" /></Field>
                  <Field label="version"><input className={INPUT} value={t.version} onChange={(e) => setTarget(i, { version: e.target.value })} /></Field>
                  <Field label="plural"><input className={INPUT} value={t.plural} onChange={(e) => setTarget(i, { plural: e.target.value })} placeholder="starrocksclusters" /></Field>
                  <Field label="name"><input className={INPUT} value={t.name} onChange={(e) => setTarget(i, { name: e.target.value })} /></Field>
                  <Field label="jsonpath"><input className={INPUT} value={t.jsonpath} onChange={(e) => setTarget(i, { jsonpath: e.target.value })} /></Field>
                  <Field label="min"><Num value={t.min} min={0} onChange={(v) => setTarget(i, { min: v ?? 0 })} /></Field>
                  <Field label="max"><Num value={t.max} min={0} onChange={(v) => setTarget(i, { max: v ?? 0 })} /></Field>
                  <div className="flex items-center gap-1">
                    <Toggle checked={t.enabled ?? true} onChange={(v) => setTarget(i, { enabled: v })} label="자동" />
                    <button type="button" onClick={() => set('targets', form.targets.filter((_, j) => j !== i))} title="삭제" aria-label="어댑터 삭제"
                      className="p-1 rounded-md text-muted-foreground hover:bg-secondary hover:text-status-critical"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
              ))}
              {!form.targets.length && <div className="text-[11px] text-muted-foreground">없음 — 워크로드의 owner 가 CR 이면(예: StarRocksCluster) request 는 추천만 하고, 확장/회수는 이 어댑터로 CR 필드를 조정합니다.</div>}
            </div>
            <div className="flex justify-end gap-2">
              <RoleGate allow={['admin', 'operator']} fallback={<span className="text-xs text-muted-foreground">정책 변경은 operator 이상만 가능합니다.</span>}>
                {existing && <button type="button" className={`${BTN} text-status-critical`} onClick={() => void remove()} disabled={deletePolicy.isPending}>정책 삭제</button>}
                <button type="button" className={BTN_PRIMARY} onClick={() => void save()} disabled={savePolicy.isPending}>저장</button>
              </RoleGate>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── 수집 스케줄 탭 ──────────────────────────────────────────────────────────────
function ScheduleTab({ clusterId }: { clusterId: string }) {
  const q = useEffSchedule();
  const { saveSchedule } = useEffMutations('');
  const toast = useToast();
  const [enabled, setEnabled] = useState(true);
  const [cron, setCron] = useState('*/10 * * * *');
  const [cEnabled, setCEnabled] = useState(true);
  const [cCron, setCCron] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (q.data && !loaded) {
      setEnabled(q.data.enabled); setCron(q.data.defaultCron);
      const c = q.data.clusters[clusterId];
      setCEnabled(c?.enabled ?? true); setCCron(c?.cron ?? '');
      setLoaded(true);
    }
  }, [q.data, loaded, clusterId]);
  const save = async () => {
    try {
      const clusters: Record<string, { enabled: boolean; cron: string | null }> = {};
      for (const [cid, c] of Object.entries(q.data?.clusters ?? {})) clusters[cid] = { enabled: c.enabled, cron: c.cron };
      clusters[clusterId] = { enabled: cEnabled, cron: cCron.trim() || null };
      await saveSchedule.mutateAsync({ enabled, defaultCron: cron.trim(), clusters });
      toast.success('수집 스케줄 저장됨', undefined);
    } catch (e) { toast.error('저장 실패', effErrMsg(e)); }
  };
  if (!q.data) return <Skeleton className="h-24 w-full" />;
  const mine = q.data.clusters[clusterId];
  return (
    <div className="space-y-3">
      <Toggle checked={enabled} onChange={setEnabled} label="주기 수집 사용(전체)" help="끄면 모든 클러스터의 자동 수집이 멈춥니다(수동 '지금 수집'은 가능)." />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <Field label="기본 cron" help={`다음 실행: ${q.data.nextRun ?? '-'} (Celery beat 가 매분 평가)`}>
          <input className={INPUT} value={cron} onChange={(e) => setCron(e.target.value)} />
        </Field>
        <Field label="이 클러스터 cron 오버라이드(비우면 기본)" help={`이 클러스터 다음 실행: ${mine?.nextRun ?? q.data.nextRun ?? '-'} · 마지막 수집: ${mine?.lastRunAt ?? '-'}`}>
          <input className={INPUT} value={cCron} onChange={(e) => setCCron(e.target.value)} placeholder={cron} />
        </Field>
      </div>
      <Toggle checked={cEnabled} onChange={setCEnabled} label="이 클러스터 수집 사용" />
      <div className="flex justify-end">
        <RoleGate allow={['admin']} fallback={<span className="text-xs text-muted-foreground">스케줄 변경은 admin 만 가능합니다.</span>}>
          <button type="button" className={BTN_PRIMARY} onClick={() => void save()} disabled={saveSchedule.isPending}>저장</button>
        </RoleGate>
      </div>
    </div>
  );
}

export function PolicyDialog({ clusterId, open, onClose, initialTab = 'namespace', initialNamespace }: {
  clusterId: string; open: boolean; onClose: () => void; initialTab?: Tab; initialNamespace?: string;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => { if (open) setTab(initialTab); }, [open, initialTab]);
  const ref = useModalA11y(open, onClose, { historyClose: true });
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4" data-export-ignore>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="자원 효율화 정책 설정"
        className="w-full max-w-5xl max-h-[90vh] overflow-auto rounded-xl border border-border bg-card shadow-xl">
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border sticky top-0 bg-card z-10">
          <span className="font-semibold">자원 효율화 정책</span>
          <div className="inline-flex rounded-xl border border-border bg-muted/20 p-0.5 ml-2">
            {([['namespace', '네임스페이스 정책'], ['defaults', '전역 기본값'], ['schedule', '수집 스케줄']] as [Tab, string][]).map(([k, l]) => (
              <button key={k} type="button" onClick={() => setTab(k)}
                className={`px-2.5 py-1 rounded-lg text-xs ${tab === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}>{l}</button>
            ))}
          </div>
          <button type="button" onClick={onClose} title="닫기" aria-label="닫기" className="ml-auto p-1 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4">
          {tab === 'defaults' && <DefaultsTab />}
          {tab === 'namespace' && <NamespaceTab clusterId={clusterId} initialNamespace={initialNamespace} />}
          {tab === 'schedule' && <ScheduleTab clusterId={clusterId} />}
        </div>
      </div>
    </div>
  );
}
