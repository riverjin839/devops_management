import type { NodeSummary } from '@/services/api';
import type { Cluster } from '@/types';

/** SSH 접속 대상 1개 — 클러스터 노드이거나 직접 입력한 호스트. */
export interface SshTarget {
  /** `${clusterId}:${nodeName}` 또는 `host:${host}` — 열린 세션과 맞춰 보는 키. */
  key: string;
  clusterId: string | null;
  clusterName: string;
  nodeName?: string;
  host: string;
  controlPlane?: boolean;
}

export function nodeTarget(cluster: Cluster, n: NodeSummary): SshTarget | null {
  const host = n.internalIp || n.externalIp || '';
  if (!host) return null;
  return {
    key: `${cluster.id}:${n.name}`, clusterId: cluster.id, clusterName: cluster.name,
    nodeName: n.name, host, controlPlane: n.roles.includes('control-plane'),
  };
}
