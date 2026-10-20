import { useMemo } from 'react';
import type { TopoNode, TopoEdge } from '@/types';
import { cssVarColor, useThemeColorKey } from '@/lib/chartTokens';

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
  ConfigMap: 'CM', Secret: 'SEC', PersistentVolumeClaim: 'PVC', External: 'EXT', Namespace: 'NS',
};

/** 종류 구분 색 = `--chart-1..8` 토큰(+같은 계열 안 명도 차) — raw hex 금지(DESIGN_SYSTEM §12.12-7, R-1).
 *  워크로드 3종·Job 2종·Ingress/Namespace 는 같은 계열에서 lighten 으로 가른다. */
export interface ColorToken { token: string; lighten?: number }
export const KIND_TOKEN: Record<string, ColorToken> = {
  Ingress: { token: '--chart-4' },
  Service: { token: '--chart-1' },
  Deployment: { token: '--chart-2' },
  StatefulSet: { token: '--chart-2', lighten: 12 },
  DaemonSet: { token: '--chart-2', lighten: -10 },
  Job: { token: '--chart-3' },
  CronJob: { token: '--chart-3', lighten: 12 },
  Pod: { token: '--chart-8' },
  ConfigMap: { token: '--chart-8', lighten: 14 },
  Secret: { token: '--chart-5' },
  PersistentVolumeClaim: { token: '--chart-6' },
  External: { token: '--muted-foreground' },
  Namespace: { token: '--chart-4', lighten: -10 },
};
const KIND_FALLBACK: ColorToken = { token: '--chart-8' };

/** kind 색을 현재 테마 값의 리터럴(`hsl(...)`)로 — three.js·export 처럼 var() 를 못 읽는 곳에서도 쓴다.
 *  호출 시점의 테마 값이므로 컴포넌트에서는 `useTopologyColors()`(테마 전환 시 재계산)를 쓴다. */
export function kindAccentColor(kind: string, alpha?: number): string {
  const t = KIND_TOKEN[kind] ?? KIND_FALLBACK;
  return cssVarColor(t.token, { lighten: t.lighten, alpha });
}

// ── status → 색 ──────────────────────────────────────────────────────────────
// SVG/DOM 용 — 테마 토큰을 따른다(D-097). three.js(3D)는 CSS 변수를 못 읽으므로 이 함수를 쓰지 않는다.
export function statusColor(status: string): string {
  switch (status) {
    case 'critical': return 'hsl(var(--status-critical))';
    case 'warning': return 'hsl(var(--status-warning))';
    case 'healthy': return 'hsl(var(--muted-foreground) / 0.4)'; // 정상은 무채색(DESIGN_SYSTEM §12.12-3)
    default: return 'hsl(var(--status-pending))';
  }
}

/** 상태를 색만으로 전달하지 않도록 함께 쓰는 글자(D-096). */
export function statusGlyph(status: string): string {
  switch (status) {
    case 'critical': return '!';
    case 'warning': return '?';
    case 'healthy': return '';
    default: return '·';
  }
}

// ── edge type → 시각 스타일 ──────────────────────────────────────────────────
/** 선 패턴 + 색 토큰. 렌더러별 색 문자열은 edgeStyleToken(SVG/DOM) · useTopologyColors().edge(three.js) 로 만든다. */
export interface EdgeSpec { token: string; dash?: string; width: number; animated?: boolean; }
export function edgeStyle(type: string, dropped = false): EdgeSpec {
  switch (type) {
    case 'routes':      return { token: '--chart-1', width: 1.5 };
    case 'exposes':     return { token: '--chart-4', width: 1.5 };
    case 'owns':        return { token: '--muted-foreground', width: 1, dash: '2 3' };
    case 'uses_config': return { token: '--chart-8', width: 1.2, dash: '4 3' };
    case 'uses_secret': return { token: '--chart-5', width: 1.2, dash: '4 3' };
    case 'mounts_pvc':  return { token: '--chart-6', width: 1.2, dash: '4 3' };
    case 'manual':      return { token: '--chart-7', width: 1.8, dash: '1 4' };
    case 'traffic':     return { token: dropped ? '--status-critical' : '--status-warning', width: 2, dash: '6 4', animated: true };
    default:            return { token: '--muted-foreground', width: 1.2 };
  }
}

export interface EdgeStyle { stroke: string; dash?: string; width: number; animated?: boolean; }
/** SVG/DOM 용 엣지 스타일 — `hsl(var(--token))`(D-097). export 는 resolveCssVars 가 var() 를 풀어 준다. */
export function edgeStyleToken(type: string, dropped = false): EdgeStyle {
  const { token, ...rest } = edgeStyle(type, dropped);
  return { ...rest, stroke: `hsl(var(${token}))` };
}

const EDGE_TYPES = ['routes', 'exposes', 'owns', 'uses_config', 'uses_secret', 'mounts_pvc', 'manual', 'traffic'];

/** 토폴로지 색 팔레트(현재 테마의 리터럴 색) — 테마·강조색이 바뀌면 다시 계산된다.
 *  WebGL(three.js)과 var() 를 못 읽는 export 경로 모두 이 값을 쓴다. */
export function useTopologyColors() {
  const themeKey = useThemeColorKey();
  return useMemo(() => {
    void themeKey;
    const kindMap: Record<string, string> = Object.fromEntries(
      Object.keys(KIND_TOKEN).map((k) => [k, kindAccentColor(k)]),
    );
    const kindFallback = kindAccentColor('');
    const edgeMap: Record<string, string> = Object.fromEntries(
      EDGE_TYPES.map((t) => [t, cssVarColor(edgeStyle(t).token)]),
    );
    const droppedColor = cssVarColor(edgeStyle('traffic', true).token);
    const edgeFallback = cssVarColor(edgeStyle('').token);
    return {
      themeKey,
      background: cssVarColor('--background'),
      kind: (kind: string): string => kindMap[kind] ?? kindFallback,
      edge: (type: string, dropped = false): string =>
        (type === 'traffic' && dropped ? droppedColor : edgeMap[type] ?? edgeFallback),
    };
  }, [themeKey]);
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
/** detail(클러스터) 모드의 네임스페이스 그룹 박스. */
export interface NamespaceBox { namespace: string; x: number; y: number; w: number; h: number; }
export interface LayoutResult { pos: Record<string, LayoutPos>; groups: NamespaceBox[]; }
export const NODE_W = 150;
export const NODE_H = 52;
const COL_GAP = 90;
const ROW_GAP = 18;

/** rank-컬럼 레이아웃(기존 알고리즘) — origin 오프셋 + bbox 반환. */
function rankColumnLayout(
  nodes: TopoNode[], edges: TopoEdge[], originX = 0, originY = 0,
): { pos: Record<string, LayoutPos>; w: number; h: number } {
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
  const byRank = new Map<number, TopoNode[]>();
  for (const n of nodes) {
    const r = kindRank(n.kind);
    (byRank.get(r) ?? byRank.set(r, []).get(r)!).push(n);
  }
  const pos: Record<string, LayoutPos> = {};
  let maxRank = 0; let maxRows = 0;
  for (const [rank, list] of byRank) {
    list.sort((a, b) => (groupOf.get(a.id)! - groupOf.get(b.id)!) || a.name.localeCompare(b.name));
    list.forEach((n, i) => {
      pos[n.id] = { x: originX + rank * (NODE_W + COL_GAP), y: originY + i * (NODE_H + ROW_GAP) };
    });
    maxRank = Math.max(maxRank, rank);
    maxRows = Math.max(maxRows, list.length);
  }
  const w = (maxRank + 1) * (NODE_W + COL_GAP) - COL_GAP;
  const h = Math.max(1, maxRows) * (NODE_H + ROW_GAP) - ROW_GAP;
  return { pos, w, h };
}

/** Namespace 요약 노드 그리드(전부 kind==="Namespace"). */
function gridLayout(nodes: TopoNode[]): LayoutResult {
  const perRow = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const CW = NODE_W + 70; const CH = NODE_H + 40;
  const pos: Record<string, LayoutPos> = {};
  const sorted = [...nodes].sort((a, b) => a.name.localeCompare(b.name));
  sorted.forEach((n, i) => {
    pos[n.id] = { x: (i % perRow) * CW, y: Math.floor(i / perRow) * CH };
  });
  return { pos, groups: [] };
}

export function computeLayout(nodes: TopoNode[], edges: TopoEdge[]): LayoutResult {
  if (!nodes.length) return { pos: {}, groups: [] };
  // 요약(클러스터): 전부 Namespace → 그리드
  if (nodes.every((n) => n.kind === 'Namespace')) return gridLayout(nodes);

  const namespaces = [...new Set(nodes.map((n) => n.namespace))];
  // 단일 네임스페이스(기존 동작 보존): groups 없음
  if (namespaces.length <= 1) {
    const { pos } = rankColumnLayout(nodes, edges, 0, 0);
    return { pos, groups: [] };
  }
  // 상세(클러스터): 네임스페이스별 박스를 세로로 쌓는다.
  const PAD = 28; const LABEL_H = 26; const BOX_GAP = 40;
  const pos: Record<string, LayoutPos> = {};
  const groups: NamespaceBox[] = [];
  let cursorY = 0;
  for (const ns of [...namespaces].sort()) {
    const nsNodes = nodes.filter((n) => n.namespace === ns);
    const nsIds = new Set(nsNodes.map((n) => n.id));
    const nsEdges = edges.filter((e) => nsIds.has(e.source) && nsIds.has(e.target));
    const sub = rankColumnLayout(nsNodes, nsEdges, PAD, cursorY + LABEL_H);
    Object.assign(pos, sub.pos);
    const boxH = LABEL_H + sub.h + PAD;
    const boxW = sub.w + PAD * 2;
    groups.push({ namespace: ns, x: 0, y: cursorY, w: boxW, h: boxH });
    cursorY += boxH + BOX_GAP;
  }
  return { pos, groups };
}
