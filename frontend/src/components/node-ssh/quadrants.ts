/**
 * SSH 멀티 콘솔의 분할 칸 배치 — 한 쪽(page)에 4칸, 세션은 **Ⅰ → Ⅳ → Ⅱ → Ⅲ 사분면** 순서로 들어간다
 * (수학 사분면: Ⅰ 우상 · Ⅱ 좌상 · Ⅲ 좌하 · Ⅳ 우하). 칸(slot)은 0 부터 이어지는 번호이고, 세션을 닫아도
 * 다른 세션을 당겨 오지 않는다 — 새 세션은 가장 앞의 빈 칸에 들어간다(작업 중 창이 움직이지 않게).
 */
export const PANES_PER_PAGE = 4;
export const MAX_SESSIONS = 16;

/** 채움 순서 k(0..3) → 격자 칸(0 좌상 · 1 우상 · 2 좌하 · 3 우하). Ⅰ 우상, Ⅳ 우하, Ⅱ 좌상, Ⅲ 좌하. */
const FILL_TO_CELL = [1, 3, 0, 2] as const;
const CELL_QUADRANT = ['Ⅱ', 'Ⅰ', 'Ⅲ', 'Ⅳ'] as const;
/** 격자 칸 위치 클래스 — Tailwind 가 정적으로 찾도록 리터럴로 둔다. */
export const CELL_CLASS = [
  'col-start-1 row-start-1',
  'col-start-2 row-start-1',
  'col-start-1 row-start-2',
  'col-start-2 row-start-2',
] as const;

export interface SlotPosition {
  page: number;
  cell: number;
  quadrant: string;
}

export function slotPosition(slot: number): SlotPosition {
  const cell = FILL_TO_CELL[slot % PANES_PER_PAGE];
  return { page: Math.floor(slot / PANES_PER_PAGE), cell, quadrant: CELL_QUADRANT[cell] };
}

/** 쓰지 않는 가장 앞 칸, 없으면 -1. */
export function firstFreeSlot(used: ReadonlySet<number>): number {
  for (let s = 0; s < MAX_SESSIONS; s += 1) if (!used.has(s)) return s;
  return -1;
}

/** 쪽 수 — 마지막으로 쓰는 칸이 있는 쪽까지(최소 1). */
export function pageCount(used: ReadonlySet<number>): number {
  let max = -1;
  used.forEach((s) => { if (s > max) max = s; });
  return Math.max(1, Math.floor(max / PANES_PER_PAGE) + 1);
}

/** 한 쪽의 격자 칸(0..3) → 그 칸에 들어가는 slot 번호. */
export function slotForCell(page: number, cell: number): number {
  return page * PANES_PER_PAGE + FILL_TO_CELL.indexOf(cell as 0 | 1 | 2 | 3);
}

export function quadrantOfCell(cell: number): string {
  return CELL_QUADRANT[cell];
}
