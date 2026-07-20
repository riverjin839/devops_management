import { useState } from 'react';
import { RefreshCw, Camera, Settings2, Plus, Trash2, ArrowUp, ArrowDown, Minus, Check, Clock } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AxiosError } from 'axios';
import { MacCard } from '@/components/ui/MacCard';
import { RoleGate } from '@/components/auth/RoleGate';
import { metricTrendApi } from '@/services/api';
import type { MetricTrendRow, MetricChecklistItemT } from '@/types';
import { parseUTC } from '@/lib/utils';

function errMsg(e: unknown): string {
  const ax = e as AxiosError<{ detail?: string }>;
  return ax?.response?.data?.detail || (e as Error)?.message || '오류';
}

const num = (v: number | null) => (v == null ? '-' : String(v));

function TrendCell({ row }: { row: MetricTrendRow }) {
  if (row.delta == null) return <span className="text-muted-foreground">-</span>;
  const Icon = row.trend === 'up' ? ArrowUp : row.trend === 'down' ? ArrowDown : Minus;
  const cls = row.trend === 'up' ? 'text-amber-600' : row.trend === 'down' ? 'text-sky-600' : 'text-muted-foreground';
  const sign = row.delta > 0 ? `+${row.delta}` : String(row.delta);
  return (
    <span className={`inline-flex items-center gap-0.5 ${cls}`}>
      <Icon className="w-3.5 h-3.5" />{row.delta === 0 ? '변화없음' : sign}
    </span>
  );
}

/** 일일점검 리뷰 — 리소스 수 추세 체크리스트 (오늘/어제/7일/2주/4주 + 추세 + 체크). */
export function ResourceTrendChecklist({ clusterId }: { clusterId: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showItems, setShowItems] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['metric-trend', clusterId],
    queryFn: async () => (await metricTrendApi.get(clusterId)).data,
    enabled: !!clusterId,
  });

  const flash = (ok: boolean, text: string) => { setMsg({ ok, text }); window.setTimeout(() => setMsg(null), 4000); };
  const reload = () => qc.invalidateQueries({ queryKey: ['metric-trend', clusterId] });

  const doSnapshot = async () => {
    setBusy(true);
    try {
      await metricTrendApi.snapshot(clusterId);
      flash(true, '백그라운드 수집을 시작했습니다 — 대규모 클러스터는 수십 초 걸릴 수 있고 완료되면 자동 갱신됩니다.');
      // 비동기(Celery) 수집 — 완료 시점을 알 수 없어 몇 차례 자동 새로고침으로 폴링.
      [8000, 20000, 40000, 70000].forEach((d) => window.setTimeout(reload, d));
    } catch (e) { flash(false, errMsg(e)); }
    finally { setBusy(false); }
  };
  const toggleCheck = async (row: MetricTrendRow) => {
    try { await metricTrendApi.check(clusterId, row.itemKey, !row.isChecked, data?.date); reload(); }
    catch (e) { flash(false, errMsg(e)); }
  };
  const editToday = async (row: MetricTrendRow) => {
    if (!data?.latestSnapshotId) { flash(false, '먼저 스냅샷을 수집하세요.'); return; }
    const input = window.prompt(`${row.label} 오늘 값 보정`, String(row.today ?? 0));
    if (input == null) return;
    const n = Number(input);
    if (!Number.isInteger(n) || n < 0) { flash(false, '0 이상의 정수'); return; }
    try { await metricTrendApi.editSnapshot(data.latestSnapshotId, { [row.resourceKind]: n }); flash(true, '보정 완료'); reload(); }
    catch (e) { flash(false, errMsg(e)); }
  };

  const COLS = 'grid-cols-[1.4fr_70px_70px_70px_70px_70px_110px_56px]';

  return (
    <MacCard title="리소스 수 추세 체크리스트" bodyPadding="p-0">
      <div className="flex items-center gap-2 flex-wrap px-3 py-2.5 border-b border-border">
        <span className="text-sm text-muted-foreground">
          {data?.latestCollectedAt ? `최근 수집: ${parseUTC(data.latestCollectedAt).toLocaleString('ko-KR')}` : '수집된 스냅샷 없음'}
        </span>
        <RoleGate allow={['admin', 'operator']}>
          <button onClick={doSnapshot} disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium disabled:opacity-50">
            <Camera className="w-3.5 h-3.5" /> {busy ? '수집 중…' : '지금 스냅샷'}
          </button>
        </RoleGate>
        <RoleGate allow={['admin']}>
          <button onClick={() => setShowItems(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-secondary/60">
            <Settings2 className="w-3.5 h-3.5" /> 항목 관리
          </button>
          <button onClick={() => setShowSchedule(true)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-secondary/60">
            <Clock className="w-3.5 h-3.5" /> 주기 설정
          </button>
        </RoleGate>
        <button onClick={() => refetch()} title="새로고침" aria-label="새로고침" className="ml-auto p-1.5 rounded-lg hover:bg-secondary text-muted-foreground">
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {msg && (
        <div className={`px-4 py-2 text-sm ${msg.ok ? 'text-status-healthy bg-status-healthy-soft' : 'text-status-critical bg-status-critical-soft'}`}>{msg.text}</div>
      )}

      <div className={`grid ${COLS} gap-2 px-4 py-1.5 text-xs font-semibold text-muted-foreground border-b border-border bg-secondary/30`}>
        <span>항목</span><span className="text-right">오늘</span><span className="text-right">어제</span>
        <span className="text-right">7일전</span><span className="text-right">2주전</span><span className="text-right">4주전</span>
        <span>추세(어제 대비)</span><span className="text-center">체크</span>
      </div>

      {isLoading ? (
        <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>
      ) : isError ? (
        <div className="p-6 text-sm text-status-critical">조회 실패: {errMsg(error)}</div>
      ) : (data?.items.length ?? 0) === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">추적 항목이 없습니다. "항목 관리"에서 추가하세요.</div>
      ) : (
        data!.items.map((r) => (
          <div key={r.itemKey} className={`grid ${COLS} gap-2 px-4 py-1.5 text-sm border-b border-border/40 items-center`}>
            <span className="font-medium truncate">{r.label}{r.truncated ? ' *' : ''}</span>
            <RoleGate allow={['admin']} fallback={<span className="text-right tabular-nums font-semibold">{num(r.today)}</span>}>
              <button onClick={() => editToday(r)} title="값 보정(admin)" className="text-right tabular-nums font-semibold hover:text-primary">{num(r.today)}</button>
            </RoleGate>
            <span className="text-right tabular-nums text-muted-foreground">{num(r.yesterday)}</span>
            <span className="text-right tabular-nums text-muted-foreground">{num(r.d7)}</span>
            <span className="text-right tabular-nums text-muted-foreground">{num(r.d14)}</span>
            <span className="text-right tabular-nums text-muted-foreground">{num(r.d28)}</span>
            <span className="text-sm"><TrendCell row={r} /></span>
            <span className="flex justify-center">
              <RoleGate allow={['admin', 'operator']} fallback={r.isChecked ? <Check className="w-4 h-4 text-status-healthy" /> : <span className="text-muted-foreground">-</span>}>
                <input type="checkbox" checked={r.isChecked} onChange={() => toggleCheck(r)} title={r.checkedBy ? `${r.checkedBy} · ${r.checkedAt ? parseUTC(r.checkedAt).toLocaleString('ko-KR') : ''}` : ''}
                  className="w-4 h-4 accent-primary cursor-pointer" />
              </RoleGate>
            </span>
          </div>
        ))
      )}
      <div className="px-4 py-1.5 text-xs text-muted-foreground border-t border-border">
        오늘/어제/7일·2주·4주전 스냅샷 비교 · 매일 08:00 자동 수집 + 수동 · * 는 집계 상한 초과(근사) · admin 은 오늘 값 클릭 보정
      </div>

      {showItems && <ItemsModal clusterId={clusterId} onClose={() => { setShowItems(false); reload(); }} />}
      {showSchedule && <ScheduleModal onClose={() => setShowSchedule(false)} />}
    </MacCard>
  );
}

// ── 동작 주기 설정 모달 (admin) ──────────────────────────────────────────────
function ScheduleModal({ onClose }: { onClose: () => void }) {
  const [enabled, setEnabled] = useState(true);
  const [mode, setMode] = useState<'daily' | 'interval' | 'cron'>('daily');
  const [time, setTime] = useState('08:00');
  const [everyH, setEveryH] = useState(6);
  const [cron, setCron] = useState('0 8 * * *');
  const [nextRun, setNextRun] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);

  useQuery({
    queryKey: ['metric-schedule'],
    queryFn: async () => {
      const d = (await metricTrendApi.getSchedule()).data;
      setEnabled(d.enabled); setCron(d.cron); setNextRun(d.nextRun);
      return d;
    },
  });

  const buildCron = (): string => {
    if (mode === 'daily') { const [h, m] = time.split(':'); return `${Number(m)} ${Number(h)} * * *`; }
    if (mode === 'interval') return `0 */${Math.max(1, Math.min(23, everyH))} * * *`;
    return cron.trim();
  };

  const save = async () => {
    setErr(''); setSaved(false);
    const c = buildCron();
    try {
      const r = (await metricTrendApi.setSchedule(enabled, c)).data;
      setCron(c); setNextRun(r.nextRun); setSaved(true);
    } catch (e) { setErr(errMsg(e)); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card w-full max-w-md rounded-2xl border border-border overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border font-semibold text-sm">자동 스냅샷 동작 주기</div>
        <div className="p-4 space-y-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-4 h-4 accent-primary" />
            자동 수집 사용
          </label>
          <div className="flex gap-1 rounded-xl border border-border overflow-hidden w-fit">
            {(['daily', 'interval', 'cron'] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)}
                className={`px-3 py-1.5 text-sm ${mode === m ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-secondary/60'}`}>
                {m === 'daily' ? '매일 시각' : m === 'interval' ? 'N시간마다' : 'cron 직접'}
              </button>
            ))}
          </div>
          {mode === 'daily' && (
            <label className="block">매일 <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="ml-2 rounded-lg border border-border bg-background px-2 py-1" /></label>
          )}
          {mode === 'interval' && (
            <label className="block">매 <input type="number" min={1} max={23} value={everyH} onChange={(e) => setEveryH(Number(e.target.value))} className="mx-2 w-16 rounded-lg border border-border bg-background px-2 py-1" /> 시간마다</label>
          )}
          {mode === 'cron' && (
            <label className="block">cron <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 8 * * *" className="ml-2 w-48 rounded-lg border border-border bg-background px-2 py-1 font-mono" /></label>
          )}
          <div className="text-xs text-muted-foreground">생성 cron: <span className="font-mono">{buildCron()}</span>{nextRun && <> · 다음 실행: {parseUTC(nextRun).toLocaleString()}</>}</div>
          {err && <div className="text-sm text-red-500">{err}</div>}
          {saved && <div className="text-sm text-green-600">저장됨</div>}
        </div>
        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl border border-border px-3 py-1.5 text-sm hover:bg-secondary">닫기</button>
          <button onClick={save} className="rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-sm">저장</button>
        </div>
      </div>
    </div>
  );
}

// ── 항목 관리 모달 (admin) ──────────────────────────────────────────────────
const KIND_OPTIONS = [
  'pods', 'deployments', 'daemonsets', 'statefulsets', 'replicasets', 'replicationcontrollers',
  'services', 'endpoints', 'ingresses', 'configmaps', 'secrets', 'persistentvolumeclaims',
  'persistentvolumes', 'jobs', 'cronjobs', 'nodes', 'namespaces', 'serviceaccounts',
  'networkpolicies', 'storageclasses',
];

function ItemsModal({ clusterId, onClose }: { clusterId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { data, refetch } = useQuery({
    queryKey: ['metric-items', clusterId],
    queryFn: async () => (await metricTrendApi.listItems(clusterId)).data,
  });
  const [form, setForm] = useState({ itemKey: '', label: '', resourceKind: 'pods' });
  const [err, setErr] = useState('');

  const reload = () => { refetch(); qc.invalidateQueries({ queryKey: ['metric-trend', clusterId] }); };
  const add = async () => {
    setErr('');
    if (!form.itemKey.trim() || !form.label.trim()) { setErr('item_key 와 label 은 필수'); return; }
    try {
      await metricTrendApi.createItem({ ...form, clusterId, enabled: true, sortOrder: (data?.items.length ?? 0) * 10 } as Partial<MetricChecklistItemT>);
      setForm({ itemKey: '', label: '', resourceKind: 'pods' });
      reload();
    } catch (e) { setErr(errMsg(e)); }
  };
  const remove = async (it: MetricChecklistItemT) => {
    if (!window.confirm(`${it.label} 항목을 삭제하시겠습니까?`)) return;
    try { await metricTrendApi.deleteItem(it.id); reload(); } catch (e) { setErr(errMsg(e)); }
  };
  const toggle = async (it: MetricChecklistItemT) => {
    try { await metricTrendApi.updateItem(it.id, { ...it, enabled: !it.enabled }); reload(); } catch (e) { setErr(errMsg(e)); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card w-full max-w-2xl max-h-[80vh] rounded-2xl border border-border flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-border font-semibold text-sm">추적 항목 관리</div>
        <div className="p-4 space-y-3 overflow-auto">
          {err && <div className="text-sm text-red-500">{err}</div>}
          <div className="flex items-end gap-2 flex-wrap">
            <label className="text-xs text-muted-foreground">키<input value={form.itemKey} onChange={(e) => setForm({ ...form, itemKey: e.target.value })} placeholder="예: pods" className="block rounded-lg border border-border bg-background px-2 py-1 text-sm w-28" /></label>
            <label className="text-xs text-muted-foreground">라벨<input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="예: Pods" className="block rounded-lg border border-border bg-background px-2 py-1 text-sm w-32" /></label>
            <label className="text-xs text-muted-foreground">종류
              <select value={form.resourceKind} onChange={(e) => setForm({ ...form, resourceKind: e.target.value })} className="block rounded-lg border border-border bg-background px-2 py-1 text-sm">
                {KIND_OPTIONS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <button onClick={add} className="inline-flex items-center gap-1 rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-sm"><Plus className="w-3.5 h-3.5" />추가</button>
          </div>
          <div className="rounded-xl border border-border divide-y divide-border/50">
            {(data?.items ?? []).map((it) => (
              <div key={it.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <input type="checkbox" checked={it.enabled} onChange={() => toggle(it)} className="w-4 h-4 accent-primary" />
                <span className="font-medium">{it.label}</span>
                <span className="text-muted-foreground">· {it.resourceKind}</span>
                <span className="text-xs text-muted-foreground">{it.clusterId ? '(클러스터)' : '(전역)'}</span>
                <button onClick={() => remove(it)} title="항목 삭제" aria-label={`${it.label} 항목 삭제`} className="ml-auto p-1 rounded text-status-critical hover:bg-status-critical-soft"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
        </div>
        <div className="px-5 py-3 border-t border-border text-right">
          <button onClick={onClose} className="rounded-xl border border-border px-3 py-1.5 text-sm hover:bg-secondary">닫기</button>
        </div>
      </div>
    </div>
  );
}
