// 공통 서비스 인스턴스 등록·편집 — 호스팅 위치(K8S 워크로드 · Podman 컨테이너 · 외부) → 주소·서비스별 설정(카탈로그 필드) →
// 접속 정보(쓰기 전용, 암호화 저장) → 사용 클러스터. K8S 호스팅은 "K8S 에서 가져오기"로 후보 워크로드를 골라 채운다.
import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { InfoHint, SegTabs, SwitchToggle } from '@/components/common';
import { useClusters } from '@/hooks/useCluster';
import { useDiscoverCommonServices } from '@/hooks/useCommonServices';
import { formatApiError } from '@/lib/utils';
import type {
  CommonServiceCandidate, CommonServiceCredentialInput, CommonServiceDef, CommonServiceHostKind,
  CommonServiceInstance, CommonServiceInstanceInput,
} from '@/types';

const INPUT = 'w-full px-2.5 py-1.5 rounded-xl border border-border bg-card text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary';
const HOST_LABEL: Record<CommonServiceHostKind, string> = { k8s: 'K8S 워크로드', podman: 'Podman 컨테이너', external: '외부' };

interface CredDraft { username: string; secret: string; authType: CommonServiceCredentialInput['authType']; clear: boolean; hasSecret: boolean }

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs">
      <span className="inline-flex items-center gap-1 text-muted-foreground">{label}{help && <InfoHint text={help} />}</span>
      <span className="block mt-1">{children}</span>
    </label>
  );
}

function paramText(v: unknown): string {
  if (Array.isArray(v)) return v.join(', ');
  if (v === null || v === undefined) return '';
  return String(v);
}

interface Props {
  open: boolean;
  def: CommonServiceDef;
  instance: CommonServiceInstance | null;
  busy: boolean;
  onClose: () => void;
  onSave: (body: CommonServiceInstanceInput) => void;
}

export function InstanceDialog({ open, def, instance, busy, onClose, onSave }: Props) {
  const { data: clusters = [] } = useClusters();
  const discover = useDiscoverCommonServices();
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [hostKind, setHostKind] = useState<CommonServiceHostKind>(def.defaultHostKind);
  const [endpoint, setEndpoint] = useState('');
  const [tlsVerify, setTlsVerify] = useState(true);
  const [clusterId, setClusterId] = useState('');
  const [namespace, setNamespace] = useState('');
  const [workloadKind, setWorkloadKind] = useState('Deployment');
  const [workloadName, setWorkloadName] = useState('');
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState(22);
  const [container, setContainer] = useState('');
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [creds, setCreds] = useState<Record<string, CredDraft>>({});
  const [links, setLinks] = useState<string[]>([]);
  const [watch, setWatch] = useState(true);
  const [candidates, setCandidates] = useState<CommonServiceCandidate[] | null>(null);

  useEffect(() => {
    if (!open) return;
    const i = instance;
    setName(i?.name ?? '');
    setDesc(i?.description ?? '');
    setHostKind(i?.hostKind ?? def.defaultHostKind);
    setEndpoint(i?.endpointUrl ?? '');
    setTlsVerify(i?.tlsVerify ?? true);
    setClusterId(i?.clusterId ?? '');
    setNamespace(i?.namespace ?? '');
    setWorkloadKind(i?.workloadKind ?? 'Deployment');
    setWorkloadName(i?.workloadName ?? '');
    setSshHost(i?.sshHost ?? '');
    setSshPort(i?.sshPort ?? 22);
    setContainer(i?.containerName ?? '');
    const p: Record<string, unknown> = {};
    for (const f of def.paramFields) p[f.key] = f.default;
    for (const kv of i?.params ?? []) p[kv.key] = kv.value;
    setParams(p);
    const c: Record<string, CredDraft> = {};
    for (const d of def.credentials) {
      const saved = i?.credentials.find((x) => x.purpose === d.purpose);
      c[d.purpose] = {
        username: saved?.username ?? '', secret: '', clear: false, hasSecret: saved?.hasSecret ?? false,
        authType: (saved?.authType as CredDraft['authType']) ?? (d.purpose === 'ssh' ? 'password' : 'password'),
      };
    }
    setCreds(c);
    setLinks(i?.links.map((l) => l.clusterId) ?? []);
    setWatch(i?.watchEnabled ?? true);
    setCandidates(null);
  }, [open, instance, def]);

  const credsShown = useMemo(
    () => def.credentials.filter((c) => c.purpose !== 'ssh' || hostKind === 'podman'),
    [def.credentials, hostKind],
  );

  const missing = !name.trim()
    || (hostKind === 'k8s' && (!clusterId || !namespace.trim() || !workloadName.trim()))
    || (hostKind === 'podman' && (!sshHost.trim() || !container.trim()))
    || (hostKind === 'external' && !endpoint.trim());

  const runDiscover = () => {
    if (!clusterId) return;
    setCandidates(null);
    discover.mutate({ clusterId, namespace: namespace.trim() || null, serviceType: def.key }, {
      onSuccess: (items) => setCandidates(items),
    });
  };

  const pick = (c: CommonServiceCandidate) => {
    setNamespace(c.namespace);
    setWorkloadKind(c.workloadKind);
    setWorkloadName(c.workloadName);
    if (!endpoint && c.endpointUrl) setEndpoint(c.endpointUrl);
    if (!name.trim()) setName(c.workloadName);
    setCandidates(null);
  };

  const submit = () => {
    onSave({
      serviceType: def.key, name: name.trim(), description: desc.trim() || null, endpointUrl: endpoint.trim() || null,
      tlsVerify, hostKind,
      clusterId: hostKind === 'k8s' ? clusterId : null,
      namespace: hostKind === 'k8s' ? namespace.trim() : null,
      workloadKind: hostKind === 'k8s' ? workloadKind : null,
      workloadName: hostKind === 'k8s' ? workloadName.trim() : null,
      sshHost: hostKind === 'podman' ? sshHost.trim() : null,
      sshPort: hostKind === 'podman' ? sshPort : null,
      containerName: hostKind === 'podman' ? container.trim() : null,
      params: def.paramFields.map((f) => ({ key: f.key, value: params[f.key] })),
      watchEnabled: watch,
      credentials: credsShown.map((d) => {
        const c = creds[d.purpose];
        return { purpose: d.purpose, authType: c.authType, username: c.username.trim() || null, secret: c.secret || null, clear: c.clear };
      }),
      links: links.map((id) => ({ clusterId: id })),
    });
  };

  const setCred = (purpose: string, patch: Partial<CredDraft>) => setCreds((prev) => ({ ...prev, [purpose]: { ...prev[purpose], ...patch } }));

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{instance ? `${def.label} 편집 — ${instance.name}` : `${def.label} 등록`}</DialogTitle>
          <DialogDescription>{def.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 px-5 pb-3 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            <Field label="이름"><input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} aria-label="이름" placeholder="운영 Keycloak" /></Field>
            <Field label="설명 (선택)"><input className={INPUT} value={desc} onChange={(e) => setDesc(e.target.value)} aria-label="설명" /></Field>
          </div>

          <div className="space-y-2">
            <span className="text-xs text-muted-foreground">호스팅 위치</span>
            <SegTabs
              label="호스팅 위치"
              value={hostKind}
              onChange={(v) => setHostKind(v)}
              options={def.hostKinds.map((k) => [k, HOST_LABEL[k]] as const)}
            />
            {hostKind === 'k8s' && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="클러스터">
                    <select className={INPUT} value={clusterId} onChange={(e) => setClusterId(e.target.value)} aria-label="호스팅 클러스터">
                      <option value="">선택</option>
                      {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </Field>
                  <Field label="네임스페이스" help="비워 두고 가져오기를 누르면 모든 네임스페이스에서 찾습니다.">
                    <input className={`${INPUT} font-mono`} value={namespace} onChange={(e) => setNamespace(e.target.value)} aria-label="네임스페이스" />
                  </Field>
                  <Field label="워크로드 종류">
                    <select className={INPUT} value={workloadKind} onChange={(e) => setWorkloadKind(e.target.value)} aria-label="워크로드 종류">
                      {['Deployment', 'StatefulSet', 'DaemonSet'].map((k) => <option key={k} value={k}>{k}</option>)}
                    </select>
                  </Field>
                  <Field label="워크로드 이름">
                    <input className={`${INPUT} font-mono`} value={workloadName} onChange={(e) => setWorkloadName(e.target.value)} aria-label="워크로드 이름" />
                  </Field>
                </div>
                <Button variant="outline" size="sm" onClick={runDiscover} disabled={!clusterId || discover.isPending}>
                  <Search className="w-3.5 h-3.5 mr-1" />{discover.isPending ? '찾는 중…' : 'K8S 에서 가져오기'}
                </Button>
                {discover.isError && <p className="text-xs text-status-critical">{formatApiError(discover.error)}</p>}
                {candidates && (
                  candidates.length === 0
                    ? <p className="text-xs text-muted-foreground">이미지·이름이 {def.label} 와(과) 맞는 워크로드가 없습니다.</p>
                    : (
                      <ul className="rounded-md border border-border divide-y divide-border" aria-label="가져올 워크로드 후보">
                        {candidates.map((c) => (
                          <li key={`${c.namespace}/${c.workloadKind}/${c.workloadName}`}>
                            <button type="button" onClick={() => pick(c)} className="w-full text-left px-3 py-2 text-xs hover:bg-secondary">
                              <span className="font-mono text-foreground">{c.namespace}/{c.workloadName}</span>
                              <span className="text-muted-foreground"> · {c.workloadKind} · {c.replicas ?? '-'}개 · {c.images[0] ?? ''}</span>
                              {c.endpointUrl && <span className="block text-muted-foreground font-mono">{c.endpointUrl}</span>}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )
                )}
              </div>
            )}
            {hostKind === 'podman' && (
              <div className="grid grid-cols-3 gap-3">
                <Field label="SSH 호스트"><input className={`${INPUT} font-mono`} value={sshHost} onChange={(e) => setSshHost(e.target.value)} aria-label="SSH 호스트" placeholder="10.0.0.5" /></Field>
                <Field label="SSH 포트"><input type="number" className={INPUT} value={sshPort} onChange={(e) => setSshPort(Number(e.target.value) || 22)} aria-label="SSH 포트" /></Field>
                <Field label="컨테이너 이름"><input className={`${INPUT} font-mono`} value={container} onChange={(e) => setContainer(e.target.value)} aria-label="컨테이너 이름" placeholder="nexus" /></Field>
              </div>
            )}
          </div>

          <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
            <Field label="엔드포인트 주소" help="앱 API(또는 LDAP) 주소. K8S 호스팅이면 클러스터 안 Service 주소도 됩니다(PEP 백엔드에서 닿아야 함).">
              <input className={`${INPUT} font-mono`} value={endpoint} onChange={(e) => setEndpoint(e.target.value)} aria-label="엔드포인트 주소" placeholder={def.endpointPlaceholder} />
            </Field>
            <SwitchToggle checked={tlsVerify} onChange={setTlsVerify} label="TLS 인증서 검증" />
          </div>

          {def.paramFields.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              {def.paramFields.map((f) => (f.type === 'bool' ? (
                <div key={f.key} className="self-end pb-1.5">
                  <SwitchToggle checked={Boolean(params[f.key])} onChange={(v) => setParams((p) => ({ ...p, [f.key]: v }))} label={f.label} hint={f.help} />
                </div>
              ) : (
                <Field key={f.key} label={f.label} help={f.help}>
                    <input
                      className={`${INPUT} font-mono`}
                      type={f.type === 'int' ? 'number' : 'text'}
                      value={paramText(params[f.key])}
                      aria-label={f.label}
                      onChange={(e) => {
                        const raw = e.target.value;
                        const v = f.type === 'int' ? Number(raw) : f.type === 'list' ? raw.split(',').map((x) => x.trim()).filter(Boolean) : raw;
                        setParams((p) => ({ ...p, [f.key]: v }));
                      }}
                    />
                </Field>
              )))}
            </div>
          )}

          {credsShown.map((d) => {
            const c = creds[d.purpose];
            if (!c) return null;
            return (
              <fieldset key={d.purpose} className="rounded-md border border-border p-3 space-y-2">
                <legend className="px-1 text-xs text-muted-foreground inline-flex items-center gap-1">{d.label}<InfoHint text={`${d.help} 암호화해 저장하며 화면·API 에는 다시 보이지 않습니다.`} /></legend>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="방식">
                    <select className={INPUT} value={c.authType} onChange={(e) => setCred(d.purpose, { authType: e.target.value as CredDraft['authType'] })} aria-label={`${d.label} 방식`}>
                      <option value="password">비밀번호</option>
                      <option value="token">토큰</option>
                      {d.purpose === 'ssh' && <option value="private_key">개인 키</option>}
                    </select>
                  </Field>
                  <Field label="사용자"><input className={`${INPUT} font-mono`} value={c.username} onChange={(e) => setCred(d.purpose, { username: e.target.value })} aria-label={`${d.label} 사용자`} autoComplete="off" /></Field>
                  <Field label={c.hasSecret ? '비밀 값 (저장됨 — 비우면 유지)' : '비밀 값'}>
                    {c.authType === 'private_key' ? (
                      <textarea className={`${INPUT} font-mono min-h-[56px]`} value={c.secret} onChange={(e) => setCred(d.purpose, { secret: e.target.value })} aria-label={`${d.label} 개인 키`} />
                    ) : (
                      <input type="password" className={`${INPUT} font-mono`} value={c.secret} onChange={(e) => setCred(d.purpose, { secret: e.target.value })} aria-label={`${d.label} 비밀 값`} autoComplete="new-password" />
                    )}
                  </Field>
                </div>
                {c.hasSecret && (
                  <SwitchToggle checked={c.clear} onChange={(v) => setCred(d.purpose, { clear: v })} label="저장된 접속 정보 삭제" />
                )}
              </fieldset>
            );
          })}

          <Field label="사용 클러스터" help="이 서비스를 쓰는 클러스터(OIDC 인증·이미지 저장소·GitOps 대상 등). 화면에 배지로 표시합니다.">
            <div className="flex flex-wrap gap-1.5">
              {clusters.length === 0 && <span className="text-xs text-muted-foreground">등록된 클러스터가 없습니다.</span>}
              {clusters.map((c) => {
                const on = links.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setLinks((prev) => (on ? prev.filter((x) => x !== c.id) : [...prev, c.id]))}
                    className={`px-2.5 py-1 rounded-xl border text-xs ${on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-secondary'}`}
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
          </Field>
          <SwitchToggle checked={watch} onChange={setWatch} label="주기 수집으로 변경 감지" hint="감시 설정의 주기마다 저장된 접속 정보로 설정값을 다시 읽고, 바뀐 값을 이력·알람으로 남깁니다." />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>취소</Button>
          <Button onClick={submit} disabled={busy || missing}>{busy ? '저장 중…' : instance ? '저장' : '등록'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
