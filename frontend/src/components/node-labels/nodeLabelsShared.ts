import { NodeRow } from '@/hooks/useNodeLabels';

/** 노드명·클러스터명 또는 레이블 키/값에 검색어가 포함되는지. (멀티클러스터) */
export function matchesSearch(node: NodeRow, query: string): boolean {
  if (!query.trim()) return true;
  const q = query.toLowerCase();
  if (node.name.toLowerCase().includes(q)) return true;
  if (node.clusterName.toLowerCase().includes(q)) return true;
  return Object.entries(node.labels ?? {}).some(
    ([k, v]) => k.toLowerCase().includes(q) || (v ?? '').toLowerCase().includes(q),
  );
}

/** 레이블이 적용된 노드 참조 — 노드명이 클러스터 간 충돌 가능하므로 클러스터를 함께 보관. */
export interface LabelNodeRef {
  clusterId: string;
  clusterName: string;
  name: string;
}

export interface LabelEntry {
  key: string;
  value: string;
  tag: string;            // 'key=value' (value 없으면 key)
  nodes: LabelNodeRef[];  // 이 레이블을 가진 노드들(클러스터 포함)
}

/** 노드 목록 → 레이블(tag) 기준 그룹. 모든 노드의 모든 라벨을 누락 없이 집계.
 *  system 레이블(kubernetes.io/k8s.io) 후순위, 그 외 tag 사전순 정렬. */
export function buildLabelEntries(nodes: NodeRow[]): LabelEntry[] {
  const map = new Map<string, { nodes: LabelNodeRef[]; value: string }>();
  for (const node of nodes) {
    for (const [k, v] of Object.entries(node.labels ?? {})) {
      const tag = v ? `${k}=${v}` : k;
      const ref: LabelNodeRef = { clusterId: node.clusterId, clusterName: node.clusterName, name: node.name };
      const entry = map.get(tag);
      if (entry) {
        entry.nodes.push(ref);
      } else {
        map.set(tag, { nodes: [ref], value: v });
      }
    }
  }
  return Array.from(map.entries())
    .map(([tag, { nodes: ns, value }]) => ({
      key: tag.split('=')[0],
      value,
      tag,
      nodes: ns,
    }))
    .sort((a, b) => {
      const aSystem = a.key.includes('kubernetes.io') || a.key.includes('k8s.io');
      const bSystem = b.key.includes('kubernetes.io') || b.key.includes('k8s.io');
      if (aSystem !== bSystem) return aSystem ? 1 : -1;
      return a.tag.localeCompare(b.tag);
    });
}

/** 레이블 엔트리에 검색어 필터(tag 또는 적용 노드명/클러스터명). */
export function filterLabelEntries(entries: LabelEntry[], query: string): LabelEntry[] {
  if (!query.trim()) return entries;
  const q = query.toLowerCase();
  return entries.filter(
    (entry) =>
      entry.tag.toLowerCase().includes(q) ||
      entry.nodes.some((n) => n.name.toLowerCase().includes(q) || n.clusterName.toLowerCase().includes(q)),
  );
}
