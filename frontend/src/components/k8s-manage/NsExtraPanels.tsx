// NS 대시보드 전용 보조 패널 — 종류별 공통 ResourceTablePanel 로는 그릴 수 없는 "이 NS 기준" 목록.
//  - NsCrdObjectsPanel: namespaced CRD 1종의 이 NS 오브젝트(additionalPrinterColumns 동적 컬럼)
//  - NsBindingsPanel: subject 가 이 NS 를 가리키는 ClusterRoleBinding(cluster-scoped) · 다른 NS 의 RoleBinding
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { EmptyState, Skeleton } from '@/components/common';
import { k8sResourcesApi } from '@/services/api';
import { NS_BINDING_QUERY, type NsBindingScope } from './nsBindingQueries';
import type { K8sCrdInfo, K8sResourceRow } from '@/types';

function ageText(sec?: number | null): string {
  if (sec == null) return '-';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

function errText(e: unknown): string {
  const d = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  return typeof d === 'string' && d ? d : String((e as Error)?.message ?? e).slice(0, 200);
}

function Rows() {
  return (
    <div className="p-3 space-y-2">
      {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-4 w-full" />)}
    </div>
  );
}

export function NsCrdObjectsPanel({ clusterId, ns, crd, onOpenObject }: {
  clusterId: string; ns: string; crd: K8sCrdInfo;
  onOpenObject: (crd: K8sCrdInfo, row: K8sResourceRow) => void;
}) {
  const q = useQuery({
    queryKey: ['k8s-mng-crd-objs', clusterId, crd.name, ns],
    queryFn: async () => (await k8sResourcesApi.crdObjects(clusterId, crd.group, crd.version, crd.plural, ns)).data,
    enabled: !!clusterId && !!ns,
    retry: false,
  });
  const dynCols = q.data?.columns ?? [];
  const grid = {
    gridTemplateColumns: [
      'minmax(160px,1.4fr)',
      ...(dynCols.length > 0 ? dynCols.map(() => 'minmax(80px,1fr)') : ['1fr']),
      '60px',
    ].join(' '),
  };
  return (
    <MacCard
      title={`${crd.kind}`}
      description={crd.group}
      bodyPadding="p-0"
      actions={
        <button type="button" onClick={() => void q.refetch()} title="새로고침" aria-label="새로고침"
          className="p-1.5 rounded-xl text-muted-foreground hover:text-foreground hover:bg-secondary/60">
          <RefreshCw className={`w-3.5 h-3.5 ${q.isFetching ? 'animate-spin' : ''}`} />
        </button>
      }
    >
      <div className="grid gap-2 px-4 py-1.5 text-xs font-semibold text-muted-foreground border-b border-border bg-secondary/30" style={grid}>
        <span>이름</span>
        {dynCols.length > 0 ? dynCols.map((c) => <span key={c.key} className="truncate">{c.label}</span>) : <span>Summary</span>}
        <span className="text-right">Age</span>
      </div>
      {q.isLoading ? <Rows /> : q.isError ? (
        <div className="p-6 text-sm text-status-critical">조회 실패: {errText(q.error)}</div>
      ) : (q.data?.items.length ?? 0) === 0 ? (
        <EmptyState compact title="오브젝트가 없습니다." description="이 네임스페이스에 이 종류의 오브젝트가 없습니다." />
      ) : (
        q.data!.items.map((r) => (
          <button key={r.name} type="button" onClick={() => onOpenObject(crd, r)}
            className="w-full grid gap-2 px-4 py-1.5 text-sm text-left border-b border-border/40 hover:bg-secondary/30 items-center" style={grid}>
            <span className="truncate font-medium">{r.name}</span>
            {dynCols.length > 0
              ? dynCols.map((c) => <span key={c.key} className="truncate text-muted-foreground" title={r.cols?.[c.key] ?? ''}>{r.cols?.[c.key] ?? '—'}</span>)
              : <span className="truncate text-muted-foreground">{r.summary}</span>}
            <span className="text-right text-muted-foreground tabular-nums">{ageText(r.ageSeconds)}</span>
          </button>
        ))
      )}
    </MacCard>
  );
}

const BINDING_TEXT: Record<NsBindingScope, { title: string; description: string; empty: string }> = {
  cluster: {
    title: 'ClusterRoleBindings',
    description: '이 네임스페이스의 ServiceAccount 등에 클러스터 전역 권한을 주는 바인딩',
    empty: '이 네임스페이스를 묶는 ClusterRoleBinding 이 없습니다.',
  },
  external: {
    title: '다른 네임스페이스의 RoleBindings',
    description: '다른 네임스페이스 안에서 이 네임스페이스의 ServiceAccount 등에 권한을 주는 바인딩',
    empty: '이 네임스페이스를 묶는 다른 네임스페이스의 RoleBinding 이 없습니다.',
  },
};

export function NsBindingsPanel({ clusterId, ns, scope, onOpenDetail }: {
  clusterId: string; ns: string; scope: NsBindingScope;
  onOpenDetail: (row: K8sResourceRow) => void;
}) {
  const q = useQuery({ ...NS_BINDING_QUERY[scope](clusterId, ns), enabled: !!clusterId && !!ns, retry: false });
  const text = BINDING_TEXT[scope];
  const withNs = scope === 'external';
  const grid = {
    gridTemplateColumns: [
      ...(withNs ? ['minmax(120px,0.8fr)'] : []),
      'minmax(180px,1.2fr) minmax(160px,1fr) minmax(200px,1.4fr) 60px',
    ].join(' '),
  };
  return (
    <MacCard title={text.title} description={text.description} bodyPadding="p-0">
      <div className="grid gap-2 px-4 py-1.5 text-xs font-semibold text-muted-foreground border-b border-border bg-secondary/30" style={grid}>
        {withNs && <span>네임스페이스</span>}
        <span>이름</span><span>Role</span><span>이 NS 의 Subjects</span><span className="text-right">Age</span>
      </div>
      {q.isLoading ? <Rows /> : q.isError ? (
        <div className="p-6 text-sm text-status-critical">조회 실패: {errText(q.error)}</div>
      ) : (q.data?.items.length ?? 0) === 0 ? (
        <EmptyState compact title={text.empty} />
      ) : (
        q.data!.items.map((r) => (
          <button key={`${r.namespace ?? ''}/${r.name}`} type="button" onClick={() => onOpenDetail(r)}
            className="w-full grid gap-2 px-4 py-1.5 text-sm text-left border-b border-border/40 hover:bg-secondary/30 items-center" style={grid}>
            {withNs && <span className="truncate text-muted-foreground">{r.namespace ?? '—'}</span>}
            <span className="truncate font-medium">{r.name}</span>
            <span className="truncate text-muted-foreground">{r.cols?.role ?? '—'}</span>
            <span className="truncate text-muted-foreground" title={r.cols?.subjects ?? ''}>{r.cols?.subjects ?? '—'}</span>
            <span className="text-right text-muted-foreground tabular-nums">{ageText(r.ageSeconds)}</span>
          </button>
        ))
      )}
    </MacCard>
  );
}
