import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ShipWheel, Key, Play, ShieldAlert, ExternalLink, RotateCw } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import {
  ClusterSidebar, ConfirmDialog, ErrorState, PageShell, SelectClusterEmptyState,
} from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { MacCard } from '@/components/ui/MacCard';
import { K9sTerminal, type K9sConnectParams, type SshTerminalStatus } from '@/components/k8s';
import { openK9sPopout } from '@/lib/k9sPopout';
import { useTerminalEnvSync } from '@/hooks/useTerminalEnvSync';
import { useCanOperate } from '@/hooks/useCanOperate';
import { isGuardedLevel, levelLabel, useOperationLevels } from '@/hooks/useOperationLevels';
import { etcdctlApi, type EtcdMasterCandidate } from '@/services/api';

const POPUP_BLOCKED_MSG = '팝업이 차단되었습니다. 브라우저에서 이 사이트의 팝업을 허용한 뒤 다시 시도하세요.';
const HANDOFF_FAILED_MSG = '새 창에 접속 정보를 전달하지 못했습니다 — "다시 열기"를 눌러 다시 여세요.';

/**
 * k9s 콘솔 — 클러스터 컨트롤 플레인 서버에 내장된 `k9s` 를 SSH 로 실행해 웹 터미널로
 * 스트리밍한다. 좌측 ClusterSidebar(iconOnly) 로 클러스터를 고르고, 대상/인증을 입력한 뒤
 * "연결"하면 K9sTerminal(xterm) 이 열린다. SSH 인증정보는 이 세션에만 쓰이고 저장되지 않는다.
 *
 * 보호 레벨(운영레벨 `guarded`, Settings ▸ 운영레벨) 클러스터는 읽기 전용(`--readonly`)이
 * 기본으로 켜지고(끌 때 확인), 연결 전에 대상·계정·읽기 전용 여부를 한 번 더 확인한다.
 */
export function K9sPage() {
  const { clusterId = '' } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const clustersQ = useClusters();
  const clusters = useMemo(() => clustersQ.data ?? [], [clustersQ.data]);
  const f = useId();
  const { canOperate, hint, withHint, ariaWithHint } = useCanOperate(clusterId || null);
  const { data: levels } = useOperationLevels();

  // clusterId 없으면 첫 클러스터로 이동
  useEffect(() => {
    if (!clusterId && clusters.length > 0) {
      navigate(`/k9s/${clusters[0].id}`, { replace: true });
    }
  }, [clusterId, clusters, navigate]);

  // 선택한 클러스터의 운영등급으로 터미널 Appearance 활성 프로파일(개발/운영)을 맞춘다(§12.6 PTY).
  useTerminalEnvSync(clusters, clusterId || null);

  const cluster = useMemo(() => clusters.find((c) => c.id === clusterId), [clusters, clusterId]);
  const guarded = isGuardedLevel(levels, cluster?.operationLevel);

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
  const [termStatus, setTermStatus] = useState<SshTerminalStatus | null>(null);
  const [popoutMsg, setPopoutMsg] = useState('');
  // handoff 실패 시 "다시 열기" 용 — 메모리에만 두고 클러스터 전환·재시도 때 비운다.
  const [retryParams, setRetryParams] = useState<K9sConnectParams | null>(null);
  const [pendingConnect, setPendingConnect] = useState<'inline' | 'popout' | null>(null);
  const [confirmReadonlyOff, setConfirmReadonlyOff] = useState(false);
  const [pendingCluster, setPendingCluster] = useState<{ id: string | null } | null>(null);
  const clusterIdRef = useRef(clusterId);
  clusterIdRef.current = clusterId;

  // 보호 레벨 클러스터는 읽기 전용을 기본으로 켠다(정책 3). 클러스터·판정이 바뀔 때만 다시 맞춘다.
  useEffect(() => {
    setReadonly(guarded);
  }, [clusterId, guarded]);

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
    setTermStatus(null);
    setSelectedMasterName('');
    setCustomHost('');
    setPassword('');
    setPrivateKey('');
    setRetryParams(null);
    setPopoutMsg('');
  };

  // 열린 세션이 있으면 클러스터 전환 전에 확인한다(D-177).
  const requestClusterChange = (id: string | null) => {
    if (session && termStatus === 'open') setPendingCluster({ id });
    else resetForCluster(id);
  };

  const buildParams = (): K9sConnectParams => ({
    host: effectiveHost, port, username, authMode, password, privateKey,
    namespace: namespace.trim() || undefined, readonly,
  });

  const openPopout = (params: K9sConnectParams): Window | null => {
    setPopoutMsg('');
    setRetryParams(null);
    const cid = clusterId;
    const win = openK9sPopout({ clusterId: cid, params }, (delivered) => {
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

  const retryPopout = () => {
    if (retryParams) openPopout(retryParams);
  };

  const onReadonlyChange = (checked: boolean) => {
    if (!checked && guarded) setConfirmReadonlyOff(true);
    else setReadonly(checked);
  };

  const levelText = levelLabel(levels, cluster?.operationLevel) || '미지정';
  const inputCls = 'w-full px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary';

  const popoutNotice = popoutMsg ? (
    <div className="flex items-center gap-2 flex-wrap" role="status">
      <p className="text-xs text-status-warning flex items-center gap-1">
        <ShieldAlert className="w-3 h-3" aria-hidden="true" /> {popoutMsg}
      </p>
      {retryParams && (
        <button
          type="button"
          onClick={retryPopout}
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
            icon={ShipWheel}
            title="k9s 콘솔"
            description="컨트롤 플레인 서버에 내장된 k9s 를 SSH 로 실행해 웹 터미널로 엽니다"
            actions={effectiveHost ? (
              <span className="text-sm px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border font-mono">
                → {username}@{effectiveHost}
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
            <SelectClusterEmptyState description="좌측에서 클러스터를 고르면 k9s 접속 정보를 입력할 수 있습니다." />
          ) : session ? (
            <>
              <p className="text-sm text-muted-foreground leading-relaxed">
                k9s 세션이 <b className="text-foreground">플로팅 창</b>으로 열려 있습니다 —
                창 상단바를 <b className="text-foreground">드래그해 위치를 이동</b>하고, 우하단 모서리를 끌어 크기를 조절할 수 있습니다.
                세션은 최대 1시간 유지되며 남은 시간은 창 상단에 표시됩니다. 다른 메뉴로 이동하면 세션이 끊기므로 계속 쓰려면 창 상단바의
                <b className="text-foreground"> 새 창으로 빼기</b>(별도 브라우저 창)를 이용하세요.
              </p>
              {popoutNotice}
              <K9sTerminal
                clusterId={clusterId}
                params={session}
                onClose={() => { setSession(null); setTermStatus(null); }}
                onPopOut={popOutSession}
                onStatusChange={setTermStatus}
              />
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground leading-relaxed">
                전제: 각 클러스터의 <b className="text-foreground">컨트롤 플레인 서버에 <code className="font-mono">k9s</code> 가 설치</b>되어 있고,
                해당 계정의 기본 kubeconfig(<code className="font-mono">~/.kube/config</code>)로 클러스터에 접근할 수 있어야 합니다.
                SSH 인증정보는 이 세션에만 사용되고 저장되지 않습니다(operator 이상 권한 필요).
                <br /><b className="text-foreground">“연결”</b> 은 이 화면 안에 <b className="text-foreground">드래그로 이동·크기 조절이 가능한 플로팅 창</b>으로 k9s 를 엽니다.
                <b className="text-foreground"> “새 창으로 열기”</b> 를 쓰면 k9s 가 별도 브라우저 창에서 열려, 메인 화면에서는 다른 페이지로 이동하며 함께 활용할 수 있습니다.
                {guarded && (
                  <>
                    <br />이 클러스터는 <b className="text-foreground">보호 레벨({levelText})</b>이라 읽기 전용이 기본으로 켜지고, 연결 전에 대상을 한 번 더 확인합니다.
                  </>
                )}
              </p>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {/* 대상 */}
                <MacCard title="대상" className="space-y-4">
                  <div>
                    <label htmlFor={`${f}-master`} className="block text-sm text-muted-foreground mb-1">컨트롤 플레인 노드</label>
                    <select
                      id={`${f}-master`}
                      value={selectedMasterName}
                      onChange={(e) => { setSelectedMasterName(e.target.value); setCustomHost(''); }}
                      disabled={!mastersQ.data?.candidates?.length}
                      className={`${inputCls} disabled:opacity-50`}
                    >
                      {mastersQ.isLoading && <option>불러오는 중…</option>}
                      {(mastersQ.data?.candidates ?? []).map((c: EtcdMasterCandidate) => (
                        <option key={c.name} value={c.name}>
                          {c.name}{c.internalIp ? ` (${c.internalIp})` : ''}
                        </option>
                      ))}
                      {mastersQ.data && mastersQ.data.candidates.length === 0 && (
                        <option value="">컨트롤 플레인 노드 없음 — 아래에 호스트를 직접 입력하세요</option>
                      )}
                    </select>
                    {mastersQ.isError && (
                      <div className="mt-2">
                        <ErrorState
                          compact
                          error={mastersQ.error}
                          title="컨트롤 플레인 노드를 불러오지 못했습니다"
                          onRetry={() => { void mastersQ.refetch(); }}
                        />
                      </div>
                    )}
                  </div>

                  <div>
                    <label htmlFor={`${f}-host`} className="block text-sm text-muted-foreground mb-1">
                      호스트 직접 입력 <span className="text-xs text-muted-foreground">(비우면 위에서 고른 노드 사용)</span>
                    </label>
                    <input
                      id={`${f}-host`}
                      type="text"
                      value={customHost}
                      onChange={(e) => setCustomHost(e.target.value)}
                      placeholder="예: 192.168.10.11"
                      className={`${inputCls} font-mono`}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label htmlFor={`${f}-user`} className="block text-sm text-muted-foreground mb-1">사용자</label>
                      <input
                        id={`${f}-user`}
                        type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label htmlFor={`${f}-port`} className="block text-sm text-muted-foreground mb-1">포트</label>
                      <input
                        id={`${f}-port`}
                        type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)}
                        className={inputCls}
                      />
                    </div>
                  </div>
                </MacCard>

                {/* 인증 + 실행 옵션 */}
                <MacCard title="인증 · 실행" className="space-y-4">
                  <div>
                    <p id={`${f}-auth`} className="block text-sm text-muted-foreground mb-1">인증 방식</p>
                    <div className="flex items-center bg-secondary/60 rounded-xl p-[3px] gap-px" role="group" aria-labelledby={`${f}-auth`}>
                      {(['password', 'key'] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setAuthMode(m)}
                          aria-pressed={authMode === m}
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
                      <label htmlFor={`${f}-pw`} className="block text-sm text-muted-foreground mb-1">SSH 비밀번호</label>
                      <input
                        id={`${f}-pw`}
                        type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                        autoComplete="off"
                        className={inputCls}
                      />
                    </div>
                  ) : (
                    <div>
                      <label htmlFor={`${f}-pkey`} className="text-sm text-muted-foreground mb-1 flex items-center gap-1">
                        <Key className="w-3 h-3" aria-hidden="true" /> 개인키(PEM)
                      </label>
                      <textarea
                        id={`${f}-pkey`}
                        value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
                        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" rows={4}
                        className="w-full px-3 py-2 text-xs font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                      />
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label htmlFor={`${f}-ns`} className="block text-sm text-muted-foreground mb-1">
                        네임스페이스 <span className="text-xs text-muted-foreground">(선택)</span>
                      </label>
                      <input
                        id={`${f}-ns`}
                        type="text" value={namespace} onChange={(e) => setNamespace(e.target.value)}
                        placeholder="예: kube-system"
                        className={inputCls}
                      />
                    </div>
                    <label className="flex items-end gap-2 pb-2 text-sm text-muted-foreground cursor-pointer">
                      <input
                        type="checkbox" checked={readonly} onChange={(e) => onReadonlyChange(e.target.checked)}
                        className="w-4 h-4 accent-primary"
                      />
                      읽기 전용 (<code className="font-mono">--readonly</code>)
                      {guarded && <span className="text-xs">· 보호 레벨 기본</span>}
                    </label>
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => requestConnect('inline')}
                      disabled={!canConnect || !canOperate}
                      title={withHint('이 화면의 플로팅 창으로 k9s 연결')}
                      aria-label={ariaWithHint('연결')}
                      className="flex-1 px-3 py-2 text-sm font-medium rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      <Play className="w-4 h-4" aria-hidden="true" /> 연결
                    </button>
                    <button
                      type="button"
                      onClick={() => requestConnect('popout')}
                      disabled={!canConnect || !canOperate}
                      title={withHint('별도 브라우저 창으로 열기 — 메인 화면에서 다른 페이지로 이동하며 함께 사용')}
                      aria-label={ariaWithHint('새 창으로 열기')}
                      className="px-3 py-2 text-sm font-medium rounded-xl border border-border text-foreground hover:bg-secondary disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      <ExternalLink className="w-4 h-4" aria-hidden="true" /> 새 창으로 열기
                    </button>
                  </div>
                  {!canOperate ? (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <ShieldAlert className="w-3 h-3" aria-hidden="true" /> {hint}
                    </p>
                  ) : !canConnect && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <ShieldAlert className="w-3 h-3" aria-hidden="true" /> 호스트와 {authMode === 'password' ? '비밀번호' : '개인키'}를 입력하세요.
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
          <dd className="font-mono text-foreground break-all">{username}@{effectiveHost}:{port}</dd>
          <dt className="text-muted-foreground">인증</dt>
          <dd className="text-foreground">{authMode === 'password' ? '비밀번호' : '개인키'}</dd>
          {namespace.trim() && (
            <>
              <dt className="text-muted-foreground">네임스페이스</dt>
              <dd className="font-mono text-foreground">{namespace.trim()}</dd>
            </>
          )}
          <dt className="text-muted-foreground">읽기 전용</dt>
          <dd className={readonly ? 'text-foreground' : 'text-status-critical font-medium'}>
            {readonly ? '켜짐 (--readonly)' : '꺼짐 — k9s 에서 리소스를 수정·삭제할 수 있습니다'}
          </dd>
        </dl>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmReadonlyOff}
        danger
        title="읽기 전용 해제"
        description={`보호 레벨(${levelText}) 클러스터입니다. 읽기 전용을 끄면 k9s 에서 리소스 편집·삭제·스케일·셸 진입이 가능해집니다.`}
        confirmLabel="읽기 전용 끄기"
        onCancel={() => setConfirmReadonlyOff(false)}
        onConfirm={() => { setConfirmReadonlyOff(false); setReadonly(false); }}
      />

      <ConfirmDialog
        open={pendingCluster !== null}
        danger
        title="클러스터 전환"
        description={session
          ? `연결된 SSH 세션을 끊습니다 — ${session.username}@${session.host}:${session.port}. 실행 중인 k9s 화면이 함께 종료됩니다.`
          : undefined}
        confirmLabel="세션 끊고 전환"
        onCancel={() => setPendingCluster(null)}
        onConfirm={() => {
          const next = pendingCluster;
          setPendingCluster(null);
          if (next) resetForCluster(next.id);
        }}
      />
    </div>
  );
}
