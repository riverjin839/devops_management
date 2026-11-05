import { useEffect, useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import {
  Database, Play, Square, CheckCircle, XCircle, AlertTriangle, Key, Terminal,
  ShieldAlert, Wifi, Clock, ScrollText, ChevronDown, ChevronRight,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useK8sHub } from '@/lib/k8sHub';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useTerminalEnvSync } from '@/hooks/useTerminalEnvSync';
import { useRunLog, runLogged, consoleRunLines, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { ConfirmDialog, ExecOutputTabs, ClusterSidebar, SavedCommands, EmptyState, ErrorState, PageShell, RunLogPanel, useToast } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { MacCard } from '@/components/ui/MacCard';
import {
  etcdctlApi, type EtcdPreset, type EtcdMasterCandidate, type EtcdCtlRunResponse,
} from '@/services/api';
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

/** 권한 부족(403)만 토스트로 알린다 — 그 밖의 실패는 실행 로그의 error 줄과 입력 카드의 알림 한 곳으로 모은다(오류 표시 중복 방지). */
function toastForbidden(toast: ReturnType<typeof useToast>, title: string, error: unknown) {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  if (status === 403) toast.error(`${title} — 권한이 없습니다`, formatApiError(error));
}

function outputLines(res: EtcdCtlRunResponse): RunLogEntry[] {
  const count = (s: string) => (s ? s.split('\n').filter((l) => l.trim()).length : 0);
  return [['info', `출력 stdout ${count(res.stdout)}줄 · stderr ${count(res.stderr)}줄 — 본문은 결과 패널`]];
}

type Tab = 'run' | 'logs';

// 로그 중심 콘솔(DESIGN_SYSTEM §12.6.1): 우측 열은 실행 로그(3) + 결과(2) 가 한 높이를 나눠 쓴다.
// 결과 카드는 실행 전에도 같은 자리에 플레이스홀더로 존재하고, 스크롤은 카드 내부에서 한 번만 일어난다.
function ResultPanel({ result, tab }: { result: EtcdCtlRunResponse | null; tab: Tab }) {
  if (!result) {
    return (
      <div className="min-w-0 flex-1 flex items-center justify-center min-h-[120px] rounded-md border border-border">
        <EmptyState
          compact
          icon={tab === 'run' ? Terminal : ScrollText}
          title="아직 실행 결과가 없습니다."
          description={tab === 'run' ? 'etcdctl 명령을 실행하면 결과가 여기에 표시됩니다.' : '로그를 가져오면 결과가 여기에 표시됩니다.'}
        />
      </div>
    );
  }
  const meta = STATUS_META[result.status];
  const Icon = meta.icon;
  return (
    <MacCard
      title={tab === 'run' ? '실행 결과' : '서비스 로그'}
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

export function EtcdCtlPage() {
  const clustersQ = useClusters();
  const { data: clusters = [] } = clustersQ;
  const [localClusterId, setClusterId] = useState('');
  // K8s 클러스터 허브(D-240) 안에서는 허브가 고른 클러스터가 우선(레일은 허브가 그린다). 단독·아일랜드에선 로컬 선택.
  const hub = useK8sHub();
  const clusterId = hub ? hub.clusterId : localClusterId;
  const toast = useToast();
  const { canOperate, withHint, ariaWithHint } = useCanOperate(clusterId || null);
  useEffect(() => {
    if (hub || localClusterId || clusters.length === 0) return;
    setClusterId(clusters[0].id);
  }, [hub, clusters, localClusterId]);
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

  // 대상 호스트 선택
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
  const [targetOpen, setTargetOpen] = useState(true);

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
  // 결과는 탭별로 보관한다 — 로그 탭을 잠깐 보고 돌아와도 방금 받은 etcdctl 결과가 남는다.
  const [results, setResults] = useState<Record<Tab, EtcdCtlRunResponse | null>>({ run: null, logs: null });
  const result = results[tab];
  const setResultFor = (t: Tab, r: EtcdCtlRunResponse | null) => setResults((prev) => ({ ...prev, [t]: r }));

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
  });

  // 실행 수명주기 로그(두 탭 공유) — 화면의 중심. 출력 본문은 결과 패널, 여기는 요청·대기·결과 요약·실패 사유.
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('etcdctl-run');
  const target = `${username}@${effectiveHost}:${port}`;
  const doRun = async () => {
    const cmd = maskCommand(`${useEnv && envFile ? `source ${envFile} && ` : ''}${etcdctlPath} ${args}`);
    const r = await runLogged(runLog, {
      title: 'etcdctl 실행',
      first: `${target} 에 SSH 접속 후 실행 요청 — ${cmd} (timeout ${timeout}s)`,
      fn: () => runMut.mutateAsync(),
      summarize: (res) => [...consoleRunLines(res), ...outputLines(res)],
    });
    if (r.ok) setResultFor('run', r.data);
    else if (!r.aborted) toastForbidden(toast, 'etcdctl 실행', r.error);
  };
  const doLogs = async () => {
    const cmd = `journalctl -u ${unit} -n ${tail}${since.trim() ? ` --since "${since.trim()}"` : ''}${grep.trim() ? ` | grep -i "${grep.trim()}"` : ''}`;
    const r = await runLogged(runLog, {
      title: 'etcd 서비스 로그 조회',
      first: `${target} 에 SSH 접속 후 조회 요청 — ${cmd}`,
      fn: () => logsMut.mutateAsync(),
      summarize: (res) => [...consoleRunLines(res), ...outputLines(res)],
    });
    if (r.ok) setResultFor('logs', r.data);
    else if (!r.aborted) toastForbidden(toast, 'etcd 서비스 로그 조회', r.error);
  };

  const baseReady = !!clusterId && !!effectiveHost
    && (authMode === 'password' ? !!password : !!privateKey.trim());
  const canRunEtcdctl = baseReady && !!args.trim();
  const canRunLogs = baseReady && !!unit.trim();

  const [confirmRun, setConfirmRun] = useState(false);
  // D-171 — 조회 allowlist 밖 명령은 danger 확인(사유 1줄). 조회 명령과 로그 조회는 확인 없이 바로 실행한다(§12.6.1).
  const runVerdict = useMemo(() => judgeCommand(args, 'etcdctl'), [args]);
  const runCommandMasked = maskCommand(`${useEnv && envFile ? `source ${envFile} && ` : ''}${etcdctlPath} ${args}`);
  const requestRun = () => {
    if (!canOperate || !canRunEtcdctl || runMut.isPending) return;
    if (runVerdict.readOnly) void doRun();
    else setConfirmRun(true);
  };
  const requestLogs = () => {
    if (!canOperate || !canRunLogs || logsMut.isPending) return;
    void doLogs();
  };

  const activeMut = tab === 'run' ? runMut : logsMut;
  const runError = activeMut.error as { response?: { data?: { detail?: string } }; message?: string } | null;

  const tabs: { key: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: 'run', label: 'etcdctl 실행', icon: Terminal },
    { key: 'logs', label: 'etcd 서비스 로그', icon: ScrollText },
  ];
  const onTabKey = (e: React.KeyboardEvent, idx: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = tabs[(idx + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].key;
    setTab(next);
    document.getElementById(f(`tab-${next}`))?.focus();
  };

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={clusterId || null}
          onSelect={(id) => {
            // D-174 ③ — 클러스터를 바꾸면 이전 클러스터의 host 직접 입력·자격증명을 지운다(mc·k9s·노드 SSH 와 동일).
            setClusterId(id ?? ''); setResults({ run: null, logs: null }); setSelectedMasterName('');
            setCustomHost(''); setPassword(''); setPrivateKey('');
          }}
          iconOnly
        />
        <div className="flex-1 min-w-0">
        <PageHeader
          className="mb-3"
          icon={Database}
          title="etcdctl 콘솔"
          titleExtra={effectiveHost ? (
            <span className="text-sm px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border font-mono">
              → {effectiveHost}
            </span>
          ) : undefined}
        />

        <div role="tablist" aria-label="etcdctl 작업" className="flex items-center gap-1 mb-3 border-b border-border">
          {tabs.map((t, idx) => (
            <button
              key={t.key}
              id={f(`tab-${t.key}`)}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              aria-controls={f('panel')}
              tabIndex={tab === t.key ? 0 : -1}
              onClick={() => setTab(t.key)}
              onKeyDown={(e) => onTabKey(e, idx)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5 ${
                tab === t.key
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              <t.icon className="w-3.5 h-3.5" />{t.label}
            </button>
          ))}
        </div>

        {/* 로그 중심 콘솔 — 좌: 제어(좁게), 우: 실행 로그(3) + 결과(2). 실행 로그가 화면의 중심이다. */}
        {clustersQ.isError ? (
          <ErrorState error={clustersQ.error} title="클러스터 목록을 불러오지 못했습니다" onRetry={() => { void clustersQ.refetch(); }} />
        ) : (
        <div
          id={f('panel')}
          role="tabpanel"
          aria-labelledby={f(`tab-${tab}`)}
          className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-3 lg:h-[calc(100vh-var(--topbar-h)-10rem)] lg:min-h-[480px]"
        >
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
                      <label htmlFor={f('master')} className={LABEL}>컨트롤 플레인 노드</label>
                      <select
                        id={f('master')}
                        value={selectedMasterName}
                        onChange={(e) => { setSelectedMasterName(e.target.value); setCustomHost(''); }}
                        disabled={!mastersQ.data?.candidates?.length}
                        className={`${INPUT} disabled:opacity-50`}
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
                      {mastersQ.isError && (
                        <div className="mt-2">
                          <ErrorState compact error={mastersQ.error} title="컨트롤 플레인 노드를 불러오지 못했습니다" onRetry={() => { void mastersQ.refetch(); }} />
                        </div>
                      )}
                    </div>
                    <div>
                      <label htmlFor={f('customHost')} className={LABEL}>호스트 직접 입력</label>
                      <input
                        id={f('customHost')}
                        type="text"
                        value={customHost}
                        onChange={(e) => setCustomHost(e.target.value)}
                        placeholder="예: 192.168.10.11"
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
                          <button
                            key={m}
                            type="button"
                            aria-pressed={authMode === m}
                            onClick={() => setAuthMode(m)}
                            className={`flex-1 px-2 py-1.5 text-sm font-medium rounded-md transition-colors ${
                              authMode === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            {m === 'password' ? '비밀번호' : '개인키'}
                          </button>
                        ))}
                      </div>
                    </div>
                    {authMode === 'password' ? (
                      <div>
                        <label htmlFor={f('pw')} className={LABEL}>SSH 비밀번호</label>
                        <input
                          id={f('pw')}
                          type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                          autoComplete="off"
                          className={INPUT}
                        />
                        <p className="mt-1 text-xs text-muted-foreground">이 실행에만 쓰이며 저장되지 않습니다.</p>
                      </div>
                    ) : (
                      <div>
                        <label htmlFor={f('pkey')} className={`${LABEL} flex items-center gap-1`}>
                          <Key className="w-3 h-3" aria-hidden="true" /> 개인키(PEM)
                        </label>
                        <textarea
                          id={f('pkey')}
                          value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
                          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" rows={4}
                          className={`${INPUT} text-xs font-mono resize-none`}
                        />
                        <p className="mt-1 text-xs text-muted-foreground">이 실행에만 쓰이며 저장되지 않습니다.</p>
                      </div>
                    )}
                  </div>
                )}
              </section>

              {tab === 'run' ? (
                <div className="px-4 py-3 space-y-3">
                  <div>
                    <p className={LABEL}>프리셋 <span className="text-xs inline-flex items-center gap-1 ml-1"><span className="w-1.5 h-1.5 rounded-full bg-status-critical" aria-hidden />변경 명령</span></p>
                    <div className="flex flex-wrap gap-1.5">
                      {(presetsQ.data?.presets ?? []).map((p: EtcdPreset) => {
                        const risky = !judgeCommand(p.args, 'etcdctl').readOnly;
                        return (
                          <button
                            key={p.key}
                            type="button"
                            onClick={() => setArgs(p.args)}
                            className="px-2.5 py-1 text-xs rounded-xl border border-border bg-secondary hover:bg-secondary/80 text-foreground inline-flex items-center gap-1.5"
                            title={`${risky ? '변경 명령 — ' : ''}${maskCommand(p.args)}`}
                          >
                            {risky && <span className="w-1.5 h-1.5 rounded-full bg-status-critical" aria-hidden />}
                            {p.label}
                            {risky && <span className="sr-only"> (변경 명령)</span>}
                          </button>
                        );
                      })}
                    </div>
                    {presetsQ.isError && (
                      <ErrorState compact error={presetsQ.error} title="프리셋을 불러오지 못했습니다" onRetry={() => { void presetsQ.refetch(); }} />
                    )}
                  </div>

                  <div>
                    <label htmlFor={f('args')} className={`${LABEL} flex items-center gap-1`}>
                      <Terminal className="w-3 h-3" aria-hidden />
                      etcdctl 인자
                    </label>
                    <textarea
                      id={f('args')}
                      value={args} onChange={(e) => setArgs(e.target.value)}
                      onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); requestRun(); } }}
                      rows={3}
                      aria-describedby={f('verdict')}
                      className={`${INPUT} text-xs font-mono resize-none`}
                    />
                    <p
                      id={f('verdict')}
                      aria-live="polite"
                      className={`mt-1.5 text-xs flex items-start gap-1.5 ${runVerdict.readOnly ? 'text-muted-foreground' : 'text-status-critical'}`}
                    >
                      <span className="shrink-0 rounded-full border border-current px-2 font-semibold">
                        {runVerdict.readOnly ? '조회 명령' : '변경 명령'}
                      </span>
                      <span>{runVerdict.readOnly ? '확인 없이 바로 실행됩니다.' : '실행 전에 확인합니다.'}</span>
                    </p>
                    <SavedCommands
                      className="mt-2"
                      storageKey="k8s:saved-cmd:etcdctl"
                      currentValue={args}
                      onPick={setArgs}
                    />
                  </div>

                  <details className="group">
                    <summary className="cursor-pointer text-sm font-semibold list-none flex items-center gap-1.5">
                      <ChevronRight className="w-3.5 h-3.5 group-open:rotate-90 transition-transform" aria-hidden />
                      고급 설정
                      <span className="text-xs font-normal text-muted-foreground">env 파일 · etcdctl 경로 · 제한 시간</span>
                    </summary>
                    <div className="mt-2 space-y-3">
                      <div>
                        <label htmlFor={f('envFile')} className={LABEL}>env 파일 경로</label>
                        <input
                          id={f('envFile')}
                          type="text" value={envFile} onChange={(e) => setEnvFile(e.target.value)}
                          disabled={!useEnv}
                          placeholder="/etc/etcd.env"
                          className={`${INPUT} font-mono disabled:opacity-50`}
                        />
                        <label className="mt-1.5 flex items-center gap-2 text-sm text-muted-foreground">
                          <input type="checkbox" checked={useEnv} onChange={(e) => setUseEnv(e.target.checked)} className="w-3.5 h-3.5 accent-primary" />
                          실행 전에 source (<code className="font-mono">ETCDCTL_*</code> 환경변수 로드)
                        </label>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label htmlFor={f('etcdctlPath')} className={LABEL}>etcdctl 경로</label>
                          <input id={f('etcdctlPath')} type="text" value={etcdctlPath} onChange={(e) => setEtcdctlPath(e.target.value)} className={`${INPUT} font-mono`} />
                        </div>
                        <div>
                          <label htmlFor={f('timeout')} className={LABEL}>제한 시간(초)</label>
                          <input id={f('timeout')} type="number" value={timeout} onChange={(e) => setTimeoutSec(Number(e.target.value) || 30)} min={1} max={300} className={INPUT} />
                        </div>
                      </div>
                    </div>
                  </details>
                </div>
              ) : (
                <div className="px-4 py-3 space-y-3">
                  <div>
                    <label htmlFor={f('unit')} className={LABEL}>systemd 유닛</label>
                    <input id={f('unit')} type="text" value={unit} onChange={(e) => setUnit(e.target.value)} className={`${INPUT} font-mono`} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label htmlFor={f('tail')} className={LABEL}>마지막 N줄</label>
                      <input id={f('tail')} type="number" value={tail} onChange={(e) => setTail(Number(e.target.value) || 200)} min={1} max={5000} className={INPUT} />
                    </div>
                    <div>
                      <label htmlFor={f('since')} className={LABEL}>시작 시점</label>
                      <input id={f('since')} type="text" value={since} onChange={(e) => setSince(e.target.value)} placeholder="예: 10 min ago" className={INPUT} />
                    </div>
                  </div>
                  <div>
                    <label htmlFor={f('grep')} className={LABEL}>grep 필터 (대소문자 무시)</label>
                    <input id={f('grep')} type="text" value={grep} onChange={(e) => setGrep(e.target.value)} placeholder="예: error 또는 leader" className={`${INPUT} font-mono`} />
                  </div>
                  <p className="text-xs text-muted-foreground">조회 전용 — 확인 없이 바로 실행됩니다.</p>
                </div>
              )}
            </div>

            {/* 실행 바 — 스크롤과 무관하게 항상 보인다. */}
            <div className="border-t border-border p-3 space-y-2">
              {runError && (
                <div role="alert" className="px-3 py-2 text-sm rounded-md bg-status-critical/10 text-status-critical border border-status-critical/30">
                  {formatApiError(runError)}
                </div>
              )}
              {activeMut.isPending ? (
                <button
                  type="button"
                  onClick={activeMut.abort}
                  className="w-full flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold bg-secondary hover:bg-secondary/80 text-foreground border border-border rounded-xl transition-colors"
                >
                  <Square className="w-4 h-4 fill-current" />
                  중지
                </button>
              ) : (
                <button
                  type="button"
                  onClick={tab === 'run' ? requestRun : requestLogs}
                  disabled={!canOperate || !(tab === 'run' ? canRunEtcdctl : canRunLogs)}
                  title={withHint(tab === 'run' ? 'etcdctl 실행' : '로그 가져오기')}
                  aria-label={ariaWithHint(tab === 'run' ? 'etcdctl 실행' : '로그 가져오기')}
                  className="w-full flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {tab === 'run' ? <Play className="w-4 h-4" /> : <ScrollText className="w-4 h-4" />}
                  {tab === 'run' ? 'etcdctl 실행' : '로그 가져오기'}
                </button>
              )}
              {tab === 'run' && (
                <p className="text-center text-xs text-muted-foreground">
                  <kbd className="px-1 rounded border border-border bg-secondary">Ctrl</kbd>+<kbd className="px-1 rounded border border-border bg-secondary">Enter</kbd> 로도 실행
                </p>
              )}
            </div>
          </MacCard>

          {/* 우: 실행 로그(중심) + 결과 — 항상 같은 위치, 실행 전엔 대기 상태 */}
          <div className="min-w-0 min-h-0 flex flex-col gap-3">
            <div className="flex flex-col min-h-[240px] lg:min-h-0 flex-[3]">
              <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} fill />
            </div>
            <div className="flex flex-col min-h-[200px] lg:min-h-0 flex-[2]">
              <ResultPanel result={result} tab={tab} />
            </div>
          </div>
        </div>
        )}
        </div>
      </PageShell>

      {/* 변경(비조회) 명령 확인 모달 — 조회 명령과 로그 조회는 확인 없이 실행한다. */}
      <ConfirmDialog
        open={confirmRun}
        title="변경 명령 실행 확인"
        description="컨트롤 플레인 노드에 SSH 접속 후 etcdctl 명령을 실행합니다. 조회 명령이 아니므로 etcd 데이터·클러스터 구성을 되돌릴 수 없게 바꿀 수 있습니다."
        confirmLabel="etcdctl 실행"
        danger
        onCancel={() => setConfirmRun(false)}
        onConfirm={() => {
          setConfirmRun(false);
          void doRun();
        }}
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
              {runCommandMasked}
            </pre>
            {runVerdict.reason && (
              <p className="mt-2 text-sm text-status-critical flex items-start gap-1.5">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                {runVerdict.reason}
              </p>
            )}
          </div>
        </div>
      </ConfirmDialog>
    </div>
  );
}
