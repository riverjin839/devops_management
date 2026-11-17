// DC 토폴로지 편집기의 배치 계산 — 화면에 보이는 구조를 그대로 좌표로 만든다.
//   계층 띠(FA 코어 · super-spine · spine · leaf) 아래에 구간 상자가 가로로 놓이고, 랙은 구간 안에 한 줄로 들어간다.
//   leaf 는 자기 랙 바로 위(leaf 띠)에 칩으로, 상위 장비는 연결된 하위 장비들의 가운데 위에 놓인다.
// 사용자가 정하는 것은 상위 장비의 좌우 위치뿐이다(끌어서 옮기면 저장). 나머지는 데이터에서 파생한다.
import type { DcDeviceRole, DcTopoFabricNode, DcTopoRack, DcTopoZone, DcTopology } from '@/types';

export const NODE_W = 124;
export const NODE_H = 40;
export const LEAF_W = 40;
export const LEAF_H = 26;
export const RACK_W = 86;
export const RACK_H = 88;
export const RACK_OPEN_W = 204;
export const ROW_H = 22;
export const RACK_GAP = 10;
export const ZONE_PAD = 12;
export const ZONE_HEAD = 34;
export const ZONE_GAP = 18;
/** 펼친 랙에 그리는 장비 줄 수 상한 — 넘으면 "+n대" 로 접는다. */
export const RACK_MAX_ROWS = 14;

export const BANDS = [
  { tier: 0, label: 'FA 코어', y: 10, h: 60 },
  { tier: 1, label: 'super-spine', y: 80, h: 60 },
  { tier: 2, label: 'spine', y: 150, h: 60 },
  { tier: 3, label: 'leaf (ToR)', y: 220, h: 50 },
] as const;
const ZONES_Y = 290;
/** 구간에 속하지 않은 랙을 담는 가상 구간의 id. */
export const NO_ZONE = '__none__';

/** 역할 색 — `--chart-*` 토큰만 쓴다(테마마다 값이 다르다). SVG 라 fill/stroke 클래스로 준다. */
export const ROLE_FILL: Record<DcDeviceRole, string> = {
  'fa-core': 'fill-[hsl(var(--chart-7)/0.18)] stroke-[hsl(var(--chart-7))]',
  'super-spine': 'fill-[hsl(var(--chart-5)/0.16)] stroke-[hsl(var(--chart-5))]',
  spine: 'fill-[hsl(var(--chart-4)/0.16)] stroke-[hsl(var(--chart-4))]',
  leaf: 'fill-[hsl(var(--chart-2)/0.2)] stroke-[hsl(var(--chart-2))]',
  server: 'fill-[hsl(var(--chart-1)/0.14)] stroke-[hsl(var(--chart-1)/0.6)]',
  mgmt: 'fill-[hsl(var(--chart-3)/0.2)] stroke-[hsl(var(--chart-3))]',
  patch: 'fill-[hsl(var(--chart-8)/0.16)] stroke-[hsl(var(--chart-8))]',
};
export const BAND_FILL = [
  'fill-[hsl(var(--chart-7)/0.07)]', 'fill-[hsl(var(--chart-5)/0.06)]',
  'fill-[hsl(var(--chart-4)/0.06)]', 'fill-[hsl(var(--chart-2)/0.08)]',
];
export const ROLE_ABBR: Record<DcDeviceRole, string> = {
  'fa-core': 'FA', 'super-spine': 'SS', spine: 'SP', leaf: 'LF', server: 'SV', mgmt: 'MG', patch: 'PP',
};

export interface Rect { x: number; y: number; w: number; h: number }
export interface ZoneBox extends Rect { id: string; zone: DcTopoZone | null; racks: DcTopoRack[] }
export interface Layout {
  zones: ZoneBox[];
  racks: Record<string, Rect>;
  /** 패브릭 장비(leaf 포함)의 사각형. */
  nodes: Record<string, Rect>;
  width: number;
  height: number;
}

export function rackRows(rack: DcTopoRack): number {
  return Math.min(rack.devices.length, RACK_MAX_ROWS) + (rack.devices.length > RACK_MAX_ROWS ? 1 : 0);
}

/** leaf 칩에 쓰는 짧은 이름 — `leaf-r07-a` → `a`. */
export function leafTag(hostname: string, index: number): string {
  const tail = hostname.split(/[-_.]/).pop() ?? '';
  return tail.length > 0 && tail.length <= 3 ? tail : String(index + 1);
}

export function computeLayout(topo: DcTopology, expanded: Set<string>, override: Record<string, number>): Layout {
  const rackRect: Record<string, Rect> = {};
  const nodes: Record<string, Rect> = {};
  const zones: ZoneBox[] = [];

  const groups: { id: string; zone: DcTopoZone | null; racks: DcTopoRack[] }[] = topo.zones.map((z) => ({
    id: z.id, zone: z, racks: topo.racks.filter((r) => r.zoneId === z.id),
  }));
  const loose = topo.racks.filter((r) => !r.zoneId || !topo.zones.some((z) => z.id === r.zoneId));
  if (loose.length > 0) groups.push({ id: NO_ZONE, zone: null, racks: loose });

  let x = 8;
  let bottom = ZONES_Y + 120;
  for (const g of groups) {
    const racks = [...g.racks].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    let rx = x + ZONE_PAD;
    let tallest = RACK_H;
    for (const r of racks) {
      const open = expanded.has(r.id);
      const w = open ? RACK_OPEN_W : RACK_W;
      const h = open ? 34 + Math.max(rackRows(r), 1) * ROW_H + 34 : RACK_H;
      rackRect[r.id] = { x: rx, y: ZONES_Y + ZONE_HEAD + 6, w, h };
      tallest = Math.max(tallest, h);
      rx += w + RACK_GAP;
    }
    const w = Math.max(rx - x - RACK_GAP + ZONE_PAD, 220);
    const box: ZoneBox = { id: g.id, zone: g.zone, racks, x, y: ZONES_Y, w, h: ZONE_HEAD + 6 + tallest + ZONE_PAD };
    zones.push(box);
    bottom = Math.max(bottom, box.y + box.h);
    x += w + ZONE_GAP;
  }
  let width = Math.max(x - ZONE_GAP + 8, 900);

  // leaf — 자기 랙 바로 위. 랙이 없는 leaf 는 leaf 띠 오른쪽 끝에 일반 노드로.
  const leafBand = BANDS[3];
  const perRack = new Map<string, number>();
  const freeLeaves: DcTopoFabricNode[] = [];
  for (const n of topo.fabric.filter((f) => f.tier === 3)) {
    const rr = n.rackId ? rackRect[n.rackId] : undefined;
    if (!rr) { freeLeaves.push(n); continue; }
    const k = perRack.get(n.rackId!) ?? 0;
    perRack.set(n.rackId!, k + 1);
    nodes[n.id] = { x: rr.x + k * (LEAF_W + 4), y: leafBand.y + 12, w: LEAF_W, h: LEAF_H };
  }
  freeLeaves.forEach((n, i) => {
    nodes[n.id] = { x: width + i * (NODE_W + 10), y: leafBand.y + 6, w: NODE_W, h: NODE_H - 2 };
  });
  if (freeLeaves.length > 0) width += freeLeaves.length * (NODE_W + 10) + 8;

  // 상위 계층 — 아래에서 위로: 연결된 하위 장비들의 가운데. 저장된 위치(끌어 놓은 x)가 있으면 그 값.
  for (const tier of [2, 1, 0]) {
    const band = BANDS[tier];
    const list = topo.fabric.filter((f) => f.tier === tier);
    const wanted = list.map((n) => {
      const saved = override[n.id] ?? (n.pinned && n.x !== null ? n.x : null);
      if (saved !== null) return { n, x: saved, fixed: true };
      const kids = topo.edges.filter((e) => e.upperId === n.id).map((e) => nodes[e.lowerId]).filter(Boolean);
      if (kids.length === 0) return { n, x: Number.NaN, fixed: false };
      const cx = kids.reduce((s, k) => s + k.x + k.w / 2, 0) / kids.length;
      return { n, x: cx - NODE_W / 2, fixed: false };
    });
    const orphans = wanted.filter((w) => Number.isNaN(w.x));
    orphans.forEach((w, i) => { w.x = (width / (orphans.length + 1)) * (i + 1) - NODE_W / 2; });
    // 겹치지 않게 왼쪽부터 밀어낸다(직접 놓은 노드는 그대로 둔다).
    wanted.sort((a, b) => a.x - b.x);
    let edge = -Infinity;
    for (const w of wanted) {
      if (!w.fixed && w.x < edge + 10) w.x = edge + 10;
      w.x = Math.max(4, w.x);
      edge = Math.max(edge, w.x + NODE_W);
      nodes[w.n.id] = { x: Math.round(w.x), y: band.y + 10, w: NODE_W, h: NODE_H };
      width = Math.max(width, w.x + NODE_W + 8);
    }
  }
  return { zones, racks: rackRect, nodes, width, height: bottom + 40 };
}

export function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** 랙에서 비어 있는 U — `fromTop` 이면 위에서부터(ToR), 아니면 아래에서부터(서버). 꽉 찼으면 null. */
export function freeU(rack: DcTopoRack, fromTop: boolean): number | null {
  const used = new Set<number>();
  for (const d of rack.devices) {
    if (d.positionU === null) continue;
    for (let u = d.positionU; u < d.positionU + Math.max(d.uHeight, 1); u += 1) used.add(u);
  }
  if (fromTop) {
    for (let u = rack.uHeight; u >= 1; u -= 1) if (!used.has(u)) return u;
  } else {
    for (let u = 1; u <= rack.uHeight; u += 1) if (!used.has(u)) return u;
  }
  return null;
}

/** 기존 이름들에서 `prefix + 번호` 의 다음 번호를 골라 새 이름을 제안한다 (`spine-03`, `R21`). */
export function nextName(existing: string[], prefix: string, width = 2): string {
  let max = 0;
  for (const name of existing) {
    if (!name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    const m = name.slice(prefix.length).match(/^(\d+)/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  let n = max + 1;
  let candidate = `${prefix}${String(n).padStart(width, '0')}`;
  while (taken.has(candidate.toLowerCase())) { n += 1; candidate = `${prefix}${String(n).padStart(width, '0')}`; }
  return candidate;
}
