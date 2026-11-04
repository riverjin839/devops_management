import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { PageHeader } from '@/components/common/PageHeader';
import { PageShell, RunLogPanel, ConfirmDialog, useToast } from '@/components/common';
import { ClipboardCheck, Settings, AlertTriangle, Loader2, BookOpen, Download, RefreshCw, WifiOff, KeyRound, Plus, MoreHorizontal, ChevronDown } from 'lucide-react';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { MacCard } from '@/components/ui/MacCard';
import { StatusBadge, statusToVariant } from '@/components/common/StatusBadge';
import {
  AddonGrid,
  AddAddonModal,
  CheckHistoryHeatmap,
  ClusterItemsGrid,
  ClusterItemModal,
  KubeconfigEditModal,
} from '@/components/dashboard';
import { PlaybookCard, AddPlaybookModal, RunCredsModal, CancelPlaybookRunsButton, playbookRunLines } from '@/components/playbooks';
import {
  useClusters, useClusterStatusBreakdown, useAddons, useHealthCheck, useCreateAddon, useDeleteAddon,
  useAddonHealthCheck, useCheckHistoryHeatmap,
} from '@/hooks/useCluster';
import { useClusterRouteParam } from '@/hooks/useClusterRouteParam';
import { useDashboardPlaybooks, useRunPlaybook, useDeletePlaybook, useToggleDashboard, useUpdatePlaybook } from '@/hooks/usePlaybook';
import { useClusterItems, useRunClusterItem, useUpdateClusterItem, useDeleteClusterItem } from '@/hooks/useClusterItems';
import { useRunLog, runLogged, elapsed, type RunLogEntry, type RunLogLevel } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { useCanOperate } from '@/hooks/useCanOperate';
import { usePlaybookStore } from '@/stores/playbookStore';
import { ClusterOpsCheckPanel } from '@/components/ops-check';
import { healthApi } from '@/services/api';
import { parseUTC, formatApiError, formatRelativeTime } from '@/lib/utils';
import { useK8sHub } from '@/lib/k8sHub';
import type {
  Addon, AddonCheckRunResult, ClusterItem, ClusterItemCardSize, ClusterStatusContributor, Playbook, PlaybookSshCreds,
} from '@/types';

const SOURCE_LABEL: Record<ClusterStatusContributor['sourceType'], string> = {
  core_bundle: '핵심 점검 번들', addon: '애드온', deep_check: '심층 점검', check_matrix: '매트릭스 항목',
};

// 애드온 점검 결과 상태 → 실행 로그 표기
const ADDON_STATUS_KO: Record<string, string> = { healthy: '정상', warning: '경고', critical: '위험', pending: '미연결', unknown: '알 수 없음' };
const ADDON_STATUS_LEVEL: Record<string, RunLogLevel> = { healthy: 'info', warning: 'warn', critical: 'error', pending: 'warn', unknown: 'warn' };

const DEFAULT_ADDONS = [
  // icon 은 비워 둔다 — 기본 타입은 AddonCard 가 lucide 아이콘으로 그린다(이모지를 DB 에 저장하지 않는다).
  { name: 'etcd Leader', type: 'etcd-leader', icon: '', description: 'etcd 리더 선출 및 상태' },
  { name: 'Node Status', type: 'node-check', icon: '', description: '노드 준비 상태 및 압박 조건' },
  { name: 'Control Plane', type: 'control-plane', icon: '', description: 'API Server, Scheduler, Controller Manager' },
  { name: 'CoreDNS', type: 'system-pod', icon: '', description: '클러스터 DNS 서비스' },
];

// 위험 → 경고 → 그 외(미연결·알 수 없음) → 정상 순. 정상은 기본으로 접는다.
const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, healthy: 3 };
const severityRank = (status: string) => SEVERITY_RANK[status] ?? 2;

// ── 삭제 확인 대상 (ConfirmDialog 하나를 여러 삭제 액션이 공유) ────────────
type PendingDelete =
  | { kind: 'clusterItem'; item: ClusterItem }
  | { kind: 'addon'; addon: Addon }
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

function ContributorRow({ c }: { c: ClusterStatusContributor }) {
  return (
    <div className="flex items-center gap-2 py-1.5 px-1 text-sm">
      <StatusBadge variant={statusToVariant(c.status)} size="sm" />
      <span className="text-xs rounded-full border border-border px-1.5 py-0.5 text-muted-foreground shrink-0">
        {SOURCE_LABEL[c.sourceType] ?? c.sourceType}
      </span>
      <span className="font-medium truncate max-w-[220px]">{c.name}</span>
      {c.message && <span className="text-muted-foreground truncate flex-1 min-w-0">{c.message}</span>}
      {c.checkedAt && (
        <span className="text-xs text-muted-foreground font-mono ml-auto shrink-0">
          {parseUTC(c.checkedAt).toLocaleString()}
        </span>
      )}
    </div>
  );
}

const HEADER_BTN = 'inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed';
const MENU_CONTENT = 'z-[60] min-w-[200px] rounded-md border border-border bg-card p-1 shadow-lg';
const MENU_ITEM = 'flex items-center gap-2 px-2 py-1.5 text-sm rounded-lg cursor-pointer outline-none data-[highlighted]:bg-secondary data-[disabled]:opacity-50 data-[disabled]:cursor-not-allowed';

/**
 * 클러스터 상세 — 종합 상태(원인 목록) + 애드온 점검 + 현황 아이템 + 점검 카탈로그 + 플레이북 + 점검 이력.
 * 매트릭스 재편 로드맵 3단계(F3): `PlatformStatusMatrix` 의 클러스터명 클릭이 여기로 온다.
 * 카탈로그/실행/로그는 `ClusterOpsCheckPanel`(구 `/ops-checks/:clusterId` 에서 추출) 재사용.
 * 애드온·현황 아이템·대시보드 플레이북·히트맵·일일 리포트는 구 `/cluster-overview` 에서 옮겨 왔다.
 */
export function ClusterDetailPage() {
  const { data: clusters = [] } = useClusters();
  const { clusterId, selectCluster } = useClusterRouteParam('/clusters', clusters);
  const cluster = clusters.find((c) => c.id === clusterId);
  const isDisconnected = cluster?.status === 'pending';
  const toast = useToast();
  const { canOperate, withHint, ariaWithHint } = useCanOperate(clusterId || null);

  const hub = useK8sHub();
  const { data: breakdown, isLoading: breakdownLoading, isError: breakdownError, refetch: refetchBreakdown } =
    useClusterStatusBreakdown(clusterId || undefined);
  const [showHealthy, setShowHealthy] = useState(false);
  const sortedContributors = useMemo(
    () => [...(breakdown?.contributors ?? [])].sort((a, b) => severityRank(a.status) - severityRank(b.status)),
    [breakdown],
  );
  const healthyCount = sortedContributors.filter((c) => severityRank(c.status) === 3).length;
  const visibleContributors = showHealthy ? sortedContributors : sortedContributors.filter((c) => severityRank(c.status) !== 3);
  const lastCheckedAt = useMemo(() => {
    const times = (breakdown?.contributors ?? []).map((c) => c.checkedAt).filter((t): t is string => !!t);
    return times.length ? times.reduce((a, b) => (parseUTC(a) > parseUTC(b) ? a : b)) : null;
  }, [breakdown]);

  // 미연결 시 점검 카드 영역은 `inert` — 포인터뿐 아니라 키보드 포커스도 막는다(React 18 은 inert 속성 미지원 → ref).
  const disconnectedRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (disconnectedRef.current) disconnectedRef.current.inert = isDisconnected;
  }, [isDisconnected, clusterId]);

  // 점검 실행 로그 — 점검 실행 · 애드온 단건 ▶ · 현황 아이템 ▶ · 플레이북 실행이 공유한다(D-135).
  const runLog = useRunLog();
  const [showRunLog, setShowRunLog] = useLogPref('dashboard-health-check');

  const [showAddAddon, setShowAddAddon] = useState(false);
  const [editingAddon, setEditingAddon] = useState<Addon | null>(null);
  const [showItemModal, setShowItemModal] = useState(false);
  const [editingItem, setEditingItem] = useState<ClusterItem | null>(null);
  const [runningItemIds, setRunningItemIds] = useState<Set<string>>(new Set());
  const [showKubeconfig, setShowKubeconfig] = useState(false);
  const [showPlaybookModal, setShowPlaybookModal] = useState(false);
  const [editingPlaybook, setEditingPlaybook] = useState<Playbook | null>(null);
  const [credsTarget, setCredsTarget] = useState<Playbook | null>(null);
  // 세션 자격증명으로 바로 나가던 플레이북 ▶ 의 실행 전 확인(D-141).
  const [playbookRunConfirm, setPlaybookRunConfirm] = useState<{ pb: Playbook; creds: PlaybookSshCreds } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null);

  // 애드온
  const { data: addons = [], isLoading: addonsLoading } = useAddons(clusterId);
  const healthCheck = useHealthCheck();
  const createAddon = useCreateAddon();
  const deleteAddon = useDeleteAddon();
  const addonHealthCheck = useAddonHealthCheck();
  const existingTypes = new Set(addons.map((a) => a.type));
  const missingAddons = DEFAULT_ADDONS.filter((a) => !existingTypes.has(a.type));

  // 현황 아이템
  const { data: clusterItems = [], isLoading: itemsLoading } = useClusterItems(clusterId);
  const runClusterItem = useRunClusterItem(clusterId);
  const updateClusterItem = useUpdateClusterItem(clusterId);
  const deleteClusterItem = useDeleteClusterItem(clusterId);

  // 클러스터 상세에 표시하도록 지정된 플레이북
  const { data: pinnedPlaybooks = [] } = useDashboardPlaybooks(clusterId);
  const { runningIds } = usePlaybookStore();
  const runPlaybook = useRunPlaybook();
  const deletePlaybook = useDeletePlaybook();
  const updatePlaybook = useUpdatePlaybook();
  const toggleDashboard = useToggleDashboard();

  // 최근 점검 이력 — 전 클러스터 로그 중 이 클러스터만.
  const { data: historyLogs = [], isLoading: historyLoading } = useCheckHistoryHeatmap();
  const clusterLogs = historyLogs.filter((l) => l.clusterId === clusterId);

  const handleRunCheck = async () => {
    if (!cluster) return;
    const t0 = performance.now();
    const run = runLog.begin(`점검 실행 — ${cluster.name}`, `${cluster.name} 애드온 점검 요청`);
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
    } catch (e) {
      clearInterval(hb);
      run.log('error', `[${cluster.name}] 점검 실패 · ${elapsed(t0)} — ${formatApiError(e)}`);
    }
    run.end();
  };

  const handleRunAddon = (addon: Addon) => {
    void runLogged(runLog, {
      title: `애드온 점검 — ${addon.name}`,
      first: `${cluster ? `[${cluster.name}] ` : ''}${addon.name} 점검 요청`,
      fn: () => addonHealthCheck.mutateAsync({ clusterId: addon.clusterId, addonId: addon.id }),
      summarize: ({ data }) => addonCheckLines(addon, data),
    });
  };

  const handleAddDefaultAddons = async () => {
    if (!clusterId) return;
    const run = runLog.begin('기본 점검 항목 추가', `${cluster ? `[${cluster.name}] ` : ''}기본 점검 항목 ${missingAddons.length}개 추가 요청`);
    const results = await Promise.allSettled(
      missingAddons.map((addon) => createAddon.mutateAsync({ clusterId, ...addon })),
    );
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') run.log('info', `${missingAddons[i].name} · 추가됨`);
      else run.log('error', `${missingAddons[i].name} · 추가 실패 — ${formatApiError(r.reason)}`);
    });
    run.end();
  };

  const handleRunItem = (item: ClusterItem) => {
    setRunningItemIds((prev) => new Set(prev).add(item.id));
    void runLogged(runLog, {
      title: `현황 아이템 수집 — ${item.title}`,
      first: `${cluster ? `[${cluster.name}] ` : ''}${item.title}(${item.itemType}) 수집 요청`,
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

  const handleResizeItem = (item: ClusterItem, size: ClusterItemCardSize) => {
    updateClusterItem.mutate({ id: item.id, data: { cardSize: size } });
  };

  const runPlaybookLogged = (pb: Playbook, creds: PlaybookSshCreds) => {
    const clusterName = clusters.find((c) => c.id === pb.clusterId)?.name ?? pb.clusterId;
    void runLogged(runLog, {
      title: `플레이북 실행 — ${pb.name}`,
      first: `${pb.name} — ${clusterName} 대상 실행 요청${creds.ssh_username ? ` (SSH ${creds.ssh_username})` : ''}`,
      fn: (run) => runPlaybook.mutateAsync({ id: pb.id, creds, run }),
      summarize: ({ data }) => playbookRunLines(data),
      heartbeatMs: 0,
    });
  };

  const handleRunPlaybook = (playbook: Playbook) => {
    // 세션 캐시된 자격증명이 있으면 확인 후 실행, 없으면 모달.
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
      case 'playbook':
        deletePlaybook.mutate(pendingDelete.playbook.id);
        break;
    }
    setPendingDelete(null);
  };

  const pendingDeleteTitle = pendingDelete && {
    clusterItem: `아이템 "${pendingDelete.kind === 'clusterItem' ? pendingDelete.item.title : ''}" 을(를) 삭제할까요?`,
    addon: `점검 항목 "${pendingDelete.kind === 'addon' ? pendingDelete.addon.name : ''}" 을(를) 삭제할까요?`,
    playbook: `플레이북 "${pendingDelete.kind === 'playbook' ? pendingDelete.playbook.name : ''}" 을(를) 삭제할까요?`,
  }[pendingDelete.kind];

  const handleDailyReport = async (fmt: 'md' | 'csv') => {
    try {
      const { data } = await healthApi.exportReport(clusterId || undefined, fmt);
      const blob = data instanceof Blob ? data : new Blob([data], { type: fmt === 'csv' ? 'text/csv' : 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const today = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `k8s-daily-report-${cluster?.name ?? 'cluster'}-${today}.${fmt}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error('리포트 다운로드 실패', formatApiError(e));
    }
  };

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
        <div className="sticky top-4 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            onSelect={selectCluster}
            iconOnly
          />
        </div>

        <div className="flex-1 min-w-0 space-y-4">
          {/* header */}
          <div className="flex items-center gap-3 flex-wrap">
            <PageHeader
              back={{ to: '/', label: '홈' }}
              title={cluster && !hub ? `${cluster.name} — 클러스터 상세` : '클러스터 상세'}
              description={clusterId && !breakdownLoading && breakdown ? (
                <span className="inline-flex items-center gap-2 flex-wrap">
                  <StatusBadge variant={statusToVariant(breakdown.status)} size="sm" />
                  <span>
                    {breakdown.contributors.length === 0
                      ? '아직 점검 결과가 없습니다'
                      : `${breakdown.contributors.length}개 신호 종합`}
                    {lastCheckedAt && ` · 마지막 점검 ${formatRelativeTime(lastCheckedAt)}`}
                  </span>
                </span>
              ) : undefined}
              className="flex-1 min-w-[200px]"
            />
            {clusterId && (
              <>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button type="button" className={HEADER_BTN} title="일일 리포트 내보내기" aria-label="일일 리포트 내보내기">
                      <Download className="w-3.5 h-3.5" /> 내보내기 <ChevronDown className="w-3 h-3" />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content align="end" sideOffset={4} className={MENU_CONTENT}>
                      <DropdownMenu.Item className={MENU_ITEM} onSelect={() => { void handleDailyReport('md'); }}>
                        마크다운 (.md)
                      </DropdownMenu.Item>
                      <DropdownMenu.Item className={MENU_ITEM} onSelect={() => { void handleDailyReport('csv'); }}>
                        CSV (.csv)
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button type="button" className={HEADER_BTN} title="더 보기" aria-label="더 보기">
                      <MoreHorizontal className="w-3.5 h-3.5" /> 더 보기
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content align="end" sideOffset={4} className={MENU_CONTENT}>
                      <DropdownMenu.Item asChild className={MENU_ITEM}>
                        <Link to={`/k8s/${clusterId}/review`}>
                          <ClipboardCheck className="w-3.5 h-3.5" /> 결과 리뷰
                        </Link>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item asChild className={MENU_ITEM}>
                        <Link to="/daily-check/settings">
                          <Settings className="w-3.5 h-3.5" /> 점검 항목 관리
                        </Link>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item className={MENU_ITEM} disabled={!canOperate} onSelect={() => setShowKubeconfig(true)}
                        title={withHint('접속 정보(kubeconfig) 편집')}>
                        <KeyRound className="w-3.5 h-3.5" /> 접속 정보(kubeconfig)
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
                <button
                  type="button"
                  onClick={handleRunCheck}
                  disabled={!canOperate || !cluster || runLog.running || healthCheck.isPending}
                  title={withHint('애드온 점검 실행')}
                  aria-label={ariaWithHint('점검 실행')}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${runLog.running || healthCheck.isPending ? 'animate-spin' : ''}`} />
                  {runLog.running || healthCheck.isPending ? '점검 중…' : '점검 실행'}
                </button>
              </>
            )}
          </div>

          {/* 상태 근거 — 상태 요약은 헤더 한 줄, 여기는 원인(위험 → 경고 순, 정상은 접음) */}
          <MacCard title="상태 근거">
            {breakdownLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <Loader2 className="w-4 h-4 animate-spin" /> 불러오는 중…
              </div>
            ) : breakdownError || !breakdown ? (
              <div className="flex items-center gap-2 text-sm text-status-critical py-4">
                <AlertTriangle className="w-4 h-4" /> 종합 상태를 불러오지 못했습니다.
                <button type="button" onClick={() => { void refetchBreakdown(); }} className={`${HEADER_BTN} ml-2 text-foreground`}>
                  <RefreshCw className="w-3.5 h-3.5" /> 다시 시도
                </button>
              </div>
            ) : breakdown.contributors.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">아직 점검 결과가 없습니다. 「점검 실행」으로 첫 결과를 만들어 보세요.</p>
            ) : (
              <div className="space-y-1">
                {visibleContributors.length === 0 && (
                  <p className="text-sm text-muted-foreground py-1">경고·위험 신호가 없습니다.</p>
                )}
                {visibleContributors.length > 0 && (
                  <div className="divide-y divide-border/50">
                    {visibleContributors.map((c, i) => (
                      <ContributorRow key={`${c.sourceType}-${c.sourceRef}-${i}`} c={c} />
                    ))}
                  </div>
                )}
                {healthyCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowHealthy((v) => !v)}
                    aria-expanded={showHealthy}
                    className="text-sm text-muted-foreground hover:text-foreground underline-offset-2 hover:underline pt-1"
                  >
                    {showHealthy ? '정상 항목 접기' : `정상 ${healthyCount}개 보기`}
                  </button>
                )}
              </div>
            )}
          </MacCard>

          <RunLogPanel
            run={runLog}
            show={showRunLog}
            onShowChange={setShowRunLog}
            actions={
              <CancelPlaybookRunsButton
                onRequested={(n, failed) => runLog.log(failed > 0 ? 'warn' : 'info',
                  `플레이북 실행 취소 요청 ${n}건${failed > 0 ? ` · ${failed}건 요청 실패` : ''}`)}
              />
            }
          />

          {clusterId && (
            <>
              {/* 애드온 점검 */}
              <MacCard
                title="애드온"
                titleExtra={<span className="text-xs text-muted-foreground tabular-nums">{addons.length}개</span>}
                bodyPadding="p-4"
                className="overflow-hidden"
                rootClassName="min-w-0"
                actions={
                  <button
                    type="button"
                    onClick={() => { setEditingAddon(null); setShowAddAddon(true); }}
                    disabled={!canOperate}
                    title={withHint('점검 항목 추가')}
                    aria-label={ariaWithHint('점검 항목 추가')}
                    className="inline-flex items-center gap-1 rounded-xl border border-border bg-secondary px-2.5 py-1 text-sm hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Plus className="w-3 h-3" /> 점검 항목
                  </button>
                }
              >
                {isDisconnected && (
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
                <div ref={disconnectedRef} className={isDisconnected ? 'opacity-70 select-none' : ''}>
                  <AddonGrid
                    addons={addons}
                    isLoading={addonsLoading}
                    onAddDefaultAddons={!isDisconnected && missingAddons.length > 0 && canOperate ? handleAddDefaultAddons : undefined}
                    onEditAddon={(addon) => { setEditingAddon(addon); setShowAddAddon(true); }}
                    onDeleteAddon={(addon) => setPendingDelete({ kind: 'addon', addon })}
                    onRunAddon={handleRunAddon}
                  />
                </div>
              </MacCard>

              {/* 현황 아이템 (클러스터에 붙는 단위 카드) */}
              <MacCard title="현황 아이템" bodyPadding="p-4" className="overflow-hidden" rootClassName="min-w-0">
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
            </>
          )}

          <ClusterOpsCheckPanel clusterId={clusterId} clusterName={cluster?.name} />

          {clusterId && pinnedPlaybooks.length > 0 && (
            <MacCard
              title="플레이북 점검"
              icon={BookOpen}
              titleExtra={<span className="text-xs text-muted-foreground tabular-nums">{pinnedPlaybooks.length}개</span>}
              bodyPadding="p-4"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                {pinnedPlaybooks.map((playbook) => (
                  <PlaybookCard
                    key={playbook.id}
                    playbook={playbook}
                    isRunning={runningIds.has(playbook.id)}
                    onRun={() => handleRunPlaybook(playbook)}
                    onDelete={() => setPendingDelete({ kind: 'playbook', playbook })}
                    onToggleDashboard={() => toggleDashboard.mutate(playbook.id)}
                    onEdit={() => { setEditingPlaybook(playbook); setShowPlaybookModal(true); }}
                  />
                ))}
              </div>
            </MacCard>
          )}

          {clusterId && (
            <MacCard title="최근 점검 이력" bodyPadding="p-0">
              <CheckHistoryHeatmap logs={clusterLogs} isLoading={historyLoading} />
            </MacCard>
          )}
        </div>
      </PageShell>

      {clusterId && (
        <>
          <AddAddonModal
            isOpen={showAddAddon}
            onClose={() => { setShowAddAddon(false); setEditingAddon(null); }}
            clusterId={clusterId}
            editingAddon={editingAddon}
          />
          <ClusterItemModal
            isOpen={showItemModal}
            onClose={() => { setShowItemModal(false); setEditingItem(null); }}
            clusterId={clusterId}
            editingItem={editingItem}
          />
          <KubeconfigEditModal
            clusterId={clusterId}
            clusterName={cluster?.name ?? ''}
            isOpen={showKubeconfig}
            onClose={() => setShowKubeconfig(false)}
          />
        </>
      )}

      <AddPlaybookModal
        isOpen={showPlaybookModal}
        onClose={() => { setShowPlaybookModal(false); setEditingPlaybook(null); }}
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
        defaultClusterId={clusterId}
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
