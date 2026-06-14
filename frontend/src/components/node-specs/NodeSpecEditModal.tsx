import { useEffect, useState } from 'react';
import { X, Save, Loader2 } from 'lucide-react';
import type { Cluster, NodeServerSpec, NodeServerSpecCreate, NodeSpecStatus } from '@/types';
import { nodeSpecsApi } from '@/services/api';

interface Props {
  mode: 'create' | 'edit';
  spec: NodeServerSpec | null;
  defaultClusterId: string | null;
  clusters: Cluster[];
  onClose: () => void;
  onSaved: () => void;
}

const STATUSES: { value: NodeSpecStatus; label: string }[] = [
  { value: 'active', label: '운영중' },
  { value: 'spare', label: '예비' },
  { value: 'maintenance', label: '점검' },
  { value: 'decommission', label: '폐기' },
];

const ROLES = ['control-plane', 'worker', 'etcd', 'storage', 'ingress', 'spare'];
const DISK_TYPES = ['NVMe', 'SSD', 'HDD', 'Hybrid'];

type Form = Partial<NodeServerSpecCreate>;

function emptyForm(defaultClusterId: string | null): Form {
  return {
    clusterId: defaultClusterId ?? null,
    hostname: '',
    status: 'active',
  };
}

export function NodeSpecEditModal({ mode, spec, defaultClusterId, clusters, onClose, onSaved }: Props) {
  const [form, setForm] = useState<Form>(() =>
    spec ? { ...spec } : emptyForm(defaultClusterId),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (spec) setForm({ ...spec });
    else setForm(emptyForm(defaultClusterId));
    setError(null);
  }, [spec, defaultClusterId, mode]);

  const update = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  // string 필드 변환 — 빈 문자열은 null 로
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const raw = e.target.value;
    update(k, (raw === '' ? null : raw) as Form[typeof k]);
  };
  // number 필드 — 빈 문자열은 null
  const setNum = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    update(k, (raw === '' ? null : Number(raw)) as Form[typeof k]);
  };

  const submit = async () => {
    if (!form.hostname?.trim()) {
      setError('hostname 은 필수입니다.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // 빈 문자열을 null 로 노멀라이즈
      const payload: Form = { ...form };
      Object.keys(payload).forEach((k) => {
        const v = (payload as Record<string, unknown>)[k];
        if (v === '') (payload as Record<string, unknown>)[k] = null;
      });

      if (mode === 'create') {
        await nodeSpecsApi.create(payload as NodeServerSpecCreate);
      } else if (spec) {
        await nodeSpecsApi.update(spec.id, payload);
      }
      onSaved();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } }; message?: string };
      setError(err.response?.data?.detail ?? err.message ?? '저장 실패');
    } finally {
      setSaving(false);
    }
  };

  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <div>
      <label className="block text-xs text-muted-foreground mb-1">{label}</label>
      {children}
    </div>
  );

  const inputCls = 'w-full px-2 py-1 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary';
  const monoCls = `${inputCls} font-mono`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={() => !saving && onClose()} />
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-5xl mx-4 max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border bg-muted/30">
          <h2 className="text-sm font-semibold">
            {mode === 'create' ? '서버스펙 신규 등록' : `서버스펙 수정 — ${spec?.hostname}`}
          </h2>
          <button onClick={onClose} disabled={saving}
            className="ml-auto p-1 rounded hover:bg-secondary text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* 기본 */}
          <section>
            <h3 className="text-sm font-bold text-muted-foreground uppercase mb-2">기본 정보</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Field label="hostname *">
                <input value={form.hostname ?? ''} onChange={set('hostname')} className={monoCls} />
              </Field>
              <Field label="k8s node name">
                <input value={form.nodeName ?? ''} onChange={set('nodeName')} className={monoCls} />
              </Field>
              <Field label="클러스터">
                <select value={form.clusterId ?? ''} onChange={(e) => update('clusterId', e.target.value || null)} className={inputCls}>
                  <option value="">미배정 (spare)</option>
                  {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
              <Field label="역할">
                <select value={form.role ?? ''} onChange={set('role')} className={inputCls}>
                  <option value="">선택</option>
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </Field>
              <Field label="상태">
                <select value={form.status ?? 'active'} onChange={set('status')} className={inputCls}>
                  {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </Field>
            </div>
          </section>

          {/* 네트워크 */}
          <section>
            <h3 className="text-sm font-bold text-muted-foreground uppercase mb-2">네트워크</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Field label="public IP (bond0)">
                <input value={form.bond0Ip ?? ''} onChange={set('bond0Ip')} className={monoCls}
                  placeholder="ip addr 의 bond0 IP" />
              </Field>
              <Field label="bond0 MAC">
                <input value={form.bond0Mac ?? ''} onChange={set('bond0Mac')} className={monoCls} placeholder="00:11:22:..." />
              </Field>
              <Field label="bond0 속도">
                <input value={form.bond0Speed ?? ''} onChange={set('bond0Speed')} className={monoCls} placeholder="25G" />
              </Field>
              <div />
              <Field label="private IP (bond1)">
                <input value={form.bond1Ip ?? ''} onChange={set('bond1Ip')} className={monoCls}
                  placeholder="ip addr 의 bond1 IP" />
              </Field>
              <Field label="bond1 MAC">
                <input value={form.bond1Mac ?? ''} onChange={set('bond1Mac')} className={monoCls} />
              </Field>
              <Field label="bond1 속도">
                <input value={form.bond1Speed ?? ''} onChange={set('bond1Speed')} className={monoCls} placeholder="25G" />
              </Field>
            </div>
          </section>

          {/* 하드웨어 */}
          <section>
            <h3 className="text-sm font-bold text-muted-foreground uppercase mb-2">하드웨어</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="md:col-span-2">
                <Field label="CPU 모델">
                  <input value={form.cpuModel ?? ''} onChange={set('cpuModel')} className={inputCls} placeholder="Intel Xeon Gold 6338" />
                </Field>
              </div>
              <Field label="CPU 소켓">
                <input type="number" value={form.cpuSockets ?? ''} onChange={setNum('cpuSockets')} className={inputCls} min={0} max={16} />
              </Field>
              <Field label="CPU 코어">
                <input type="number" value={form.cpuCores ?? ''} onChange={setNum('cpuCores')} className={inputCls} min={0} max={2048} />
              </Field>
              <Field label="CPU 스레드 (HT)">
                <input type="number" value={form.cpuThreads ?? ''} onChange={setNum('cpuThreads')} className={inputCls} min={0} max={4096} />
              </Field>
              <Field label="메모리 (GB)">
                <input type="number" value={form.memoryGb ?? ''} onChange={setNum('memoryGb')} className={inputCls} min={0} />
              </Field>
              <div className="md:col-span-2">
                <Field label="메모리 모듈 구성">
                  <input value={form.memoryModules ?? ''} onChange={set('memoryModules')} className={inputCls} placeholder="16x64GB DDR4-3200" />
                </Field>
              </div>

              <Field label="디스크 총 용량 (GB)">
                <input type="number" value={form.diskTotalGb ?? ''} onChange={setNum('diskTotalGb')} className={inputCls} min={0} />
              </Field>
              <Field label="OS 제외 디스크 (GB)">
                <input type="number" value={form.nonOsDiskGb ?? ''} onChange={setNum('nonOsDiskGb')} className={inputCls} min={0}
                  placeholder="OS 디스크 제외 합계" />
              </Field>
              <Field label="디스크 종류">
                <select value={form.diskType ?? ''} onChange={set('diskType')} className={inputCls}>
                  <option value="">-</option>
                  {DISK_TYPES.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </Field>
              <Field label="디스크 개수">
                <input type="number" value={form.diskCount ?? ''} onChange={setNum('diskCount')} className={inputCls} min={0} />
              </Field>
              <Field label="RAID 구성">
                <input value={form.raidConfig ?? ''} onChange={set('raidConfig')} className={inputCls} placeholder="RAID10" />
              </Field>

              <Field label="SSD 여부">
                <select
                  value={form.isSsd === true ? 'y' : form.isSsd === false ? 'n' : ''}
                  onChange={(e) => update('isSsd', e.target.value === 'y' ? true : e.target.value === 'n' ? false : null)}
                  className={inputCls}
                >
                  <option value="">미지정</option>
                  <option value="y">O (SSD/NVMe)</option>
                  <option value="n">X (HDD)</option>
                </select>
              </Field>
              <Field label="VM 여부">
                <select
                  value={form.isVm === true ? 'y' : form.isVm === false ? 'n' : ''}
                  onChange={(e) => update('isVm', e.target.value === 'y' ? true : e.target.value === 'n' ? false : null)}
                  className={inputCls}
                >
                  <option value="">미지정</option>
                  <option value="y">O (VM)</option>
                  <option value="n">X (Bare-metal)</option>
                </select>
              </Field>
            </div>
          </section>

          {/* 위치 */}
          <section>
            <h3 className="text-sm font-bold text-muted-foreground uppercase mb-2">위치</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Field label="데이터센터">
                <input value={form.datacenter ?? ''} onChange={set('datacenter')} className={inputCls} placeholder="DC1" />
              </Field>
              <Field label="Room / Cage">
                <input value={form.room ?? ''} onChange={set('room')} className={inputCls} />
              </Field>
              <Field label="Rack">
                <input value={form.rack ?? ''} onChange={set('rack')} className={inputCls} placeholder="R12" />
              </Field>
              <Field label="Rack Unit">
                <input value={form.rackUnit ?? ''} onChange={set('rackUnit')} className={inputCls} placeholder="U21-U22" />
              </Field>
            </div>
          </section>

          {/* 소프트웨어 */}
          <section>
            <h3 className="text-sm font-bold text-muted-foreground uppercase mb-2">소프트웨어 (자동 수집 대상)</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="md:col-span-2">
                <Field label="OS Image">
                  <input value={form.osImage ?? ''} onChange={set('osImage')} className={inputCls} />
                </Field>
              </div>
              <Field label="Kernel">
                <input value={form.kernelVersion ?? ''} onChange={set('kernelVersion')} className={monoCls} />
              </Field>
              <Field label="Kubelet">
                <input value={form.kubeletVersion ?? ''} onChange={set('kubeletVersion')} className={monoCls} />
              </Field>
              <div className="md:col-span-2">
                <Field label="Container Runtime">
                  <input value={form.containerRuntime ?? ''} onChange={set('containerRuntime')} className={monoCls} />
                </Field>
              </div>
            </div>
          </section>

          {/* 운영 정보 — 자산/계약 항목(자산태그·구매일·보증·담당자·구입목적) 은 사용자 요청으로 제거. */}
          <section>
            <h3 className="text-sm font-bold text-muted-foreground uppercase mb-2">운영</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="md:col-span-2">
                <Field label="현재 용도">
                  <input value={form.currentUsage ?? ''} onChange={set('currentUsage')} className={inputCls}
                    placeholder="NEW K8S MASTER" />
                </Field>
              </div>
            </div>
          </section>

          {/* 메모 */}
          <section>
            <Field label="메모 / 설명">
              <textarea value={form.description ?? ''} onChange={set('description')} rows={3}
                className={`${inputCls} resize-y`} />
            </Field>
          </section>

          {error && (
            <div className="px-3 py-2 text-sm rounded-lg bg-destructive/10 text-destructive border border-destructive/30">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/10">
          <button onClick={onClose} disabled={saving}
            className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg disabled:opacity-40">
            취소
          </button>
          <button onClick={submit} disabled={saving}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50">
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            {mode === 'create' ? '등록' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
