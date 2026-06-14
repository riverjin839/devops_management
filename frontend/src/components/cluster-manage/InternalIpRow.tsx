import type { OverlapColor } from './constants';
import { extractInternalIps, groupInternalIps, parseNodeIps } from './internalIp';
import { IpGroupRow } from './IpGroupRow';

interface InternalIpRowProps {
  /** 표시 대상 클러스터 — 우선순위: nodeIps(자동수집) > internalIps(수동 정규식) > cidr(fallback supernet) */
  cluster: { cidr?: string; internalIps?: string; nodeIps?: string };
  overlapColor?: OverlapColor | null;
}

/** 사용자가 직접 입력한 IP 리스트 정규식 문자열을 줄 단위로 분리한 그룹 배열로 반환. */
function splitManualGroups(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Cluster 카드의 네트워크 탭에서 사용되는 INTERNAL_IP 표시 행.
 *
 * 표시 우선순위:
 *  1. `cluster.nodeIps`  — kubectl 자동수집 InternalIP → /24 단위 정규식으로 압축
 *  2. `cluster.internalIps` — 수동 입력된 IP 리스트 정규식 (예: "10.0.1.[5-7,10]")
 *  3. `cluster.cidr`     — fallback supernet (CIDR 표기)
 */
export function InternalIpRow({ cluster, overlapColor }: InternalIpRowProps) {
  const entries = parseNodeIps(cluster.nodeIps);
  const ips = extractInternalIps(entries);
  const autoGroups = groupInternalIps(ips);
  const manualGroups = splitManualGroups(cluster.internalIps);

  // 자동수집이 있으면 그것을, 없고 수동 정규식이 있으면 그것을 사용.
  const groups = autoGroups.length > 0 ? autoGroups : manualGroups;
  const totalIps = autoGroups.length > 0 ? ips.length : 0;

  const fallback = cluster.cidr ? (
    <p className="text-sm font-mono text-muted-foreground" title="nodeIps / internalIps 미입력 — fallback CIDR">
      <span className="text-muted-foreground/70 text-xs mr-1">fallback CIDR</span>
      <span className="text-foreground">{cluster.cidr}</span>
    </p>
  ) : null;

  return (
    <IpGroupRow
      label="INTERNAL_IP"
      groups={groups}
      totalIps={totalIps}
      accent="sky"
      emptyMessage="미수집 — 자동수집(kubectl) 후 노드 InternalIP 가 표시됩니다"
      fallback={fallback}
      hasContent={groups.length > 0 || Boolean(cluster.cidr)}
      calcCidr={cluster.cidr}
      overlapColor={overlapColor}
    />
  );
}
