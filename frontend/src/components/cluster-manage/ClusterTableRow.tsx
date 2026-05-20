import { useRef, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Pencil, Trash2, AlertTriangle, RefreshCw, Loader2, ArrowUpRight, Cable, Server } from 'lucide-react';
import type { Cluster, ClusterCustomField } from '@/types';
import { useUpdateCluster } from '@/hooks/useCluster';
import { InlineEdit } from '@/components/common';
import { resolveClusterIcon } from '@/lib/clusterIcons';
import { STATUS_STYLE } from './constants';
import { useOperationLevels, levelBadgeClass, levelLabel, levelColor } from '@/hooks/useOperationLevels';
import { ClusterCustomCell } from './ClusterCustomCell';
import { extractInterfaceIps, extractInternalIps, groupInternalIps, parseNodeIps } from './internalIp';

interface ClusterTableRowProps {
  cluster: Cluster;
  onEdit: (c: Cluster) => void;
  onDelete: (c: Cluster) => void;
  deletingId: string | null;
  overlapGroupIdx: number | undefined;
  onCilium: (c: Cluster) => void;
  onAutoUpdate: (c: Cluster) => void;
  autoUpdatingId: string | null;
  customFields?: ClusterCustomField[];
  /** 노드 IP 만 수집 (diff 다이얼로그 없이 즉시 적용) */
  onCollectNodeIps?: (c: Cluster) => void;
  collectingNodeIpsId?: string | null;
  /** SSH 기반 NIC 수집(bond0/bond1 채움) 모달 열기 */
  onCollectNics?: (c: Cluster) => void;
}

type EditField = null | 'region' | 'operationLevel' | 'cidr' | 'podCidr' | 'svcCidr';

/** 편집 가능 셀 wrapper — 더블클릭 OR hover 시 나타나는 ✏️ 아이콘 클릭으로 진입.
 *  text 선택을 막아 dblclick 이 안정적으로 발화되게 함.
 */
function EditableCell({
  isEditing, onEnter, children, className = '',
}: {
  isEditing: boolean;
  onEnter: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  if (isEditing) {
    return <td className={`px-3 py-2.5 ${className}`}>{children}</td>;
  }
  return (
    <td
      className={`px-3 py-2.5 select-none cursor-pointer relative group hover:bg-primary/5 transition-colors ${className}`}
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
        className="absolute top-1 right-1 p-0.5 rounded opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary hover:bg-secondary/80 transition-opacity"
        title="이 셀 수정"
        aria-label="수정"
      >
        <Pencil className="w-3 h-3" />
      </button>
    </td>
  );
}

export function ClusterTableRow({ cluster, onEdit, onDelete, deletingId, overlapGroupIdx, onCilium, onAutoUpdate, autoUpdatingId, customFields = [], onCollectNodeIps, collectingNodeIpsId, onCollectNics }: ClusterTableRowProps) {
  const updateCluster = useUpdateCluster();
  const [editingField, setEditingField] = useState<EditField>(null);
  const iconAnchorRef = useRef<HTMLSpanElement | null>(null);

  const quickUpdate = (patch: Partial<Cluster>) => {
    updateCluster.mutate({ id: cluster.id, data: patch }, { onSettled: () => setEditingField(null) });
  };

  const resolvedIcon = resolveClusterIcon(cluster.icon);
  const FallbackIcon = Server;
  const st = STATUS_STYLE[cluster.status] ?? STATUS_STYLE.pending;
  const { data: opsLevels } = useOperationLevels();
  const lv = cluster.operationLevel ? levelBadgeClass(levelColor(opsLevels, cluster.operationLevel)) : undefined;
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
    <tr className="border-b border-border hover:bg-secondary/20 transition-colors">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
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
          <span className="font-medium text-sm text-foreground">{cluster.name}</span>
        </div>
        {cluster.hostname && (
          <p className="text-[10px] font-mono text-muted-foreground mt-0.5 ml-4">{cluster.hostname}</p>
        )}
      </td>
      <td className="px-3 py-2.5">
        <span className={`text-[11px] px-2 py-0.5 rounded-full border ${st.badge}`}>{st.label}</span>
      </td>

      {/* 지역 — 인라인 편집 */}
      <EditableCell
        isEditing={editingField === 'region'}
        onEnter={() => setEditingField('region')}
        className="text-sm text-muted-foreground"
      >
        {editingField === 'region' ? (
          <InlineEdit
            value={cluster.region ?? ''}
            onSave={(v) => quickUpdate({ region: v || undefined })}
            onCancel={() => setEditingField(null)}
            placeholder="예: 서울"
            inputClassName="text-sm"
          />
        ) : (cluster.region || <span className="text-muted-foreground/60">-</span>)}
      </EditableCell>

      {/* 운영레벨 — select 인라인 */}
      <EditableCell
        isEditing={editingField === 'operationLevel'}
        onEnter={() => setEditingField('operationLevel')}
      >
        {editingField === 'operationLevel' ? (
          <select
            autoFocus
            value={cluster.operationLevel ?? ''}
            onChange={(e) => quickUpdate({ operationLevel: e.target.value || undefined })}
            onBlur={() => setEditingField(null)}
            className="text-xs bg-background border border-border rounded px-1.5 py-0.5"
          >
            <option value="">—</option>
            {(opsLevels ?? []).map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        ) : cluster.operationLevel ? (
          <span className={`text-[11px] px-2 py-0.5 rounded-full border ${lv}`}>
            {levelLabel(opsLevels, cluster.operationLevel)}
          </span>
        ) : <span className="text-muted-foreground/60 text-xs">-</span>}
      </EditableCell>

      <td className="px-3 py-2.5">
        {cluster.bgpEnabled ? (
          <div>
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-400 border border-cyan-500/30">BGP</span>
            {cluster.asNumber && <p className="text-[10px] font-mono text-muted-foreground mt-0.5">AS{cluster.asNumber}</p>}
          </div>
        ) : <span className="text-muted-foreground/60 text-xs">-</span>}
      </td>

      {/* INTERNAL_IP — kubectl InternalIP 들을 정규식/Glob 형식으로 묶어 표시 */}
      <EditableCell
        isEditing={editingField === 'cidr'}
        onEnter={() => setEditingField('cidr')}
      >
        {editingField === 'cidr' ? (
          <InlineEdit
            value={cluster.cidr ?? ''}
            onSave={(v) => quickUpdate({ cidr: v || undefined })}
            onCancel={() => setEditingField(null)}
            placeholder="192.168.0.0/24 (fallback)"
            inputClassName="text-xs font-mono"
          />
        ) : (() => {
          const manualGroups = (cluster.internalIps ?? '')
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean);
          const hasAuto = ipBuckets.internal.groups.length > 0;
          const hasManual = manualGroups.length > 0;
          const hasContent = hasAuto || hasManual || Boolean(cluster.cidr);
          if (!hasContent) return <span className="text-muted-foreground/60 text-xs">-</span>;
          return (
          <div>
            {hasAuto ? (
              <div title="kubectl get nodes -o wide 의 InternalIP 들을 /24 단위로 묶은 표기 (마지막 옥텟 연속 구간 압축)">
                {ipBuckets.internal.groups.map((g, i) => (
                  <p key={i} className="text-xs font-mono text-foreground tabular-nums">{g}</p>
                ))}
                <p className="text-[10px] text-muted-foreground/80 mt-0.5">
                  {ipBuckets.internal.ips.length}개 노드
                </p>
              </div>
            ) : hasManual ? (
              <div title="수동 입력된 IP 리스트 (정규식)">
                {manualGroups.map((g, i) => (
                  <p key={i} className="text-xs font-mono text-foreground tabular-nums">{g}</p>
                ))}
                <p className="text-[10px] text-muted-foreground/80 mt-0.5">수동 입력 (정규식)</p>
              </div>
            ) : (
              <p className="text-xs font-mono text-muted-foreground" title="nodeIps / internalIps 미입력 — fallback CIDR">
                <span className="text-muted-foreground/60 text-[10px] mr-1">fallback</span>
                <span className="text-foreground">{cluster.cidr}</span>
              </p>
            )}
            <div className="flex items-center gap-1 mt-1">
              {overlapGroupIdx !== undefined && (
                <span className="text-[10px] text-amber-600 inline-flex items-center gap-0.5">
                  <AlertTriangle className="w-2.5 h-2.5" />겹침
                </span>
              )}
              {cluster.cidr && (
                <Link
                  to={`/cidr?cidr=${encodeURIComponent(cluster.cidr)}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-[10px] text-muted-foreground hover:text-primary inline-flex items-center gap-0.5 ml-auto px-1 py-0.5 rounded hover:bg-primary/10 transition-colors"
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

      {/* bond0 — 모든 노드 bond0 IP 들 정규식/Glob 그룹화 */}
      <td className="px-3 py-2.5 align-top">
        {ipBuckets.bond0.groups.length > 0 ? (
          <div>
            {ipBuckets.bond0.groups.map((g, i) => (
              <p key={i} className="text-xs font-mono text-cyan-700 tabular-nums" title="모든 노드 bond0 IP /24 묶음">{g}</p>
            ))}
            <p className="text-[10px] text-muted-foreground/80 mt-0.5">{ipBuckets.bond0.ips.length}개 IP</p>
          </div>
        ) : <span className="text-muted-foreground/50 text-xs" title="NIC 수집(SSH) 후 채워짐">-</span>}
      </td>

      {/* bond1 */}
      <td className="px-3 py-2.5 align-top">
        {ipBuckets.bond1.groups.length > 0 ? (
          <div>
            {ipBuckets.bond1.groups.map((g, i) => (
              <p key={i} className="text-xs font-mono text-amber-700 tabular-nums" title="모든 노드 bond1 IP /24 묶음">{g}</p>
            ))}
            <p className="text-[10px] text-muted-foreground/80 mt-0.5">{ipBuckets.bond1.ips.length}개 IP</p>
          </div>
        ) : <span className="text-muted-foreground/50 text-xs" title="NIC 수집(SSH) 후 채워짐">-</span>}
      </td>

      {/* Pod CIDR */}
      <EditableCell
        isEditing={editingField === 'podCidr'}
        onEnter={() => setEditingField('podCidr')}
      >
        {editingField === 'podCidr' ? (
          <InlineEdit
            value={cluster.podCidr ?? ''}
            onSave={(v) => quickUpdate({ podCidr: v || undefined })}
            onCancel={() => setEditingField(null)}
            placeholder="10.244.0.0/16"
            inputClassName="text-xs font-mono"
          />
        ) : cluster.podCidr ? (
          <div>
            <p className="text-xs font-mono text-foreground">{cluster.podCidr}</p>
            {(cluster.podFirstHost || cluster.podLastHost) && (
              <p className="text-[10px] font-mono text-muted-foreground">{cluster.podFirstHost} ~ {cluster.podLastHost}</p>
            )}
          </div>
        ) : <span className="text-muted-foreground/60 text-xs">-</span>}
      </EditableCell>

      {/* Service CIDR */}
      <EditableCell
        isEditing={editingField === 'svcCidr'}
        onEnter={() => setEditingField('svcCidr')}
      >
        {editingField === 'svcCidr' ? (
          <InlineEdit
            value={cluster.svcCidr ?? ''}
            onSave={(v) => quickUpdate({ svcCidr: v || undefined })}
            onCancel={() => setEditingField(null)}
            placeholder="10.96.0.0/12"
            inputClassName="text-xs font-mono"
          />
        ) : cluster.svcCidr ? (
          <div>
            <p className="text-xs font-mono text-foreground">{cluster.svcCidr}</p>
            {(cluster.svcFirstHost || cluster.svcLastHost) && (
              <p className="text-[10px] font-mono text-muted-foreground">{cluster.svcFirstHost} ~ {cluster.svcLastHost}</p>
            )}
          </div>
        ) : <span className="text-muted-foreground/60 text-xs">-</span>}
      </EditableCell>

      <td className="px-3 py-2.5 text-sm text-center">
        {cluster.maxPod
          ? <span className="font-mono text-foreground">{cluster.maxPod}</span>
          : <span className="text-muted-foreground/60 text-xs">-</span>}
      </td>
      {/* K8s / Cilium 버전 */}
      <td className="px-3 py-2.5">
        <div className="flex flex-col gap-1">
          {cluster.k8sVersion ? (
            <span className="text-[11px] font-mono px-1.5 py-0.5 rounded-full bg-sky-500/10 text-sky-500 border border-sky-500/20 w-fit">
              k8s {cluster.k8sVersion}
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground/60 italic">k8s 미수집</span>
          )}
          <button
            type="button"
            onClick={() => onCilium(cluster)}
            title={cluster.ciliumVersion
              ? `Cilium ${cluster.ciliumVersion} — 클릭 시 설정 보기`
              : 'Cilium 버전 미수집 — 클릭 시 cilium-config ConfigMap 으로 조회/설정'}
            className={`text-[11px] font-mono px-1.5 py-0.5 rounded-full border w-fit transition-colors ${
              cluster.ciliumVersion
                ? 'bg-cyan-500/10 text-cyan-500 border-cyan-500/30 hover:bg-cyan-500/20'
                : 'bg-secondary text-muted-foreground border-border hover:bg-secondary/80 hover:text-foreground'
            }`}
          >
            {cluster.ciliumVersion ? `cilium ${cluster.ciliumVersion}` : 'cilium 설정 →'}
          </button>
        </div>
      </td>

      {/* 노드 IP 목록 — 노드당 여러 IP (bond0/bond1) + public/private 스코프 표시 */}
      <td className="px-3 py-2.5">
        {(() => {
          if (!cluster.nodeIps) {
            const isCollecting = collectingNodeIpsId === cluster.id;
            return (
              <div className="flex items-center gap-2 text-[11px]">
                {cluster.nodeCount
                  ? <span className="text-muted-foreground">노드 {cluster.nodeCount}개</span>
                  : <span className="text-muted-foreground/60">-</span>}
                {onCollectNodeIps && (
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
              <div className="text-[11px] font-mono space-y-0.5">
                {shown.map((n) => {
                  const ifaces = n.interfaces ?? [];
                  if (ifaces.length > 0) {
                    return (
                      <div key={n.name} className="space-y-0.5"
                        title={`${n.name}${n.externalIp ? ` · ext: ${n.externalIp}` : ''}`}>
                        <div className={`flex items-center gap-1 ${n.master ? 'text-foreground' : 'text-foreground/80'}`}>
                          {n.master && <span className="inline-block w-1 h-1 rounded-full bg-primary align-middle" />}
                          <span className="text-[10px] text-muted-foreground/80 truncate max-w-[120px]">{n.name}</span>
                        </div>
                        {ifaces.map((ifc) => {
                          const scopes = ifc.scopes ?? [];
                          const ips = ifc.ips ?? [];
                          return (
                            <div key={`${n.name}-${ifc.name}`} className="flex items-center gap-1 flex-wrap pl-2">
                              <span className="text-[9px] text-muted-foreground/70">{ifc.name}</span>
                              {ips.map((ip, i) => {
                                const sc = scopes[i] ?? 'unknown';
                                const isPub = sc === 'public';
                                return (
                                  <span key={ip}
                                    className={`text-[10px] px-1 rounded ${
                                      isPub
                                        ? 'bg-amber-500/10 text-amber-500'
                                        : 'bg-sky-500/10 text-sky-500'
                                    }`}
                                    title={isPub ? 'public' : sc}>
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
                    <span className="text-[10px] text-primary/70" title="노드당 IP 여러 개 (bond0/bond1 등)">
                      다중 IP {multiCount}대
                    </span>
                  )}
                  {pubCount > 0 && (
                    <span className="text-[10px] text-amber-500/80" title="public IP 보유 NIC 수">
                      public {pubCount}건
                    </span>
                  )}
                  {!hasIfaces && (
                    <span className="text-[10px] text-muted-foreground/60" title="NIC 상세 미수집 — 'NIC 수집' 실행 시 채워집니다.">
                      NIC 미수집
                    </span>
                  )}
                </div>
              </div>
            );
          } catch {
            return <p className="text-[10px] font-mono text-muted-foreground truncate">{cluster.nodeIps}</p>;
          }
        })()}
      </td>

      {customFields.map((f) => (
        <td key={f.id} className="px-3 py-2.5 border-l border-primary/10 align-top" style={f.width ? { width: f.width } : undefined}>
          <ClusterCustomCell cluster={cluster} field={f} />
        </td>
      ))}

      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1">
          <button onClick={() => onAutoUpdate(cluster)}
            className={`p-1.5 rounded transition-colors ${
              autoUpdatingId === cluster.id
                ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                : 'text-muted-foreground hover:bg-primary/10 hover:text-primary'
            }`}
            title={autoUpdatingId === cluster.id
              ? '수집 중지'
              : '재수집(diff 미리보기) — kubeconfig 로 노드 / 버전 / CIDR 등 다시 조회 후 변경분 확인'}>
            {autoUpdatingId === cluster.id
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <RefreshCw className="w-3.5 h-3.5" />}
          </button>
          {onCollectNics && (
            <button onClick={() => onCollectNics(cluster)}
              className="p-1.5 hover:bg-primary/10 rounded text-muted-foreground hover:text-primary transition-colors"
              title="NIC 수집 (SSH 기반) — bond0/bond1 IP/MAC 채움. kubectl 만으로는 인터페이스 이름을 알 수 없어 별도 SSH 수집 필요">
              <Cable className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={() => onEdit(cluster)}
            className="p-1.5 hover:bg-secondary rounded text-muted-foreground hover:text-foreground transition-colors"
            title="전체 수정 — 이름/지역/운영레벨/메타데이터 등 폼 페이지로 이동">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => onDelete(cluster)} disabled={deletingId === cluster.id}
            className="p-1.5 hover:bg-red-500/10 rounded text-muted-foreground hover:text-red-400 disabled:opacity-40 transition-colors"
            title="삭제 — 클러스터와 연관된 Addon/Playbook/점검 이력이 함께 제거됩니다">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
}
