// 적용 — 버전·변경 요약 / 대상(범위 전체·노드 선택) / 방식(서비스별) / 영향 / 실행될 명령 / SSH(노드 서비스, 저장하지 않음) → 적용 시작.
// 적용은 노드 설정을 실제로 바꾸는 실행이다: 시작 버튼은 위험 색이고, 실행 로그를 실시간으로 남긴다(로그 보기 선택).
import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState } from '@/components/common';
import { useServiceConfigApplyPlan, useServiceConfigSettings } from '@/hooks/useServiceConfig';
import type { ServiceConfigDriftRow } from '@/types';

const INPUT = 'px-2.5 py-1.5 rounded-xl border border-border bg-card text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary';
const TH = 'text-left px-2 py-1.5 text-xs font-medium text-muted-foreground border-b border-border';
const TD = 'px-2 py-1.5 border-b border-border align-top';

const IMPACT: Record<string, string> = {
  linux: '재시작 없음 — sysctl 로 즉시 반영. 관리 파일에 기록하면 재부팅 뒤에도 유지된다.',
  cilium: 'cilium-config 를 바꾸고 cilium 에이전트(DaemonSet)를 노드 한 대씩 다시 띄운다. 재시작 중인 노드는 잠시 정책 갱신이 멈춘다.',
  etcd: 'etcd 멤버를 한 대씩 재시작한다. 시작 전에 전 멤버가 정상인지 확인하고, 새 설정으로 정상 기동하지 않으면 백업으로 되돌린 뒤 멈춘다(쿼럼 보호).',
  'kube-apiserver': '컨트롤 플레인 노드마다 API 서버 매니페스트를 고치고 kubelet 이 API 서버를 다시 띄운다. 한 대씩 하며, 시작 전 모든 API 서버가 정상인지 확인한다 — 컨트롤 플레인이 1대면 재시작 동안 API 를 쓸 수 없다.',
  'kube-controller-manager': '컨트롤 플레인 노드마다 컨트롤러 매니저 매니페스트를 고치고 kubelet 이 다시 띄운다. 리더가 바뀌는 동안 잠시 컨트롤러 동작(파드 재생성 등)이 멈춘다.',
  'kube-scheduler': '컨트롤 플레인 노드마다 스케줄러 매니페스트를 고치고 kubelet 이 다시 띄운다. 리더가 바뀌는 동안 잠시 새 파드 배치가 멈춘다.',
  kubelet: 'kubelet 설정 파일을 고치고 kubelet 을 재시작한다 — 실행 중인 파드는 유지되지만 재시작 동안 노드 상태 보고·새 파드 기동이 멈춘다. 노드 Ready 를 확인하고 configz 로 실효 값을 본다.',
  containerd: 'containerd 를 재시작한다 — 실행 중인 컨테이너는 유지되지만 재시작 동안 새 파드 생성·이미지 받기가 멈춘다. cordon 으로 새 파드 배치를 막고, 필요하면 drain 한다.',
};
const STATIC_POD = new Set(['kube-apiserver', 'kube-controller-manager', 'kube-scheduler']);
const NODE_SERVICES = new Set(['linux', 'etcd', 'containerd', 'kubelet', ...STATIC_POD]);
/** 쿼럼·컨트롤 플레인 보호 — 한 대씩·실패 시 중단 고정(서버도 강제). */
const ONE_BY_ONE = new Set(['etcd', ...STATIC_POD]);

export interface ApplyRequest {
  version_no: number;
  group_id: string | null;
  target_mode: 'scope' | 'nodes';
  nodes: string[];
  options: {
    batch_size: number; pause_sec: number; stop_on_failure: boolean;
    persist: boolean; update_watch_rules: boolean; restart: boolean; rollout_timeout_sec: number | null;
    auto_restore: boolean; health_timeout_sec: number | null;
    cordon: boolean; drain: boolean; drain_timeout_sec: number; node_ready_timeout_sec: number | null;
  };
  ssh: { username: string; port: number; password: string | null; private_key: string | null; use_sudo: boolean } | null;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-4 py-3 border-b border-border last:border-0">
      <span className="w-20 shrink-0 pt-1 text-xs font-semibold text-foreground">{label}</span>
      <div className="flex-1 min-w-0 space-y-1.5 text-sm">{children}</div>
    </div>
  );
}

interface Props {
  open: boolean;
  clusterId: string;
  service: string;
  serviceLabel: string;
  groupId: string | null;
  versionNo: number | null;
  showLog: boolean;
  onShowLogChange: (v: boolean) => void;
  onClose: () => void;
  onStart: (req: ApplyRequest) => void;
  /** 있으면 '노드 선택' 으로 시작하고 이 노드들을 미리 고른다(드리프트 다시 적용). */
  initialNodes?: string[] | null;
  /** 드리프트 다시 적용이면 기준과 다른 노드 값 — '변경' 대신 이것을 보여 준다(버전 값을 그대로 다시 쓰므로). */
  driftRows?: ServiceConfigDriftRow[] | null;
}

export function ApplyDialog({ open, clusterId, service, serviceLabel, groupId, versionNo, showLog, onShowLogChange, onClose, onStart, initialNodes, driftRows }: Props) {
  const planQ = useServiceConfigApplyPlan(clusterId, service, versionNo, groupId, open);
  const plan = planQ.data;
  const settingsQ = useServiceConfigSettings(open);
  const isLinux = service === 'linux';
  const isNode = NODE_SERVICES.has(service);
  const isEtcd = service === 'etcd';
  const oneByOne = ONE_BY_ONE.has(service);
  const isCtd = service === 'containerd';
  const isKubelet = service === 'kubelet';
  const unit = isEtcd ? '멤버' : '노드';
  const [mode, setMode] = useState<'scope' | 'nodes'>('scope');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState(1);
  const [pause, setPause] = useState(10);
  const [stopOnFail, setStopOnFail] = useState(true);
  const [persist, setPersist] = useState(true);
  const [watch, setWatch] = useState(true);
  const [restart, setRestart] = useState(true);
  const [timeout, setTimeoutSec] = useState(600);
  const [autoRestore, setAutoRestore] = useState(true);
  const [healthTimeout, setHealthTimeout] = useState(180);
  const [cordon, setCordon] = useState(true);
  const [drain, setDrain] = useState(false);
  const [drainTimeout, setDrainTimeout] = useState(300);
  const [readyTimeout, setReadyTimeout] = useState(300);
  const [user, setUser] = useState('root');
  const [port, setPort] = useState(22);
  const [auth, setAuth] = useState<'password' | 'key'>('key');
  const [password, setPassword] = useState('');
  const [key, setKey] = useState('');
  const [sudo, setSudo] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode(initialNodes?.length ? 'nodes' : 'scope');
    setPicked(new Set(initialNodes ?? []));
    setPassword('');
    setKey('');
  }, [open, initialNodes]);
  useEffect(() => {  // 대기 시간 기본값은 적용 설정을 따른다(실행마다 바꿀 수 있다)
    const st = settingsQ.data;
    if (!open || !st) return;
    setTimeoutSec(st.rolloutTimeoutSec);
    setHealthTimeout(isEtcd ? st.etcdHealthTimeoutSec : st.controlPlaneHealthTimeoutSec);
    setReadyTimeout(st.nodeReadyTimeoutSec);
  }, [open, settingsQ.data, isEtcd]);

  const nodes = useMemo(() => plan?.scopeNodes ?? [], [plan]);
  const count = mode === 'scope' ? (plan?.targets.length ?? 0) : picked.size;
  const credsOk = !isNode || (auth === 'password' ? !!password : !!key.trim());
  const canStart = !!plan && plan.supported && count > 0 && credsOk;

  const start = () => {
    if (!plan) return;
    onStart({
      version_no: plan.versionNo,
      group_id: groupId,
      target_mode: isNode ? mode : 'scope',
      nodes: mode === 'nodes' ? [...picked] : [],
      options: {
        batch_size: oneByOne ? 1 : batch, pause_sec: pause, stop_on_failure: oneByOne ? true : stopOnFail, persist, update_watch_rules: watch,
        restart, rollout_timeout_sec: service === 'cilium' ? timeout : null,
        auto_restore: autoRestore, health_timeout_sec: oneByOne ? healthTimeout : null,
        cordon, drain, drain_timeout_sec: drainTimeout, node_ready_timeout_sec: isCtd || isKubelet ? readyTimeout : null,
      },
      ssh: isNode ? {
        username: user, port, password: auth === 'password' ? password : null,
        private_key: auth === 'key' ? key : null, use_sudo: sudo,
      } : null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            적용: {serviceLabel}{plan ? ` · ${plan.group.name}` : ''}{plan ? ` ${plan.baselineVersionNo ? `V${plan.baselineVersionNo} → ` : ''}V${plan.versionNo}` : ''}
          </DialogTitle>
          <DialogDescription>저장된 설정 버전을 노드에 실제로 반영합니다. 실행 로그가 실시간으로 남고, 중간에 중지할 수 있습니다.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[62vh] overflow-y-auto px-5">
          {planQ.isLoading ? <LoadingState /> : planQ.isError ? <ErrorState error={planQ.error} title="적용 계획을 만들지 못했습니다" /> : plan ? (
            <>
              <Row label="변경">
                {driftRows ? (
                  <>
                    <p className="text-muted-foreground">기준 버전 V{plan.versionNo} 값을 그대로 다시 쓴다 — 아래 노드 값이 기준으로 돌아간다.</p>
                    <table className="w-full">
                      <thead><tr><th className={TH}>키</th><th className={TH}>노드</th><th className={TH}>현재</th><th className={TH}>되돌릴 값</th></tr></thead>
                      <tbody>
                        {driftRows.slice(0, 50).map((r) => (
                          <tr key={`${r.key}|${r.node}`}>
                            <td className={`${TD} font-mono text-xs break-all`}>{r.key}</td>
                            <td className={`${TD} text-xs`}>{r.node}</td>
                            <td className={`${TD} font-mono text-xs text-muted-foreground`}>{r.current}</td>
                            <td className={`${TD} font-mono text-xs font-semibold`}>{r.expected}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                ) : plan.changes.length === 0 ? (
                  <p className="text-muted-foreground">기준 버전과 다른 값이 없습니다 — 버전 값을 그대로 다시 씁니다.</p>
                ) : (
                  <table className="w-full">
                    <thead><tr><th className={TH}>키</th><th className={TH}>기준</th><th className={TH}>적용 값</th></tr></thead>
                    <tbody>
                      {plan.changes.map((c) => (
                        <tr key={c.key}>
                          <td className={`${TD} font-mono text-xs break-all`}>{c.key}</td>
                          <td className={`${TD} font-mono text-xs text-muted-foreground`}>{c.a ?? '(없음)'}</td>
                          <td className={`${TD} font-mono text-xs font-semibold`}>{c.b ?? '(없음)'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Row>
              <Row label="대상">
                {isNode ? (
                  <>
                    <label className="flex items-center gap-2">
                      <input type="radio" name="apply-target" checked={mode === 'scope'} onChange={() => setMode('scope')} />
                      {plan.group.name} 노드 전체 ({plan.targets.length})
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="radio" name="apply-target" checked={mode === 'nodes'} onChange={() => setMode('nodes')} />
                      {`${unit} 선택`} <span className="text-xs text-muted-foreground">— 일부에 먼저 적용해 보고 넓힐 때. 버전은 &lsquo;저장됨·미적용&rsquo; 으로 남는다</span>
                    </label>
                    {mode === 'nodes' && (
                      <div className="flex flex-wrap gap-1.5 pl-6">
                        {nodes.map((n) => (
                          <label key={n} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border text-xs ${picked.has(n) ? 'border-primary bg-primary/5' : 'border-border'}`}>
                            <input type="checkbox" checked={picked.has(n)} onChange={(e) => setPicked((s) => {
                              const next = new Set(s);
                              if (e.target.checked) next.add(n); else next.delete(n);
                              return next;
                            })} />
                            {n}
                          </label>
                        ))}
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">접속 주소: {plan.targets.slice(0, 6).map((t) => (t.host === t.node ? t.node : `${t.node}(${t.host})`)).join(', ')}{plan.targets.length > 6 ? ' …' : ''}</p>
                  </>
                ) : (
                  <p>클러스터 하나 — kube-system 의 cilium-config(K8S API, SSH 없음)</p>
                )}
              </Row>
              <Row label="방식">
                {oneByOne ? (
                  <>
                    <p>한 대씩(고정) · 실패하면 남은 {unit}는 건너뛰고 중단(고정) · 시작 전 전 {unit} health 확인</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1.5">{unit} 사이 대기 <input type="number" min={0} max={600} value={pause} onChange={(e) => setPause(Number(e.target.value) || 0)} className={`${INPUT} w-20`} aria-label={`${unit} 사이 대기(초)`} /> 초</label>
                      <label className="flex items-center gap-1.5">정상 기동 대기 <input type="number" min={30} max={1800} value={healthTimeout} onChange={(e) => setHealthTimeout(Number(e.target.value) || 180)} className={`${INPUT} w-24`} aria-label="health 대기 제한 시간(초)" /> 초</label>
                    </div>
                    <label className="flex items-center gap-2"><input type="checkbox" checked={autoRestore} onChange={(e) => setAutoRestore(e.target.checked)} /> 새 설정으로 정상 기동하지 않으면 백업으로 자동 복원</label>
                  </>
                ) : isNode ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1.5">롤링 <input type="number" min={1} max={50} value={batch} onChange={(e) => setBatch(Number(e.target.value) || 1)} className={`${INPUT} w-20`} aria-label="한 번에 적용할 노드 수" /> 대씩</label>
                      <label className="flex items-center gap-1.5">배치 사이 대기 <input type="number" min={0} max={600} value={pause} onChange={(e) => setPause(Number(e.target.value) || 0)} className={`${INPUT} w-20`} aria-label="배치 사이 대기(초)" /> 초</label>
                    </div>
                    <label className="flex items-center gap-2"><input type="checkbox" checked={stopOnFail} onChange={(e) => setStopOnFail(e.target.checked)} /> 실패하면 남은 노드는 건너뛰고 중단</label>
                    {isLinux && (
                      <>
                        <label className="flex items-center gap-2"><input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} /> 영구 설정 파일에도 기록(끄면 sysctl -w 만 — 재부팅 시 원복)</label>
                        <label className="flex items-center gap-2"><input type="checkbox" checked={watch} onChange={(e) => setWatch(e.target.checked)} /> 범위 전체에 적용하면 OS 파라미터 감시 기준값을 이 값으로 갱신</label>
                      </>
                    )}
                    {isKubelet && (
                      <>
                        <label className="flex items-center gap-1.5">Ready 대기 <input type="number" min={30} max={1800} value={readyTimeout} onChange={(e) => setReadyTimeout(Number(e.target.value) || 300)} className={`${INPUT} w-24`} aria-label="노드 Ready 대기 제한 시간(초)" /> 초</label>
                        <label className="flex items-center gap-2"><input type="checkbox" checked={autoRestore} onChange={(e) => setAutoRestore(e.target.checked)} /> 재시작·확인에 실패하면 백업으로 자동 복원</label>
                      </>
                    )}
                    {isCtd && (
                      <>
                        <label className="flex items-center gap-2"><input type="checkbox" checked={cordon} onChange={(e) => setCordon(e.target.checked)} /> 재시작 전 cordon(새 파드 배치 막기), 노드 Ready 확인 뒤 uncordon</label>
                        <label className="flex items-center gap-2"><input type="checkbox" checked={drain} disabled={!cordon} onChange={(e) => setDrain(e.target.checked)} /> drain — DaemonSet·미러 파드를 뺀 파드를 내보냄(PDB 를 지킨다)</label>
                        <div className="flex flex-wrap items-center gap-2">
                          {drain && cordon && <label className="flex items-center gap-1.5">drain 제한 <input type="number" min={30} max={1800} value={drainTimeout} onChange={(e) => setDrainTimeout(Number(e.target.value) || 300)} className={`${INPUT} w-24`} aria-label="drain 제한 시간(초)" /> 초</label>}
                          <label className="flex items-center gap-1.5">Ready 대기 <input type="number" min={30} max={1800} value={readyTimeout} onChange={(e) => setReadyTimeout(Number(e.target.value) || 300)} className={`${INPUT} w-24`} aria-label="노드 Ready 대기 제한 시간(초)" /> 초</label>
                        </div>
                        <label className="flex items-center gap-2"><input type="checkbox" checked={autoRestore} onChange={(e) => setAutoRestore(e.target.checked)} /> 재시작·확인에 실패하면 백업으로 자동 복원</label>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <label className="flex items-center gap-2"><input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} /> cilium DaemonSet 롤링 재시작 후 롤아웃 완료까지 기다림</label>
                    <label className="flex items-center gap-1.5">제한 시간 <input type="number" min={30} max={3600} value={timeout} onChange={(e) => setTimeoutSec(Number(e.target.value) || 600)} className={`${INPUT} w-24`} aria-label="롤아웃 제한 시간(초)" /> 초</label>
                  </>
                )}
              </Row>
              <Row label="영향"><p className="text-muted-foreground">{IMPACT[service] ?? ''}</p></Row>
              {(plan.commands ?? []).length > 0 && (
                <Row label="명령">
                  <details>
                    <summary className="cursor-pointer text-sm text-muted-foreground">실행될 명령 {plan.commands.length}개 보기 — 경로·명령은 적용 설정에서 바꾼다</summary>
                    <ol className="mt-2 space-y-1 list-decimal pl-5">
                      {plan.commands.map((c, i) => <li key={i} className="font-mono text-xs break-all">{c}</li>)}
                    </ol>
                  </details>
                </Row>
              )}
              {isNode && (
                <Row label="SSH">
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1.5">사용자 <input value={user} onChange={(e) => setUser(e.target.value)} className={`${INPUT} w-28`} aria-label="SSH 사용자" /></label>
                    <label className="flex items-center gap-1.5">포트 <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)} className={`${INPUT} w-20`} aria-label="SSH 포트" /></label>
                    <label className="flex items-center gap-1.5"><input type="radio" name="apply-auth" checked={auth === 'password'} onChange={() => setAuth('password')} /> 비밀번호</label>
                    <label className="flex items-center gap-1.5"><input type="radio" name="apply-auth" checked={auth === 'key'} onChange={() => setAuth('key')} /> 개인 키</label>
                    <label className="flex items-center gap-1.5"><input type="checkbox" checked={sudo} onChange={(e) => setSudo(e.target.checked)} /> sudo</label>
                  </div>
                  {auth === 'password' ? (
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="SSH 비밀번호" aria-label="SSH 비밀번호" className={`${INPUT} w-full`} />
                  ) : (
                    <textarea value={key} onChange={(e) => setKey(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" aria-label="SSH 개인 키" rows={3} className={`${INPUT} w-full font-mono text-xs`} />
                  )}
                  <p className="text-xs text-muted-foreground">자격증명은 이번 적용에만 쓰고 저장하지 않습니다(실행 이력·감사 로그에도 남지 않습니다).</p>
                </Row>
              )}
              {!plan.supported && <p className="py-3 text-sm text-status-warning">{serviceLabel} 은(는) 적용을 지원하지 않습니다.</p>}
            </>
          ) : null}
        </div>
        <DialogFooter>
          <label className="mr-auto flex items-center gap-2 text-sm"><input type="checkbox" checked={showLog} onChange={(e) => onShowLogChange(e.target.checked)} /> 실행 로그 바로 열기</label>
          <Button variant="outline" onClick={onClose}>취소</Button>
          <Button variant="destructive" disabled={!canStart} onClick={start}
            title={!credsOk ? 'SSH 비밀번호 또는 개인 키를 입력하세요' : count === 0 ? '적용할 노드를 고르세요' : undefined}>
            {isNode ? `${count}개 ${unit}에 적용 시작` : '클러스터에 적용 시작'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
