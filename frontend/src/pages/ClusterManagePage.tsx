import { Fragment, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ViewModeBar, DebugLogPanel, useToast, DoubleScrollX, ConfirmDialog, Skeleton, SkeletonTable, EmptyState, PageHeader, RunLogPanel } from '@/components/common';
import { useModalA11y } from '@/components/common/useModalA11y';
import { MacCard } from '@/components/ui/MacCard';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { formatApiError } from '@/lib/utils';
import {
  Server, AlertTriangle, Search, ChevronDown,
  LayoutList, LayoutGrid, Network, Loader2, GripVertical, Globe, Tag,
  Wrench, HelpCircle, ArrowDown,
} from 'lucide-react';
import type { Cluster } from '@/types';
import { useClusters } from '@/hooks/useCluster';
import { useClusterStore } from '@/stores/clusterStore';
import { useAuthStore, hasRole } from '@/stores/authStore';
import { clustersApi } from '@/services/api';
import { useRunLog, runLogged, type RunLogEntry } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { pickParam, useUrlParams } from '@/hooks/useUrlParams';
import { useQueryClient } from '@tanstack/react-query';
import {
  CiliumConfigModal,
  ClusterCard,
  ClusterTableRow,
  ClusterUpdateDiffDialog,
  ClusterCustomFieldsManager,
  verifyClusterLogged,
  diffFieldLabel,
  renderDiffValue,
  type DiffRow,
} from '@/components/cluster-manage';
import { NodeNicsCollectModal } from '@/components/versions';
import { useOperationLevels, levelLabel } from '@/hooks/useOperationLevels';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { ResizeGrip, PageShell } from '@/components/common';
import { useClusterCustomFields, sortedFields } from '@/hooks/useClusterCustomFields';
import { EyeOff, Settings2, Wand2 } from 'lucide-react';
import { StandardizeClusterNamesModal } from '@/components/cluster-manage/StandardizeClusterNamesModal';
import { DndContext, closestCenter, PointerSensor, KeyboardSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, verticalListSortingStrategy, sortableKeyboardCoordinates, useSortable, arrayMove } from '@dnd-kit/sortable';
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

type SortKey = 'name' | 'status' | 'level' | 'manual';
// 헤더 클릭 정렬이 가능한 컬럼 → 정렬 키
const HEADER_SORT: Record<string, SortKey> = { name: 'name', status: 'status', level: 'level' };

// 실행 로그 한 줄에 담을 값 — 긴 값(ciliumConfig·nodeIps)은 줄여 쓴다. 전체 값은 행·카드에서 본다.
const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}…` : s);
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// ── 드래그 가능한 ClusterCard 래퍼 ────────────────────────────────────────────
// sortEnabled=false(수동 정렬 아님)면 useSortable 을 비활성하고 핸들을 숨긴다 —
// 이름/상태순에서는 드롭 직후 재정렬돼 되돌아간 것처럼 보이기 때문 (D-045).
function SortableClusterCard(
  { sortEnabled, ...props }: Parameters<typeof ClusterCard>[0] & { sortEnabled: boolean },
) {
  const canDrag = sortEnabled && (props.canEdit ?? true);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.cluster.id, disabled: !canDrag });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} className="relative group/card">
      {canDrag && (
        <button
          {...attributes} {...listeners}
          className="absolute top-2 left-2 z-10 cursor-grab active:cursor-grabbing p-1 rounded text-muted-foreground/30 opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 hover:text-muted-foreground hover:bg-secondary transition-colors"
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
  // 서버(require_operator)는 이미 막지만, 프론트도 viewer 에게 변경성 버튼을 숨겨
  // "눌러보고서야 403 으로 안다"를 없앤다.
  const authUser = useAuthStore((s) => s.user);
  const canEdit = hasRole(authUser, 'admin', 'operator');
  // /settings 는 RequireAdmin 라우트라 빈 상태의 등록 CTA 는 admin 에게만 보인다(D-129).
  const isAdmin = hasRole(authUser, 'admin');
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
  const [verifyingIds, setVerifyingIds] = useState<Set<string>>(new Set());
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
  // useUrlParams 는 다른 쿼리와 hash(모달 뒤로가기 기록)를 보존한다. Your Island 패널에
  // 임베드되면 훅이 로컬 state 로 동작한다.
  const [listParams, setListParams] = useUrlParams({ q: '', level: '', sort: 'manual', group: 'none', view: 'table', problems: '' });
  const search      = listParams.q;
  const filterLevel = listParams.level;
  const sortBy: SortKey = pickParam(listParams.sort, ['name', 'status', 'level', 'manual'] as const, 'manual');
  const groupBy: GroupByMode = pickParam(listParams.group, ['region', 'level', 'none'] as const, 'none');
  const viewMode = pickParam(listParams.view, ['table', 'card'] as const, 'table');
  // 「문제만」 — 경고·위험·미연결 상태이거나 CIDR 이 겹치는 클러스터만. 장애 대응 중 가장 먼저 찾는 목록.
  const problemsOnly = listParams.problems === '1';
  const setSearch      = (v: string) => setListParams({ q: v });
  const setFilterLevel = (v: string) => setListParams({ level: v });
  const setSortBy      = (v: SortKey) => setListParams({ sort: v });
  const setProblemsOnly = (v: boolean) => setListParams({ problems: v ? '1' : '' });
  const clearFilters = () => setListParams({ q: '', level: '', problems: '' });
  const hasFilters = !!(search || filterLevel || problemsOnly);
  const setGroupBy     = (v: GroupByMode) => setListParams({ group: v });
  const setViewMode    = (v: 'table' | 'card') => setListParams({ view: v });
  // 필터가 URL 에 있으면 패널을 펼친 상태로 시작 (딥링크 진입 시 조건이 보이게).
  // 검색은 툴바 상시 노출로 옮겨져 패널 펼침 조건에서 빠졌다.
  const [showFilter, setShowFilter]       = useState(() => !!filterLevel);
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

  // 커스텀 필드 — 조회 실패 시 컬럼이 소리 없이 사라지면 "정의가 지워졌나?" 오해를
  // 부르므로 isError 를 헤더 배지로 노출한다.
  const [customFieldsOpen, setCustomFieldsOpen] = useState(false);
  const { data: customFieldsRaw, isError: customFieldsError } = useClusterCustomFields();
  const customFields = sortedFields(customFieldsRaw);
  const { data: opsLevels = [] } = useOperationLevels();

  // ── 실행 로그 (CLAUDE.md 실행-로그 규칙, DESIGN_SYSTEM §12.9.1) ─────────────
  // 연결 검증·재수집·IP 수집·일괄 수집·적용을 화면 하나의 표준 실행 로그에 남긴다 — 건수 토스트로
  // 뭉개지 않고 대상별 한 줄씩(일괄 수집은 클러스터별 단계 칩 + 실패 사유). 펼침은 "로그 보기"가 정한다.
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('cluster-manage');
  const [lastBulkFailedIds, setLastBulkFailedIds] = useState<string[]>([]);

  // ── 기본 컬럼 표시/숨김 — IP 성격 컬럼 4개가 같은 nodeIps 데이터를 반복(≈900px)하던
  // 것을 사용자가 조절할 수 있게. bond0/bond1 은 기본 숨김(상세는 노드 IP 트리·카드 뷰·
  // NIC 수집 모달에 그대로 있고, 아래 도구 → 표시 컬럼에서 언제든 다시 켤 수 있다).
  const HIDDEN_COLS_KEY = 'pep:clusterManageHiddenCols';
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(HIDDEN_COLS_KEY);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* ignore */ }
    return new Set(['bond0', 'bond1']);
  });
  const toggleHiddenCol = (key: string) => {
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try { localStorage.setItem(HIDDEN_COLS_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  };

  // 컬럼 너비 — drag 로 사용자 정의, localStorage 영속화
  // tip: 헤더 마우스오버 시 보여줄 의미 + 데이터 출처. (사용자 요청: 모든 항목 마우스 오버 설명)
  const COLUMNS: { key: string; label: string; w: number; center?: boolean; tip: string }[] = [
    { key: 'name',     label: '클러스터명',  w: 160,
      tip: '사용자가 등록 시 입력한 이름. 마스터 노드 hostname 은 자동수집 시 그 아래 작게 표시됨.' },
    { key: 'status',   label: '상태',         w: 90,
      tip: '마지막 헬스체크·연결 검증의 종합 판정 (정상 / 경고 / 위험 / 미연결). 행의 연결 검증 버튼으로 바로 다시 판정할 수 있습니다. 머리글을 누르면 상태순으로 정렬됩니다.' },
    { key: 'region',   label: '지역',         w: 100,
      tip: '운영 지역 라벨. 사용자가 직접 입력하며 그룹/필터 키로 사용됩니다 (예: 서울, IDC1).' },
    { key: 'level',    label: '운영레벨',     w: 130,
      tip: '설정 → 운영레벨 탭에서 정의한 레벨 (예: 운영/검증/개발). 클러스터 그룹/필터 키로도 사용.' },
    { key: 'bgp',      label: 'BGP / AS',    w: 110,
      tip: 'Cilium 의 cilium-config ConfigMap 에서 enable-bgp-control-plane 과 cluster-pool 의 AS 번호를 자동 추출. ConfigMap 이 없으면 비어 있음.' },
    { key: 'cidr',     label: '내부 IP', w: 220,
      tip: '노드 InternalIP(kubectl get nodes -o wide)들을 /24 단위로 묶어 압축 표기 (예: 10.0.1.[5-7,10]). 노드 IP 를 아직 수집하지 않았으면 수동 입력 CIDR 을 대신 표시합니다.' },
    { key: 'bond0',    label: 'bond0',       w: 180,
      tip: '모든 노드의 bond0 인터페이스 IP 를 같은 압축 표기로 묶어 표시 (예: 10.0.1.[5-7,10]). 행의 NIC 수집(SSH) 후에 채워집니다.' },
    { key: 'bond1',    label: 'bond1',       w: 180,
      tip: '모든 노드의 bond1 인터페이스 IP 를 같은 압축 표기로 묶어 표시. 행의 NIC 수집(SSH) 후에 채워집니다.' },
    { key: 'pod',      label: 'Pod CIDR',    w: 150,
      tip: 'kube-controller-manager 정적 Pod 의 --cluster-cidr 플래그에서 추출. 관리형 K8s 라 플래그를 못 읽으면 비어 있습니다.' },
    { key: 'svc',      label: 'Service CIDR', w: 150,
      tip: 'kube-apiserver 정적 Pod 의 --service-cluster-ip-range 플래그에서 추출.' },
    { key: 'maxpod',   label: '노드당 최대 Pod', w: 110, center: true,
      tip: '마스터 노드의 할당 가능 Pod 수(allocatable.pods) — 한 노드에 띄울 수 있는 최대 Pod 수.' },
    { key: 'k8s',      label: 'K8s / Cilium', w: 160,
      tip: 'K8s 버전: API 서버가 보고하는 버전. Cilium 버전: cilium-config ConfigMap 또는 cilium-agent 이미지 태그. Cilium 칩을 누르면 Cilium 설정을 봅니다.' },
    { key: 'nodeip',   label: '노드 IP',     w: 320,
      tip: '노드별 InternalIP. NIC 상세(bond0/bond1, 공인/사설 IP)는 행의 NIC 수집(SSH) 버튼으로 채웁니다. 비어 있으면 셀의 재수집 버튼으로 바로 수집할 수 있습니다.' },
  ];
  const columnDefaults: Record<string, number> = Object.fromEntries(COLUMNS.map((c) => [c.key, c.w]));
  customFields.forEach((f) => { columnDefaults[`custom_${f.id}`] = f.width ?? 140; });
  // 행 동작 5개(검증·재수집·NIC·수정·삭제)가 잘리지 않는 폭 — 100px 이면 수정·삭제가 셀 밖으로 잘렸다.
  columnDefaults['actions'] = 184;
  const colW = useColumnWidths('cluster-table', { defaults: columnDefaults, min: 60, max: 800 });

  // 클러스터명은 항상 표시 — 나머지는 도구 → 표시 컬럼에서 토글.
  const visibleColumns = COLUMNS.filter((c) => c.key === 'name' || !hiddenCols.has(c.key));

  const { cidrOverlapGroups, overlapPeerNames } = useMemo(() => {
    if (clusters.length < 2) {
      return { cidrOverlapGroups: new Map<string, number>(), overlapPeerNames: new Map<string, string[]>() };
    }
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
    // CIDR 겹침 배지 툴팁용 — 그룹 전체가 아니라 실제 직접 겹치는 상대만 나열해야
    // "A-B, B-C 겹침, A-C 는 안 겹침"인 경우 A에게 C를 잘못 지목하지 않는다.
    const nameById = new Map(clusters.map((c) => [c.id, c.name]));
    const overlapPeerNames = new Map<string, string[]>();
    for (const [id, neighborIds] of adj) {
      if (neighborIds.length === 0) continue;
      overlapPeerNames.set(id, neighborIds.map((nid) => nameById.get(nid) ?? nid));
    }
    return { cidrOverlapGroups: groupMap, overlapPeerNames };
  }, [clusters]);

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
    if (problemsOnly) list = list.filter(c => c.status !== 'healthy' || cidrOverlapGroups.has(c.id));
    list.sort((a, b) => {
      if (sortBy === 'status') return (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3);
      if (sortBy === 'level')  return (a.operationLevel ?? '').localeCompare(b.operationLevel ?? '');
      // seq 미할당 fallback 은 useClusters 의 정렬(?? 1000)과 동일하게 — 두 기준이
      // 다르면 미할당 클러스터의 위치가 화면마다 반대로 나온다 (D-045).
      if (sortBy === 'manual') return (a.seq ?? 1000) - (b.seq ?? 1000);
      return a.name.localeCompare(b.name);
    });
    return list;
  }, [clusters, search, filterLevel, sortBy, problemsOnly, cidrOverlapGroups]);

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
  // KeyboardSensor 병행 등록 — 그립이 포커스 가능하고 "순서 변경 핸들"로 announce 되는데
  // Space/Arrow 가 무반응이면 보이는데 안 움직이는 가짜 affordance 가 된다 (D-052 후속).
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
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


  const overlapCount = cidrOverlapGroups.size;
  const problemCount = clusters.filter((c) => c.status !== 'healthy' || cidrOverlapGroups.has(c.id)).length;

  // 삭제 확인은 클러스터 이름 재입력으로 잠근다 — 운영 클러스터와 개발 클러스터의 삭제 마찰이
  // 같으면 엉뚱한 행에서 확인을 누르는 사고를 막지 못한다.
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const handleDelete = (cluster: Cluster) => { setDeleteConfirmName(''); setDeleteTarget(cluster); };

  const executeDelete = async () => {
    const target = deleteTarget;
    if (!target || deleteConfirmName.trim() !== target.name) return;
    setDeleteTarget(null);
    setDeletingId(target.id);
    try {
      // 연쇄 삭제라 실행 로그에 흔적을 남긴다 — 토스트는 사라지면 무엇을 지웠는지 화면에 남지 않는다.
      const r = await runLogged(runLog, {
        title: `클러스터 삭제 — ${target.name}`,
        first: `${target.name}${target.operationLevel ? ` (${levelLabel(opsLevels, target.operationLevel)})` : ''} 삭제 요청 — Addon · Playbook · 점검 이력 함께 삭제`,
        fn: () => clustersApi.delete(target.id).then(() => true),
        summarize: () => [['info', `${target.name} 삭제 완료`]],
      });
      if (r.ok) {
        queryClient.invalidateQueries({ queryKey: ['clusters'] });
        toast.success('클러스터 삭제됨', target.name);
      } else if (!r.aborted) {
        toast.error('삭제 실패', formatApiError(r.error));
      }
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
      const r = await runLogged(runLog, {
        title: `재수집 (미리보기) — ${cluster.name}`,
        first: `${cluster.name} kubeconfig 기반 정보 재수집 요청 — dry-run, 아직 반영하지 않음`,
        fn: () => clustersApi.autoUpdate(cluster.id, { dryRun: true, signal: ctrl.signal }).then((res) => res.data),
        summarize: (data) => {
          const changed = (data.diff ?? []).filter((d) => d.changed);
          const out: RunLogEntry[] = [[
            'info',
            `변경 ${changed.length}건 · 변경 없음 ${(data.diff ?? []).length - changed.length}건 미리보기${changed.length ? ` — ${changed.map((d) => diffFieldLabel(d.field)).join(', ')}` : ''}`,
          ]];
          for (const w of data.warnings ?? []) out.push(['warn', `경고 — ${w}`]);
          return out;
        },
      });
      if (r.ok) {
        const data = r.data;
        const open = diffClusterRef.current;
        if (open && open.id !== cluster.id) {
          // 다른 클러스터의 diff 가 열려 있음 — 덮어쓰면 사용자가 엉뚱한 대상에 적용할 수 있다.
          runLog.log('warn', `${open.name} 의 변경 미리보기가 열려 있어 ${cluster.name} 결과는 표시하지 않음`);
          toast.info(`${cluster.name} 재수집됨`, `${open.name} 의 변경 미리보기가 열려 있어 표시하지 않았습니다. 닫은 뒤 다시 재수집하세요.`);
        } else {
          openDiff(cluster, (data.diff ?? []) as DiffRow[], data.warnings ?? []);
        }
      } else if (!r.aborted) {
        toast.error('재수집 실패', `${cluster.name}: ${formatApiError(r.error)}`);
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

  // 연결 검증 — POST /clusters/{id}/verify/stream(SSE) 을 표준 실행 로그로 소비한다(verifyClusterLogged):
  // 단계(api_server / kubeconfig_auth / kubectl_nodes)가 시작·끝날 때마다 단계 칩과 로그 줄이 바로 쌓인다.
  // 진행 중 버튼을 다시 누르면 abort — 서버는 남은 단계를 실행하지 않고 상태도 바꾸지 않는다(감사: aborted).
  const verifyAbortRef = useRef<Map<string, AbortController>>(new Map());
  const handleVerify = async (cluster: Cluster) => {
    const running = verifyAbortRef.current.get(cluster.id);
    if (running) {
      running.abort();
      return;
    }
    const ac = new AbortController();
    verifyAbortRef.current.set(cluster.id, ac);
    setVerifyingIds((prev) => new Set(prev).add(cluster.id));
    try {
      const r = await verifyClusterLogged(runLog, cluster, ac.signal);
      if (r.ok) {
        if (r.data.ok) toast.success('연결 검증 통과', cluster.name);
        else toast.warning('연결 검증 실패 항목 있음', `${cluster.name} — 자세한 내용은 실행 로그`);
      } else if (r.aborted) {
        toast.info('연결 검증 중지', cluster.name);
      } else {
        toast.error('연결 검증 실패', `${cluster.name}: ${r.error instanceof Error ? r.error.message : formatApiError(r.error)}`);
      }
    } finally {
      verifyAbortRef.current.delete(cluster.id);
      setVerifyingIds((prev) => {
        const next = new Set(prev);
        next.delete(cluster.id);
        return next;
      });
      // 서버가 cluster.status 를 갱신했을 수 있으니 목록을 다시 읽는다.
      await queryClient.refetchQueries({ queryKey: ['clusters'] });
    }
  };

  // 바로 재수집 — 미리보기 없이 auto-update 결과를 바로 반영(실행 전 ConfirmDialog).
  // 백엔드 auto-update 가 nodeIps + nodeCount + hostname + cidr 등을 같이 갱신하므로
  // 추가 엔드포인트 없이 dryRun=false 호출 한 번이면 충분.
  // ※ invalidate 만 하면 Zustand 스토어가 다음 폴링 틱(30s) 까지 stale 일 수 있어
  //   refetchQueries 로 즉시 갱신을 보장.
  // 반영(dryRun 없음) 응답 요약 — 필드 이름만이 아니라 실제로 쓰인 값까지 줄로 남긴다.
  const autoUpdateLines = (data: { updated?: Record<string, unknown>; warnings?: string[] }): RunLogEntry[] => {
    const entries = Object.entries(data.updated ?? {});
    const out: RunLogEntry[] = [[
      'info',
      entries.length ? `반영된 필드 ${entries.length}개` : '반영된 필드 없음',
    ]];
    for (const [field, value] of entries) {
      out.push(['info', `  ${diffFieldLabel(field)} = ${clip(renderDiffValue(value, field))}`]);
    }
    for (const w of data.warnings ?? []) out.push(['warn', `경고 — ${w}`]);
    return out;
  };

  const collectNodeIps = async (cluster: Cluster) => {
    setCollectingNodeIpsId(cluster.id);
    try {
      const r = await runLogged(runLog, {
        title: `재수집 (바로 반영) — ${cluster.name}`,
        first: `${cluster.name} 재수집 요청 — 미리보기 없이 바로 반영`,
        fn: () => clustersApi.autoUpdate(cluster.id).then((res) => res.data),
        summarize: autoUpdateLines,
      });
      if (r.ok) {
        await queryClient.refetchQueries({ queryKey: ['clusters'] });
        toast.success('재수집됨', `${cluster.name} 의 노드 IP · K8s 버전 등이 갱신됐습니다. 반영된 값은 실행 로그에 있습니다.`);
      } else if (!r.aborted) {
        toast.error('재수집 실패', formatApiError(r.error));
      }
    } finally {
      setCollectingNodeIpsId(null);
    }
  };

  // per-row "IP 수집"도 일괄 경로와 동일하게 확인을 받는다 — 같은 API(dryRun 없는
  // auto-update)가 hostname/CIDR/버전/Max Pods 를 함께 덮어쓰는데 단건만 무게이트면
  // 마찰의 비대칭이 생긴다.
  const [collectConfirm, setCollectConfirm] = useState<Cluster | null>(null);

  // 일괄 수집은 dryRun 없는 auto-update 를 N개 클러스터에 적용하는 위험 동작 —
  // 확인 다이얼로그로 게이팅하고, 진행률(n/N)·중단·실패 구분 토스트를 제공한다 (D-048).
  // 대상 범위: 노드 IP 가 빈 클러스터만(신규 등록분 채우기) 또는 지금 화면에 보이는 목록 전체
  // (검색·필터·「문제만」으로 좁힌 뒤 오래된 값을 한 번에 갱신). 빈 것만 고를 수 있으면
  // 이미 IP 가 있는 오래된 클러스터는 일괄로 갱신할 방법이 없었다.
  const [bulkScope, setBulkScope] = useState<'empty' | 'visible'>('empty');
  const emptyTargets = clusters.filter((c) => !c.nodeIps);
  const bulkTargets = bulkScope === 'empty' ? emptyTargets : filteredClusters;

  const handleBulkCollectNodeIps = () => {
    if (bulkCollecting) {
      // 수집 중 재클릭 = 중단 요청 (다음 클러스터로 넘어가기 전에 반영)
      bulkAbortRef.current = true;
      return;
    }
    setBulkScope(emptyTargets.length > 0 ? 'empty' : 'visible');
    setBulkConfirmOpen(true);
  };

  // targetsOverride: 실패분 재시도 경로 — 확인 다이얼로그를 이미 거친 동일 동작의 반복이라
  // 재확인 없이 실행한다.
  const executeBulkCollect = async (targetsOverride?: Cluster[]) => {
    setBulkConfirmOpen(false);
    const targets = targetsOverride ?? bulkTargets;
    if (targets.length === 0) return;
    setBulkCollecting(true);
    bulkAbortRef.current = false;
    setBulkProgress({ done: 0, total: targets.length });
    // 클러스터를 클라이언트에서 순회한다 — 대상마다 단계 칩·결과 줄을 남기고, 한 대상 실패가
    // 전체를 멈추지 않는다. 실패를 익명 카운트로 삼키지 않고 어느 클러스터가 왜 실패했는지 남긴다.
    const r = await runLogged(runLog, {
      title: targetsOverride ? '일괄 재수집 — 실패분 재시도' : `일괄 재수집 — ${bulkScope === 'empty' ? '노드 IP 빈 클러스터' : '화면 목록'}`,
      first: `대상 ${targets.length}개 — ${targets.slice(0, 8).map((c) => c.name).join(', ')}${targets.length > 8 ? ` 외 ${targets.length - 8}개` : ''}`,
      heartbeatMs: 0,
      fn: async () => {
        let ok = 0;
        let fail = 0;
        let aborted = false;
        const failedIds: string[] = [];
        for (const c of targets) {
          if (bulkAbortRef.current) { aborted = true; break; }
          const t0 = performance.now();
          runLog.setStep(c.id, c.name, 'running');
          runLog.log('info', `${c.name} 재수집 중`);
          try {
            const { data } = await clustersApi.autoUpdate(c.id);
            ok += 1;
            runLog.setStep(c.id, c.name, 'done');
            const fields = Object.keys(data.updated ?? {}).length;
            runLog.log('info', `${c.name} 완료 · ${Math.round(performance.now() - t0)}ms · 갱신 ${fields}개 필드`);
            for (const w of data.warnings ?? []) runLog.log('warn', `${c.name} 경고 — ${w}`);
          } catch (e) {
            fail += 1;
            failedIds.push(c.id);
            runLog.setStep(c.id, c.name, 'failed');
            runLog.log('error', `${c.name} 실패 — ${formatApiError(e)}`);
          }
          setBulkProgress({ done: ok + fail, total: targets.length });
        }
        return { ok, fail, aborted, failedIds };
      },
      summarize: (res) => {
        const out: RunLogEntry[] = [];
        if (res.aborted) out.push(['warn', `사용자 중단 — 남은 ${targets.length - res.ok - res.fail}개는 재수집하지 않음`]);
        out.push([
          res.fail ? 'warn' : 'info',
          `성공 ${res.ok} · 실패 ${res.fail} · 대상 ${targets.length}${res.aborted ? ' · 중단됨' : ''}`,
        ]);
        return out;
      },
    });
    await queryClient.refetchQueries({ queryKey: ['clusters'] });
    setBulkCollecting(false);
    setBulkProgress(null);
    if (!r.ok) {
      toast.error('일괄 재수집 실패', formatApiError(r.error));
      return;
    }
    const { ok, fail, aborted, failedIds } = r.data;
    setLastBulkFailedIds(failedIds);
    const summary = `성공 ${ok} · 실패 ${fail} · 대상 ${targets.length}${aborted ? ' · 중단됨' : ''}`;
    if (fail > 0 && ok === 0) toast.error('일괄 재수집 실패', `${summary} — 상세는 실행 로그 참조`);
    else if (fail > 0) toast.warning('일괄 재수집 부분 실패', `${summary} — 상세는 실행 로그 참조`);
    else if (aborted) toast.info('일괄 재수집 중단됨', summary);
    else toast.success('일괄 재수집됨', summary);
  };

  const handleApplyDiff = async () => {
    if (!diffCluster) return;
    const target = diffCluster;
    const changed = diffRows.filter((d) => d.changed).length;
    // 적용 API 는 미리본 값을 받지 않고 서버가 다시 수집해 쓴다 — 그 사이 클러스터가 바뀌면 검토한 diff 와
    // 실제 반영값이 다를 수 있다. 미리보기 값과 반영값을 대조해 다른 필드를 실행 로그·토스트로 드러낸다.
    const previewed = new Map(diffRows.map((d) => [d.field, d.proposed]));
    let mismatched: string[] = [];
    setApplyingId(target.id);
    try {
      const r = await runLogged(runLog, {
        title: `변경 적용 — ${target.name}`,
        first: `${target.name} 미리보기 변경 ${changed}건 적용 요청 — 서버가 다시 수집해 반영`,
        fn: () => clustersApi.autoUpdate(target.id).then((res) => res.data),
        summarize: (data) => {
          const out = autoUpdateLines(data);
          mismatched = Object.entries(data.updated ?? {})
            .filter(([field, value]) => previewed.has(field) && !sameValue(previewed.get(field), value))
            .map(([field]) => field);
          const unseen = Object.keys(data.updated ?? {}).filter((field) => !previewed.has(field));
          for (const field of mismatched) {
            out.push(['warn', `미리보기와 다름 — ${diffFieldLabel(field)}: 미리보기 ${clip(renderDiffValue(previewed.get(field), field), 60)} → 반영 ${clip(renderDiffValue(data.updated?.[field], field), 60)}`]);
          }
          if (unseen.length) out.push(['info', `미리보기 표에 없던 필드도 반영 — ${unseen.map(diffFieldLabel).join(', ')}`]);
          if (!mismatched.length) out.push(['info', '반영값이 미리보기와 같음']);
          return out;
        },
      });
      if (r.ok) {
        queryClient.invalidateQueries({ queryKey: ['clusters'] });
        if (mismatched.length) {
          toast.warning('적용됨 — 미리보기와 다른 값 있음', `${target.name}: ${mismatched.map(diffFieldLabel).join(', ')} — 실행 로그에서 확인하세요`);
        } else {
          toast.success('클러스터 정보 갱신됨', `${target.name} — 반영값은 실행 로그에 있습니다`);
        }
        closeDiff();
      } else if (!r.aborted) {
        toast.error('적용 실패', formatApiError(r.error));
      }
    } finally {
      setApplyingId(null);
    }
  };

  // ── "도구" 팝오버 — 이름 표준화/컬럼 관리/너비 리셋(저빈도)을 접고, 표시 컬럼
  // 토글을 함께 담는다. 툴바 6개 동일 비중 문제의 해소 지점.
  const [toolsOpen, setToolsOpen] = useState(false);
  // 도구 메뉴(팝오버) — 뒤로가기 기록을 남기지 않는다.
  const toolsRef = useModalA11y(toolsOpen, () => setToolsOpen(false), { historyClose: false });

  const hasRunLog = runLog.running || runLog.lines.length > 0;
  const runLogPanel = hasRunLog
    ? <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-40" />
    : undefined;
  // 직전 일괄 수집에서 실패한 클러스터만 다시 — 확인 다이얼로그를 이미 거친 동일 동작이라 재확인 없음.
  const retryFailedButton = lastBulkFailedIds.length > 0 && !bulkCollecting && canEdit ? (
    <button
      type="button"
      onClick={() => executeBulkCollect(clusters.filter((c) => lastBulkFailedIds.includes(c.id)))}
      className="px-2 py-1 text-xs font-medium rounded-xl bg-status-warning/10 text-status-warning border border-status-warning/30 hover:bg-status-warning/20 transition-colors"
      title="직전 일괄 수집에서 실패한 클러스터만 다시 수집합니다"
    >
      실패 {lastBulkFailedIds.length}개 재시도
    </button>
  ) : undefined;

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" sidebar={false}>
        <DebugLogPanel pageKey="cluster-manage" extra={{ clusters: clusters.length, filtered: filteredClusters.length, autoUpdating: [...autoUpdatingIds].join(','), diffRowsCount: diffRows.length }} />

        {/* 페이지 헤더 — 액션이 많아 좁은 폭에서 줄바꿈 허용 (D-051) */}
        <PageHeader
          className="mb-6"
          icon={Server}
          title="클러스터 관리"
          titleExtra={<>
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
            {customFieldsError && (
              <span
                className="flex items-center gap-1 text-sm px-2 py-0.5 rounded-full bg-status-warning/10 text-status-warning border border-status-warning/30"
                title="커스텀 컬럼 정의를 불러오지 못해 테이블에서 임시로 빠졌습니다 — 정의가 삭제된 것이 아닙니다. 새로고침 후에도 계속되면 서버 상태를 확인하세요."
              >
                <AlertTriangle className="w-3 h-3" aria-hidden />
                커스텀 컬럼 조회 실패
              </span>
            )}
          </>}
          actions={<>
            <ViewModeBar
              modes={[
                { id: 'table', label: '테이블', icon: <LayoutList className="w-3.5 h-3.5" /> },
                { id: 'card',  label: '카드',   icon: <LayoutGrid className="w-3.5 h-3.5" /> },
              ]}
              active={viewMode}
              onChange={(v) => setViewMode(v as 'table' | 'card')}
              showStylePanel={false}
            />
            {/* 검색 — 대장의 최빈 동작이라 토글 뒤에 숨기지 않고 상시 노출 */}
            <div className="relative min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="이름, 지역, 호스트명 검색"
                aria-label="클러스터 검색"
                className="w-full pl-8 pr-3 py-1.5 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            {/* 「문제만」 — 장애 대응 중 비정상 클러스터를 한 번에 추리는 최빈 필터라 패널에 숨기지 않는다 */}
            <button
              type="button"
              onClick={() => setProblemsOnly(!problemsOnly)}
              aria-pressed={problemsOnly}
              disabled={clusters.length === 0}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-xl transition-colors disabled:opacity-50 ${
                problemsOnly
                  ? 'bg-status-warning/10 border-status-warning/40 text-status-warning'
                  : 'bg-secondary border-border text-muted-foreground hover:text-foreground hover:bg-secondary/80'
              }`}
              title="경고 · 위험 · 미연결 상태이거나 CIDR 이 겹치는 클러스터만 표시"
            >
              <AlertTriangle className="w-3.5 h-3.5" aria-hidden />
              문제만{problemCount > 0 && <span className="tabular-nums">{problemCount}</span>}
            </button>
            {canEdit && (
              <button
                onClick={handleBulkCollectNodeIps}
                disabled={!bulkCollecting && clusters.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-secondary hover:bg-secondary/80 border border-border rounded-xl text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                title={bulkCollecting
                  ? '클릭하면 다음 클러스터로 넘어가기 전에 재수집을 중단합니다'
                  : '여러 클러스터를 미리보기 없이 재수집합니다 — 실행 전 대상 범위(노드 IP 빈 클러스터 / 화면 목록)를 고릅니다'}
              >
                {bulkCollecting
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
                  : <Network className="w-3.5 h-3.5" aria-hidden />}
                {bulkCollecting
                  ? `재수집 중 ${bulkProgress?.done ?? 0}/${bulkProgress?.total ?? 0} — 중단`
                  : '일괄 재수집'}
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowFilter(v => !v)}
              aria-expanded={showFilter}
              aria-controls={f('filter-panel')}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors text-muted-foreground hover:text-foreground"
            >
              필터 · 정렬
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showFilter ? 'rotate-180' : ''}`} aria-hidden />
            </button>
            {/* 저빈도 도구(이름 표준화·컬럼 관리·너비 리셋)와 표시 컬럼 토글을 한 팝오버로 —
                6개 동일 비중 나열이 주는 인지 부하를 줄인다. */}
            <div className="relative inline-block">
              <button
                onClick={() => setToolsOpen((v) => !v)}
                aria-haspopup="dialog"
                aria-expanded={toolsOpen}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm border border-border rounded-xl transition-colors ${
                  toolsOpen ? 'bg-secondary text-foreground' : 'bg-secondary/60 hover:bg-secondary text-muted-foreground hover:text-foreground'
                }`}
                title="도구 — 이름 표준화 · 컬럼 관리 · 너비 리셋 · 표시 컬럼"
              >
                <Wrench className="w-3.5 h-3.5" />
                도구
              </button>
              {toolsOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setToolsOpen(false)} />
                  <div
                    ref={toolsRef}
                    role="dialog"
                    aria-label="테이블 도구"
                    className="absolute z-50 top-full mt-1 right-0 w-64 bg-card border border-border rounded-md shadow-xl p-2 space-y-1"
                  >
                    {canEdit && (
                      <button
                        onClick={() => { setStandardizeOpen(true); setToolsOpen(false); }}
                        disabled={clusters.length === 0}
                        className="w-full text-left px-2.5 py-1.5 text-sm rounded-md hover:bg-secondary flex items-center gap-2 disabled:opacity-50"
                        title="기존 클러스터 이름을 [업무명]-[운영타입]-[속성] 표준으로 정리"
                      >
                        <Wand2 className="w-3.5 h-3.5 text-muted-foreground" /> 이름 표준화
                      </button>
                    )}
                    {canEdit && (
                      <button
                        onClick={() => { setCustomFieldsOpen(true); setToolsOpen(false); }}
                        className="w-full text-left px-2.5 py-1.5 text-sm rounded-md hover:bg-secondary flex items-center gap-2"
                        title="테이블에 커스텀 컬럼 추가/수정/삭제"
                      >
                        <Settings2 className="w-3.5 h-3.5 text-muted-foreground" />
                        컬럼 관리 {customFields.length > 0 && <span className="text-primary">({customFields.length})</span>}
                      </button>
                    )}
                    <button
                      onClick={() => { colW.reset(); setToolsOpen(false); }}
                      className="w-full text-left px-2.5 py-1.5 text-sm rounded-md hover:bg-secondary flex items-center gap-2"
                      title="저장된 컬럼 너비를 기본값으로 되돌립니다"
                    >
                      너비 리셋
                    </button>
                    <div className="border-t border-border/50 pt-1.5 px-2.5 pb-1">
                      <p className="text-[11px] text-muted-foreground mb-1.5">
                        표시 컬럼 — bond0/bond1 등 IP 상세 컬럼을 켜고 끕니다
                      </p>
                      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
                        {COLUMNS.map((c) => (
                          <label key={c.key} className={`flex items-center gap-1.5 text-xs ${c.key === 'name' ? 'opacity-50' : 'cursor-pointer'}`}>
                            <input
                              type="checkbox"
                              disabled={c.key === 'name'}
                              checked={c.key === 'name' || !hiddenCols.has(c.key)}
                              onChange={() => toggleHiddenCol(c.key)}
                              className="rounded border-border"
                            />
                            <span className="truncate">{c.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </>}
        />

        {/* 실행 로그 — 연결 검증/재수집/IP 수집/일괄 수집/적용의 수명주기·대상별 결과 (표준 RunLogPanel) */}
        {hasRunLog && (
          <div className="mb-5">
            <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} actions={retryFailedButton} maxHeight="max-h-56" />
          </div>
        )}

        {/* 필터 패널 — 수제 카드 div 대신 MacCard (D-050). 검색은 툴바 상시 노출로 이동. */}
        {showFilter && (
          <div id={f('filter-panel')}>
          <MacCard title="필터 · 정렬" rootClassName="mb-5" className="flex flex-wrap items-end gap-3">
            <div className="min-w-[160px]">
              <label htmlFor={f('level')} className="block text-sm text-muted-foreground mb-1">운영레벨</label>
              <select id={f('level')} value={filterLevel} onChange={(e) => setFilterLevel(e.target.value)}
                className="w-full px-3 py-2 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-primary">
                <option value="">전체</option>
                {opsLevels.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            <div className="min-w-[140px]">
              <label htmlFor={f('sort')} className="block text-sm text-muted-foreground mb-1">정렬</label>
              <select id={f('sort')} value={sortBy} onChange={(e) => setSortBy(e.target.value as SortKey)}
                className="w-full px-3 py-2 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-primary">
                <option value="manual">수동(드래그)</option>
                <option value="name">이름순</option>
                <option value="status">상태순</option>
                <option value="level">운영레벨순</option>
              </select>
            </div>
            <div className="min-w-[140px]">
              <label htmlFor={f('group')} className="block text-sm text-muted-foreground mb-1">그룹</label>
              <select id={f('group')} value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupByMode)}
                className="w-full px-3 py-2 bg-secondary border border-border rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-primary">
                <option value="none">그룹 없음</option>
                <option value="region">지역별</option>
                <option value="level">운영레벨별</option>
              </select>
            </div>
            {hasFilters && (
              <button type="button" onClick={clearFilters}
                className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground bg-secondary border border-border rounded-xl transition-colors">
                초기화
              </button>
            )}
          </MacCard>
          </div>
        )}

        {/* viewer 네트워크 정보 숨김 정책 — 빈 IP·CIDR 칸이 "미수집" 으로 오해되지 않게 안내 */}
        {clusters.some((c) => c.networkMasked) && (
          <p className="mb-5 text-sm text-muted-foreground flex items-center gap-2">
            <EyeOff className="w-4 h-4 text-muted-foreground flex-shrink-0" aria-hidden />
            관리자 정책으로 IP·CIDR·MAC·호스트명·API 엔드포인트가 숨김 처리되어 빈 칸으로 보입니다 (viewer 권한).
          </p>
        )}

        {/* 클러스터 목록 — 로딩/조회실패/0건 3분기 (D-043) */}
        {clusters.length === 0 && clustersLoading ? (
          <MacCard bodyPadding="p-0">
            <div aria-busy="true">
              {/* 스켈레톤 형태를 실제 표(표시 컬럼 수)와 일치시킨다 — 하드코딩 8개는 컬럼이
                  바뀔 때마다 로드 전환 시 시프트를 만들었다. */}
              <div className="px-3 py-2.5 bg-secondary border-b border-border flex gap-6 overflow-hidden">
                {visibleColumns.map((c) => <Skeleton key={c.key} width={Math.min(Math.round(c.w * 0.55), 120)} height={12} />)}
              </div>
              <table className="w-full text-sm">
                <tbody>
                  <SkeletonTable rows={6} columns={visibleColumns.length + 1} />
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
            description={isAdmin
              ? '클러스터 등록과 API/kubeconfig 설정은 설정 → 클러스터 탭에서 할 수 있습니다.'
              : '클러스터 등록은 관리자만 할 수 있습니다. 관리자에게 설정 → 클러스터 탭에서 등록을 요청하세요.'}
            action={isAdmin ? { label: '설정에서 클러스터 등록', onClick: () => navigate('/settings?tab=cluster') } : undefined}
          />
        ) : filteredClusters.length === 0 ? (
          <EmptyState
            icon={Search}
            title="검색 결과가 없습니다."
            description={problemsOnly && !search && !filterLevel
              ? '경고 · 위험 · 미연결 상태이거나 CIDR 이 겹치는 클러스터가 없습니다.'
              : '검색어나 운영레벨 · 「문제만」 필터를 바꿔 보세요.'}
            action={hasFilters
              ? { label: '필터 초기화', onClick: clearFilters, variant: 'secondary' }
              : undefined}
          />
        ) : viewMode === 'table' ? (
          <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          {/* 수제 카드 div → MacCard (D-050). 본문에 max-h 를 줘 세로 스크롤을 만들고
              thead 를 sticky 로 고정 — 13열+커스텀열 표에서 헤더가 사라지지 않게 (D-051) */}
          <MacCard bodyPadding="p-0">
            <DoubleScrollX bodyClassName="max-h-[calc(100vh-16rem)]">
              <table className="text-sm border-collapse table-fixed w-max min-w-full">
                <colgroup>
                  {visibleColumns.map((c) => <col key={c.key} style={{ width: `${colW.getWidth(c.key)}px` }} />)}
                  {customFields.map((f) => <col key={`custom_${f.id}`} style={{ width: `${colW.getWidth(`custom_${f.id}`)}px` }} />)}
                  <col style={{ width: `${colW.getWidth('actions')}px` }} />
                </colgroup>
                {/* sticky 헤더 — border-collapse 에서는 sticky 셀의 border 가 사라지므로
                    구분선은 inset box-shadow 로 그린다. 배경은 반투명이면 행이 비쳐 보여 solid. */}
                <thead className="sticky top-0 z-10 bg-secondary">
                  <tr>
                    {visibleColumns.map((c) => {
                      // 이름·상태·운영레벨은 머리글 클릭으로 정렬 — 다시 누르면 수동(드래그) 순서로 돌아간다.
                      const sortKey = HEADER_SORT[c.key];
                      const sorted = sortKey !== undefined && sortBy === sortKey;
                      return (
                      <th key={c.key}
                        aria-sort={sortKey ? (sorted ? 'ascending' : 'none') : undefined}
                        className={`relative px-3 py-2.5 text-left text-sm font-semibold text-muted-foreground shadow-[inset_0_-1px_0_hsl(var(--border))] ${c.center ? 'text-center' : ''}`}>
                        <span className="truncate inline-flex items-center gap-1 max-w-full align-middle">
                          {sortKey ? (
                            <button
                              type="button"
                              onClick={() => setSortBy(sorted ? 'manual' : sortKey)}
                              className={`inline-flex items-center gap-0.5 rounded-xl px-0.5 -mx-0.5 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-primary ${sorted ? 'text-foreground' : ''}`}
                              title={sorted ? `${c.label}순 정렬 중 — 누르면 수동(드래그) 순서로` : `${c.label}순으로 정렬`}
                            >
                              {c.label}
                              {sorted && <ArrowDown className="w-3 h-3" aria-hidden />}
                            </button>
                          ) : (
                            <span title={c.tip} className="cursor-help">{c.label}</span>
                          )}
                          {/* provenance 설명이 title 전용이면 키보드/스크린리더가 화면 최고
                              기능(데이터 출처 문서화)에 접근할 수 없다 — Tooltip 프리미티브는
                              hover 뿐 아니라 키보드 포커스에서도 열린다. */}
                          <Tooltip>
                            <TooltipTrigger
                              type="button"
                              aria-label={`${c.label} 설명`}
                              className="inline-flex items-center text-muted-foreground hover:text-muted-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded"
                            >
                              <HelpCircle className="w-3 h-3" />
                            </TooltipTrigger>
                            <TooltipContent side="bottom" className="max-w-72 whitespace-normal text-left leading-relaxed font-normal normal-case">
                              {c.tip}
                            </TooltipContent>
                          </Tooltip>
                        </span>
                        <ResizeGrip onMouseDown={(e) => colW.beginResize(c.key, e)} onDoubleClick={() => colW.autoFit(c.key)} />
                      </th>
                      );
                    })}
                    {customFields.map((f) => (
                      <th key={f.id}
                        className="relative px-3 py-2.5 text-left text-sm font-semibold text-primary/80 border-l border-primary/10 shadow-[inset_0_-1px_0_hsl(var(--border))]"
                        // 설명이 없으면 빈 title 대신 필드명을 안내 (빈 title 은 툴팁만 깜빡임)
                        title={f.description?.trim() || `커스텀 컬럼: ${f.label}`}>
                        <span className="truncate inline-block max-w-full align-middle">{f.label}</span>
                        <ResizeGrip onMouseDown={(e) => colW.beginResize(`custom_${f.id}`, e)} onDoubleClick={() => colW.autoFit(`custom_${f.id}`)} />
                      </th>
                    ))}
                    <th className="relative px-3 py-2.5 text-left text-sm font-semibold text-muted-foreground shadow-[inset_0_-1px_0_hsl(var(--border))]">
                      <span className="inline-flex items-center gap-1">
                        <span title="행 단위 동작 — 연결 검증 · 재수집(미리보기) · NIC 수집(SSH) · 전체 수정 · 삭제. Cilium 설정은 K8s / Cilium 칸의 Cilium 칩으로 엽니다." className="cursor-help">편집</span>
                        <Tooltip>
                          <TooltipTrigger
                            type="button"
                            aria-label="편집 컬럼 설명"
                            className="inline-flex items-center text-muted-foreground hover:text-muted-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded"
                          >
                            <HelpCircle className="w-3 h-3" />
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="max-w-72 whitespace-normal text-left leading-relaxed font-normal normal-case">
                            행 단위 동작 — 연결 검증 · 재수집(미리보기) · NIC 수집(SSH) · 전체 수정 · 삭제. Cilium 설정은 K8s / Cilium 칸의 Cilium 칩으로 엽니다.
                          </TooltipContent>
                        </Tooltip>
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
                          <td colSpan={visibleColumns.length + customFields.length + 1}
                            className="px-3 py-1.5 text-xs font-semibold text-primary">
                            <span className="inline-flex items-center gap-1.5 align-middle">
                              <GroupIcon className="w-3 h-3" aria-hidden />
                              {groupLabelPrefix} {group.label}
                            </span>
                            <span className="ml-2 text-muted-foreground font-normal">
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
                            overlapPeers={overlapPeerNames.get(cluster.id)}
                            onCilium={c => setCiliumCluster(c)}
                            onAutoUpdate={handleAutoUpdate}
                            onVerify={handleVerify}
                            verifying={verifyingIds.has(cluster.id)}
                            autoUpdating={autoUpdatingIds.has(cluster.id)}
                            customFields={customFields}
                            onCollectNodeIps={(c) => setCollectConfirm(c)}
                            collectingNodeIpsId={collectingNodeIpsId}
                            onCollectNics={(c) => setNicsClusterId(c.id)}
                            sortable={sortEnabled}
                            canEdit={canEdit}
                            hiddenCols={hiddenCols}
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
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary">
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
                    <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(320px,100%),1fr))]">
                      {group.clusters.map((cluster) => (
                        <SortableClusterCard
                          key={cluster.id}
                          cluster={cluster}
                          onEdit={c => navigate(`/cluster-manage/${c.id}/edit`)}
                          onDelete={handleDelete}
                          deletingId={deletingId}
                          overlapGroupIdx={cidrOverlapGroups.get(cluster.id)}
                          overlapPeers={overlapPeerNames.get(cluster.id)}
                          onAutoUpdate={handleAutoUpdate}
                          onVerify={handleVerify}
                          verifying={verifyingIds.has(cluster.id)}
                          autoUpdating={autoUpdatingIds.has(cluster.id)}
                          onCollectNics={(c) => setNicsClusterId(c.id)}
                          sortEnabled={sortEnabled}
                          onCilium={(c) => setCiliumCluster(c)}
                          canEdit={canEdit}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </div>
              ))}
            </div>
          </DndContext>
        )}

        {/* /settings 는 관리자 전용 라우트 — 들어갈 수 없는 사람에게 링크를 주지 않는다 */}
        {clusters.length > 0 && (
          <p className="text-sm text-muted-foreground mt-6 text-center">
            {isAdmin ? (
              <>클러스터 등록과 API · kubeconfig 설정은{' '}
                <Link to="/settings?tab=cluster" className="text-primary hover:underline rounded-xl focus:outline-none focus-visible:ring-1 focus-visible:ring-primary">설정 → 클러스터</Link>
                에서 합니다.</>
            ) : '클러스터 등록과 API · kubeconfig 설정은 관리자가 설정 → 클러스터 탭에서 합니다.'}
          </p>
        )}
      </PageShell>

      <StandardizeClusterNamesModal
        open={standardizeOpen}
        clusters={clusters}
        onClose={() => setStandardizeOpen(false)}
        onRenamed={() => queryClient.invalidateQueries({ queryKey: ['clusters'] })}
        runLog={runLog}
        showLog={showLog}
        onShowLogChange={setShowLog}
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
        logSlot={runLogPanel}
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
        description={deleteTarget
          ? `"${deleteTarget.name}"${deleteTarget.operationLevel ? ` · 운영레벨 ${levelLabel(opsLevels, deleteTarget.operationLevel)}` : ''}${deleteTarget.region ? ` · ${deleteTarget.region}` : ''} 클러스터를 삭제합니다.`
          : undefined}
        confirmLabel="삭제"
        confirmDisabled={!deleteTarget || deleteConfirmName.trim() !== deleteTarget.name}
        onConfirm={executeDelete}
        onCancel={() => setDeleteTarget(null)}
      >
        <div className="space-y-3">
          <p className="text-muted-foreground">
            이 동작은 되돌릴 수 없으며, 클러스터에 연관된{' '}
            <strong className="text-foreground">Addon · Playbook · 점검 이력이 모두 함께 삭제</strong>됩니다.
          </p>
          <div>
            <label htmlFor={f('delete-confirm')} className="block text-sm text-muted-foreground mb-1">
              확인을 위해 클러스터 이름 <strong className="text-foreground font-mono">{deleteTarget?.name}</strong> 을 입력하세요
            </label>
            <input
              id={f('delete-confirm')}
              type="text"
              value={deleteConfirmName}
              onChange={(e) => setDeleteConfirmName(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="w-full px-3 py-2 bg-secondary border border-border rounded-xl text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>
      </ConfirmDialog>

      {/* 일괄 재수집 확인 — 대상 범위 선택 + 대상 수·갱신 범위를 명시 (D-048) */}
      <ConfirmDialog
        open={bulkConfirmOpen}
        title="일괄 재수집"
        description={`클러스터 ${bulkTargets.length}개를 미리보기 없이 재수집해 바로 반영합니다.`}
        confirmLabel={bulkTargets.length > 0 ? `${bulkTargets.length}개 재수집 시작` : '대상 없음'}
        confirmDisabled={bulkTargets.length === 0}
        onConfirm={executeBulkCollect}
        onCancel={() => setBulkConfirmOpen(false)}
      >
        <div className="space-y-3 text-muted-foreground">
          <fieldset className="space-y-1.5">
            <legend className="text-sm text-foreground font-medium mb-1">대상 범위</legend>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name={f('bulk-scope')} checked={bulkScope === 'empty'} onChange={() => setBulkScope('empty')} />
              노드 IP 가 비어 있는 클러스터 <span className="tabular-nums text-foreground">{emptyTargets.length}개</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name={f('bulk-scope')} checked={bulkScope === 'visible'} onChange={() => setBulkScope('visible')} />
              지금 화면 목록 전체 <span className="tabular-nums text-foreground">{filteredClusters.length}개</span>
              {hasFilters && <span className="text-xs">(검색·필터 적용됨)</span>}
            </label>
          </fieldset>
          <p>
            노드 IP 외에도{' '}
            <strong className="text-foreground">호스트명 · CIDR · K8s/Cilium 버전 · 노드당 최대 Pod</strong> 등이
            함께 갱신될 수 있습니다. 클러스터별 반영 결과는 실행 로그에 남습니다.
          </p>
          {bulkTargets.length > 0 && (
            <p className="text-xs">
              대상: {bulkTargets.slice(0, 8).map((c) => c.name).join(', ')}
              {bulkTargets.length > 8 && ` 외 ${bulkTargets.length - 8}개`}
            </p>
          )}
          <p className="text-xs">진행 중에는 버튼을 다시 눌러 언제든 중단할 수 있습니다(진행 중인 클러스터는 마친 뒤 멈춤).</p>
        </div>
      </ConfirmDialog>

      {/* 행의 바로 재수집 확인 — 일괄 경로와 동일한 write 인데 단건만 무게이트였던 비대칭 해소 */}
      <ConfirmDialog
        open={!!collectConfirm}
        title="재수집 — 미리보기 없이 반영"
        description={collectConfirm ? `"${collectConfirm.name}" 을 미리보기 없이 재수집해 바로 반영합니다.` : undefined}
        confirmLabel="재수집 시작"
        onConfirm={() => {
          const target = collectConfirm;
          setCollectConfirm(null);
          if (target) void collectNodeIps(target);
        }}
        onCancel={() => setCollectConfirm(null)}
      >
        <p className="text-muted-foreground">
          노드 IP 외에도 <strong className="text-foreground">호스트명 · CIDR · K8s/Cilium 버전 · 노드당 최대 Pod</strong> 등이
          함께 갱신될 수 있습니다. 변경분을 먼저 확인하려면 편집 칸의 재수집(미리보기) 버튼을 사용하세요.
        </p>
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
