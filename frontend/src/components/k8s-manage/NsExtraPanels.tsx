// NS 대시보드 전용 보조 패널 — 종류별 공통 ResourceTablePanel 로는 그릴 수 없는 "이 NS 기준" 목록.
//  - NsCrdObjectsPanel: namespaced CRD 1종의 이 NS 오브젝트(additionalPrinterColumns 동적 컬럼)
//  - NsBindingsPanel: subject 가 이 NS 를 가리키는 ClusterRoleBinding(cluster-scoped) · 다른 NS 의 RoleBinding
//    (두 표 모두 행을 펼치면 참조 Role/ClusterRole 의 권한 규칙을 보여준다 — RoleRulesView)
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { EmptyState, Skeleton } from '@/components/common';
import { k8sResourcesApi } from '@/services/api';
import { NS_BINDING_QUERY, type NsBindingScope } from './nsBindingQueries';
import type { K8sBindingRow, K8sCrdInfo, K8sResourceRow, K8sRoleRule } from '@/types';

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

/** 규칙 값 목록 — 와일드카드 `*` 는 넓은 권한이라 경고색으로 강조한다. */
function RuleValues({ values, empty = '—' }: { values: string[]; empty?: string }) {
  if (values.length === 0) return <span className="text-muted-foreground">{empty}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {values.map((v) => (
        <span key={v} className={`font-mono text-xs rounded px-1 py-0.5 ${v === '*' ? 'bg-status-warning/15 text-status-warning font-semibold' : 'bg-secondary text-foreground'}`}>{v}</span>
      ))}
    </span>
  );
}

const RULE_GRID = { gridTemplateColumns: 'minmax(140px,1fr) minmax(110px,0.8fr) minmax(160px,1.2fr) minmax(120px,1fr)' };

/** 참조 Role/ClusterRole 의 규칙 표 — kubectl describe role 처럼 규칙 1개 = 1줄. */
function RoleRulesView({ row, scope }: { row: K8sBindingRow; scope: NsBindingScope }) {
  const scopeNote = scope === 'cluster'
    ? `ClusterRole ${row.roleName} 의 규칙입니다 — ClusterRoleBinding 이라 클러스터 전체(모든 네임스페이스)에서 유효합니다.`
    : row.roleKind === 'ClusterRole'
      ? `ClusterRole ${row.roleName} 의 규칙이지만, RoleBinding 으로 묶여 ${row.namespace} 네임스페이스 안에서만 유효합니다.`
      : `${row.namespace} 네임스페이스의 Role ${row.roleName} 규칙입니다.`;
  return (
    <div className="px-4 pb-2 pt-1 pl-10 space-y-1.5 bg-secondary/20 border-b border-border/40">
      {row.rulesError ? (
        <p role="status" className="text-xs text-status-warning">{row.rulesError}</p>
      ) : !row.rules || row.rules.length === 0 ? (
        <p className="text-xs text-muted-foreground">{row.rules ? '규칙이 없는 Role 입니다 — 아무 권한도 주지 않습니다.' : '권한 내용을 받지 못했습니다.'}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{scopeNote}</p>
          <div className="rounded-md border border-border overflow-hidden">
            <div className="grid gap-2 px-3 py-1 text-xs font-semibold text-muted-foreground bg-secondary/40 border-b border-border" style={RULE_GRID}>
              <span>동작(verbs)</span><span>API 그룹</span><span>리소스 / URL</span><span>리소스 이름</span>
            </div>
            {row.rules.map((rule: K8sRoleRule, i) => (
              <div key={i} className="grid gap-2 px-3 py-1 text-sm border-b border-border/40 last:border-b-0 items-start" style={RULE_GRID}>
                <RuleValues values={rule.verbs} />
                <RuleValues values={rule.apiGroups.map((g) => g || 'core')} empty={rule.nonResourceUrls.length ? '—' : 'core'} />
                <RuleValues values={[...rule.resources, ...rule.nonResourceUrls]} />
                <RuleValues values={rule.resourceNames} empty="전체" />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function NsBindingsPanel({ clusterId, ns, scope, onOpenDetail }: {
  clusterId: string; ns: string; scope: NsBindingScope;
  onOpenDetail: (row: K8sResourceRow) => void;
}) {
  const q = useQuery({ ...NS_BINDING_QUERY[scope](clusterId, ns), enabled: !!clusterId && !!ns, retry: false });
  const text = BINDING_TEXT[scope];
  const withNs = scope === 'external';
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [allOpen, setAllOpen] = useState(false);
  const toggle = (key: string) => {
    if (allOpen) {   // 전체 펼침 상태에서 하나를 접으면 나머지는 펼친 채로 개별 모드로 전환
      setAllOpen(false);
      setExpanded(new Set((q.data?.items ?? []).map((r) => `${r.namespace ?? ''}/${r.name}`).filter((k) => k !== key)));
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const grid = {
    gridTemplateColumns: [
      '20px',
      ...(withNs ? ['minmax(120px,0.8fr)'] : []),
      'minmax(180px,1.2fr) minmax(160px,1fr) minmax(200px,1.4fr) 60px',
    ].join(' '),
  };
  const hasRows = (q.data?.items.length ?? 0) > 0;
  return (
    <MacCard
      title={text.title}
      description={`${text.description} · 행 앞 화살표로 참조 ${withNs ? 'Role' : 'ClusterRole'} 의 권한을 펼친다`}
      bodyPadding="p-0"
      actions={hasRows ? (
        <button type="button" onClick={() => { setAllOpen((v) => !v); setExpanded(new Set()); }}
          className="rounded-xl border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/60">
          {allOpen ? '권한 모두 접기' : '권한 모두 펼치기'}
        </button>
      ) : undefined}
    >
      <div className="grid gap-2 px-4 py-1.5 text-xs font-semibold text-muted-foreground border-b border-border bg-secondary/30" style={grid}>
        <span aria-hidden />
        {withNs && <span>네임스페이스</span>}
        <span>이름</span><span>Role</span><span>이 NS 의 Subjects</span><span className="text-right">Age</span>
      </div>
      {q.isLoading ? <Rows /> : q.isError ? (
        <div className="p-6 text-sm text-status-critical">조회 실패: {errText(q.error)}</div>
      ) : (q.data?.items.length ?? 0) === 0 ? (
        <EmptyState compact title={text.empty} />
      ) : (
        q.data!.items.map((r) => {
          const key = `${r.namespace ?? ''}/${r.name}`;
          // 행 앞 화살표로 참조 Role/ClusterRole 권한을 펼치고, 이름을 누르면 바인딩 상세·YAML.
          const open = allOpen || expanded.has(key);
          return (
            <div key={key}>
              <div className="grid gap-2 px-4 py-1.5 text-sm border-b border-border/40 hover:bg-secondary/30 items-center" style={grid}>
                <button type="button" onClick={() => toggle(key)} aria-expanded={open}
                  title={open ? '권한 접기' : '권한 펼치기'} aria-label={`${r.name} 권한 ${open ? '접기' : '펼치기'}`}
                  className="flex items-center justify-center w-5 h-5 rounded-xl text-muted-foreground hover:text-foreground hover:bg-secondary/60">
                  <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
                </button>
                {withNs && <span className="truncate text-muted-foreground">{r.namespace ?? '—'}</span>}
                <button type="button" onClick={() => onOpenDetail(r)} title="바인딩 상세·YAML"
                  className="truncate font-medium text-left hover:underline">{r.name}</button>
                <span className="truncate text-muted-foreground">{r.cols?.role ?? '—'}</span>
                <span className="truncate text-muted-foreground" title={r.cols?.subjects ?? ''}>{r.cols?.subjects ?? '—'}</span>
                <span className="text-right text-muted-foreground tabular-nums">{ageText(r.ageSeconds)}</span>
              </div>
              {open && <RoleRulesView row={r} scope={scope} />}
            </div>
          );
        })
      )}
    </MacCard>
  );
}
