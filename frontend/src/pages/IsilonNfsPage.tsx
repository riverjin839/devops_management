import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  HardDrive, Plus, Pencil, RefreshCw, Loader2, Terminal,
  ServerCog, CheckCircle2, AlertCircle,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { StatusBadge, StatusDot, statusToVariant, EmptyState, useToast } from '@/components/common';
import { IsilonServerModal, IsilonCommandManager } from '@/components/isilon';
import {
  useIsilonServers, useIsilonOverview, isilonKeys,
} from '@/hooks/useIsilonNfs';
import { isilonNfsApi } from '@/services/api';
import type {
  IsilonServer, IsilonCommandResult, IsilonNfsOverview, IsilonK8sNfsPv,
} from '@/types';
import { parseUTC } from '@/lib/utils';

const SECTION_LABEL: Record<string, string> = {
  exports: 'Export / 마운트',
  nfs_settings: 'NFS 서비스 설정',
  quotas: '쿼터 / 용량',
  clients: '클라이언트 / 성능',
  node_health: '클러스터 / 노드 상태',
  custom: '커스텀 명령',
};

export function IsilonNfsPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: servers = [], isLoading: loadingServers } = useIsilonServers();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [serverModal, setServerModal] = useState<{ open: boolean; edit?: IsilonServer | null }>({ open: false });
  const [cmdOpen, setCmdOpen] = useState(false);
  const [forcing, setForcing] = useState(false);

  // 서버 목록 로드 시 기본 선택
  useEffect(() => {
    if (!selectedId && servers.length > 0) {
      setSelectedId(servers.find((s) => s.isDefault)?.id ?? servers[0].id);
    }
  }, [servers, selectedId]);

  const selected = servers.find((s) => s.id === selectedId);
  const { data: overview, isLoading: loadingOverview, isFetching } = useIsilonOverview(selectedId, !!selectedId);

  const handleForceRefresh = async () => {
    if (!selectedId) return;
    setForcing(true);
    try {
      const { data } = await isilonNfsApi.getOverview(selectedId, true);
      qc.setQueryData(isilonKeys.overview(selectedId), data);
      toast.success('재수집 완료');
    } catch {
      toast.error('재수집 실패');
    } finally {
      setForcing(false);
    }
  };

  return (
    <div className="app-min-h-screen bg-background py-3 pr-3">
      <div className="flex gap-3">
        {/* 좌측 서버 레일 */}
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
            <div className="border-t border-border mt-2 pt-2 space-y-1">
              <button onClick={() => setServerModal({ open: true, edit: null })}
                className="w-full inline-flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-xl border border-border hover:bg-muted">
                <Plus className="w-3.5 h-3.5" /> 서버 추가
              </button>
              <button onClick={() => setCmdOpen(true)}
                className="w-full inline-flex items-center gap-1.5 text-xs px-2 py-1.5 rounded-xl border border-border hover:bg-muted">
                <Terminal className="w-3.5 h-3.5" /> isi 명령 관리
              </button>
            </div>
          </MacCard>
        </div>

        {/* 본문 */}
        <div className="flex-1 min-w-0 space-y-4">
          <div className="flex items-center gap-2">
            <HardDrive className="w-5 h-5 text-sky-500" />
            <h1 className="text-lg font-semibold">NFS 모니터링 (Isilon)</h1>
            <span className="text-xs text-muted-foreground">K8s 가 쓰는 NFS 를 NAS 서버 쪽에서 점검 · 읽기전용/무부하</span>
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
                    {overview?.collectedAt && (
                      <span className="text-xs text-muted-foreground">
                        수집 {parseUTC(overview.collectedAt).toLocaleTimeString()}
                        {overview.fromCache && <span className="ml-1 text-[10px] px-1 rounded bg-muted">캐시</span>}
                      </span>
                    )}
                    <ConnBadge overview={overview} loading={loadingOverview || isFetching} />
                    <button onClick={handleForceRefresh} disabled={forcing}
                      title="캐시를 무시하고 재수집 (NAS 부하 주의)"
                      className="inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-xl border border-border hover:bg-muted disabled:opacity-50">
                      {forcing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                      새로고침
                    </button>
                  </div>
                </div>
                {overview?.connectionError && (
                  <div className="mt-3 text-sm text-red-500 flex items-center gap-1.5">
                    <AlertCircle className="w-4 h-4" /> {overview.connectionError}
                  </div>
                )}
                {overview && overview.errors && overview.errors.length > 0 && (
                  <ul className="mt-2 text-xs text-amber-600 space-y-0.5">
                    {overview.errors.slice(0, 6).map((er, i) => <li key={i}>· {er}</li>)}
                  </ul>
                )}
              </MacCard>

              {/* K8s NFS PV ↔ export 매칭 */}
              <MacCard title="K8s 가 사용하는 NFS (PV ↔ Isilon export)">
                <K8sNfsTable overview={overview} loading={loadingOverview} />
              </MacCard>

              {/* 수집 결과 섹션들 */}
              {loadingOverview && !overview ? (
                <MacCard><div className="text-sm text-muted-foreground py-6 text-center"><Loader2 className="w-4 h-4 animate-spin inline" /> 수집 중…</div></MacCard>
              ) : (
                (overview?.results ?? []).filter((r) => r.showOnOverview).map((r) => (
                  <MacCard key={r.key} title={`${SECTION_LABEL[r.section] ?? r.section} · ${r.label}`}>
                    <ResultBody result={r} />
                  </MacCard>
                ))
              )}
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
function ConnBadge({ overview, loading }: { overview?: IsilonNfsOverview; loading: boolean }) {
  if (loading) return <StatusBadge variant="loading" label="수집 중" />;
  if (!overview) return <StatusBadge variant="neutral" label="-" />;
  if (overview.configured === false) return <StatusBadge variant="pending" label="미설정" />;
  return overview.connectionOk
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

function K8sNfsTable({ overview, loading }: { overview?: IsilonNfsOverview; loading: boolean }) {
  const pvs: IsilonK8sNfsPv[] = overview?.k8sNfsPvs ?? [];
  const exportPaths = useMemo(() => extractExportPaths(overview?.results), [overview]);
  if (loading && !overview) return <div className="text-sm text-muted-foreground py-4 text-center"><Loader2 className="w-4 h-4 animate-spin inline" /> …</div>;
  if (pvs.length === 0) return <p className="text-sm text-muted-foreground">NFS 백엔드(spec.nfs)를 쓰는 K8s PV 가 없거나 K8s 조회가 불가합니다.</p>;
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
                    ? <StatusBadge variant="neutral" label="확인불가" />
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

function ResultBody({ result }: { result: IsilonCommandResult }) {
  const content = result.parsed != null
    ? JSON.stringify(result.parsed, null, 2)
    : (result.raw ?? '');
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        {result.ok
          ? <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="w-3.5 h-3.5" /> exit {result.exitCode}</span>
          : <span className="inline-flex items-center gap-1 text-red-500"><AlertCircle className="w-3.5 h-3.5" /> {result.error ?? `exit ${result.exitCode}`}</span>}
        <code className="text-muted-foreground truncate">{result.command}</code>
        <span className="ml-auto text-muted-foreground">{result.durationMs}ms</span>
      </div>
      {content
        ? <div className="overflow-x-auto"><pre className="text-xs bg-muted/40 rounded-xl p-3 max-h-72 overflow-y-auto">{content}</pre></div>
        : <p className="text-xs text-muted-foreground">출력 없음</p>}
    </div>
  );
}
