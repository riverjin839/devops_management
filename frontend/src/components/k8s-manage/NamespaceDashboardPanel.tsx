// K8S 상세관리 — 네임스페이스 대시보드. 종류(kind) 기준 탐색과 별도로, 네임스페이스 하나를
// 고르면 그 안의 workload/config/network/storage/access control/custom resource/helm/events 를
// 한 화면에서 본다. 실제 리소스 조회/스케일/재시작/삭제/YAML 편집은 전부 기존
// ResourceTablePanel/PodsPanel/HelmPanel(및 페이지 레벨 DetailDrawer/ConfirmDialog)을 그대로 재사용한다
// — 이 파일은 "네임스페이스로 먼저 좁히는" 레이아웃만 새로 만든다.
import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import * as Tabs from '@radix-ui/react-tabs';
import {
  Boxes, Settings as SettingsIcon, Network, Database, LayoutGrid, Rows3, ShieldCheck, Puzzle, Package, ScrollText, FileText,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { EmptyState, Skeleton } from '@/components/common';
import { NamespaceMultiSelect } from '@/components/k8s/NamespaceMultiSelect';
import { EventsStream } from '@/components/k8s/EventsStream';
import { k8sHelmApi, k8sResourcesApi } from '@/services/api';
import { ResourceTablePanel, PodsPanel, HelmPanel } from '@/pages/K8sManagePage';
import { NsClusterBindingsPanel, NsCrdObjectsPanel } from './NsExtraPanels';
import type {
  HelmRelease, K8sCrdInfo, K8sResourceCapability, K8sResourceRow, K8sPodRichRow, KindAvailabilityInfo,
} from '@/types';

type CatId = 'workload' | 'config' | 'network' | 'storage' | 'access' | 'custom' | 'helm' | 'events';
interface CatDef { id: CatId; label: string; icon: React.ComponentType<{ className?: string }>; chartVar: string; kinds: string[] }

// 종류별 목록 API 로 그리는 고정 종류. PV/StorageClass/ClusterRole 등 cluster-scoped 종류는 제외 —
// "이 네임스페이스 안" 이라는 전제와 맞지 않는다(단, 이 NS 를 subject 로 묶는 ClusterRoleBinding 은
// 이 NS 의 권한 셋업이라 Access Control 에 별도 키로 넣는다).
const CRB_KEY = '__clusterrolebindings';
const HELM_KEY = '__helm';
const crKey = (crd: K8sCrdInfo) => `cr:${crd.name}`;

const CATS: CatDef[] = [
  { id: 'workload', label: 'Workload', icon: Boxes, chartVar: '--chart-1', kinds: ['pods', 'deployments', 'statefulsets', 'daemonsets', 'replicasets', 'replicationcontrollers', 'jobs', 'cronjobs'] },
  { id: 'config', label: 'Config', icon: SettingsIcon, chartVar: '--chart-2', kinds: ['configmaps', 'secrets', 'resourcequotas', 'limitranges', 'horizontalpodautoscalers', 'poddisruptionbudgets', 'leases'] },
  { id: 'network', label: 'Network', icon: Network, chartVar: '--chart-3', kinds: ['services', 'endpoints', 'endpointslices', 'ingresses', 'networkpolicies'] },
  { id: 'storage', label: 'Storage', icon: Database, chartVar: '--chart-4', kinds: ['persistentvolumeclaims'] },
  { id: 'access', label: 'Access Control', icon: ShieldCheck, chartVar: '--chart-5', kinds: ['serviceaccounts', 'roles', 'rolebindings'] },
];
// 종류가 동적(CRD)이거나 목록 API 가 다른 카테고리 — 인벤토리 행은 별도 쿼리로 만든다.
const CUSTOM_CAT: CatDef = { id: 'custom', label: 'Custom Resources', icon: Puzzle, chartVar: '--chart-6', kinds: [] };
const HELM_CAT: CatDef = { id: 'helm', label: 'Helm', icon: Package, chartVar: '--chart-7', kinds: [] };
const EVENTS_CAT: CatDef = { id: 'events', label: 'Events', icon: ScrollText, chartVar: '--chart-8', kinds: [] };
const ALL_CATS: CatDef[] = [...CATS, CUSTOM_CAT, HELM_CAT, EVENTS_CAT];

const KIND_LABEL: Record<string, string> = {
  pods: 'Pods', deployments: 'Deployments', statefulsets: 'StatefulSets', daemonsets: 'DaemonSets',
  replicasets: 'ReplicaSets', replicationcontrollers: 'Replication Controllers', jobs: 'Jobs', cronjobs: 'CronJobs',
  configmaps: 'ConfigMaps', secrets: 'Secrets', resourcequotas: 'Resource Quotas', limitranges: 'Limit Ranges',
  horizontalpodautoscalers: 'HPA', poddisruptionbudgets: 'Pod Disruption Budgets', leases: 'Leases',
  services: 'Services', endpoints: 'Endpoints', endpointslices: 'Endpoint Slices', ingresses: 'Ingresses',
  networkpolicies: 'Network Policies', persistentvolumeclaims: 'Persistent Volume Claims',
  serviceaccounts: 'ServiceAccounts', roles: 'Roles', rolebindings: 'RoleBindings',
  [CRB_KEY]: 'ClusterRoleBindings (이 NS)', [HELM_KEY]: 'Helm 릴리스',
};

/** 이 NS 에 그 종류를 표시할지. kind-availability 의 `present`(클러스터 어디엔가 1개 이상 — 5분 캐시)는
 *  숨김 근거로 쓰지 않는다: 프로브 뒤에 생긴 리소스(예: 새 ResourceQuota)가 통째로 안 보이고, "0개"
 *  자체도 NS 셋업 정보다. API 미지원(`available=false`)만 숨긴다. */
function kindShown(kind: string, caps: Record<string, K8sResourceCapability>, avail?: Record<string, KindAvailabilityInfo>): boolean {
  return (caps[kind]?.namespaced ?? true) && avail?.[kind]?.available !== false;
}

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
  <span className={`tabular-nums ${n === 0 ? 'text-muted-foreground' : tone === 'ok' ? 'text-foreground font-medium' : tone === 'warn' ? 'text-status-warning font-semibold' : 'text-status-critical font-semibold'}`}>
    {n}
  </span>
);

function healthFromHelm(rows: HelmRelease[]): Health {
  let ok = 0, warn = 0, crit = 0;
  rows.forEach((r) => {
    const s = (r.status ?? '').toLowerCase();
    if (s === 'deployed') ok++; else if (s === 'failed') crit++; else warn++;
  });
  return { ok, warn, crit };
}

interface NamespaceDashboardPanelProps {
  clusterId: string;
  caps: Record<string, K8sResourceCapability>;
  avail?: Record<string, KindAvailabilityInfo>;
  onOpenDetail: (kind: string, row: K8sResourceRow | K8sPodRichRow, editable: boolean) => void;
  onScale: (kind: string, ns: string, name: string) => void;
  onRestart: (kind: string, ns: string, name: string) => void;
  onDelete: (kind: string, ns: string, name: string) => void;
  onTerminal: (ns: string, name: string) => void;
  onHelmValues: (r: HelmRelease) => void;
  onOpenCrdObject: (crd: K8sCrdInfo, row: K8sResourceRow) => void;
}

interface InvRow {
  cat: CatDef;
  key: string;
  label: string;
  count: number | null;   // null = 개수 모름(프로브 부분 결과)
  more?: boolean;         // 목록 상한(1000)에 걸려 잘림
  health: Health;
  isLoading?: boolean;
  isError?: boolean;
  note?: string;
}

const GRID = 'minmax(150px,1.6fr) 120px 70px 60px 60px 60px 1fr';

export function NamespaceDashboardPanel(p: NamespaceDashboardPanelProps) {
  const { clusterId, caps, avail, onOpenDetail, onScale, onRestart, onDelete, onTerminal, onHelmValues, onOpenCrdObject } = p;
  const [ns, setNs] = useState('');
  const nsSet = useMemo(() => new Set(ns ? [ns] : []), [ns]);
  const [mode, setMode] = useState<'tab' | 'list'>('tab');
  const [activeCat, setActiveCat] = useState<CatId>('workload');
  const [activeKind, setActiveKind] = useState<string | null>(null);
  const noopCordon = () => {};
  const noopDrain = () => {};
  const enabled = !!clusterId && !!ns;

  const flatKinds = useMemo(
    () => CATS.flatMap((cat) => cat.kinds.filter((kind) => kindShown(kind, caps, avail)).map((kind) => ({ cat, kind }))),
    [caps, avail],
  );
  // ClusterRoleBinding 은 cluster-scoped 라 kindShown(namespaced 조건)을 쓰지 않고 API 지원 여부만 본다.
  const showCrb = avail?.clusterrolebindings?.available !== false;

  const queries = useQueries({
    queries: flatKinds.map(({ kind }) => ({
      queryKey: ['k8s-mng-list', clusterId, kind, ns || 'none'],
      queryFn: async () => kind === 'pods'
        ? (await k8sResourcesApi.richPods(clusterId, ns)).data
        : (await k8sResourcesApi.list(clusterId, kind, ns)).data,
      enabled,
    })),
  });
  // 키는 각 패널(NsClusterBindingsPanel/HelmPanel)과 같아 인벤토리·상세 목록이 한 번만 조회한다.
  const crbQ = useQuery({
    queryKey: ['k8s-mng-ns-crb', clusterId, ns],
    queryFn: async () => (await k8sResourcesApi.nsClusterRoleBindings(clusterId, ns)).data,
    enabled: enabled && showCrb, retry: false,
  });
  const helmQ = useQuery({
    queryKey: ['k8s-mng-helm', clusterId, ns],
    queryFn: async () => (await k8sHelmApi.releases(clusterId, ns)).data,
    enabled, retry: false,
  });
  const crQ = useQuery({
    queryKey: ['k8s-mng-ns-cr', clusterId, ns],
    queryFn: async () => (await k8sResourcesApi.nsCustomResources(clusterId, ns)).data,
    enabled, retry: false,
  });
  const crItems = useMemo(() => crQ.data?.items ?? [], [crQ.data]);

  const inventory: InvRow[] = [
    ...flatKinds.map(({ cat, kind }, i): InvRow => {
      const q = queries[i];
      const data = q?.data as { items?: (K8sResourceRow | K8sPodRichRow)[]; count?: number; truncated?: boolean } | undefined;
      const items = data?.items ?? [];
      const count = kind === 'pods' ? items.length : (data?.count ?? 0);
      const health = !data ? null
        : kind === 'pods' ? healthFromPods(items as K8sPodRichRow[])
        : healthFromGenericRows(kind, items as K8sResourceRow[]);
      return { cat, key: kind, label: KIND_LABEL[kind] ?? kind, count, more: !!data?.truncated, health, isLoading: q?.isLoading, isError: q?.isError };
    }),
    ...(showCrb ? [{
      cat: CATS[4], key: CRB_KEY, label: KIND_LABEL[CRB_KEY], count: crbQ.data?.count ?? 0, health: null,
      isLoading: crbQ.isLoading, isError: crbQ.isError,
    } satisfies InvRow] : []),
    ...(crQ.isLoading || crQ.isError ? [{
      cat: CUSTOM_CAT, key: 'cr:__pending', label: 'Custom Resources', count: 0, health: null,
      isLoading: crQ.isLoading, isError: crQ.isError,
    } satisfies InvRow] : crItems.map((crd): InvRow => ({
      cat: CUSTOM_CAT, key: crKey(crd), label: crd.kind, count: crd.count, health: null, note: crd.group,
    }))),
    {
      cat: HELM_CAT, key: HELM_KEY, label: KIND_LABEL[HELM_KEY], count: helmQ.data?.items.length ?? 0,
      health: helmQ.data ? healthFromHelm(helmQ.data.items) : null, isLoading: helmQ.isLoading, isError: helmQ.isError,
    },
  ];
  const totalCount = inventory.reduce((s, r) => s + (r.count ?? 0), 0);
  const rowsOf = (catId: CatId) => inventory.filter((r) => r.cat.id === catId && r.key !== 'cr:__pending');

  const crNote = crQ.data && (crQ.data.errors > 0 || crQ.data.unknown > 0)
    ? `namespaced CRD ${crQ.data.checked}종 확인 — 권한 없음 등 ${crQ.data.errors}종 · 시간 초과 ${crQ.data.unknown}종은 확인하지 못했습니다.`
    : crQ.data ? `namespaced CRD ${crQ.data.checked}종 중 이 네임스페이스에 오브젝트가 있는 ${crQ.data.count}종` : '';

  const gotoKind = (catId: CatId, key: string) => {
    setActiveCat(catId); setActiveKind(key);
    const anchor = mode === 'tab' ? 'nsdash-detail' : `nsdash-kind-${key}`;
    requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const renderPanel = (key: string) => {
    if (key === CRB_KEY) {
      return (
        <NsClusterBindingsPanel clusterId={clusterId} ns={ns}
          onOpenDetail={(row) => onOpenDetail('clusterrolebindings', row, !!caps.clusterrolebindings?.editable)} />
      );
    }
    if (key === HELM_KEY) return <HelmPanel clusterId={clusterId} namespace={ns} onViewValues={onHelmValues} />;
    if (key.startsWith('cr:')) {
      const crd = crItems.find((c) => crKey(c) === key);
      return crd ? <NsCrdObjectsPanel clusterId={clusterId} ns={ns} crd={crd} onOpenObject={onOpenCrdObject} /> : null;
    }
    return (
      <KindPanel
        clusterId={clusterId} ns={ns} kind={key} caps={caps[key]}
        onOpenDetail={onOpenDetail} onScale={onScale} onRestart={onRestart} onDelete={onDelete} onTerminal={onTerminal}
        onCordon={noopCordon} onDrain={noopDrain}
      />
    );
  };

  const catBody = (cat: CatDef, keys: string[]) => {
    if (cat.id === 'events') return <EventsStream clusterId={clusterId} fixedNamespace={ns} />;
    if (cat.id === 'custom' && crQ.isLoading) return <MacCard title="Custom Resources"><Skeleton className="h-4 w-48" /></MacCard>;
    if (cat.id === 'custom' && crQ.isError) {
      return <div className="rounded-md border border-border px-4 py-3 text-sm text-status-critical">커스텀 리소스 조회 실패 — 새로고침하거나 CRD 화면에서 확인하세요.</div>;
    }
    if (keys.length === 0) {
      return <EmptyState compact icon={cat.icon} title={`이 네임스페이스에는 ${cat.label} 리소스가 없습니다`} description={cat.id === 'custom' ? crNote : undefined} />;
    }
    return null;
  };

  return (
    <div className="space-y-3">
      {/* 네임스페이스 선택 툴바 — 툴바만 감싸던 카드를 걷었다(§12.12-4) */}
      <div className="flex items-center gap-3 flex-wrap">
        <NamespaceMultiSelect
          clusterId={clusterId} selected={nsSet} singleSelect
          onChange={(next) => { setNs([...next][0] ?? ''); setActiveKind(null); }}
        />
        {ns && (
          <button type="button"
            onClick={() => onOpenDetail('namespaces', { name: ns, namespace: null, summary: '' }, !!caps.namespaces?.editable)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-secondary/60">
            <FileText className="w-3.5 h-3.5" /> 네임스페이스 상세·YAML
          </button>
        )}
        {ns && <span className="text-xs text-muted-foreground">종류 {inventory.length}개 · 리소스 {totalCount}개</span>}
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

      {!ns ? (
        <EmptyState title="네임스페이스를 선택하세요" description="위에서 네임스페이스를 고르면 그 안의 workload/config/network/storage/access control/custom resource/helm/events 가 한 화면에 모입니다." />
      ) : (() => {
        const inventoryCard = (
          <MacCard title="리소스 인벤토리" description="행 클릭 시 해당 종류의 상세 목록으로 이동 · 0개인 종류도 셋업 확인용으로 표시" bodyPadding="p-0">
            <div className="grid gap-2 px-4 py-1 text-xs font-semibold text-muted-foreground border-b border-border bg-secondary/30"
              style={{ gridTemplateColumns: GRID }}>
              <span>종류</span><span>구분</span><span className="text-right">개수</span>
              <span className="text-right">정상</span><span className="text-right">경고</span><span className="text-right">위험</span><span>비고</span>
            </div>
            {inventory.map(({ cat, key, label, count, more, health, isLoading, isError, note }) => (
              <button key={key} type="button" onClick={() => gotoKind(cat.id, key)}
                className={`w-full grid gap-2 px-4 py-1 text-sm border-b border-border/40 items-center text-left hover:bg-secondary/30 ${activeKind === key ? 'bg-secondary/40' : ''}`}
                style={{ gridTemplateColumns: GRID }}>
                <span className={`font-medium truncate ${!isLoading && !isError && count === 0 ? 'text-muted-foreground' : ''}`}>{label}</span>
                <span className="flex items-center gap-1.5 text-muted-foreground truncate">
                  <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: `hsl(var(${cat.chartVar}))` }} />
                  {cat.label}
                </span>
                {isLoading ? (
                  <span className="col-span-4"><Skeleton className="h-3 w-20" /></span>
                ) : isError ? (
                  <span className="col-span-4 text-xs text-status-critical">조회 실패</span>
                ) : (
                  <>
                    <span className={`text-right tabular-nums ${count === 0 ? 'text-muted-foreground' : ''}`}>{count == null ? '?' : `${count}${more ? '+' : ''}`}</span>
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
                      {health && count ? (health.crit > 0 ? `위험 ${health.crit}건 확인 필요` : health.warn > 0 ? `경고 ${health.warn}건` : '정상') : count === 0 ? '없음' : (note ?? '')}
                    </span>
                  </>
                )}
              </button>
            ))}
            {crNote && <div className="px-4 py-1.5 text-xs text-muted-foreground">{crNote}</div>}
          </MacCard>
        );

        return mode === 'tab' ? (
          <>
            <div id="nsdash-detail" />
            <Tabs.Root value={activeCat} onValueChange={(v) => { setActiveCat(v as CatId); setActiveKind(null); }}>
              <Tabs.List className="flex gap-1 mb-2 border-b border-border flex-wrap">
                {ALL_CATS.map((cat) => (
                  <Tabs.Trigger key={cat.id} value={cat.id}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary text-muted-foreground">
                    <cat.icon className="w-3.5 h-3.5" />{cat.label}
                  </Tabs.Trigger>
                ))}
              </Tabs.List>
              {ALL_CATS.map((cat) => {
                const rows = rowsOf(cat.id);
                const keys = rows.map((r) => r.key);
                const key = keys.includes(activeKind ?? '') ? (activeKind as string) : keys[0];
                const fallback = catBody(cat, keys);
                return (
                  <Tabs.Content key={cat.id} value={cat.id} className="space-y-2">
                    {fallback ?? (
                      <>
                        {rows.length > 1 && (
                          <div className="flex gap-1.5 flex-wrap">
                            {rows.map((r) => (
                              <button key={r.key} type="button" onClick={() => setActiveKind(r.key)}
                                className={`px-2.5 py-1 rounded-full text-xs font-medium border ${r.key === key ? 'bg-primary text-primary-foreground border-primary' : 'border-border text-muted-foreground hover:text-foreground'}`}>
                                {r.label} <span className="tabular-nums opacity-70">{r.count ?? '?'}</span>
                              </button>
                            ))}
                          </div>
                        )}
                        {key && renderPanel(key)}
                        {cat.id === 'custom' && crNote && <p className="text-xs text-muted-foreground">{crNote}</p>}
                      </>
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
              {ALL_CATS.map((cat) => {
                // 전체 나열형은 0개 종류의 빈 패널을 쌓지 않는다(0개는 위 인벤토리 표에 그대로 보인다).
                const keys = rowsOf(cat.id).filter((r) => r.count !== 0 || r.isLoading || r.isError).map((r) => r.key);
                const fallback = catBody(cat, keys);
                return (
                  // 카테고리는 구분 제목만 — 종류별 패널이 각자 MacCard 라 바깥 카드를 걷었다(카드 안 카드 금지).
                  <section key={cat.id} className="space-y-2">
                    <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                      <cat.icon className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />{cat.label}
                    </h3>
                    {fallback ?? keys.map((k) => (
                      <div key={k} id={`nsdash-kind-${k}`}>{renderPanel(k)}</div>
                    ))}
                  </section>
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
        search={search} setSearch={setSearch} hideNsSelector title={KIND_LABEL.pods ?? '파드'}
        onOpenDetail={(row) => onOpenDetail('pods', row, !!caps?.editable)}
        onDelete={onDelete} onTerminal={onTerminal}
      />
    );
  }
  return (
    <ResourceTablePanel
      clusterId={clusterId} kind={kind} caps={caps} selectedNs={selectedNs} setSelectedNs={setSelectedNs}
      search={search} setSearch={setSearch} hideNsSelector title={KIND_LABEL[kind] ?? kind}
      onOpenDetail={(row, editable) => onOpenDetail(kind, row, editable)}
      onScale={onScale} onRestart={onRestart} onDelete={onDelete}
      onCordon={onCordon} onDrain={onDrain} onTerminal={onTerminal}
    />
  );
}
