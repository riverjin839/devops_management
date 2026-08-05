import { useEffect, useId, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ShipWheel, Key, Play, ShieldAlert, ExternalLink } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { ClusterSidebar, EmptyState } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { K9sTerminal, type K9sConnectParams } from '@/components/k8s';
import { openK9sPopout } from '@/lib/k9sPopout';
import { etcdctlApi, type EtcdMasterCandidate } from '@/services/api';

/**
 * k9s 콘솔 — 클러스터 control-plane 서버에 내장된 `k9s` 를 SSH 로 실행해 웹 터미널로
 * 스트리밍한다. 좌측 ClusterSidebar(iconOnly) 로 클러스터를 고르고, 타겟/인증을 입력한 뒤
 * "연결"하면 K9sTerminal(xterm) 이 열린다. SSH 인증정보는 이 세션에만 쓰이고 저장되지 않는다.
 */
export function K9sPage() {
  const { clusterId = '' } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const { data: clusters = [] } = useClusters();
  const f = useId();

  // clusterId 없으면 첫 클러스터로 이동
  useEffect(() => {
    if (!clusterId && clusters.length > 0) {
      navigate(`/k9s/${clusters[0].id}`, { replace: true });
    }
  }, [clusterId, clusters, navigate]);

  // master(control-plane) 후보 — etcdctl 라우터의 master-candidates 재사용
  const mastersQ = useQuery({
    queryKey: ['k9s', 'masters', clusterId],
    queryFn: () => etcdctlApi.masters(clusterId).then((r) => r.data),
    enabled: !!clusterId,
    staleTime: 60_000,
  });

  const [selectedMasterName, setSelectedMasterName] = useState('');
  const [customHost, setCustomHost] = useState('');
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState('root');
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [namespace, setNamespace] = useState('');
  const [readonly, setReadonly] = useState(false);
  const [session, setSession] = useState<K9sConnectParams | null>(null);
  const [popoutMsg, setPopoutMsg] = useState('');

  // 첫 후보 자동선택
  useEffect(() => {
    if (!mastersQ.data) return;
    if (!selectedMasterName && mastersQ.data.candidates.length > 0) {
      setSelectedMasterName(mastersQ.data.candidates[0].name);
    }
  }, [mastersQ.data, selectedMasterName]);

  const effectiveHost = useMemo(() => {
    if (customHost.trim()) return customHost.trim();
    const m = (mastersQ.data?.candidates ?? []).find(
      (c: EtcdMasterCandidate) => c.name === selectedMasterName);
    return m?.internalIp || m?.externalIp || '';
  }, [customHost, mastersQ.data, selectedMasterName]);

  const canConnect = !!effectiveHost && !!username
    && (authMode === 'password' ? !!password : !!privateKey.trim());

  const resetForCluster = (id: string | null) => {
    navigate(`/k9s/${id ?? ''}`);
    setSession(null);
    setSelectedMasterName('');
    setCustomHost('');
    setPassword('');
    setPrivateKey('');
  };

  const buildParams = (): K9sConnectParams => ({
    host: effectiveHost, port, username, authMode, password, privateKey,
    namespace: namespace.trim() || undefined, readonly,
  });

  const handleConnect = () => {
    if (!canConnect) return;
    setPopoutMsg('');
    setSession(buildParams());
  };

  // 폼에서 바로 별도 창으로 연결 (인라인 세션은 만들지 않음).
  const handlePopOutFromForm = () => {
    if (!canConnect) return;
    const win = openK9sPopout({ clusterId, params: buildParams() });
    setPopoutMsg(win ? '' : '팝업이 차단되었습니다. 브라우저에서 이 사이트의 팝업을 허용한 뒤 다시 시도하세요.');
  };

  // 인라인 세션을 별도 창으로 이동 — 성공 시 메인 창 세션은 닫는다(중복 세션 방지).
  const popOutSession = () => {
    if (!session) return;
    const win = openK9sPopout({ clusterId, params: session });
    if (win) setSession(null);
    else setPopoutMsg('팝업이 차단되었습니다. 브라우저에서 이 사이트의 팝업을 허용한 뒤 다시 시도하세요.');
  };

  return (
    <div className="app-min-h-screen bg-background py-3 pr-3">
      <div className="flex gap-3">
        <div className="sticky top-3 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            onSelect={(id) => resetForCluster(id)}
            iconOnly
          />
        </div>

        <div className="flex-1 min-w-0 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-lg font-semibold flex items-center gap-2">
              <ShipWheel className="w-5 h-5 text-primary" /> k9s 콘솔
            </h1>
            <span className="text-sm text-muted-foreground">
              control-plane 서버에 내장된 k9s 를 SSH 로 실행해 스트리밍
            </span>
            {effectiveHost && (
              <span className="ml-auto text-sm px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-400 border border-slate-500/30 font-mono">
                → {username}@{effectiveHost}
              </span>
            )}
          </div>

          {!clusterId ? (
            <MacCard>
              <EmptyState title="클러스터를 선택하세요" description="좌측에서 클러스터를 고르면 k9s 접속 정보를 입력할 수 있습니다." />
            </MacCard>
          ) : session ? (
            <>
              <MacCard className="text-sm text-muted-foreground leading-relaxed">
                k9s 세션이 <b className="text-foreground">플로팅 창</b>으로 열려 있습니다 —
                창 상단바를 <b className="text-foreground">드래그해 위치를 이동</b>하고, 우하단 모서리를 끌어 크기를 조절할 수 있습니다.
                단, 다른 페이지로 이동하면 세션이 끊기므로 계속 쓰려면 창 상단바의
                <b className="text-foreground"> 새 창으로 빼기</b>(별도 브라우저 창)를 이용하세요.
              </MacCard>
              {popoutMsg && (
                <p className="text-xs text-status-warning flex items-center gap-1">
                  <ShieldAlert className="w-3 h-3" /> {popoutMsg}
                </p>
              )}
              <K9sTerminal clusterId={clusterId} params={session} onClose={() => setSession(null)} onPopOut={popOutSession} />
            </>
          ) : (
            <>
              <MacCard className="text-sm text-muted-foreground leading-relaxed">
                전제: 각 클러스터의 <b className="text-foreground">control-plane(master) 서버에 <code className="font-mono">k9s</code> 가 설치</b>되어 있고,
                해당 계정의 기본 kubeconfig(<code className="font-mono">~/.kube/config</code>)로 클러스터에 접근 가능해야 합니다.
                SSH 인증정보는 이 세션에만 사용되고 저장되지 않습니다. (admin/operator 권한 필요)
                <br /><b className="text-foreground">“연결”</b> 은 이 화면 안에 <b className="text-foreground">드래그로 이동·크기 조절이 가능한 플로팅 창</b>으로 k9s 를 엽니다.
                <b className="text-foreground"> “새 창으로 열기”</b> 를 쓰면 k9s 가 별도 브라우저 창에서 열려, 메인 화면에서는 다른 페이지로 이동하며 함께 활용할 수 있습니다.
              </MacCard>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {/* 타겟 */}
                <MacCard title="타겟" className="space-y-4">
                  <div>
                    <label htmlFor={`${f}-master`} className="block text-sm text-muted-foreground mb-1">master 노드 후보</label>
                    <select
                      id={`${f}-master`}
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
                    <label htmlFor={`${f}-host`} className="block text-sm text-muted-foreground mb-1">
                      수동 host override <span className="text-xs opacity-60">(비우면 위 드롭다운 사용)</span>
                    </label>
                    <input
                      id={`${f}-host`}
                      type="text"
                      value={customHost}
                      onChange={(e) => setCustomHost(e.target.value)}
                      placeholder="예: 192.168.10.11"
                      className="w-full px-3 py-2 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label htmlFor={`${f}-user`} className="block text-sm text-muted-foreground mb-1">사용자</label>
                      <input
                        id={`${f}-user`}
                        type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                        className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                    <div>
                      <label htmlFor={`${f}-port`} className="block text-sm text-muted-foreground mb-1">포트</label>
                      <input
                        id={`${f}-port`}
                        type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)}
                        className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </div>
                </MacCard>

                {/* 인증 + 실행 옵션 */}
                <MacCard title="인증 · 실행" className="space-y-4">
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
                      <label htmlFor={`${f}-pkey`} className="text-sm text-muted-foreground mb-1 flex items-center gap-1">
                        <Key className="w-3 h-3" /> Private Key (PEM)
                      </label>
                      <textarea
                        id={`${f}-pkey`}
                        value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
                        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" rows={4}
                        className="w-full px-3 py-2 text-xs font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                      />
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label htmlFor={`${f}-ns`} className="block text-sm text-muted-foreground mb-1">
                        네임스페이스 <span className="text-xs opacity-60">(선택)</span>
                      </label>
                      <input
                        id={`${f}-ns`}
                        type="text" value={namespace} onChange={(e) => setNamespace(e.target.value)}
                        placeholder="예: kube-system"
                        className="w-full px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                    <label className="flex items-end gap-2 pb-2 text-sm text-muted-foreground cursor-pointer">
                      <input
                        type="checkbox" checked={readonly} onChange={(e) => setReadonly(e.target.checked)}
                        className="w-4 h-4 accent-primary"
                      />
                      읽기 전용 (--readonly)
                    </label>
                  </div>

                  <div className="flex gap-2">
                    <button
                      onClick={handleConnect}
                      disabled={!canConnect}
                      className="flex-1 px-3 py-2 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      <Play className="w-4 h-4" /> 연결
                    </button>
                    <button
                      onClick={handlePopOutFromForm}
                      disabled={!canConnect}
                      title="별도 브라우저 창으로 열기 — 메인 화면에서 다른 페이지로 이동하며 함께 사용"
                      className="px-3 py-2 text-sm font-medium rounded-lg border border-border text-foreground hover:bg-secondary disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      <ExternalLink className="w-4 h-4" /> 새 창으로 열기
                    </button>
                  </div>
                  {!canConnect && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <ShieldAlert className="w-3 h-3" /> host 와 {authMode === 'password' ? '비밀번호' : 'private key'} 를 입력하세요.
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
