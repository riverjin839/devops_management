import { useEffect, useId, useMemo, useState } from 'react';
import {
  HardDrive, Plus, Pencil, ServerCog, AlertTriangle, Settings2, Inbox, Play, Square, ListChecks, Terminal,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { StatusBadge, StatusDot, statusToVariant, EmptyState, ErrorState, LoadingState, LogViewer, PageShell, RunLogPanel } from '@/components/common';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import { PageHeader } from '@/components/common/PageHeader';
import { IsilonServerModal, IsilonCommandManager, ISILON_SECTION_LABEL } from '@/components/isilon';
import { useIsilonServers, useIsilonCommands } from '@/hooks/useIsilonNfs';
import { useClusters } from '@/hooks/useCluster';
import { useTerminalEnvSync } from '@/hooks/useTerminalEnvSync';
import { isilonNfsApi } from '@/services/api';
import { formatApiError } from '@/lib/utils';
import type {
  IsilonServer, IsilonCommand, IsilonCommandResult, IsilonRunResponse, IsilonK8sNfsPv,
} from '@/types';

function isAbortError(e: unknown): boolean {
  const x = e as { name?: string; code?: string } | null;
  return x?.name === 'CanceledError' || x?.code === 'ERR_CANCELED' || x?.name === 'AbortError';
}

/**
 * 실행 API 가 AbortSignal 을 받지 않으므로 "중지"는 결과 대기만 끊는다(서버의 읽기전용 isi 명령은 끝까지 돈다).
 * 중지 후 도착한 응답은 버려 화면 상태를 바꾸지 않는다.
 */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('사용자 중지', 'AbortError'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    void p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** 글로벌 기본 + 서버 오버라이드를 key 기준으로 병합(서버 전용 우선), enabled 만, sortOrder 순 — 백엔드 `effective_commands` 와 동일한 규칙. */
function mergeEffective(commands: IsilonCommand[]): IsilonCommand[] {
  const byKey = new Map<string, IsilonCommand>();
  for (const c of commands) {
    const existing = byKey.get(c.key);
    if (!existing || (existing.serverId == null && c.serverId != null)) byKey.set(c.key, c);
  }
  return [...byKey.values()]
    .filter((c) => c.enabled)
    .sort((a, b) => (a.sortOrder - b.sortOrder) || a.key.localeCompare(b.key));
}

export function IsilonNfsPage() {
  const {
    data: servers = [], isLoading: loadingServers, isError: serversError, error: serversErr, refetch: refetchServers,
  } = useIsilonServers();
  const { canOperate, withHint, ariaWithHint } = useCanOperate();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [serverModal, setServerModal] = useState<{ open: boolean; edit?: IsilonServer | null }>({ open: false });
  const [cmdOpen, setCmdOpen] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [runResult, setRunResult] = useState<IsilonRunResponse | null>(null);
  const runLog = useRunLog();
  const { clear: clearRunLog } = runLog;
  const [showLog, setShowLog] = useLogPref('isilon-nfs-run');
  const fid = useId();

  // 서버가 tied 된 K8s 클러스터가 없는 서버 스코프 화면이라 항상 전역 기본(dev) 프로파일 —
  // 그래도 콘솔 화면 표준(§12.6 rule 4)에 맞춰 최상단에서 호출한다.
  const { data: clusters = [] } = useClusters();
  useTerminalEnvSync(clusters, null);

  const runMut = useAbortableMutation({
    mutationFn: ({ serverId, keys }: { serverId: string; keys: string[] }, signal: AbortSignal) =>
      raceAbort(isilonNfsApi.runCommands(serverId, keys).then((r) => r.data), signal),
  });
  const { abort: abortRun } = runMut;

  // 서버 목록 로드 시 기본 선택 — 선택한 서버가 목록에서 사라지면(삭제 등) 기본 서버로 다시 고른다.
  // 조회 실패 중에는 servers 가 빈 기본값이라 선택을 건드리지 않는다.
  useEffect(() => {
    if (loadingServers || serversError) return;
    if (selectedId && servers.some((s) => s.id === selectedId)) return;
    const next = servers.find((s) => s.isDefault)?.id ?? servers[0]?.id;
    if (next !== selectedId) setSelectedId(next);
  }, [servers, selectedId, loadingServers, serversError]);

  // 서버를 바꾸면 이전 서버의 선택/결과/진행 중 대기를 들고 있지 않는다.
  useEffect(() => {
    abortRun();
    setSelectedKeys(new Set());
    setRunResult(null);
    clearRunLog();
  }, [selectedId, clearRunLog, abortRun]);

  const selected = servers.find((s) => s.id === selectedId);
  const commandsQ = useIsilonCommands(selectedId, !!selectedId);
  const effective = useMemo(() => mergeEffective(commandsQ.data ?? []), [commandsQ.data]);

  const toggleKey = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const canRun = canOperate && !!selectedId && selectedKeys.size > 0 && !runMut.isPending;

  // 등록된 읽기전용 isi 명령(allowlist)만 고르므로 확인 모달 없이 바로 실행한다(§12.6.1 동작 규칙 1).
  const handleRun = async () => {
    if (!canRun || !selectedId) return;
    const keys = [...selectedKeys];
    const target = selected ? `${selected.name} (${selected.username}@${selected.host}:${selected.port})` : selectedId;
    const r = await runLogged(runLog, {
      title: 'Isilon 명령 실행',
      first: `${target} — 명령 ${keys.length}개 실행 요청: ${keys.join(', ')}`,
      fn: () => runMut.mutateAsync({ serverId: selectedId, keys }),
      summarize: isilonRunLines,
    });
    if (r.ok) setRunResult(r.data);
  };

  // 오류 표시는 실행 로그 error 줄 + 실행 바 위 alert 한 곳(§12.6.1 동작 규칙 4).
  const runErr = runMut.error && !isAbortError(runMut.error) ? formatApiError(runMut.error) : null;
  const alertText = runErr
    ?? (runResult && runResult.connectionOk === false ? `SSH 접속 실패 — ${runResult.connectionError ?? '사유 미상'}` : null);

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" as="div" className="flex gap-3">
        {/* 좌측 서버 레일 — 클러스터가 아닌 서버 스코프라 ClusterSidebar 대신 전용 레일 사용 */}
        <div className="sticky top-4 self-start w-56 flex-shrink-0">
          <MacCard title="Isilon 서버" bodyPadding="p-2">
            <div className="space-y-1">
              {loadingServers ? (
                <LoadingState compact />
              ) : serversError ? (
                <ErrorState compact error={serversErr} title="서버 목록 조회 실패" onRetry={() => { void refetchServers(); }} />
              ) : servers.length === 0 ? (
                <EmptyState compact icon={ServerCog} title="등록된 서버가 없습니다." description="아래 서버 추가로 등록하세요." />
              ) : servers.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  aria-pressed={selectedId === s.id}
                  className={`w-full text-left rounded-xl px-2.5 py-2 border transition ${selectedId === s.id ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-muted'}`}
                >
                  <div className="flex items-center gap-1.5">
                    <StatusDot variant={statusToVariant(s.status)} />
                    <span className="text-sm font-medium truncate">{s.name}</span>
                    {s.isDefault && <span className="ml-auto text-xs px-1 rounded bg-muted text-muted-foreground">기본</span>}
                  </div>
                  <span className="block text-xs text-muted-foreground truncate mt-0.5">{s.host}</span>
                </button>
              ))}
            </div>
            <div className="border-t border-border mt-2 pt-2">
              <button onClick={() => setServerModal({ open: true, edit: null })}
                disabled={!canOperate}
                title={withHint('서버 추가')} aria-label={ariaWithHint('서버 추가')}
                className="w-full inline-flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-xl border border-border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed">
                <Plus className="w-3.5 h-3.5" aria-hidden="true" /> 서버 추가
              </button>
            </div>
          </MacCard>
        </div>

        {/* 본문 */}
        <div className="flex-1 min-w-0">
          <PageHeader
            className="mb-3"
            icon={HardDrive}
            title="NFS 모니터링 (Isilon)"
            description="K8s 가 쓰는 NFS 를 NAS 서버 쪽에서 점검 · 읽기전용/무부하 · 선택한 명령만 실행"
          />

          {loadingServers ? (
            <LoadingState />
          ) : serversError ? (
            // 조회 실패를 "서버를 먼저 등록하세요" 로 보이면 중복 등록으로 이어진다(D-137).
            <ErrorState error={serversErr} title="Isilon 서버 목록을 불러오지 못했습니다" onRetry={() => { void refetchServers(); }} />
          ) : servers.length === 0 ? (
            <EmptyState
              icon={ServerCog}
              title="Isilon 서버를 먼저 등록하세요"
              description={canOperate
                ? 'SSH 접속 대상(host/계정/비밀번호)을 등록하면 isi 명령으로 NFS 현황을 수집합니다.'
                : 'SSH 접속 대상 등록은 operator 이상 권한이 필요합니다. 관리자에게 등록을 요청하세요.'}
              action={canOperate ? { label: '서버 추가', onClick: () => setServerModal({ open: true, edit: null }) } : undefined}
            />
          ) : selected ? (
            <>
              {/* 대상 요약 한 줄 — 서버 이름·접속 계정·편집 + 접속 상태(§12.6.1 "요약 한 줄") */}
              <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <h2 className="font-semibold">{selected.name}</h2>
                <button onClick={() => setServerModal({ open: true, edit: selected })}
                  disabled={!canOperate}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                  title={withHint('서버 편집')} aria-label={ariaWithHint('서버 편집')}>
                  <Pencil className="w-3.5 h-3.5" aria-hidden />
                </button>
                <span className="text-xs font-mono text-muted-foreground">{selected.username}@{selected.host}:{selected.port}</span>
                <div className="ml-auto flex items-center gap-3">
                  {runResult?.executedAt && (
                    <span className="text-xs text-muted-foreground">
                      마지막 실행 {new Date(runResult.executedAt).toLocaleTimeString()}
                    </span>
                  )}
                  <ConnBadge runResult={runResult} running={runMut.isPending} />
                </div>
              </div>

              {/* 로그 중심 콘솔(§12.6.1) — 좌: 명령 선택 + 하단 고정 실행 바, 우: 실행 로그(3) + 결과(2). */}
              <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-3 lg:h-[calc(100vh-var(--topbar-h)-10rem)] lg:min-h-[480px]">
                <MacCard
                  title="명령 선택"
                  titleExtra={selectedKeys.size > 0 ? <span className="text-xs text-muted-foreground tabular-nums">{selectedKeys.size}개 선택</span> : undefined}
                  rootClassName="min-w-0 flex flex-col lg:min-h-0"
                  bodyPadding="p-0"
                  className="flex flex-col flex-1 min-h-0"
                  actions={
                    <button
                      type="button"
                      onClick={() => setCmdOpen(true)}
                      // viewer 도 명령 정의는 볼 수 있게 연다 — 안의 추가·저장·삭제가 비활성+사유(§12.9).
                      title={canOperate ? 'isi 명령 등록·수정·비활성' : 'isi 명령 보기 (등록·수정은 operator 이상)'}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-xl border border-border hover:bg-muted"
                    >
                      <Settings2 className="w-3.5 h-3.5" aria-hidden /> 명령 관리
                    </button>
                  }
                >
                  <div
                    className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3"
                    onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void handleRun(); } }}
                  >
                    <p id={`${fid}-hint`} className="text-xs text-muted-foreground">
                      등록된 읽기전용 isi 명령 중 선택합니다(복수 선택 가능). 확인 없이 바로 실행됩니다.
                    </p>
                    {commandsQ.isLoading ? (
                      <LoadingState compact />
                    ) : commandsQ.isError ? (
                      <ErrorState compact error={commandsQ.error} title="명령 목록을 불러오지 못했습니다" onRetry={() => { void commandsQ.refetch(); }} />
                    ) : effective.length === 0 ? (
                      <EmptyState
                        compact
                        icon={ListChecks}
                        title="활성화된 명령이 없습니다"
                        description="명령 관리에서 isi 명령을 등록하거나 활성화하면 여기서 골라 실행할 수 있습니다."
                      />
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <button type="button" onClick={() => setSelectedKeys(new Set(effective.map((c) => c.key)))}
                            className="text-xs px-2 py-1 rounded-xl border border-border hover:bg-muted">
                            전체 선택
                          </button>
                          <button type="button" onClick={() => setSelectedKeys(new Set())} disabled={selectedKeys.size === 0}
                            className="text-xs px-2 py-1 rounded-xl border border-border hover:bg-muted disabled:opacity-50">
                            선택 해제
                          </button>
                        </div>
                        <ul aria-describedby={`${fid}-hint`} className="space-y-1.5">
                          {effective.map((c) => (
                            <li key={c.key}>
                              <label aria-label={c.label} className="flex items-start gap-2 rounded-xl border border-border px-2.5 py-2 hover:bg-muted transition cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={selectedKeys.has(c.key)}
                                  onChange={() => toggleKey(c.key)}
                                  className="mt-0.5 accent-primary"
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-sm font-medium truncate">{c.label}</span>
                                    <span className="ml-auto shrink-0 text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                      {ISILON_SECTION_LABEL[c.section] ?? c.section}
                                    </span>
                                  </div>
                                  <code className="block text-xs text-muted-foreground truncate mt-0.5" title={c.command}>{c.command}</code>
                                </div>
                              </label>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>

                  {/* 실행 바 — 스크롤과 무관하게 항상 보인다. 실행 중에는 중지로 바뀐다. */}
                  <div className="border-t border-border p-3 space-y-2">
                    {alertText && (
                      <div role="alert" className="px-3 py-2 text-sm rounded-md bg-status-critical/10 text-status-critical border border-status-critical/30 break-words">
                        {alertText}
                      </div>
                    )}
                    {runMut.isPending ? (
                      <button
                        type="button"
                        onClick={abortRun}
                        title="결과 대기를 멈춥니다 (서버의 읽기전용 명령은 끝까지 수행됩니다)"
                        className="w-full flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold bg-secondary hover:bg-secondary/80 text-foreground border border-border rounded-xl transition-colors"
                      >
                        <Square className="w-4 h-4 fill-current" aria-hidden="true" />
                        중지
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { void handleRun(); }}
                        disabled={!canRun}
                        title={withHint('선택한 명령 실행')}
                        aria-label={ariaWithHint(`선택 실행 (${selectedKeys.size})`)}
                        className="w-full flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Play className="w-4 h-4" aria-hidden="true" />
                        선택 실행 ({selectedKeys.size})
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
                    {/* 요청·대기·명령별 결과 요약·실패 사유 — 명령 출력 본문은 아래 결과 카드 */}
                    <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} fill />
                  </div>
                  <div className="flex flex-col min-h-[200px] lg:min-h-0 flex-[2]">
                    <RunResultPanel runResult={runResult} running={runMut.isPending} />
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </PageShell>

      {serverModal.open && (
        <IsilonServerModal server={serverModal.edit} onClose={() => setServerModal({ open: false })} />
      )}
      {cmdOpen && (
        <IsilonCommandManager serverId={selectedId} onClose={() => setCmdOpen(false)} />
      )}
    </div>
  );
}

// ── 하위 렌더 조각 (module-local, 비-export) ──────────────────────────────────
// 실행 로그 요약 — 접속 결과 · 명령별 "섹션 · 라벨 · exit · ms · 오류" · 건너뜀 · 합계.
function isilonRunLines(res: IsilonRunResponse): RunLogEntry[] {
  const out: RunLogEntry[] = [];
  if (res.connectionOk === false) out.push(['error', `SSH 접속 실패 — ${res.connectionError ?? '사유 미상'}`]);
  else if (res.connectionOk) out.push(['info', 'SSH 접속 성공']);
  const results = res.results ?? [];
  for (const r of results) {
    const parts = [`${ISILON_SECTION_LABEL[r.section] ?? r.section} · ${r.label}`, `exit ${r.exitCode ?? '—'}`, `${r.durationMs}ms`];
    if (!r.ok) {
      const firstErr = (r.error ?? '').trim() || (r.raw ?? '').split('\n').map((l) => l.trim()).find(Boolean) || '';
      if (firstErr) parts.push(`오류 — ${firstErr.slice(0, 200)}`);
    }
    out.push([r.ok ? 'info' : 'error', parts.join(' · ')]);
  }
  if (res.skippedKeys && res.skippedKeys.length > 0) out.push(['warn', `등록/활성화되지 않아 건너뜀: ${res.skippedKeys.join(', ')}`]);
  if (res.k8sNfsPvsError) out.push(['warn', res.k8sNfsPvsError]);
  else if (res.k8sNfsPvs) out.push(['info', `K8s NFS PV ${res.k8sNfsPvs.length}개 조회`]);
  const failed = results.filter((r) => !r.ok).length;
  out.push([failed ? 'warn' : 'info', `명령 ${results.length} · 성공 ${results.length - failed} · 실패 ${failed}`]);
  return out;
}

function ConnBadge({ runResult, running }: { runResult: IsilonRunResponse | null; running: boolean }) {
  if (running) return <StatusBadge variant="loading" label="실행 중" />;
  if (!runResult) return <StatusBadge variant="neutral" label="미실행" />;
  // 접속 실패는 "아직 안 붙어 봄"(pending 회색)이 아니라 오류다(D-147).
  return runResult.connectionOk
    ? <StatusBadge variant="healthy" label="접속됨" />
    : <StatusBadge variant="critical" label="접속 실패" />;
}

function extractExportPaths(results?: IsilonCommandResult[]): string[] {
  const r = (results ?? []).find((x) => x.section === 'exports' && x.parsed != null);
  if (!r) return [];
  const parsed = r.parsed as Record<string, unknown> | unknown[];
  const items: unknown[] = Array.isArray(parsed)
    ? parsed
    : (Array.isArray((parsed as Record<string, unknown>).exports)
      ? (parsed as Record<string, unknown>).exports as unknown[]
      : []);
  const out: string[] = [];
  for (const it of items) {
    if (typeof it !== 'object' || it === null) continue;
    const obj = it as Record<string, unknown>;
    const paths = Array.isArray(obj.paths) ? obj.paths : (obj.path ? [obj.path] : []);
    for (const p of paths) if (typeof p === 'string') out.push(p);
  }
  return out;
}

function pathServed(pvPath: string, exportPaths: string[]): boolean {
  const p = pvPath.replace(/\/+$/, '');
  return exportPaths.some((ep) => {
    const e = ep.replace(/\/+$/, '');
    return !!e && (p === e || p.startsWith(e + '/') || e.startsWith(p + '/'));
  });
}

function K8sNfsTable({ runResult }: { runResult: IsilonRunResponse }) {
  const pvs: IsilonK8sNfsPv[] = runResult.k8sNfsPvs ?? [];
  const exportPaths = useMemo(() => extractExportPaths(runResult.results), [runResult]);
  // 빈 상태 분기(D-147) — K8s 조회 실패 / NFS PV 없음 을 한 문장에 섞지 않는다(미실행은 결과 카드 플레이스홀더).
  // 조회 실패는 실행 로그 warn 줄에도 남으므로 여기선 alert 를 또 걸지 않는다(오류 표시 한 곳).
  if (runResult.k8sNfsPvsError) {
    return (
      <div className="flex items-start gap-2 text-sm text-status-critical">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-medium">K8s PV 조회 실패 — PV ↔ export 매칭을 할 수 없습니다</p>
          <p className="text-xs mt-0.5 break-words">{runResult.k8sNfsPvsError}</p>
        </div>
      </div>
    );
  }
  if (pvs.length === 0) {
    return (
      <EmptyState
        compact
        icon={Inbox}
        title="NFS PV 가 없습니다"
        description="관리 클러스터에 NFS 백엔드(spec.nfs)를 쓰는 PersistentVolume 이 없습니다."
      />
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted-foreground border-b border-border">
            <th className="text-left font-medium py-1.5 pr-3">PV</th>
            <th className="text-left font-medium py-1.5 pr-3">PVC</th>
            <th className="text-left font-medium py-1.5 pr-3">NFS 경로</th>
            <th className="text-left font-medium py-1.5 pr-3">서버</th>
            <th className="text-left font-medium py-1.5 pr-3">Isilon export</th>
          </tr>
        </thead>
        <tbody>
          {pvs.map((pv) => {
            const served = exportPaths.length > 0 ? pathServed(pv.path, exportPaths) : null;
            return (
              <tr key={pv.pv} className="border-b border-border/50">
                <td className="py-1.5 pr-3 font-mono text-xs truncate max-w-[200px]">{pv.pv}</td>
                <td className="py-1.5 pr-3 text-xs">{pv.pvc ?? '—'}</td>
                <td className="py-1.5 pr-3 font-mono text-xs">{pv.path}</td>
                <td className="py-1.5 pr-3 text-xs">{pv.server ?? '—'}</td>
                <td className="py-1.5 pr-3">
                  {served === null
                    ? <StatusBadge variant="neutral" label="exports 미실행" />
                    : served
                      ? <StatusBadge variant="healthy" label="매칭됨" />
                      : <StatusBadge variant="critical" label="누락" />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// 결과는 실행 전에도 같은 자리(우 하단)에 플레이스홀더로 존재 — §12.6.1.
// 스크롤은 카드 본문 한 겹뿐 — 안쪽 LogViewer 에 max-h 를 또 걸지 않는다. 로그 출력은 항상 LogViewer(plain <pre> 금지).
function RunResultPanel({ runResult, running }: { runResult: IsilonRunResponse | null; running: boolean }) {
  if (!runResult && !running) {
    return (
      <div className="min-w-0 flex-1 flex items-center justify-center min-h-[120px] rounded-md border border-border">
        <EmptyState
          compact
          icon={Terminal}
          title="아직 실행 결과가 없습니다."
          description="왼쪽에서 isi 명령을 선택하고 실행하면 명령 출력과 K8s PV ↔ export 매칭이 여기에 표시됩니다."
        />
      </div>
    );
  }
  const results = runResult?.results ?? [];
  return (
    <MacCard
      title="실행 결과"
      titleExtra={results.length > 0 ? <span className="text-xs text-muted-foreground tabular-nums">{results.length}건</span> : undefined}
      rootClassName="min-w-0 flex flex-col flex-1 min-h-0"
      bodyPadding="p-0"
      className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
    >
      {!runResult ? (
        <LoadingState label="실행 중…" />
      ) : (
        <div className="divide-y divide-border">
          <section className="p-4 space-y-2" aria-label="K8s 가 사용하는 NFS">
            <p className="text-xs font-medium text-muted-foreground">K8s 가 사용하는 NFS (PV ↔ Isilon export)</p>
            <K8sNfsTable runResult={runResult} />
          </section>
          {results.length === 0 ? (
            <div className="p-4">
              <EmptyState compact title="실행된 명령 결과가 없습니다." description="선택한 명령이 결과를 반환하지 않았습니다. 명령 선택을 확인하고 다시 실행하세요." />
            </div>
          ) : results.map((r) => <ResultBlock key={r.key} result={r} />)}
        </div>
      )}
    </MacCard>
  );
}

function ResultBlock({ result }: { result: IsilonCommandResult }) {
  const content = result.parsed != null
    ? JSON.stringify(result.parsed, null, 2)
    : (result.raw ?? '');
  return (
    <div className="p-4 space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <StatusBadge
          variant={result.ok ? 'healthy' : 'critical'}
          label={result.ok ? `exit ${result.exitCode ?? 0}` : (result.error ?? `exit ${result.exitCode ?? '—'}`)}
        />
        <span className="font-medium text-foreground">{ISILON_SECTION_LABEL[result.section] ?? result.section} · {result.label}</span>
        <code className="text-muted-foreground truncate">{result.command}</code>
        <span className="ml-auto text-muted-foreground shrink-0">{result.durationMs}ms</span>
      </div>
      {content
        ? <LogViewer text={content} maxHeight="max-h-none" asError={!result.ok} />
        : <p className="text-xs text-muted-foreground">출력 없음</p>}
    </div>
  );
}
