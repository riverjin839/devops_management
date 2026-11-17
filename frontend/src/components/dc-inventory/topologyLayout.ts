// DC 토폴로지 캔버스의 자동 배치와 노드 모양 — 저장된 위치(pinned)가 있으면 그 값을 쓰고, 없으면 계층별로 놓는다.
import type { DcDeviceRole, DcTopoFabricNode, DcTopoRack, DcTopology } from '@/types';

export const NODE_W = 150;
export const NODE_H = 44;
export const RACK_W = 190;
export const RACK_HEAD = 30;
export const ROW_H = 17;
export const RACK_GAP = 26;
/** 랙 박스에 그리는 장비 줄 수 상한 — 넘으면 "+n대" 한 줄로 접는다. */
export const RACK_MAX_ROWS = 24;
const TIER_Y = [40, 170, 300, 430];
const RACK_Y = 580;
const LEFT = 40;

export const TIER_LABEL = ['FA 코어', 'super-spine', 'spine', 'leaf (ToR)'];

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
export const ROLE_ABBR: Record<DcDeviceRole, string> = {
  'fa-core': 'FA', 'super-spine': 'SS', spine: 'SP', leaf: 'LF', server: 'SV', mgmt: 'MG', patch: 'PP',
};

export interface Point { x: number; y: number }
export interface Layout {
  fabric: Record<string, Point>;
  racks: Record<string, Point>;
  rackHeight: Record<string, number>;
  width: number;
  height: number;
}

export function rackBoxHeight(rack: DcTopoRack): number {
  const rows = Math.min(rack.devices.length, RACK_MAX_ROWS) + (rack.devices.length > RACK_MAX_ROWS ? 1 : 0);
  return RACK_HEAD + Math.max(rows, 1) * ROW_H + 8;
}

/** 저장된 위치 + 사용자가 지금 끌고 있는 위치(override)를 합쳐 최종 좌표를 만든다. */
export function computeLayout(topo: DcTopology, override: Record<string, Point>): Layout {
  const zoneOrder = new Map(topo.zones.map((z, i) => [z.id, i]));
  const racks = [...topo.racks].sort((a, b) =>
    (zoneOrder.get(a.zoneId ?? '') ?? 999) - (zoneOrder.get(b.zoneId ?? '') ?? 999) || a.name.localeCompare(b.name));
  const rackPos: Record<string, Point> = {};
  const rackHeight: Record<string, number> = {};
  racks.forEach((r, i) => {
    rackHeight[r.id] = rackBoxHeight(r);
    rackPos[r.id] = override[r.id] ?? (r.pinned && r.x !== null && r.y !== null
      ? { x: r.x, y: r.y } : { x: LEFT + i * (RACK_W + RACK_GAP), y: RACK_Y });
  });
  const autoWidth = Math.max(LEFT * 2 + racks.length * (RACK_W + RACK_GAP), 1100);

  const fabricPos: Record<string, Point> = {};
  const byTier: DcTopoFabricNode[][] = [[], [], [], []];
  for (const n of topo.fabric) byTier[Math.min(Math.max(n.tier, 0), 3)].push(n);
  byTier.forEach((nodes, tier) => {
    // leaf 는 자기 랙 위에 놓는다(같은 랙의 leaf 는 옆으로 나란히). 랙이 없는 leaf·상위 계층은 폭에 고르게 편다.
    const perRack = new Map<string, number>();
    const free = nodes.filter((n) => !(tier === 3 && n.rackId && rackPos[n.rackId]));
    nodes.forEach((n) => {
      let auto: Point;
      if (tier === 3 && n.rackId && rackPos[n.rackId]) {
        const k = perRack.get(n.rackId) ?? 0;
        perRack.set(n.rackId, k + 1);
        auto = { x: rackPos[n.rackId].x + (RACK_W - NODE_W) / 2 + k * 18, y: TIER_Y[3] - k * 52 };
      } else {
        const i = free.indexOf(n);
        const step = autoWidth / (free.length + 1);
        auto = { x: step * (i + 1) - NODE_W / 2, y: TIER_Y[tier] };
      }
      fabricPos[n.id] = override[n.id] ?? (n.pinned && n.x !== null && n.y !== null ? { x: n.x, y: n.y } : auto);
    });
  });

  let width = autoWidth;
  let height = RACK_Y + 120;
  for (const p of Object.values(fabricPos)) { width = Math.max(width, p.x + NODE_W + 60); height = Math.max(height, p.y + NODE_H + 60); }
  for (const [id, p] of Object.entries(rackPos)) {
    width = Math.max(width, p.x + RACK_W + 60);
    height = Math.max(height, p.y + rackHeight[id] + 60);
  }
  return { fabric: fabricPos, racks: rackPos, rackHeight, width, height };
}

/** 위 노드 아래 가운데 → 아래 노드 위 가운데를 잇는 곡선. */
export function linkPath(from: Point, to: Point): string {
  const midY = (from.y + to.y) / 2;
  return `M ${from.x} ${from.y} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.y}`;
}
