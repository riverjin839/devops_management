import { useEffect, useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  HardDrive, Play, Square, CheckCircle, XCircle, AlertTriangle, Key, ShieldAlert, Wifi, Clock, Terminal,
  ChevronDown, ChevronRight,
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

/** 권한 부족(403)만 토스트로 알린다 — 그 밖의 실패는 실행 로그의 error 줄과 실행 바 위 알림 한 곳으로 모은다(§12.6.1). */
function toastForbidden(toast: ReturnType<typeof useToast>, title: string, error: unknown) {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  if (status === 403) toast.error(`${title} — 권한이 없습니다`, formatApiError(error));
}

function outputLines(res: EtcdCtlRunResponse): RunLogEntry[] {
  const count = (s: string) => (s ? s.split('\n').filter((l) => l.trim()).length : 0);
  return [['info', `출력 stdout ${count(res.stdout)}줄 · stderr ${count(res.stderr)}줄 — 본문은 결과 패널`]];
}

// 로그 중심 콘솔(DESIGN_SYSTEM §12.6.1): 우측 열은 실행 로그(3) + 결과(2) 가 한 높이를 나눠 쓴다.
// 결과 카드는 실행 전에도 같은 자리에 플레이스홀더로 존재하고, 스크롤은 카드 내부에서 한 번만 일어난다.
function ResultPanel({ result }: { result: EtcdCtlRunResponse | null }) {
  if (!result) {
    return (
      <div className="min-w-0 flex-1 flex items-center justify-center min-h-[120px] rounded-md border border-border">
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
      rootClassName="min-w-0 flex flex-col flex-1 min-h-0"
      bodyPadding="px-5 py-3"
      className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden space-y-3"
    >
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-1">실행된 명령</p>
        <pre className="text-xs font-mono bg-background border border-border rounded-md p-2 overflow-auto whitespace-pre-wrap break-all text-foreground/80">
          {maskCommand(result.executedCommand) || '(서버가 실행 명령을 돌려주지 않았습니다)'}
        </pre>
      </div>
      <ExecOutputTabs stdout={result.stdout} stderr={result.stderr} maxHeight="max-h-none" />
    </MacCard>
  );
}

const INPUT = 'w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary';
const LABEL = 'block text-sm text-muted-foreground mb-1';

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
  const [targetOpen, setTargetOpen] = useState(true);
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

  // 실행 수명주기 로그 — 화면의 중심. 출력 본문은 결과 패널(ExecOutputTabs), 여기는 요청·대기·결과 요약·실패 사유.
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('mc-client-run');
  const target = `${username}@${effectiveHost}:${port}`;
  const resolvedArgs = args.replace(/\{alias\}/g, alias);
  const commandMasked = maskCommand(`${mcPath} ${resolvedArgs}`);
  const doRun = async () => {
    const r = await runLogged(runLog, {
      title: 'mc 실행',
      first: `${target} 에 SSH 접속 후 실행 요청 — ${commandMasked} (timeout ${timeout}s)`,
      fn: () => runMut.mutateAsync(),
      summarize: (res) => [...consoleRunLines(res), ...outputLines(res)],
    });
    if (r.ok) setResult(r.data);
    else if (!r.aborted) toastForbidden(toast, 'mc 실행', r.error);
  };

  const canRun = !!clusterId && !!effectiveHost && !!args.trim()
    && (authMode === 'password' ? !!password : !!privateKey.trim());

  const runError = runMut.error as { response?: { data?: { detail?: string } }; message?: string } | null;

  // D-171 — 조회 allowlist(ls·stat·du·admin info·admin * list/info/status 등) 밖 명령만 danger 확인.
  // 조회 명령은 확인 없이 바로 실행한다(§12.6.1 — 읽기까지 모달을 거치면 위험 경고가 무뎌진다).
  const verdict = useMemo(() => judgeCommand(resolvedArgs, 'mc'), [resolvedArgs]);
  const requestRun = () => {
    if (!canOperate || !canRun || runMut.isPending) return;
    if (verdict.readOnly) void doRun();
    else setConfirmOpen(true);
  };

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
        <ClusterSidebar clusters={clusters} selectedId={clusterId || null} onSelect={(id) => { setClusterId(id ?? ''); setResult(null); }} iconOnly />

        <div className="flex-1 min-w-0">
          <PageHeader
            className="mb-3"
            icon={HardDrive}
            title="mc 클라이언트 콘솔"
            description={<>MinIO <code className="font-mono text-foreground">mc</code> 가 설치된 호스트에 SSH 로 접속해 명령을 실행합니다. 조회 명령(ls·stat·du·admin info 등)은 바로, 그 밖의 명령은 위험 확인 후 실행합니다.</>}
            titleExtra={effectiveHost ? (
              <span className="text-sm px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border font-mono">
                → {effectiveHost}
              </span>
            ) : undefined}
          />

          {/* 로그 중심 콘솔 — 좌: 제어(좁게), 우: 실행 로그(3) + 결과(2). 실행 로그가 화면의 중심이다. */}
          {clustersQ.isError ? (
            <ErrorState error={clustersQ.error} title="클러스터 목록을 불러오지 못했습니다" onRetry={() => { void clustersQ.refetch(); }} />
          ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-3 lg:h-[calc(100vh-var(--topbar-h)-10rem)] lg:min-h-[480px]">
            {/* 좌: 제어 */}
            <MacCard title="제어" rootClassName="min-w-0 flex flex-col lg:min-h-0" bodyPadding="p-0" className="flex flex-col flex-1 min-h-0">
              <div className="flex-1 min-h-0 overflow-y-auto">
                <section className="border-b border-border">
                  <button
                    type="button"
                    onClick={() => setTargetOpen((v) => !v)}
                    aria-expanded={targetOpen}
                    aria-controls={f('target')}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-left hover:bg-secondary/50"
                  >
                    {targetOpen ? <ChevronDown className="w-3.5 h-3.5" aria-hidden /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden />}
                    대상·인증
                    <span className="ml-auto text-xs font-mono font-normal text-muted-foreground truncate">
                      {effectiveHost ? `${target} · ${authMode === 'password' ? '비밀번호' : '개인키'}` : '대상 미선택'}
                    </span>
                  </button>
                  {targetOpen && (
                    <div id={f('target')} className="px-4 pb-4 space-y-3">
                      <div>
                        <label htmlFor={f('node')} className={LABEL}>호스트 (mc 설치된 노드)</label>
                        <select
                          id={f('node')}
                          value={selectedNodeName}
                          onChange={(e) => { setSelectedNodeName(e.target.value); setCustomHost(''); }}
                          disabled={!nodesQ.data?.nodes?.length}
                          className={`${INPUT} disabled:opacity-50`}
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
                        <label htmlFor={f('host')} className={LABEL}>호스트 직접 입력</label>
                        <input
                          id={f('host')}
                          type="text"
                          value={customHost}
                          onChange={(e) => setCustomHost(e.target.value)}
                          placeholder="예: 10.0.0.42"
                          className={`${INPUT} font-mono`}
                        />
                        <p className="mt-1 text-xs text-muted-foreground">비우면 위 노드를 사용합니다.</p>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label htmlFor={f('user')} className={LABEL}>사용자</label>
                          <input id={f('user')} type="text" value={username} onChange={(e) => setUsername(e.target.value)} className={INPUT} />
                        </div>
                        <div>
                          <label htmlFor={f('port')} className={LABEL}>포트</label>
                          <input id={f('port')} type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)} className={INPUT} />
                        </div>
                      </div>
                      <div>
                        <p id={f('authLabel')} className={LABEL}>인증 방식</p>
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
                        <div>
                          <label htmlFor={f('pw')} className={LABEL}>SSH 비밀번호</label>
                          <input id={f('pw')} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                            autoComplete="off" className={INPUT} />
                          <p className="mt-1 text-xs text-muted-foreground">이 실행에만 쓰이며 저장되지 않습니다.</p>
                        </div>
                      ) : (
                        <div>
                          <label htmlFor={f('pkey')} className={`${LABEL} flex items-center gap-1`}>
                            <Key className="w-3 h-3" aria-hidden="true" /> 개인키(PEM)
                          </label>
                          <textarea id={f('pkey')} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} rows={4}
                            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                            className={`${INPUT} text-xs font-mono resize-none`} />
                          <p className="mt-1 text-xs text-muted-foreground">이 실행에만 쓰이며 저장되지 않습니다.</p>
                        </div>
                      )}
                    </div>
                  )}
                </section>

                <div className="px-4 py-3 space-y-3">
                  <McPresetManager clusterId={clusterId} isAdmin={isAdmin} onPick={setArgs} />

                  <div>
                    <label htmlFor={f('args')} className={`${LABEL} flex items-center gap-1`}>
                      <Terminal className="w-3 h-3" aria-hidden /> mc 인자
                    </label>
                    <textarea
                      id={f('args')}
                      value={args} onChange={(e) => setArgs(e.target.value)}
                      onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); requestRun(); } }}
                      rows={3}
                      aria-describedby={`${f('argsHelp')} ${f('verdict')}`}
                      className={`${INPUT} text-xs font-mono resize-none`}
                    />
                    <p id={f('argsHelp')} className="mt-1 text-xs text-muted-foreground">
                      <code className="font-mono">{'{alias}'}</code> 는 아래 alias 값으로 치환됩니다.
                    </p>
                    <p
                      id={f('verdict')}
                      aria-live="polite"
                      className={`mt-1.5 text-xs flex items-start gap-1.5 ${verdict.readOnly ? 'text-muted-foreground' : 'text-status-critical'}`}
                    >
                      <span className="shrink-0 rounded-full border border-current px-2 font-semibold">
                        {verdict.readOnly ? '조회 명령' : '변경 명령'}
                      </span>
                      <span>{verdict.readOnly ? '확인 없이 바로 실행됩니다.' : '실행 전에 확인합니다.'}</span>
                    </p>
                    <SavedCommands
                      className="mt-2"
                      storageKey="k8s:saved-cmd:mc"
                      currentValue={args}
                      onPick={setArgs}
                    />
                  </div>

                  <details className="group">
                    <summary className="cursor-pointer text-sm font-semibold list-none flex items-center gap-1.5">
                      <ChevronRight className="w-3.5 h-3.5 group-open:rotate-90 transition-transform" aria-hidden />
                      고급 설정
                      <span className="text-xs font-normal text-muted-foreground truncate">alias {alias || '-'} · {mcPath || 'mc'} · {timeout}s</span>
                    </summary>
                    <div className="mt-2 space-y-3">
                      <div>
                        <label htmlFor={f('alias')} className={LABEL}>alias 이름</label>
                        <input id={f('alias')} type="text" value={alias} onChange={(e) => setAlias(e.target.value)}
                          placeholder="local" className={`${INPUT} font-mono`} />
                        <p className="mt-1 text-xs text-muted-foreground">
                          호스트에 <code className="font-mono">mc alias set</code> 으로 미리 구성돼 있어야 합니다.
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label htmlFor={f('mcPath')} className={LABEL}>mc 경로</label>
                          <input id={f('mcPath')} type="text" value={mcPath} onChange={(e) => setMcPath(e.target.value)}
                            placeholder="mc" className={`${INPUT} font-mono`} />
                        </div>
                        <div>
                          <label htmlFor={f('timeout')} className={LABEL}>제한 시간(초)</label>
                          <input id={f('timeout')} type="number" value={timeout} onChange={(e) => setTimeoutSec(Number(e.target.value) || 60)}
                            min={1} max={600} className={INPUT} />
                        </div>
                      </div>
                    </div>
                  </details>
                </div>
              </div>

              {/* 실행 바 — 스크롤과 무관하게 항상 보인다. */}
              <div className="border-t border-border p-3 space-y-2">
                {runError && (
                  <div role="alert" className="px-3 py-2 text-sm rounded-md bg-status-critical/10 text-status-critical border border-status-critical/30">
                    {formatApiError(runError)}
                  </div>
                )}
                {runMut.isPending ? (
                  <button
                    type="button"
                    onClick={runMut.abort}
                    className="w-full flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold bg-secondary hover:bg-secondary/80 text-foreground border border-border rounded-xl transition-colors"
                  >
                    <Square className="w-4 h-4 fill-current" />
                    중지
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={requestRun}
                    disabled={!canOperate || !canRun}
                    title={withHint('mc 실행')}
                    aria-label={ariaWithHint('mc 실행')}
                    className="w-full flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Play className="w-4 h-4" />
                    mc 실행
                  </button>
                )}
                <p className="text-center text-xs text-muted-foreground">
                  <kbd className="px-1 rounded border border-border bg-secondary">Ctrl</kbd>+<kbd className="px-1 rounded border border-border bg-secondary">Enter</kbd> 로도 실행
                </p>
              </div>
            </MacCard>

            {/* 우: 실행 로그(중심) + 결과 — 항상 같은 위치, 실행 전엔 대기 상태 */}
            <div className="min-w-0 min-h-0 flex flex-col gap-3">
              <div className="flex flex-col min-h-[240px] lg:min-h-0 flex-[3]">
                <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} fill />
              </div>
              <div className="flex flex-col min-h-[200px] lg:min-h-0 flex-[2]">
                <ResultPanel result={result} />
              </div>
            </div>
          </div>
          )}
        </div>
      </PageShell>

      {/* 변경(비조회) 명령 확인 모달 — 조회 명령은 확인 없이 실행한다. */}
      <ConfirmDialog
        open={confirmOpen}
        title="변경 명령 실행 확인"
        description={`${effectiveHost} 에 SSH 접속 후 mc 명령을 실행합니다. 조회 명령이 아니므로 버킷·객체·서버 설정을 되돌릴 수 없게 바꿀 수 있습니다.`}
        confirmLabel="mc 실행"
        danger
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => { setConfirmOpen(false); void doRun(); }}
      >
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">대상</p>
            <p className="font-mono">
              <span className="text-primary">{username}</span>
              <span className="text-muted-foreground">@</span>
              <span className="text-foreground">{effectiveHost}</span>
              <span className="text-muted-foreground">:{port}</span>
              <span className="ml-2 text-xs px-1.5 py-0.5 rounded border border-border bg-secondary">
                {authMode === 'password' ? '비밀번호' : '개인키'}
              </span>
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">실행</p>
            <pre className="text-xs font-mono bg-background border border-border rounded-md p-2 max-h-32 overflow-auto whitespace-pre-wrap break-all">
              {commandMasked}
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
