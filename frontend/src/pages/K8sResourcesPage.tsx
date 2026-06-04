import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Boxes, Search, X, RefreshCw, FileCode } from 'lucide-react';
import { Virtuoso } from 'react-virtuoso';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { LogViewer } from '@/components/common/LogViewer';
import { useClusters } from '@/hooks/useCluster';
import { useQuery } from '@tanstack/react-query';
import { k8sResourcesApi } from '@/services/api';
import type { K8sResourceRow } from '@/types';

// 백엔드 KIND_MAP 과 동기 — 라벨만 한글.
const KINDS: { key: string; label: string }[] = [
  { key: 'pods', label: 'Pods' },
  { key: 'deployments', label: 'Deployments' },
  { key: 'statefulsets', label: 'StatefulSets' },
  { key: 'daemonsets', label: 'DaemonSets' },
  { key: 'services', label: 'Services' },
  { key: 'ingresses', label: 'Ingresses' },
  { key: 'configmaps', label: 'ConfigMaps' },
  { key: 'secrets', label: 'Secrets' },
  { key: 'persistentvolumeclaims', label: 'PVC' },
  { key: 'jobs', label: 'Jobs' },
  { key: 'cronjobs', label: 'CronJobs' },
];

function age(sec?: number | null): string {
  if (sec == null) return '-';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

export function K8sResourcesPage() {
  const { clusterId = '' } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const { data: clusters = [] } = useClusters();

  useEffect(() => {
    if (!clusterId && clusters.length > 0) navigate(`/k8s-resources/${clusters[0].id}`, { replace: true });
  }, [clusterId, clusters, navigate]);

  const cluster = clusters.find((c) => c.id === clusterId);
  const [kind, setKind] = useState('pods');
  const [search, setSearch] = useState('');
  const [yamlTarget, setYamlTarget] = useState<K8sResourceRow | null>(null);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['k8s-resources', clusterId, kind],
    queryFn: async () => (await k8sResourcesApi.list(clusterId, kind)).data,
    enabled: !!clusterId,
  });

  const yamlQuery = useQuery({
    queryKey: ['k8s-yaml', clusterId, kind, yamlTarget?.namespace, yamlTarget?.name],
    queryFn: async () => (await k8sResourcesApi.yaml(clusterId, kind, yamlTarget!.namespace || '-', yamlTarget!.name)).data,
    enabled: !!yamlTarget,
  });

  const filtered = useMemo(() => {
    const list = data?.items ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => `${r.name} ${r.namespace ?? ''} ${r.summary}`.toLowerCase().includes(q));
  }, [data, search]);

  return (
    <div className="min-h-screen bg-background p-5">
      <div className="flex gap-4 max-w-[1600px] mx-auto">
        <div className="sticky top-4 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            onSelect={(id) => { if (id) navigate(`/k8s-resources/${id}`); }}
            iconOnly
          />
        </div>

        <div className="flex-1 min-w-0 space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <Link to="/" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted">
              <ArrowLeft className="w-3.5 h-3.5" /> 대시보드
            </Link>
            <h1 className="text-lg font-semibold flex-1 min-w-[200px] flex items-center gap-2">
              <Boxes className="w-4 h-4 text-primary" />
              {cluster ? `${cluster.name} — 리소스 탐색기` : '리소스 탐색기'}
              <span className="text-[10px] font-normal rounded px-1.5 py-0.5 bg-muted text-muted-foreground">읽기전용</span>
            </h1>
          </div>

          <MacCard title="K8s 리소스" bodyPadding="p-0">
            {/* kind 탭 + 검색 */}
            <div className="flex items-center gap-1.5 flex-wrap px-3 py-2.5 border-b border-border">
              {KINDS.map((k) => (
                <button
                  key={k.key}
                  onClick={() => setKind(k.key)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium border ${kind === k.key ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-muted-foreground border-border hover:bg-secondary/60'}`}
                >
                  {k.label}
                </button>
              ))}
              <div className="relative ml-auto">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="이름/네임스페이스 검색"
                  className="rounded-xl border border-border bg-card pl-7 pr-2 py-1 text-xs w-52 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <button onClick={() => refetch()} title="새로고침" className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground">
                <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {/* 헤더 행 */}
            <div className="grid grid-cols-[1fr_1fr_90px_60px] gap-2 px-4 py-1.5 text-[10px] font-semibold text-muted-foreground border-b border-border bg-secondary/30">
              <span>이름</span><span>네임스페이스</span><span>요약</span><span className="text-right">Age</span>
            </div>

            {isLoading ? (
              <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>
            ) : isError ? (
              <div className="p-6 text-sm text-red-500">조회 실패: {String((error as Error)?.message ?? '').slice(0, 200)}</div>
            ) : filtered.length === 0 ? (
              <div className="p-10 text-center text-sm text-muted-foreground">표시할 리소스가 없습니다.</div>
            ) : (
              <Virtuoso
                style={{ height: '62vh' }}
                data={filtered}
                itemContent={(_i, r) => (
                  <button
                    onClick={() => setYamlTarget(r)}
                    className="w-full grid grid-cols-[1fr_1fr_90px_60px] gap-2 px-4 py-1.5 text-left text-xs border-b border-border/40 hover:bg-secondary/30"
                  >
                    <span className="truncate font-medium">{r.name}</span>
                    <span className="truncate text-muted-foreground">{r.namespace ?? '-'}</span>
                    <span className="truncate text-muted-foreground">{r.summary}</span>
                    <span className="text-right text-muted-foreground tabular-nums">{age(r.ageSeconds)}</span>
                  </button>
                )}
              />
            )}
            <div className="px-4 py-1.5 text-[10px] text-muted-foreground border-t border-border">
              {filtered.length}개 표시{data?.truncated ? ` · ${1000}개 초과(잘림) — 네임스페이스 필터 권장` : ''} · 행 클릭 시 YAML
            </div>
          </MacCard>
        </div>
      </div>

      {/* YAML 읽기전용 drawer */}
      {yamlTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex justify-end" onClick={() => setYamlTarget(null)}>
          <div className="bg-card w-full max-w-2xl h-full overflow-auto border-l border-border" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-card flex items-center gap-2 px-5 py-3 border-b border-border">
              <FileCode className="w-4 h-4 text-primary" />
              <span className="font-semibold text-sm truncate">{kind}/{yamlTarget.namespace ? `${yamlTarget.namespace}/` : ''}{yamlTarget.name}</span>
              <span className="text-[10px] rounded px-1.5 py-0.5 bg-muted text-muted-foreground ml-1">읽기전용</span>
              <button onClick={() => setYamlTarget(null)} className="ml-auto text-muted-foreground hover:text-foreground" aria-label="닫기">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4">
              {yamlQuery.isLoading ? (
                <div className="text-sm text-muted-foreground">YAML 불러오는 중…</div>
              ) : yamlQuery.isError ? (
                <div className="text-sm text-red-500">YAML 조회 실패</div>
              ) : (
                <LogViewer text={yamlQuery.data?.yaml ?? ''} maxHeight="max-h-[80vh]" />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
