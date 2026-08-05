import { useMemo, useState } from 'react';
import { Pencil, Trash2, Cpu, Network, AlertTriangle, RefreshCw, Loader2, Cable } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import type { Cluster } from '@/types';
import { STATUS_STYLE, OVERLAP_COLORS } from './constants';
import { useOperationLevels, levelBadgeClass, levelBadgeStyle, levelLabel, levelColor, levelIcon } from '@/hooks/useOperationLevels';
import { CidrRow } from './CidrRow';
import { InternalIpRow } from './InternalIpRow';
import { BondIpRow } from './BondIpRow';
import {
  extractInterfaceIps, extractInterfaceMacs, groupInternalIps, parseNodeIps,
} from './internalIp';

type CardTab = 'node' | 'network';

interface ClusterCardProps {
  cluster: Cluster;
  onEdit: (c: Cluster) => void;
  onDelete: (c: Cluster) => void;
  deletingId: string | null;
  overlapGroupIdx: number | undefined;
  onAutoUpdate: (c: Cluster) => void;
  /** 이 클러스터의 auto-update 진행 여부 — per-cluster 동시 진행 지원 (D-047) */
  autoUpdating: boolean;
  /** SSH 기반 NIC 수집(bond0/bond1 채움) 모달 열기 */
  onCollectNics?: (c: Cluster) => void;
  /** viewer 역할은 조회만 — 수집/수정/삭제 진입점을 노출하지 않는다 */
  canEdit?: boolean;
}

export function ClusterCard({ cluster, onEdit, onDelete, deletingId, overlapGroupIdx, onAutoUpdate, autoUpdating, onCollectNics, canEdit = true }: ClusterCardProps) {
  const [tab, setTab] = useState<CardTab>('node');
  const st = STATUS_STYLE[cluster.status] ?? STATUS_STYLE.pending;
  const { data: opsLevels } = useOperationLevels();
  const overlapColor = overlapGroupIdx !== undefined
    ? OVERLAP_COLORS[overlapGroupIdx % OVERLAP_COLORS.length]
    : null;

  // bond0/bond1 IP/MAC — nodeIps 의 모든 노드 인터페이스에서 모아 정규식 그룹 표기.
  // master 한 대에서만 채워지는 cluster.bond0Ip / bond1Ip 단일 필드는 fallback 으로만 사용.
  const nicData = useMemo(() => {
    const entries = parseNodeIps(cluster.nodeIps);
    const bond0Ips = extractInterfaceIps(entries, 'bond0');
    const bond1Ips = extractInterfaceIps(entries, 'bond1');
    return {
      bond0: {
        ips: bond0Ips,
        groups: groupInternalIps(bond0Ips),
        macs: extractInterfaceMacs(entries, 'bond0'),
      },
      bond1: {
        ips: bond1Ips,
        groups: groupInternalIps(bond1Ips),
        macs: extractInterfaceMacs(entries, 'bond1'),
      },
    };
  }, [cluster.nodeIps]);

  const hasBondData = nicData.bond0.ips.length > 0 || nicData.bond1.ips.length > 0
    || !!cluster.bond0Ip || !!cluster.bond1Ip
    || !!cluster.bond0Mac || !!cluster.bond1Mac;
  const hasNodeData    = !!(cluster.nodeCount || cluster.maxPod || cluster.hostname) || hasBondData;
  const hasNetworkData = !!(cluster.cidr || cluster.podCidr || cluster.svcCidr || cluster.nodeIps);

  return (
    <MacCard rootClassName={`border-l-4 ${st.border} mac-shadow`} bodyPadding="p-0" className="flex flex-col h-full">
      {/* 카드 헤더 */}
      <div className="px-4 pt-4 pb-3 border-b border-border/50">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${st.dot}`} />
              {cluster.operationLevel && (
                <span
                  className="text-lg leading-none flex-shrink-0"
                  title={`운영레벨: ${levelLabel(opsLevels, cluster.operationLevel)}`}
                  aria-hidden
                >
                  {levelIcon(opsLevels, cluster.operationLevel)}
                </span>
              )}
              <h3 className="text-sm font-bold truncate">{cluster.name}</h3>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${st.badge}`}>{st.label}</span>
              {cluster.operationLevel && (
                <span
                  className={`inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-full border ${levelBadgeClass(levelColor(opsLevels, cluster.operationLevel))}`}
                  style={levelBadgeStyle(opsLevels, cluster.operationLevel)}
                >
                  <span>{levelIcon(opsLevels, cluster.operationLevel)}</span>
                  <span>{levelLabel(opsLevels, cluster.operationLevel)}</span>
                </span>
              )}
              {cluster.region && (
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground">
                  {cluster.region}
                </span>
              )}
            </div>
          </div>
          {canEdit && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <button onClick={() => onAutoUpdate(cluster)}
                className={`p-1.5 rounded-md transition-colors ${
                  autoUpdating
                    ? 'bg-status-critical/10 text-status-critical hover:bg-status-critical/20'
                    : 'text-muted-foreground hover:bg-primary/10 hover:text-primary'
                }`}
                title={autoUpdating ? '중지' : '클러스터 정보 수집 (kubeconfig 기반)'}
                aria-label={autoUpdating ? `${cluster.name} 수집 중지` : `${cluster.name} 정보 수집`}>
                {autoUpdating
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <RefreshCw className="w-3.5 h-3.5" />}
              </button>
              {onCollectNics && (
                <button onClick={() => onCollectNics(cluster)}
                  className="p-1.5 hover:bg-primary/10 rounded-md transition-colors text-muted-foreground hover:text-primary"
                  title="NIC 수집 (SSH 기반) — bond0/bond1 IP/MAC 채움"
                  aria-label={`${cluster.name} NIC 수집`}>
                  <Cable className="w-3.5 h-3.5" />
                </button>
              )}
              <button onClick={() => onEdit(cluster)}
                className="p-1.5 hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-foreground"
                title="수정" aria-label={`${cluster.name} 수정`}>
                <Pencil className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => onDelete(cluster)} disabled={deletingId === cluster.id}
                className="p-1.5 hover:bg-status-critical/10 rounded-md transition-colors text-muted-foreground hover:text-status-critical disabled:opacity-40"
                title="삭제" aria-label={`${cluster.name} 삭제`}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
        <p className="text-xs font-mono text-muted-foreground/60 mt-1.5 truncate" title={cluster.apiEndpoint}>
          {cluster.apiEndpoint}
        </p>
      </div>

      {/* 탭 스위처 */}
      <div className="flex border-b border-border/50">
        <button onClick={() => setTab('node')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium transition-colors ${
            tab === 'node' ? 'text-primary border-b-2 border-primary bg-primary/5' : 'text-muted-foreground hover:text-foreground'
          }`}>
          <Cpu className="w-3 h-3" />노드 스펙
          {hasNodeData && tab !== 'node' && <span className="w-1.5 h-1.5 rounded-full bg-primary/50" />}
        </button>
        <button onClick={() => setTab('network')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium transition-colors ${
            tab === 'network' ? 'text-primary border-b-2 border-primary bg-primary/5' : 'text-muted-foreground hover:text-foreground'
          }`}>
          <Network className="w-3 h-3" />N/W CIDR
          {overlapColor && <AlertTriangle className="w-3 h-3 text-status-warning" />}
          {hasNetworkData && tab !== 'network' && !overlapColor && <span className="w-1.5 h-1.5 rounded-full bg-primary/50" />}
        </button>
      </div>

      {/* 탭 콘텐츠 */}
      <div className="px-4 py-3 flex-1">
        {tab === 'node' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-secondary/50 rounded-lg px-3 py-2 text-center">
                <p className="text-xs text-muted-foreground mb-0.5">노드 수</p>
                <p className="text-lg font-bold text-foreground">{cluster.nodeCount ?? <span className="text-muted-foreground text-sm">-</span>}</p>
              </div>
              <div className="bg-secondary/50 rounded-lg px-3 py-2 text-center">
                <p className="text-xs text-muted-foreground mb-0.5">Max Pod</p>
                <p className="text-lg font-bold text-foreground">{cluster.maxPod ?? <span className="text-muted-foreground text-sm">-</span>}</p>
              </div>
            </div>
            {cluster.hostname && (
              <div className="px-3 py-2 bg-secondary/30 rounded-lg">
                <p className="text-xs text-muted-foreground mb-0.5">호스트명</p>
                <p className="text-sm font-mono text-foreground truncate">{cluster.hostname}</p>
              </div>
            )}
            {hasBondData ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">NIC</p>
                <div className="grid grid-cols-2 gap-2">
                  <NicCompact
                    label="bond0"
                    groups={nicData.bond0.groups}
                    ipCount={nicData.bond0.ips.length}
                    macs={nicData.bond0.macs}
                    fallbackIp={cluster.bond0Ip ?? null}
                    fallbackMac={cluster.bond0Mac ?? null}
                  />
                  <NicCompact
                    label="bond1"
                    groups={nicData.bond1.groups}
                    ipCount={nicData.bond1.ips.length}
                    macs={nicData.bond1.macs}
                    fallbackIp={cluster.bond1Ip ?? null}
                    fallbackMac={cluster.bond1Mac ?? null}
                  />
                </div>
              </div>
            ) : (
              !cluster.nodeCount && !cluster.maxPod && !cluster.hostname && (
                <p className="text-sm text-muted-foreground/50 text-center py-2">노드 스펙 정보 없음 — 수정 버튼으로 입력하세요</p>
              )
            )}
          </div>
        )}

        {tab === 'network' && (
          <div className="space-y-2">
            <InternalIpRow cluster={cluster}
              overlapColor={cluster.cidr ? overlapColor : null} />
            <div className="grid grid-cols-2 gap-2">
              <BondIpRow cluster={cluster} bond="bond0" />
              <BondIpRow cluster={cluster} bond="bond1" />
            </div>
            <CidrRow label="Pod CIDR" cidr={cluster.podCidr} first={cluster.podFirstHost} last={cluster.podLastHost}
              color={{ bg: 'bg-chart-2/5', border: 'border-chart-2/20', text: 'text-chart-2', label: 'text-chart-2' }}
              overlapColor={cluster.podCidr ? overlapColor : null} />
            <CidrRow label="Service CIDR" cidr={cluster.svcCidr} first={cluster.svcFirstHost} last={cluster.svcLastHost}
              color={{ bg: 'bg-chart-4/5', border: 'border-chart-4/20', text: 'text-chart-4', label: 'text-chart-4' }}
              overlapColor={cluster.svcCidr ? overlapColor : null} />
            {cluster.ciliumConfig && (
              <div className="mt-1 pt-2 border-t border-border/40">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Cilium 설정</p>
                <pre className="text-xs font-mono text-muted-foreground bg-muted/20 rounded p-2 whitespace-pre-wrap max-h-20 overflow-y-auto">
                  {cluster.ciliumConfig}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>

      {cluster.description && (
        <div className="px-4 pb-3 pt-1 border-t border-border/30 mt-auto">
          <p className="text-xs text-muted-foreground/70 line-clamp-2">{cluster.description}</p>
        </div>
      )}
    </MacCard>
  );
}

/**
 * 노드 스펙 카드의 NIC 한 칸 — 모든 노드의 bond0/bond1 IP 들을 정규식 그룹 표기로,
 * MAC 들은 모든 값을 나열 (노드별 unique 라 그룹화 불가). nodeIps 미수집 시
 * fallback 으로 cluster.bond0Ip / bond0Mac 단일 값을 표시.
 */
function NicCompact({
  label, groups, ipCount, macs, fallbackIp, fallbackMac,
}: {
  label: string;
  groups: string[];
  ipCount: number;
  macs: string[];
  fallbackIp: string | null;
  fallbackMac: string | null;
}) {
  const hasGroups = groups.length > 0;
  const hasMacs = macs.length > 0;
  const hasFallback = !!fallbackIp || !!fallbackMac;
  if (!hasGroups && !hasMacs && !hasFallback) return null;
  return (
    <div className="border border-border rounded-lg px-2.5 py-2 bg-muted/10">
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-xs font-bold text-primary">{label}</p>
        {ipCount > 0 && (
          <span className="text-[10px] font-mono text-muted-foreground tabular-nums">{ipCount}개</span>
        )}
      </div>
      {/* IP — 그룹 표기 우선, 없으면 master 단일 값 fallback */}
      {hasGroups ? (
        <div className="mb-1">
          <p className="text-[10px] text-muted-foreground uppercase">IP</p>
          <div className="space-y-0.5">
            {groups.map((g, i) => (
              <p key={i} className="text-xs font-mono text-foreground tabular-nums"
                title="/24 단위로 묶어 마지막 옥텟의 연속 구간을 압축한 표기">
                {g}
              </p>
            ))}
          </div>
        </div>
      ) : fallbackIp ? (
        <div className="mb-1">
          <p className="text-[10px] text-muted-foreground uppercase">IP (master)</p>
          <p className="text-xs font-mono text-foreground">{fallbackIp}</p>
        </div>
      ) : null}
      {/* MAC — 모든 노드 MAC 나열 (보통 5개 이하). fallback 은 master 단일 */}
      {hasMacs ? (
        <div>
          <p className="text-[10px] text-muted-foreground uppercase">MAC ({macs.length})</p>
          <div className="space-y-0.5">
            {macs.map((m) => (
              <p key={m} className="text-xs font-mono text-foreground/90">{m}</p>
            ))}
          </div>
        </div>
      ) : fallbackMac ? (
        <div>
          <p className="text-[10px] text-muted-foreground uppercase">MAC (master)</p>
          <p className="text-xs font-mono text-foreground">{fallbackMac}</p>
        </div>
      ) : null}
    </div>
  );
}
