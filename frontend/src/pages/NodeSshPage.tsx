import { useEffect, useId, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  TerminalSquare, Key, Play, ShieldAlert, ExternalLink, Search, Loader2,
  CheckCircle, XCircle, Wifi, Clock, Plug,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { ClusterSidebar, EmptyState } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { NodeSshTerminal, type NodeSshConnectParams } from '@/components/k8s';
import { openNodeSshPopout } from '@/lib/nodeSshPopout';
import { useTerminalEnvSync } from '@/hooks/useTerminalEnvSync';
import { formatApiError } from '@/lib/utils';
import { bulkExecApi, nodeSshApi, type NodeSshTestResult, type NodeSummary } from '@/services/api';

const TEST_STATUS_META: Record<
  NodeSshTestResult['status'],
  { label: string; cls: string; icon: React.ComponentType<{ className?: string }> }
> = {
  ok:            { label: '연결 성공', cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30', icon: CheckCircle },
  error:         { label: '에러',      cls: 'bg-red-500/10 text-red-400 border-red-500/30',             icon: XCircle },
  timeout:       { label: '타임아웃',  cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30',       icon: Clock },
  auth_error:    { label: '인증 실패', cls: 'bg-orange-500/10 text-orange-400 border-orange-500/30',    icon: ShieldAlert },
  connect_error: { label: '연결 실패', cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30',       icon: Wifi },
};

/**
 * 개별 노드 SSH 터미널 — 클러스터 노드 하나를 골라 **로그인 셸**을 웹 터미널로 연다.
 * k9s 콘솔이 control-plane 의 k9s TUI 만 띄우는 것과 달리 여기는 범용 셸이라
 * 로그 확인·서비스 상태 점검 같은 임의 작업을 그대로 할 수 있다.
 *
 * 재사용하는 base 툴: 노드 목록은 mc/bulk-exec 와 같은 `bulkExecApi.nodeList`,
 * 터미널 창은 k9s 와 같은 `SshTerminalWindow`(→ 백엔드 `services/ssh_pty`),
 * 창 간 handoff 는 `lib/terminalPopout.ts`. SSH 인증정보는 저장하지 않는다.
 */
export function NodeSshPage() {
  const { clusterId = '' } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const { data: clusters = [] } = useClusters();
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

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
  const [popoutMsg, setPopoutMsg] = useState('');

  // 클러스터가 바뀌면 대상/자격증명을 초기화한다(다른 클러스터에 그대로 붙지 않도록).
  useEffect(() => {
    setSelectedNodeName('');
    setCustomHost('');
    setNodeFilter('');
    setPassword('');
    setPrivateKey('');
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

  const handleConnect = () => {
    if (!canConnect) return;
    setPopoutMsg('');
    setSession(buildParams());
  };

  // 폼에서 바로 별도 창으로 연결 (인라인 세션은 만들지 않음).
  const handlePopOutFromForm = () => {
    if (!canConnect) return;
    const win = openNodeSshPopout({ params: buildParams() });
    setPopoutMsg(win ? '' : '팝업이 차단되었습니다. 브라우저에서 이 사이트의 팝업을 허용한 뒤 다시 시도하세요.');
  };

  // 인라인 세션을 별도 창으로 이동 — 성공 시 메인 창 세션은 닫는다(중복 세션 방지).
  const popOutSession = () => {
    if (!session) return;
    const win = openNodeSshPopout({ params: session });
    if (win) setSession(null);
    else setPopoutMsg('팝업이 차단되었습니다. 브라우저에서 이 사이트의 팝업을 허용한 뒤 다시 시도하세요.');
  };

  const testMeta = testM.data ? TEST_STATUS_META[testM.data.status] : null;
  const TestIcon = testMeta?.icon;

  return (
    <div className="app-min-h-screen bg-background py-3 pr-3">
      <div className="flex gap-3">
        <div className="sticky top-3 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            onSelect={(id) => { navigate(`/node-ssh/${id ?? ''}`); setSession(null); }}
            iconOnly
          />
        </div>

        <div className="flex-1 min-w-0 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-lg font-semibold flex items-center gap-2">
              <TerminalSquare className="w-5 h-5 text-primary" /> 노드 SSH 터미널
            </h1>
            <span className="text-sm text-muted-foreground">
              개별 노드에 SSH 로그인 셸을 열어 웹 터미널로 사용
            </span>
            {effectiveHost && (
              <span className="ml-auto text-sm px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-400 border border-slate-500/30 font-mono">
                → {username}@{effectiveHost}:{port}
              </span>
            )}
          </div>

          {!clusterId ? (
            <MacCard>
              <EmptyState
                title="클러스터를 선택하세요"
                description="좌측에서 클러스터를 고르면 노드 목록과 접속 정보를 입력할 수 있습니다."
              />
            </MacCard>
          ) : session ? (
            <>
              <MacCard className="text-sm text-muted-foreground leading-relaxed">
                SSH 세션이 <b className="text-foreground">플로팅 창</b>으로 열려 있습니다 —
                창 상단바를 <b className="text-foreground">드래그해 위치를 이동</b>하고, 우하단 모서리를 끌어 크기를 조절할 수 있습니다.
                단, 다른 페이지로 이동하면 세션이 끊기므로 계속 쓰려면 창 상단바의
                <b className="text-foreground"> 새 창으로 빼기</b>(별도 브라우저 창)를 이용하세요.
              </MacCard>
              {popoutMsg && (
                <p className="text-xs text-status-warning flex items-center gap-1">
                  <ShieldAlert className="w-3 h-3" /> {popoutMsg}
                </p>
              )}
              <NodeSshTerminal params={session} onClose={() => setSession(null)} onPopOut={popOutSession} />
            </>
          ) : (
            <>
              <MacCard className="text-sm text-muted-foreground leading-relaxed">
                선택한 노드에 SSH 로 접속해 <b className="text-foreground">로그인 셸을 그대로</b> 웹 터미널(tty + resize)로 씁니다 —
                `journalctl`, `top`, `vi` 같은 인터랙티브 명령도 동작합니다.
                SSH 인증정보는 이 세션에만 사용되고 저장되지 않습니다. (admin/operator 권한 필요)
                <br />
                여러 노드에 <b className="text-foreground">같은 명령을 한 번에</b> 돌려야 한다면 <b className="text-foreground">노드 일괄 실행</b>,
                클러스터 리소스를 TUI 로 탐색하려면 <b className="text-foreground">k9s 콘솔</b>을 쓰세요.
              </MacCard>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
                {/* 타겟 노드 */}
                <MacCard title="타겟 노드" className="space-y-3">
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
                      <p className="px-3 py-4 text-sm text-muted-foreground flex items-center gap-2">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" /> 노드 목록 불러오는 중…
                      </p>
                    )}
                    {nodesQ.isError && (
                      <p className="px-3 py-4 text-sm text-status-critical">
                        노드 목록 조회 실패: {formatApiError(nodesQ.error)}
                      </p>
                    )}
                    {!nodesQ.isLoading && !nodesQ.isError && filteredNodes.length === 0 && (
                      <p className="px-3 py-4 text-sm text-muted-foreground">조건에 맞는 노드가 없습니다.</p>
                    )}
                    {filteredNodes.map((n: NodeSummary) => {
                      const active = !customHost.trim() && n.name === selectedNodeName;
                      return (
                        <button
                          key={n.name}
                          type="button"
                          onClick={() => { setSelectedNodeName(n.name); setCustomHost(''); }}
                          className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${
                            active ? 'bg-primary/10' : 'hover:bg-secondary'
                          }`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full shrink-0 ${n.ready ? 'bg-emerald-500' : 'bg-red-500'}`}
                            title={n.ready ? 'Ready' : 'NotReady'}
                          />
                          <span className={`text-sm truncate ${active ? 'text-foreground font-medium' : 'text-foreground/80'}`}>
                            {n.name}
                          </span>
                          <span className="text-xs font-mono text-muted-foreground ml-auto shrink-0">
                            {n.internalIp ?? '—'}
                          </span>
                          {n.roles.includes('control-plane') && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-500/15 text-orange-400 border border-orange-500/30 shrink-0">
                              master
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  <div>
                    <label htmlFor={f('host')} className="block text-sm text-muted-foreground mb-1">
                      수동 host override <span className="text-xs opacity-60">(비우면 위에서 고른 노드 사용)</span>
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
                    <p className="block text-sm text-muted-foreground mb-1">인증 방식</p>
                    <div className="flex items-center bg-secondary/60 rounded-xl p-[3px] gap-px">
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
                      placeholder="SSH 비밀번호" aria-label="SSH 비밀번호"
                      className="w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
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
                        className="w-full px-3 py-2 text-xs font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                      />
                    </div>
                  )}

                  <div>
                    <label htmlFor={f('initcmd')} className="block text-sm text-muted-foreground mb-1">
                      접속 후 실행 <span className="text-xs opacity-60">(선택 — 셸에 한 줄로 입력됩니다)</span>
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
                      onClick={handleConnect}
                      disabled={!canConnect}
                      className="flex-1 px-3 py-2 text-sm font-medium rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      <Play className="w-4 h-4" /> 연결
                    </button>
                    <button
                      onClick={handlePopOutFromForm}
                      disabled={!canConnect}
                      title="별도 브라우저 창으로 열기 — 메인 화면에서 다른 페이지로 이동하며 함께 사용"
                      className="px-3 py-2 text-sm font-medium rounded-xl border border-border text-foreground hover:bg-secondary disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      <ExternalLink className="w-4 h-4" /> 새 창으로 열기
                    </button>
                    <button
                      onClick={() => testM.mutate()}
                      disabled={!canConnect || testM.isPending}
                      title="터미널을 열지 않고 호스트/자격증명만 확인"
                      aria-label="연결 테스트"
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

                  {!canConnect && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <ShieldAlert className="w-3 h-3" /> 노드(또는 host) 와 {authMode === 'password' ? '비밀번호' : 'private key'} 를 입력하세요.
                    </p>
                  )}
                  {popoutMsg && (
                    <p className="text-xs text-status-warning flex items-center gap-1">
                      <ShieldAlert className="w-3 h-3" /> {popoutMsg}
                    </p>
                  )}
                </MacCard>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
