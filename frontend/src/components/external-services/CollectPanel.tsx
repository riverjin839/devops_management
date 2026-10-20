// 외부 서비스 "지금 수집" — 로그인한 operator 이상에게만 보인다(공개 화면 안의 운영자 도구).
// 수집은 SSE 로 단계·로그가 실시간으로 흐르고(RunLogPanel), "로그 보기" 는 사용자가 정한다.
// SSH 역조회 자격증명은 이 요청에만 쓰고 저장하지 않는다(서버도 저장하지 않는다).
import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Settings2 } from 'lucide-react';
import { MasterHostPicker, RunLogPanel, useToast } from '@/components/common';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useLogPref } from '@/hooks/useLogPref';
import { applyRunEvent, useRunLog } from '@/hooks/useRunLog';
import { postSse } from '@/lib/sse';
import { externalServicesApi } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import { ExternalServicesSettingsDialog } from './ExternalServicesSettingsDialog';

type Resolver = 'ssh' | 'backend' | 'none';

const INPUT = 'w-full text-sm px-2 py-1.5 rounded-xl border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary';
const BTN = 'text-sm inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed';
const BTN_PRIMARY = 'text-sm inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-primary text-primary-foreground disabled:opacity-50';

const RESOLVERS: { value: Resolver; label: string; help: string }[] = [
  { value: 'ssh', label: '노드에서 nslookup (권장)', help: '마스터/워커에 SSH 로 접속해 IP 마다 nslookup — 사내 DNS 기준 도메인. 못 찾은 IP 는 backend 역조회로 보완.' },
  { value: 'backend', label: 'backend 역조회', help: 'PEP backend 가 PTR 조회. 자격증명 불필요(정기 수집과 같은 방식).' },
  { value: 'none', label: '역조회 안 함', help: 'IP:Port 목록만 갱신. 이전에 찾은 도메인은 유지된다.' },
];

export function CollectPanel({ clusterId, clusterName }: { clusterId: string; clusterName: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const { canOperate, withHint, ariaWithHint } = useCanOperate(clusterId);
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('external-services-collect');
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resolver, setResolver] = useState<Resolver>('ssh');
  const [host, setHost] = useState({ selectedName: '', customHost: '', effectiveHost: '' });
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState('root');
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password');
  const [secret, setSecret] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const sshReady = resolver !== 'ssh' || (!!host.effectiveHost && !!username && !!secret);

  const start = async () => {
    setOpen(false);
    const run = runLog.begin(`${clusterName} 외부 서비스 수집`,
      `수집 요청 — 역조회 ${RESOLVERS.find((r) => r.value === resolver)?.label}${resolver === 'ssh' ? ` · ${username}@${host.effectiveHost}:${port}` : ''}`);
    const ac = new AbortController();
    abortRef.current = ac;
    let error: string | null = null;
    let errorLogged = false;   // 서버가 이미 로그 줄로 남긴 실패(result.ok=false)는 다시 쓰지 않는다
    let done = false;
    try {
      await postSse(
        externalServicesApi.collectStreamUrl(clusterId),
        {
          resolver,
          ssh: resolver === 'ssh' ? {
            host: host.effectiveHost, port, username,
            password: authMode === 'password' ? secret : null,
            private_key: authMode === 'key' ? secret : null,
          } : null,
        },
        (evt) => {
          if (evt.type === 'result') {
            const r = evt.result as { ok?: boolean; error?: string } | undefined;
            if (r && r.ok === false) { error = r.error ?? '수집 실패'; errorLogged = true; }
            done = true;
          } else if (evt.type === 'error') error = String(evt.message ?? '수집 실패');
          else applyRunEvent(run, evt);
        },
        ac.signal,
      );
    } catch (e) {
      if (!ac.signal.aborted) error = e instanceof Error ? e.message : String(e);
      else run.log('warn', '사용자 중지 — 서버 쪽 수집은 끝까지 진행될 수 있음');
    } finally {
      setSecret('');
      abortRef.current = null;
    }
    if (error) {
      if (!errorLogged) run.log('error', error);
      toast.error('외부 서비스 수집 실패', error);
    } else if (done) {
      run.log('info', '완료 — 목록을 다시 읽는다');
      toast.success('외부 서비스 수집 완료');
    }
    // 실패도 스냅샷의 오류 표시가 바뀌므로 항상 다시 읽는다.
    void qc.invalidateQueries({ queryKey: ['external-services', clusterId] });
    run.end();
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BTN_PRIMARY} disabled={!canOperate || runLog.running}
          title={withHint('클러스터에서 외부 노출 엔드포인트를 다시 수집하고 IP 를 도메인으로 역조회')}
          aria-label={ariaWithHint('지금 수집')} onClick={() => setOpen(true)}>
          <RefreshCw className={runLog.running ? 'w-4 h-4 animate-spin' : 'w-4 h-4'} /> 지금 수집
        </button>
        {runLog.running && (
          <button type="button" className={BTN} onClick={() => abortRef.current?.abort()}>중지</button>
        )}
        {isAdmin && (
          <button type="button" className={BTN} onClick={() => setSettingsOpen(true)}>
            <Settings2 className="w-4 h-4" /> 설정
          </button>
        )}
        <span className="text-xs text-muted-foreground">운영자 전용 — 로그인하지 않은 방문자에게는 보이지 않는다</span>
      </div>
      <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-64" />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>외부 서비스 수집 — {clusterName}</DialogTitle>
            <DialogDescription>
              Service(LoadBalancer·ExternalIP·NodePort)와 Ingress 를 다시 읽고, 외부 IP 를 도메인으로 역조회한다.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 px-5 pb-3">
            <fieldset className="space-y-1.5">
              <legend className="text-xs text-muted-foreground mb-1">IP → 도메인 역조회</legend>
              {RESOLVERS.map((r) => (
                <label key={r.value} className="flex items-start gap-2 text-sm">
                  <input type="radio" name="resolver" className="accent-primary mt-1" checked={resolver === r.value}
                    onChange={() => setResolver(r.value)} />
                  <span>
                    {r.label}
                    <span className="block text-[11px] text-muted-foreground leading-snug">{r.help}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {resolver === 'ssh' && (
              <div className="space-y-2 rounded-xl border border-border p-3">
                <MasterHostPicker clusterId={clusterId} customHost={host.customHost} selectedName={host.selectedName}
                  onChange={setHost} label="nslookup 실행 노드" compact />
                <div className="grid grid-cols-3 gap-2">
                  <label className="text-xs col-span-2">
                    <span className="text-muted-foreground">사용자</span>
                    <input className={INPUT} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
                  </label>
                  <label className="text-xs">
                    <span className="text-muted-foreground">포트</span>
                    <input type="number" min={1} max={65535} className={INPUT} value={port}
                      onChange={(e) => setPort(Number(e.target.value) || 22)} />
                  </label>
                </div>
                <div className="flex gap-3 text-xs">
                  {(['password', 'key'] as const).map((m) => (
                    <label key={m} className="inline-flex items-center gap-1">
                      <input type="radio" name="auth" className="accent-primary" checked={authMode === m}
                        onChange={() => { setAuthMode(m); setSecret(''); }} />
                      {m === 'password' ? '비밀번호' : '개인키'}
                    </label>
                  ))}
                </div>
                {authMode === 'password' ? (
                  <input type="password" className={INPUT} placeholder="비밀번호" value={secret}
                    onChange={(e) => setSecret(e.target.value)} autoComplete="current-password" aria-label="SSH 비밀번호" />
                ) : (
                  <textarea className={`${INPUT} font-mono h-24`} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    value={secret} onChange={(e) => setSecret(e.target.value)} aria-label="SSH 개인키" />
                )}
                <p className="text-[11px] text-muted-foreground">자격증명은 이번 수집에만 쓰고 저장하지 않는다.</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <button type="button" className={BTN} onClick={() => setOpen(false)}>취소</button>
            <button type="button" className={BTN_PRIMARY} disabled={!sshReady} onClick={() => void start()}>수집 실행</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {isAdmin && <ExternalServicesSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
