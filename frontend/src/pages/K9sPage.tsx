import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ShipWheel, Key, Play, ShieldAlert, ExternalLink, RotateCw } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import {
  ClusterSidebar, ConfirmDialog, ErrorState, PageShell, RunLogPanel, SelectClusterEmptyState,
} from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { MacCard } from '@/components/ui/MacCard';
import { K9sTerminal, type K9sConnectParams, type SshTerminalEvent, type SshTerminalStatus } from '@/components/k8s';
import { openK9sPopout } from '@/lib/k9sPopout';
import { useTerminalEnvSync } from '@/hooks/useTerminalEnvSync';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useRunLog, type RunLogHandle } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { isGuardedLevel, levelLabel, useOperationLevels } from '@/hooks/useOperationLevels';
import { etcdctlApi, type EtcdMasterCandidate } from '@/services/api';

const POPUP_BLOCKED_MSG = '팝업이 차단되었습니다. 브라우저에서 이 사이트의 팝업을 허용한 뒤 다시 시도하세요.';
/** 클러스터별로 기억하는 접속 입력값 — 비밀번호·개인키는 절대 넣지 않는다(비저장 원칙). */
interface K9sRemembered {
  selectedMasterName?: string; customHost?: string; username?: string;
  port?: string; authMode?: 'password' | 'key'; namespace?: string;
}
const rememberKey = (clusterId: string) => `k9s:last:${clusterId}`;
function loadRemembered(clusterId: string): K9sRemembered {
  try {
    const raw = localStorage.getItem(rememberKey(clusterId));
    return raw ? (JSON.parse(raw) as K9sRemembered) : {};
  } catch { return {}; }
}
function saveRemembered(clusterId: string, v: K9sRemembered) {
  try { localStorage.setItem(rememberKey(clusterId), JSON.stringify(v)); } catch { /* 저장 불가 환경은 무시 */ }
}

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
  const levelsQ = useOperationLevels();
  const levels = levelsQ.data;

  // clusterId 없으면 첫 클러스터로 이동
  useEffect(() => {
    if (!clusterId && clusters.length > 0) {
      navigate(`/k9s/${clusters[0].id}`, { replace: true });
    }
  }, [clusterId, clusters, navigate]);

  // 선택한 클러스터의 운영등급으로 터미널 Appearance 활성 프로파일(개발/운영)을 맞춘다(§12.6 PTY).
  useTerminalEnvSync(clusters, clusterId || null);

  const cluster = useMemo(() => clusters.find((c) => c.id === clusterId), [clusters, clusterId]);
  // fail-closed: 운영레벨이 미지정이거나 레벨 목록을 아직 못 읽었으면 보호 레벨로 취급한다(읽기 전용 기본 + 연결 전 확인).
  const levelUnknown = !cluster?.operationLevel;
  const guarded = levelUnknown || levelsQ.isLoading || isGuardedLevel(levels, cluster?.operationLevel);
  // 클러스터·레벨 판정이 끝나기 전에는 연결하지 못하게 막는다(판정 전 쓰기 가능 연결 방지).
  const levelPending = clustersQ.isLoading || levelsQ.isLoading;

  // master(control-plane) 후보 — etcdctl 라우터의 master-candidates 재사용
  const mastersQ = useQuery({
    queryKey: ['k9s', 'masters', clusterId],
    queryFn: () => etcdctlApi.masters(clusterId).then((r) => r.data),
    enabled: !!clusterId,
    staleTime: 60_000,
  });

  const [selectedMasterName, setSelectedMasterName] = useState('');
  const [customHost, setCustomHost] = useState('');
  const [portText, setPortText] = useState('22');
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
  // 연결 진행 상태·상세 로그(D-089) — 항상 수집하고 보일지는 사용자가 "로그 보기"로 정한다.
  const runLog = useRunLog();
  const [showRunLog, setShowRunLog] = useLogPref('k9s-connect');
  const runHandleRef = useRef<RunLogHandle | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  // 접속 실패(첫 응답 전 종료) 사유 — 폼으로 돌아와 인라인으로 보여준다. 입력값은 유지한다.
  const [connectError, setConnectError] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // 접속에 성공했을 때만 클러스터별로 기억할 입력값(비밀 제외).
  const pendingRememberRef = useRef<K9sRemembered | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const keyRef = useRef<HTMLTextAreaElement | null>(null);
  // 사용자가 중단한 시도의 늦은 이벤트(소켓 정리 직전 도착분)를 무시한다.
  const abortedRef = useRef(false);
  const popoutTimerRef = useRef<number | undefined>(undefined);
  const clusterIdRef = useRef(clusterId);
  clusterIdRef.current = clusterId;

  // 보호 레벨 클러스터는 읽기 전용을 기본으로 켠다(정책 3). 클러스터·판정이 바뀔 때만 다시 맞춘다.
  useEffect(() => {
    setReadonly(guarded);
  }, [clusterId, guarded]);

  // 클러스터를 고르면 그 클러스터에서 마지막에 쓴 접속 입력값(비밀 제외)을 불러온다.
  useEffect(() => {
    if (!clusterId) return;
    const r = loadRemembered(clusterId);
    setSelectedMasterName(r.selectedMasterName ?? '');
    setCustomHost(r.customHost ?? '');
    setUsername(r.username ?? 'root');
    setPortText(r.port ?? '22');
    setAuthMode(r.authMode ?? 'password');
    setNamespace(r.namespace ?? '');
    setAdvancedOpen((r.port ?? '22') !== '22' || !!r.namespace);
  }, [clusterId]);

  // 첫 후보 자동선택
  useEffect(() => {
    if (!mastersQ.data) return;
    const cands = mastersQ.data.candidates;
    if (cands.length > 0 && (!selectedMasterName || !cands.some((c: EtcdMasterCandidate) => c.name === selectedMasterName))) {
      setSelectedMasterName(cands[0].name);
    }
  }, [mastersQ.data, selectedMasterName]);

  const effectiveHost = useMemo(() => {
    if (customHost.trim()) return customHost.trim();
    const m = (mastersQ.data?.candidates ?? []).find(
      (c: EtcdMasterCandidate) => c.name === selectedMasterName);
    return m?.internalIp || m?.externalIp || '';
  }, [customHost, mastersQ.data, selectedMasterName]);

  const port = Number(portText);
  const portValid = Number.isInteger(port) && port >= 1 && port <= 65535;
  const canConnect = !!effectiveHost && !!username && portValid && !levelPending
    && (authMode === 'password' ? !!password : !!privateKey.trim());

  const resetForCluster = (id: string | null) => {
    navigate(`/k9s/${id ?? ''}`);
    window.clearTimeout(popoutTimerRef.current);
    runHandleRef.current?.log('warn', '클러스터를 전환해 세션을 정리했습니다');
    runHandleRef.current?.end();
    setConnectError('');
    setSession(null);
    setTermStatus(null);
    setPassword('');
    setPrivateKey('');
    setRetryParams(null);
    setPopoutMsg('');
  };

  // 열린 세션이 있으면 클러스터 전환 전에 확인한다(D-177).
  const requestClusterChange = (id: string | null) => {
    // 연결 중(상태 미정 포함)에도 확인한다 — 끊긴 세션(closed/error)만 바로 전환.
    if (session && termStatus !== 'closed' && termStatus !== 'error') setPendingCluster({ id });
    else resetForCluster(id);
  };

  const onTerminalEvent = (e: SshTerminalEvent) => {
    if (abortedRef.current) return;
    if (e.reconnect) {
      // 재연결은 새 시도 — 새 로그 실행을 시작한다(끝난 실행에 이어 쓰면 "완료" 로 보인다).
      runHandleRef.current?.end();
      runHandleRef.current = runLog.begin('k9s 재연결', e.message);
    } else {
      // 핸들은 세션 동안 유지한다 — 첫 응답 이후의 끊김·만료도 같은 로그에 이어 쓴다.
      runHandleRef.current?.log(e.level, e.message);
    }
    e.steps?.forEach((st) => runHandleRef.current?.setStep(st.name, st.label, st.status));
    if (e.ready && pendingRememberRef.current) {
      saveRemembered(clusterIdRef.current, pendingRememberRef.current);
      pendingRememberRef.current = null;
    }
    if (e.end) runHandleRef.current?.end();
    if (e.failed) {
      // 접속 자체가 실패 — 창을 닫고 폼으로 돌아간다(입력값 유지, 비밀번호 칸에 포커스).
      setConnectError(e.userMessage ?? e.message);
      setSession(null);
      setTermStatus(null);
      window.setTimeout(() => (authMode === 'password' ? passwordRef : keyRef).current?.focus(), 0);
    }
  };

  // 진행 중인 연결 시도를 중단한다 — 웹소켓이 열렸어도 SSH 인증 전이면 소켓째 닫아 원격 셸이 남지 않게 한다.
  // (실행 중 로그는 첫 응답에서 끝나므로 이 버튼은 인증 전에만 보인다.)
  const abortConnect = () => {
    abortedRef.current = true;
    window.clearTimeout(popoutTimerRef.current);
    runHandleRef.current?.log('warn', '사용자가 연결을 중단했습니다');
    runHandleRef.current?.end();
    pendingRememberRef.current = null;
    setSession(null);
    setTermStatus(null);
  };

  const beginRunLog = (mode: 'inline' | 'popout') => {
    abortedRef.current = false;
    runHandleRef.current?.end();
    const where = `${username}@${effectiveHost}:${port}`;
    runHandleRef.current = runLog.begin(
      mode === 'popout' ? 'k9s 새 창 연결' : 'k9s 연결',
      `${cluster?.name ?? clusterId} · ${where} · ${authMode === 'password' ? '비밀번호' : '개인키'} 인증${readonly ? ' · 읽기 전용' : ''}${namespace.trim() ? ` · ns=${namespace.trim()}` : ''}`,
    );
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
      window.clearTimeout(popoutTimerRef.current);
      if (delivered) {
        runHandleRef.current?.log('info', '새 창에 접속 정보를 전달했습니다 — 이후 연결 진행은 새 창에서 확인하세요');
        if (pendingRememberRef.current) { saveRemembered(cid, pendingRememberRef.current); pendingRememberRef.current = null; }
        runHandleRef.current?.end();
      }
      if (delivered || clusterIdRef.current !== cid) return;
      runHandleRef.current?.log('error', '새 창에 접속 정보를 전달하지 못했습니다');
      setRetryParams(params);
      setPopoutMsg(HANDOFF_FAILED_MSG);
    });
    if (win) {
      // 전달 확인 콜백이 끝내 오지 않아도 로그가 "실행 중" 으로 남지 않게 한다.
      const h = runHandleRef.current;
      window.clearTimeout(popoutTimerRef.current);
      popoutTimerRef.current = window.setTimeout(() => {
        if (runHandleRef.current === h) {
          h?.log('warn', '새 창 전달 확인이 10초 안에 오지 않았습니다 — 새 창 상태를 확인하세요');
          h?.end();
        }
      }, 10_000);
    }
    if (!win) {
      setPopoutMsg(POPUP_BLOCKED_MSG);
      runHandleRef.current?.log('error', POPUP_BLOCKED_MSG);
      runHandleRef.current?.end();
    }
    return win;
  };

  const doConnect = (mode: 'inline' | 'popout') => {
    if (!canConnect || !canOperate || connectBusy) return;
    // 연속 클릭으로 세션·새 창이 두 번 열리지 않게 잠시 잠근다.
    setConnectBusy(true);
    window.setTimeout(() => setConnectBusy(false), 1500);
    pendingRememberRef.current = {
      selectedMasterName, customHost: customHost.trim(), username, port: portText, authMode, namespace: namespace.trim(),
    };
    setConnectError('');
    beginRunLog(mode);
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
    if (!retryParams) return;
    runHandleRef.current?.end();
    runHandleRef.current = runLog.begin('k9s 새 창 다시 열기', `${retryParams.username}@${retryParams.host}:${retryParams.port}`);
    openPopout(retryParams);
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
            manual="k9s"
            actions={clusterId ? (
              <>
                {/* 어느 클러스터에 어떤 위험 수준으로 붙는지 — 행동 지점(헤더)에 항상 보인다. 보호 레벨만 경고색. */}
                <span
                  className={`text-sm px-2 py-0.5 rounded-full border ${
                    guarded
                      ? 'bg-status-warning/10 text-status-warning border-status-warning/30 font-medium'
                      : 'bg-secondary text-muted-foreground border-border'
                  }`}
                  title={`클러스터 ${cluster?.name ?? clusterId} · 운영레벨 ${levelText}`}
                >
                  {cluster?.name ?? clusterId} · {levelText}
                </span>
                {effectiveHost && (
                  <span className="text-sm px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border font-mono">
                    → {username}@{effectiveHost}
                  </span>
                )}
              </>
            ) : undefined}
          />

          <RunLogPanel
            run={runLog}
            show={showRunLog}
            onShowChange={setShowRunLog}
            actions={runLog.running ? (
              <button
                type="button"
                onClick={abortConnect}
                title="진행 중인 연결 시도를 중단합니다"
                aria-label="연결 중단"
                className="text-xs px-2 py-1 rounded-xl border border-border bg-background hover:bg-secondary"
              >
                중단
              </button>
            ) : undefined}
          />

          {clustersQ.isError ? (
            <ErrorState
              error={clustersQ.error}
              title="클러스터 목록을 불러오지 못했습니다"
              onRetry={() => { void clustersQ.refetch(); }}
            />
          ) : !clusterId ? (
            <SelectClusterEmptyState description="좌측에서 클러스터를 선택하세요." />
          ) : session ? (
            <>
              {/* 세션 중에도 대상·옵션이 한눈에 보이도록 요약을 남긴다(폼은 접속 전에만 보인다). */}
              <MacCard title={termStatus === 'closed' || termStatus === 'error' ? '끊긴 세션' : '연결 중인 세션'} className="space-y-2">
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">대상</dt>
                  <dd className="font-mono text-foreground break-all">{session.username}@{session.host}:{session.port}</dd>
                  <dt className="text-muted-foreground">읽기 전용</dt>
                  <dd className={session.readonly ? 'text-foreground' : guarded ? 'text-status-critical font-medium' : 'text-foreground'}>
                    {session.readonly ? '켜짐 (--readonly)' : '꺼짐 — 수정·삭제 가능'}
                  </dd>
                  {session.namespace && (
                    <>
                      <dt className="text-muted-foreground">네임스페이스</dt>
                      <dd className="font-mono text-foreground">{session.namespace}</dd>
                    </>
                  )}
                </dl>
                <p className="text-sm text-muted-foreground">다른 메뉴로 이동하면 세션이 끊깁니다.</p>
              </MacCard>
              {popoutNotice}
              <K9sTerminal
                clusterId={clusterId}
                params={session}
                onClose={() => {
                  setSession(null); setTermStatus(null);
                  runHandleRef.current?.end();
                  // 세션이 끝나면 비밀은 더 필요 없다 — 메모리에서도 비운다.
                  setPassword(''); setPrivateKey('');
                }}
                onPopOut={popOutSession}
                onStatusChange={setTermStatus}
                onEvent={onTerminalEvent}
                contextLabel={`${cluster?.name ?? clusterId} · ${levelText}`}
                contextWarn={guarded && !session.readonly}
              />
            </>
          ) : (
            <>
              {connectError && (
                <p className="flex items-start gap-1.5 rounded-xl border border-status-critical/30 bg-status-critical/5 px-3 py-2 text-sm text-status-critical" role="alert">
                  <ShieldAlert className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" /> {connectError}
                </p>
              )}

              <form
                className="grid grid-cols-1 lg:grid-cols-2 gap-3"
                onSubmit={(e) => { e.preventDefault(); requestConnect('inline'); }}
              >
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
                      호스트 직접 입력 <span className="text-xs text-muted-foreground">(비우면 선택한 노드)</span>
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

                  <div className="space-y-4">
                    <div>
                      <label htmlFor={`${f}-user`} className="block text-sm text-muted-foreground mb-1">사용자</label>
                      <input
                        id={`${f}-user`}
                        type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                        autoComplete="username"
                        className={inputCls}
                      />
                      {guarded && username.trim() === 'root' && (
                        <p className="mt-1 text-xs text-status-warning">root 로 접속합니다 — 전용 운영 계정을 권장합니다.</p>
                      )}
                    </div>
                    {/* 고급 — 포트·네임스페이스는 드물게 바꾸므로 접어 둔다. 기본값이 아니거나 포트가 잘못되면 펼쳐 둔다. */}
                    <details
                      open={advancedOpen}
                      onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
                      className="text-sm"
                    >
                      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
                        고급 — 포트 {portText || '-'}{namespace.trim() ? ` · 네임스페이스 ${namespace.trim()}` : ''}
                      </summary>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <div>
                          <label htmlFor={`${f}-port`} className="block text-sm text-muted-foreground mb-1">포트</label>
                          <input
                            id={`${f}-port`}
                            type="number" min={1} max={65535} value={portText} onChange={(e) => {
                              setPortText(e.target.value);
                              const n = Number(e.target.value);
                              if (!(Number.isInteger(n) && n >= 1 && n <= 65535)) setAdvancedOpen(true);
                            }}
                            aria-invalid={!portValid}
                            aria-describedby={!portValid ? `${f}-port-err` : undefined}
                            className={inputCls}
                          />
                          {!portValid && <p id={`${f}-port-err`} className="mt-1 text-xs text-status-critical" role="alert">포트는 1–65535 사이여야 합니다.</p>}
                        </div>
                        <div>
                          <label htmlFor={`${f}-ns`} className="block text-sm text-muted-foreground mb-1">
                            네임스페이스 <span className="text-xs">(선택)</span>
                          </label>
                          <input
                            id={`${f}-ns`}
                            type="text" value={namespace} onChange={(e) => setNamespace(e.target.value)}
                            placeholder="예: kube-system"
                            className={inputCls}
                          />
                        </div>
                      </div>
                    </details>
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
                          className={`flex-1 px-2 py-1.5 text-sm font-medium rounded-xl transition-colors ${
                            authMode === m ? 'bg-background text-foreground ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'
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
                        ref={passwordRef}
                        autoComplete="current-password"
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
                        ref={keyRef}
                        value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
                        placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" rows={4}
                        className="w-full px-3 py-2 text-xs font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                      />
                    </div>
                  )}

                  {/* 안전 행 — 읽기 전용 여부를 상태 문구로 크게 보여준다. 꺼짐(수정·삭제 가능)일 때만 경고색. */}
                  <div
                    className={`flex items-start gap-2 rounded-xl border px-3 py-2 ${
                      readonly ? 'border-border bg-secondary/40' : 'border-status-warning/40 bg-status-warning/5'
                    }`}
                  >
                    <input
                      id={`${f}-ro`}
                      type="checkbox" checked={readonly} onChange={(e) => onReadonlyChange(e.target.checked)}
                      className="mt-0.5 w-4 h-4 accent-primary"
                    />
                    <label htmlFor={`${f}-ro`} className="text-sm cursor-pointer">
                      <span className="font-medium text-foreground">
                        읽기 전용: {readonly ? '켜짐' : '꺼짐'} (<code className="font-mono">--readonly</code>)
                        {guarded && <span className="text-xs font-normal text-muted-foreground"> · 보호 레벨 기본</span>}
                      </span>
                      <span className={`block text-xs ${readonly ? 'text-muted-foreground' : 'text-status-warning'}`}>
                        {readonly ? '조회만 가능' : '수정·삭제·스케일·셸 진입 가능'}
                      </span>
                    </label>
                  </div>

                  <div className="flex gap-2">
                    <button
                      type="submit"
                      disabled={!canConnect || !canOperate || connectBusy}
                      title={withHint('이 화면 위의 창으로 k9s 연결')}
                      aria-describedby={!canConnect ? `${f}-need` : undefined}
                      aria-label={ariaWithHint('연결')}
                      className="flex-1 px-3 py-2 text-sm font-medium rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      <Play className="w-4 h-4" aria-hidden="true" /> 연결
                    </button>
                    <button
                      type="button"
                      onClick={() => requestConnect('popout')}
                      disabled={!canConnect || !canOperate || connectBusy}
                      title={withHint('별도 브라우저 창으로 열기 — 메인 화면에서 다른 페이지로 이동하며 함께 사용')}
                      aria-label={ariaWithHint('별도 창으로 연결')}
                      className="px-3 py-2 text-sm text-muted-foreground rounded-xl border border-border hover:bg-secondary hover:text-foreground disabled:opacity-50 flex items-center justify-center gap-1.5"
                    >
                      <ExternalLink className="w-4 h-4" aria-hidden="true" /> 별도 창으로 연결
                    </button>
                  </div>
                  {!canOperate ? (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <ShieldAlert className="w-3 h-3" aria-hidden="true" /> {hint}
                    </p>
                  ) : !canConnect && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1" id={`${f}-need`}>
                      <ShieldAlert className="w-3 h-3" aria-hidden="true" /> {portValid ? `호스트와 ${authMode === 'password' ? '비밀번호' : '개인키'}를 입력하세요.` : '포트를 확인하세요.'}
                    </p>
                  )}
                  {popoutNotice}
                </MacCard>
              </form>
            </>
          )}
        </div>
      </PageShell>

      <ConfirmDialog
        open={pendingConnect !== null}
        title="보호 레벨 클러스터에 접속"
        description={levelUnknown
          ? '운영레벨 미지정 — 보호 레벨로 취급합니다.'
          : '보호 레벨 클러스터입니다.'}
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
            {readonly ? '켜짐 (--readonly)' : '꺼짐 — 수정·삭제 가능'}
          </dd>
        </dl>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmReadonlyOff}
        danger
        title="읽기 전용 해제"
        description={`보호 레벨(${levelText}) 클러스터에서 수정·삭제·셸 진입이 가능해집니다.`}
        confirmLabel="읽기 전용 끄기"
        onCancel={() => setConfirmReadonlyOff(false)}
        onConfirm={() => { setConfirmReadonlyOff(false); setReadonly(false); }}
      />

      <ConfirmDialog
        open={pendingCluster !== null}
        danger
        title="클러스터 전환"
        description={session
          ? `SSH 세션(${session.username}@${session.host}:${session.port})과 실행 중인 k9s 가 종료됩니다.`
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
