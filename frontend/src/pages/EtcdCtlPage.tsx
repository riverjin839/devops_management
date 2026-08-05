import { useEffect, useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import {
  Database, Play, Square, CheckCircle, XCircle, Key, FileText, Terminal,
  ShieldAlert, Wifi, Clock, ScrollText,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useTerminalEnvSync } from '@/hooks/useTerminalEnvSync';
import { ConfirmDialog, ExecOutputTabs, ClusterSidebar, SavedCommands } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import {
  etcdctlApi, type EtcdPreset, type EtcdMasterCandidate, type EtcdCtlRunResponse,
} from '@/services/api';
import { formatApiError } from '@/lib/utils';

const STATUS_META: Record<EtcdCtlRunResponse['status'], { label: string; cls: string; icon: React.ComponentType<{ className?: string }> }> = {
  ok:            { label: '정상',     cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',  icon: CheckCircle },
  error:         { label: '에러',     cls: 'bg-red-500/10 text-red-400 border-red-500/30',              icon: XCircle },
  timeout:       { label: '타임아웃', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30',        icon: Clock },
  auth_error:    { label: '인증 실패', cls: 'bg-orange-500/10 text-orange-400 border-orange-500/30',    icon: ShieldAlert },
  connect_error: { label: '연결 실패', cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30',       icon: Wifi },
};

// 타겟/실행 구성 옆(우측)에 고정 위치로 배치 — mc 클라이언트 콘솔과 동일한 패턴이다.
// 실행 전에도 같은 자리에 플레이스홀더를 보여줘 결과가 나와도 레이아웃이 흔들리지 않는다.
// 카드 자체는 화면 높이에 맞춰 세로 스크롤만 허용(overflow-y-auto)하고 가로 스크롤은
// 막는다(overflow-x-hidden) — 좁은 카드 폭 안에 긴 로그가 들어와도 페이지가 옆으로 늘어나지 않는다.
function ResultPanel({ result, tab }: { result: EtcdCtlRunResponse | null; tab: Tab }) {
  if (!result) {
    return (
      <MacCard rootClassName="lg:col-span-5 min-w-0" bodyPadding="p-5" className="flex items-center justify-center min-h-[200px] lg:h-[calc(100vh-260px)]">
        <p className="text-sm text-muted-foreground text-center">
          {tab === 'run' ? 'etcdctl 명령을 실행하면' : '로그를 가져오면'}<br />결과가 여기에 표시됩니다.
        </p>
      </MacCard>
    );
  }
  const meta = STATUS_META[result.status];
  const Icon = meta.icon;
  return (
    <MacCard rootClassName="lg:col-span-5 min-w-0 overflow-y-auto overflow-x-hidden lg:h-[calc(100vh-260px)]" bodyPadding="p-0">
      <header className="sticky top-0 z-10 px-5 py-3 border-b border-border flex items-center justify-between bg-muted/90 backdrop-blur-sm">
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`inline-flex items-center gap-1 text-sm px-2 py-0.5 rounded-full border font-medium ${meta.cls}`}>
            <Icon className="w-3 h-3" />
            {meta.label}
          </span>
          <span className="text-sm font-mono text-muted-foreground truncate">{result.host}</span>
          {result.exitCode !== null && result.exitCode !== undefined && (
            <span className="text-sm font-mono text-muted-foreground">exit {result.exitCode}</span>
          )}
          <span className="text-sm font-mono text-muted-foreground">{result.durationMs}ms</span>
        </div>
        {result.error && (
          <span className="text-sm text-red-400">⚠ {result.error}</span>
        )}
      </header>
      <div className="px-5 py-3 space-y-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">executed</p>
          <pre className="text-xs font-mono bg-background border border-border rounded p-2 overflow-auto whitespace-pre-wrap break-all text-foreground/80">
            {result.executedCommand || '(not provided)'}
          </pre>
        </div>
        <ExecOutputTabs stdout={result.stdout} stderr={result.stderr} maxHeight="max-h-[440px]" />
      </div>
    </MacCard>
  );
}

type Tab = 'run' | 'logs';

export function EtcdCtlPage() {
  const { data: clusters = [] } = useClusters();
  const [clusterId, setClusterId] = useState('');
  useEffect(() => {
    if (!clusterId && clusters.length > 0) setClusterId(clusters[0].id);
  }, [clusters, clusterId]);
  // 선택 클러스터 운영등급 → 터미널 Appearance(개발/운영) 자동 적용.
  useTerminalEnvSync(clusters, clusterId || null);

  const mastersQ = useQuery({
    queryKey: ['etcdctl', 'masters', clusterId],
    queryFn: () => etcdctlApi.masters(clusterId).then((r) => r.data),
    enabled: !!clusterId,
  });
  const presetsQ = useQuery({
    queryKey: ['etcdctl', 'presets', clusterId],
    queryFn: () => etcdctlApi.presets(clusterId).then((r) => r.data),
    enabled: !!clusterId,
  });

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  // 타겟 호스트 선택
  const [selectedMasterName, setSelectedMasterName] = useState('');
  const [customHost, setCustomHost] = useState('');
  useEffect(() => {
    if (!mastersQ.data) return;
    if (!selectedMasterName && mastersQ.data.candidates.length > 0) {
      setSelectedMasterName(mastersQ.data.candidates[0].name);
    }
  }, [mastersQ.data, selectedMasterName]);

  const effectiveHost = useMemo(() => {
    if (customHost.trim()) return customHost.trim();
    const m = (mastersQ.data?.candidates ?? []).find((c: EtcdMasterCandidate) => c.name === selectedMasterName);
    return m?.internalIp || m?.externalIp || m?.name || '';
  }, [customHost, mastersQ.data, selectedMasterName]);

  // SSH 인증
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState('root');
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');

  // etcdctl 구성
  const [args, setArgs] = useState('endpoint health --write-out=table');
  const [envFile, setEnvFile] = useState('/etc/etcd.env');
  const [useEnv, setUseEnv] = useState(true);
  const [etcdctlPath, setEtcdctlPath] = useState('etcdctl');
  const [timeout, setTimeoutSec] = useState(30);

  // Logs 구성
  const [unit, setUnit] = useState('etcd.service');
  const [tail, setTail] = useState(200);
  const [since, setSince] = useState('');
  const [grep, setGrep] = useState('');

  const [tab, setTab] = useState<Tab>('run');
  const [result, setResult] = useState<EtcdCtlRunResponse | null>(null);

  const runMut = useAbortableMutation({
    mutationFn: async (_: void, signal) => {
      const res = await etcdctlApi.run(clusterId, {
        host: effectiveHost,
        port,
        username,
        password: authMode === 'password' ? password : undefined,
        privateKey: authMode === 'key' ? privateKey : undefined,
        args,
        envFile,
        useEnv,
        etcdctlPath,
        timeout,
      }, signal);
      return res.data;
    },
    onSuccess: (d) => setResult(d),
  });

  const logsMut = useAbortableMutation({
    mutationFn: async (_: void, signal) => {
      const res = await etcdctlApi.logs(clusterId, {
        host: effectiveHost,
        port,
        username,
        password: authMode === 'password' ? password : undefined,
        privateKey: authMode === 'key' ? privateKey : undefined,
        unit,
        tail,
        since: since.trim() || undefined,
        grep: grep.trim() || undefined,
      }, signal);
      return res.data;
    },
    onSuccess: (d) => setResult(d),
  });

  const baseReady = !!clusterId && !!effectiveHost
    && (authMode === 'password' ? !!password : !!privateKey.trim());
  const canRunEtcdctl = baseReady && !!args.trim();
  const canRunLogs = baseReady && !!unit.trim();

  const [confirmAction, setConfirmAction] = useState<null | 'run' | 'logs'>(null);

  const runError = (tab === 'run' ? runMut.error : logsMut.error) as
    { response?: { data?: { detail?: string } }; message?: string } | null;

  return (
    <div className="app-min-h-screen bg-background">
      <main className="pr-6 py-6 flex gap-5">
        <ClusterSidebar
          clusters={clusters}
          selectedId={clusterId || null}
          onSelect={(id) => { setClusterId(id ?? ''); setResult(null); setSelectedMasterName(''); }}
          iconOnly
        />
        <div className="flex-1 min-w-0">
        {/* 헤더 */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Database className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">etcdctl 콘솔</h1>
            {effectiveHost && (
              <span className="text-sm px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-400 border border-slate-500/30 font-mono">
                → {effectiveHost}
              </span>
            )}
          </div>
        </div>

        {/* 안내 */}
        <MacCard rootClassName="mb-5" className="text-sm text-muted-foreground leading-relaxed">
          기본 가정: control-plane(master1) 서버에 <code className="font-mono text-foreground">etcd.service</code> 가 systemd 로 동작하고
          <code className="font-mono text-foreground"> /etc/etcd.env</code> 에 <code className="font-mono text-foreground">ETCDCTL_*</code> 환경변수가 정의됨.
          다르면 "env 파일" 경로를 바꾸거나 env 로드를 끄고 extra env 로 직접 지정 가능.
          SSH 인증정보는 이 실행에만 사용되고 저장되지 않습니다.
        </MacCard>

        {/* 탭 */}
        <div className="flex items-center gap-1 mb-5">
          {(['run', 'logs'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setResult(null); }}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 ${
                tab === t
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t === 'run' ? <><Terminal className="w-3.5 h-3.5" />etcdctl 실행</>
                           : <><ScrollText className="w-3.5 h-3.5" />etcd 서비스 로그</>}
            </button>
          ))}
        </div>

        {/* 타겟 2 : 실행 구성 3 : 결과 5 비율 (10 컬럼 그리드) — mc 클라이언트 콘솔과 동일.
            결과는 항상 같은 자리(우측)에 고정되고 내부에서만 세로 스크롤되어(가로 스크롤 없음)
            컨트롤과 로그가 한 화면 폭 안에 나란히 들어온다. */}
        <div className="grid grid-cols-1 lg:grid-cols-10 gap-5 items-start">
          {/* 좌: 타겟 + 인증 */}
          <MacCard title="타겟" rootClassName="lg:col-span-2 min-w-0" bodyPadding="p-5" className="space-y-4">
            <div>
              <label htmlFor={f('master')} className="block text-sm text-muted-foreground mb-1">master 노드 후보</label>
              <select
                id={f('master')}
                value={selectedMasterName}
                onChange={(e) => { setSelectedMasterName(e.target.value); setCustomHost(''); }}
                disabled={!mastersQ.data?.candidates?.length}
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
              >
                {mastersQ.isLoading && <option>불러오는 중…</option>}
                {(mastersQ.data?.candidates ?? []).map((c: EtcdMasterCandidate) => (
                  <option key={c.name} value={c.name}>
                    {c.name}{c.internalIp ? ` (${c.internalIp})` : ''}
                  </option>
                ))}
                {mastersQ.data && mastersQ.data.candidates.length === 0 && (
                  <option value="">— control-plane 라벨 노드 없음 —</option>
                )}
              </select>
            </div>

            <div>
              <label htmlFor={f('customHost')} className="block text-sm text-muted-foreground mb-1">
                수동 host override <span className="text-xs opacity-60">(비우면 위 드롭다운 사용)</span>
              </label>
              <input
                id={f('customHost')}
                type="text"
                value={customHost}
                onChange={(e) => setCustomHost(e.target.value)}
                placeholder="예: 192.168.10.11"
                className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor={f('user')} className="block text-sm text-muted-foreground mb-1">사용자</label>
                <input
                  id={f('user')}
                  type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label htmlFor={f('port')} className="block text-sm text-muted-foreground mb-1">포트</label>
                <input
                  id={f('port')}
                  type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>

            <div>
              <p className="block text-sm text-muted-foreground mb-1">인증 방식</p>
              <div className="flex items-center bg-secondary/60 rounded-lg p-[3px] gap-px">
                {(['password', 'key'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setAuthMode(m)}
                    className={`flex-1 px-2 py-1.5 text-sm font-medium rounded-md transition-all ${
                      authMode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground/70 hover:text-foreground'
                    }`}
                  >
                    {m === 'password' ? '비밀번호' : 'Private Key'}
                  </button>
                ))}
              </div>
            </div>

            {authMode === 'password' ? (
              <input
                type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="SSH 비밀번호"
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
              />
            ) : (
              <div>
                <label htmlFor={f('pkey')} className="text-sm text-muted-foreground mb-1 flex items-center gap-1">
                  <Key className="w-3 h-3" /> Private Key (PEM)
                </label>
                <textarea
                  id={f('pkey')}
                  value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" rows={4}
                  className="w-full px-3 py-2 text-xs font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                />
              </div>
            )}
          </MacCard>

          {/* 중: 실행 구성 */}
          <MacCard rootClassName="lg:col-span-3 min-w-0" bodyPadding="p-5" className="space-y-4">
            {tab === 'run' ? (
              <>
                {/* 프리셋 */}
                <div>
                  <p className="text-sm text-muted-foreground mb-1.5">프리셋 — 클릭해서 args 에 채워넣기</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(presetsQ.data?.presets ?? []).map((p: EtcdPreset) => (
                      <button
                        key={p.key}
                        onClick={() => setArgs(p.args)}
                        className="px-2.5 py-1 text-xs rounded border border-border bg-secondary hover:bg-secondary/80 text-foreground"
                        title={p.args}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* env file */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="md:col-span-2">
                    <label htmlFor={f('envFile')} className="text-sm text-muted-foreground mb-1 flex items-center gap-1">
                      <FileText className="w-3 h-3" /> env file 경로
                    </label>
                    <input
                      id={f('envFile')}
                      type="text" value={envFile} onChange={(e) => setEnvFile(e.target.value)}
                      disabled={!useEnv}
                      placeholder="/etc/etcd.env"
                      className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
                    />
                  </div>
                  <div className="flex items-end">
                    <label className="flex items-center gap-2 text-sm text-muted-foreground pb-2.5">
                      <input
                        type="checkbox" checked={useEnv} onChange={(e) => setUseEnv(e.target.checked)}
                        className="w-3.5 h-3.5 accent-primary"
                      />
                      실행 전에 source
                    </label>
                  </div>
                </div>

                {/* args */}
                <div>
                  <label htmlFor={f('args')} className="text-sm text-muted-foreground mb-1 flex items-center gap-1">
                    <Terminal className="w-3 h-3" />
                    etcdctl 인자
                    <span className="ml-1 text-xs opacity-60">(예: endpoint health --write-out=table)</span>
                  </label>
                  <textarea
                    id={f('args')}
                    value={args} onChange={(e) => setArgs(e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 text-[12px] font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                  />
                  <SavedCommands
                    className="mt-2"
                    storageKey="k8s:saved-cmd:etcdctl"
                    currentValue={args}
                    onPick={setArgs}
                  />
                </div>

                {/* 기타 */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor={f('etcdctlPath')} className="block text-sm text-muted-foreground mb-1">etcdctl 경로</label>
                    <input
                      id={f('etcdctlPath')}
                      type="text" value={etcdctlPath} onChange={(e) => setEtcdctlPath(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <div>
                    <label htmlFor={f('timeout')} className="block text-sm text-muted-foreground mb-1">timeout (s)</label>
                    <input
                      id={f('timeout')}
                      type="number" value={timeout} onChange={(e) => setTimeoutSec(Number(e.target.value) || 30)}
                      min={1} max={300}
                      className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                </div>

                {runError && (
                  <div className="px-3 py-2 text-sm rounded-lg bg-destructive/10 text-destructive border border-destructive/30">
                    {formatApiError(runError)}
                  </div>
                )}

                <div className="flex justify-end pt-2 border-t border-border">
                  {runMut.isPending ? (
                    <button
                      onClick={runMut.abort}
                      className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-red-500 hover:bg-red-600 text-primary-foreground rounded-lg transition-colors"
                    >
                      <Square className="w-4 h-4 fill-current" />
                      중지
                    </button>
                  ) : (
                    <button
                      onClick={() => setConfirmAction('run')}
                      disabled={!canRunEtcdctl}
                      className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-50"
                    >
                      <Play className="w-4 h-4" />
                      etcdctl 실행
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div>
                    <label htmlFor={f('unit')} className="block text-sm text-muted-foreground mb-1">systemd unit</label>
                    <input
                      id={f('unit')}
                      type="text" value={unit} onChange={(e) => setUnit(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <div>
                    <label htmlFor={f('tail')} className="block text-sm text-muted-foreground mb-1">tail (N 줄)</label>
                    <input
                      id={f('tail')}
                      type="number" value={tail} onChange={(e) => setTail(Number(e.target.value) || 200)}
                      min={1} max={5000}
                      className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <div>
                    <label htmlFor={f('since')} className="block text-sm text-muted-foreground mb-1">since (journalctl)</label>
                    <input
                      id={f('since')}
                      type="text" value={since} onChange={(e) => setSince(e.target.value)}
                      placeholder="예: 10 min ago"
                      className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor={f('grep')} className="block text-sm text-muted-foreground mb-1">
                    grep 필터 <span className="opacity-60">(대소문자 무시)</span>
                  </label>
                  <input
                    id={f('grep')}
                    type="text" value={grep} onChange={(e) => setGrep(e.target.value)}
                    placeholder="예: error 또는 leader"
                    className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>

                {runError && (
                  <div className="px-3 py-2 text-sm rounded-lg bg-destructive/10 text-destructive border border-destructive/30">
                    {formatApiError(runError)}
                  </div>
                )}

                <div className="flex justify-end pt-2 border-t border-border">
                  {logsMut.isPending ? (
                    <button
                      onClick={logsMut.abort}
                      className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-red-500 hover:bg-red-600 text-primary-foreground rounded-lg transition-colors"
                    >
                      <Square className="w-4 h-4 fill-current" />
                      중지
                    </button>
                  ) : (
                    <button
                      onClick={() => setConfirmAction('logs')}
                      disabled={!canRunLogs}
                      className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-50"
                    >
                      <ScrollText className="w-4 h-4" />
                      로그 가져오기
                    </button>
                  )}
                </div>
              </>
            )}
          </MacCard>

          {/* 우: 결과 — 항상 같은 위치(우측)에 고정, 실행 전엔 플레이스홀더 */}
          <ResultPanel result={result} tab={tab} />
        </div>
        </div>
      </main>

      {/* 실행 확인 모달 */}
      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction === 'run' ? 'etcdctl 실행 확인' : 'etcd 서비스 로그 조회 확인'}
        description={confirmAction === 'run'
          ? 'master 노드에 SSH 접속 후 etcdctl 명령을 실행합니다. defrag / compact / snapshot 같은 명령은 etcd 에 영향을 줄 수 있습니다.'
          : 'master 노드에 SSH 접속 후 journalctl 로 로그를 가져옵니다.'}
        confirmLabel={confirmAction === 'run' ? 'etcdctl 실행' : '로그 가져오기'}
        danger={confirmAction === 'run' && /\b(defrag|compact|snapshot|move-leader|alarm\s+disarm|member\s+(add|remove|update))\b/i.test(args)}
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => {
          const which = confirmAction;
          setConfirmAction(null);
          if (which === 'run') runMut.mutate();
          else if (which === 'logs') logsMut.mutate();
        }}
      >
        <div className="space-y-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">타겟</p>
            <p className="font-mono">
              <span className="text-primary">{username}</span>
              <span className="text-muted-foreground">@</span>
              <span className="text-foreground">{effectiveHost}</span>
              <span className="text-muted-foreground">:{port}</span>
              <span className="ml-2 text-xs px-1.5 py-0.5 rounded border border-border bg-secondary">
                {authMode === 'password' ? '비밀번호' : 'Private Key'}
              </span>
            </p>
          </div>
          {confirmAction === 'run' ? (
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">실행</p>
              <pre className="text-xs font-mono bg-background border border-border rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap break-all">
                {useEnv && envFile ? `source ${envFile} && ` : ''}{etcdctlPath} {args}
              </pre>
            </div>
          ) : (
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">journalctl</p>
              <pre className="text-xs font-mono bg-background border border-border rounded p-2 overflow-auto whitespace-pre-wrap">
                journalctl -u {unit} -n {tail}
                {since && ` --since "${since}"`}
                {grep && ` | grep -i "${grep}"`}
              </pre>
            </div>
          )}
        </div>
      </ConfirmDialog>
    </div>
  );
}
