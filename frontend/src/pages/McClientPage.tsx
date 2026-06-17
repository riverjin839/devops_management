import { useEffect, useId, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  HardDrive, Play, Loader2, CheckCircle, XCircle, Key, ShieldAlert, Wifi, Clock, Terminal,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { ConfirmDialog, LogViewer, ClusterSidebar, SavedCommands } from '@/components/common';
import { McPresetManager } from '@/components/mc/McPresetManager';
import { mcApi, bulkExecApi, type EtcdCtlRunResponse, type NodeSummary } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import { useTerminalEnvStore } from '@/stores/terminalEnvStore';
import { envForOperationLevel } from '@/lib/terminalThemes';
import { formatApiError } from '@/lib/utils';

const STATUS_META: Record<EtcdCtlRunResponse['status'], { label: string; cls: string; icon: React.ComponentType<{ className?: string }> }> = {
  ok:            { label: '정상',     cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',  icon: CheckCircle },
  error:         { label: '에러',     cls: 'bg-red-500/10 text-red-400 border-red-500/30',              icon: XCircle },
  timeout:       { label: '타임아웃', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30',        icon: Clock },
  auth_error:    { label: '인증 실패', cls: 'bg-orange-500/10 text-orange-400 border-orange-500/30',    icon: ShieldAlert },
  connect_error: { label: '연결 실패', cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30',       icon: Wifi },
};

function ResultPanel({ result }: { result: EtcdCtlRunResponse }) {
  const meta = STATUS_META[result.status];
  const Icon = meta.icon;
  return (
    <section className="bg-card border border-border rounded-xl overflow-hidden mt-5">
      <header className="px-5 py-3 border-b border-border flex items-center justify-between bg-muted/20">
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-1 text-sm px-2 py-0.5 rounded-full border font-medium ${meta.cls}`}>
            <Icon className="w-3 h-3" />
            {meta.label}
          </span>
          <span className="text-sm font-mono text-muted-foreground">{result.host}</span>
          {result.exitCode !== null && result.exitCode !== undefined && (
            <span className="text-sm font-mono text-muted-foreground">exit {result.exitCode}</span>
          )}
          <span className="text-sm font-mono text-muted-foreground">{result.durationMs}ms</span>
        </div>
        {result.error && <span className="text-sm text-red-400">⚠ {result.error}</span>}
      </header>
      <div className="px-5 py-3 space-y-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">executed</p>
          <pre className="text-xs font-mono bg-background border border-border rounded p-2 overflow-auto whitespace-pre-wrap text-foreground/80">
            {result.executedCommand || '(not provided)'}
          </pre>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">stdout</p>
          <LogViewer text={result.stdout} maxHeight="max-h-[440px]" />
        </div>
        {result.stderr && (
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">stderr</p>
            <LogViewer text={result.stderr} maxHeight="max-h-[260px]" asError />
          </div>
        )}
      </div>
    </section>
  );
}

export function McClientPage() {
  const { data: clusters = [] } = useClusters();
  const [clusterId, setClusterId] = useState('');
  useEffect(() => {
    if (!clusterId && clusters.length > 0) setClusterId(clusters[0].id);
  }, [clusters, clusterId]);

  // 호스트 선택 — 노드 리스트 재사용 + 수동 override
  const nodesQ = useQuery({
    queryKey: ['bulk-exec', 'nodes', clusterId],
    queryFn: () => bulkExecApi.nodeList(clusterId).then((r) => r.data),
    enabled: !!clusterId,
  });
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');

  // 선택한 클러스터의 운영등급에 따라 터미널 Appearance 활성 프로파일(개발/운영)을 결정.
  const setCurrentEnv = useTerminalEnvStore((s) => s.setCurrentEnv);
  useEffect(() => {
    const c = clusters.find((x) => x.id === clusterId);
    setCurrentEnv(clusterId ? envForOperationLevel(c?.operationLevel) : null);
  }, [clusterId, clusters, setCurrentEnv]);

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const [selectedNodeName, setSelectedNodeName] = useState('');
  const [customHost, setCustomHost] = useState('');
  useEffect(() => { setSelectedNodeName(''); setCustomHost(''); }, [clusterId]);
  useEffect(() => {
    if (!selectedNodeName && nodesQ.data?.nodes?.length) {
      // master 우선, 없으면 첫 노드
      const master = nodesQ.data.nodes.find((n: NodeSummary) => n.roles.includes('control-plane'));
      setSelectedNodeName(master?.name ?? nodesQ.data.nodes[0].name);
    }
  }, [nodesQ.data, selectedNodeName]);

  const effectiveHost = (() => {
    if (customHost.trim()) return customHost.trim();
    const n = (nodesQ.data?.nodes ?? []).find((x: NodeSummary) => x.name === selectedNodeName);
    return n?.internalIp || n?.name || '';
  })();

  const [port, setPort] = useState(22);
  const [username, setUsername] = useState('root');
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [args, setArgs] = useState('admin info {alias}');
  const [alias, setAlias] = useState('local');
  const [mcPath, setMcPath] = useState('mc');
  const [timeout, setTimeoutSec] = useState(60);

  const [result, setResult] = useState<EtcdCtlRunResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const runMut = useMutation({
    mutationFn: async () => {
      const res = await mcApi.run(clusterId, {
        host: effectiveHost, port, username,
        password: authMode === 'password' ? password : undefined,
        privateKey: authMode === 'key' ? privateKey : undefined,
        args, alias, mcPath, timeout,
      });
      return res.data;
    },
    onSuccess: (d) => setResult(d),
  });

  const canRun = !!clusterId && !!effectiveHost && !!args.trim()
    && (authMode === 'password' ? !!password : !!privateKey.trim());

  const runError = runMut.error as { response?: { data?: { detail?: string } }; message?: string } | null;

  // args 에 위험 키워드 있으면 danger=true (rm, admin service stop/restart, config reset 등)
  const dangerKeywords = /\b(rm|rb|mirror|admin\s+service\s+(stop|restart|unfreeze|freeze)|admin\s+config\s+reset|policy\s+set|admin\s+user\s+remove|admin\s+user\s+disable|admin\s+heal\s+(?!--dry-run))\b/i;
  const isDanger = dangerKeywords.test(args);

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto px-6 py-6 flex gap-5">
        <ClusterSidebar clusters={clusters} selectedId={clusterId || null} onSelect={(id) => { setClusterId(id ?? ''); setResult(null); }} iconOnly />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-6">
            <HardDrive className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">mc 클라이언트 콘솔</h1>
            {effectiveHost && (
              <span className="text-sm px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-400 border border-slate-500/30 font-mono">
                → {effectiveHost}
              </span>
            )}
          </div>

          <div className="bg-card border border-border rounded-xl p-4 mb-5 text-sm text-muted-foreground leading-relaxed">
            MinIO <code className="font-mono text-foreground">mc</code> 가 설치된 호스트에 SSH 로 접속해 명령 실행.
            alias 는 미리 <code className="font-mono text-foreground">mc alias set</code> 으로 구성돼 있어야 합니다 (기본값: <code className="font-mono text-foreground">local</code>). 프리셋의 <code className="font-mono text-foreground">{'{alias}'}</code> 는 아래 alias 값으로 치환됩니다.
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* 좌: 타겟 + 인증 */}
            <section className="bg-card border border-border rounded-xl p-5 space-y-4">
              <h2 className="text-sm font-semibold mb-1">타겟</h2>

              <div>
                <label htmlFor={f('node')} className="block text-sm text-muted-foreground mb-1">호스트 (mc 설치된 노드)</label>
                <select
                  id={f('node')}
                  value={selectedNodeName}
                  onChange={(e) => { setSelectedNodeName(e.target.value); setCustomHost(''); }}
                  disabled={!nodesQ.data?.nodes?.length}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
                >
                  {(nodesQ.data?.nodes ?? []).map((n: NodeSummary) => (
                    <option key={n.name} value={n.name}>
                      {n.name}{n.internalIp ? ` (${n.internalIp})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor={f('host')} className="block text-sm text-muted-foreground mb-1">수동 host override</label>
                <input
                  id={f('host')}
                  type="text"
                  value={customHost}
                  onChange={(e) => setCustomHost(e.target.value)}
                  placeholder="예: 10.0.0.42"
                  className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor={f('user')} className="block text-sm text-muted-foreground mb-1">사용자</label>
                  <input id={f('user')} type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
                </div>
                <div>
                  <label htmlFor={f('port')} className="block text-sm text-muted-foreground mb-1">포트</label>
                  <input id={f('port')} type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)}
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
                </div>
              </div>

              <div>
                <p className="block text-sm text-muted-foreground mb-1">인증</p>
                <div className="flex items-center bg-secondary/60 rounded-lg p-[3px] gap-px">
                  {(['password', 'key'] as const).map((m) => (
                    <button key={m} onClick={() => setAuthMode(m)}
                      className={`flex-1 px-2 py-1.5 text-sm font-medium rounded-md transition-all ${
                        authMode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground/70 hover:text-foreground'
                      }`}>
                      {m === 'password' ? '비밀번호' : 'Private Key'}
                    </button>
                  ))}
                </div>
              </div>
              {authMode === 'password' ? (
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="SSH 비밀번호"
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
              ) : (
                <div>
                  <label htmlFor={f('pkey')} className="text-sm text-muted-foreground mb-1 flex items-center gap-1"><Key className="w-3 h-3" /> Private Key (PEM)</label>
                  <textarea id={f('pkey')} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} rows={4}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    className="w-full px-3 py-2 text-xs font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary resize-none" />
                </div>
              )}
            </section>

            {/* 우: 프리셋 + 명령 */}
            <section className="lg:col-span-2 bg-card border border-border rounded-xl p-5 space-y-4">
              <McPresetManager clusterId={clusterId} isAdmin={isAdmin} onPick={setArgs} />

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label htmlFor={f('alias')} className="block text-sm text-muted-foreground mb-1">alias 이름</label>
                  <input id={f('alias')} type="text" value={alias} onChange={(e) => setAlias(e.target.value)}
                    placeholder="local"
                    className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
                </div>
                <div className="md:col-span-2">
                  <label htmlFor={f('mcPath')} className="block text-sm text-muted-foreground mb-1">mc 경로</label>
                  <input id={f('mcPath')} type="text" value={mcPath} onChange={(e) => setMcPath(e.target.value)}
                    placeholder="mc"
                    className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
                </div>
              </div>

              <div>
                <label htmlFor={f('args')} className="text-sm text-muted-foreground mb-1 flex items-center gap-1">
                  <Terminal className="w-3 h-3" /> mc 인자
                  <span className="ml-1 text-xs opacity-60">{'{alias}'} 는 위 alias 값으로 치환</span>
                </label>
                <textarea id={f('args')} value={args} onChange={(e) => setArgs(e.target.value)} rows={3}
                  className="w-full px-3 py-2 text-[12px] font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary resize-none" />
                <SavedCommands
                  className="mt-2"
                  storageKey="k8s:saved-cmd:mc"
                  currentValue={args}
                  onPick={setArgs}
                />
              </div>

              <div>
                <label htmlFor={f('timeout')} className="block text-sm text-muted-foreground mb-1">timeout (s)</label>
                <input id={f('timeout')} type="number" value={timeout} onChange={(e) => setTimeoutSec(Number(e.target.value) || 60)}
                  min={1} max={600}
                  className="w-32 px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
              </div>

              {runError && (
                <div className="px-3 py-2 text-sm rounded-lg bg-destructive/10 text-destructive border border-destructive/30">
                  {formatApiError(runError)}
                </div>
              )}

              <div className="flex justify-end pt-2 border-t border-border">
                <button
                  onClick={() => setConfirmOpen(true)}
                  disabled={!canRun || runMut.isPending}
                  className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-50"
                >
                  {runMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  mc 실행
                </button>
              </div>
            </section>
          </div>

          {result && <ResultPanel result={result} />}
        </div>
      </main>

      <ConfirmDialog
        open={confirmOpen}
        title="mc 명령 실행 확인"
        description={`${effectiveHost} 에 SSH 접속 후 mc 명령을 실행합니다.`}
        confirmLabel="mc 실행"
        danger={isDanger}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); runMut.mutate(); }}
      >
        <div className="space-y-3">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">타겟</p>
            <p className="font-mono">
              <span className="text-primary">{username}</span>
              <span className="text-muted-foreground">@</span>
              <span className="text-foreground">{effectiveHost}</span>
              <span className="text-muted-foreground">:{port}</span>
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">실행</p>
            <pre className="text-xs font-mono bg-background border border-border rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap break-all">
              {mcPath} {args.replace(/\{alias\}/g, alias)}
            </pre>
          </div>
          {isDanger && (
            <div className="text-sm text-red-400 border border-red-500/30 bg-red-500/5 rounded p-2">
              ⚠ 쓰기 성격 명령(rm/mirror/admin service restart/policy set 등)이 감지되었습니다. 정말 진행하시겠습니까?
            </div>
          )}
        </div>
      </ConfirmDialog>
    </div>
  );
}
