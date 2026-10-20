import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  TerminalSquare, Key, Play, ShieldAlert, ExternalLink, Search, Loader2,
  CheckCircle, XCircle, Wifi, Clock, Plug, RotateCw,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import {
  ClusterSidebar, ConfirmDialog, ErrorState, PageShell, SelectClusterEmptyState, EmptyState, LoadingState,
} from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { MacCard } from '@/components/ui/MacCard';
import { NodeSshTerminal, type NodeSshConnectParams, type SshTerminalStatus } from '@/components/k8s';
import { openNodeSshPopout } from '@/lib/nodeSshPopout';
import { useTerminalEnvSync } from '@/hooks/useTerminalEnvSync';
import { useCanOperate } from '@/hooks/useCanOperate';
import { isGuardedLevel, levelLabel, useOperationLevels } from '@/hooks/useOperationLevels';
import { formatApiError } from '@/lib/utils';
import { bulkExecApi, nodeSshApi, type NodeSshTestResult, type NodeSummary } from '@/services/api';

const TEST_STATUS_META: Record<
  NodeSshTestResult['status'],
  { label: string; cls: string; icon: React.ComponentType<{ className?: string }> }
> = {
  ok:            { label: '연결 성공', cls: 'bg-status-healthy/10 text-status-healthy border-status-healthy/30', icon: CheckCircle },
  error:         { label: '오류',      cls: 'bg-status-critical/10 text-status-critical border-status-critical/30',             icon: XCircle },
  timeout:       { label: '시간 초과',  cls: 'bg-status-warning/10 text-status-warning border-status-warning/30',       icon: Clock },
  auth_error:    { label: '인증 실패', cls: 'bg-status-warning/10 text-status-warning border-status-warning/30',    icon: ShieldAlert },
  connect_error: { label: '연결 실패', cls: 'bg-status-unknown/10 text-status-unknown border-status-unknown/30',       icon: Wifi },
};

const POPUP_BLOCKED_MSG = '팝업이 차단되었습니다. 브라우저에서 이 사이트의 팝업을 허용한 뒤 다시 시도하세요.';
const HANDOFF_FAILED_MSG = '새 창에 접속 정보를 전달하지 못했습니다 — "다시 열기"를 눌러 다시 여세요.';

/**
 * 개별 노드 SSH 터미널 — 클러스터 노드 하나를 골라 **로그인 셸**을 웹 터미널로 연다.
 * k9s 콘솔이 control-plane 의 k9s TUI 만 띄우는 것과 달리 여기는 범용 셸이라
 * 로그 확인·서비스 상태 점검 같은 임의 작업을 그대로 할 수 있다.
 *
 * 재사용하는 base 툴: 노드 목록은 mc/bulk-exec 와 같은 `bulkExecApi.nodeList`,
 * 터미널 창은 k9s 와 같은 `SshTerminalWindow`(→ 백엔드 `services/ssh_pty`),
 * 창 간 handoff 는 `lib/terminalPopout.ts`(저장소 없는 postMessage). SSH 인증정보는 저장하지 않는다.
 * 보호 레벨(운영레벨 `guarded`) 클러스터는 연결 전에 대상·계정을 한 번 더 확인한다(정책 4).
 */
export function NodeSshPage() {
  const { clusterId = '' } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const clustersQ = useClusters();
  const clusters = useMemo(() => clustersQ.data ?? [], [clustersQ.data]);
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;
  const { canOperate, hint, withHint, ariaWithHint } = useCanOperate(clusterId || null);
  const { data: levels } = useOperationLevels();
  const cluster = useMemo(() => clusters.find((c) => c.id === clusterId), [clusters, clusterId]);
  const guarded = isGuardedLevel(levels, cluster?.operationLevel);
  const levelText = levelLabel(levels, cluster?.operationLevel) || '미지정';

  // clusterId 없으면 첫 클러스터로 이동
  useEffect(() => {
    if (!clusterId && clusters.length > 0) {
      navigate(`/node-ssh/${clusters[0].id}`, { replace: true });
    }
  }, [clusterId, clusters, navigate]);

  // 선택한 클러스터의 운영등급에 따라 터미널 Appearance 활성 프로파일(개발/운영)을 결정.
  useTerminalEnvSync(clusters, clusterId || null);

  // 노드 목록 — mc 클라이언트/노드 일괄 실행과 동일한 엔드포인트를 재사용.
  const nodesQ = useQuery({
    queryKey: ['bulk-exec', 'nodes', clusterId],
    queryFn: () => bulkExecApi.nodeList(clusterId).then((r) => r.data),
    enabled: !!clusterId,
    staleTime: 60_000,
  });

  const [nodeFilter, setNodeFilter] = useState('');
  const [selectedNodeName, setSelectedNodeName] = useState('');
  const [customHost, setCustomHost] = useState('');
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState('root');
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [initialCommand, setInitialCommand] = useState('');
  const [session, setSession] = useState<NodeSshConnectParams | null>(null);
  const [termStatus, setTermStatus] = useState<SshTerminalStatus | null>(null);
  const [popoutMsg, setPopoutMsg] = useState('');
  // handoff 실패 시 "다시 열기" 용 — 메모리에만 두고 클러스터 전환·재시도 때 비운다.
  const [retryParams, setRetryParams] = useState<NodeSshConnectParams | null>(null);
  const [pendingConnect, setPendingConnect] = useState<'inline' | 'popout' | null>(null);
  const [pendingCluster, setPendingCluster] = useState<{ id: string | null } | null>(null);
  const clusterIdRef = useRef(clusterId);
  clusterIdRef.current = clusterId;

  // 클러스터가 바뀌면 대상/자격증명을 초기화한다(다른 클러스터에 그대로 붙지 않도록).
  useEffect(() => {
    setSelectedNodeName('');
    setCustomHost('');
    setNodeFilter('');
    setPassword('');
    setPrivateKey('');
    setRetryParams(null);
    setPopoutMsg('');
  }, [clusterId]);

  const nodes = useMemo(() => nodesQ.data?.nodes ?? [], [nodesQ.data]);
  const filteredNodes = useMemo(() => {
    const q = nodeFilter.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter((n: NodeSummary) =>
      n.name.toLowerCase().includes(q) || (n.internalIp ?? '').includes(q));
  }, [nodes, nodeFilter]);

  // 첫 노드 자동선택 — k9s 와 달리 master 를 우선하지 않는다(범용 셸이므로).
  useEffect(() => {
    if (!selectedNodeName && nodes.length > 0) setSelectedNodeName(nodes[0].name);
  }, [nodes, selectedNodeName]);

  const selectedNode = useMemo(
    () => nodes.find((n: NodeSummary) => n.name === selectedNodeName),
    [nodes, selectedNodeName],
  );
  const effectiveHost = customHost.trim() || selectedNode?.internalIp || selectedNode?.externalIp || '';
  const effectiveNodeName = customHost.trim() ? '' : (selectedNode?.name ?? '');

  const canConnect = !!effectiveHost && !!username
    && (authMode === 'password' ? !!password : !!privateKey.trim());

  const testM = useMutation({
    mutationFn: () => nodeSshApi.test({
      host: effectiveHost,
      port,
      username,
      password: authMode === 'password' ? password : undefined,
      privateKey: authMode === 'key' ? privateKey : undefined,
    }).then((r) => r.data),
  });

  // 대상·자격증명이 바뀌면 이전 테스트 결과 배지를 지운다 — 다른 대상의 결과로 읽히지 않게(D-174 ④).
  const resetTest = testM.reset;
  useEffect(() => {
    resetTest();
  }, [effectiveHost, port, username, authMode, password, privateKey, resetTest]);

  const buildParams = (): NodeSshConnectParams => ({
    nodeName: effectiveNodeName || undefined,
    host: effectiveHost,
    port,
    username,
    authMode,
    password,
    privateKey,
    initialCommand: initialCommand.trim() || undefined,
    clusterId: clusterId || undefined,
  });

  const openPopout = (params: NodeSshConnectParams): Window | null => {
    setPopoutMsg('');
    setRetryParams(null);
    const cid = clusterId;
    const win = openNodeSshPopout({ params }, (delivered) => {
      if (delivered || clusterIdRef.current !== cid) return;
      setRetryParams(params);
      setPopoutMsg(HANDOFF_FAILED_MSG);
    });
    if (!win) setPopoutMsg(POPUP_BLOCKED_MSG);
    return win;
  };

  const doConnect = (mode: 'inline' | 'popout') => {
    if (!canConnect || !canOperate) return;
    if (mode === 'inline') {
      setPopoutMsg('');
      setRetryParams(null);
      setSession(buildParams());
    } else {
      // 폼에서 바로 별도 창으로 연결 (인라인 세션은 만들지 않음).
      openPopout(buildParams());
    }
  };

  // 보호 레벨이면 연결 전 확인(정책 4), 그 외는 즉시 연결.
  const requestConnect = (mode: 'inline' | 'popout') => {
    if (!canConnect || !canOperate) return;
    if (guarded) setPendingConnect(mode);
    else doConnect(mode);
  };

  // 인라인 세션을 별도 창으로 이동 — 성공 시 메인 창 세션은 닫는다(중복 세션 방지).
  const popOutSession = () => {
    if (!session) return;
    if (openPopout(session)) {
      setSession(null);
      setTermStatus(null);
    }
  };

  const changeCluster = (id: string | null) => {
    navigate(`/node-ssh/${id ?? ''}`);
    setSession(null);
    setTermStatus(null);
  };

  // 열린 세션이 있으면 클러스터 전환 전에 확인한다(D-177).
  const requestClusterChange = (id: string | null) => {
    if (session && termStatus === 'open') setPendingCluster({ id });
    else changeCluster(id);
  };

  const popoutNotice = popoutMsg ? (
    <div className="flex items-center gap-2 flex-wrap" role="status">
      <p className="text-xs text-status-warning flex items-center gap-1">
        <ShieldAlert className="w-3 h-3" aria-hidden="true" /> {popoutMsg}
      </p>
      {retryParams && (
        <button
          type="button"
          onClick={() => openPopout(retryParams)}
          disabled={!canOperate}
          title={withHint('같은 접속 정보로 새 창을 다시 엽니다')}
          aria-label={ariaWithHint('다시 열기')}
          className="px-2 py-1 text-xs font-medium rounded-xl border border-border text-foreground hover:bg-secondary disabled:opacity-50 flex items-center gap-1"
        >
          <RotateCw className="w-3 h-3" aria-hidden="true" /> 다시 열기
        </button>
      )}
    </div>
  ) : null;

  const testMeta = testM.data ? TEST_STATUS_META[testM.data.status] : null;
  const TestIcon = testMeta?.icon;

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" as="div" className="flex gap-3">
        <div className="sticky top-3 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            onSelect={requestClusterChange}
            iconOnly
          />
        </div>

        <div className="flex-1 min-w-0 space-y-3">
          <PageHeader
            icon={TerminalSquare}
            title="노드 SSH 터미널"
            description="개별 노드에 SSH 로그인 셸을 열어 웹 터미널로 사용"
            actions={effectiveHost ? (
              <span className="text-sm px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border font-mono">
                → {username}@{effectiveHost}:{port}
              </span>
            ) : undefined}
          />

          {clustersQ.isError ? (
            <ErrorState
              error={clustersQ.error}
              title="클러스터 목록을 불러오지 못했습니다"
              onRetry={() => { void clustersQ.refetch(); }}
            />
          ) : !clusterId ? (
            <SelectClusterEmptyState description="왼쪽에서 클러스터를 고르면 노드 목록과 접속 정보를 입력할 수 있습니다." />
          ) : session ? (
            <>
              <p className="text-sm text-muted-foreground leading-relaxed">
                SSH 세션이 <b className="text-foreground">플로팅 창</b>으로 열려 있습니다 —
                창 상단바를 <b className="text-foreground">드래그해 위치를 이동</b>하고, 우하단 모서리를 끌어 크기를 조절할 수 있습니다.
                세션은 최대 1시간 유지되며 남은 시간은 창 상단에 표시됩니다. 다른 메뉴로 이동하면 세션이 끊기므로 계속 쓰려면 창 상단바의
                <b className="text-foreground"> 새 창으로 빼기</b>(별도 브라우저 창)를 이용하세요.
              </p>
              {popoutNotice}
              <NodeSshTerminal
                params={session}
                onClose={() => { setSession(null); setTermStatus(null); }}
                onPopOut={popOutSession}
                onStatusChange={setTermStatus}
              />
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground leading-relaxed">
                선택한 노드에 SSH 로 접속해 <b className="text-foreground">로그인 셸을 그대로</b> 웹 터미널(tty + resize)로 씁니다 —
                <code className="font-mono">journalctl</code>, <code className="font-mono">top</code>, <code className="font-mono">vi</code> 같은 인터랙티브 명령도 동작합니다.
                SSH 인증정보는 이 세션에만 사용되고 저장되지 않습니다(operator 이상 권한 필요).
                <br />
                여러 노드에 <b className="text-foreground">같은 명령을 한 번에</b> 돌려야 한다면 <b className="text-foreground">노드 일괄 실행</b>,
                클러스터 리소스를 TUI 로 탐색하려면 <b className="text-foreground">k9s 콘솔</b>을 쓰세요.
                {guarded && (
                  <>
                    <br />이 클러스터는 <b className="text-foreground">보호 레벨({levelText})</b>이라 연결 전에 대상과 계정을 한 번 더 확인합니다.
                  </>
                )}
              </p>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
                {/* 대상 노드 */}
                <MacCard title="대상 노드" className="space-y-3">
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="text"
                      value={nodeFilter}
                      onChange={(e) => setNodeFilter(e.target.value)}
                      placeholder="노드 이름 / IP 검색"
                      aria-label="노드 검색"
                      className="w-full pl-8 pr-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>

                  <div className="max-h-64 overflow-y-auto rounded-xl border border-border divide-y divide-border">
                    {nodesQ.isLoading && (
                      <LoadingState compact />
                    )}
                    {nodesQ.isError && (
                      <ErrorState
                        compact
                        error={nodesQ.error}
                        title="노드 목록을 불러오지 못했습니다"
                        onRetry={() => { void nodesQ.refetch(); }}
                      />
                    )}
                    {!nodesQ.isLoading && !nodesQ.isError && filteredNodes.length === 0 && (
                      <EmptyState
                        compact
                        icon={Search}
                        title="조건에 맞는 노드가 없습니다."
                        description="검색어를 바꾸거나 아래에 호스트를 직접 입력하세요."
                      />
                    )}
                    {filteredNodes.map((n: NodeSummary) => {
                      const active = !customHost.trim() && n.name === selectedNodeName;
                      return (
                        <button
                          key={n.name}
                          type="button"
                          aria-pressed={active}
                          onClick={() => { setSelectedNodeName(n.name); setCustomHost(''); }}
                          className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${
                            active ? 'bg-primary/10' : 'hover:bg-secondary'
                          }`}
                        >
                          <span
                            aria-hidden="true"
                            className={`w-1.5 h-1.5 rounded-full shrink-0 ${n.ready ? 'bg-muted-foreground/40' : 'bg-status-critical'}`}
                            title={n.ready ? '준비됨' : '준비 안 됨'}
                          />
                          <span className="sr-only">{n.ready ? '준비됨' : '준비 안 됨'} —</span>
                          <span className={`text-sm truncate ${active ? 'text-foreground font-medium' : 'text-foreground/80'}`}>
                            {n.name}
                          </span>
                          <span className="text-xs font-mono text-muted-foreground ml-auto shrink-0">
                            {n.internalIp ?? '—'}
                          </span>
                          {n.roles.includes('control-plane') && (
                            <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-chart-7/15 text-chart-7-text border border-chart-7/30 shrink-0">
                              컨트롤 플레인
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  <div>
                    <label htmlFor={f('host')} className="block text-sm text-muted-foreground mb-1">
                      호스트 직접 입력 <span className="text-xs text-muted-foreground">(비우면 위에서 고른 노드 사용)</span>
                    </label>
                    <input
                      id={f('host')}
                      type="text"
                      value={customHost}
                      onChange={(e) => setCustomHost(e.target.value)}
                      placeholder="예: 192.168.10.11 (클러스터 밖 서버도 가능)"
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
                </MacCard>

                {/* 인증 + 실행 옵션 */}
                <MacCard title="인증 · 실행" className="space-y-4">
                  <div>
                    <p id={f('auth')} className="block text-sm text-muted-foreground mb-1">인증 방식</p>
                    <div className="flex items-center bg-secondary/60 rounded-xl p-[3px] gap-px" role="group" aria-labelledby={f('auth')}>
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
                      <label htmlFor={f('pw')} className="block text-sm text-muted-foreground mb-1">SSH 비밀번호</label>
                      <input
                        id={f('pw')}
                        type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                        autoComplete="off"
                        className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
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

                  <div>
                    <label htmlFor={f('initcmd')} className="block text-sm text-muted-foreground mb-1">
                      접속 후 실행 <span className="text-xs text-muted-foreground">(선택 — 셸에 한 줄로 입력됩니다)</span>
                    </label>
                    <input
                      id={f('initcmd')}
                      type="text" value={initialCommand} onChange={(e) => setInitialCommand(e.target.value)}
                      placeholder="예: sudo -i · cd /var/log · journalctl -u kubelet -f"
                      className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => requestConnect('inline')}
                      disabled={!canConnect || !canOperate}
                      title={withHint('이 화면의 플로팅 창으로 SSH 연결')}
                      aria-label={ariaWithHint('연결')}
                      className="flex-1 px-3 py-2 text-sm font-medium rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      <Play className="w-4 h-4" /> 연결
                    </button>
                    <button
                      type="button"
                      onClick={() => requestConnect('popout')}
                      disabled={!canConnect || !canOperate}
                      title={withHint('별도 브라우저 창으로 열기 — 메인 화면에서 다른 페이지로 이동하며 함께 사용')}
                      aria-label={ariaWithHint('새 창으로 열기')}
                      className="px-3 py-2 text-sm font-medium rounded-xl border border-border text-foreground hover:bg-secondary disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      <ExternalLink className="w-4 h-4" /> 새 창으로 열기
                    </button>
                    <button
                      type="button"
                      onClick={() => testM.mutate()}
                      disabled={!canConnect || !canOperate || testM.isPending}
                      title={withHint('터미널을 열지 않고 호스트/자격증명만 확인')}
                      aria-label={ariaWithHint('연결 테스트')}
                      className="px-3 py-2 text-sm font-medium rounded-xl border border-border text-foreground hover:bg-secondary disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      {testM.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
                      테스트
                    </button>
                  </div>

                  {testMeta && TestIcon && testM.data && (
                    <p className="flex items-center gap-2 flex-wrap">
                      <span className={`inline-flex items-center gap-1 text-sm px-2 py-0.5 rounded-full border font-medium ${testMeta.cls}`}>
                        <TestIcon className="w-3 h-3" /> {testMeta.label}
                      </span>
                      <span className="text-xs font-mono text-muted-foreground">
                        {testM.data.host} · {testM.data.durationMs}ms
                      </span>
                      {testM.data.error && <span className="text-xs text-status-critical">{testM.data.error}</span>}
                    </p>
                  )}
                  {testM.isError && (
                    <p className="text-xs text-status-critical">테스트 실패: {formatApiError(testM.error)}</p>
                  )}

                  {!canOperate ? (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <ShieldAlert className="w-3 h-3" aria-hidden="true" /> {hint}
                    </p>
                  ) : !canConnect && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <ShieldAlert className="w-3 h-3" aria-hidden="true" /> 노드(또는 호스트)와 {authMode === 'password' ? '비밀번호' : '개인키'}를 입력하세요.
                    </p>
                  )}
                  {popoutNotice}
                </MacCard>
              </div>
            </>
          )}
        </div>
      </PageShell>

      <ConfirmDialog
        open={pendingConnect !== null}
        title="보호 레벨 클러스터에 접속"
        description="이 클러스터는 보호 레벨입니다. 접속 대상과 계정을 확인한 뒤 연결하세요."
        confirmLabel={pendingConnect === 'popout' ? '새 창으로 연결' : '연결'}
        onCancel={() => setPendingConnect(null)}
        onConfirm={() => {
          const mode = pendingConnect;
          setPendingConnect(null);
          if (mode) doConnect(mode);
        }}
      >
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">클러스터</dt>
          <dd className="text-foreground">{cluster?.name ?? clusterId} · {levelText}</dd>
          <dt className="text-muted-foreground">대상</dt>
          <dd className="font-mono text-foreground break-all">
            {username}@{effectiveHost}:{port}{effectiveNodeName ? ` (${effectiveNodeName})` : ' (직접 입력)'}
          </dd>
          <dt className="text-muted-foreground">인증</dt>
          <dd className="text-foreground">{authMode === 'password' ? '비밀번호' : '개인키'}</dd>
          {initialCommand.trim() && (
            <>
              <dt className="text-muted-foreground">접속 후 실행</dt>
              <dd className="font-mono text-foreground break-all">{initialCommand.trim()}</dd>
            </>
          )}
          <dt className="text-muted-foreground">읽기 전용</dt>
          <dd className="text-foreground">해당 없음 — 로그인 셸은 계정 권한 그대로 동작합니다</dd>
        </dl>
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingCluster !== null}
        danger
        title="클러스터 전환"
        description={session
          ? `연결된 SSH 세션을 끊습니다 — ${session.username}@${session.host}:${session.port}. 실행 중인 원격 작업이 함께 종료됩니다.`
          : undefined}
        confirmLabel="세션 끊고 전환"
        onCancel={() => setPendingCluster(null)}
        onConfirm={() => {
          const next = pendingCluster;
          setPendingCluster(null);
          if (next) changeCluster(next.id);
        }}
      />
    </div>
  );
}
