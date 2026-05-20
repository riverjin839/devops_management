import { useState } from 'react';
import { Download, BookOpen, Plus, Activity, RefreshCw, CheckCircle, AlertTriangle, XCircle, Server, WifiOff } from 'lucide-react';
import { formatDateTime } from '@/lib/utils';
import {
  SummaryStats,
  AddonGrid,
  AddClusterModal,
  AddAddonModal,
  MetricCardGrid,
  AddMetricCardModal,
  KubeconfigEditModal,
  KanbanSummaryCharts,
} from '@/components/dashboard';
import { PlaybookCard, AddPlaybookModal, RunCredsModal } from '@/components/playbooks';
import type { PlaybookSshCreds } from '@/types';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar, DebugLogPanel } from '@/components/common';
import { useClusterStore } from '@/stores/clusterStore';
import { usePlaybookStore } from '@/stores/playbookStore';
import { useClusters, useSummary, useAddons, useHealthCheck, useCreateAddon, useDeleteAddon, useAddonHealthCheck } from '@/hooks/useCluster';
import { useDashboardPlaybooks, useRunPlaybook, useDeletePlaybook, useToggleDashboard, useUpdatePlaybook } from '@/hooks/usePlaybook';
import { useMetricCards, useMetricResults, useDeleteMetricCard } from '@/hooks/useMetricCards';
import { useWorkItems } from '@/hooks/useWorkItems';
import { healthApi } from '@/services/api';
import { Addon, Cluster, MetricCard, Playbook } from '@/types';

// ── Cluster Overview Grid (shown when All tab is selected) ─────────────────────
interface ClusterOverviewGridProps {
  clusters: Cluster[];
  addons: Record<string, Addon[]>;
  onSelectCluster: (id: string) => void;
}

function ClusterOverviewGrid({ clusters, addons, onSelectCluster }: ClusterOverviewGridProps) {
  if (clusters.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm">
        등록된 클러스터가 없습니다. 클러스터를 추가하세요.
      </div>
    );
  }

  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}
    >
      {clusters.map((cluster) => {
        const clusterAddons = addons[cluster.id] ?? [];
        const healthy  = clusterAddons.filter((a) => a.status === 'healthy').length;
        const warning  = clusterAddons.filter((a) => a.status === 'warning').length;
        const critical = clusterAddons.filter((a) => a.status === 'critical').length;
        const total    = clusterAddons.length;

        const statusColor = {
          healthy:  { border: 'border-emerald-500/40', bg: 'bg-emerald-500/10', text: 'text-emerald-400', dot: 'bg-emerald-400' },
          warning:  { border: 'border-yellow-500/40',  bg: 'bg-yellow-500/10',  text: 'text-yellow-400',  dot: 'bg-yellow-400'  },
          critical: { border: 'border-red-500/40',     bg: 'bg-red-500/10',     text: 'text-red-400',     dot: 'bg-red-400'     },
          pending:  { border: 'border-slate-500/40',   bg: 'bg-slate-500/10',   text: 'text-slate-400',   dot: 'bg-slate-400'   },
        }[cluster.status] ?? { border: 'border-border', bg: 'bg-muted/20', text: 'text-muted-foreground', dot: 'bg-slate-400' };

        return (
          <button
            key={cluster.id}
            onClick={() => onSelectCluster(cluster.id)}
            className={`bg-card border rounded-xl p-4 text-left hover:shadow-md transition-all group ${statusColor.border} hover:border-primary/40`}
          >
            {/* Header */}
            <div className="flex items-start justify-between mb-3 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${statusColor.bg}`}>
                  <Server className={`w-4 h-4 ${statusColor.text}`} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate group-hover:text-primary transition-colors">
                    {cluster.name}
                  </p>
                  {cluster.region && (
                    <p className="text-xs text-muted-foreground truncate">{cluster.region}</p>
                  )}
                </div>
              </div>
              <span className={`flex-shrink-0 w-2.5 h-2.5 rounded-full mt-1 ${statusColor.dot}`} />
            </div>

            {/* Status label */}
            <div className={`text-xs font-medium px-2 py-1 rounded-full inline-flex items-center gap-1.5 mb-3 ${statusColor.bg} ${statusColor.text}`}>
              {cluster.status === 'healthy'  && <CheckCircle className="w-3 h-3" />}
              {cluster.status === 'warning'  && <AlertTriangle className="w-3 h-3" />}
              {cluster.status === 'critical' && <XCircle className="w-3 h-3" />}
              {cluster.status === 'pending'  && <WifiOff className="w-3 h-3" />}
              {cluster.status === 'healthy'
                ? '정상'
                : cluster.status === 'warning'
                ? '경고'
                : cluster.status === 'critical'
                ? '위험'
                : '미연결'}
            </div>

            {/* Check counts — 미연결이면 stale 값 대신 안내 */}
            {cluster.status === 'pending' ? (
              <p className="text-xs text-slate-400/80 italic">연결 불가로 점검 데이터 없음</p>
            ) : total > 0 ? (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">전체 점검</span>
                  <span className="font-medium">{total}</span>
                </div>
                <div className="flex gap-2">
                  <div className="flex items-center gap-1 text-xs text-emerald-400">
                    <CheckCircle className="w-3 h-3" />
                    <span>{healthy}</span>
                  </div>
                  {warning > 0 && (
                    <div className="flex items-center gap-1 text-xs text-yellow-400">
                      <AlertTriangle className="w-3 h-3" />
                      <span>{warning}</span>
                    </div>
                  )}
                  {critical > 0 && (
                    <div className="flex items-center gap-1 text-xs text-red-400">
                      <XCircle className="w-3 h-3" />
                      <span>{critical}</span>
                    </div>
                  )}
                </div>
                {/* Progress bar */}
                <div className="h-1.5 rounded-full bg-secondary overflow-hidden flex gap-px">
                  {healthy  > 0 && <div className="bg-emerald-500 rounded-full" style={{ width: `${(healthy / total) * 100}%` }} />}
                  {warning  > 0 && <div className="bg-yellow-500 rounded-full"  style={{ width: `${(warning / total) * 100}%` }} />}
                  {critical > 0 && <div className="bg-red-500 rounded-full"     style={{ width: `${(critical / total) * 100}%` }} />}
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">점검 항목 없음</p>
            )}

            {cluster.nodeCount != null && (
              <p className="text-xs text-muted-foreground mt-2">노드 {cluster.nodeCount}개</p>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Dashboard() {
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [showAddCluster, setShowAddCluster] = useState(false);
  const [showAddAddon, setShowAddAddon] = useState(false);
  const [editingAddon, setEditingAddon] = useState<Addon | null>(null);
  const [showAddMetric, setShowAddMetric] = useState(false);
  const [showPlaybookModal, setShowPlaybookModal] = useState(false);
  const [editingPlaybook, setEditingPlaybook] = useState<Playbook | null>(null);
  const [credsTarget, setCredsTarget] = useState<Playbook | null>(null);
  const [showKubeconfig, setShowKubeconfig] = useState(false);
  const [editingMetricCard, setEditingMetricCard] = useState<MetricCard | null>(null);
  const { clusters, summary, addons, isChecking, lastCheckTime } = useClusterStore();

  // Queries
  const { isLoading: clustersLoading } = useClusters();
  const { isLoading: summaryLoading } = useSummary();

  // 선택된 클러스터의 애드온 로드
  const activeClusterId = selectedClusterId || clusters[0]?.id || '';
  const { isLoading: addonsLoading } = useAddons(activeClusterId);

  // Health Check mutation
  const healthCheck = useHealthCheck();
  const createAddon = useCreateAddon();
  const deleteAddon = useDeleteAddon();
  const addonHealthCheck = useAddonHealthCheck();

  // Dashboard playbooks
  const { data: dashboardPlaybooks = [] } = useDashboardPlaybooks(activeClusterId);
  const { runningIds } = usePlaybookStore();
  const runPlaybook = useRunPlaybook();
  const deletePlaybook = useDeletePlaybook();
  const updatePlaybook = useUpdatePlaybook();
  const toggleDashboard = useToggleDashboard();

  // PromQL Metric Cards
  const { data: metricCards = [], isLoading: metricsLoading } = useMetricCards();
  const { data: metricResults = [] } = useMetricResults();
  const deleteMetricCard = useDeleteMetricCard();

  // Kanban summary data — 통합 work items 한 번에 가져와 type 으로 분할
  const { data: workItemsData, isLoading: workItemsLoading } = useWorkItems();
  const allWorkItems = workItemsData?.data ?? [];

  const handleRunCheck = async () => {
    if (selectedClusterId) {
      healthCheck.mutate(selectedClusterId);
    } else if (clusters.length > 0) {
      // 순차 실행: 각 클러스터 점검 완료 후 다음 진행
      for (const cluster of clusters) {
        try {
          await healthCheck.mutateAsync(cluster.id);
        } catch (e) {
          console.error(`Check failed for ${cluster.name}:`, e);
        }
      }
    }
  };

  const DEFAULT_ADDONS = [
    { name: 'etcd Leader', type: 'etcd-leader', icon: '💾', description: 'etcd leader election & health status' },
    { name: 'Node Status', type: 'node-check', icon: '🖥️', description: 'Node readiness & pressure conditions' },
    { name: 'Control Plane', type: 'control-plane', icon: '🎛️', description: 'API Server, Scheduler, Controller Manager' },
    { name: 'CoreDNS', type: 'system-pod', icon: '🔍', description: 'Cluster DNS service' },
  ];

  // 현재 표시할 애드온
  const currentAddons = selectedClusterId
    ? addons[selectedClusterId] || []
    : Object.values(addons).flat();

  const selectedCluster = selectedClusterId ? clusters.find((c) => c.id === selectedClusterId) : null;
  const isSelectedDisconnected = selectedCluster?.status === 'pending';

  // 이미 등록된 타입을 제외한 missing addons 계산
  const existingTypes = new Set(currentAddons.map((a) => a.type));
  const missingAddons = DEFAULT_ADDONS.filter((a) => !existingTypes.has(a.type));

  const handleAddDefaultAddons = () => {
    const clusterId = activeClusterId;
    if (!clusterId) return;
    missingAddons.forEach((addon) => {
      createAddon.mutate({ clusterId, ...addon });
    });
  };

  const handleDailyReport = async (fmt: 'md' | 'csv') => {
    try {
      const { data } = await healthApi.exportReport(activeClusterId || undefined, fmt);
      const blob = data instanceof Blob ? data : new Blob([data], { type: fmt === 'csv' ? 'text/csv' : 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const today = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `k8s-daily-report-${today}.${fmt}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Export failed:', e);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-20 px-4 lg:px-6 py-2 bg-background/95 backdrop-blur border-b border-border flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h1 className="font-bold text-sm tracking-tight whitespace-nowrap">DEVOPS MANAGEMENT</h1>
        {lastCheckTime && (
          <p className="text-[11px] text-muted-foreground font-mono hidden sm:block">
            Last: {formatDateTime(lastCheckTime)}
          </p>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setShowAddCluster(true)}
            className="px-2.5 py-1 text-xs font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded-lg transition-colors flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> Cluster
          </button>
          {clusters.length > 0 && (
            <button
              onClick={() => setShowAddAddon(true)}
              className="px-2.5 py-1 text-xs font-medium bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-600 border border-emerald-500/20 rounded-lg transition-colors flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> Check
            </button>
          )}
          <button
            onClick={() => { setEditingMetricCard(null); setShowAddMetric(true); }}
            className="px-2.5 py-1 text-xs font-medium bg-purple-500/10 hover:bg-purple-500/20 text-purple-600 border border-purple-500/20 rounded-lg transition-colors flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> Metric
          </button>
          <div className="w-px h-4 bg-border mx-0.5" />
          <button
            onClick={() => handleDailyReport('md')}
            className="px-2.5 py-1 text-xs font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors flex items-center gap-1"
            title="Daily Report (markdown)"
          >
            <Download className="w-3 h-3" /> .md
          </button>
          <button
            onClick={() => handleDailyReport('csv')}
            className="px-2.5 py-1 text-xs font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors flex items-center gap-1"
            title="Daily Report (csv)"
          >
            <Download className="w-3 h-3" /> .csv
          </button>
          {selectedClusterId && (
            <button
              onClick={() => setShowKubeconfig(true)}
              className="px-2.5 py-1 text-xs font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors"
            >
              Kubeconfig
            </button>
          )}
          <div className="w-px h-4 bg-border mx-0.5" />
          <button
            onClick={handleRunCheck}
            disabled={isChecking}
            className="px-3 py-1 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-50 mac-shadow"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`} />
            {isChecking ? 'Checking...' : 'Run Check'}
          </button>
        </div>
      </div>

      <div className="mx-auto px-3 lg:px-4 xl:px-6 py-3 flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={selectedClusterId}
          onSelect={setSelectedClusterId}
          allowAll
          allLabel="전체 현황"
          iconOnly
        />

      <main className="flex-1 min-w-0 space-y-3">
        <DebugLogPanel pageKey="dashboard" extra={{ activeClusterId, clusters: clusters.length, metricCards: metricCards.length }} />

        {/* ── Summary Stats ──────────────────────────────────────────────── */}
        <SummaryStats
          stats={summary ?? { totalClusters: 0, healthy: 0, warning: 0, critical: 0 }}
          isLoading={summaryLoading}
        />

        {/*
          레이아웃 규칙
            · "전체 현황" / 단일 클러스터 모두 동일하게 stack 으로 배치.
              메트릭 카드 수가 늘어나면 좁은 우측 컬럼 안에 grid-cols-3/4 가
              나오면서 카드가 짤리는 사고가 있어, 항상 전폭으로 펼쳐 카드 잘림
              사고를 원천 차단한다.
        */}
        <div className="space-y-3 min-w-0">

        {/* ── Cluster Status ─────────────────────────────────────────────── */}
        <MacCard title="Cluster Status" bodyPadding="p-4" className="overflow-hidden" rootClassName="min-w-0">
          {selectedClusterId === null ? (
            <ClusterOverviewGrid clusters={clusters} addons={addons} onSelectCluster={setSelectedClusterId} />
          ) : (
            <>
              {isSelectedDisconnected && (
                <div className="mb-4 px-4 py-3 rounded-xl border border-slate-500/30 bg-slate-500/10 flex items-start gap-3">
                  <WifiOff className="w-5 h-5 text-slate-400 flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-slate-300 mb-0.5">
                      미연결 — 클러스터에 연결할 수 없습니다
                    </p>
                    <p className="text-xs text-muted-foreground">
                      API 서버 또는 kubeconfig 인증이 실패했습니다. 아래 점검 카드는 마지막 성공 시점의 값으로 <b>비활성화</b> 되어 있습니다.
                      Settings → "연결 확인"을 실행하거나 kubeconfig 를 점검한 뒤 다시 시도하세요.
                    </p>
                  </div>
                </div>
              )}
              <div className={isSelectedDisconnected ? 'opacity-40 pointer-events-none select-none grayscale' : ''}>
                <AddonGrid
                  addons={currentAddons}
                  isLoading={clustersLoading || addonsLoading}
                  onAddDefaultAddons={!isSelectedDisconnected && clusters.length > 0 && missingAddons.length > 0 ? handleAddDefaultAddons : undefined}
                  onEditAddon={(addon) => { setEditingAddon(addon); setShowAddAddon(true); }}
                  onDeleteAddon={(addon) => { if (confirm(`Delete check "${addon.name}"?`)) deleteAddon.mutate({ addonId: addon.id, clusterId: addon.clusterId }); }}
                  onRunAddon={(addon) => addonHealthCheck.mutate({ clusterId: addon.clusterId, addonId: addon.id })}
                />
              </div>
            </>
          )}
        </MacCard>

        {/* ── Prometheus Insights (우측 컬럼) ─────────────────────────────── */}
        <MacCard title="Prometheus Insights" bodyPadding="p-4" className="overflow-hidden" rootClassName="min-w-0">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-3">
            <Activity className="w-4 h-4 text-primary" />
            <span>{metricCards.length} cards</span>
          </div>
          <MetricCardGrid
            cards={metricCards}
            results={metricResults}
            isLoading={metricsLoading}
            onDeleteCard={(id) => { if (confirm('Delete this metric card?')) deleteMetricCard.mutate(id); }}
            onEditCard={(card) => { setEditingMetricCard(card); setShowAddMetric(true); }}
          />
        </MacCard>

        </div>

        {/* 2-column grid: Playbook Checks ↔ 작업/이슈 현황 (lg 부터 분할) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {/* ── Playbook Checks ──────────────────────────────────────────── */}
          {dashboardPlaybooks.length > 0 && (
            <MacCard title="Playbook Checks" bodyPadding="p-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-3">
                <BookOpen className="w-4 h-4 text-primary" />
                <span>{dashboardPlaybooks.length} playbooks</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {dashboardPlaybooks.map((playbook) => (
                  <PlaybookCard
                    key={playbook.id}
                    playbook={playbook}
                    isRunning={runningIds.has(playbook.id)}
                    onRun={() => {
                      // 세션 캐시된 자격증명이 있으면 바로 실행, 없으면 모달.
                      let cached: PlaybookSshCreds | null = null;
                      try {
                        const raw = sessionStorage.getItem('k8s:playbook-ssh-creds');
                        if (raw) cached = JSON.parse(raw);
                      } catch { /* ignore */ }
                      if (cached && (cached.ssh_username || cached.ssh_password || cached.ssh_private_key)) {
                        runPlaybook.mutate({ id: playbook.id, creds: cached });
                      } else {
                        setCredsTarget(playbook);
                      }
                    }}
                    onDelete={() => { if (confirm(`Delete playbook "${playbook.name}"?`)) deletePlaybook.mutate(playbook.id); }}
                    onToggleDashboard={() => toggleDashboard.mutate(playbook.id)}
                    onEdit={() => { setEditingPlaybook(playbook); setShowPlaybookModal(true); }}
                  />
                ))}
              </div>
            </MacCard>
          )}

          {/* ── 업무 현황 ─────────────────────────────────────────── */}
          <MacCard title="업무 현황" bodyPadding="p-4"
            className={dashboardPlaybooks.length === 0 ? 'lg:col-span-2' : ''}>
            <KanbanSummaryCharts
              items={allWorkItems}
              isLoading={workItemsLoading}
              selectedClusterId={selectedClusterId}
            />
          </MacCard>
        </div>

      </main>
      </div>

      {/* Add Cluster Modal */}
      <AddClusterModal
        isOpen={showAddCluster}
        onClose={() => setShowAddCluster(false)}
      />

      {/* Add Addon Modal */}
      <AddAddonModal
        isOpen={showAddAddon}
        onClose={() => {
          setShowAddAddon(false);
          setEditingAddon(null);
        }}
        clusterId={activeClusterId}
        editingAddon={editingAddon}
      />


      {/* Add Metric Card Modal */}
      <AddMetricCardModal
        isOpen={showAddMetric}
        onClose={() => {
          setShowAddMetric(false);
          setEditingMetricCard(null);
        }}
        editingCard={editingMetricCard}
      />

      {/* Kubeconfig Edit Modal */}
      {selectedClusterId && (
        <KubeconfigEditModal
          clusterId={selectedClusterId}
          clusterName={clusters.find((c) => c.id === selectedClusterId)?.name ?? ''}
          isOpen={showKubeconfig}
          onClose={() => setShowKubeconfig(false)}
        />
      )}

      {/* Playbook Edit Modal */}
      <AddPlaybookModal
        isOpen={showPlaybookModal}
        onClose={() => {
          setShowPlaybookModal(false);
          setEditingPlaybook(null);
        }}
        onSubmit={(data) => {
          if (!editingPlaybook) return;
          updatePlaybook.mutate({
            id: editingPlaybook.id,
            data: {
              name: data.name,
              description: data.description || undefined,
              playbookPath: data.playbookPath,
              inventoryPath: data.inventoryPath || undefined,
              tags: data.tags || undefined,
              clusterId: data.clusterId,
            },
          });
          setShowPlaybookModal(false);
          setEditingPlaybook(null);
        }}
        clusters={clusters}
        defaultClusterId={activeClusterId}
        initialData={editingPlaybook}
      />

      <RunCredsModal
        open={!!credsTarget}
        playbookName={credsTarget?.name ?? ''}
        onClose={() => setCredsTarget(null)}
        onRun={(creds) => {
          if (credsTarget) {
            runPlaybook.mutate({ id: credsTarget.id, creds });
            setCredsTarget(null);
          }
        }}
      />
    </div>
  );
}
