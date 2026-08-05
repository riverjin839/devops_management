import { useEffect, useMemo, useState } from 'react';
import {
  HardDrive, Plus, Pencil, Loader2, ServerCog,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { StatusBadge, StatusDot, statusToVariant, EmptyState, LogViewer } from '@/components/common';
import { IsilonServerModal, IsilonCommandManager, IsilonCommandSelector, ISILON_SECTION_LABEL } from '@/components/isilon';
import { useIsilonServers, useRunIsilonCommands } from '@/hooks/useIsilonNfs';
import { useClusters } from '@/hooks/useCluster';
import { useTerminalEnvSync } from '@/hooks/useTerminalEnvSync';
import type {
  IsilonServer, IsilonCommandResult, IsilonRunResponse, IsilonK8sNfsPv,
} from '@/types';

export function IsilonNfsPage() {
  const { data: servers = [], isLoading: loadingServers } = useIsilonServers();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [serverModal, setServerModal] = useState<{ open: boolean; edit?: IsilonServer | null }>({ open: false });
  const [cmdOpen, setCmdOpen] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [runResult, setRunResult] = useState<IsilonRunResponse | null>(null);

  // 서버가 tied 된 K8s 클러스터가 없는 서버 스코프 화면이라 항상 전역 기본(dev) 프로파일 —
  // 그래도 콘솔 화면 표준(§12.6 rule 4)에 맞춰 최상단에서 호출한다.
  const { data: clusters = [] } = useClusters();
  useTerminalEnvSync(clusters, null);

  // 서버 목록 로드 시 기본 선택
  useEffect(() => {
    if (!selectedId && servers.length > 0) {
      setSelectedId(servers.find((s) => s.isDefault)?.id ?? servers[0].id);
    }
  }, [servers, selectedId]);

  // 서버를 바꾸면 이전 서버의 선택/결과를 들고 있지 않는다.
  useEffect(() => {
    setSelectedKeys(new Set());
    setRunResult(null);
  }, [selectedId]);

  const selected = servers.find((s) => s.id === selectedId);
  const runMut = useRunIsilonCommands();

  const toggleKey = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const handleRun = () => {
    if (!selectedId || selectedKeys.size === 0) return;
    runMut.mutate(
      { serverId: selectedId, keys: [...selectedKeys] },
      { onSuccess: (data) => setRunResult(data) },
    );
  };

  return (
    <div className="min-h-screen bg-background py-3 pr-3">
      <div className="flex gap-3">
        {/* 좌측 서버 레일 — 클러스터가 아닌 서버 스코프라 ClusterSidebar 대신 전용 레일 사용 */}
        <div className="sticky top-4 self-start w-56 flex-shrink-0">
          <MacCard title="Isilon 서버" bodyPadding="p-2">
            <div className="space-y-1">
              {loadingServers ? (
                <div className="text-xs text-muted-foreground p-2"><Loader2 className="w-3.5 h-3.5 animate-spin inline" /> 로딩…</div>
              ) : servers.length === 0 ? (
                <p className="text-xs text-muted-foreground p-2">등록된 서버가 없습니다.</p>
              ) : servers.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  className={`w-full text-left rounded-xl px-2.5 py-2 border transition ${selectedId === s.id ? 'border-primary bg-primary/5' : 'border-transparent hover:bg-muted'}`}
                >
                  <div className="flex items-center gap-1.5">
                    <StatusDot variant={statusToVariant(s.status)} />
                    <span className="text-sm font-medium truncate">{s.name}</span>
                    {s.isDefault && <span className="ml-auto text-[10px] px-1 rounded bg-muted text-muted-foreground">기본</span>}
                  </div>
                  <span className="block text-[11px] text-muted-foreground truncate mt-0.5">{s.host}</span>
                </button>
              ))}
            </div>
            <div className="border-t border-border mt-2 pt-2">
              <button onClick={() => setServerModal({ open: true, edit: null })}
                className="w-full inline-flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-xl border border-border hover:bg-muted">
                <Plus className="w-3.5 h-3.5" /> 서버 추가
              </button>
            </div>
          </MacCard>
        </div>

        {/* 본문 */}
        <div className="flex-1 min-w-0 space-y-4">
          <div className="flex items-center gap-2">
            <HardDrive className="w-5 h-5 text-sky-500" />
            <h1 className="text-lg font-semibold">NFS 모니터링 (Isilon)</h1>
            <span className="text-xs text-muted-foreground">K8s 가 쓰는 NFS 를 NAS 서버 쪽에서 점검 · 읽기전용/무부하 · 선택한 명령만 실행</span>
          </div>

          {!loadingServers && servers.length === 0 ? (
            <MacCard>
              <EmptyState
                icon={ServerCog}
                title="Isilon 서버를 먼저 등록하세요"
                description="SSH 접속 대상(host/계정/비밀번호)을 등록하면 isi 명령으로 NFS 현황을 수집합니다."
                action={{ label: '서버 추가', onClick: () => setServerModal({ open: true, edit: null }) }}
              />
            </MacCard>
          ) : selected ? (
            <>
              {/* 서버 헤더 */}
              <MacCard bodyPadding="p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{selected.name}</span>
                      <button onClick={() => setServerModal({ open: true, edit: selected })}
                        className="text-muted-foreground hover:text-foreground" aria-label="편집">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <span className="text-xs text-muted-foreground">{selected.username}@{selected.host}:{selected.port}</span>
                  </div>
                  <div className="ml-auto flex items-center gap-3">
                    {runResult?.executedAt && (
                      <span className="text-xs text-muted-foreground">
                        마지막 실행 {new Date(runResult.executedAt).toLocaleTimeString()}
                      </span>
                    )}
                    <ConnBadge runResult={runResult} running={runMut.isPending} />
                  </div>
                </div>
                {runResult?.connectionError && (
                  <div className="mt-3 text-sm text-red-500">⚠ {runResult.connectionError}</div>
                )}
                {runResult?.skippedKeys && runResult.skippedKeys.length > 0 && (
                  <p className="mt-2 text-xs text-amber-600">등록/활성화되지 않아 건너뜀: {runResult.skippedKeys.join(', ')}</p>
                )}
              </MacCard>

              {/* K8s NFS PV ↔ export 매칭 (직전 실행에 exports 명령이 포함된 경우에만 채워짐) */}
              <MacCard title="K8s 가 사용하는 NFS (PV ↔ Isilon export)">
                <K8sNfsTable runResult={runResult} />
              </MacCard>

              {/* 좌(명령 선택) / 우(결과) 한 로우 고정 — 콘솔 화면 표준(§12.6) */}
              <div className="grid grid-cols-1 lg:grid-cols-10 gap-4 items-start">
                <MacCard title="명령 선택" rootClassName="lg:col-span-4 min-w-0" bodyPadding="p-4">
                  <IsilonCommandSelector
                    serverId={selectedId}
                    selectedKeys={selectedKeys}
                    onToggle={toggleKey}
                    onSelectAll={(keys) => setSelectedKeys(new Set(keys))}
                    onClear={() => setSelectedKeys(new Set())}
                    onRun={handleRun}
                    onManage={() => setCmdOpen(true)}
                    running={runMut.isPending}
                  />
                </MacCard>

                <RunResultPanel runResult={runResult} running={runMut.isPending} />
              </div>
            </>
          ) : null}
        </div>
      </div>

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
function ConnBadge({ runResult, running }: { runResult: IsilonRunResponse | null; running: boolean }) {
  if (running) return <StatusBadge variant="loading" label="실행 중" />;
  if (!runResult) return <StatusBadge variant="neutral" label="미실행" />;
  return runResult.connectionOk
    ? <StatusBadge variant="healthy" label="접속됨" />
    : <StatusBadge variant="pending" label="접속 불가" />;
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

function K8sNfsTable({ runResult }: { runResult: IsilonRunResponse | null }) {
  const pvs: IsilonK8sNfsPv[] = runResult?.k8sNfsPvs ?? [];
  const exportPaths = useMemo(() => extractExportPaths(runResult?.results), [runResult]);
  if (pvs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        NFS 백엔드(spec.nfs)를 쓰는 K8s PV 가 없거나 K8s 조회가 불가합니다. (명령을 하나 이상 실행하면 함께 채워집니다.)
      </p>
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
                <td className="py-1.5 pr-3 text-xs">{pv.pvc ?? '-'}</td>
                <td className="py-1.5 pr-3 font-mono text-xs">{pv.path}</td>
                <td className="py-1.5 pr-3 text-xs">{pv.server ?? '-'}</td>
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

// 결과는 실행 전에도 같은 자리(우측)에 플레이스홀더로 존재 — 콘솔 화면 표준(§12.6 rule 1).
// 로그 출력은 항상 LogViewer(plain <pre> 금지, rule 3).
function RunResultPanel({ runResult, running }: { runResult: IsilonRunResponse | null; running: boolean }) {
  if (!runResult && !running) {
    return (
      <MacCard rootClassName="lg:col-span-6 min-w-0" bodyPadding="p-5" className="flex items-center justify-center min-h-[200px] lg:h-[calc(100vh-360px)]">
        <p className="text-sm text-muted-foreground text-center">
          왼쪽에서 isi 명령을 선택하고 실행하면<br />결과가 여기에 표시됩니다.
        </p>
      </MacCard>
    );
  }
  const results = runResult?.results ?? [];
  return (
    <MacCard rootClassName="lg:col-span-6 min-w-0 overflow-y-auto overflow-x-hidden lg:h-[calc(100vh-360px)]" bodyPadding="p-0">
      {running && !runResult ? (
        <div className="text-sm text-muted-foreground py-10 text-center"><Loader2 className="w-4 h-4 animate-spin inline" /> 실행 중…</div>
      ) : results.length === 0 ? (
        <p className="text-sm text-muted-foreground py-10 text-center">실행된 명령 결과가 없습니다.</p>
      ) : (
        <div className="divide-y divide-border">
          {results.map((r) => <ResultBlock key={r.key} result={r} />)}
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
          label={result.ok ? `exit ${result.exitCode ?? 0}` : (result.error ?? `exit ${result.exitCode ?? '-'}`)}
        />
        <span className="font-medium text-foreground">{ISILON_SECTION_LABEL[result.section] ?? result.section} · {result.label}</span>
        <code className="text-muted-foreground truncate">{result.command}</code>
        <span className="ml-auto text-muted-foreground shrink-0">{result.durationMs}ms</span>
      </div>
      {content
        ? <LogViewer text={content} maxHeight="max-h-72" asError={!result.ok} />
        : <p className="text-xs text-muted-foreground">출력 없음</p>}
    </div>
  );
}
