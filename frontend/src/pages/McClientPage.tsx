import { useEffect, useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  HardDrive, Play, Square, CheckCircle, XCircle, AlertTriangle, Key, ShieldAlert, Wifi, Clock, Terminal,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import { useRunLog, runLogged, consoleRunLines, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { ConfirmDialog, ExecOutputTabs, ClusterSidebar, SavedCommands, EmptyState, ErrorState, PageShell, RunLogPanel, useToast } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { MacCard } from '@/components/ui/MacCard';
import { McPresetManager } from '@/components/mc/McPresetManager';
import { mcApi, bulkExecApi, type EtcdCtlRunResponse, type NodeSummary } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import { useTerminalEnvSync } from '@/hooks/useTerminalEnvSync';
import { formatApiError } from '@/lib/utils';
import { maskCommand } from '@/lib/commandMask';
import { judgeCommand } from '@/lib/dangerCommand';

const STATUS_META: Record<EtcdCtlRunResponse['status'], { label: string; cls: string; icon: React.ComponentType<{ className?: string }> }> = {
  ok:            { label: '정상',     cls: 'bg-status-healthy/10 text-status-healthy border-status-healthy/30',  icon: CheckCircle },
  error:         { label: '오류',     cls: 'bg-status-critical/10 text-status-critical border-status-critical/30',              icon: XCircle },
  timeout:       { label: '타임아웃', cls: 'bg-status-warning/10 text-status-warning border-status-warning/30',        icon: Clock },
  auth_error:    { label: '인증 실패', cls: 'bg-status-warning/10 text-status-warning border-status-warning/30',    icon: ShieldAlert },
  connect_error: { label: '연결 실패', cls: 'bg-status-unknown/10 text-status-unknown border-status-unknown/30',       icon: Wifi },
};

/** 실패 토스트 — 서버 403(역할·테넌트 권한 부족)은 사유를 그대로 보여 준다(D-172). 실행 로그에는 runLogged 가 error 줄을 남긴다. */
function toastFailure(toast: ReturnType<typeof useToast>, title: string, error: unknown) {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  toast.error(status === 403 ? `${title} — 권한이 없습니다` : `${title} 실패`, formatApiError(error));
}

function outputLines(res: EtcdCtlRunResponse): RunLogEntry[] {
  const count = (s: string) => (s ? s.split('\n').filter((l) => l.trim()).length : 0);
  return [['info', `출력 stdout ${count(res.stdout)}줄 · stderr ${count(res.stderr)}줄 — 본문은 결과 패널`]];
}

// 타겟/프리셋 옆(우측)에 고정 위치로 배치 — 실행 전에도 같은 자리에 플레이스홀더를 보여줘
// 결과가 나와도 레이아웃이 흔들리지 않는다. 카드 자체는 화면 높이에 맞춰 세로 스크롤만
// 허용(overflow-y-auto) 하고 가로 스크롤은 막는다(overflow-x-hidden) — 좁은 카드 폭 안에
// 긴 로그가 들어와도 페이지 전체가 옆으로 늘어나지 않는다.
function ResultPanel({ result }: { result: EtcdCtlRunResponse | null }) {
  if (!result) {
    return (
      <div className="min-w-0 flex items-center justify-center min-h-[200px] lg:h-[calc(100vh-220px)]">
        <EmptyState
          compact
          icon={Terminal}
          title="아직 실행 결과가 없습니다."
          description="mc 명령을 실행하면 결과가 여기에 표시됩니다."
        />
      </div>
    );
  }
  const meta = STATUS_META[result.status];
  const Icon = meta.icon;
  // 헤더(상태·호스트·exit·소요)는 고정, 본문만 세로 스크롤 — 예전 sticky header 와 같은 동작.
  return (
    <MacCard
      title="실행 결과"
      titleExtra={
        <span className="flex items-center gap-3 flex-wrap min-w-0">
          <span className={`inline-flex items-center gap-1 text-sm px-2 py-0.5 rounded-full border font-medium ${meta.cls}`}>
            <Icon className="w-3 h-3" />
            {meta.label}
          </span>
          <span className="text-sm font-mono text-muted-foreground truncate">{result.host}</span>
          {result.exitCode !== null && result.exitCode !== undefined && (
            <span className="text-sm font-mono text-muted-foreground">exit {result.exitCode}</span>
          )}
          <span className="text-sm text-muted-foreground tabular-nums">{result.durationMs}ms</span>
        </span>
      }
      actions={result.error ? (
        <span className="text-sm text-status-critical inline-flex items-start gap-1"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />{result.error}</span>
      ) : undefined}
      rootClassName="min-w-0 flex flex-col lg:h-[calc(100vh-220px)]"
      bodyPadding="px-5 py-3"
      className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden space-y-3"
    >
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">실행된 명령</p>
        <pre className="text-xs font-mono bg-background border border-border rounded-md p-2 overflow-auto whitespace-pre-wrap break-all text-foreground/80">
          {maskCommand(result.executedCommand) || '(서버가 실행 명령을 돌려주지 않았습니다)'}
        </pre>
      </div>
      <ExecOutputTabs stdout={result.stdout} stderr={result.stderr} maxHeight="max-h-[440px]" />
    </MacCard>
  );
}

export function McClientPage() {
  const clustersQ = useClusters();
  const { data: clusters = [] } = clustersQ;
  const [clusterId, setClusterId] = useState('');
  const toast = useToast();
  const { canOperate, withHint, ariaWithHint } = useCanOperate(clusterId || null);
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
  useTerminalEnvSync(clusters, clusterId || null);

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

  const runMut = useAbortableMutation({
    mutationFn: async (_: void, signal) => {
      const res = await mcApi.run(clusterId, {
        host: effectiveHost, port, username,
        password: authMode === 'password' ? password : undefined,
        privateKey: authMode === 'key' ? privateKey : undefined,
        args, alias, mcPath, timeout,
      }, signal);
      return res.data;
    },
  });

  // 실행 수명주기 로그 — 출력 본문은 결과 패널(ExecOutputTabs), 여기는 요청·대기·결과 요약·실패 사유.
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('mc-client-run');
  const doRun = async () => {
    const cmd = maskCommand(`${mcPath} ${args.replace(/\{alias\}/g, alias)}`);
    const r = await runLogged(runLog, {
      title: 'mc 실행',
      first: `${username}@${effectiveHost}:${port} 에 SSH 접속 후 실행 요청 — ${cmd} (timeout ${timeout}s)`,
      fn: () => runMut.mutateAsync(),
      summarize: (res) => [...consoleRunLines(res), ...outputLines(res)],
    });
    if (r.ok) setResult(r.data);
    else if (!r.aborted) toastFailure(toast, 'mc 실행', r.error);
  };

  const canRun = !!clusterId && !!effectiveHost && !!args.trim()
    && (authMode === 'password' ? !!password : !!privateKey.trim());

  const runError = runMut.error as { response?: { data?: { detail?: string } }; message?: string } | null;

  // D-171 — 조회 allowlist(ls·stat·du·admin info·admin * list/info/status 등) 밖 명령은 전부 danger 확인.
  const resolvedArgs = args.replace(/\{alias\}/g, alias);
  const verdict = useMemo(() => judgeCommand(resolvedArgs, 'mc'), [resolvedArgs]);
  const isDanger = !verdict.readOnly;

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
        <ClusterSidebar clusters={clusters} selectedId={clusterId || null} onSelect={(id) => { setClusterId(id ?? ''); setResult(null); }} iconOnly />

        <div className="flex-1 min-w-0">
          <PageHeader
            className="mb-6"
            icon={HardDrive}
            title="mc 클라이언트 콘솔"
            titleExtra={effectiveHost ? (
              <span className="text-sm px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border font-mono">
                → {effectiveHost}
              </span>
            ) : undefined}
          />

          <p className="mb-5 text-sm text-muted-foreground leading-relaxed">
            MinIO <code className="font-mono text-foreground">mc</code> 가 설치된 호스트에 SSH 로 접속해 명령을 실행합니다.
            조회 명령(ls·stat·du·admin info 등) 밖의 명령은 위험 확인을 거칩니다. alias 는 미리 <code className="font-mono text-foreground">mc alias set</code> 으로 구성돼 있어야 합니다 (기본값: <code className="font-mono text-foreground">local</code>). 프리셋의 <code className="font-mono text-foreground">{'{alias}'}</code> 는 아래 alias 값으로 치환됩니다.
          </p>

          {/* 타겟 2 : 프리셋 3 : 결과 5 비율 (10 컬럼 그리드) — 결과는 항상 같은 자리(우측)에 고정,
              내부에서만 세로 스크롤(가로 스크롤 없음)되어 카드들이 한 화면 폭 안에 들어온다. */}
          {clustersQ.isError ? (
            <ErrorState error={clustersQ.error} title="클러스터 목록을 불러오지 못했습니다" onRetry={() => { void clustersQ.refetch(); }} />
          ) : (
          <div className="grid grid-cols-1 lg:grid-cols-10 gap-5 items-start">
            {/* 좌: 타겟 + 인증 */}
            <MacCard title="타겟" rootClassName="lg:col-span-2 min-w-0" bodyPadding="p-5" className="space-y-4">
              <div>
                <label htmlFor={f('node')} className="block text-sm text-muted-foreground mb-1">호스트 (mc 설치된 노드)</label>
                <select
                  id={f('node')}
                  value={selectedNodeName}
                  onChange={(e) => { setSelectedNodeName(e.target.value); setCustomHost(''); }}
                  disabled={!nodesQ.data?.nodes?.length}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
                >
                  {(nodesQ.data?.nodes ?? []).map((n: NodeSummary) => (
                    <option key={n.name} value={n.name}>
                      {n.name}{n.internalIp ? ` (${n.internalIp})` : ''}
                    </option>
                  ))}
                  {nodesQ.isLoading && <option value="">불러오는 중…</option>}
                  {nodesQ.data && nodesQ.data.nodes.length === 0 && <option value="">— 노드 없음 —</option>}
                </select>
                {nodesQ.isError && (
                  <div className="mt-2">
                    <ErrorState compact error={nodesQ.error} title="노드 목록을 불러오지 못했습니다" onRetry={() => { void nodesQ.refetch(); }} />
                  </div>
                )}
              </div>

              <div>
                <label htmlFor={f('host')} className="block text-sm text-muted-foreground mb-1">호스트 직접 입력 <span className="text-xs opacity-60">(비우면 위 노드 사용)</span></label>
                <input
                  id={f('host')}
                  type="text"
                  value={customHost}
                  onChange={(e) => setCustomHost(e.target.value)}
                  placeholder="예: 10.0.0.42"
                  className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor={f('user')} className="block text-sm text-muted-foreground mb-1">사용자</label>
                  <input id={f('user')} type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary" />
                </div>
                <div>
                  <label htmlFor={f('port')} className="block text-sm text-muted-foreground mb-1">포트</label>
                  <input id={f('port')} type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)}
                    className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary" />
                </div>
              </div>

              <div>
                <p id={f('authLabel')} className="block text-sm text-muted-foreground mb-1">인증</p>
                <div role="group" aria-labelledby={f('authLabel')} className="flex items-center bg-secondary/60 rounded-xl p-[3px] gap-px">
                  {(['password', 'key'] as const).map((m) => (
                    <button key={m} type="button" aria-pressed={authMode === m} onClick={() => setAuthMode(m)}
                      className={`flex-1 px-2 py-1.5 text-sm font-medium rounded-md transition-colors ${
                        authMode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                      }`}>
                      {m === 'password' ? '비밀번호' : '개인키'}
                    </button>
                  ))}
                </div>
              </div>
              {authMode === 'password' ? (
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  aria-label="SSH 비밀번호" autoComplete="off"
                  placeholder="SSH 비밀번호"
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary" />
              ) : (
                <div>
                  <label htmlFor={f('pkey')} className="text-sm text-muted-foreground mb-1 flex items-center gap-1"><Key className="w-3 h-3" aria-hidden="true" /> 개인키(PEM)</label>
                  <textarea id={f('pkey')} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} rows={4}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    className="w-full px-3 py-2 text-xs font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary resize-none" />
                </div>
              )}
            </MacCard>

            {/* 중: 프리셋 + 명령 */}
            <MacCard title="명령" rootClassName="lg:col-span-3 min-w-0" bodyPadding="p-5" className="space-y-4">
              <McPresetManager clusterId={clusterId} isAdmin={isAdmin} onPick={setArgs} />

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label htmlFor={f('alias')} className="block text-sm text-muted-foreground mb-1">alias 이름</label>
                  <input id={f('alias')} type="text" value={alias} onChange={(e) => setAlias(e.target.value)}
                    placeholder="local"
                    className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary" />
                </div>
                <div className="md:col-span-2">
                  <label htmlFor={f('mcPath')} className="block text-sm text-muted-foreground mb-1">mc 경로</label>
                  <input id={f('mcPath')} type="text" value={mcPath} onChange={(e) => setMcPath(e.target.value)}
                    placeholder="mc"
                    className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary" />
                </div>
              </div>

              <div>
                <label htmlFor={f('args')} className="text-sm text-muted-foreground mb-1 flex items-center gap-1">
                  <Terminal className="w-3 h-3" /> mc 인자
                  <span className="ml-1 text-xs opacity-60">{'{alias}'} 는 위 alias 값으로 치환</span>
                </label>
                <textarea id={f('args')} value={args} onChange={(e) => setArgs(e.target.value)} rows={3}
                  className="w-full px-3 py-2 text-xs font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary resize-none" />
                <SavedCommands
                  className="mt-2"
                  storageKey="k8s:saved-cmd:mc"
                  currentValue={args}
                  onPick={setArgs}
                />
              </div>

              <div>
                <label htmlFor={f('timeout')} className="block text-sm text-muted-foreground mb-1">제한 시간(초)</label>
                <input id={f('timeout')} type="number" value={timeout} onChange={(e) => setTimeoutSec(Number(e.target.value) || 60)}
                  min={1} max={600}
                  className="w-32 px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary" />
              </div>

              {runError && (
                <div role="alert" className="px-3 py-2 text-sm rounded-md bg-status-critical/10 text-status-critical border border-status-critical/30">
                  {formatApiError(runError)}
                </div>
              )}

              <div className="flex justify-end pt-2 border-t border-border">
                {runMut.isPending ? (
                  <button
                    onClick={runMut.abort}
                    className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-secondary hover:bg-secondary/80 text-foreground border border-border rounded-xl transition-colors"
                  >
                    <Square className="w-4 h-4 fill-current" />
                    중지
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirmOpen(true)}
                    disabled={!canOperate || !canRun}
                    title={withHint('mc 실행')}
                    aria-label={ariaWithHint('mc 실행')}
                    className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Play className="w-4 h-4" />
                    mc 실행
                  </button>
                )}
              </div>
            </MacCard>

            {/* 우: 실행 로그(수명주기) + 결과 — 항상 같은 위치(우측)에 고정, 실행 전엔 플레이스홀더 */}
            <div className="lg:col-span-5 min-w-0 flex flex-col gap-3">
              <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
              <ResultPanel result={result} />
            </div>
          </div>
          )}
        </div>
      </PageShell>

      <ConfirmDialog
        open={confirmOpen}
        title="mc 명령 실행 확인"
        description={isDanger
          ? `${effectiveHost} 에 SSH 접속 후 mc 명령을 실행합니다. 조회 명령이 아니므로 버킷·객체·서버 설정을 되돌릴 수 없게 바꿀 수 있습니다.`
          : `${effectiveHost} 에 SSH 접속 후 mc 조회 명령(${verdict.subcommand})을 실행합니다.`}
        confirmLabel="mc 실행"
        danger={isDanger}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); void doRun(); }}
      >
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">타겟</p>
            <p className="font-mono">
              <span className="text-primary">{username}</span>
              <span className="text-muted-foreground">@</span>
              <span className="text-foreground">{effectiveHost}</span>
              <span className="text-muted-foreground">:{port}</span>
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">실행</p>
            <pre className="text-xs font-mono bg-background border border-border rounded-md p-2 max-h-32 overflow-auto whitespace-pre-wrap break-all">
              {maskCommand(`${mcPath} ${resolvedArgs}`)}
            </pre>
          </div>
          {verdict.reason && (
            <p className="text-sm text-status-critical flex items-start gap-1.5">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
              <span>{verdict.reason}</span>
            </p>
          )}
        </div>
      </ConfirmDialog>
    </div>
  );
}
