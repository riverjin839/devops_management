import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Boxes, Server, Settings as SettingsIcon, Network, Database, Layers,
  ScrollText, Package, ShieldCheck, Puzzle, Trash2, RotateCw, Scaling, Terminal,
  FileCode, Pencil, Save, X, Search, RefreshCw, Ban, CheckCircle2, AlertTriangle,
} from 'lucide-react';
import { Virtuoso } from 'react-virtuoso';
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
import type {
  K8sResourceRow, K8sResourceCapability, K8sCrdInfo, HelmRelease,
} from '@/types';

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
      { id: 'statefulsets', label: 'StatefulSets', mode: 'kind', kind: 'statefulsets' },
      { id: 'daemonsets', label: 'DaemonSets', mode: 'kind', kind: 'daemonsets' },
      { id: 'jobs', label: 'Jobs', mode: 'kind', kind: 'jobs' },
      { id: 'cronjobs', label: 'CronJobs', mode: 'kind', kind: 'cronjobs' },
    ],
  },
  {
    id: 'config', label: 'Config', icon: SettingsIcon, leaves: [
      { id: 'configmaps', label: 'ConfigMaps', mode: 'kind', kind: 'configmaps' },
      { id: 'secrets', label: 'Secrets', mode: 'kind', kind: 'secrets' },
    ],
  },
  {
    id: 'network', label: 'Network', icon: Network, leaves: [
      { id: 'services', label: 'Services', mode: 'kind', kind: 'services' },
      { id: 'ingresses', label: 'Ingresses', mode: 'kind', kind: 'ingresses' },
    ],
  },
  { id: 'storage', label: 'Storage', icon: Database, leaves: [{ id: 'pvc', label: 'PersistentVolumeClaims', mode: 'kind', kind: 'persistentvolumeclaims' }] },
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
  const [nsFilter, setNsFilter] = useState('');
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
    <div className="min-h-screen bg-background p-5">
      <div className="flex gap-3 max-w-[1700px] mx-auto">
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
              {NAV.map((cat) => {
                const Icon = cat.icon;
                const single = cat.leaves.length === 1;
                if (single) {
                  const lf = cat.leaves[0];
                  const active = activeLeaf === lf.id;
                  return (
                    <button
                      key={cat.id}
                      onClick={() => { setActiveLeaf(lf.id); setSelectedCrd(null); }}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs font-medium ${active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary/60'}`}
                    >
                      <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                      <span className="truncate">{cat.label}</span>
                    </button>
                  );
                }
                return (
                  <div key={cat.id}>
                    <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                      <Icon className="w-3 h-3" /> {cat.label}
                    </div>
                    <div className="space-y-0.5">
                      {cat.leaves.map((lf) => {
                        const active = activeLeaf === lf.id;
                        return (
                          <button
                            key={lf.id}
                            onClick={() => { setActiveLeaf(lf.id); setSelectedCrd(null); }}
                            className={`w-full text-left pl-7 pr-2 py-1 rounded-lg text-xs ${active ? 'bg-primary/15 text-primary font-semibold' : 'text-muted-foreground hover:bg-secondary/60'}`}
                          >
                            {lf.label}
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
            <Link to="/cluster-overview" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted">
              <ArrowLeft className="w-3.5 h-3.5" /> 클러스터 현황
            </Link>
            <h1 className="text-lg font-semibold flex items-center gap-2">
              <Boxes className="w-4 h-4 text-primary" />
              {cluster ? cluster.name : '클러스터'} — {leaf.label}
            </h1>
            <RoleGate allow={['admin', 'operator']} fallback={
              <span className="text-[10px] rounded px-1.5 py-0.5 bg-muted text-muted-foreground">읽기 전용 (viewer)</span>
            }>
              <span className="text-[10px] rounded px-1.5 py-0.5 bg-green-500/15 text-green-600">쓰기 가능 (operator)</span>
            </RoleGate>
          </div>

          {actionMsg && (
            <div className={`flex items-center gap-2 rounded-xl px-3 py-2 text-xs ${actionMsg.kind === 'ok' ? 'bg-green-500/10 text-green-700' : 'bg-red-500/10 text-red-600'}`}>
              {actionMsg.kind === 'ok' ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
              {actionMsg.text}
            </div>
          )}

          {leaf.mode === 'kind' && leaf.kind && (
            <ResourceTablePanel
              clusterId={clusterId}
              kind={leaf.kind}
              caps={caps[leaf.kind]}
              nsFilter={nsFilter}
              setNsFilter={setNsFilter}
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
              <div className="mb-3">
                <input
                  value={nsFilter}
                  onChange={(e) => setNsFilter(e.target.value)}
                  placeholder="네임스페이스 필터 (비우면 전체)"
                  className="rounded-xl border border-border bg-card px-3 py-1.5 text-xs w-64 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <EventsStream clusterId={clusterId} namespace={nsFilter.trim() || undefined} />
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
  nsFilter: string;
  setNsFilter: (v: string) => void;
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
  const { clusterId, kind, caps, nsFilter, setNsFilter, search, setSearch } = p;
  const isNamespaced = caps?.namespaced ?? true;

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['k8s-mng-list', clusterId, kind, nsFilter],
    queryFn: async () => (await k8sResourcesApi.list(clusterId, kind, isNamespaced ? (nsFilter.trim() || undefined) : undefined)).data,
    enabled: !!clusterId,
  });

  const filtered = useMemo(() => {
    const list = data?.items ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => `${r.name} ${r.namespace ?? ''} ${r.summary}`.toLowerCase().includes(q));
  }, [data, search]);

  return (
    <MacCard title={kind} bodyPadding="p-0">
      <div className="flex items-center gap-2 flex-wrap px-3 py-2.5 border-b border-border">
        {isNamespaced && (
          <input
            value={nsFilter}
            onChange={(e) => setNsFilter(e.target.value)}
            placeholder="네임스페이스"
            className="rounded-xl border border-border bg-card px-2.5 py-1 text-xs w-40 focus:outline-none focus:ring-1 focus:ring-primary"
          />
        )}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="이름/요약 검색"
            className="rounded-xl border border-border bg-card pl-7 pr-2 py-1 text-xs w-48 focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <button onClick={() => refetch()} title="새로고침" className="ml-auto p-1.5 rounded-lg hover:bg-secondary text-muted-foreground">
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="grid grid-cols-[1fr_140px_1fr_60px_220px] gap-2 px-4 py-1.5 text-[10px] font-semibold text-muted-foreground border-b border-border bg-secondary/30">
        <span>이름</span><span>네임스페이스</span><span>요약</span><span className="text-right">Age</span><span className="text-right pr-2">동작</span>
      </div>

      {isLoading ? (
        <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>
      ) : isError ? (
        <div className="p-6 text-sm text-red-500">조회 실패: {errMsg(error)}</div>
      ) : filtered.length === 0 ? (
        <div className="p-10 text-center text-sm text-muted-foreground">표시할 리소스가 없습니다.</div>
      ) : (
        <Virtuoso
          style={{ height: '64vh' }}
          data={filtered}
          itemContent={(_i, r) => {
            const ns = r.namespace || '-';
            const cordoned = (r.summary || '').includes('SchedulingDisabled');
            return (
              <div className="grid grid-cols-[1fr_140px_1fr_60px_220px] gap-2 px-4 py-1.5 text-xs border-b border-border/40 hover:bg-secondary/30 items-center">
                <button onClick={() => p.onOpenDetail(r, !!caps?.editable)} className="truncate font-medium text-left hover:text-primary">{r.name}</button>
                <span className="truncate text-muted-foreground">{r.namespace ?? '-'}</span>
                <span className="truncate text-muted-foreground">{r.summary}</span>
                <span className="text-right text-muted-foreground tabular-nums">{age(r.ageSeconds)}</span>
                <div className="flex items-center justify-end gap-1">
                  <RoleGate allow={['admin', 'operator']}>
                    {kind === 'pods' && (
                      <IconBtn title="터미널" onClick={() => p.onTerminal(ns, r.name)}><Terminal className="w-3.5 h-3.5" /></IconBtn>
                    )}
                    {kind === 'nodes' && (
                      <>
                        <IconBtn title={cordoned ? 'uncordon' : 'cordon'} onClick={() => p.onCordon(r.name, !cordoned)}>
                          {cordoned ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}
                        </IconBtn>
                        <IconBtn title="drain" onClick={() => p.onDrain(r.name)}><Scaling className="w-3.5 h-3.5" /></IconBtn>
                      </>
                    )}
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
      <div className="px-4 py-1.5 text-[10px] text-muted-foreground border-t border-border">
        {filtered.length}개 표시{data?.truncated ? ' · 1000개 초과(잘림) — 네임스페이스 필터 권장' : ''} · 이름 클릭 시 상세/YAML
      </div>
    </MacCard>
  );
}

function IconBtn({ title, onClick, danger, children }: { title: string; onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`p-1 rounded-md ${danger ? 'text-red-500 hover:bg-red-500/10' : 'text-muted-foreground hover:bg-secondary'}`}
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
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </MacCard>
  );

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <Stat label="노드" value={nodeItems.length} sub={`Ready ${readyNodes} / ${nodeItems.length}`} />
      <Stat label="네임스페이스" value={namespaces.data?.items.length ?? '-'} />
      <Stat label="상태" value={readyNodes === nodeItems.length && nodeItems.length > 0 ? 'Healthy' : '점검'} />
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
      <div className="grid grid-cols-[1fr_140px_70px_1fr_90px] gap-2 px-4 py-1.5 text-[10px] font-semibold text-muted-foreground border-b border-border bg-secondary/30">
        <span>이름</span><span>네임스페이스</span><span>rev</span><span>차트</span><span className="text-right pr-2">values</span>
      </div>
      {isLoading ? (
        <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>
      ) : isError ? (
        <div className="p-6 text-sm text-red-500">조회 실패: {errMsg(error)}</div>
      ) : (data?.items.length ?? 0) === 0 ? (
        <div className="p-10 text-center text-sm text-muted-foreground">Helm 릴리스가 없습니다.</div>
      ) : (
        data!.items.map((r) => (
          <div key={`${r.namespace}/${r.name}`} className="grid grid-cols-[1fr_140px_70px_1fr_90px] gap-2 px-4 py-1.5 text-xs border-b border-border/40 items-center">
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
    return (
      <MacCard title={`${selectedCrd.kind} (${selectedCrd.group})`} bodyPadding="p-0">
        <div className="px-4 py-2 border-b border-border">
          <button onClick={() => setSelectedCrd(null)} className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline">
            <ArrowLeft className="w-3.5 h-3.5" /> CRD 목록
          </button>
        </div>
        {objects.isLoading ? (
          <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>
        ) : objects.isError ? (
          <div className="p-6 text-sm text-red-500">조회 실패: {errMsg(objects.error)}</div>
        ) : (objects.data?.items.length ?? 0) === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">오브젝트가 없습니다.</div>
        ) : (
          objects.data!.items.map((r) => (
            <button key={`${r.namespace}/${r.name}`} onClick={() => onOpenObject(selectedCrd, r)}
              className="w-full grid grid-cols-[1fr_160px_1fr] gap-2 px-4 py-1.5 text-xs text-left border-b border-border/40 hover:bg-secondary/30">
              <span className="truncate font-medium">{r.name}</span>
              <span className="truncate text-muted-foreground">{r.namespace ?? '-'}</span>
              <span className="truncate text-muted-foreground">{r.summary}</span>
            </button>
          ))
        )}
      </MacCard>
    );
  }

  return (
    <MacCard title="Custom Resource Definitions" bodyPadding="p-0">
      <div className="grid grid-cols-[1fr_1fr_90px] gap-2 px-4 py-1.5 text-[10px] font-semibold text-muted-foreground border-b border-border bg-secondary/30">
        <span>Kind</span><span>Group</span><span>Scope</span>
      </div>
      {crds.isLoading ? (
        <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>
      ) : crds.isError ? (
        <div className="p-6 text-sm text-red-500">조회 실패: {errMsg(crds.error)}</div>
      ) : (crds.data?.items.length ?? 0) === 0 ? (
        <div className="p-10 text-center text-sm text-muted-foreground">CRD 가 없습니다.</div>
      ) : (
        crds.data!.items.map((c) => (
          <button key={c.name} onClick={() => setSelectedCrd(c)}
            className="w-full grid grid-cols-[1fr_1fr_90px] gap-2 px-4 py-1.5 text-xs text-left border-b border-border/40 hover:bg-secondary/30">
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
              <button onClick={() => onStartEdit(yamlText)} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] hover:bg-secondary">
                <Pencil className="w-3 h-3" /> 편집
              </button>
            </RoleGate>
          )}
          {editing && (
            <div className="ml-auto flex items-center gap-1.5">
              <button onClick={onApply} className="inline-flex items-center gap-1 rounded-lg bg-primary text-primary-foreground px-2.5 py-1 text-[11px]">
                <Save className="w-3 h-3" /> 적용
              </button>
              <button onClick={onCancelEdit} className="rounded-lg border border-border px-2 py-1 text-[11px] hover:bg-secondary">취소</button>
            </div>
          )}
          <button onClick={onClose} className={`${editing || (detail.editable && detail.kind === 'k8s') ? '' : 'ml-auto'} text-muted-foreground hover:text-foreground`} aria-label="닫기">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-4">
          {yamlQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">YAML 불러오는 중…</div>
          ) : yamlQuery.isError ? (
            <div className="text-sm text-red-500">조회 실패: {errMsg(yamlQuery.error)}</div>
          ) : editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="w-full h-[80vh] font-mono text-xs rounded-xl border border-border bg-background p-3 focus:outline-none focus:ring-1 focus:ring-primary"
            />
          ) : (
            <LogViewer text={yamlText} maxHeight="max-h-[82vh]" />
          )}
        </div>
      </div>
    </div>
  );
}
