import type { TopoNode, TopoEdge } from '@/types';

// ── kind → 컬럼 랭크 (좌→우 계층) ────────────────────────────────────────────
export function kindRank(kind: string): number {
  switch (kind) {
    case 'Ingress': return 0;
    case 'Service': return 1;
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'Job':
    case 'CronJob': return 2;
    case 'Pod': return 3;
    case 'ConfigMap':
    case 'Secret':
    case 'PersistentVolumeClaim': return 4;
    case 'External': return 5;
    default: return 2;
  }
}

// ── kind → 짧은 약어/색 ──────────────────────────────────────────────────────
export const KIND_ABBR: Record<string, string> = {
  Ingress: 'ING', Service: 'SVC', Deployment: 'DEP', StatefulSet: 'STS',
  DaemonSet: 'DS', Job: 'JOB', CronJob: 'CRON', Pod: 'POD',
  ConfigMap: 'CM', Secret: 'SEC', PersistentVolumeClaim: 'PVC', External: 'EXT',
};

export const KIND_ACCENT: Record<string, string> = {
  Ingress: '#8b5cf6', Service: '#0ea5e9', Deployment: '#10b981', StatefulSet: '#14b8a6',
  DaemonSet: '#22c55e', Job: '#eab308', CronJob: '#f59e0b', Pod: '#64748b',
  ConfigMap: '#6366f1', Secret: '#ec4899', PersistentVolumeClaim: '#06b6d4', External: '#94a3b8',
};

export function kindAccent(kind: string): string {
  return KIND_ACCENT[kind] ?? '#64748b';
}

// ── status → 색 ──────────────────────────────────────────────────────────────
export function statusColor(status: string): string {
  switch (status) {
    case 'critical': return '#ef4444';
    case 'warning': return '#f59e0b';
    case 'healthy': return '#10b981';
    default: return '#94a3b8';
  }
}

// ── edge type → 시각 스타일 ──────────────────────────────────────────────────
export interface EdgeStyle { stroke: string; dash?: string; width: number; animated?: boolean; }
export function edgeStyle(type: string, dropped = false): EdgeStyle {
  switch (type) {
    case 'routes':      return { stroke: '#0ea5e9', width: 1.5 };
    case 'exposes':     return { stroke: '#8b5cf6', width: 1.5 };
    case 'owns':        return { stroke: '#cbd5e1', width: 1, dash: '2 3' };
    case 'uses_config': return { stroke: '#6366f1', width: 1.2, dash: '4 3' };
    case 'uses_secret': return { stroke: '#ec4899', width: 1.2, dash: '4 3' };
    case 'mounts_pvc':  return { stroke: '#06b6d4', width: 1.2, dash: '4 3' };
    case 'manual':      return { stroke: '#f97316', width: 1.8, dash: '1 4' };
    case 'traffic':     return { stroke: dropped ? '#ef4444' : '#f59e0b', width: 2, dash: '6 4', animated: true };
    default:            return { stroke: '#94a3b8', width: 1.2 };
  }
}

export const EDGE_TYPE_LABEL: Record<string, string> = {
  routes: 'Service→워크로드', exposes: 'Ingress→Service', owns: '소유',
  uses_config: 'ConfigMap 사용', uses_secret: 'Secret 사용', mounts_pvc: 'PVC 마운트',
  manual: '수동 연계', traffic: '실트래픽',
};

// ── 메트릭 포맷 ──────────────────────────────────────────────────────────────
export function fmtCpu(cores?: number | null): string {
  if (cores == null) return 'n/a';
  if (cores < 1) return `${Math.round(cores * 1000)}m`;
  return `${cores.toFixed(2)}`;
}
export function fmtMem(bytes?: number | null): string {
  if (bytes == null) return 'n/a';
  const gi = bytes / 1024 ** 3;
  if (gi >= 1) return `${gi.toFixed(2)} Gi`;
  const mi = bytes / 1024 ** 2;
  return `${Math.round(mi)} Mi`;
}
/** usage/limit(없으면 request) → 0~1 비율. 둘 다 없으면 null. */
export function usageRatio(usage?: number | null, request?: number | null, limit?: number | null): number | null {
  const denom = limit ?? request;
  if (usage == null || !denom || denom <= 0) return null;
  return Math.max(0, Math.min(1, usage / denom));
}

// ── 레이아웃: 컬럼 랭크 + 컴포넌트 그룹핑 결정적 배치 ─────────────────────────
export interface LayoutPos { x: number; y: number; }
export const NODE_W = 150;
export const NODE_H = 52;
const COL_GAP = 90;
const ROW_GAP = 18;

export function computeLayout(nodes: TopoNode[], edges: TopoEdge[]): Record<string, LayoutPos> {
  // 연결 컴포넌트 그룹 → 같은 그룹은 가까이 정렬(안정).
  const adj = new Map<string, Set<string>>();
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) adj.set(n.id, new Set());
  for (const e of edges) {
    if (ids.has(e.source) && ids.has(e.target)) {
      adj.get(e.source)!.add(e.target);
      adj.get(e.target)!.add(e.source);
    }
  }
  const groupOf = new Map<string, number>();
  let g = 0;
  for (const n of nodes) {
    if (groupOf.has(n.id)) continue;
    const stack = [n.id];
    groupOf.set(n.id, g);
    while (stack.length) {
      const cur = stack.pop()!;
      for (const nb of adj.get(cur) ?? []) {
        if (!groupOf.has(nb)) { groupOf.set(nb, g); stack.push(nb); }
      }
    }
    g += 1;
  }

  // 랭크별로 (group, name) 정렬 후 행 배치.
  const byRank = new Map<number, TopoNode[]>();
  for (const n of nodes) {
    const r = kindRank(n.kind);
    (byRank.get(r) ?? byRank.set(r, []).get(r)!).push(n);
  }
  const pos: Record<string, LayoutPos> = {};
  for (const [rank, list] of byRank) {
    list.sort((a, b) => (groupOf.get(a.id)! - groupOf.get(b.id)!) || a.name.localeCompare(b.name));
    list.forEach((n, i) => {
      pos[n.id] = { x: rank * (NODE_W + COL_GAP), y: i * (NODE_H + ROW_GAP) };
    });
  }
  return pos;
}
