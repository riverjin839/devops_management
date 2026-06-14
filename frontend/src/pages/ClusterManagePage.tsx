import { useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ViewModeBar, DebugLogPanel, useToast, DoubleScrollX } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import {
  Server, AlertTriangle, Search, ChevronDown,
  LayoutList, LayoutGrid, Network, Loader2, GripVertical,
} from 'lucide-react';
import type { Cluster } from '@/types';
import { useClusters } from '@/hooks/useCluster';
import { useClusterStore } from '@/stores/clusterStore';
import { clustersApi } from '@/services/api';
import { useQueryClient } from '@tanstack/react-query';
import {
  CiliumConfigModal,
  ClusterCard,
  ClusterTableRow,
  ClusterUpdateDiffDialog,
  ClusterCustomFieldsManager,
  type DiffRow,
} from '@/components/cluster-manage';
import { NodeNicsCollectModal } from '@/components/versions';
import { useOperationLevels, levelLabel } from '@/hooks/useOperationLevels';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { ResizeGrip } from '@/components/common';
import { useClusterCustomFields, sortedFields } from '@/hooks/useClusterCustomFields';
import { Settings2, Wand2 } from 'lucide-react';
import { StandardizeClusterNamesModal } from '@/components/cluster-manage/StandardizeClusterNamesModal';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

type GroupByMode = 'none' | 'region' | 'level';

// ── CIDR 겹침 유틸 ────────────────────────────────────────────────────────────
function cidrIpToNum(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) | parseInt(o, 10), 0) >>> 0;
}
function parseCidrRange(cidr: string): { start: number; end: number } | null {
  const m = cidr.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
  if (!m) return null;
  const prefix = parseInt(m[2], 10);
  if (prefix < 0 || prefix > 32) return null;
  const ipNum = cidrIpToNum(m[1]);
  const mask  = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const net   = (ipNum & mask) >>> 0;
  const bcast = (net | (~mask >>> 0)) >>> 0;
  return { start: net, end: bcast };
}
function cidrsOverlap(a: string, b: string): boolean {
  const ra = parseCidrRange(a), rb = parseCidrRange(b);
  return !!ra && !!rb && ra.start <= rb.end && rb.start <= ra.end;
}

const STATUS_ORDER: Record<string, number> = { critical: 0, warning: 1, healthy: 2, pending: 3 };

// ── 드래그 가능한 ClusterCard 래퍼 ────────────────────────────────────────────
function SortableClusterCard(
  props: Parameters<typeof ClusterCard>[0],
) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.cluster.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} className="relative group/card">
      <button
        {...attributes} {...listeners}
        className="absolute top-2 left-2 z-10 cursor-grab active:cursor-grabbing p-1 rounded text-muted-foreground/30 opacity-0 group-hover/card:opacity-100 hover:text-muted-foreground hover:bg-secondary transition-all"
        title="드래그하여 순서 변경"
        aria-label="순서 변경 핸들"
      >
        <GripVertical className="w-4 h-4" />
      </button>
      <ClusterCard {...props} />
    </div>
  );
}

// ── 메인 페이지 ───────────────────────────────────────────────────────────────
export function ClusterManagePage() {
  const navigate = useNavigate();
  const { clusters } = useClusterStore();
  useClusters();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [deletingId, setDeletingId]       = useState<string | null>(null);
  const [autoUpdatingId, setAutoUpdatingId] = useState<string | null>(null);
  const [applyingId, setApplyingId]       = useState<string | null>(null);
  const [collectingNodeIpsId, setCollectingNodeIpsId] = useState<string | null>(null);
  const [bulkCollecting, setBulkCollecting] = useState(false);
  // SSH 기반 NIC 수집 모달 — bond0/bond1 IP/MAC 채우기 위한 진입점.
  // kubectl 자동수집(auto-update)은 인터페이스 이름을 알 수 없어 별도 SSH 수집이 필요하다.
  const [nicsClusterId, setNicsClusterId] = useState<string | null>(null);

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const [search, setSearch]               = useState('');
  const [filterLevel, setFilterLevel]     = useState('');
  const [sortBy, setSortBy]               = useState<'name' | 'status' | 'level' | 'manual'>('manual');
  const [groupBy, setGroupBy]             = useState<GroupByMode>('none');
  const [showFilter, setShowFilter]       = useState(false);
  const [standardizeOpen, setStandardizeOpen] = useState(false);
  const [viewMode, setViewMode]           = useState<'table' | 'card'>('table');
  const [ciliumCluster, setCiliumCluster] = useState<Cluster | null>(null);

  // Diff 팝업 상태
  const [diffCluster, setDiffCluster] = useState<Cluster | null>(null);
  const [diffRows, setDiffRows]       = useState<DiffRow[]>([]);
  const [diffWarnings, setDiffWarnings] = useState<string[]>([]);
  const autoUpdateAbortRef = useRef<AbortController | null>(null);

  // 커스텀 필드
  const [customFieldsOpen, setCustomFieldsOpen] = useState(false);
  const { data: customFieldsRaw } = useClusterCustomFields();
  const customFields = sortedFields(customFieldsRaw);
  const { data: opsLevels = [] } = useOperationLevels();

  // 컬럼 너비 — drag 로 사용자 정의, localStorage 영속화
  // tip: 헤더 마우스오버 시 보여줄 의미 + 데이터 출처. (사용자 요청: 모든 항목 마우스 오버 설명)
  const COLUMNS: { key: string; label: string; w: number; center?: boolean; tip: string }[] = [
    { key: 'name',     label: '클러스터명',  w: 160,
      tip: '사용자가 등록 시 입력한 이름. 마스터 노드 hostname 은 자동수집 시 그 아래 작게 표시됨.' },
    { key: 'status',   label: '상태',         w: 90,
      tip: '주기적 헬스체크 결과 (healthy/warning/critical/pending). 점검 → /api/v1/health 가 종합 판정.' },
    { key: 'region',   label: '지역',         w: 100,
      tip: '운영 지역 라벨. 사용자가 직접 입력하며 그룹/필터 키로 사용됩니다 (예: 서울, IDC1).' },
    { key: 'level',    label: '운영레벨',     w: 130,
      tip: 'Settings → 운영레벨 탭에서 정의한 레벨 (예: 운영/검증/개발). 클러스터 그룹/필터 키로도 사용.' },
    { key: 'bgp',      label: 'BGP / AS',    w: 110,
      tip: 'Cilium 의 cilium-config ConfigMap 에서 enable-bgp-control-plane 과 cluster-pool 의 AS 번호를 자동 추출. ConfigMap 이 없으면 비어 있음.' },
    { key: 'cidr',     label: 'INTERNAL_IP', w: 220,
      tip: 'kubectl get nodes -o wide 의 InternalIP 들을 /24 단위로 묶어 정규식/Glob 형식으로 표시 (예: 10.0.1.[5-7,10]). nodeIps 미수집 상태에서는 수동 입력 CIDR 을 fallback 으로 표시.' },
    { key: 'bond0',    label: 'bond0',       w: 180,
      tip: '모든 노드의 NIC 수집 결과 중 interfaces[].name === "bond0" 인 IP 들을 같은 정규식/Glob 형식으로 묶어 표시 (예: 10.0.1.[5-7,10]). NIC 수집(SSH) 후에만 채워짐.' },
    { key: 'bond1',    label: 'bond1',       w: 180,
      tip: '모든 노드의 NIC 수집 결과 중 interfaces[].name === "bond1" 인 IP 들을 같은 정규식/Glob 형식으로 묶어 표시. NIC 수집(SSH) 후에만 채워짐.' },
    { key: 'pod',      label: 'Pod CIDR',    w: 150,
      tip: 'kube-controller-manager 정적 Pod 의 --cluster-cidr 플래그에서 추출. 관리형 K8s 라 플래그를 못 읽으면 비어 있음.' },
    { key: 'svc',      label: 'Svc CIDR',    w: 150,
      tip: 'kube-apiserver 정적 Pod 의 --service-cluster-ip-range 플래그에서 추출.' },
    { key: 'maxpod',   label: 'Max Pods',    w: 80, center: true,
      tip: '마스터 노드의 status.allocatable.pods 값 — 한 노드에 띄울 수 있는 최대 Pod 수.' },
    { key: 'k8s',      label: 'K8s / Cilium', w: 160,
      tip: 'k8s 버전: VersionApi.get_code() 의 git_version. Cilium 버전: cilium-config ConfigMap 의 cilium-version 또는 cilium-agent 이미지 태그. 셀 클릭 시 Cilium 설정 보기.' },
    { key: 'nodeip',   label: '노드 IP',     w: 320,
      tip: '주: kubectl get nodes 의 InternalIP. NIC 상세(bond0/bond1, public/private)는 [버전·설정] 페이지의 NIC 수집(SSH 기반) 이후에 채워짐.' },
  ];
  const columnDefaults: Record<string, number> = Object.fromEntries(COLUMNS.map((c) => [c.key, c.w]));
  customFields.forEach((f) => { columnDefaults[`custom_${f.id}`] = f.width ?? 140; });
  columnDefaults['actions'] = 100;
  const colW = useColumnWidths('cluster-table', { defaults: columnDefaults, min: 60, max: 800 });

  const filteredClusters = useMemo(() => {
    let list = [...clusters];
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(c =>
        c.name.toLowerCase().includes(q) ||
        (c.region ?? '').toLowerCase().includes(q) ||
        (c.hostname ?? '').toLowerCase().includes(q) ||
        (c.apiEndpoint ?? '').toLowerCase().includes(q),
      );
    }
    if (filterLevel) list = list.filter(c => c.operationLevel === filterLevel);
    list.sort((a, b) => {
      if (sortBy === 'status') return (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3);
      if (sortBy === 'level')  return (a.operationLevel ?? '').localeCompare(b.operationLevel ?? '');
      if (sortBy === 'manual') return (a.seq ?? 0) - (b.seq ?? 0);
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [clusters, search, filterLevel, sortBy]);

  // ── 그룹화 ──────────────────────────────────────────────────────────────────
  // groupBy === 'none' 면 단일 그룹 (label 없음). 그 외는 키별로 묶고 빈 값은 "(미지정)" 으로 표시.
  const groupedClusters = useMemo(() => {
    if (groupBy === 'none') {
      return [{ key: '_all', label: '', clusters: filteredClusters }];
    }
    const buckets = new Map<string, Cluster[]>();
    for (const c of filteredClusters) {
      const raw = groupBy === 'region' ? c.region : c.operationLevel;
      const key = (raw ?? '').trim() || '_unset';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(c);
    }
    // 그룹 정렬: 미지정은 마지막, 나머지는 알파벳/사용자 정의 순.
    const entries = Array.from(buckets.entries());
    entries.sort((a, b) => {
      if (a[0] === '_unset') return 1;
      if (b[0] === '_unset') return -1;
      return a[0].localeCompare(b[0]);
    });
    return entries.map(([key, list]) => ({
      key,
      label: key === '_unset'
        ? '(미지정)'
        : (groupBy === 'level' ? levelLabel(opsLevels, key) : key),
      clusters: list,
    }));
  }, [filteredClusters, groupBy, opsLevels]);

  // ── 드래그 순서 변경 ─────────────────────────────────────────────────────
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = async (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const activeId = String(e.active.id);
    const overId = String(e.over.id);

    // 같은 그룹 내에서만 순서 변경 — 그룹간 이동은 region/operationLevel 자체 편집을 요구.
    const activeGroup = groupedClusters.find((g) => g.clusters.some((c) => c.id === activeId));
    const overGroup = groupedClusters.find((g) => g.clusters.some((c) => c.id === overId));
    if (!activeGroup || !overGroup || activeGroup.key !== overGroup.key) return;

    const oldIdx = activeGroup.clusters.findIndex((c) => c.id === activeId);
    const newIdx = activeGroup.clusters.findIndex((c) => c.id === overId);
    if (oldIdx < 0 || newIdx < 0) return;

    const reorderedGroup = arrayMove(activeGroup.clusters, oldIdx, newIdx);
    // 전체 클러스터 정렬: 영향받지 않은 그룹은 그대로 + 영향받은 그룹만 새 순서.
    const fullOrder: string[] = [];
    for (const g of groupedClusters) {
      const slice = g.key === activeGroup.key ? reorderedGroup : g.clusters;
      for (const c of slice) fullOrder.push(c.id);
    }
    try {
      await clustersApi.reorder(fullOrder);
      queryClient.invalidateQueries({ queryKey: ['clusters'] });
    } catch (err) {
      toast.error('순서 변경 실패', formatApiError(err));
    }
  };

  const cidrOverlapGroups = useMemo(() => {
    if (clusters.length < 2) return new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const c of clusters) adj.set(c.id, []);
    const keys: (keyof Cluster)[] = ['cidr', 'podCidr', 'svcCidr'];
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const ci = clusters[i], cj = clusters[j];
        let overlap = false;
        outer: for (const ki of keys) {
          for (const kj of keys) {
            const vi = ci[ki] as string | undefined;
            const vj = cj[kj] as string | undefined;
            if (vi && vj && cidrsOverlap(vi, vj)) { overlap = true; break outer; }
          }
        }
        if (overlap) { adj.get(ci.id)!.push(cj.id); adj.get(cj.id)!.push(ci.id); }
      }
    }
    const groupMap = new Map<string, number>();
    const visited  = new Set<string>();
    let gIdx = 0;
    for (const c of clusters) {
      if (visited.has(c.id) || (adj.get(c.id)?.length ?? 0) === 0) continue;
      const q = [c.id];
      visited.add(c.id);
      while (q.length) {
        const id = q.shift()!;
        groupMap.set(id, gIdx);
        for (const nb of adj.get(id) ?? []) {
          if (!visited.has(nb)) { visited.add(nb); q.push(nb); }
        }
      }
      gIdx++;
    }
    return groupMap;
  }, [clusters]);

  const overlapCount = cidrOverlapGroups.size;

  const handleDelete = async (cluster: Cluster) => {
    if (!confirm(`"${cluster.name}" 클러스터를 삭제하시겠습니까?\n연관된 Addon, Playbook, 점검 이력이 모두 삭제됩니다.`)) return;
    setDeletingId(cluster.id);
    try {
      await clustersApi.delete(cluster.id);
      queryClient.invalidateQueries({ queryKey: ['clusters'] });
      toast.success('클러스터 삭제됨', cluster.name);
    } catch (e) {
      toast.error('삭제 실패', formatApiError(e));
    } finally {
      setDeletingId(null);
    }
  };

  const handleAutoUpdate = async (cluster: Cluster) => {
    // 이미 수집 중인 클러스터면 중지
    if (autoUpdatingId === cluster.id && autoUpdateAbortRef.current) {
      autoUpdateAbortRef.current.abort();
      return;
    }
    setAutoUpdatingId(cluster.id);
    autoUpdateAbortRef.current = new AbortController();
    try {
      const { data } = await clustersApi.autoUpdate(cluster.id, {
        dryRun: true,
        signal: autoUpdateAbortRef.current.signal,
      });
      setDiffCluster(cluster);
      setDiffRows((data.diff ?? []) as DiffRow[]);
      setDiffWarnings(data.warnings ?? []);
    } catch (e: unknown) {
      const err = e as { name?: string; code?: string };
      if (err.name !== 'CanceledError' && err.code !== 'ERR_CANCELED') {
        toast.error('클러스터 정보 수집 실패', formatApiError(e));
      }
    } finally {
      setAutoUpdatingId(null);
      autoUpdateAbortRef.current = null;
    }
  };

  // 노드 IP 만 즉시 수집 — diff 다이얼로그 없이 auto-update 결과를 바로 반영.
  // 백엔드 auto-update 가 nodeIps + nodeCount + hostname + cidr 등을 같이 갱신하므로
  // 추가 엔드포인트 없이 dryRun=false 호출 한 번이면 충분.
  // ※ invalidate 만 하면 Zustand 스토어가 다음 폴링 틱(30s) 까지 stale 일 수 있어
  //   refetchQueries 로 즉시 갱신을 보장.
  const collectNodeIps = async (cluster: Cluster) => {
    setCollectingNodeIpsId(cluster.id);
    try {
      await clustersApi.autoUpdate(cluster.id);
      await queryClient.refetchQueries({ queryKey: ['clusters'] });
      toast.success('수집 완료', `${cluster.name} 의 노드 IP / k8s 버전 등이 갱신됐습니다.`);
    } catch (e: unknown) {
      toast.error('노드 IP 수집 실패', formatApiError(e));
    } finally {
      setCollectingNodeIpsId(null);
    }
  };

  const handleBulkCollectNodeIps = async () => {
    const targets = clusters.filter((c) => !c.nodeIps);
    if (targets.length === 0) {
      toast.success('수집 대상 없음', '모든 클러스터에 노드 IP 가 이미 채워져 있습니다.');
      return;
    }
    setBulkCollecting(true);
    let ok = 0;
    let fail = 0;
    for (const c of targets) {
      try {
        await clustersApi.autoUpdate(c.id);
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    await queryClient.refetchQueries({ queryKey: ['clusters'] });
    setBulkCollecting(false);
    toast.success('일괄 수집 종료', `성공 ${ok} · 실패 ${fail} · 대상 ${targets.length}`);
  };

  const handleApplyDiff = async () => {
    if (!diffCluster) return;
    setApplyingId(diffCluster.id);
    try {
      await clustersApi.autoUpdate(diffCluster.id);
      queryClient.invalidateQueries({ queryKey: ['clusters'] });
      toast.success('클러스터 정보 갱신됨', diffCluster.name);
      setDiffCluster(null);
      setDiffRows([]);
      setDiffWarnings([]);
    } catch (e: unknown) {
      toast.error('적용 실패', formatApiError(e));
    } finally {
      setApplyingId(null);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <main className="max-w-[2400px] mx-auto px-4 py-6">
        <DebugLogPanel pageKey="cluster-manage" extra={{ clusters: clusters.length, filtered: filteredClusters.length, autoUpdatingId, diffRowsCount: diffRows.length }} />

        {/* 페이지 헤더 */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Server className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">클러스터 관리</h1>
            {clusters.length > 0 && (
              <span className="text-sm px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-400 border border-slate-500/30">
                {filteredClusters.length} / {clusters.length}
              </span>
            )}
            {overlapCount > 0 && (
              <span className="flex items-center gap-1 text-sm px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/30">
                <AlertTriangle className="w-3 h-3" />
                CIDR 겹침 {overlapCount}건
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <ViewModeBar
              modes={[
                { id: 'table', label: '테이블', icon: <LayoutList className="w-3.5 h-3.5" /> },
                { id: 'card',  label: '카드',   icon: <LayoutGrid className="w-3.5 h-3.5" /> },
              ]}
              active={viewMode}
              onChange={(v) => setViewMode(v as 'table' | 'card')}
              showStylePanel={false}
            />
            <button
              onClick={() => setStandardizeOpen(true)}
              disabled={clusters.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors text-muted-foreground hover:text-foreground disabled:opacity-50"
              title="기존 클러스터 이름을 [업무명]-[운영타입]-[속성] 표준으로 정리"
            >
              <Wand2 className="w-3.5 h-3.5" />
              이름 표준화
            </button>
            <button
              onClick={() => setCustomFieldsOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors text-muted-foreground hover:text-foreground"
              title="테이블에 커스텀 컬럼 추가/수정/삭제"
            >
              <Settings2 className="w-3.5 h-3.5" />
              컬럼 관리 {customFields.length > 0 && <span className="text-primary">({customFields.length})</span>}
            </button>
            <button
              onClick={handleBulkCollectNodeIps}
              disabled={bulkCollecting || clusters.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary/10 hover:bg-primary/20 border border-primary/30 rounded-lg text-primary transition-colors disabled:opacity-50"
              title="nodeIps 가 비어있는 모든 클러스터에 대해 auto-update 호출 (diff 다이얼로그 없이 즉시 반영)"
            >
              {bulkCollecting
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Network className="w-3.5 h-3.5" />}
              {bulkCollecting ? '수집중…' : '노드 IP 일괄 수집'}
            </button>
            <button
              onClick={colW.reset}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors text-muted-foreground hover:text-foreground"
              title="저장된 컬럼 너비를 기본값으로 되돌립니다"
            >
              너비 리셋
            </button>
            <button
              onClick={() => setShowFilter(v => !v)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors text-muted-foreground hover:text-foreground"
            >
              검색 / 필터
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showFilter ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>

        {/* 검색 / 필터 패널 */}
        {showFilter && (
          <div className="mb-5 p-4 bg-card border border-border rounded-xl flex flex-wrap items-end gap-3">
            <div className="flex-1 min-w-[200px]">
              <label htmlFor={f('search')} className="block text-sm text-muted-foreground mb-1">검색</label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <input
                  id={f('search')}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="이름, 지역, 호스트명, API Endpoint"
                  className="w-full pl-8 pr-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
            <div className="min-w-[160px]">
              <label htmlFor={f('level')} className="block text-sm text-muted-foreground mb-1">운영레벨</label>
              <select id={f('level')} value={filterLevel} onChange={(e) => setFilterLevel(e.target.value)}
                className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary">
                <option value="">전체</option>
                {opsLevels.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            <div className="min-w-[140px]">
              <label htmlFor={f('sort')} className="block text-sm text-muted-foreground mb-1">정렬</label>
              <select id={f('sort')} value={sortBy} onChange={(e) => setSortBy(e.target.value as 'name' | 'status' | 'level' | 'manual')}
                className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary">
                <option value="manual">수동(드래그)</option>
                <option value="name">이름순</option>
                <option value="status">상태순</option>
                <option value="level">운영레벨순</option>
              </select>
            </div>
            <div className="min-w-[140px]">
              <label htmlFor={f('group')} className="block text-sm text-muted-foreground mb-1">그룹</label>
              <select id={f('group')} value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupByMode)}
                className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary">
                <option value="none">그룹 없음</option>
                <option value="region">지역별</option>
                <option value="level">운영레벨별</option>
              </select>
            </div>
            {(search || filterLevel) && (
              <button onClick={() => { setSearch(''); setFilterLevel(''); }}
                className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground bg-secondary border border-border rounded-lg transition-colors">
                초기화
              </button>
            )}
          </div>
        )}

        {/* 클러스터 목록 */}
        {clusters.length === 0 ? (
          <div className="text-center py-20">
            <Server className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
            <p className="text-muted-foreground">등록된 클러스터가 없습니다.</p>
            <p className="text-sm text-muted-foreground/70 mt-1">Settings 페이지에서 클러스터를 먼저 등록하세요.</p>
          </div>
        ) : filteredClusters.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Search className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>검색 결과가 없습니다.</p>
          </div>
        ) : viewMode === 'table' ? (
          <div className="rounded-xl border border-border overflow-hidden">
            <DoubleScrollX>
              <table className="text-sm border-collapse" style={{ tableLayout: 'fixed', width: 'max-content', minWidth: '100%' }}>
                <colgroup>
                  {COLUMNS.map((c) => <col key={c.key} style={{ width: `${colW.getWidth(c.key)}px` }} />)}
                  {customFields.map((f) => <col key={`custom_${f.id}`} style={{ width: `${colW.getWidth(`custom_${f.id}`)}px` }} />)}
                  <col style={{ width: `${colW.getWidth('actions')}px` }} />
                </colgroup>
                <thead className="bg-secondary/50">
                  <tr className="border-b border-border">
                    {COLUMNS.map((c) => (
                      <th key={c.key}
                        title={c.tip}
                        className={`relative px-3 py-2.5 text-left text-sm font-semibold text-muted-foreground ${c.center ? 'text-center' : ''}`}>
                        <span className="truncate inline-flex items-center gap-1 max-w-full align-middle cursor-help">
                          {c.label}
                          <span className="text-[10px] text-muted-foreground/50">ⓘ</span>
                        </span>
                        <ResizeGrip onMouseDown={(e) => colW.beginResize(c.key, e)} onDoubleClick={() => colW.autoFit(c.key)} />
                      </th>
                    ))}
                    {customFields.map((f) => (
                      <th key={f.id}
                        className="relative px-3 py-2.5 text-left text-sm font-semibold text-primary/80 border-l border-primary/10"
                        title={f.description ?? ''}>
                        <span className="truncate inline-block max-w-full align-middle">{f.label}</span>
                        <ResizeGrip onMouseDown={(e) => colW.beginResize(`custom_${f.id}`, e)} onDoubleClick={() => colW.autoFit(`custom_${f.id}`)} />
                      </th>
                    ))}
                    <th className="relative px-3 py-2.5 text-left text-sm font-semibold text-muted-foreground"
                      title="행 단위 동작 — 새로고침(자동수집 → diff 미리보기), 수정, 삭제. (Cilium 설정은 K8s/Cilium 셀 클릭으로 이동)">
                      <span className="inline-flex items-center gap-1 cursor-help">
                        편집
                        <span className="text-[10px] text-muted-foreground/50">ⓘ</span>
                      </span>
                      <ResizeGrip onMouseDown={(e) => colW.beginResize('actions', e)} onDoubleClick={() => colW.autoFit('actions')} />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groupedClusters.flatMap((group) => {
                    const rows: React.ReactNode[] = [];
                    if (group.label) {
                      rows.push(
                        <tr key={`hdr-${group.key}`} className="bg-primary/5 border-y border-primary/20">
                          <td colSpan={COLUMNS.length + customFields.length + 1}
                            className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-primary">
                            {groupBy === 'region' ? '🌐' : '🏷️'} {group.label}
                            <span className="ml-2 text-muted-foreground font-normal normal-case tracking-normal">
                              {group.clusters.length}개
                            </span>
                          </td>
                        </tr>,
                      );
                    }
                    for (const cluster of group.clusters) {
                      rows.push(
                        <ClusterTableRow
                          key={cluster.id}
                          cluster={cluster}
                          onEdit={c => navigate(`/cluster-manage/${c.id}/edit`)}
                          onDelete={handleDelete}
                          deletingId={deletingId}
                          overlapGroupIdx={cidrOverlapGroups.get(cluster.id)}
                          onCilium={c => setCiliumCluster(c)}
                          onAutoUpdate={handleAutoUpdate}
                          autoUpdatingId={autoUpdatingId}
                          customFields={customFields}
                          onCollectNodeIps={collectNodeIps}
                          collectingNodeIpsId={collectingNodeIpsId}
                          onCollectNics={(c) => setNicsClusterId(c.id)}
                        />,
                      );
                    }
                    return rows;
                  })}
                </tbody>
              </table>
            </DoubleScrollX>
          </div>
        ) : (
          <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <div className="space-y-5">
              {groupedClusters.map((group) => (
                <div key={group.key}>
                  {group.label && (
                    <div className="flex items-baseline gap-2 mb-2 px-1 border-l-2 border-primary pl-3">
                      <span className="text-xs font-bold uppercase tracking-wider text-primary">
                        {groupBy === 'region' ? '🌐' : '🏷️'} {group.label}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {group.clusters.length}개
                      </span>
                    </div>
                  )}
                  <SortableContext items={group.clusters.map((c) => c.id)} strategy={rectSortingStrategy}>
                    <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
                      {group.clusters.map((cluster) => (
                        <SortableClusterCard
                          key={cluster.id}
                          cluster={cluster}
                          onEdit={c => navigate(`/cluster-manage/${c.id}/edit`)}
                          onDelete={handleDelete}
                          deletingId={deletingId}
                          overlapGroupIdx={cidrOverlapGroups.get(cluster.id)}
                          onAutoUpdate={handleAutoUpdate}
                          autoUpdatingId={autoUpdatingId}
                          onCollectNics={(c) => setNicsClusterId(c.id)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </div>
              ))}
            </div>
          </DndContext>
        )}

        <p className="text-sm text-muted-foreground mt-6 text-center">
          클러스터 등록 및 API/kubeconfig 설정은 <strong>Settings</strong> 페이지에서 할 수 있습니다.
        </p>
      </main>

      <StandardizeClusterNamesModal
        open={standardizeOpen}
        clusters={clusters}
        onClose={() => setStandardizeOpen(false)}
        onRenamed={() => queryClient.invalidateQueries({ queryKey: ['clusters'] })}
      />

      {ciliumCluster && (
        <CiliumConfigModal
          cluster={ciliumCluster}
          onClose={() => setCiliumCluster(null)}
        />
      )}

      <ClusterUpdateDiffDialog
        open={!!diffCluster}
        clusterName={diffCluster?.name ?? ''}
        diff={diffRows}
        warnings={diffWarnings}
        applying={applyingId === diffCluster?.id}
        onCancel={() => { if (!applyingId) { setDiffCluster(null); setDiffRows([]); setDiffWarnings([]); } }}
        onConfirm={handleApplyDiff}
      />

      <ClusterCustomFieldsManager
        open={customFieldsOpen}
        onClose={() => setCustomFieldsOpen(false)}
      />

      {nicsClusterId && (
        <NodeNicsCollectModal
          open
          clusterId={nicsClusterId}
          onClose={() => {
            setNicsClusterId(null);
            // SSH 수집이 cluster.node_ips 의 interfaces[] 를 갱신했을 수 있으므로
            // 즉시 캐시 무효화 — bond0/bond1 컬럼이 곧바로 채워지게 한다.
            queryClient.invalidateQueries({ queryKey: ['clusters'] });
          }}
        />
      )}
    </div>
  );
}
