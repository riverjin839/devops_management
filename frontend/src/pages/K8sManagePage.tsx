import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Boxes, Server, Settings as SettingsIcon, Network, Database, Layers,
  ScrollText, Package, ShieldCheck, Puzzle, Trash2, RotateCw, Scaling, Terminal,
  FileCode, Pencil, Save, X, Search, RefreshCw, Ban, CheckCircle2, AlertTriangle,
} from 'lucide-react';
import { Virtuoso } from 'react-virtuoso';
import * as Tabs from '@radix-ui/react-tabs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AxiosError } from 'axios';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { LogViewer } from '@/components/common/LogViewer';
import { RoleGate } from '@/components/auth/RoleGate';
import { useClusters } from '@/hooks/useCluster';
import { k8sResourcesApi, k8sHelmApi } from '@/services/api';
import { PodTerminal } from '@/components/k8s/PodTerminal';
import { EventsStream } from '@/components/k8s/EventsStream';
import { NamespaceMultiSelect } from '@/components/k8s/NamespaceMultiSelect';
import { ColumnToggle } from '@/components/k8s/ColumnToggle';
import { useColumnPrefs } from '@/hooks/useColumnPrefs';
import type {
  K8sResourceRow, K8sResourceCapability, K8sCrdInfo, HelmRelease,
  K8sNodeRichRow, ResourceDetailSection, ResourceDetailKVItem,
  K8sPodRichRow, K8sCellColor, K8sRelatedEvent,
} from '@/types';

// 셀 색상 → Tailwind 클래스
const CELL_BG: Record<K8sCellColor, string> = {
  green: 'bg-status-healthy', amber: 'bg-status-warning', red: 'bg-status-critical', gray: 'bg-status-unknown',
};
const STATUS_TEXT: Record<K8sCellColor, string> = {
  green: 'text-status-healthy', amber: 'text-status-warning', red: 'text-status-critical', gray: 'text-status-unknown',
};
// 컨테이너 색칸 접근성 라벨 (D-024)
const CELL_LABEL: Record<K8sCellColor, string> = {
  green: '실행/정상', amber: '대기/준비안됨', red: '오류', gray: '종료/대기',
};

// ── Lens 식 카테고리 내비 모델 ────────────────────────────────────────────────
type LeafMode = 'kind' | 'overview' | 'events' | 'helm' | 'crd';
interface NavLeaf { id: string; label: string; mode: LeafMode; kind?: string }
interface NavCat { id: string; label: string; icon: React.ComponentType<{ className?: string }>; leaves: NavLeaf[] }

const NAV: NavCat[] = [
  { id: 'cluster', label: 'Cluster', icon: Layers, leaves: [{ id: 'overview', label: '개요', mode: 'overview' }] },
  { id: 'nodes', label: 'Nodes', icon: Server, leaves: [{ id: 'nodes', label: 'Nodes', mode: 'kind', kind: 'nodes' }] },
  {
    id: 'workloads', label: 'Workloads', icon: Boxes, leaves: [
      { id: 'pods', label: 'Pods', mode: 'kind', kind: 'pods' },
      { id: 'deployments', label: 'Deployments', mode: 'kind', kind: 'deployments' },
      { id: 'daemonsets', label: 'DaemonSets', mode: 'kind', kind: 'daemonsets' },
      { id: 'statefulsets', label: 'StatefulSets', mode: 'kind', kind: 'statefulsets' },
      { id: 'replicasets', label: 'ReplicaSets', mode: 'kind', kind: 'replicasets' },
      { id: 'replicationcontrollers', label: 'Replication Controllers', mode: 'kind', kind: 'replicationcontrollers' },
      { id: 'jobs', label: 'Jobs', mode: 'kind', kind: 'jobs' },
      { id: 'cronjobs', label: 'CronJobs', mode: 'kind', kind: 'cronjobs' },
    ],
  },
  {
    id: 'config', label: 'Config', icon: SettingsIcon, leaves: [
      { id: 'configmaps', label: 'ConfigMaps', mode: 'kind', kind: 'configmaps' },
      { id: 'secrets', label: 'Secrets', mode: 'kind', kind: 'secrets' },
      { id: 'resourcequotas', label: 'Resource Quotas', mode: 'kind', kind: 'resourcequotas' },
      { id: 'limitranges', label: 'Limit Ranges', mode: 'kind', kind: 'limitranges' },
      { id: 'horizontalpodautoscalers', label: 'HPA', mode: 'kind', kind: 'horizontalpodautoscalers' },
      { id: 'poddisruptionbudgets', label: 'Pod Disruption Budgets', mode: 'kind', kind: 'poddisruptionbudgets' },
      { id: 'priorityclasses', label: 'Priority Classes', mode: 'kind', kind: 'priorityclasses' },
      { id: 'runtimeclasses', label: 'Runtime Classes', mode: 'kind', kind: 'runtimeclasses' },
      { id: 'leases', label: 'Leases', mode: 'kind', kind: 'leases' },
      { id: 'mutatingwebhookconfigurations', label: 'Mutating Webhooks', mode: 'kind', kind: 'mutatingwebhookconfigurations' },
      { id: 'validatingwebhookconfigurations', label: 'Validating Webhooks', mode: 'kind', kind: 'validatingwebhookconfigurations' },
      { id: 'validatingadmissionpolicies', label: 'Validating Admission Policies', mode: 'kind', kind: 'validatingadmissionpolicies' },
      { id: 'validatingadmissionpolicybindings', label: 'VAP Bindings', mode: 'kind', kind: 'validatingadmissionpolicybindings' },
    ],
  },
  {
    id: 'network', label: 'Network', icon: Network, leaves: [
      { id: 'services', label: 'Services', mode: 'kind', kind: 'services' },
      { id: 'endpoints', label: 'Endpoints', mode: 'kind', kind: 'endpoints' },
      { id: 'endpointslices', label: 'Endpoint Slices', mode: 'kind', kind: 'endpointslices' },
      { id: 'ingresses', label: 'Ingresses', mode: 'kind', kind: 'ingresses' },
      { id: 'ingressclasses', label: 'Ingress Classes', mode: 'kind', kind: 'ingressclasses' },
      { id: 'networkpolicies', label: 'Network Policies', mode: 'kind', kind: 'networkpolicies' },
    ],
  },
  {
    id: 'storage', label: 'Storage', icon: Database, leaves: [
      { id: 'pvc', label: 'Persistent Volume Claims', mode: 'kind', kind: 'persistentvolumeclaims' },
      { id: 'persistentvolumes', label: 'Persistent Volumes', mode: 'kind', kind: 'persistentvolumes' },
      { id: 'storageclasses', label: 'Storage Classes', mode: 'kind', kind: 'storageclasses' },
    ],
  },
  { id: 'namespaces', label: 'Namespaces', icon: Layers, leaves: [{ id: 'namespaces', label: 'Namespaces', mode: 'kind', kind: 'namespaces' }] },
  { id: 'events', label: 'Events', icon: ScrollText, leaves: [{ id: 'events', label: 'Events', mode: 'events' }] },
  { id: 'helm', label: 'Helm', icon: Package, leaves: [{ id: 'helm', label: 'Releases', mode: 'helm' }] },
  {
    id: 'accesscontrol', label: 'Access Control', icon: ShieldCheck, leaves: [
      { id: 'serviceaccounts', label: 'ServiceAccounts', mode: 'kind', kind: 'serviceaccounts' },
      { id: 'roles', label: 'Roles', mode: 'kind', kind: 'roles' },
      { id: 'rolebindings', label: 'RoleBindings', mode: 'kind', kind: 'rolebindings' },
      { id: 'clusterroles', label: 'ClusterRoles', mode: 'kind', kind: 'clusterroles' },
      { id: 'clusterrolebindings', label: 'ClusterRoleBindings', mode: 'kind', kind: 'clusterrolebindings' },
    ],
  },
  { id: 'customresources', label: 'Custom Resources', icon: Puzzle, leaves: [{ id: 'crd', label: 'CRDs', mode: 'crd' }] },
];

const ALL_LEAVES = NAV.flatMap((c) => c.leaves);

function age(sec?: number | null): string {
  if (sec == null) return '-';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

function errMsg(e: unknown): string {
  const ax = e as AxiosError<{ detail?: string }>;
  return ax?.response?.data?.detail || (e as Error)?.message || '알 수 없는 오류';
}

interface DetailTarget {
  kind: 'k8s' | 'crd' | 'helmValues';
  resourceKind?: string;
  group?: string; version?: string; plural?: string;
  namespace: string;
  name: string;
  editable?: boolean;
}

export function K8sManagePage() {
  const { clusterId = '' } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: clusters = [] } = useClusters();

  useEffect(() => {
    if (!clusterId && clusters.length > 0) navigate(`/k8s-manage/${clusters[0].id}`, { replace: true });
  }, [clusterId, clusters, navigate]);

  const cluster = clusters.find((c) => c.id === clusterId);

  const [activeLeaf, setActiveLeaf] = useState('pods');
  const [selectedNs, setSelectedNs] = useState<Set<string>>(new Set()); // 비어있으면 전체
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [actionMsg, setActionMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [terminalPod, setTerminalPod] = useState<{ namespace: string; name: string } | null>(null);
  const [selectedCrd, setSelectedCrd] = useState<K8sCrdInfo | null>(null);

  const leaf = ALL_LEAVES.find((l) => l.id === activeLeaf) ?? ALL_LEAVES[0];

  // capabilities — kind 별 가능한 쓰기 동작
  const { data: capsData } = useQuery({
    queryKey: ['k8s-caps', clusterId],
    queryFn: async () => (await k8sResourcesApi.capabilities(clusterId)).data,
    enabled: !!clusterId,
    staleTime: 5 * 60_000,
  });
  const caps: Record<string, K8sResourceCapability> = capsData?.capabilities ?? {};

  // 종류 가용성 — 클러스터에 실제 존재하는 종류만 nav 노출 (없으면 전체 노출 폴백)
  const { data: availData } = useQuery({
    queryKey: ['k8s-avail', clusterId],
    queryFn: async () => (await k8sResourcesApi.kindAvailability(clusterId)).data,
    enabled: !!clusterId,
    staleTime: 60_000,
    retry: false,
  });
  const avail = availData?.kinds;
  const isLeafVisible = (lf: NavLeaf): boolean => {
    if (lf.mode !== 'kind' || !lf.kind) return true;       // overview/events/helm/crd 항상 노출
    if (!avail) return true;                                // 미로딩/에러 → 전체 노출 폴백
    return avail[lf.kind]?.present ?? false;                // 존재하는 종류만
  };
  const visibleCats = NAV
    .map((cat) => ({ ...cat, leaves: cat.leaves.filter(isLeafVisible) }))
    .filter((cat) => cat.leaves.length > 0);

  const flash = (kind: 'ok' | 'err', text: string) => {
    setActionMsg({ kind, text });
    window.setTimeout(() => setActionMsg(null), 4000);
  };

  const reloadList = () => {
    queryClient.invalidateQueries({ queryKey: ['k8s-mng-list', clusterId] });
  };

  // ── 쓰기 액션 핸들러 ────────────────────────────────────────────────────────
  const doScale = async (kind: string, ns: string, name: string) => {
    const input = window.prompt(`${name} — replicas 수를 입력하세요`, '1');
    if (input == null) return;
    const n = Number(input);
    if (!Number.isInteger(n) || n < 0) { flash('err', 'replicas 는 0 이상의 정수여야 합니다.'); return; }
    try {
      await k8sResourcesApi.scale(clusterId, kind, ns, name, n);
      flash('ok', `${name} → replicas ${n}`);
      reloadList();
    } catch (e) { flash('err', errMsg(e)); }
  };
  const doRestart = async (kind: string, ns: string, name: string) => {
    if (!window.confirm(`${name} 을(를) rollout restart 하시겠습니까?`)) return;
    try {
      await k8sResourcesApi.restart(clusterId, kind, ns, name);
      flash('ok', `${name} 재시작 트리거됨`);
      reloadList();
    } catch (e) { flash('err', errMsg(e)); }
  };
  const doDelete = async (kind: string, ns: string, name: string) => {
    if (!window.confirm(`정말 삭제하시겠습니까?\n${kind}/${ns}/${name}\n\n이 동작은 kubeconfig 신원으로 실행되며 되돌릴 수 없습니다.`)) return;
    try {
      await k8sResourcesApi.remove(clusterId, kind, ns, name);
      flash('ok', `${name} 삭제됨`);
      reloadList();
    } catch (e) { flash('err', errMsg(e)); }
  };
  const doCordon = async (name: string, unschedulable: boolean) => {
    try {
      await k8sResourcesApi.cordon(clusterId, name, unschedulable);
      flash('ok', `${name} ${unschedulable ? 'cordon' : 'uncordon'} 완료`);
      reloadList();
    } catch (e) { flash('err', errMsg(e)); }
  };
  const doDrain = async (name: string) => {
    if (!window.confirm(`${name} 을(를) drain 하시겠습니까?\ncordon 후 DaemonSet/mirror 를 제외한 파드를 eviction 합니다.`)) return;
    try {
      const res = await k8sResourcesApi.drain(clusterId, name);
      flash(res.data.ok ? 'ok' : 'err',
        `drain: evicted ${res.data.evicted.length} · skipped ${res.data.skipped.length} · errors ${res.data.errors.length}`);
      reloadList();
    } catch (e) { flash('err', errMsg(e)); }
  };
  const doApply = async () => {
    if (!detail || detail.kind !== 'k8s' || !detail.resourceKind) return;
    try {
      await k8sResourcesApi.apply(clusterId, detail.resourceKind, detail.namespace, detail.name, draft);
      flash('ok', `${detail.name} 적용됨`);
      setEditing(false);
      reloadList();
      queryClient.invalidateQueries({ queryKey: ['k8s-mng-yaml'] });
    } catch (e) { flash('err', errMsg(e)); }
  };

  const closeDetail = () => { setDetail(null); setEditing(false); setDraft(''); };

  return (
    <div className="min-h-screen bg-background py-3 pr-3">
      <div className="flex gap-3">
        {/* 클러스터 선택 레일 */}
        <div className="sticky top-4 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            onSelect={(id) => { if (id) navigate(`/k8s-manage/${id}`); }}
            iconOnly
          />
        </div>

        {/* Lens 식 카테고리 내비 */}
        <div className="sticky top-4 self-start w-52 flex-shrink-0">
          <MacCard title="K8S 상세 관리" bodyPadding="p-2">
            <nav className="space-y-2">
              {visibleCats.map((cat) => {
                const Icon = cat.icon;
                const single = cat.leaves.length === 1;
                if (single) {
                  const lf = cat.leaves[0];
                  const active = activeLeaf === lf.id;
                  return (
                    <button
                      key={cat.id}
                      onClick={() => { setActiveLeaf(lf.id); setSelectedCrd(null); }}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm font-medium ${active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary/60'}`}
                    >
                      <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                      <span className="truncate">{cat.label}</span>
                    </button>
                  );
                }
                return (
                  <div key={cat.id}>
                    <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                      <Icon className="w-3 h-3" /> {cat.label}
                    </div>
                    <div className="space-y-0.5">
                      {cat.leaves.map((lf) => {
                        const active = activeLeaf === lf.id;
                        const cnt = lf.kind ? avail?.[lf.kind]?.count : undefined;
                        const more = lf.kind ? avail?.[lf.kind]?.truncated : false;
                        return (
                          <button
                            key={lf.id}
                            onClick={() => { setActiveLeaf(lf.id); setSelectedCrd(null); }}
                            className={`w-full flex items-center gap-1 pl-7 pr-2 py-1 rounded-lg text-sm ${active ? 'bg-primary/15 text-primary font-semibold' : 'text-muted-foreground hover:bg-secondary/60'}`}
                          >
                            <span className="flex-1 text-left truncate">{lf.label}</span>
                            {cnt != null && (
                              <span className="text-[10px] tabular-nums rounded-full bg-secondary px-1.5 py-0.5 text-muted-foreground">{cnt}{more ? '+' : ''}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </nav>
          </MacCard>
        </div>

        {/* 본문 */}
        <div className="flex-1 min-w-0 space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <Link to="/cluster-overview" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted">
              <ArrowLeft className="w-3.5 h-3.5" /> 클러스터 현황
            </Link>
            <h1 className="text-lg font-semibold flex items-center gap-2">
              <Boxes className="w-4 h-4 text-primary" />
              {cluster ? cluster.name : '클러스터'} — {leaf.label}
            </h1>
            <RoleGate allow={['admin', 'operator']} fallback={
              <span className="text-xs rounded px-1.5 py-0.5 bg-muted text-muted-foreground">읽기 전용 (viewer)</span>
            }>
              <span className="text-xs rounded px-1.5 py-0.5 bg-status-healthy/15 text-status-healthy">쓰기 가능 (operator)</span>
            </RoleGate>
          </div>

          {actionMsg && (
            <div className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${actionMsg.kind === 'ok' ? 'bg-status-healthy/10 text-status-healthy' : 'bg-destructive/10 text-destructive'}`}>
              {actionMsg.kind === 'ok' ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
              {actionMsg.text}
            </div>
          )}

          {leaf.mode === 'kind' && leaf.kind === 'nodes' && (
            <NodesPanel
              clusterId={clusterId}
              onOpenDetail={(name) => { setDetail({ kind: 'k8s', resourceKind: 'nodes', namespace: '-', name, editable: false }); setEditing(false); }}
              onCordon={doCordon}
              onDrain={doDrain}
            />
          )}
          {leaf.mode === 'kind' && leaf.kind === 'pods' && (
            <PodsPanel
              clusterId={clusterId}
              caps={caps.pods}
              selectedNs={selectedNs}
              setSelectedNs={setSelectedNs}
              search={search}
              setSearch={setSearch}
              onOpenDetail={(row) => { setDetail({ kind: 'k8s', resourceKind: 'pods', namespace: row.namespace || '-', name: row.name, editable: !!caps.pods?.editable }); setEditing(false); }}
              onDelete={doDelete}
              onTerminal={(ns, name) => setTerminalPod({ namespace: ns, name })}
            />
          )}
          {leaf.mode === 'kind' && leaf.kind && leaf.kind !== 'nodes' && leaf.kind !== 'pods' && (
            <ResourceTablePanel
              clusterId={clusterId}
              kind={leaf.kind}
              caps={caps[leaf.kind]}
              selectedNs={selectedNs}
              setSelectedNs={setSelectedNs}
              search={search}
              setSearch={setSearch}
              onOpenDetail={(row, editable) => {
                setDetail({ kind: 'k8s', resourceKind: leaf.kind!, namespace: row.namespace || '-', name: row.name, editable });
                setEditing(false);
              }}
              onScale={doScale}
              onRestart={doRestart}
              onDelete={doDelete}
              onCordon={doCordon}
              onDrain={doDrain}
              onTerminal={(ns, name) => setTerminalPod({ namespace: ns, name })}
            />
          )}

          {leaf.mode === 'overview' && <OverviewPanel clusterId={clusterId} />}
          {leaf.mode === 'events' && (
            <MacCard title="이벤트 (실시간)">
              <EventsStream clusterId={clusterId} selectedNs={selectedNs} onSelectedNsChange={setSelectedNs} />
            </MacCard>
          )}
          {leaf.mode === 'helm' && (
            <HelmPanel clusterId={clusterId} onViewValues={(r) => setDetail({ kind: 'helmValues', namespace: r.namespace, name: r.name })} />
          )}
          {leaf.mode === 'crd' && (
            <CrdPanel
              clusterId={clusterId}
              selectedCrd={selectedCrd}
              setSelectedCrd={setSelectedCrd}
              onOpenObject={(crd, row) => setDetail({
                kind: 'crd', group: crd.group, version: crd.version, plural: crd.plural,
                namespace: row.namespace || '-', name: row.name,
              })}
            />
          )}
        </div>
      </div>

      {/* 상세 / YAML 드로어 */}
      {detail && (
        <DetailDrawer
          clusterId={clusterId}
          detail={detail}
          editing={editing}
          draft={draft}
          setDraft={setDraft}
          onStartEdit={(yamlText) => { setEditing(true); setDraft(yamlText); }}
          onCancelEdit={() => setEditing(false)}
          onApply={doApply}
          onClose={closeDetail}
        />
      )}

      {/* Pod 터미널 */}
      {terminalPod && (
        <PodTerminal
          clusterId={clusterId}
          namespace={terminalPod.namespace}
          pod={terminalPod.name}
          onClose={() => setTerminalPod(null)}
        />
      )}
    </div>
  );
}

// ── 리소스 테이블 패널 ────────────────────────────────────────────────────────
interface ResourceTablePanelProps {
  clusterId: string;
  kind: string;
  caps?: K8sResourceCapability;
  selectedNs: Set<string>;
  setSelectedNs: (s: Set<string>) => void;
  search: string;
  setSearch: (v: string) => void;
  onOpenDetail: (row: K8sResourceRow, editable: boolean) => void;
  onScale: (kind: string, ns: string, name: string) => void;
  onRestart: (kind: string, ns: string, name: string) => void;
  onDelete: (kind: string, ns: string, name: string) => void;
  onCordon: (name: string, unschedulable: boolean) => void;
  onDrain: (name: string) => void;
  onTerminal: (ns: string, name: string) => void;
}

function ResourceTablePanel(p: ResourceTablePanelProps) {
  const { clusterId, kind, caps, selectedNs, setSelectedNs, search, setSearch } = p;
  const isNamespaced = caps?.namespaced ?? true;
  // 단일 선택이면 서버에서 정확히 필터, 다중/전체면 전체 조회 후 클라이언트 필터
  const nsArr = useMemo(() => [...selectedNs], [selectedNs]);
  const serverNs = isNamespaced && nsArr.length === 1 ? nsArr[0] : undefined;

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['k8s-mng-list', clusterId, kind, serverNs ?? (nsArr.length > 1 ? 'multi' : 'all')],
    queryFn: async () => (await k8sResourcesApi.list(clusterId, kind, serverNs)).data,
    enabled: !!clusterId,
  });

  const filtered = useMemo(() => {
    let list = data?.items ?? [];
    if (isNamespaced && selectedNs.size > 1) list = list.filter((r) => r.namespace && selectedNs.has(r.namespace));
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => `${r.name} ${r.namespace ?? ''} ${r.summary} ${Object.values(r.cols ?? {}).join(' ')}`.toLowerCase().includes(q));
  }, [data, search, selectedNs, isNamespaced]);

  const allColumns = data?.columns ?? [];
  const { hidden, toggle } = useColumnPrefs(kind);
  const columns = allColumns.filter((c) => !hidden.has(c.key));
  const useSummary = allColumns.length === 0;
  const gridTemplate = [
    'minmax(160px,1.6fr)',
    isNamespaced ? '130px' : '',
    ...(useSummary ? ['minmax(120px,1.5fr)'] : columns.map(() => 'minmax(70px,1fr)')),
    '60px',
    '170px',
  ].filter(Boolean).join(' ');

  return (
    <MacCard title={kind} bodyPadding="p-0">
      <div className="flex items-center gap-2 flex-wrap px-3 py-2.5 border-b border-border">
        {isNamespaced && (
          <NamespaceMultiSelect clusterId={clusterId} selected={selectedNs} onChange={setSelectedNs} />
        )}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="이름/요약 검색"
            className="rounded-xl border border-border bg-card pl-7 pr-2 py-1 text-sm w-48 focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <ColumnToggle columns={allColumns} hidden={hidden} onToggle={toggle} />
          <button onClick={() => refetch()} title="새로고침" aria-label="새로고침" className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground">
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
      <div className="min-w-[760px]">
      <div className="grid gap-2 px-4 py-1.5 text-xs font-semibold text-muted-foreground border-b border-border bg-secondary/30" style={{ gridTemplateColumns: gridTemplate }}>
        <span>이름</span>
        {isNamespaced && <span>네임스페이스</span>}
        {useSummary ? <span>요약</span> : columns.map((c) => <span key={c.key} className="truncate">{c.label}</span>)}
        <span className="text-right">Age</span>
        <span className="text-right pr-2">동작</span>
      </div>

      {isLoading ? (
        <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>
      ) : isError ? (
        <div className="p-6 text-sm text-destructive">조회 실패: {errMsg(error)}</div>
      ) : filtered.length === 0 ? (
        <div className="p-10 text-center text-sm text-muted-foreground">표시할 리소스가 없습니다.</div>
      ) : (
        <Virtuoso
          style={{ height: '64vh' }}
          data={filtered}
          itemContent={(_i, r) => {
            const ns = r.namespace || '-';
            return (
              <div className="grid gap-2 px-4 py-1.5 text-sm border-b border-border/40 hover:bg-secondary/30 items-center" style={{ gridTemplateColumns: gridTemplate }}>
                <button onClick={() => p.onOpenDetail(r, !!caps?.editable)} className="truncate font-medium text-left hover:text-primary">{r.name}</button>
                {isNamespaced && <span className="truncate text-muted-foreground">{r.namespace ?? '-'}</span>}
                {useSummary ? (
                  <span className="truncate text-muted-foreground">{r.summary}</span>
                ) : (
                  columns.map((c) => (
                    <span key={c.key} className="truncate text-muted-foreground" title={r.cols?.[c.key] ?? ''}>{r.cols?.[c.key] ?? '-'}</span>
                  ))
                )}
                <span className="text-right text-muted-foreground tabular-nums">{age(r.ageSeconds)}</span>
                <div className="flex items-center justify-end gap-1">
                  <RoleGate allow={['admin', 'operator']}>
                    {caps?.scalable && (
                      <IconBtn title="scale" onClick={() => p.onScale(kind, ns, r.name)}><Scaling className="w-3.5 h-3.5" /></IconBtn>
                    )}
                    {caps?.restartable && (
                      <IconBtn title="restart" onClick={() => p.onRestart(kind, ns, r.name)}><RotateCw className="w-3.5 h-3.5" /></IconBtn>
                    )}
                    {caps?.editable && (
                      <IconBtn title="YAML 편집" onClick={() => p.onOpenDetail(r, true)}><Pencil className="w-3.5 h-3.5" /></IconBtn>
                    )}
                    {caps?.deletable && (
                      <IconBtn title="삭제" danger onClick={() => p.onDelete(kind, ns, r.name)}><Trash2 className="w-3.5 h-3.5" /></IconBtn>
                    )}
                  </RoleGate>
                </div>
              </div>
            );
          }}
        />
      )}
      </div>
      </div>
      <div className="px-4 py-1.5 text-xs text-muted-foreground border-t border-border">
        {filtered.length}개 표시{data?.truncated ? ' · 1000개 초과(잘림) — 네임스페이스 필터 권장' : ''} · 이름 클릭 시 상세/YAML
      </div>
    </MacCard>
  );
}

function IconBtn({ title, onClick, danger, children }: { title: string; onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`p-1 rounded-md ${danger ? 'text-destructive hover:bg-destructive/10' : 'text-muted-foreground hover:bg-secondary'}`}
    >
      {children}
    </button>
  );
}

// ── 개요 패널 ─────────────────────────────────────────────────────────────────
function OverviewPanel({ clusterId }: { clusterId: string }) {
  const nodes = useQuery({
    queryKey: ['k8s-mng-list', clusterId, 'nodes', ''],
    queryFn: async () => (await k8sResourcesApi.list(clusterId, 'nodes')).data,
    enabled: !!clusterId,
  });
  const namespaces = useQuery({
    queryKey: ['k8s-mng-list', clusterId, 'namespaces', ''],
    queryFn: async () => (await k8sResourcesApi.list(clusterId, 'namespaces')).data,
    enabled: !!clusterId,
  });
  const nodeItems = nodes.data?.items ?? [];
  const readyNodes = nodeItems.filter((n) => (n.summary || '').startsWith('Ready')).length;

  const Stat = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
    <MacCard title={label}>
      <div className="text-3xl font-bold tabular-nums">{value}</div>
      {sub && <div className="text-sm text-muted-foreground mt-1">{sub}</div>}
    </MacCard>
  );

  // 조회 실패 시 — "노드 0·상태 점검" 위장 대신 명시적 에러 배너
  if (nodes.isError || namespaces.isError) {
    return (
      <MacCard title="개요">
        <div className="flex items-center gap-2 p-4 text-sm text-destructive">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          조회 실패: {errMsg(nodes.error ?? namespaces.error)}
        </div>
      </MacCard>
    );
  }
  // 로딩 중 — 플레이스홀더
  if (nodes.isLoading || namespaces.isLoading) {
    return (
      <MacCard title="개요">
        <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>
      </MacCard>
    );
  }

  const healthy = readyNodes === nodeItems.length && nodeItems.length > 0;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <Stat label="노드" value={nodeItems.length} sub={`Ready ${readyNodes} / ${nodeItems.length}`} />
      <Stat label="네임스페이스" value={namespaces.data?.items.length ?? '-'} />
      <Stat label="상태" value={healthy ? 'Healthy' : '점검'} />
    </div>
  );
}

// ── Helm 패널 ─────────────────────────────────────────────────────────────────
function HelmPanel({ clusterId, onViewValues }: { clusterId: string; onViewValues: (r: HelmRelease) => void }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['k8s-mng-helm', clusterId],
    queryFn: async () => (await k8sHelmApi.releases(clusterId)).data,
    enabled: !!clusterId,
    retry: false,
  });
  return (
    <MacCard title="Helm Releases" bodyPadding="p-0">
      <div className="grid grid-cols-[1fr_140px_70px_1fr_90px] gap-2 px-4 py-1.5 text-xs font-semibold text-muted-foreground border-b border-border bg-secondary/30">
        <span>이름</span><span>네임스페이스</span><span>rev</span><span>차트</span><span className="text-right pr-2">values</span>
      </div>
      {isLoading ? (
        <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>
      ) : isError ? (
        <div className="p-6 text-sm text-destructive">조회 실패: {errMsg(error)}</div>
      ) : (data?.items.length ?? 0) === 0 ? (
        <div className="p-10 text-center text-sm text-muted-foreground">Helm 릴리스가 없습니다.</div>
      ) : (
        data!.items.map((r) => (
          <div key={`${r.namespace}/${r.name}`} className="grid grid-cols-[1fr_140px_70px_1fr_90px] gap-2 px-4 py-1.5 text-sm border-b border-border/40 items-center">
            <span className="truncate font-medium">{r.name}</span>
            <span className="truncate text-muted-foreground">{r.namespace}</span>
            <span className="text-muted-foreground">{r.revision}</span>
            <span className="truncate text-muted-foreground">{r.chart} {r.status ? `· ${r.status}` : ''}</span>
            <div className="text-right">
              <button onClick={() => onViewValues(r)} className="text-primary hover:underline">보기</button>
            </div>
          </div>
        ))
      )}
    </MacCard>
  );
}

// ── CRD 패널 ──────────────────────────────────────────────────────────────────
interface CrdPanelProps {
  clusterId: string;
  selectedCrd: K8sCrdInfo | null;
  setSelectedCrd: (c: K8sCrdInfo | null) => void;
  onOpenObject: (crd: K8sCrdInfo, row: K8sResourceRow) => void;
}
function CrdPanel({ clusterId, selectedCrd, setSelectedCrd, onOpenObject }: CrdPanelProps) {
  const crds = useQuery({
    queryKey: ['k8s-mng-crds', clusterId],
    queryFn: async () => (await k8sResourcesApi.crds(clusterId)).data,
    enabled: !!clusterId,
  });
  const objects = useQuery({
    queryKey: ['k8s-mng-crd-objs', clusterId, selectedCrd?.name],
    queryFn: async () => (await k8sResourcesApi.crdObjects(clusterId, selectedCrd!.group, selectedCrd!.version, selectedCrd!.plural)).data,
    enabled: !!clusterId && !!selectedCrd,
    retry: false,
  });

  if (selectedCrd) {
    // additionalPrinterColumns 기반 동적 컬럼 (kubectl 파리티) — 없으면 summary 폴백
    const dynCols = objects.data?.columns ?? [];
    const namespaced = selectedCrd.scope === 'Namespaced';
    const grid = {
      gridTemplateColumns: [
        'minmax(160px,1.4fr)',
        ...(namespaced ? ['minmax(120px,160px)'] : []),
        ...(dynCols.length > 0 ? dynCols.map(() => 'minmax(80px,1fr)') : ['1fr']),
        '60px',
      ].join(' '),
    };
    return (
      <MacCard title={`${selectedCrd.kind} (${selectedCrd.group})`} bodyPadding="p-0">
        <div className="px-4 py-2 border-b border-border">
          <button onClick={() => setSelectedCrd(null)} className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
            <ArrowLeft className="w-3.5 h-3.5" /> CRD 목록
          </button>
        </div>
        <div className="grid gap-2 px-4 py-1.5 text-xs font-semibold text-muted-foreground border-b border-border bg-secondary/30" style={grid}>
          <span>이름</span>
          {namespaced && <span>네임스페이스</span>}
          {dynCols.length > 0 ? dynCols.map((c) => <span key={c.key} className="truncate">{c.label}</span>) : <span>Summary</span>}
          <span className="text-right">Age</span>
        </div>
        {objects.isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>
        ) : objects.isError ? (
          <div className="p-6 text-sm text-destructive">조회 실패: {errMsg(objects.error)}</div>
        ) : (objects.data?.items.length ?? 0) === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">오브젝트가 없습니다.</div>
        ) : (
          objects.data!.items.map((r) => (
            <button key={`${r.namespace}/${r.name}`} onClick={() => onOpenObject(selectedCrd, r)}
              className="w-full grid gap-2 px-4 py-1.5 text-sm text-left border-b border-border/40 hover:bg-secondary/30 items-center" style={grid}>
              <span className="truncate font-medium">{r.name}</span>
              {namespaced && <span className="truncate text-muted-foreground">{r.namespace ?? '-'}</span>}
              {dynCols.length > 0
                ? dynCols.map((c) => (
                    <span key={c.key} className="truncate text-muted-foreground" title={r.cols?.[c.key] ?? ''}>{r.cols?.[c.key] ?? '-'}</span>
                  ))
                : <span className="truncate text-muted-foreground">{r.summary}</span>}
              <span className="text-right text-muted-foreground tabular-nums">{age(r.ageSeconds)}</span>
            </button>
          ))
        )}
      </MacCard>
    );
  }

  return (
    <MacCard title="Custom Resource Definitions" bodyPadding="p-0">
      <div className="grid grid-cols-[1fr_1fr_90px] gap-2 px-4 py-1.5 text-xs font-semibold text-muted-foreground border-b border-border bg-secondary/30">
        <span>Kind</span><span>Group</span><span>Scope</span>
      </div>
      {crds.isLoading ? (
        <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>
      ) : crds.isError ? (
        <div className="p-6 text-sm text-destructive">조회 실패: {errMsg(crds.error)}</div>
      ) : (crds.data?.items.length ?? 0) === 0 ? (
        <div className="p-10 text-center text-sm text-muted-foreground">CRD 가 없습니다.</div>
      ) : (
        crds.data!.items.map((c) => (
          <button key={c.name} onClick={() => setSelectedCrd(c)}
            className="w-full grid grid-cols-[1fr_1fr_90px] gap-2 px-4 py-1.5 text-sm text-left border-b border-border/40 hover:bg-secondary/30">
            <span className="truncate font-medium">{c.kind}</span>
            <span className="truncate text-muted-foreground">{c.group}</span>
            <span className="text-muted-foreground">{c.scope}</span>
          </button>
        ))
      )}
    </MacCard>
  );
}

// ── 상세 / YAML 드로어 ────────────────────────────────────────────────────────
interface DetailDrawerProps {
  clusterId: string;
  detail: DetailTarget;
  editing: boolean;
  draft: string;
  setDraft: (v: string) => void;
  onStartEdit: (yamlText: string) => void;
  onCancelEdit: () => void;
  onApply: () => void;
  onClose: () => void;
}
function DetailDrawer({ clusterId, detail, editing, draft, setDraft, onStartEdit, onCancelEdit, onApply, onClose }: DetailDrawerProps) {
  const yamlQuery = useQuery({
    queryKey: ['k8s-mng-yaml', clusterId, detail.kind, detail.resourceKind, detail.group, detail.plural, detail.namespace, detail.name],
    queryFn: async () => {
      if (detail.kind === 'helmValues') return (await k8sHelmApi.values(clusterId, detail.namespace, detail.name)).data;
      if (detail.kind === 'crd') return (await k8sResourcesApi.crdObjectYaml(clusterId, detail.group!, detail.version!, detail.plural!, detail.namespace, detail.name)).data;
      return (await k8sResourcesApi.yaml(clusterId, detail.resourceKind!, detail.namespace, detail.name)).data;
    },
  });
  const yamlText = yamlQuery.data?.yaml ?? '';
  const sections = (yamlQuery.data as { sections?: ResourceDetailSection[] } | undefined)?.sections;
  const hasSections = !!(sections && sections.length);
  const [tab, setTab] = useState<'summary' | 'yaml' | 'events'>('summary');

  // 관련 이벤트 (k8s 리소스만) — 탭 활성 시 15s 라이브 갱신 (Lens 파리티)
  const hasEvents = detail.kind === 'k8s';
  const eventsQuery = useQuery({
    queryKey: ['k8s-mng-obj-events', clusterId, detail.resourceKind, detail.namespace, detail.name],
    queryFn: async () => (await k8sResourcesApi.resourceEvents(clusterId, detail.resourceKind!, detail.namespace, detail.name)).data,
    enabled: hasEvents && tab === 'events',
    refetchInterval: 15_000,
  });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex justify-end" onClick={onClose}>
      <div className="bg-card w-full max-w-2xl h-full overflow-auto border-l border-border" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-card flex items-center gap-2 px-5 py-3 border-b border-border z-10">
          <FileCode className="w-4 h-4 text-primary" />
          <span className="font-semibold text-sm truncate">
            {detail.kind === 'helmValues' ? 'helm values' : detail.resourceKind || detail.plural}/{detail.namespace !== '-' ? `${detail.namespace}/` : ''}{detail.name}
          </span>
          {detail.editable && detail.kind === 'k8s' && !editing && (
            <RoleGate allow={['admin', 'operator']}>
              <button onClick={() => onStartEdit(yamlText)} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs hover:bg-secondary">
                <Pencil className="w-3 h-3" /> 편집
              </button>
            </RoleGate>
          )}
          {editing && (
            <div className="ml-auto flex items-center gap-1.5">
              <button onClick={onApply} className="inline-flex items-center gap-1 rounded-lg bg-primary text-primary-foreground px-2.5 py-1 text-xs">
                <Save className="w-3 h-3" /> 적용
              </button>
              <button onClick={onCancelEdit} className="rounded-lg border border-border px-2 py-1 text-xs hover:bg-secondary">취소</button>
            </div>
          )}
          <button onClick={onClose} className={`${editing || (detail.editable && detail.kind === 'k8s') ? '' : 'ml-auto'} text-muted-foreground hover:text-foreground`} aria-label="닫기">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4">
          {yamlQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">불러오는 중…</div>
          ) : yamlQuery.isError ? (
            <div className="text-sm text-destructive">조회 실패: {errMsg(yamlQuery.error)}</div>
          ) : (
            <Tabs.Root value={editing || (!hasSections && tab === 'summary') ? 'yaml' : tab} onValueChange={(v) => setTab(v as 'summary' | 'yaml' | 'events')}>
              <Tabs.List className="flex gap-1 mb-3 border-b border-border">
                {hasSections && (
                  <Tabs.Trigger value="summary" disabled={editing}
                    className="px-3 py-1.5 text-sm font-medium border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary text-muted-foreground disabled:opacity-40">
                    요약
                  </Tabs.Trigger>
                )}
                <Tabs.Trigger value="yaml"
                  className="px-3 py-1.5 text-sm font-medium border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary text-muted-foreground">
                  YAML
                </Tabs.Trigger>
                {hasEvents && (
                  <Tabs.Trigger value="events" disabled={editing}
                    className="px-3 py-1.5 text-sm font-medium border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary text-muted-foreground disabled:opacity-40">
                    이벤트
                  </Tabs.Trigger>
                )}
              </Tabs.List>
              {hasSections && (
                <Tabs.Content value="summary">
                  <SectionsView sections={sections!} />
                </Tabs.Content>
              )}
              {hasEvents && (
                <Tabs.Content value="events">
                  <RelatedEventsView
                    loading={eventsQuery.isLoading}
                    error={eventsQuery.isError ? errMsg(eventsQuery.error) : null}
                    items={eventsQuery.data?.items ?? []}
                  />
                </Tabs.Content>
              )}
              <Tabs.Content value="yaml">
                {editing ? (
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    spellCheck={false}
                    className="w-full h-[78vh] font-mono text-sm rounded-xl border border-border bg-background p-3 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                ) : (
                  <LogViewer text={yamlText} maxHeight="max-h-[80vh]" />
                )}
              </Tabs.Content>
            </Tabs.Root>
          )}
        </div>
      </div>
    </div>
  );
}

// ── 관련 이벤트 탭 (Lens 상세 드로어 파리티) ──────────────────────────────────
function RelatedEventsView({ loading, error, items }: { loading: boolean; error: string | null; items: K8sRelatedEvent[] }) {
  const rel = (iso?: string | null) => {
    if (!iso) return '-';
    const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    return `${age(sec)} 전`;
  };
  if (loading) return <div className="text-sm text-muted-foreground">이벤트 불러오는 중…</div>;
  if (error) return <div className="text-sm text-destructive">이벤트 조회 실패: {error}</div>;
  if (items.length === 0) return <div className="text-sm text-muted-foreground p-6 text-center">관련 이벤트 없음</div>;
  return (
    <div className="space-y-2 max-h-[80vh] overflow-auto pr-1">
      {items.map((ev, i) => (
        <div
          key={i}
          className={`rounded-xl border p-3 text-sm ${ev.type === 'Warning' ? 'border-status-warning/50 bg-status-warning/5' : 'border-border'}`}
        >
          <div className="flex items-center gap-2 mb-1">
            {ev.type === 'Warning'
              ? <AlertTriangle className="w-3.5 h-3.5 text-status-warning shrink-0" />
              : <CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
            <span className="font-medium truncate">{ev.reason ?? '-'}</span>
            {(ev.count ?? 0) > 1 && <span className="text-xs text-muted-foreground">×{ev.count}</span>}
            <span className="ml-auto text-xs text-muted-foreground tabular-nums shrink-0" title={ev.lastTimestamp ?? ''}>
              {rel(ev.lastTimestamp)}
            </span>
          </div>
          <p className="text-muted-foreground break-all whitespace-pre-wrap m-0">{ev.message ?? ''}</p>
          {ev.source && <p className="mt-1 text-xs text-muted-foreground/70 m-0">source: {ev.source}</p>}
        </div>
      ))}
    </div>
  );
}

// ── 구조화 상세(요약) 렌더 ────────────────────────────────────────────────────
function SectionsView({ sections }: { sections: ResourceDetailSection[] }) {
  return (
    <div className="space-y-4 max-h-[80vh] overflow-auto pr-1">
      {sections.map((s, i) => (
        <div key={i} className="rounded-xl border border-border overflow-hidden">
          <div className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground bg-secondary/40 border-b border-border">
            {s.title}
          </div>
          <div className="p-3 text-sm">
            {s.type === 'text' && <span className="text-muted-foreground">{s.text}</span>}
            {s.type === 'list' && (
              <ul className="space-y-1">
                {(s.items as string[] | undefined)?.map((it, j) => (
                  <li key={j} className="font-mono break-all text-muted-foreground">• {it}</li>
                ))}
              </ul>
            )}
            {s.type === 'kv' && (
              <div className="space-y-1.5">
                {(s.items as ResourceDetailKVItem[] | undefined)?.map((it, j) => (
                  <div key={j} className="grid grid-cols-[160px_1fr] gap-2">
                    <span className="font-medium text-muted-foreground truncate" title={it.k}>{it.k}</span>
                    <pre className="font-mono whitespace-pre-wrap break-all text-foreground/90 m-0">{it.v}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Nodes 패널 (Lens 식 컬럼) ─────────────────────────────────────────────────
interface NodesPanelProps {
  clusterId: string;
  onOpenDetail: (name: string) => void;
  onCordon: (name: string, unschedulable: boolean) => void;
  onDrain: (name: string) => void;
}
function NodesPanel({ clusterId, onOpenDetail, onCordon, onDrain }: NodesPanelProps) {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['k8s-mng-nodes', clusterId],
    queryFn: async () => (await k8sResourcesApi.richNodes(clusterId)).data,
    enabled: !!clusterId,
  });
  const rows: K8sNodeRichRow[] = data?.items ?? [];

  const NODES_TOGGLE_COLS: { key: string; label: string; width: string }[] = [
    { key: 'roles', label: 'Roles', width: 'minmax(80px,1fr)' },
    { key: 'version', label: 'Version', width: '90px' },
    { key: 'taints', label: 'Taints', width: '60px' },
    { key: 'cpu', label: 'CPU', width: 'minmax(80px,1fr)' },
    { key: 'memory', label: 'Memory', width: 'minmax(80px,1fr)' },
    { key: 'age', label: 'Age', width: '60px' },
  ];
  const { hidden, toggle, isHidden } = useColumnPrefs('nodes');
  const visibleCols = NODES_TOGGLE_COLS.filter((c) => !hidden.has(c.key));
  const gridStyle = {
    gridTemplateColumns: ['minmax(160px,1.4fr)', ...visibleCols.map((c) => c.width), '160px'].join(' '),
  };

  return (
    <MacCard title="Nodes" bodyPadding="p-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="text-sm text-muted-foreground">{rows.length} nodes{data && !data.metricsAvailable ? ' · metrics-server 없음(usage 생략)' : ''}</span>
        <div className="ml-auto flex items-center gap-1">
          <ColumnToggle columns={NODES_TOGGLE_COLS} hidden={hidden} onToggle={toggle} />
          <button onClick={() => refetch()} title="새로고침" aria-label="새로고침" className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground">
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
      <div className="min-w-[720px]">
      <div className="grid gap-2 px-4 py-1.5 text-xs font-semibold text-muted-foreground border-b border-border bg-secondary/30" style={gridStyle}>
        <span>이름</span>
        {visibleCols.map((c) => <span key={c.key} className={c.key === 'age' ? 'text-right' : ''}>{c.label}</span>)}
        <span className="text-right pr-2">동작</span>
      </div>
      {isLoading ? (
        <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>
      ) : isError ? (
        <div className="p-6 text-sm text-destructive">조회 실패: {errMsg(error)}</div>
      ) : rows.length === 0 ? (
        <div className="p-10 text-center text-sm text-muted-foreground">노드가 없습니다.</div>
      ) : (
        rows.map((n) => {
          const ready = n.conditions.includes('Ready');
          const warn = n.conditions.filter((c) => c !== 'Ready');
          return (
            <div key={n.name} className="grid gap-2 px-4 py-1.5 text-sm border-b border-border/40 hover:bg-secondary/30 items-center" style={gridStyle}>
              <button onClick={() => onOpenDetail(n.name)} className="truncate font-medium text-left hover:text-primary flex items-center gap-1.5">
                {ready
                  ? <CheckCircle2 className="w-3.5 h-3.5 text-status-healthy flex-shrink-0" aria-label="Ready" />
                  : <AlertTriangle className="w-3.5 h-3.5 text-status-critical flex-shrink-0" aria-label="NotReady" />}
                <span className="truncate">{n.name}</span>
                {n.unschedulable && <span className="text-[10px] rounded px-1 bg-status-warning/15 text-status-warning">cordoned</span>}
              </button>
              {!isHidden('roles') && <span className="truncate text-muted-foreground">{n.roles.join(', ')}</span>}
              {!isHidden('version') && <span className="truncate text-muted-foreground">{n.version ?? '-'}</span>}
              {!isHidden('taints') && <span className="text-muted-foreground tabular-nums">{n.taints}</span>}
              {!isHidden('cpu') && <span className="truncate text-muted-foreground">{n.cpuUsage ? `${n.cpuUsage} / ` : ''}{n.cpuCapacity ?? '-'}</span>}
              {!isHidden('memory') && <span className="truncate text-muted-foreground">{n.memUsage ? `${n.memUsage} / ` : ''}{n.memCapacity ?? '-'}</span>}
              {!isHidden('age') && <span className="text-right text-muted-foreground tabular-nums">{age(n.ageSeconds)}</span>}
              <div className="flex items-center justify-end gap-1">
                {warn.length > 0 && <span className="text-[10px] text-status-warning mr-1" title={warn.join(',')}>{warn.length}⚠</span>}
                <RoleGate allow={['admin', 'operator']}>
                  <IconBtn title={n.unschedulable ? 'uncordon' : 'cordon'} onClick={() => onCordon(n.name, !n.unschedulable)}>
                    {n.unschedulable ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}
                  </IconBtn>
                  <IconBtn title="drain" onClick={() => onDrain(n.name)}><Scaling className="w-3.5 h-3.5" /></IconBtn>
                </RoleGate>
              </div>
            </div>
          );
        })
      )}
      </div>
      </div>
    </MacCard>
  );
}

// ── Pods 패널 (Lens 식 컬럼 + 색표현) ─────────────────────────────────────────
interface PodsPanelProps {
  clusterId: string;
  caps?: K8sResourceCapability;
  selectedNs: Set<string>;
  setSelectedNs: (s: Set<string>) => void;
  search: string;
  setSearch: (v: string) => void;
  onOpenDetail: (row: K8sPodRichRow) => void;
  onDelete: (kind: string, ns: string, name: string) => void;
  onTerminal: (ns: string, name: string) => void;
}
function PodsPanel(p: PodsPanelProps) {
  const { clusterId, selectedNs, setSelectedNs, search, setSearch } = p;
  const navigate = useNavigate();
  const nsArr = useMemo(() => [...selectedNs], [selectedNs]);
  const serverNs = nsArr.length === 1 ? nsArr[0] : undefined;
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['k8s-mng-list', clusterId, 'pods', serverNs ?? (nsArr.length > 1 ? 'multi' : 'all')],
    queryFn: async () => (await k8sResourcesApi.richPods(clusterId, serverNs)).data,
    enabled: !!clusterId,
  });
  const filtered = useMemo(() => {
    let list = data?.items ?? [];
    if (selectedNs.size > 1) list = list.filter((r) => r.namespace && selectedNs.has(r.namespace));
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => `${r.name} ${r.namespace ?? ''} ${r.phase} ${r.node ?? ''} ${r.controlledBy ?? ''}`.toLowerCase().includes(q));
  }, [data, search, selectedNs]);

  // 토글 가능 컬럼 (이름/상태/동작은 항상 표시)
  const PODS_TOGGLE_COLS: { key: string; label: string; width: string }[] = [
    { key: 'namespace', label: '네임스페이스', width: '110px' },
    { key: 'containers', label: '컨테이너', width: '90px' },
    { key: 'restarts', label: '재시작', width: '56px' },
    { key: 'cpu', label: 'CPU', width: '64px' },
    { key: 'mem', label: 'MEM', width: '70px' },
    { key: 'controlledBy', label: 'Controlled By', width: 'minmax(80px,1fr)' },
    { key: 'node', label: '노드', width: '110px' },
    { key: 'qos', label: 'QoS', width: '72px' },
    { key: 'age', label: 'Age', width: '50px' },
  ];
  const { hidden, toggle, isHidden } = useColumnPrefs('pods');
  const visibleCols = PODS_TOGGLE_COLS.filter((c) => !hidden.has(c.key));
  const gridStyle = {
    gridTemplateColumns: ['minmax(160px,1.6fr)', ...visibleCols.map((c) => c.width), '110px', '110px'].join(' '),
  };

  return (
    <MacCard title="Pods" bodyPadding="p-0">
      <div className="flex items-center gap-2 flex-wrap px-3 py-2.5 border-b border-border">
        <NamespaceMultiSelect clusterId={clusterId} selected={selectedNs} onChange={setSelectedNs} />
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="이름/노드/소유자 검색"
            className="rounded-xl border border-border bg-card pl-7 pr-2 py-1 text-sm w-52 focus:outline-none focus:ring-1 focus:ring-primary" />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <ColumnToggle columns={PODS_TOGGLE_COLS} hidden={hidden} onToggle={toggle} />
          <button onClick={() => refetch()} title="새로고침" aria-label="새로고침" className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground">
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
      <div className="min-w-[900px]">
      <div className="grid gap-2 px-4 py-1.5 text-xs font-semibold text-muted-foreground border-b border-border bg-secondary/30" style={gridStyle}>
        <span>이름</span>
        {visibleCols.map((c) => <span key={c.key} className={c.key === 'age' ? 'text-right' : ''}>{c.label}</span>)}
        <span>상태</span><span className="text-right pr-2">동작</span>
      </div>
      {isLoading ? (
        <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>
      ) : isError ? (
        <div className="p-6 text-sm text-destructive">조회 실패: {errMsg(error)}</div>
      ) : filtered.length === 0 ? (
        <div className="p-10 text-center text-sm text-muted-foreground">표시할 파드가 없습니다.</div>
      ) : (
        <Virtuoso
          style={{ height: '64vh' }}
          data={filtered}
          itemContent={(_i, r) => {
            const ns = r.namespace || '-';
            return (
              <div className="grid gap-2 px-4 py-1.5 text-sm border-b border-border/40 hover:bg-secondary/30 items-center" style={gridStyle}>
                <button onClick={() => p.onOpenDetail(r)} className="truncate font-medium text-left hover:text-primary">{r.name}</button>
                {!isHidden('namespace') && <span className="truncate text-muted-foreground">{r.namespace ?? '-'}</span>}
                {!isHidden('containers') && (
                  <span className="flex items-center gap-0.5" title={r.containers.map((c) => `${c.name}: ${c.state}${c.reason ? ` (${c.reason})` : ''}`).join('\n')}>
                    {r.containers.slice(0, 12).map((c, j) => (
                      <span
                        key={j}
                        role="img"
                        aria-label={`${c.name}: ${CELL_LABEL[c.color]}${c.reason ? ` (${c.reason})` : ''}`}
                        className={`w-2.5 h-2.5 rounded-sm ${CELL_BG[c.color]}`}
                      />
                    ))}
                    <span className="ml-1 text-xs text-muted-foreground tabular-nums">{r.ready}</span>
                  </span>
                )}
                {!isHidden('restarts') && <span className={`tabular-nums ${r.restarts > 0 ? 'text-status-warning font-medium' : 'text-muted-foreground'}`}>{r.restarts}</span>}
                {!isHidden('cpu') && <span className="truncate text-muted-foreground tabular-nums">{r.cpuUsage ?? '-'}</span>}
                {!isHidden('mem') && <span className="truncate text-muted-foreground tabular-nums">{r.memUsage ?? '-'}</span>}
                {!isHidden('controlledBy') && <span className="truncate text-muted-foreground" title={r.controlledBy ?? ''}>{r.controlledBy ?? '-'}</span>}
                {!isHidden('node') && <span className="truncate text-muted-foreground" title={r.node ?? ''}>{r.node ?? '-'}</span>}
                {!isHidden('qos') && <span className="truncate text-muted-foreground">{r.qos ?? '-'}</span>}
                {!isHidden('age') && <span className="text-right text-muted-foreground tabular-nums">{age(r.ageSeconds)}</span>}
                <span className={`truncate font-medium ${STATUS_TEXT[r.statusColor]}`} title={r.phase}>
                  <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${CELL_BG[r.statusColor]}`} />{r.phase}
                </span>
                <div className="flex items-center justify-end gap-1">
                  {(r.warningCount ?? 0) > 0 && (
                    <span title={`Warning 이벤트 ${r.warningCount}건${r.warningReason ? ` · 최신: ${r.warningReason}` : ''}`}>
                      <AlertTriangle className="w-3.5 h-3.5 text-status-warning" />
                    </span>
                  )}
                  <IconBtn
                    title="로그"
                    onClick={() => navigate(`/k8s-logs/${clusterId}?namespace=${encodeURIComponent(ns)}&pod=${encodeURIComponent(r.name)}`)}
                  >
                    <ScrollText className="w-3.5 h-3.5" />
                  </IconBtn>
                  <RoleGate allow={['admin', 'operator']}>
                    <IconBtn title="터미널" onClick={() => p.onTerminal(ns, r.name)}><Terminal className="w-3.5 h-3.5" /></IconBtn>
                    {p.caps?.deletable && (
                      <IconBtn title="삭제" danger onClick={() => p.onDelete('pods', ns, r.name)}><Trash2 className="w-3.5 h-3.5" /></IconBtn>
                    )}
                  </RoleGate>
                </div>
              </div>
            );
          }}
        />
      )}
      </div>
      </div>
      <div className="px-4 py-1.5 text-xs text-muted-foreground border-t border-border">
        {filtered.length}개 표시{data?.truncated ? ' · 1000개 초과(잘림) — 네임스페이스 필터 권장' : ''}
        {data && data.metricsAvailable === false ? ' · metrics-server 없음(CPU/MEM 생략)' : ''} · 컨테이너 색칸: 초록=실행/정상, 노랑=대기/준비안됨, 빨강=오류, 회색=종료/대기
      </div>
    </MacCard>
  );
}
