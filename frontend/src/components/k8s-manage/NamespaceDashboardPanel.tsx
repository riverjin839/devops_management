// K8S 상세관리 — 네임스페이스 대시보드. 종류(kind) 기준 탐색과 별도로, 네임스페이스 하나를
// 고르면 그 안의 workload/config/network/storage 를 한 화면에서 본다. 실제 리소스 조회/스케일/
// 재시작/삭제/YAML 편집은 전부 기존 ResourceTablePanel/PodsPanel(및 페이지 레벨 DetailDrawer/
// ConfirmDialog)을 그대로 재사용한다 — 이 파일은 "네임스페이스로 먼저 좁히는" 레이아웃만 새로 만든다.
import { useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import * as Tabs from '@radix-ui/react-tabs';
import { Boxes, Settings as SettingsIcon, Network, Database, LayoutGrid, Rows3 } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { EmptyState, Skeleton } from '@/components/common';
import { NamespaceMultiSelect } from '@/components/k8s/NamespaceMultiSelect';
import { k8sResourcesApi } from '@/services/api';
import { ResourceTablePanel, PodsPanel } from '@/pages/K8sManagePage';
import type { K8sResourceCapability, K8sResourceRow, K8sPodRichRow, KindAvailabilityInfo } from '@/types';

type CatId = 'workload' | 'config' | 'network' | 'storage';
interface CatDef { id: CatId; label: string; icon: React.ComponentType<{ className?: string }>; chartVar: string; kinds: string[] }

// PV/StorageClass 등 cluster-scoped 종류는 제외 — "이 네임스페이스 안" 이라는 전제와 맞지 않는다.
const CATS: CatDef[] = [
  { id: 'workload', label: 'Workload', icon: Boxes, chartVar: '--chart-1', kinds: ['pods', 'deployments', 'statefulsets', 'daemonsets', 'replicasets', 'replicationcontrollers', 'jobs', 'cronjobs'] },
  { id: 'config', label: 'Config', icon: SettingsIcon, chartVar: '--chart-2', kinds: ['configmaps', 'secrets', 'resourcequotas', 'limitranges', 'horizontalpodautoscalers', 'poddisruptionbudgets', 'leases'] },
  { id: 'network', label: 'Network', icon: Network, chartVar: '--chart-3', kinds: ['services', 'endpoints', 'endpointslices', 'ingresses', 'networkpolicies'] },
  { id: 'storage', label: 'Storage', icon: Database, chartVar: '--chart-4', kinds: ['persistentvolumeclaims'] },
];

const KIND_LABEL: Record<string, string> = {
  pods: 'Pods', deployments: 'Deployments', statefulsets: 'StatefulSets', daemonsets: 'DaemonSets',
  replicasets: 'ReplicaSets', replicationcontrollers: 'Replication Controllers', jobs: 'Jobs', cronjobs: 'CronJobs',
  configmaps: 'ConfigMaps', secrets: 'Secrets', resourcequotas: 'Resource Quotas', limitranges: 'Limit Ranges',
  horizontalpodautoscalers: 'HPA', poddisruptionbudgets: 'Pod Disruption Budgets', leases: 'Leases',
  services: 'Services', endpoints: 'Endpoints', endpointslices: 'Endpoint Slices', ingresses: 'Ingresses',
  networkpolicies: 'Network Policies', persistentvolumeclaims: 'Persistent Volume Claims',
};

type Health = { ok: number; warn: number; crit: number } | null;

function ratio(cols: Record<string, string> | undefined, key: string): number {
  return parseInt(cols?.[key] ?? '0', 10) || 0;
}

/** 종류별 "상태" 개념이 있는 것만 정상/경고/위험을 매긴다 — 없는 종류(ConfigMap 등)는 null(개수만 표시). */
function healthFromGenericRows(kind: string, rows: K8sResourceRow[]): Health {
  if (kind === 'deployments' || kind === 'statefulsets') {
    let ok = 0, warn = 0;
    rows.forEach((r) => {
      const [ready, desired] = (r.cols?.pods ?? '0/0').split('/').map((n) => parseInt(n, 10) || 0);
      if (ready === desired) ok++; else warn++;
    });
    return { ok, warn, crit: 0 };
  }
  if (kind === 'daemonsets') {
    let ok = 0, warn = 0;
    rows.forEach((r) => { if (ratio(r.cols, 'ready') === ratio(r.cols, 'desired')) ok++; else warn++; });
    return { ok, warn, crit: 0 };
  }
  if (kind === 'replicasets' || kind === 'replicationcontrollers') {
    let ok = 0, warn = 0;
    rows.forEach((r) => {
      const desired = ratio(r.cols, 'desired');
      if (desired === 0 || ratio(r.cols, 'ready') === desired) ok++; else warn++;
    });
    return { ok, warn, crit: 0 };
  }
  if (kind === 'jobs') {
    let ok = 0, warn = 0, crit = 0;
    rows.forEach((r) => {
      const failed = ratio(r.cols, 'failed');
      const succeeded = ratio(r.cols, 'succeeded');
      const completions = parseInt(r.cols?.completions ?? '', 10);
      if (failed > 0) crit++;
      else if (!Number.isNaN(completions) && succeeded >= completions) ok++;
      else warn++;
    });
    return { ok, warn, crit };
  }
  if (kind === 'persistentvolumeclaims') {
    let ok = 0, warn = 0, crit = 0;
    rows.forEach((r) => {
      const s = (r.cols?.status ?? '').toLowerCase();
      if (s === 'bound') ok++; else if (s === 'pending') warn++; else crit++;
    });
    return { ok, warn, crit };
  }
  return null;
}
function healthFromPods(rows: K8sPodRichRow[]): Health {
  let ok = 0, warn = 0, crit = 0;
  rows.forEach((r) => {
    if (r.statusColor === 'red') crit++;
    else if (r.statusColor === 'amber') warn++;
    else ok++; // green + gray(종료/대기) 는 "위험" 취급하지 않는다
  });
  return { ok, warn, crit };
}

const HealthCell = ({ n, tone }: { n: number; tone: 'ok' | 'warn' | 'crit' }) => (
  <span className={`tabular-nums ${n === 0 ? 'text-muted-foreground' : tone === 'ok' ? 'text-status-healthy font-medium' : tone === 'warn' ? 'text-status-warning font-semibold' : 'text-status-critical font-semibold'}`}>
    {n}
  </span>
);

interface NamespaceDashboardPanelProps {
  clusterId: string;
  caps: Record<string, K8sResourceCapability>;
  avail?: Record<string, KindAvailabilityInfo>;
  onOpenDetail: (kind: string, row: K8sResourceRow | K8sPodRichRow, editable: boolean) => void;
  onScale: (kind: string, ns: string, name: string) => void;
  onRestart: (kind: string, ns: string, name: string) => void;
  onDelete: (kind: string, ns: string, name: string) => void;
  onTerminal: (ns: string, name: string) => void;
}

export function NamespaceDashboardPanel(p: NamespaceDashboardPanelProps) {
  const { clusterId, caps, avail, onOpenDetail, onScale, onRestart, onDelete, onTerminal } = p;
  const [ns, setNs] = useState('');
  const nsSet = useMemo(() => new Set(ns ? [ns] : []), [ns]);
  const [mode, setMode] = useState<'tab' | 'list'>('tab');
  const [activeCat, setActiveCat] = useState<CatId>('workload');
  const [activeKind, setActiveKind] = useState<string | null>(null);
  const noopCordon = () => {};
  const noopDrain = () => {};

  const isVisible = (kind: string) =>
    (caps[kind]?.namespaced ?? true) && (!avail || avail[kind]?.present !== false);

  const flatKinds = useMemo(
    () => CATS.flatMap((cat) => cat.kinds
      .filter((kind) => (caps[kind]?.namespaced ?? true) && (!avail || avail[kind]?.present !== false))
      .map((kind) => ({ cat, kind }))),
    [caps, avail],
  );

  const queries = useQueries({
    queries: flatKinds.map(({ kind }) => ({
      queryKey: ['k8s-mng-list', clusterId, kind, ns || 'none'],
      queryFn: async () => kind === 'pods'
        ? (await k8sResourcesApi.richPods(clusterId, ns)).data
        : (await k8sResourcesApi.list(clusterId, kind, ns)).data,
      enabled: !!clusterId && !!ns,
    })),
  });

  const inventory = flatKinds.map(({ cat, kind }, i) => {
    const q = queries[i];
    const data = q?.data as { items?: (K8sResourceRow | K8sPodRichRow)[]; count?: number } | undefined;
    const items = data?.items ?? [];
    const count = kind === 'pods' ? items.length : (data?.count ?? 0);
    const health = !data ? null
      : kind === 'pods' ? healthFromPods(items as K8sPodRichRow[])
      : healthFromGenericRows(kind, items as K8sResourceRow[]);
    return { cat, kind, count, health, isLoading: q?.isLoading, isError: q?.isError };
  });
  const totalCount = inventory.reduce((s, r) => s + r.count, 0);

  const gotoKind = (catId: CatId, kind: string) => {
    setActiveCat(catId); setActiveKind(kind);
    const anchor = mode === 'tab' ? 'nsdash-detail' : `nsdash-kind-${kind}`;
    requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <div className="space-y-3">
      <MacCard title="네임스페이스 선택" bodyPadding="p-3">
        <div className="flex items-center gap-3 flex-wrap">
          <NamespaceMultiSelect
            clusterId={clusterId} selected={nsSet} singleSelect
            onChange={(next) => { setNs([...next][0] ?? ''); setActiveKind(null); }}
          />
          {ns && <span className="text-xs text-muted-foreground">종류 {flatKinds.length}개 · 리소스 {totalCount}개</span>}
          <div className="ml-auto inline-flex rounded-xl border border-border p-0.5 bg-secondary/30">
            <button type="button" onClick={() => setMode('tab')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium ${mode === 'tab' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
              <Rows3 className="w-3.5 h-3.5" /> 탭 드릴인형
            </button>
            <button type="button" onClick={() => setMode('list')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium ${mode === 'list' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>
              <LayoutGrid className="w-3.5 h-3.5" /> 전체 나열형
            </button>
          </div>
        </div>
      </MacCard>

      {!ns ? (
        <MacCard bodyPadding="p-0">
          <EmptyState title="네임스페이스를 선택하세요" description="위에서 네임스페이스를 고르면 그 안의 workload/config/network/storage 리소스가 한 화면에 모입니다." />
        </MacCard>
      ) : (() => {
        const inventoryCard = (
          <MacCard title="리소스 인벤토리" bodyPadding="p-0">
            <div className="grid gap-2 px-4 py-1 text-xs font-semibold text-muted-foreground border-b border-border bg-secondary/30"
              style={{ gridTemplateColumns: 'minmax(150px,1.6fr) 110px 70px 60px 60px 60px 1fr' }}>
              <span>종류</span><span>구분</span><span className="text-right">개수</span>
              <span className="text-right">정상</span><span className="text-right">경고</span><span className="text-right">위험</span><span>비고</span>
            </div>
            {inventory.map(({ cat, kind, count, health, isLoading, isError }) => (
              <button key={kind} type="button" onClick={() => gotoKind(cat.id, kind)}
                className={`w-full grid gap-2 px-4 py-1 text-sm border-b border-border/40 items-center text-left hover:bg-secondary/30 ${activeKind === kind ? 'bg-secondary/40' : ''}`}
                style={{ gridTemplateColumns: 'minmax(150px,1.6fr) 110px 70px 60px 60px 60px 1fr' }}>
                <span className="font-medium truncate">{KIND_LABEL[kind] ?? kind}</span>
                <span className="flex items-center gap-1.5 text-muted-foreground truncate">
                  <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: `hsl(var(${cat.chartVar}))` }} />
                  {cat.label}
                </span>
                {isLoading ? (
                  <span className="col-span-4"><Skeleton className="h-3 w-20" /></span>
                ) : isError ? (
                  <span className="col-span-4 text-xs text-destructive">조회 실패</span>
                ) : (
                  <>
                    <span className="text-right tabular-nums">{count}</span>
                    {health ? (
                      <>
                        <span className="text-right"><HealthCell n={health.ok} tone="ok" /></span>
                        <span className="text-right"><HealthCell n={health.warn} tone="warn" /></span>
                        <span className="text-right"><HealthCell n={health.crit} tone="crit" /></span>
                      </>
                    ) : (
                      <span className="col-span-3 text-right text-muted-foreground">—</span>
                    )}
                    <span className="text-xs text-muted-foreground truncate">
                      {health ? (health.crit > 0 ? `위험 ${health.crit}건 확인 필요` : health.warn > 0 ? `경고 ${health.warn}건` : '정상') : ''}
                    </span>
                  </>
                )}
              </button>
            ))}
            <div className="px-4 py-1 text-xs text-muted-foreground border-t border-border">
              행 클릭 시 해당 종류의 상세 목록으로 이동합니다.
            </div>
          </MacCard>
        );

        return mode === 'tab' ? (
          <>
            <div id="nsdash-detail" />
            <Tabs.Root value={activeCat} onValueChange={(v) => { setActiveCat(v as CatId); setActiveKind(null); }}>
              <Tabs.List className="flex gap-1 mb-2 border-b border-border">
                {CATS.map((cat) => (
                  <Tabs.Trigger key={cat.id} value={cat.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary text-muted-foreground">
                    <cat.icon className="w-3.5 h-3.5" />{cat.label}
                  </Tabs.Trigger>
                ))}
              </Tabs.List>
              {CATS.map((cat) => {
                const kinds = cat.kinds.filter(isVisible);
                const kind = kinds.includes(activeKind ?? '') ? (activeKind as string) : kinds[0];
                return (
                  <Tabs.Content key={cat.id} value={cat.id} className="space-y-2">
                    <div className="flex gap-1.5 flex-wrap">
                      {kinds.map((k) => {
                        const inv = inventory.find((r) => r.kind === k);
                        return (
                          <button key={k} type="button" onClick={() => setActiveKind(k)}
                            className={`px-2.5 py-1 rounded-full text-xs font-medium border ${k === kind ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                            {KIND_LABEL[k] ?? k} <span className="tabular-nums opacity-70">{inv?.count ?? 0}</span>
                          </button>
                        );
                      })}
                    </div>
                    {kind && (
                      <KindPanel
                        clusterId={clusterId} ns={ns} kind={kind} caps={caps[kind]}
                        onOpenDetail={onOpenDetail} onScale={onScale} onRestart={onRestart} onDelete={onDelete} onTerminal={onTerminal}
                        onCordon={noopCordon} onDrain={noopDrain}
                      />
                    )}
                  </Tabs.Content>
                );
              })}
            </Tabs.Root>
            {inventoryCard}
          </>
        ) : (
          <>
            {inventoryCard}
            <div className="space-y-4">
              {CATS.map((cat) => {
                const kinds = cat.kinds.filter(isVisible);
                return (
                  <MacCard key={cat.id} title={cat.label} bodyPadding="p-3" className="space-y-3">
                    {kinds.length === 0 ? (
                      <div className="text-sm text-muted-foreground">이 네임스페이스에는 {cat.label} 리소스가 없습니다.</div>
                    ) : kinds.map((k) => (
                      <div key={k} id={`nsdash-kind-${k}`}>
                        <div className="text-xs font-semibold text-muted-foreground mb-1.5">{KIND_LABEL[k] ?? k}</div>
                        <KindPanel
                          clusterId={clusterId} ns={ns} kind={k} caps={caps[k]}
                          onOpenDetail={onOpenDetail} onScale={onScale} onRestart={onRestart} onDelete={onDelete} onTerminal={onTerminal}
                          onCordon={noopCordon} onDrain={noopDrain}
                        />
                      </div>
                    ))}
                  </MacCard>
                );
              })}
            </div>
          </>
        );
      })()}
    </div>
  );
}

/** ResourceTablePanel/PodsPanel 을 "네임스페이스 고정 + 내장 NS 선택기 숨김" 상태로 감싸는 얇은
 * 래퍼 — 검색어 state 를 종류마다 독립적으로 가져서 전체 나열형에서 여러 개가 동시에 떠도 서로
 * 간섭하지 않는다. */
function KindPanel({ clusterId, ns, kind, caps, onOpenDetail, onScale, onRestart, onDelete, onTerminal, onCordon, onDrain }: {
  clusterId: string; ns: string; kind: string; caps?: K8sResourceCapability;
  onOpenDetail: (kind: string, row: K8sResourceRow | K8sPodRichRow, editable: boolean) => void;
  onScale: (kind: string, ns: string, name: string) => void;
  onRestart: (kind: string, ns: string, name: string) => void;
  onDelete: (kind: string, ns: string, name: string) => void;
  onTerminal: (ns: string, name: string) => void;
  onCordon: (name: string, unschedulable: boolean) => void;
  onDrain: (name: string) => void;
}) {
  const [search, setSearch] = useState('');
  const selectedNs = useMemo(() => new Set([ns]), [ns]);
  const setSelectedNs = () => {};

  if (kind === 'pods') {
    return (
      <PodsPanel
        clusterId={clusterId} caps={caps} selectedNs={selectedNs} setSelectedNs={setSelectedNs}
        search={search} setSearch={setSearch} hideNsSelector
        onOpenDetail={(row) => onOpenDetail('pods', row, !!caps?.editable)}
        onDelete={onDelete} onTerminal={onTerminal}
      />
    );
  }
  return (
    <ResourceTablePanel
      clusterId={clusterId} kind={kind} caps={caps} selectedNs={selectedNs} setSelectedNs={setSelectedNs}
      search={search} setSearch={setSearch} hideNsSelector
      onOpenDetail={(row, editable) => onOpenDetail(kind, row, editable)}
      onScale={onScale} onRestart={onRestart} onDelete={onDelete}
      onCordon={onCordon} onDrain={onDrain} onTerminal={onTerminal}
    />
  );
}
