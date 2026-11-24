import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation } from '@tanstack/react-query';
import {
  ChevronLeft, ChevronRight, Key, Loader2, Play, Plug, Radio, ShieldAlert, SlidersHorizontal, TerminalSquare,
} from 'lucide-react';
import { useClusterRouteParam } from '@/hooks/useClusterRouteParam';
import { useClusters } from '@/hooks/useCluster';
import {
  ClusterSidebar, ConfirmDialog, EmptyState, ErrorState, PageShell, RunLogPanel, SegTabs, useToast,
} from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import {
  NodeSshTerminal, type NodeSshConnectParams, type SshTerminalControl, type SshTerminalEvent, type SshTerminalStatus,
} from '@/components/k8s';
import {
  CELL_CLASS, MAX_SESSIONS, NodeMultiSelect, SshFavoritesChips, SshFavoritesDialog, SshFavoritesMenu,
  favoriteIsDanger, firstFreeSlot, pageCount, quadrantOfCell, slotForCell, slotPosition, type FavoritePick, type SshTarget,
} from '@/components/node-ssh';
import { useK8sHub } from '@/lib/k8sHub';
import { openNodeSshPopout } from '@/lib/nodeSshPopout';
import { judgeCommand } from '@/lib/dangerCommand';
import { formatApiError } from '@/lib/utils';
import { useTerminalEnvSync } from '@/hooks/useTerminalEnvSync';
import { CLUSTER_OPERATE_REQUIRED_HINT, useCanOperate, useMyClusterAccess } from '@/hooks/useCanOperate';
import { isGuardedLevel, levelLabel, useOperationLevels } from '@/hooks/useOperationLevels';
import { useRunLog, type RunLogHandle } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { useSshFavorites } from '@/hooks/useSshFavorites';
import { nodeSshApi } from '@/services/api';
import type { SshFavorite } from '@/types';

interface SshSession {
  id: string;
  slot: number;
  target: SshTarget;
  params: NodeSshConnectParams;
}

interface PendingFavorite {
  fav: SshFavorite;
  data: string;
  sessionIds: string[];
}

const INPUT = 'px-2.5 py-1.5 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary';
let sessionSeq = 0;

function targetLabel(t: SshTarget): string {
  return t.nodeName ?? t.host;
}

/**
 * SSH — 노드(여러 클러스터 포함) 여러 대에 **로그인 셸**을 화면 안 분할 칸으로 연다(최대 4분할, 넘치면 쪽 넘김).
 *
 * - 대상은 허브 2행 「SSH」 탭 옆 리스트박스(`NodeMultiSelect`, 허브 `toolbarSlot` 포털)에서 고른다. 다른 K8S 클러스터 노드도 된다.
 * - 세션은 Ⅰ → Ⅳ → Ⅱ → Ⅲ 사분면 순으로 칸에 들어가고, 5번째부터 다음 쪽(`components/node-ssh/quadrants.ts`).
 *   다른 쪽 세션도 연결은 유지된다(마운트한 채 숨김). 허브에서 클러스터를 바꿔도 다시 마운트하지 않는다(`keepAcrossClusters`).
 * - 터미널 창 ★ 메뉴·칩 바 = 서버에 저장되는 즐겨찾기 명령(`/ssh-favorites`, 기본 = 옛 커널 파라미터 프리셋).
 * - 연결·재연결·즐겨찾기 보내기는 실행 로그(`RunLogPanel`, 「로그 보기」 토글)에 노드별로 쌓인다.
 * SSH 인증정보는 저장하지 않는다(세션 메모리에만 — 재연결용). 보호 레벨 클러스터는 연결 전에 대상·계정을 확인한다.
 */
export function NodeSshPage() {
  const clustersQ = useClusters();
  const clusters = useMemo(() => clustersQ.data ?? [], [clustersQ.data]);
  const hub = useK8sHub();
  const { clusterId, selectCluster } = useClusterRouteParam('/node-ssh', clusters);
  const fid = useId();
  const toast = useToast();
  const { canOperate: roleOk, hint: roleHint, withHint, ariaWithHint, role } = useCanOperate(null);
  const access = useMyClusterAccess(role !== 'admin');
  const { data: levels } = useOperationLevels();
  const favoritesQ = useSshFavorites();
  const favorites = useMemo(() => favoritesQ.data ?? [], [favoritesQ.data]);

  useTerminalEnvSync(clusters, clusterId || null);

  // ── 접속 정보(새 연결 전부에 같이 쓴다 — 저장하지 않음) ──
  const [selected, setSelected] = useState<SshTarget[]>([]);
  const [username, setUsername] = useState('root');
  const [port, setPort] = useState(22);
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [initialCommand, setInitialCommand] = useState('');
  const [optionsOpen, setOptionsOpen] = useState(false);

  // ── 세션·배치 ──
  const [sessions, setSessions] = useState<SshSession[]>([]);
  const [statuses, setStatuses] = useState<Record<string, SshTerminalStatus>>({});
  const [page, setPage] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const [broadcast, setBroadcast] = useState(false);
  const [favDialogOpen, setFavDialogOpen] = useState(false);
  const [pendingConnect, setPendingConnect] = useState<SshTarget[] | null>(null);
  const [pendingFav, setPendingFav] = useState<PendingFavorite | null>(null);

  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('node-ssh-connect');
  const handles = useRef(new Map<string, RunLogHandle>());
  const controls = useRef(new Map<string, { current: SshTerminalControl | null }>());
  const controlRef = (id: string) => {
    let r = controls.current.get(id);
    if (!r) { r = { current: null }; controls.current.set(id, r); }
    return r;
  };

  const blockedReason = useCallback((cid: string): string | undefined => {
    if (!roleOk) return roleHint;
    const level = access.data?.[cid];
    return level !== undefined && level !== 'operate' ? CLUSTER_OPERATE_REQUIRED_HINT : undefined;
  }, [roleOk, roleHint, access.data]);

  const used = useMemo(() => new Set(sessions.map((s) => s.slot)), [sessions]);
  const pages = pageCount(used);
  useEffect(() => { if (page > pages - 1) setPage(pages - 1); }, [page, pages]);

  const slotLabel = useCallback((slot: number) => {
    const p = slotPosition(slot);
    return pages > 1 ? `${p.page + 1}쪽 ${p.quadrant}` : p.quadrant;
  }, [pages]);
  const openLabels = useMemo(() => new Map(sessions.map((s) => [s.target.key, slotLabel(s.slot)])), [sessions, slotLabel]);
  const newTargets = useMemo(
    () => selected.filter((t) => !sessions.some((s) => s.target.key === t.key)),
    [selected, sessions],
  );
  const credsOk = !!username.trim() && (authMode === 'password' ? !!password : !!privateKey.trim());
  const blockedNew = newTargets.find((t) => t.clusterId && blockedReason(t.clusterId));
  const capacity = MAX_SESSIONS - sessions.length;
  const connectHint = !roleOk ? roleHint
    : newTargets.length === 0 ? (selected.length ? '고른 노드는 이미 열려 있습니다' : '대상 노드를 고르세요')
    : !credsOk ? `${authMode === 'password' ? '비밀번호' : '개인키'}를 입력하세요`
    : blockedNew ? `${targetLabel(blockedNew)} — ${CLUSTER_OPERATE_REQUIRED_HINT}`
    : capacity <= 0 ? `세션은 ${MAX_SESSIONS}개까지 열 수 있습니다`
    : undefined;
  const canConnect = !connectHint;

  const clusterOf = (t: SshTarget) => clusters.find((c) => c.id === t.clusterId);
  const guardedOf = (t: SshTarget) => isGuardedLevel(levels, clusterOf(t)?.operationLevel);

  // ── 연결 ──
  const doConnect = (targets: SshTarget[]) => {
    const taken = new Set(used);
    const created: SshSession[] = [];
    for (const t of targets) {
      const slot = firstFreeSlot(taken);
      if (slot < 0) {
        runLog.log('warn', `세션 상한(${MAX_SESSIONS}개)이라 ${targetLabel(t)} 은(는) 열지 않았습니다`);
        break;
      }
      taken.add(slot);
      sessionSeq += 1;
      const id = `ssh-${Date.now()}-${sessionSeq}`;
      const params: NodeSshConnectParams = {
        nodeName: t.nodeName, host: t.host, port, username: username.trim(), authMode, password, privateKey,
        initialCommand: initialCommand.trim() || undefined, clusterId: t.clusterId ?? undefined,
      };
      handles.current.set(id, runLog.begin(
        `${targetLabel(t)} 연결`,
        `${params.username}@${t.host}:${port} · ${t.clusterName} · ${authMode === 'password' ? '비밀번호' : '개인키'} 인증 · 칸 ${slotPosition(slot).quadrant}`,
      ));
      created.push({ id, slot, target: t, params });
    }
    if (created.length === 0) return;
    setSessions((prev) => [...prev, ...created]);
    setPage(slotPosition(created[0].slot).page);
    setActiveId(created[0].id);
    setMaximizedId(null);
  };
  const requestConnect = () => {
    if (!canConnect) return;
    const targets = newTargets.slice(0, Math.max(0, capacity));
    if (targets.some(guardedOf)) setPendingConnect(targets);
    else doConnect(targets);
  };

  const onEvent = (s: SshSession) => (e: SshTerminalEvent) => {
    if (e.reconnect) {
      handles.current.get(s.id)?.end();
      handles.current.set(s.id, runLog.begin(`${targetLabel(s.target)} 재연결`, e.message));
      return;
    }
    const h = handles.current.get(s.id);
    h?.log(e.level, e.message);
    e.steps?.forEach((st) => h?.setStep(st.name, st.label, st.status));
    if (e.end) h?.end();
  };

  const closeSession = (id: string) => {
    handles.current.get(id)?.end();
    handles.current.delete(id);
    controls.current.delete(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setStatuses((prev) => { const next = { ...prev }; delete next[id]; return next; });
    setMaximizedId((m) => (m === id ? null : m));
    setActiveId((a) => (a === id ? null : a));
  };

  const popOut = (s: SshSession) => {
    const win = openNodeSshPopout({ params: s.params }, (delivered) => {
      if (!delivered) toast.error('새 창에 접속 정보를 전달하지 못했습니다', '이 칸의 세션은 그대로 두었습니다.');
    });
    if (!win) {
      toast.error('팝업이 차단되었습니다', '브라우저에서 이 사이트의 팝업을 허용한 뒤 다시 시도하세요.');
      return;
    }
    runLog.log('info', `[${targetLabel(s.target)}] 세션을 새 창으로 옮겼습니다`);
    closeSession(s.id);
  };

  // ── 보이는 칸 ──
  const single = sessions.length === 1 || maximizedId !== null;
  const isVisible = (s: SshSession) => (
    maximizedId ? s.id === maximizedId : sessions.length === 1 ? true : slotPosition(s.slot).page === page
  );
  const visibleIds = sessions.filter(isVisible).map((s) => s.id);
  const openCount = Object.values(statuses).filter((v) => v === 'open').length;

  // ── 즐겨찾기 보내기 ──
  const deliver = (fav: SshFavorite, data: string, ids: string[]) => {
    const run = data.endsWith('\r');
    let sent = 0;
    for (const id of ids) {
      const s = sessions.find((x) => x.id === id);
      const ok = controls.current.get(id)?.current?.send(data) ?? false;
      if (s) runLog.log(ok ? 'info' : 'warn', `[${targetLabel(s.target)}] 즐겨찾기 「${fav.name}」 ${ok ? (run ? '입력 후 실행' : '입력') : '보내지 못함 — 연결돼 있지 않음'}`);
      if (ok) sent += 1;
    }
    if (ids.length === 1) controls.current.get(ids[0])?.current?.focus();
    if (sent === 0) toast.error('명령을 보내지 못했습니다', '연결된 창이 없습니다.');
  };
  const pickFavorite = (from: string) => ({ fav, insertOnly }: FavoritePick) => {
    const text = fav.command.replace(/\s+$/, '');
    const run = !insertOnly && fav.runMode === 'run';
    const data = run ? `${text}\r` : text;
    const ids = broadcast ? visibleIds.filter((id) => statuses[id] === 'open') : [from];
    if (run && favoriteIsDanger(fav)) setPendingFav({ fav, data, sessionIds: ids });
    else deliver(fav, data, ids);
  };

  // ── 연결 테스트(터미널 없이 첫 대상의 자격증명만 확인) ──
  const testTarget = newTargets[0] ?? selected[0];
  const testM = useMutation({
    mutationFn: () => nodeSshApi.test({
      host: testTarget?.host ?? '', port, username: username.trim(),
      password: authMode === 'password' ? password : undefined,
      privateKey: authMode === 'key' ? privateKey : undefined,
    }).then((r) => r.data),
  });
  const resetTest = testM.reset;
  useEffect(() => { resetTest(); }, [testTarget?.key, port, username, authMode, password, privateKey, resetTest]);

  // ── 툴바(허브 2행 SSH 탭 옆) ──
  const toolbar = (
    <div className="flex items-center gap-2 flex-wrap">
      <NodeMultiSelect
        clusters={clusters}
        currentClusterId={clusterId}
        selected={selected}
        onChange={setSelected}
        openLabels={openLabels}
        blockedReason={blockedReason}
      />
      <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
        사용자
        <input value={username} onChange={(e) => setUsername(e.target.value)} className={`${INPUT} w-24`} aria-label="SSH 사용자" />
      </label>
      {authMode === 'password' ? (
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          비밀번호
          <input
            type="password" value={password} autoComplete="off"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') requestConnect(); }}
            className={`${INPUT} w-32`} aria-label="SSH 비밀번호"
          />
        </label>
      ) : (
        <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
          <Key className="w-3 h-3" aria-hidden="true" /> 개인키 {privateKey.trim() ? '입력됨' : '없음'}
        </span>
      )}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOptionsOpen((v) => !v)}
          aria-expanded={optionsOpen}
          aria-haspopup="dialog"
          className={`px-2.5 py-1.5 text-sm rounded-xl border inline-flex items-center gap-1 ${optionsOpen ? 'bg-secondary border-border' : 'border-border hover:bg-secondary'}`}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" /> 인증·포트·접속 후 실행
        </button>
        {optionsOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setOptionsOpen(false)} aria-hidden />
            <div role="dialog" aria-label="접속 옵션"
              onKeyDown={(e) => { if (e.key === 'Escape') setOptionsOpen(false); }}
              className="absolute left-0 top-full mt-1 z-40 w-[360px] max-w-[calc(100vw_-_32px)] bg-popover text-popover-foreground border border-border rounded-md shadow-lg p-3 flex flex-col gap-3">
              <div>
                <p id={`${fid}-auth`} className="text-sm text-muted-foreground mb-1">인증 방식</p>
                <SegTabs<'password' | 'key'>
                  label="인증 방식" value={authMode} onChange={setAuthMode}
                  options={[['password', '비밀번호'], ['key', '개인키']]}
                />
              </div>
              {authMode === 'key' && (
                <div>
                  <label htmlFor={`${fid}-pkey`} className="block text-sm text-muted-foreground mb-1">개인키(PEM)</label>
                  <textarea id={`${fid}-pkey`} rows={4} value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    className={`${INPUT} w-full text-xs font-mono resize-none`} />
                </div>
              )}
              <div className="flex gap-2">
                <div className="w-24">
                  <label htmlFor={`${fid}-port`} className="block text-sm text-muted-foreground mb-1">포트</label>
                  <input id={`${fid}-port`} type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)} className={`${INPUT} w-full`} />
                </div>
                <div className="flex-1 min-w-0">
                  <label htmlFor={`${fid}-init`} className="block text-sm text-muted-foreground mb-1">접속 후 실행 <span className="text-xs">(선택)</span></label>
                  <input id={`${fid}-init`} value={initialCommand} onChange={(e) => setInitialCommand(e.target.value)}
                    placeholder="sudo -i · cd /var/log" className={`${INPUT} w-full font-mono`} />
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => testM.mutate()}
                  disabled={!testTarget || !credsOk || !roleOk || testM.isPending}
                  title={withHint('터미널을 열지 않고 첫 대상의 호스트·자격증명만 확인')}
                  aria-label={ariaWithHint('연결 테스트')}
                  className="px-3 py-1.5 text-sm rounded-xl border border-border hover:bg-secondary disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {testM.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Plug className="w-3.5 h-3.5" aria-hidden="true" />}
                  연결 테스트{testTarget ? ` — ${targetLabel(testTarget)}` : ''}
                </button>
                {testM.data && (
                  <span className={`text-xs ${testM.data.status === 'ok' ? 'text-muted-foreground' : 'text-status-critical'}`}>
                    {testM.data.status === 'ok' ? `연결 성공 · ${testM.data.durationMs}ms` : (testM.data.error ?? testM.data.status)}
                  </span>
                )}
                {testM.isError && <span className="text-xs text-status-critical">테스트 실패: {formatApiError(testM.error)}</span>}
              </div>
              <p className="text-xs text-muted-foreground">SSH 인증정보는 이 화면의 세션에만 쓰고 저장하지 않습니다.</p>
            </div>
          </>
        )}
      </div>
      <button
        type="button"
        onClick={requestConnect}
        disabled={!canConnect}
        title={connectHint ?? '고른 노드 중 아직 열리지 않은 노드마다 분할 칸을 엽니다'}
        aria-label={connectHint ? `연결 — ${connectHint}` : '연결'}
        className="px-3 py-1.5 text-sm font-medium rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5"
      >
        <Play className="w-3.5 h-3.5" aria-hidden="true" />
        연결{newTargets.length > 0 ? ` (${Math.min(newTargets.length, Math.max(capacity, 0))}개 새로)` : ''}
      </button>
    </div>
  );

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" as="div" className="flex gap-3">
        <div className="sticky top-3 self-start">
          <ClusterSidebar clusters={clusters} selectedId={clusterId || null} onSelect={selectCluster} iconOnly />
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-3">
          <PageHeader
            icon={TerminalSquare}
            title="SSH"
            description="노드 여러 대(다른 클러스터 포함)에 로그인 셸을 열어 화면 안에서 최대 4분할로 사용"
          />

          {hub?.toolbarSlot ? createPortal(toolbar, hub.toolbarSlot) : toolbar}

          {clustersQ.isError && (
            <ErrorState error={clustersQ.error} title="클러스터 목록을 불러오지 못했습니다" onRetry={() => { void clustersQ.refetch(); }} />
          )}

          {/* 세션 바 — 개수·동시 보내기·쪽 넘김·보기 */}
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <span className="text-muted-foreground">세션 {sessions.length}/{MAX_SESSIONS} · 연결됨 {openCount}</span>
            {broadcast && (
              <button type="button" onClick={() => setBroadcast(false)}
                title="즐겨찾기 명령을 지금 보이는 모든 창에 보냅니다 — 누르면 끕니다"
                className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border border-status-warning/40 bg-status-warning/10 text-status-warning">
                <Radio className="w-3 h-3" aria-hidden="true" /> 동시 보내기 켜짐
              </button>
            )}
            <span className="ml-auto inline-flex items-center gap-1.5">
              <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0 || single}
                title="이전 쪽" aria-label="이전 쪽" className="p-1.5 rounded-xl border border-border hover:bg-secondary disabled:opacity-40">
                <ChevronLeft className="w-4 h-4" aria-hidden="true" />
              </button>
              <span className="min-w-[3rem] text-center font-medium tabular-nums" aria-live="polite">{page + 1} / {pages}</span>
              <button type="button" onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1 || single}
                title="다음 쪽" aria-label="다음 쪽" className="p-1.5 rounded-xl border border-border hover:bg-secondary disabled:opacity-40">
                <ChevronRight className="w-4 h-4" aria-hidden="true" />
              </button>
              <SegTabs<'grid' | 'single'>
                label="보기" className="ml-1"
                value={maximizedId ? 'single' : 'grid'}
                onChange={(v) => setMaximizedId(v === 'single' ? (activeId ?? visibleIds[0] ?? null) : null)}
                options={[['grid', '4분할'], ['single', '1칸']]}
              />
            </span>
          </div>

          <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} idleHint="연결하면 노드별 연결 단계·종료 사유와 즐겨찾기 보내기가 여기 쌓입니다." />

          {/* 분할 칸 — 세션은 다른 쪽에 있어도 마운트한 채 숨긴다(연결 유지). */}
          <div className="grid grid-cols-2 grid-rows-2 gap-2 h-[calc(100vh_-_16rem)] min-h-[520px]">
            {sessions.map((s) => {
              const visible = isVisible(s);
              const pos = slotPosition(s.slot);
              const status = statuses[s.id];
              const cluster = clusterOf(s.target);
              return (
                <div
                  key={s.id}
                  className={`min-w-0 min-h-0 ${!visible ? 'hidden' : single ? 'col-span-2 row-span-2 col-start-1 row-start-1' : CELL_CLASS[pos.cell]}`}
                >
                  <NodeSshTerminal
                    params={s.params}
                    embedded
                    active={activeId === s.id}
                    onActivate={() => setActiveId(s.id)}
                    badge={(
                      <span className={`text-xs font-bold px-1.5 py-px rounded shrink-0 ${activeId === s.id ? 'bg-primary text-primary-foreground' : 'bg-zinc-700 text-zinc-200'}`}>
                        {slotLabel(s.slot)}
                      </span>
                    )}
                    contextLabel={cluster ? `${cluster.name}${guardedOf(s.target) ? ` · ${levelLabel(levels, cluster.operationLevel)}` : ''}` : s.target.clusterName}
                    controlRef={controlRef(s.id)}
                    headerActions={(
                      <SshFavoritesMenu
                        favorites={favorites}
                        loading={favoritesQ.isLoading}
                        onPick={pickFavorite(s.id)}
                        onEdit={() => setFavDialogOpen(true)}
                        broadcast={broadcast}
                        onBroadcastChange={setBroadcast}
                        disabled={status !== 'open'}
                      />
                    )}
                    toolbar={<SshFavoritesChips favorites={favorites} onPick={pickFavorite(s.id)} disabled={status !== 'open'} />}
                    onToggleMaximize={sessions.length > 1 ? () => setMaximizedId((m) => (m === s.id ? null : s.id)) : undefined}
                    maximized={maximizedId === s.id}
                    onEvent={onEvent(s)}
                    onStatusChange={(st) => setStatuses((prev) => (prev[s.id] === st ? prev : { ...prev, [s.id]: st }))}
                    onPopOut={() => popOut(s)}
                    onClose={() => closeSession(s.id)}
                  />
                </div>
              );
            })}

            {sessions.length === 0 && (
              <div className="col-span-2 row-span-2 rounded-md border border-dashed border-border flex items-center justify-center">
                <EmptyState
                  icon={TerminalSquare}
                  title="열린 SSH 세션이 없습니다"
                  description="위 「대상 노드」에서 노드를 고르고(다른 클러스터 노드도 됩니다) 비밀번호를 넣은 뒤 연결하세요. 세션은 Ⅰ → Ⅳ → Ⅱ → Ⅲ 칸 순서로 열리고, 4개가 넘으면 다음 쪽에 열립니다."
                />
              </div>
            )}

            {sessions.length > 1 && !maximizedId && [0, 1, 2, 3].map((cell) => (
              used.has(slotForCell(page, cell)) ? null : (
                <div key={`empty-${cell}`} className={`${CELL_CLASS[cell]} min-h-0 rounded-md border border-dashed border-border flex items-center justify-center`}>
                  <EmptyState compact icon={TerminalSquare} title={`${quadrantOfCell(cell)} 비어 있음`} description="다음 연결이 이 칸에 열립니다." />
                </div>
              )
            ))}
          </div>

          {!roleOk && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <ShieldAlert className="w-3 h-3" aria-hidden="true" /> {roleHint}
            </p>
          )}
        </div>
      </PageShell>

      <SshFavoritesDialog open={favDialogOpen} favorites={favorites} onClose={() => setFavDialogOpen(false)} />

      <ConfirmDialog
        open={pendingConnect !== null}
        title="보호 레벨 클러스터에 접속"
        description="보호 레벨 클러스터의 노드가 들어 있습니다. 접속 대상과 계정을 확인한 뒤 연결하세요."
        confirmLabel={`${pendingConnect?.length ?? 0}개 연결`}
        onCancel={() => setPendingConnect(null)}
        onConfirm={() => {
          const targets = pendingConnect;
          setPendingConnect(null);
          if (targets) doConnect(targets);
        }}
      >
        <ul className="text-sm flex flex-col gap-1 max-h-60 overflow-y-auto">
          {(pendingConnect ?? []).map((t) => {
            const c = clusterOf(t);
            return (
              <li key={t.key} className="font-mono break-all">
                {username}@{t.host}:{port} <span className="font-sans text-muted-foreground">
                  · {targetLabel(t)} · {c?.name ?? t.clusterName}{guardedOf(t) ? ` · ${levelLabel(levels, c?.operationLevel)}` : ''}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">로그인 셸은 계정 권한 그대로 동작합니다(읽기 전용 없음).</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingFav !== null}
        danger
        title="변경 명령 실행"
        description={pendingFav ? `「${pendingFav.fav.name}」은(는) 조회 명령이 아닙니다 — ${judgeCommand(pendingFav.fav.command, 'shell').reason ?? '노드 상태를 바꿀 수 있습니다'}. ${pendingFav.sessionIds.length}개 창에서 바로 실행합니다.` : undefined}
        confirmLabel="실행"
        onCancel={() => setPendingFav(null)}
        onConfirm={() => {
          const p = pendingFav;
          setPendingFav(null);
          if (p) deliver(p.fav, p.data, p.sessionIds);
        }}
      >
        {pendingFav && <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-secondary rounded-md p-2">{pendingFav.fav.command}</pre>}
      </ConfirmDialog>

    </div>
  );
}

