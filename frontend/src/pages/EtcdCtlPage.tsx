import { useEffect, useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import {
  Database, Play, Square, CheckCircle, XCircle, AlertTriangle, Key, FileText, Terminal,
  ShieldAlert, Wifi, Clock, ScrollText,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
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

/** 실패 토스트 — 서버 403(역할·테넌트 권한 부족)은 사유를 그대로 보여 준다(D-172). 실행 로그에는 runLogged 가 error 줄을 남긴다. */
function toastFailure(toast: ReturnType<typeof useToast>, title: string, error: unknown) {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  toast.error(status === 403 ? `${title} — 권한이 없습니다` : `${title} 실패`, formatApiError(error));
}

function outputLines(res: EtcdCtlRunResponse): RunLogEntry[] {
  const count = (s: string) => (s ? s.split('\n').filter((l) => l.trim()).length : 0);
  return [['info', `출력 stdout ${count(res.stdout)}줄 · stderr ${count(res.stderr)}줄 — 본문은 결과 패널`]];
}

// 타겟/실행 구성 옆(우측)에 고정 위치로 배치 — mc 클라이언트 콘솔과 동일한 패턴이다.
// 실행 전에도 같은 자리에 플레이스홀더를 보여줘 결과가 나와도 레이아웃이 흔들리지 않는다.
// 카드 자체는 화면 높이에 맞춰 세로 스크롤만 허용(overflow-y-auto)하고 가로 스크롤은
// 막는다(overflow-x-hidden) — 좁은 카드 폭 안에 긴 로그가 들어와도 페이지가 옆으로 늘어나지 않는다.
function ResultPanel({ result, tab }: { result: EtcdCtlRunResponse | null; tab: Tab }) {
  if (!result) {
    return (
      <div className="min-w-0 flex items-center justify-center min-h-[200px] lg:h-[calc(100vh-260px)]">
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
  // 헤더(상태·호스트·exit·소요)는 고정, 본문만 세로 스크롤 — 예전 sticky header 와 같은 동작.
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
      rootClassName="min-w-0 flex flex-col lg:h-[calc(100vh-260px)]"
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

type Tab = 'run' | 'logs';

export function EtcdCtlPage() {
  const clustersQ = useClusters();
  const { data: clusters = [] } = clustersQ;
  const [clusterId, setClusterId] = useState('');
  const toast = useToast();
  const { canOperate, withHint, ariaWithHint } = useCanOperate(clusterId || null);
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

  // 실행 수명주기 로그(두 탭 공유) — 출력 본문은 결과 패널, 여기는 요청·대기·결과 요약·실패 사유.
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
    if (r.ok) setResult(r.data);
    else if (!r.aborted) toastFailure(toast, 'etcdctl 실행', r.error);
  };
  const doLogs = async () => {
    const cmd = `journalctl -u ${unit} -n ${tail}${since.trim() ? ` --since "${since.trim()}"` : ''}${grep.trim() ? ` | grep -i "${grep.trim()}"` : ''}`;
    const r = await runLogged(runLog, {
      title: 'etcd 서비스 로그 조회',
      first: `${target} 에 SSH 접속 후 조회 요청 — ${cmd}`,
      fn: () => logsMut.mutateAsync(),
      summarize: (res) => [...consoleRunLines(res), ...outputLines(res)],
    });
    if (r.ok) setResult(r.data);
    else if (!r.aborted) toastFailure(toast, 'etcd 서비스 로그 조회', r.error);
  };

  const baseReady = !!clusterId && !!effectiveHost
    && (authMode === 'password' ? !!password : !!privateKey.trim());
  const canRunEtcdctl = baseReady && !!args.trim();
  const canRunLogs = baseReady && !!unit.trim();

  const [confirmAction, setConfirmAction] = useState<null | 'run' | 'logs'>(null);
  // D-171 — 조회 allowlist 밖 명령은 전부 danger 확인(사유 1줄).
  const runVerdict = useMemo(() => judgeCommand(args, 'etcdctl'), [args]);
  const runCommandMasked = maskCommand(`${useEnv && envFile ? `source ${envFile} && ` : ''}${etcdctlPath} ${args}`);

  const runError = (tab === 'run' ? runMut.error : logsMut.error) as
    { response?: { data?: { detail?: string } }; message?: string } | null;

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={clusterId || null}
          onSelect={(id) => {
            // D-174 ③ — 클러스터를 바꾸면 이전 클러스터의 host 직접 입력·자격증명을 지운다(mc·k9s·노드 SSH 와 동일).
            setClusterId(id ?? ''); setResult(null); setSelectedMasterName('');
            setCustomHost(''); setPassword(''); setPrivateKey('');
          }}
          iconOnly
        />
        <div className="flex-1 min-w-0">
        {/* 헤더 */}
        <PageHeader
          className="mb-6"
          icon={Database}
          title="etcdctl 콘솔"
          titleExtra={effectiveHost ? (
            <span className="text-sm px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border font-mono">
              → {effectiveHost}
            </span>
          ) : undefined}
        />

        {/* 안내 */}
        <p className="mb-5 text-sm text-muted-foreground leading-relaxed">
          컨트롤 플레인 노드에 <code className="font-mono text-foreground">etcd.service</code> 가 systemd 로 동작하고
          <code className="font-mono text-foreground"> /etc/etcd.env</code> 에 <code className="font-mono text-foreground">ETCDCTL_*</code> 환경변수가 정의돼 있다고 가정합니다.
          다르면 "env 파일 경로"를 바꾸거나 env 로드를 끄고 인자에 직접 지정할 수 있습니다.
          조회 명령(get·endpoint health/status·member list 등) 밖의 명령은 위험 확인을 거칩니다.
          SSH 인증정보는 이 실행에만 사용되고 저장되지 않습니다.
        </p>

        {/* 탭 */}
        <div role="tablist" aria-label="etcdctl 작업" className="flex items-center gap-1 mb-5">
          {(['run', 'logs'] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
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
        {clustersQ.isError ? (
          <ErrorState error={clustersQ.error} title="클러스터 목록을 불러오지 못했습니다" onRetry={() => { void clustersQ.refetch(); }} />
        ) : (
        <div className="grid grid-cols-1 lg:grid-cols-10 gap-5 items-start">
          {/* 좌: 타겟 + 인증 */}
          <MacCard title="타겟" rootClassName="lg:col-span-2 min-w-0" bodyPadding="p-5" className="space-y-4">
            <div>
              <label htmlFor={f('master')} className="block text-sm text-muted-foreground mb-1">컨트롤 플레인 노드</label>
              <select
                id={f('master')}
                value={selectedMasterName}
                onChange={(e) => { setSelectedMasterName(e.target.value); setCustomHost(''); }}
                disabled={!mastersQ.data?.candidates?.length}
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
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
              <label htmlFor={f('customHost')} className="block text-sm text-muted-foreground mb-1">
                호스트 직접 입력 <span className="text-xs opacity-60">(비우면 위 노드 사용)</span>
              </label>
              <input
                id={f('customHost')}
                type="text"
                value={customHost}
                onChange={(e) => setCustomHost(e.target.value)}
                placeholder="예: 192.168.10.11"
                className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor={f('user')} className="block text-sm text-muted-foreground mb-1">사용자</label>
                <input
                  id={f('user')}
                  type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label htmlFor={f('port')} className="block text-sm text-muted-foreground mb-1">포트</label>
                <input
                  id={f('port')}
                  type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)}
                  className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>

            <div>
              <p id={f('authLabel')} className="block text-sm text-muted-foreground mb-1">인증 방식</p>
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
              <input
                type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                aria-label="SSH 비밀번호" autoComplete="off"
                placeholder="SSH 비밀번호"
                className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
              />
            ) : (
              <div>
                <label htmlFor={f('pkey')} className="text-sm text-muted-foreground mb-1 flex items-center gap-1">
                  <Key className="w-3 h-3" aria-hidden="true" /> 개인키(PEM)
                </label>
                <textarea
                  id={f('pkey')}
                  value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" rows={4}
                  className="w-full px-3 py-2 text-xs font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                />
              </div>
            )}
          </MacCard>

          {/* 중: 실행 구성 */}
          <MacCard title={tab === 'run' ? '명령' : '로그 조회'} rootClassName="lg:col-span-3 min-w-0" bodyPadding="p-5" className="space-y-4">
            {tab === 'run' ? (
              <>
                {/* 프리셋 */}
                <div>
                  <p className="text-sm text-muted-foreground mb-1.5">프리셋 — 누르면 인자 칸에 채웁니다</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(presetsQ.data?.presets ?? []).map((p: EtcdPreset) => (
                      <button
                        key={p.key}
                        onClick={() => setArgs(p.args)}
                        className="px-2.5 py-1 text-xs rounded-xl border border-border bg-secondary hover:bg-secondary/80 text-foreground"
                        title={maskCommand(p.args)}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  {presetsQ.isError && (
                    <ErrorState compact error={presetsQ.error} title="프리셋을 불러오지 못했습니다" onRetry={() => { void presetsQ.refetch(); }} />
                  )}
                </div>

                {/* env file */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="md:col-span-2">
                    <label htmlFor={f('envFile')} className="text-sm text-muted-foreground mb-1 flex items-center gap-1">
                      <FileText className="w-3 h-3" aria-hidden="true" /> env 파일 경로
                    </label>
                    <input
                      id={f('envFile')}
                      type="text" value={envFile} onChange={(e) => setEnvFile(e.target.value)}
                      disabled={!useEnv}
                      placeholder="/etc/etcd.env"
                      className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
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
                    className="w-full px-3 py-2 text-xs font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary resize-none"
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
                      className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <div>
                    <label htmlFor={f('timeout')} className="block text-sm text-muted-foreground mb-1">제한 시간(초)</label>
                    <input
                      id={f('timeout')}
                      type="number" value={timeout} onChange={(e) => setTimeoutSec(Number(e.target.value) || 30)}
                      min={1} max={300}
                      className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
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
                      onClick={() => setConfirmAction('run')}
                      disabled={!canOperate || !canRunEtcdctl}
                      title={withHint('etcdctl 실행')}
                      aria-label={ariaWithHint('etcdctl 실행')}
                      className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
                    <label htmlFor={f('unit')} className="block text-sm text-muted-foreground mb-1">systemd 유닛</label>
                    <input
                      id={f('unit')}
                      type="text" value={unit} onChange={(e) => setUnit(e.target.value)}
                      className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <div>
                    <label htmlFor={f('tail')} className="block text-sm text-muted-foreground mb-1">마지막 N줄</label>
                    <input
                      id={f('tail')}
                      type="number" value={tail} onChange={(e) => setTail(Number(e.target.value) || 200)}
                      min={1} max={5000}
                      className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <div>
                    <label htmlFor={f('since')} className="block text-sm text-muted-foreground mb-1">시작 시점 <span className="opacity-60">(journalctl --since)</span></label>
                    <input
                      id={f('since')}
                      type="text" value={since} onChange={(e) => setSince(e.target.value)}
                      placeholder="예: 10 min ago"
                      className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
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
                    className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>

                {runError && (
                  <div role="alert" className="px-3 py-2 text-sm rounded-md bg-status-critical/10 text-status-critical border border-status-critical/30">
                    {formatApiError(runError)}
                  </div>
                )}

                <div className="flex justify-end pt-2 border-t border-border">
                  {logsMut.isPending ? (
                    <button
                      onClick={logsMut.abort}
                      className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-secondary hover:bg-secondary/80 text-foreground border border-border rounded-xl transition-colors"
                    >
                      <Square className="w-4 h-4 fill-current" />
                      중지
                    </button>
                  ) : (
                    <button
                      onClick={() => setConfirmAction('logs')}
                      disabled={!canOperate || !canRunLogs}
                      title={withHint('로그 가져오기')}
                      aria-label={ariaWithHint('로그 가져오기')}
                      className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ScrollText className="w-4 h-4" />
                      로그 가져오기
                    </button>
                  )}
                </div>
              </>
            )}
          </MacCard>

          {/* 우: 실행 로그(수명주기) + 결과 — 항상 같은 위치(우측)에 고정, 실행 전엔 플레이스홀더 */}
          <div className="lg:col-span-5 min-w-0 flex flex-col gap-3">
            <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
            <ResultPanel result={result} tab={tab} />
          </div>
        </div>
        )}
        </div>
      </PageShell>

      {/* 실행 확인 모달 */}
      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction === 'run' ? 'etcdctl 실행 확인' : 'etcd 서비스 로그 조회 확인'}
        description={confirmAction === 'run'
          ? (runVerdict.readOnly
            ? `컨트롤 플레인 노드에 SSH 접속 후 etcdctl 조회 명령(${runVerdict.subcommand})을 실행합니다.`
            : '컨트롤 플레인 노드에 SSH 접속 후 etcdctl 명령을 실행합니다. 조회 명령이 아니므로 etcd 데이터·클러스터 구성을 되돌릴 수 없게 바꿀 수 있습니다.')
          : '컨트롤 플레인 노드에 SSH 접속 후 journalctl 로 로그를 가져옵니다.'}
        confirmLabel={confirmAction === 'run' ? 'etcdctl 실행' : '로그 가져오기'}
        danger={confirmAction === 'run' && !runVerdict.readOnly}
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => {
          const which = confirmAction;
          setConfirmAction(null);
          if (which === 'run') void doRun();
          else if (which === 'logs') void doLogs();
        }}
      >
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">타겟</p>
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
          {confirmAction === 'run' ? (
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
          ) : (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">journalctl</p>
              <pre className="text-xs font-mono bg-background border border-border rounded-md p-2 overflow-auto whitespace-pre-wrap">
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
