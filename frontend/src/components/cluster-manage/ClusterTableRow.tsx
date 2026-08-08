import { useRef, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Trash2, AlertTriangle, RefreshCw, Loader2, ArrowUpRight, Cable, Server, GripVertical, Globe, Lock } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Cluster, ClusterCustomField, ClusterManageUpdate } from '@/types';
import { useUpdateCluster } from '@/hooks/useCluster';
import { InlineEdit, useToast } from '@/components/common';
import { formatApiError, formatRelativeTime } from '@/lib/utils';
import { useClusterIconSrc } from '@/hooks/useClusterIconSrc';
import { STATUS_STYLE } from './constants';
import { useOperationLevels, levelBadgeClass, levelBadgeStyle, levelLabel, levelColor } from '@/hooks/useOperationLevels';
import { ClusterCustomCell } from './ClusterCustomCell';
import { extractInterfaceIps, extractInternalIps, groupInternalIps, parseNodeIps } from './internalIp';

interface ClusterTableRowProps {
  cluster: Cluster;
  onEdit: (c: Cluster) => void;
  onDelete: (c: Cluster) => void;
  deletingId: string | null;
  overlapGroupIdx: number | undefined;
  /** CIDR 겹침 배지 툴팁용 — 실제로 직접 겹치는 상대 클러스터명 */
  overlapPeers?: string[];
  onCilium: (c: Cluster) => void;
  onAutoUpdate: (c: Cluster) => void;
  /** 이 클러스터의 auto-update 진행 여부 — per-cluster 동시 진행 지원 (D-047) */
  autoUpdating: boolean;
  customFields?: ClusterCustomField[];
  /** 수동 정렬 모드에서 행 드래그 허용 — 이름 셀 좌측에 그립 노출 (D-045) */
  sortable?: boolean;
  /** 노드 IP 만 수집 (diff 다이얼로그 없이 즉시 적용) */
  onCollectNodeIps?: (c: Cluster) => void;
  collectingNodeIpsId?: string | null;
  /** SSH 기반 NIC 수집(bond0/bond1 채움) 모달 열기 */
  onCollectNics?: (c: Cluster) => void;
  /** viewer 역할은 조회만 — 인라인 편집·수집·삭제 진입점을 노출하지 않는다 */
  canEdit?: boolean;
  /** 페이지의 표시 컬럼 토글과 동기 — 숨긴 컬럼의 셀은 렌더하지 않는다(헤더/colgroup 과 열 수 일치). */
  hiddenCols?: Set<string>;
}

type EditField = null | 'region' | 'operationLevel' | 'cidr' | 'podCidr' | 'svcCidr';

/** 편집 가능 셀 wrapper — 더블클릭 OR hover 시 나타나는 ✏️ 아이콘 클릭으로 진입.
 *  text 선택을 막아 dblclick 이 안정적으로 발화되게 함. `canEdit=false`(viewer)면
 *  더블클릭·연필 버튼 없이 순수 읽기 전용 셀로 렌더한다.
 */
function EditableCell({
  isEditing, onEnter, children, className = '', canEdit = true,
}: {
  isEditing: boolean;
  onEnter: () => void;
  children: React.ReactNode;
  className?: string;
  canEdit?: boolean;
}) {
  if (!canEdit) {
    return <td className={`px-3 py-2.5 overflow-hidden ${className}`}>{children}</td>;
  }
  if (isEditing) {
    return <td className={`px-3 py-2.5 overflow-hidden ${className}`}>{children}</td>;
  }
  return (
    <td
      className={`px-3 py-2.5 overflow-hidden select-none cursor-pointer relative group hover:bg-primary/5 focus-within:bg-primary/5 transition-colors ${className}`}
      onDoubleClick={(e) => { e.preventDefault(); onEnter(); }}
      onClick={(e) => {
        // 더블클릭 안전망 — detail===2 가 dblclick 보다 먼저 들어오므로 무시
        if (e.detail === 2) return;
      }}
      title="더블클릭 또는 ✏️ 클릭으로 수정"
    >
      {children}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onEnter(); }}
        className="absolute top-1 right-1 p-0.5 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-primary text-muted-foreground hover:text-primary hover:bg-secondary/80 transition-opacity"
        title="이 셀 수정"
        aria-label="수정"
      >
        <Pencil className="w-3 h-3" />
      </button>
    </td>
  );
}

export function ClusterTableRow({ cluster, onEdit, onDelete, deletingId, overlapGroupIdx, overlapPeers, onCilium, onAutoUpdate, autoUpdating, customFields = [], onCollectNodeIps, collectingNodeIpsId, onCollectNics, sortable = false, canEdit = true, hiddenCols }: ClusterTableRowProps) {
  const colVisible = (key: string) => key === 'name' || !hiddenCols?.has(key);
  const updateCluster = useUpdateCluster();
  // 테이블 뷰 행 드래그 — 페이지의 DndContext/SortableContext 안에서만 렌더된다.
  // sortable=false(수동 정렬 아님)면 비활성 + 그립 미노출 (D-045).
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: cluster.id, disabled: !sortable || !canEdit });
  const toast = useToast();
  const [editingField, setEditingField] = useState<EditField>(null);
  const iconAnchorRef = useRef<HTMLSpanElement | null>(null);

  // 빈 입력은 `null` 로 보내야 값 해제가 저장된다 — `undefined` 는 JSON 직렬화에서
  // 사라져 백엔드 `exclude_unset=True` 가 기존 값을 유지한다. (D-041)
  // 실패는 토스트로 고지 — 422/403 이어도 조용히 원복되지 않게. (D-042)
  const quickUpdate = (patch: ClusterManageUpdate) => {
    updateCluster.mutate(
      { id: cluster.id, data: patch },
      {
        onError: (e) => toast.error('저장 실패', formatApiError(e)),
        onSettled: () => setEditingField(null),
      },
    );
  };

  const resolvedIcon = useClusterIconSrc(cluster);
  const FallbackIcon = Server;
  const st = STATUS_STYLE[cluster.status] ?? STATUS_STYLE.pending;
  const { data: opsLevels } = useOperationLevels();
  const lv = cluster.operationLevel ? levelBadgeClass(levelColor(opsLevels, cluster.operationLevel)) : undefined;
  const lvStyle = cluster.operationLevel ? levelBadgeStyle(opsLevels, cluster.operationLevel) : undefined;
  const ipBuckets = useMemo(() => {
    const entries = parseNodeIps(cluster.nodeIps);
    const internalIps = extractInternalIps(entries);
    const bond0Ips = extractInterfaceIps(entries, 'bond0');
    const bond1Ips = extractInterfaceIps(entries, 'bond1');
    return {
      internal: { ips: internalIps, groups: groupInternalIps(internalIps) },
      bond0:    { ips: bond0Ips,    groups: groupInternalIps(bond0Ips) },
      bond1:    { ips: bond1Ips,    groups: groupInternalIps(bond1Ips) },
    };
  }, [cluster.nodeIps]);

  return (
    <tr
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="border-b border-border hover:bg-secondary/20 transition-colors group/row"
    >
      <td className="px-3 py-2.5 overflow-hidden">
        <div className="flex items-center gap-2">
          {sortable && canEdit && (
            <button
              type="button"
              {...attributes} {...listeners}
              className="p-0.5 -ml-1 rounded cursor-grab active:cursor-grabbing text-muted-foreground/30 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-muted-foreground hover:bg-secondary transition-all flex-shrink-0"
              title="드래그하여 순서 변경 (정렬: 수동 모드)"
              aria-label="순서 변경 핸들"
            >
              <GripVertical className="w-3.5 h-3.5" />
            </button>
          )}
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${st.dot}`} />
          {/* 현재 아이콘 표시 (읽기 전용) — 변경은 시스템 → Settings → 클러스터 탭에서 */}
          <span
            ref={iconAnchorRef}
            className="flex items-center justify-center w-6 h-6 rounded-md text-muted-foreground flex-shrink-0"
            title="아이콘 변경: 시스템 → Settings → 클러스터 탭에서"
            aria-hidden
          >
            {resolvedIcon?.kind === 'image'
              ? <img src={resolvedIcon.value} alt="" className="w-5 h-5 rounded object-cover" />
              : resolvedIcon?.kind === 'text'
                ? <span className="text-base leading-none">{resolvedIcon.value}</span>
                : resolvedIcon?.kind === 'lucide'
                  ? <resolvedIcon.Component className="w-4 h-4" />
                  : <FallbackIcon className="w-4 h-4 opacity-50" />}
          </span>
          <span className="font-medium text-sm text-foreground truncate" title={cluster.name}>{cluster.name}</span>
        </div>
        {cluster.hostname && (
          <p className="text-xs font-mono text-muted-foreground mt-0.5 ml-4 truncate" title={cluster.hostname}>{cluster.hostname}</p>
        )}
        {/* 값들은 전부 스냅샷이라 "언제 것인지"가 신뢰의 1차 변수 — 마지막 갱신 시각을 상시 노출 */}
        {cluster.updatedAt && (
          <p className="text-[10px] text-muted-foreground/70 mt-0.5 ml-4" title={`마지막 갱신(수집·편집 포함): ${cluster.updatedAt}`}>
            갱신 {formatRelativeTime(cluster.updatedAt)}
          </p>
        )}
      </td>
      {colVisible('status') && (
      <td className="px-3 py-2.5 overflow-hidden">
        <span className={`text-xs px-2 py-0.5 rounded-full border ${st.badge}`}>{st.label}</span>
      </td>
      )}

      {/* 지역 — 인라인 편집 */}
      {colVisible('region') && (
      <EditableCell
        isEditing={editingField === 'region'}
        onEnter={() => setEditingField('region')}
        canEdit={canEdit}
        className="text-sm text-muted-foreground"
      >
        {editingField === 'region' ? (
          <InlineEdit
            value={cluster.region ?? ''}
            onSave={(v) => quickUpdate({ region: v.trim() || null })}
            onCancel={() => setEditingField(null)}
            placeholder="예: 서울"
            inputClassName="text-sm"
          />
        ) : (cluster.region || <span className="text-muted-foreground/60">-</span>)}
      </EditableCell>
      )}

      {/* 운영레벨 — select 인라인 */}
      {colVisible('level') && (
      <EditableCell
        isEditing={editingField === 'operationLevel'}
        onEnter={() => setEditingField('operationLevel')}
        canEdit={canEdit}
      >
        {editingField === 'operationLevel' ? (
          <select
            autoFocus
            value={cluster.operationLevel ?? ''}
            onChange={(e) => quickUpdate({ operationLevel: e.target.value || null })}
            onBlur={() => setEditingField(null)}
            className="text-sm bg-background border border-border rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">—</option>
            {(opsLevels ?? []).map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        ) : cluster.operationLevel ? (
          <span className={`text-xs px-2 py-0.5 rounded-full border ${lv}`} style={lvStyle}>
            {levelLabel(opsLevels, cluster.operationLevel)}
          </span>
        ) : <span className="text-muted-foreground/60 text-sm">-</span>}
      </EditableCell>
      )}

      {colVisible('bgp') && (
      <td className="px-3 py-2.5 overflow-hidden">
        {cluster.bgpEnabled ? (
          <div>
            <span className="text-xs px-1.5 py-0.5 rounded bg-chart-6/15 text-chart-6 border border-chart-6/30">BGP</span>
            {cluster.asNumber && <p className="text-xs font-mono text-muted-foreground mt-0.5">AS{cluster.asNumber}</p>}
          </div>
        ) : <span className="text-muted-foreground/60 text-sm">-</span>}
      </td>
      )}

      {/* INTERNAL_IP — kubectl InternalIP 들을 정규식/Glob 형식으로 묶어 표시 */}
      {colVisible('cidr') && (
      <EditableCell
        isEditing={editingField === 'cidr'}
        onEnter={() => setEditingField('cidr')}
        canEdit={canEdit}
      >
        {editingField === 'cidr' ? (
          <InlineEdit
            value={cluster.cidr ?? ''}
            onSave={(v) => quickUpdate({ cidr: v.trim() || null })}
            onCancel={() => setEditingField(null)}
            placeholder="192.168.0.0/24 (fallback)"
            inputClassName="text-sm font-mono"
          />
        ) : (() => {
          const manualGroups = (cluster.internalIps ?? '')
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean);
          const hasAuto = ipBuckets.internal.groups.length > 0;
          const hasManual = manualGroups.length > 0;
          const hasContent = hasAuto || hasManual || Boolean(cluster.cidr);
          if (!hasContent) return <span className="text-muted-foreground/60 text-sm">-</span>;
          return (
          <div>
            {hasAuto ? (
              <div title="kubectl get nodes -o wide 의 InternalIP 들을 /24 단위로 묶은 표기 (마지막 옥텟 연속 구간 압축)">
                {ipBuckets.internal.groups.map((g, i) => (
                  <p key={i} className="text-sm font-mono text-foreground tabular-nums">{g}</p>
                ))}
                <p className="text-xs text-muted-foreground/80 mt-0.5">
                  {ipBuckets.internal.ips.length}개 노드
                </p>
              </div>
            ) : hasManual ? (
              <div title="수동 입력된 IP 리스트 (정규식)">
                {manualGroups.map((g, i) => (
                  <p key={i} className="text-sm font-mono text-foreground tabular-nums">{g}</p>
                ))}
                <p className="text-xs text-muted-foreground/80 mt-0.5">수동 입력 (정규식)</p>
              </div>
            ) : (
              <p className="text-sm font-mono text-muted-foreground" title="nodeIps / internalIps 미입력 — fallback CIDR">
                <span className="text-muted-foreground/60 text-xs mr-1">fallback</span>
                <span className="text-foreground">{cluster.cidr}</span>
              </p>
            )}
            <div className="flex items-center gap-1 mt-1">
              {overlapGroupIdx !== undefined && (
                <span
                  className="text-xs text-status-warning inline-flex items-center gap-0.5"
                  title={overlapPeers?.length ? `겹치는 클러스터: ${overlapPeers.join(', ')}` : undefined}
                >
                  <AlertTriangle className="w-2.5 h-2.5" />겹침
                </span>
              )}
              {cluster.cidr && (
                <Link
                  to={`/cidr?cidr=${encodeURIComponent(cluster.cidr)}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-0.5 ml-auto px-1 py-0.5 rounded hover:bg-primary/10 transition-colors"
                  title={`CIDR Calculator 에서 ${cluster.cidr} 분석`}
                >
                  <ArrowUpRight className="w-2.5 h-2.5" />Calc
                </Link>
              )}
            </div>
          </div>
          );
        })()}
      </EditableCell>
      )}

      {/* bond0 — 모든 노드 bond0 IP 들 정규식/Glob 그룹화 (기본 숨김 — 도구 → 표시 컬럼) */}
      {colVisible('bond0') && (
      <td className="px-3 py-2.5 align-top overflow-hidden">
        {ipBuckets.bond0.groups.length > 0 ? (
          <div>
            {ipBuckets.bond0.groups.map((g, i) => (
              <p key={i} className="text-sm font-mono text-chart-6 tabular-nums" title="모든 노드 bond0 IP /24 묶음">{g}</p>
            ))}
            <p className="text-xs text-muted-foreground/80 mt-0.5">{ipBuckets.bond0.ips.length}개 IP</p>
          </div>
        ) : <span className="text-muted-foreground/50 text-sm" title="NIC 수집(SSH) 후 채워짐">-</span>}
      </td>
      )}

      {/* bond1 (기본 숨김 — 도구 → 표시 컬럼) */}
      {colVisible('bond1') && (
      <td className="px-3 py-2.5 align-top overflow-hidden">
        {ipBuckets.bond1.groups.length > 0 ? (
          <div>
            {ipBuckets.bond1.groups.map((g, i) => (
              <p key={i} className="text-sm font-mono text-chart-3 tabular-nums" title="모든 노드 bond1 IP /24 묶음">{g}</p>
            ))}
            <p className="text-xs text-muted-foreground/80 mt-0.5">{ipBuckets.bond1.ips.length}개 IP</p>
          </div>
        ) : <span className="text-muted-foreground/50 text-sm" title="NIC 수집(SSH) 후 채워짐">-</span>}
      </td>
      )}

      {/* Pod CIDR */}
      {colVisible('pod') && (
      <EditableCell
        isEditing={editingField === 'podCidr'}
        onEnter={() => setEditingField('podCidr')}
        canEdit={canEdit}
      >
        {editingField === 'podCidr' ? (
          <InlineEdit
            value={cluster.podCidr ?? ''}
            onSave={(v) => quickUpdate({ podCidr: v.trim() || null })}
            onCancel={() => setEditingField(null)}
            placeholder="10.244.0.0/16"
            inputClassName="text-sm font-mono"
          />
        ) : cluster.podCidr ? (
          <div>
            <p className="text-sm font-mono text-foreground">{cluster.podCidr}</p>
            {(cluster.podFirstHost || cluster.podLastHost) && (
              <p className="text-xs font-mono text-muted-foreground">{cluster.podFirstHost} ~ {cluster.podLastHost}</p>
            )}
          </div>
        ) : <span className="text-muted-foreground/60 text-sm">-</span>}
      </EditableCell>
      )}

      {/* Service CIDR */}
      {colVisible('svc') && (
      <EditableCell
        isEditing={editingField === 'svcCidr'}
        onEnter={() => setEditingField('svcCidr')}
        canEdit={canEdit}
      >
        {editingField === 'svcCidr' ? (
          <InlineEdit
            value={cluster.svcCidr ?? ''}
            onSave={(v) => quickUpdate({ svcCidr: v.trim() || null })}
            onCancel={() => setEditingField(null)}
            placeholder="10.96.0.0/12"
            inputClassName="text-sm font-mono"
          />
        ) : cluster.svcCidr ? (
          <div>
            <p className="text-sm font-mono text-foreground">{cluster.svcCidr}</p>
            {(cluster.svcFirstHost || cluster.svcLastHost) && (
              <p className="text-xs font-mono text-muted-foreground">{cluster.svcFirstHost} ~ {cluster.svcLastHost}</p>
            )}
          </div>
        ) : <span className="text-muted-foreground/60 text-sm">-</span>}
      </EditableCell>
      )}

      {colVisible('maxpod') && (
      <td className="px-3 py-2.5 text-sm text-center overflow-hidden">
        {cluster.maxPod
          ? <span className="font-mono text-foreground">{cluster.maxPod}</span>
          : <span className="text-muted-foreground/60 text-sm">-</span>}
      </td>
      )}
      {/* K8s / Cilium 버전 */}
      {colVisible('k8s') && (
      <td className="px-3 py-2.5 overflow-hidden">
        <div className="flex flex-col gap-1">
          {cluster.k8sVersion ? (
            <span className="text-xs font-mono px-1.5 py-0.5 rounded-full bg-chart-1/10 text-chart-1 border border-chart-1/20 w-fit">
              k8s {cluster.k8sVersion}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground/60 italic">k8s 미수집</span>
          )}
          <button
            type="button"
            onClick={() => onCilium(cluster)}
            title={cluster.ciliumVersion
              ? `Cilium ${cluster.ciliumVersion} — 클릭 시 설정 보기`
              : 'Cilium 버전 미수집 — 클릭 시 cilium-config ConfigMap 으로 조회/설정'}
            aria-label={`${cluster.name} Cilium 설정 보기`}
            className={`text-xs font-mono px-1.5 py-0.5 rounded-full border w-fit transition-colors ${
              cluster.ciliumVersion
                ? 'bg-chart-6/10 text-chart-6 border-chart-6/30 hover:bg-chart-6/20'
                : 'bg-secondary text-muted-foreground border-border hover:bg-secondary/80 hover:text-foreground'
            }`}
          >
            {cluster.ciliumVersion ? `cilium ${cluster.ciliumVersion}` : 'cilium 설정 →'}
          </button>
        </div>
      </td>
      )}

      {/* 노드 IP 목록 — 노드당 여러 IP (bond0/bond1) + public/private 스코프 표시 */}
      {colVisible('nodeip') && (
      <td className="px-3 py-2.5 overflow-hidden">
        {(() => {
          if (!cluster.nodeIps) {
            const isCollecting = collectingNodeIpsId === cluster.id;
            return (
              <div className="flex items-center gap-2 text-xs">
                {cluster.nodeCount
                  ? <span className="text-muted-foreground">노드 {cluster.nodeCount}개</span>
                  : <span className="text-muted-foreground/60">-</span>}
                {onCollectNodeIps && canEdit && (
                  <button
                    type="button"
                    onClick={() => onCollectNodeIps(cluster)}
                    disabled={isCollecting}
                    className="px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 disabled:opacity-50 flex items-center gap-1"
                    title="kubeconfig 로 노드 IP 즉시 수집 (diff 다이얼로그 없이 적용)"
                  >
                    {isCollecting
                      ? <><Loader2 className="w-3 h-3 animate-spin" /> 수집중</>
                      : <>IP 수집</>}
                  </button>
                )}
              </div>
            );
          }
          try {
            const arr = JSON.parse(cluster.nodeIps) as {
              name: string;
              ip?: string;
              ips?: string[];
              externalIp?: string;
              external_ip?: string;
              master?: boolean;
              interfaces?: { name: string; ips: string[]; scopes?: string[]; operstate?: string | null }[];
            }[];
            const shown = arr.slice(0, 4);
            const rest = arr.length - shown.length;
            const multiCount = arr.filter((n) => (n.ips?.length ?? 0) > 1).length;
            const hasIfaces = arr.some((n) => (n.interfaces?.length ?? 0) > 0);
            const pubCount = arr.reduce((s, n) =>
              s + (n.interfaces ?? []).reduce((s2, ifc) =>
                s2 + (ifc.scopes ?? []).filter((sc) => sc === 'public').length, 0), 0);
            return (
              <div className="text-xs font-mono space-y-0.5">
                {shown.map((n) => {
                  const ifaces = n.interfaces ?? [];
                  if (ifaces.length > 0) {
                    return (
                      <div key={n.name} className="space-y-0.5"
                        title={`${n.name}${n.externalIp ? ` · ext: ${n.externalIp}` : ''}`}>
                        <div className={`flex items-center gap-1 ${n.master ? 'text-foreground' : 'text-foreground/80'}`}>
                          {n.master && <span className="inline-block w-1 h-1 rounded-full bg-primary align-middle" />}
                          <span className="text-xs text-muted-foreground/80 truncate max-w-[120px]">{n.name}</span>
                        </div>
                        {ifaces.map((ifc) => {
                          const scopes = ifc.scopes ?? [];
                          const ips = ifc.ips ?? [];
                          return (
                            <div key={`${n.name}-${ifc.name}`} className="flex items-center gap-1 flex-wrap pl-2">
                              <span className="text-[10px] text-muted-foreground/70">{ifc.name}</span>
                              {ips.map((ip, i) => {
                                const sc = scopes[i] ?? 'unknown';
                                const isPub = sc === 'public';
                                return (
                                  <span key={ip}
                                    className={`text-xs px-1 rounded inline-flex items-center gap-0.5 ${
                                      isPub
                                        ? 'bg-status-warning/10 text-status-warning'
                                        : 'bg-chart-1/10 text-chart-1'
                                    }`}
                                    title={isPub ? 'public' : sc}>
                                    {isPub ? <Globe className="w-2.5 h-2.5" /> : <Lock className="w-2.5 h-2.5" />}
                                    {ip}
                                  </span>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    );
                  }
                  // legacy 포맷 — interfaces 없는 경우
                  const ips = n.ips && n.ips.length > 0 ? n.ips : (n.ip ? [n.ip] : []);
                  return (
                    <div key={n.name} className={n.master ? 'text-foreground' : 'text-muted-foreground'}
                      title={`${n.name}${n.externalIp ? ` · ext: ${n.externalIp}` : ''}`}>
                      {n.master && <span className="inline-block w-1 h-1 rounded-full bg-primary mr-1 align-middle" />}
                      {ips.length === 0
                        ? <span className="text-muted-foreground/60">?</span>
                        : ips.length === 1
                          ? ips[0]
                          : (
                            <span>
                              {ips[0]}
                              <span className="text-muted-foreground/60"> +{ips.length - 1}</span>
                            </span>
                          )}
                    </div>
                  );
                })}
                {rest > 0 && <p className="text-muted-foreground/70">+{rest} more</p>}
                <div className="flex items-center gap-2 pt-0.5">
                  {multiCount > 0 && (
                    <span className="text-xs text-primary/70" title="노드당 IP 여러 개 (bond0/bond1 등)">
                      다중 IP {multiCount}대
                    </span>
                  )}
                  {pubCount > 0 && (
                    <span className="text-xs text-status-warning/80" title="public IP 보유 NIC 수">
                      public {pubCount}건
                    </span>
                  )}
                  {!hasIfaces && (
                    <span className="text-xs text-muted-foreground/60" title="NIC 상세 미수집 — 'NIC 수집' 실행 시 채워집니다.">
                      NIC 미수집
                    </span>
                  )}
                </div>
              </div>
            );
          } catch {
            return <p className="text-xs font-mono text-muted-foreground truncate">{cluster.nodeIps}</p>;
          }
        })()}
      </td>
      )}

      {customFields.map((f) => (
        <td key={f.id} className="px-3 py-2.5 border-l border-primary/10 align-top overflow-hidden">
          <ClusterCustomCell cluster={cluster} field={f} canEdit={canEdit} />
        </td>
      ))}

      <td className="px-3 py-2.5 overflow-hidden">
        {canEdit ? (
          <div className="flex items-center gap-1">
            <button onClick={() => onAutoUpdate(cluster)}
              className={`p-1.5 rounded transition-colors ${
                autoUpdating
                  ? 'bg-status-critical/10 text-status-critical hover:bg-status-critical/20'
                  : 'text-muted-foreground hover:bg-primary/10 hover:text-primary'
              }`}
              title={autoUpdating
                ? '수집 중지'
                : '재수집(diff 미리보기) — kubeconfig 로 노드 / 버전 / CIDR 등 다시 조회 후 변경분 확인'}
              aria-label={autoUpdating ? `${cluster.name} 수집 중지` : `${cluster.name} 재수집`}>
              {autoUpdating
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <RefreshCw className="w-3.5 h-3.5" />}
            </button>
            {onCollectNics && (
              <button onClick={() => onCollectNics(cluster)}
                className="p-1.5 hover:bg-primary/10 rounded text-muted-foreground hover:text-primary transition-colors"
                title="NIC 수집 (SSH 기반) — bond0/bond1 IP/MAC 채움. kubectl 만으로는 인터페이스 이름을 알 수 없어 별도 SSH 수집 필요"
                aria-label={`${cluster.name} NIC 수집`}>
                <Cable className="w-3.5 h-3.5" />
              </button>
            )}
            <button onClick={() => onEdit(cluster)}
              className="p-1.5 hover:bg-secondary rounded text-muted-foreground hover:text-foreground transition-colors"
              title="전체 수정 — 이름/지역/운영레벨/메타데이터 등 폼 페이지로 이동"
              aria-label={`${cluster.name} 전체 수정`}>
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => onDelete(cluster)} disabled={deletingId === cluster.id}
              className="p-1.5 hover:bg-status-critical/10 rounded text-muted-foreground hover:text-status-critical disabled:opacity-40 transition-colors"
              title="삭제 — 클러스터와 연관된 Addon/Playbook/점검 이력이 함께 제거됩니다"
              aria-label={`${cluster.name} 삭제`}>
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground/50" title="조회 전용 계정입니다">조회 전용</span>
        )}
      </td>
    </tr>
  );
}
