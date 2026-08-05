import { Fragment, useId, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ViewModeBar, DebugLogPanel, useToast, DoubleScrollX, ConfirmDialog, Skeleton, SkeletonTable, EmptyState } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { formatApiError } from '@/lib/utils';
import {
  Server, AlertTriangle, Search, ChevronDown,
  LayoutList, LayoutGrid, Network, Loader2, GripVertical, Globe, Tag,
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
import { SortableContext, rectSortingStrategy, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

type GroupByMode = 'none' | 'region' | 'level';

// ── CIDR 겹침 유틸 ────────────────────────────────────────────────────────────
function cidrIpToNum(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) | parseInt(o, 10), 0) >>> 0;
}
function parseCidrRange(cidr: string): { start: number; end: number } | null {
  const m = cidr.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
  if (!m) return null;
  // 정규식은 `999.1.1.1` 도 통과시키므로 옥텟 범위를 따로 본다 — 잘못된 값이 겹침
  // 판정에 참여하면 있지도 않은 충돌을 경고하게 된다 (D-053).
  const octets = m[1].split('.').map((o) => parseInt(o, 10));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
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
// sortEnabled=false(수동 정렬 아님)면 useSortable 을 비활성하고 핸들을 숨긴다 —
// 이름/상태순에서는 드롭 직후 재정렬돼 되돌아간 것처럼 보이기 때문 (D-045).
function SortableClusterCard(
  { sortEnabled, ...props }: Parameters<typeof ClusterCard>[0] & { sortEnabled: boolean },
) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.cluster.id, disabled: !sortEnabled });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} className="relative group/card">
      {sortEnabled && (
        <button
          {...attributes} {...listeners}
          className="absolute top-2 left-2 z-10 cursor-grab active:cursor-grabbing p-1 rounded text-muted-foreground/30 opacity-0 group-hover/card:opacity-100 hover:text-muted-foreground hover:bg-secondary transition-all"
          title="드래그하여 순서 변경 (정렬: 수동 모드)"
          aria-label="순서 변경 핸들"
        >
          <GripVertical className="w-4 h-4" />
        </button>
      )}
      <ClusterCard {...props} />
    </div>
  );
}

// ── 메인 페이지 ───────────────────────────────────────────────────────────────
export function ClusterManagePage() {
  const navigate = useNavigate();
  const { clusters } = useClusterStore();
  // 로딩/조회실패를 "등록된 클러스터가 없습니다" 로 위장하지 않도록 쿼리 상태를 사용한다 (D-043).
  const { isLoading: clustersLoading, isError: clustersError, error: clustersLoadError, refetch: refetchClusters } = useClusters();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [deletingId, setDeletingId]       = useState<string | null>(null);
  // 삭제는 Addon/Playbook/점검 이력까지 캐스케이드되므로 native confirm 이 아니라
  // ConfirmDialog(danger) 로 게이팅한다 (D-048).
  const [deleteTarget, setDeleteTarget]   = useState<Cluster | null>(null);
  // auto-update 는 클러스터별로 동시에 돌 수 있으므로 진행 상태·중단 컨트롤러를
  // 단일 슬롯이 아니라 per-cluster 로 관리한다 (D-047).
  const [autoUpdatingIds, setAutoUpdatingIds] = useState<Set<string>>(new Set());
  const autoUpdateAbortsRef = useRef<Map<string, AbortController>>(new Map());
  const [applyingId, setApplyingId]       = useState<string | null>(null);
  const [collectingNodeIpsId, setCollectingNodeIpsId] = useState<string | null>(null);
  const [bulkCollecting, setBulkCollecting] = useState(false);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkProgress, setBulkProgress]   = useState<{ done: number; total: number } | null>(null);
  const bulkAbortRef = useRef(false);
  // SSH 기반 NIC 수집 모달 — bond0/bond1 IP/MAC 채우기 위한 진입점.
  // kubectl 자동수집(auto-update)은 인터페이스 이름을 알 수 없어 별도 SSH 수집이 필요하다.
  const [nicsClusterId, setNicsClusterId] = useState<string | null>(null);

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  // 검색/필터/정렬/그룹/뷰모드를 URL 에 영속화 — 새로고침·공유·뒤로가기에서 유지된다
  // (D-029 후속 "목록 필터 URL 저장", D-038 의 `?tab=` 패턴 준용: `replace: true` 라
  //  필터 조작이 히스토리에 쌓이지 않아 전역 뒤로가기를 되짚지 않는다). (D-053)
  const [searchParams, setSearchParams] = useSearchParams();
  const setParam = (key: string, value: string, defaultValue: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === defaultValue) next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  };
  const search      = searchParams.get('q') ?? '';
  const filterLevel = searchParams.get('level') ?? '';
  const sortParam   = searchParams.get('sort');
  const sortBy: 'name' | 'status' | 'level' | 'manual' =
    sortParam === 'name' || sortParam === 'status' || sortParam === 'level' ? sortParam : 'manual';
  const groupParam  = searchParams.get('group');
  const groupBy: GroupByMode = groupParam === 'region' || groupParam === 'level' ? groupParam : 'none';
  const viewMode: 'table' | 'card' = searchParams.get('view') === 'card' ? 'card' : 'table';
  const setSearch      = (v: string) => setParam('q', v, '');
  const setFilterLevel = (v: string) => setParam('level', v, '');
  const setSortBy      = (v: 'name' | 'status' | 'level' | 'manual') => setParam('sort', v, 'manual');
  const setGroupBy     = (v: GroupByMode) => setParam('group', v, 'none');
  const setViewMode    = (v: 'table' | 'card') => setParam('view', v, 'table');
  // 필터가 URL 에 있으면 패널을 펼친 상태로 시작 (딥링크 진입 시 조건이 보이게)
  const [showFilter, setShowFilter]       = useState(() => !!(search || filterLevel));
  const [standardizeOpen, setStandardizeOpen] = useState(false);
  const [ciliumCluster, setCiliumCluster] = useState<Cluster | null>(null);

  // Diff 팝업 상태 — 열려 있는 대상을 ref 로도 추적해, 다른 클러스터의 늦은 응답이
  // 열린 다이얼로그를 소리 없이 덮어쓰지 않게 한다 (D-047).
  const [diffCluster, setDiffCluster] = useState<Cluster | null>(null);
  const [diffRows, setDiffRows]       = useState<DiffRow[]>([]);
  const [diffWarnings, setDiffWarnings] = useState<string[]>([]);
  const diffClusterRef = useRef<Cluster | null>(null);

  const openDiff = (cluster: Cluster, rows: DiffRow[], warnings: string[]) => {
    diffClusterRef.current = cluster;
    setDiffCluster(cluster);
    setDiffRows(rows);
    setDiffWarnings(warnings);
  };
  const closeDiff = () => {
    diffClusterRef.current = null;
    setDiffCluster(null);
    setDiffRows([]);
    setDiffWarnings([]);
  };

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
      // seq 미할당 fallback 은 useClusters 의 정렬(?? 1000)과 동일하게 — 두 기준이
      // 다르면 미할당 클러스터의 위치가 화면마다 반대로 나온다 (D-045).
      if (sortBy === 'manual') return (a.seq ?? 1000) - (b.seq ?? 1000);
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

  // 그룹 헤더 표식 — 이모지 단독(🌐/🏷️)은 스크린리더/폰트에 따라 의미가 전달되지 않아
  // lucide 아이콘(aria-hidden) + 텍스트 라벨 조합으로 대체 (D-052).
  const GroupIcon = groupBy === 'region' ? Globe : Tag;
  const groupLabelPrefix = groupBy === 'region' ? '지역' : '운영레벨';

  // ── 드래그 순서 변경 ─────────────────────────────────────────────────────
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  // 드래그는 수동 정렬 모드에서만 — 이름/상태순에서는 드롭 직후 재정렬돼 되돌아간
  // 것처럼 보이고 seq 만 바뀐다 (D-045). 핸들 노출·useSortable 활성도 이 값을 따른다.
  const sortEnabled = sortBy === 'manual';

  const handleDragEnd = async (e: DragEndEvent) => {
    if (!sortEnabled) return;
    if (!e.over || e.active.id === e.over.id) return;
    const activeId = String(e.active.id);
    const overId = String(e.over.id);

    // 같은 그룹 내에서만 순서 변경 — 그룹간 이동은 region/operationLevel 자체 편집을 요구.
    const activeGroup = groupedClusters.find((g) => g.clusters.some((c) => c.id === activeId));
    const overGroup = groupedClusters.find((g) => g.clusters.some((c) => c.id === overId));
    if (!activeGroup || !overGroup || activeGroup.key !== overGroup.key) return;

    // 전송 순서는 화면(검색/필터된) 목록이 아니라 **전체 클러스터** 기준으로 만든다 —
    // 백엔드 reorder 는 받은 id 에만 seq 를 재할당하므로, 필터로 가려진 클러스터를 빼고
    // 보내면 그들의 옛 seq 사이로 끼어들어 전체 순서가 오염된다 (D-044).
    // 스토어 순서 = seq 정렬(useClusters)이고, arrayMove 는 이동 대상 외 상대 순서를
    // 보존하므로 가려진 클러스터의 자리도 그대로 유지된다.
    const fullIds = clusters.map((c) => c.id);
    const fromIdx = fullIds.indexOf(activeId);
    const toIdx = fullIds.indexOf(overId);
    if (fromIdx < 0 || toIdx < 0) return;
    const fullOrder = arrayMove(fullIds, fromIdx, toIdx);
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

  const handleDelete = (cluster: Cluster) => setDeleteTarget(cluster);

  const executeDelete = async () => {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    setDeletingId(target.id);
    try {
      await clustersApi.delete(target.id);
      queryClient.invalidateQueries({ queryKey: ['clusters'] });
      toast.success('클러스터 삭제됨', target.name);
    } catch (e) {
      toast.error('삭제 실패', formatApiError(e));
    } finally {
      setDeletingId(null);
    }
  };

  const handleAutoUpdate = async (cluster: Cluster) => {
    const aborts = autoUpdateAbortsRef.current;
    // 이미 수집 중인 클러스터면 중지 — 다른 클러스터의 진행에는 영향 없음 (D-047)
    const existing = aborts.get(cluster.id);
    if (existing) {
      existing.abort();
      return;
    }
    const ctrl = new AbortController();
    aborts.set(cluster.id, ctrl);
    setAutoUpdatingIds((prev) => new Set(prev).add(cluster.id));
    try {
      const { data } = await clustersApi.autoUpdate(cluster.id, {
        dryRun: true,
        signal: ctrl.signal,
      });
      const open = diffClusterRef.current;
      if (open && open.id !== cluster.id) {
        // 다른 클러스터의 diff 가 열려 있음 — 덮어쓰면 사용자가 엉뚱한 대상에 적용할 수 있다.
        toast.info(`${cluster.name} 수집 완료`, `${open.name} 의 변경 미리보기가 열려 있어 표시하지 않았습니다. 닫은 뒤 다시 새로고침하세요.`);
      } else {
        openDiff(cluster, (data.diff ?? []) as DiffRow[], data.warnings ?? []);
      }
    } catch (e: unknown) {
      const err = e as { name?: string; code?: string };
      if (err.name !== 'CanceledError' && err.code !== 'ERR_CANCELED') {
        toast.error('클러스터 정보 수집 실패', `${cluster.name}: ${formatApiError(e)}`);
      }
    } finally {
      aborts.delete(cluster.id);
      setAutoUpdatingIds((prev) => {
        const next = new Set(prev);
        next.delete(cluster.id);
        return next;
      });
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

  // 일괄 수집은 dryRun 없는 auto-update 를 N개 클러스터에 적용하는 위험 동작 —
  // 확인 다이얼로그로 게이팅하고, 진행률(n/N)·중단·실패 구분 토스트를 제공한다 (D-048).
  const bulkTargets = clusters.filter((c) => !c.nodeIps);

  const handleBulkCollectNodeIps = () => {
    if (bulkCollecting) {
      // 수집 중 재클릭 = 중단 요청 (다음 클러스터로 넘어가기 전에 반영)
      bulkAbortRef.current = true;
      return;
    }
    if (bulkTargets.length === 0) {
      toast.success('수집 대상 없음', '모든 클러스터에 노드 IP 가 이미 채워져 있습니다.');
      return;
    }
    setBulkConfirmOpen(true);
  };

  const executeBulkCollect = async () => {
    setBulkConfirmOpen(false);
    const targets = clusters.filter((c) => !c.nodeIps);
    if (targets.length === 0) return;
    setBulkCollecting(true);
    bulkAbortRef.current = false;
    setBulkProgress({ done: 0, total: targets.length });
    let ok = 0;
    let fail = 0;
    let aborted = false;
    for (const c of targets) {
      if (bulkAbortRef.current) { aborted = true; break; }
      try {
        await clustersApi.autoUpdate(c.id);
        ok += 1;
      } catch {
        fail += 1;
      }
      setBulkProgress({ done: ok + fail, total: targets.length });
    }
    await queryClient.refetchQueries({ queryKey: ['clusters'] });
    setBulkCollecting(false);
    setBulkProgress(null);
    const summary = `성공 ${ok} · 실패 ${fail} · 대상 ${targets.length}${aborted ? ' · 중단됨' : ''}`;
    if (fail > 0 && ok === 0) toast.error('일괄 수집 실패', summary);
    else if (fail > 0) toast.warning('일괄 수집 부분 실패', summary);
    else if (aborted) toast.info('일괄 수집 중단됨', summary);
    else toast.success('일괄 수집 완료', summary);
  };

  const handleApplyDiff = async () => {
    if (!diffCluster) return;
    setApplyingId(diffCluster.id);
    try {
      await clustersApi.autoUpdate(diffCluster.id);
      queryClient.invalidateQueries({ queryKey: ['clusters'] });
      toast.success('클러스터 정보 갱신됨', diffCluster.name);
      closeDiff();
    } catch (e: unknown) {
      toast.error('적용 실패', formatApiError(e));
    } finally {
      setApplyingId(null);
    }
  };

  return (
    <div className="app-min-h-screen bg-background">
      <main className="max-w-[2400px] mx-auto px-4 py-6">
        <DebugLogPanel pageKey="cluster-manage" extra={{ clusters: clusters.length, filtered: filteredClusters.length, autoUpdating: [...autoUpdatingIds].join(','), diffRowsCount: diffRows.length }} />

        {/* 페이지 헤더 — 액션이 많아 좁은 폭에서 줄바꿈 허용 (D-051) */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <div className="flex flex-wrap items-center gap-3">
            <Server className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">클러스터 관리</h1>
            {clusters.length > 0 && (
              <span className="text-sm px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">
                {filteredClusters.length} / {clusters.length}
              </span>
            )}
            {overlapCount > 0 && (
              <span
                className="flex items-center gap-1 text-sm px-2 py-0.5 rounded-full bg-status-warning/10 text-status-warning border border-status-warning/30"
                title="INTERNAL_IP / Pod / Service CIDR 이 다른 클러스터와 겹치는 클러스터 수"
              >
                <AlertTriangle className="w-3 h-3" aria-hidden />
                {/* 쌍(pair) 수가 아니라 겹침에 연루된 클러스터 수 — 문구를 실제 값에 맞춤 (D-053) */}
                CIDR 겹침 클러스터 {overlapCount}개
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
              disabled={!bulkCollecting && clusters.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary/10 hover:bg-primary/20 border border-primary/30 rounded-lg text-primary transition-colors disabled:opacity-50"
              title={bulkCollecting
                ? '클릭하면 다음 클러스터로 넘어가기 전에 수집을 중단합니다'
                : 'nodeIps 가 비어있는 모든 클러스터에 대해 auto-update 호출 (실행 전 대상·범위 확인)'}
            >
              {bulkCollecting
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Network className="w-3.5 h-3.5" />}
              {bulkCollecting
                ? `수집중 ${bulkProgress?.done ?? 0}/${bulkProgress?.total ?? 0} — 중단`
                : '노드 IP 일괄 수집'}
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

        {/* 검색 / 필터 패널 — 수제 카드 div 대신 MacCard (D-050) */}
        {showFilter && (
          <MacCard title="검색 / 필터" rootClassName="mb-5" className="flex flex-wrap items-end gap-3">
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
                className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground bg-secondary border border-border rounded-xl transition-colors">
                초기화
              </button>
            )}
          </MacCard>
        )}

        {/* 클러스터 목록 — 로딩/조회실패/0건 3분기 (D-043) */}
        {clusters.length === 0 && clustersLoading ? (
          <MacCard bodyPadding="p-0">
            <div aria-busy="true">
              <div className="px-3 py-2.5 bg-secondary border-b border-border flex gap-6">
                {[90, 60, 70, 90, 120, 110, 80, 130].map((w, i) => <Skeleton key={i} width={w} height={12} />)}
              </div>
              <table className="w-full text-sm">
                <tbody>
                  <SkeletonTable rows={6} columns={8} />
                </tbody>
              </table>
            </div>
          </MacCard>
        ) : clusters.length === 0 && clustersError ? (
          <EmptyState
            icon={AlertTriangle}
            title="클러스터 목록을 불러오지 못했습니다."
            description={formatApiError(clustersLoadError)}
            action={{ label: '다시 시도', onClick: () => { void refetchClusters(); }, variant: 'secondary' }}
          />
        ) : clusters.length === 0 ? (
          <EmptyState
            icon={Server}
            title="등록된 클러스터가 없습니다."
            description="클러스터 등록과 API/kubeconfig 설정은 Settings → 클러스터 탭에서 할 수 있습니다."
            action={{ label: 'Settings 에서 클러스터 등록', onClick: () => navigate('/settings?tab=clusters') }}
          />
        ) : filteredClusters.length === 0 ? (
          <EmptyState
            icon={Search}
            title="검색 결과가 없습니다."
            description="검색어나 운영레벨 필터를 바꿔 보세요."
            action={(search || filterLevel)
              ? { label: '필터 초기화', onClick: () => { setSearch(''); setFilterLevel(''); }, variant: 'secondary' }
              : undefined}
          />
        ) : viewMode === 'table' ? (
          <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          {/* 수제 카드 div → MacCard (D-050). 본문에 max-h 를 줘 세로 스크롤을 만들고
              thead 를 sticky 로 고정 — 13열+커스텀열 표에서 헤더가 사라지지 않게 (D-051) */}
          <MacCard bodyPadding="p-0">
            <DoubleScrollX bodyClassName="max-h-[calc(100vh-16rem)]">
              <table className="text-sm border-collapse" style={{ tableLayout: 'fixed', width: 'max-content', minWidth: '100%' }}>
                <colgroup>
                  {COLUMNS.map((c) => <col key={c.key} style={{ width: `${colW.getWidth(c.key)}px` }} />)}
                  {customFields.map((f) => <col key={`custom_${f.id}`} style={{ width: `${colW.getWidth(`custom_${f.id}`)}px` }} />)}
                  <col style={{ width: `${colW.getWidth('actions')}px` }} />
                </colgroup>
                {/* sticky 헤더 — border-collapse 에서는 sticky 셀의 border 가 사라지므로
                    구분선은 inset box-shadow 로 그린다. 배경은 반투명이면 행이 비쳐 보여 solid. */}
                <thead className="sticky top-0 z-10 bg-secondary">
                  <tr>
                    {COLUMNS.map((c) => (
                      <th key={c.key}
                        title={c.tip}
                        className={`relative px-3 py-2.5 text-left text-sm font-semibold text-muted-foreground shadow-[inset_0_-1px_0_hsl(var(--border))] ${c.center ? 'text-center' : ''}`}>
                        <span className="truncate inline-flex items-center gap-1 max-w-full align-middle cursor-help">
                          {c.label}
                          <span className="text-[10px] text-muted-foreground/50" aria-hidden>ⓘ</span>
                        </span>
                        <ResizeGrip onMouseDown={(e) => colW.beginResize(c.key, e)} onDoubleClick={() => colW.autoFit(c.key)} />
                      </th>
                    ))}
                    {customFields.map((f) => (
                      <th key={f.id}
                        className="relative px-3 py-2.5 text-left text-sm font-semibold text-primary/80 border-l border-primary/10 shadow-[inset_0_-1px_0_hsl(var(--border))]"
                        // 설명이 없으면 빈 title 대신 필드명을 안내 (빈 title 은 툴팁만 깜빡임)
                        title={f.description?.trim() || `커스텀 컬럼: ${f.label}`}>
                        <span className="truncate inline-block max-w-full align-middle">{f.label}</span>
                        <ResizeGrip onMouseDown={(e) => colW.beginResize(`custom_${f.id}`, e)} onDoubleClick={() => colW.autoFit(`custom_${f.id}`)} />
                      </th>
                    ))}
                    <th className="relative px-3 py-2.5 text-left text-sm font-semibold text-muted-foreground shadow-[inset_0_-1px_0_hsl(var(--border))]"
                      title="행 단위 동작 — 새로고침(자동수집 → diff 미리보기), 수정, 삭제. (Cilium 설정은 K8s/Cilium 셀 클릭으로 이동)">
                      <span className="inline-flex items-center gap-1 cursor-help">
                        편집
                        <span className="text-[10px] text-muted-foreground/50" aria-hidden>ⓘ</span>
                      </span>
                      <ResizeGrip onMouseDown={(e) => colW.beginResize('actions', e)} onDoubleClick={() => colW.autoFit('actions')} />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {groupedClusters.map((group) => (
                    <Fragment key={group.key}>
                      {group.label && (
                        <tr className="bg-primary/5 border-y border-primary/20">
                          <td colSpan={COLUMNS.length + customFields.length + 1}
                            className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-primary">
                            <span className="inline-flex items-center gap-1.5 align-middle">
                              <GroupIcon className="w-3 h-3" aria-hidden />
                              {groupLabelPrefix} {group.label}
                            </span>
                            <span className="ml-2 text-muted-foreground font-normal normal-case tracking-normal">
                              {group.clusters.length}개
                            </span>
                          </td>
                        </tr>
                      )}
                      <SortableContext items={group.clusters.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                        {group.clusters.map((cluster) => (
                          <ClusterTableRow
                            key={cluster.id}
                            cluster={cluster}
                            onEdit={c => navigate(`/cluster-manage/${c.id}/edit`)}
                            onDelete={handleDelete}
                            deletingId={deletingId}
                            overlapGroupIdx={cidrOverlapGroups.get(cluster.id)}
                            onCilium={c => setCiliumCluster(c)}
                            onAutoUpdate={handleAutoUpdate}
                            autoUpdating={autoUpdatingIds.has(cluster.id)}
                            customFields={customFields}
                            onCollectNodeIps={collectNodeIps}
                            collectingNodeIpsId={collectingNodeIpsId}
                            onCollectNics={(c) => setNicsClusterId(c.id)}
                            sortable={sortEnabled}
                          />
                        ))}
                      </SortableContext>
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </DoubleScrollX>
          </MacCard>
          </DndContext>
        ) : (
          <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <div className="space-y-5">
              {groupedClusters.map((group) => (
                <div key={group.key}>
                  {group.label && (
                    <div className="flex items-baseline gap-2 mb-2 px-1 border-l-2 border-primary pl-3">
                      <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-primary">
                        <GroupIcon className="w-3 h-3" aria-hidden />
                        {groupLabelPrefix} {group.label}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {group.clusters.length}개
                      </span>
                    </div>
                  )}
                  <SortableContext items={group.clusters.map((c) => c.id)} strategy={rectSortingStrategy}>
                    {/* 좁은 폭에서 가로 오버플로가 나지 않게 min() 패턴 (D-025·D-051) */}
                    <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))' }}>
                      {group.clusters.map((cluster) => (
                        <SortableClusterCard
                          key={cluster.id}
                          cluster={cluster}
                          onEdit={c => navigate(`/cluster-manage/${c.id}/edit`)}
                          onDelete={handleDelete}
                          deletingId={deletingId}
                          overlapGroupIdx={cidrOverlapGroups.get(cluster.id)}
                          onAutoUpdate={handleAutoUpdate}
                          autoUpdating={autoUpdatingIds.has(cluster.id)}
                          onCollectNics={(c) => setNicsClusterId(c.id)}
                          sortEnabled={sortEnabled}
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
        onCancel={() => { if (!applyingId) closeDiff(); }}
        onConfirm={handleApplyDiff}
      />

      <ClusterCustomFieldsManager
        open={customFieldsOpen}
        onClose={() => setCustomFieldsOpen(false)}
      />

      {/* 클러스터 삭제 확인 — 캐스케이드 삭제 범위를 명시 (D-048) */}
      <ConfirmDialog
        open={!!deleteTarget}
        danger
        title="클러스터 삭제"
        description={deleteTarget ? `"${deleteTarget.name}" 클러스터를 삭제합니다.` : undefined}
        confirmLabel="삭제"
        onConfirm={executeDelete}
        onCancel={() => setDeleteTarget(null)}
      >
        <p className="text-muted-foreground">
          이 동작은 되돌릴 수 없으며, 클러스터에 연관된{' '}
          <strong className="text-foreground">Addon · Playbook · 점검 이력이 모두 함께 삭제</strong>됩니다.
        </p>
      </ConfirmDialog>

      {/* 노드 IP 일괄 수집 확인 — 대상 수·갱신 범위를 명시 (D-048) */}
      <ConfirmDialog
        open={bulkConfirmOpen}
        title="노드 IP 일괄 수집"
        description={`노드 IP 가 비어 있는 클러스터 ${bulkTargets.length}개에 auto-update 를 적용합니다.`}
        confirmLabel={`${bulkTargets.length}개 수집 시작`}
        onConfirm={executeBulkCollect}
        onCancel={() => setBulkConfirmOpen(false)}
      >
        <div className="space-y-2 text-muted-foreground">
          <p>
            diff 미리보기 없이 kubeconfig 수집 결과가 바로 반영됩니다 — 노드 IP 외에도{' '}
            <strong className="text-foreground">hostname · CIDR · K8s/Cilium 버전 · Max Pods</strong> 등이
            함께 갱신될 수 있습니다.
          </p>
          <p className="text-xs">
            대상: {bulkTargets.slice(0, 8).map((c) => c.name).join(', ')}
            {bulkTargets.length > 8 && ` 외 ${bulkTargets.length - 8}개`}
          </p>
          <p className="text-xs">진행 중에는 버튼을 다시 눌러 언제든 중단할 수 있습니다.</p>
        </div>
      </ConfirmDialog>

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
