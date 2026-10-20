import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, BookOpen, Plus, Activity, RefreshCw, CheckCircle, AlertTriangle, XCircle, Server, WifiOff, LayoutGrid } from 'lucide-react';
import { formatDateTime, formatApiError } from '@/lib/utils';
import {
  HealthHero,
  CheckHistoryHeatmap,
  AddonGrid,
  AddClusterModal,
  AddAddonModal,
  MetricCardGrid,
  AddMetricCardModal,
  KubeconfigEditModal,
  KanbanSummaryCharts,
  ClusterItemsGrid,
  ClusterItemModal,
} from '@/components/dashboard';
import { PlaybookCard, AddPlaybookModal, RunCredsModal, playbookRunLines } from '@/components/playbooks';
import type { PlaybookSshCreds } from '@/types';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar, DebugLogPanel, ConfirmDialog, useToast, StatusBadge, statusToVariant, EmptyState, PageHeader, PageShell, RunLogPanel } from '@/components/common';
import { useRunLog, runLogged, elapsed, type RunLogEntry, type RunLogLevel } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { useClusterStore } from '@/stores/clusterStore';
import { usePlaybookStore } from '@/stores/playbookStore';
import { useClusters, useSummary, useAddons, useHealthCheck, useCreateAddon, useDeleteAddon, useAddonHealthCheck, useCheckHistoryHeatmap, useClusterStatusBreakdown } from '@/hooks/useCluster';
import { useDashboardPlaybooks, useRunPlaybook, useDeletePlaybook, useToggleDashboard, useUpdatePlaybook } from '@/hooks/usePlaybook';
import { useMetricCards, useMetricResults, useDeleteMetricCard } from '@/hooks/useMetricCards';
import { useClusterItems, useRunClusterItem, useUpdateClusterItem, useDeleteClusterItem } from '@/hooks/useClusterItems';
import { useWorkItems } from '@/hooks/useWorkItems';
import { healthApi } from '@/services/api';
import { Addon, AddonCheckRunResult, Cluster, ClusterItem, ClusterItemCardSize, MetricCard, Playbook } from '@/types';
import { useAuthStore, hasRole } from '@/stores/authStore';

// ── Cluster Overview Grid (shown when All tab is selected) ─────────────────────
interface ClusterOverviewGridProps {
  clusters: Cluster[];
  addons: Record<string, Addon[]>;
  onSelectCluster: (id: string) => void;
}

// 비정상 우선 정렬 — 운영 화면의 1차 목적은 예외 발견이다 (§12.12-3, D-119).
const STATUS_RANK: Record<string, number> = { critical: 0, warning: 1, pending: 2, healthy: 3 };
function sortByStatus<T extends { status: string; name: string }>(list: T[]): T[] {
  return [...list].sort((a, b) =>
    (STATUS_RANK[a.status] ?? 4) - (STATUS_RANK[b.status] ?? 4) || a.name.localeCompare(b.name));
}

function ClusterOverviewGrid({ clusters, addons, onSelectCluster }: ClusterOverviewGridProps) {
  if (clusters.length === 0) {
    return (
      <EmptyState
        icon={Server}
        title="등록된 클러스터가 없습니다."
        description="상단의 + 클러스터 버튼으로 클러스터를 추가하면 여기에서 상태를 한눈에 볼 수 있습니다."
      />
    );
  }

  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}
    >
      {sortByStatus(clusters).map((cluster) => {
        const clusterAddons = addons[cluster.id] ?? [];
        const healthy  = clusterAddons.filter((a) => a.status === 'healthy').length;
        const warning  = clusterAddons.filter((a) => a.status === 'warning').length;
        const critical = clusterAddons.filter((a) => a.status === 'critical').length;
        const total    = clusterAddons.length;

        const statusColor = {
          healthy:  { border: 'border-border',              bg: 'bg-secondary',          text: 'text-muted-foreground', dot: 'bg-muted-foreground/40' },
          warning:  { border: 'border-status-warning/40',  bg: 'bg-status-warning/10',  text: 'text-status-warning',  dot: 'bg-status-warning'  },
          critical: { border: 'border-status-critical/40', bg: 'bg-status-critical/10', text: 'text-status-critical', dot: 'bg-status-critical' },
          pending:  { border: 'border-status-unknown/40',  bg: 'bg-status-unknown/10',  text: 'text-status-unknown',  dot: 'bg-status-unknown'  },
        }[cluster.status] ?? { border: 'border-border', bg: 'bg-muted/20', text: 'text-muted-foreground', dot: 'bg-status-unknown' };

        return (
          <button
            key={cluster.id}
            onClick={() => onSelectCluster(cluster.id)}
            className={`bg-card border rounded-md p-4 text-left transition-colors group ${statusColor.border} hover:border-primary/40`}
          >
            {/* Header */}
            <div className="flex items-start justify-between mb-3 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <Server className={`w-4 h-4 flex-shrink-0 ${statusColor.text}`} aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate group-hover:text-primary transition-colors">
                    {cluster.name}
                  </p>
                  {cluster.region && (
                    <p className="text-sm text-muted-foreground truncate">{cluster.region}</p>
                  )}
                </div>
              </div>
              <span className={`flex-shrink-0 w-2.5 h-2.5 rounded-full mt-1 ${statusColor.dot}`} />
            </div>

            {/* Status label */}
            <div className={`text-sm font-medium px-2 py-1 rounded-full inline-flex items-center gap-1.5 mb-3 ${statusColor.bg} ${statusColor.text}`}>
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
              <p className="text-sm text-status-unknown italic">연결 불가로 점검 데이터 없음</p>
            ) : total > 0 ? (
              <div className="space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">전체 점검</span>
                  <span className="font-medium">{total}</span>
                </div>
                <div className="flex gap-2">
                  <div className="flex items-center gap-1 text-sm text-muted-foreground">
                    <CheckCircle className="w-3 h-3" />
                    <span className="tabular-nums">{healthy}</span>
                  </div>
                  {warning > 0 && (
                    <div className="flex items-center gap-1 text-sm text-status-warning">
                      <AlertTriangle className="w-3 h-3" />
                      <span>{warning}</span>
                    </div>
                  )}
                  {critical > 0 && (
                    <div className="flex items-center gap-1 text-sm text-status-critical">
                      <XCircle className="w-3 h-3" />
                      <span>{critical}</span>
                    </div>
                  )}
                </div>
                {/* Progress bar */}
                <div className="h-1.5 rounded-full bg-secondary overflow-hidden flex gap-px">
                  {healthy  > 0 && <div className="bg-status-healthy rounded-full"  style={{ width: `${(healthy / total) * 100}%` }} />}
                  {warning  > 0 && <div className="bg-status-warning rounded-full"  style={{ width: `${(warning / total) * 100}%` }} />}
                  {critical > 0 && <div className="bg-status-critical rounded-full" style={{ width: `${(critical / total) * 100}%` }} />}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">점검 항목 없음</p>
            )}

            {cluster.nodeCount != null && (
              <p className="text-sm text-muted-foreground mt-2">노드 {cluster.nodeCount}개</p>
            )}
          </button>
        );
      })}
    </div>
  );
}

// 애드온 점검 결과 상태 → 실행 로그 표기
const ADDON_STATUS_KO: Record<string, string> = { healthy: '정상', warning: '경고', critical: '위험', pending: '미연결', unknown: '알 수 없음' };
const ADDON_STATUS_LEVEL: Record<string, RunLogLevel> = { healthy: 'info', warning: 'warn', critical: 'error', pending: 'warn', unknown: 'warn' };

// ── 삭제 확인 대상 (ConfirmDialog 하나를 여러 삭제 액션이 공유) ────────────
type PendingDelete =
  | { kind: 'clusterItem'; item: ClusterItem }
  | { kind: 'addon'; addon: Addon }
  | { kind: 'metricCard'; id: string }
  | { kind: 'playbook'; playbook: Playbook }
  | null;

// POST /health/check/{cid}/addons/{aid} 응답 → 결과 줄.
function addonCheckLines(addon: Addon, r: AddonCheckRunResult): RunLogEntry[] {
  const st = r.status || 'unknown';
  const ms = r.responseTime != null ? ` · ${r.responseTime}ms` : '';
  const msg = r.log ? ` · ${r.log}` : '';
  return [[ADDON_STATUS_LEVEL[st] ?? 'warn', `${addon.name} · ${ADDON_STATUS_KO[st] ?? st}${ms}${msg}`]];
}

// POST /cluster-items/{id}/run 응답(갱신된 ClusterItem) → 결과 줄.
function clusterItemLines(item: ClusterItem): RunLogEntry[] {
  const value = item.currentText ?? (item.currentValue != null ? `${item.currentValue}${item.unit ? ` ${item.unit}` : ''}` : '—');
  if (item.lastStatus === 'error') {
    return [['error', `${item.title} · 수집 실패${item.lastError ? ` — ${item.lastError}` : ''}`]];
  }
  const level: RunLogLevel = item.resultStatus === 'critical' ? 'error' : item.resultStatus === 'warning' ? 'warn' : 'info';
  const lines: RunLogEntry[] = [[level, `${item.title} · 값 ${value}${item.resultStatus ? ` · ${ADDON_STATUS_KO[item.resultStatus] ?? item.resultStatus}` : ''}${item.lastSource ? ` · 출처 ${item.lastSource}` : ''}`]];
  if (item.previousValue != null && item.currentValue != null && item.previousValue !== item.currentValue) {
    lines.push(['info', `이전 값 ${item.previousValue} → ${item.currentValue}`]);
  }
  return lines;
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
  // 세션 자격증명으로 바로 나가던 플레이북 ▶ 의 실행 전 확인(D-141).
  const [playbookRunConfirm, setPlaybookRunConfirm] = useState<{ pb: Playbook; creds: PlaybookSshCreds } | null>(null);
  const [showKubeconfig, setShowKubeconfig] = useState(false);
  const [editingMetricCard, setEditingMetricCard] = useState<MetricCard | null>(null);
  const [showItemModal, setShowItemModal] = useState(false);
  const [editingItem, setEditingItem] = useState<ClusterItem | null>(null);
  const [runningItemIds, setRunningItemIds] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null);
  const { clusters, summary, addons, isChecking, lastCheckTime } = useClusterStore();
  const authUser = useAuthStore((s) => s.user);
  const toast = useToast();
  // 점검 실행 로그 — 점검 실행(선택 클러스터 1개 또는 전 클러스터 순차, D-128) · 애드온 단건 ▶ ·
  // 현황 아이템 ▶ · 플레이북 실행이 공유한다(D-135). 헤더(title)가 어떤 실행인지 말해 준다.
  const runLog = useRunLog();
  const [showRunLog, setShowRunLog] = useLogPref('dashboard-health-check');
  // 카드 생성/수정/삭제/테스트는 백엔드가 operator 이상만 허용(require_operator) —
  // viewer 에게는 버튼 자체를 숨겨 403 을 미리 막는다.
  const canManageMetricCards = hasRole(authUser, 'admin', 'operator');

  // Queries
  const { isLoading: clustersLoading } = useClusters();
  const { isLoading: summaryLoading } = useSummary();

  // 선택된 클러스터의 애드온 로드
  const activeClusterId = selectedClusterId || clusters[0]?.id || '';
  const { isLoading: addonsLoading } = useAddons(activeClusterId);

  // Recent Check History — Heat Map (cluster × time)
  const { data: historyLogs = [], isLoading: historyLoading } = useCheckHistoryHeatmap();

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

  // Cluster Items (현황 아이템) — 단일 클러스터 선택 시 표시.
  const { data: clusterItems = [], isLoading: itemsLoading } = useClusterItems(activeClusterId);
  const runClusterItem = useRunClusterItem(activeClusterId);
  const updateClusterItem = useUpdateClusterItem(activeClusterId);
  const deleteClusterItem = useDeleteClusterItem(activeClusterId);

  const handleRunItem = (item: ClusterItem) => {
    setRunningItemIds((prev) => new Set(prev).add(item.id));
    const clusterName = clusters.find((c) => c.id === item.clusterId)?.name;
    void runLogged(runLog, {
      title: `현황 아이템 수집 — ${item.title}`,
      first: `${clusterName ? `[${clusterName}] ` : ''}${item.title}(${item.itemType}) 수집 요청`,
      fn: () => runClusterItem.mutateAsync(item.id),
      summarize: ({ data }) => clusterItemLines(data),
    }).then(() => {
      setRunningItemIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    });
  };

  const handleRunAddon = (addon: Addon) => {
    const clusterName = clusters.find((c) => c.id === addon.clusterId)?.name;
    void runLogged(runLog, {
      title: `애드온 점검 — ${addon.name}`,
      first: `${clusterName ? `[${clusterName}] ` : ''}${addon.name} 점검 요청`,
      fn: () => addonHealthCheck.mutateAsync({ clusterId: addon.clusterId, addonId: addon.id }),
      summarize: ({ data }) => addonCheckLines(addon, data),
    });
  };

  const runPlaybookLogged = (pb: Playbook, creds: PlaybookSshCreds) => {
    const clusterName = clusters.find((c) => c.id === pb.clusterId)?.name ?? pb.clusterId;
    void runLogged(runLog, {
      title: `플레이북 실행 — ${pb.name}`,
      first: `${pb.name} — ${clusterName} 대상 실행 요청${creds.ssh_username ? ` (SSH ${creds.ssh_username})` : ''}`,
      fn: () => runPlaybook.mutateAsync({ id: pb.id, creds }),
      summarize: ({ data }) => playbookRunLines(data),
    });
  };

  const handleResizeItem = (item: ClusterItem, size: ClusterItemCardSize) => {
    updateClusterItem.mutate({ id: item.id, data: { cardSize: size } });
  };

  const confirmPendingDelete = () => {
    if (!pendingDelete) return;
    switch (pendingDelete.kind) {
      case 'clusterItem':
        deleteClusterItem.mutate(pendingDelete.item.id);
        break;
      case 'addon':
        deleteAddon.mutate({ addonId: pendingDelete.addon.id, clusterId: pendingDelete.addon.clusterId });
        break;
      case 'metricCard':
        deleteMetricCard.mutate(pendingDelete.id);
        break;
      case 'playbook':
        deletePlaybook.mutate(pendingDelete.playbook.id);
        break;
    }
    setPendingDelete(null);
  };

  const pendingDeleteTitle = pendingDelete && {
    clusterItem: `아이템 "${pendingDelete.kind === 'clusterItem' ? pendingDelete.item.title : ''}" 을(를) 삭제할까요?`,
    addon: `점검 항목 "${pendingDelete.kind === 'addon' ? pendingDelete.addon.name : ''}" 을(를) 삭제할까요?`,
    metricCard: '이 메트릭 카드를 삭제할까요?',
    playbook: `플레이북 "${pendingDelete.kind === 'playbook' ? pendingDelete.playbook.name : ''}" 을(를) 삭제할까요?`,
  }[pendingDelete.kind];

  // Kanban summary data — 통합 work items 한 번에 가져와 type 으로 분할
  const { data: workItemsData, isLoading: workItemsLoading } = useWorkItems();
  const allWorkItems = workItemsData?.data ?? [];

  const handleRunCheck = async () => {
    const targets = selectedClusterId
      ? clusters.filter((c) => c.id === selectedClusterId)
      : clusters;
    if (targets.length === 0) return;
    const tAll = performance.now();
    const run = runLog.begin(
      targets.length === 1 ? `점검 실행 — ${targets[0].name}` : `점검 실행 — 전체 ${targets.length}개 클러스터`,
      targets.length === 1 ? `${targets[0].name} 애드온 점검 요청` : `클러스터 ${targets.length}개 순차 점검 시작`,
    );
    let okClusters = 0;
    let failedClusters = 0;
    const totals = { healthy: 0, warning: 0, critical: 0, other: 0 };
    // 순차 실행: 각 클러스터 점검 완료 후 다음 진행 — 실패한 클러스터는 error 줄로 남기고 계속한다.
    for (const cluster of targets) {
      const t0 = performance.now();
      if (targets.length > 1) run.log('info', `[${cluster.name}] 점검 시작`);
      const hb = setInterval(
        () => run.log('info', `[${cluster.name}] 응답 대기 중 · ${Math.round((performance.now() - t0) / 1000)}초 경과`),
        5000,
      );
      try {
        const { data } = await healthCheck.mutateAsync(cluster.id);
        clearInterval(hb);
        const counts = { healthy: 0, warning: 0, critical: 0, other: 0 };
        for (const a of data.addons ?? []) {
          const key = a.status === 'healthy' || a.status === 'warning' || a.status === 'critical' ? a.status : 'other';
          counts[key] += 1;
          totals[key] += 1;
          run.log(
            ADDON_STATUS_LEVEL[a.status] ?? 'warn',
            `[${cluster.name}] ${a.name} · ${ADDON_STATUS_KO[a.status] ?? a.status}${a.responseTime != null ? ` · ${a.responseTime}ms` : ''}${a.message ? ` · ${a.message}` : ''}`,
          );
        }
        const level: RunLogLevel = counts.critical > 0 ? 'error' : counts.warning > 0 || counts.other > 0 ? 'warn' : 'info';
        run.log(
          level,
          `[${cluster.name}] 애드온 ${data.addonsUpdated}개 갱신 · 정상 ${counts.healthy} · 경고 ${counts.warning} · 위험 ${counts.critical}${counts.other ? ` · 기타 ${counts.other}` : ''} · ${elapsed(t0)}`,
        );
        okClusters += 1;
      } catch (e) {
        clearInterval(hb);
        failedClusters += 1;
        run.log('error', `[${cluster.name}] 점검 실패 · ${elapsed(t0)} — ${formatApiError(e)}`);
      }
    }
    if (targets.length > 1 || failedClusters > 0) {
      run.log(
        failedClusters > 0 || totals.critical > 0 ? 'error' : totals.warning > 0 ? 'warn' : 'info',
        `전체 요약 · 클러스터 성공 ${okClusters} · 실패 ${failedClusters} · 애드온 정상 ${totals.healthy} · 경고 ${totals.warning} · 위험 ${totals.critical} · ${elapsed(tAll)}`,
      );
    }
    run.end();
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
  // 원인 요약 1줄 — 애드온 그리드만 봐서는 안 보이던 심층 점검 원인까지 한 줄로.
  const { data: statusBreakdown } = useClusterStatusBreakdown(selectedClusterId ?? undefined);
  const topContributor = statusBreakdown?.contributors.find((c) => c.status !== 'healthy');

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
      toast.error('리포트 다운로드 실패', formatApiError(e));
    }
  };

  return (
    <div className="app-min-h-screen bg-background">
      {/* ── Top bar ──────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-20 px-4 lg:px-6 py-2 bg-background border-b border-border flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <PageHeader
          className="flex-1 items-center"
          title="클러스터 현황"
          titleExtra={lastCheckTime && (
            <span className="text-xs text-muted-foreground font-mono hidden sm:inline">
              마지막 점검: {formatDateTime(lastCheckTime)}
            </span>
          )}
          actions={<>
          <button
            onClick={() => setShowAddCluster(true)}
            className="px-2.5 py-1 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded-xl transition-colors flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> 클러스터
          </button>
          {clusters.length > 0 && (
            <button
              onClick={() => setShowAddAddon(true)}
              className="px-2.5 py-1 text-sm font-medium bg-secondary hover:bg-secondary/80 text-secondary-foreground border border-border rounded-xl transition-colors flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> 점검 항목
            </button>
          )}
          {canManageMetricCards && (
            <button
              onClick={() => { setEditingMetricCard(null); setShowAddMetric(true); }}
              className="px-2.5 py-1 text-sm font-medium bg-secondary hover:bg-secondary/80 text-foreground border border-border rounded-xl transition-colors flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> 메트릭
            </button>
          )}
          <div className="w-px h-4 bg-border mx-0.5" />
          <button
            onClick={() => handleDailyReport('md')}
            className="px-2.5 py-1 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-1"
            title="일일 리포트 다운로드 (.md)"
          >
            <Download className="w-3 h-3" /> .md
          </button>
          <button
            onClick={() => handleDailyReport('csv')}
            className="px-2.5 py-1 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-1"
            title="일일 리포트 다운로드 (.csv)"
          >
            <Download className="w-3 h-3" /> .csv
          </button>
          {selectedClusterId && (
            <button
              onClick={() => setShowKubeconfig(true)}
              className="px-2.5 py-1 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors"
            >
              Kubeconfig
            </button>
          )}
          <div className="w-px h-4 bg-border mx-0.5" />
          <button
            onClick={handleRunCheck}
            disabled={isChecking || runLog.running || clusters.length === 0}
            className="px-3 py-1 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors flex items-center gap-1.5 disabled:opacity-50 shadow-card"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isChecking || runLog.running ? 'animate-spin' : ''}`} />
            {isChecking || runLog.running ? '점검 중…' : '점검 실행'}
          </button>
          </>}
        />
      </div>

      <PageShell density="console" as="div" className="flex gap-3">
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

        <RunLogPanel run={runLog} show={showRunLog} onShowChange={setShowRunLog} />

        {/* ── Health Hero (Bento) ──────────────────────────────────────────── */}
        <HealthHero
          stats={summary ?? { totalClusters: 0, healthy: 0, warning: 0, critical: 0 }}
          isLoading={summaryLoading}
          lastCheckTime={lastCheckTime}
        />

        {/* ── 현황 아이템 (클러스터에 붙는 단위 카드) ─────────────────────── */}
        {selectedClusterId && (
          <MacCard
            title={`현황 아이템 — ${selectedCluster?.name ?? ''}`}
            bodyPadding="p-4"
            className="overflow-hidden"
            rootClassName="min-w-0"
          >
            <ClusterItemsGrid
              items={clusterItems}
              isLoading={itemsLoading}
              runningIds={runningItemIds}
              onAdd={() => { setEditingItem(null); setShowItemModal(true); }}
              onRun={handleRunItem}
              onEdit={(item) => { setEditingItem(item); setShowItemModal(true); }}
              onDelete={(item) => setPendingDelete({ kind: 'clusterItem', item })}
              onResize={handleResizeItem}
            />
          </MacCard>
        )}

        {/*
          레이아웃 규칙
            · "전체 현황" / 단일 클러스터 모두 동일하게 stack 으로 배치.
              메트릭 카드 수가 늘어나면 좁은 우측 컬럼 안에 grid-cols-3/4 가
              나오면서 카드가 짤리는 사고가 있어, 항상 전폭으로 펼쳐 카드 잘림
              사고를 원천 차단한다.
        */}
        <div className="space-y-3 min-w-0">

        {/* ── Cluster Status ─────────────────────────────────────────────── */}
        <MacCard title="클러스터 상태" bodyPadding="p-4" className="overflow-hidden" rootClassName="min-w-0">
          {selectedClusterId === null ? (
            <ClusterOverviewGrid clusters={clusters} addons={addons} onSelectCluster={setSelectedClusterId} />
          ) : (
            <>
              {!isSelectedDisconnected && statusBreakdown && (
                <div className="mb-3 flex items-center gap-2 flex-wrap text-sm">
                  <StatusBadge variant={statusToVariant(statusBreakdown.status)} />
                  {topContributor ? (
                    <span className="text-muted-foreground truncate">
                      {topContributor.name}{topContributor.message ? ` — ${topContributor.message}` : ''}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">정상입니다.</span>
                  )}
                  <Link
                    to={`/clusters/${selectedClusterId}`}
                    className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline shrink-0"
                  >
                    <LayoutGrid className="w-3 h-3" /> 클러스터 상세로
                  </Link>
                </div>
              )}
              {isSelectedDisconnected && (
                <div className="mb-4 px-4 py-3 rounded-xl border border-status-unknown/30 bg-status-unknown/10 flex items-start gap-3">
                  <WifiOff className="w-5 h-5 text-status-unknown flex-shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-status-unknown mb-0.5">
                      미연결 — 클러스터에 연결할 수 없습니다
                    </p>
                    <p className="text-sm text-muted-foreground">
                      API 서버 또는 kubeconfig 인증이 실패했습니다. 아래 점검 카드는 마지막 성공 시점의 값으로 <b>비활성화</b> 되어 있습니다.
                      설정 → "연결 확인"을 실행하거나 kubeconfig 를 점검한 뒤 다시 시도하세요.
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
                  onDeleteAddon={(addon) => setPendingDelete({ kind: 'addon', addon })}
                  onRunAddon={handleRunAddon}
                />
              </div>
            </>
          )}
        </MacCard>

        {/* ── Prometheus Insights (우측 컬럼) ─────────────────────────────── */}
        <MacCard
          title="Prometheus 지표"
          icon={Activity}
          titleExtra={<span className="text-xs text-muted-foreground tabular-nums">{metricCards.length}개</span>}
          bodyPadding="p-4"
          className="overflow-hidden"
          rootClassName="min-w-0"
        >
          <MetricCardGrid
            cards={metricCards}
            results={metricResults}
            isLoading={metricsLoading}
            onDeleteCard={canManageMetricCards
              ? (id) => setPendingDelete({ kind: 'metricCard', id })
              : undefined}
            onEditCard={canManageMetricCards
              ? (card) => { setEditingMetricCard(card); setShowAddMetric(true); }
              : undefined}
          />
        </MacCard>

        </div>

        {/* 2-column grid: Playbook Checks ↔ 작업/이슈 현황 (lg 부터 분할) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {/* ── Playbook Checks ──────────────────────────────────────────── */}
          {dashboardPlaybooks.length > 0 && (
            <MacCard
              title="플레이북 점검"
              icon={BookOpen}
              titleExtra={<span className="text-xs text-muted-foreground tabular-nums">{dashboardPlaybooks.length}개</span>}
              bodyPadding="p-4"
            >
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
                        setPlaybookRunConfirm({ pb: playbook, creds: cached });
                      } else {
                        setCredsTarget(playbook);
                      }
                    }}
                    onDelete={() => setPendingDelete({ kind: 'playbook', playbook })}
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

        {/* ── Recent Check History (Heat Map) ──────────────────────────── */}
        <MacCard title="최근 점검 이력" bodyPadding="p-0">
          <CheckHistoryHeatmap logs={historyLogs} isLoading={historyLoading} />
        </MacCard>

      </main>
      </PageShell>

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

      {/* Cluster Item Modal */}
      {activeClusterId && (
        <ClusterItemModal
          isOpen={showItemModal}
          onClose={() => { setShowItemModal(false); setEditingItem(null); }}
          clusterId={activeClusterId}
          editingItem={editingItem}
        />
      )}

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
          if (!editingPlaybook) return Promise.resolve();
          // 모달이 결과를 기다린다(D-143) — 성공 시 모달 onClose 가 닫고, 실패 시 모달 안에 사유를 띄운다.
          return updatePlaybook.mutateAsync({
            id: editingPlaybook.id,
            data: {
              name: data.name,
              // 지운 값은 null 로 보내 서버가 컬럼을 비우게 한다(D-144).
              description: data.description.trim() || null,
              // 모드 전환 시 반대편 필드를 비워야 backend 에서 충돌 안 남(/playbooks 와 동일)
              playbookFileId: data.playbookFileId ?? null,
              inventoryId: data.inventoryId ?? null,
              playbookPath: data.playbookPath ?? null,
              inventoryPath: data.inventoryPath ?? null,
              tags: data.tags.trim() || null,
              timeoutSeconds: data.timeoutSeconds,
              clusterId: data.clusterId,
            },
          });
        }}
        clusters={clusters}
        defaultClusterId={activeClusterId}
        initialData={editingPlaybook}
      />

      <ConfirmDialog
        open={!!playbookRunConfirm}
        title="플레이북 실행"
        description={playbookRunConfirm
          ? `"${playbookRunConfirm.pb.name}" 을(를) ${clusters.find((c) => c.id === playbookRunConfirm.pb.clusterId)?.name ?? playbookRunConfirm.pb.clusterId} 클러스터 대상으로 실행합니다. 인벤토리(${playbookRunConfirm.pb.inventoryName || playbookRunConfirm.pb.inventoryPath || '기본 인벤토리'})의 호스트에 세션에 저장된 SSH 자격증명${playbookRunConfirm.creds.ssh_username ? `(${playbookRunConfirm.creds.ssh_username})` : ''}으로 ansible-playbook 이 바로 실행됩니다.`
          : undefined}
        confirmLabel="실행"
        danger
        busy={!!playbookRunConfirm && runningIds.has(playbookRunConfirm.pb.id)}
        onConfirm={() => {
          if (!playbookRunConfirm) return;
          const { pb, creds } = playbookRunConfirm;
          setPlaybookRunConfirm(null);
          runPlaybookLogged(pb, creds);
        }}
        onCancel={() => setPlaybookRunConfirm(null)}
      />

      <RunCredsModal
        open={!!credsTarget}
        playbookName={credsTarget?.name ?? ''}
        onClose={() => setCredsTarget(null)}
        onRun={(creds) => {
          if (credsTarget) {
            // 모달은 제출 즉시 닫히므로 실행 로그는 상단 패널에 남긴다.
            runPlaybookLogged(credsTarget, creds);
            setCredsTarget(null);
          }
        }}
      />

      <ConfirmDialog
        open={!!pendingDelete}
        title={pendingDeleteTitle ?? ''}
        description="이 작업은 되돌릴 수 없습니다."
        confirmLabel="삭제"
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmPendingDelete}
      />
    </div>
  );
}
