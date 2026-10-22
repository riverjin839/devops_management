import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Map as MapIcon,
  ArrowLeftRight,
  Plus,
  Trash2,
  X,
  Check,
  Edit2,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Maximize2,
  GitBranch,
  LayoutGrid,
  Rows3,
  Building2,
  Spline,
  Minus,
  CornerDownRight,
  HelpCircle,
  ExternalLink,
  Link2,
  Download,
  FileImage,
  ListTree,
  Network,
} from 'lucide-react';
import {
  useMindMaps, useMindMap, useCreateMindMap, useUpdateMindMap, useDeleteMindMap,
  useCreateNode, useUpdateNode, useDeleteNode, useBulkUpdatePositions,
} from '@/hooks/useMindMap';
import type { MindMap, MindMapListItem, MindMapNode, MindMapUpdate } from '@/types';
import {
  ConfirmDialog, EmptyState, ErrorState, LoadingState, Skeleton, TenantScopeSelect, useModalA11y,
} from '@/components/common';
import { cssVarColor, useThemeColorKey } from '@/lib/chartTokens';

// ── Constants ───────────────────────────────────────────────────────────────
// 노드 색은 사용자 데이터(저장값 hex)라 raw hex 화이트리스트 — 라벨만 한국어(§12.12-11).
const NODE_COLORS = [
  { label: '기본', value: '' },
  { label: '청회색', value: '#64748b' },
  { label: '회색', value: '#6b7280' },
  { label: '진회색', value: '#71717a' },
  { label: '갈회색', value: '#78716c' },
  { label: '빨강', value: '#ef4444' },
  { label: '주황', value: '#f97316' },
  { label: '호박색', value: '#f59e0b' },
  { label: '노랑', value: '#eab308' },
  { label: '청록', value: '#14b8a6' },
  { label: '시안', value: '#06b6d4' },
  { label: '하늘색', value: '#0ea5e9' },
  { label: '파랑', value: '#3b82f6' },
  { label: '남색', value: '#6366f1' },
  { label: '보라', value: '#8b5cf6' },
  { label: '자주', value: '#a855f7' },
  { label: '분홍', value: '#ec4899' },
  { label: '장미색', value: '#f43f5e' },
  { label: '에메랄드', value: '#10b981' },
  { label: '연두', value: '#84cc16' },
  { label: '자홍', value: '#d946ef' },
];

// 가지·기본 노드 색은 테마 토큰(R-1). SVG/PNG 내보내기가 var() 를 풀지 못하므로 캔버스에서
// cssVarColor 리터럴로 바꿔 쓰고, 테마가 바뀌면 다시 읽는다. 사용자가 고른 node.color(hex)는 데이터라 그대로 둔다.
const BRANCH_TOKENS = ['--chart-1', '--chart-4', '--chart-6', '--chart-2', '--chart-3', '--chart-7', '--chart-5', '--chart-8'];

interface MindMapPalette {
  root: string;
  node: string;
  branch: string[];
  badgeText: string;
}

function mindMapPalette(): MindMapPalette {
  return {
    root: cssVarColor('--primary'),
    // 내보내기 배경(흰색)과 다크 테마 화면 양쪽에서 읽히는 중간 명도 — foreground 는 다크에서 흰 배경에 묻힌다.
    node: cssVarColor('--muted-foreground'),
    branch: BRANCH_TOKENS.map((t) => cssVarColor(t)),
    badgeText: cssVarColor('--background'),
  };
}

const NODE_W_ROOT = 130;
const NODE_H_ROOT = 44;
const NODE_W = 106;
const NODE_H = 34;
const H_GAP = 150;
const V_GAP = 24;
const LEVEL_GAP = 120;
const SIBLING_GAP = 26;

const BORDER_DASH: Record<NodeBorderStyle, string | undefined> = {
  solid: undefined,
  dashed: '6,3',
  dotted: '2,3',
};

const SIZE_MULTIPLIER: Record<NodeSize, number> = {
  sm: 0.8,
  md: 1,
  lg: 1.25,
};

type LayoutMode = 'mindmap' | 'tree' | 'orgchart';
type ConnStyle = 'bezier' | 'straight' | 'elbow';
type NodeShape = 'rect' | 'rounded' | 'pill' | 'circle' | 'diamond' | 'hexagon' | 'parallelogram' | 'cloud';
type NodeBorderStyle = 'solid' | 'dashed' | 'dotted';
type NodeSize = 'sm' | 'md' | 'lg';

type PosMap = globalThis.Map<string, { x: number; y: number }>;

interface NodeExtra {
  shape?: NodeShape;
  borderStyle?: NodeBorderStyle;
  size?: NodeSize;
}

const NODE_SHAPES: { value: NodeShape; label: string }[] = [
  { value: 'rect', label: '사각형' },
  { value: 'rounded', label: '둥근 사각형' },
  { value: 'pill', label: '알약' },
  { value: 'circle', label: '원' },
  { value: 'diamond', label: '마름모' },
  { value: 'hexagon', label: '육각형' },
  { value: 'parallelogram', label: '평행사변형' },
  { value: 'cloud', label: '구름' },
];

const BORDER_OPTIONS: { value: NodeBorderStyle; label: string }[] = [
  { value: 'solid', label: '실선' },
  { value: 'dashed', label: '파선' },
  { value: 'dotted', label: '점선' },
];

const SIZE_OPTIONS: { value: NodeSize; label: string }[] = [
  { value: 'sm', label: '작게' },
  { value: 'md', label: '보통' },
  { value: 'lg', label: '크게' },
];

// ── Tree helpers ─────────────────────────────────────────────────────────────
function buildNodeTree(nodes: MindMapNode[]) {
  const byId = new globalThis.Map(nodes.map((n): [string, MindMapNode] => [n.id, n]));
  const children = new globalThis.Map<string | null, MindMapNode[]>();
  for (const n of nodes) {
    const pid = n.parentId ?? null;
    if (!children.has(pid)) children.set(pid, []);
    children.get(pid)!.push(n);
  }
  return { byId, children };
}

function getNodeExtra(node: MindMapNode): NodeExtra {
  return (node.extra ?? {}) as NodeExtra;
}

function nodeDimensions(node: MindMapNode, isRoot: boolean) {
  const baseW = isRoot ? NODE_W_ROOT : NODE_W;
  const baseH = isRoot ? NODE_H_ROOT : NODE_H;
  const extra = getNodeExtra(node);
  const scale = SIZE_MULTIPLIER[extra.size ?? 'md'];
  return { w: baseW * scale, h: baseH * scale };
}

function nodeColor(node: MindMapNode, isRoot: boolean, palette: MindMapPalette) {
  if (node.color) return node.color;
  return isRoot ? palette.root : palette.node;
}

function rgbaFromHex(hex: string, alpha: number) {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 사용자 hex(node.color)와 토큰 리터럴(cssVarColor 의 `hsl(h, s, l)`)을 모두 받아 투명도를 입힌다. */
function withAlpha(color: string, alpha: number) {
  if (color.startsWith('#')) return rgbaFromHex(color, alpha);
  const m = /^hsl\(([^)]*)\)$/.exec(color);
  return m ? `hsla(${m[1]}, ${alpha})` : color;
}

function getNodeShapePath(shape: NodeShape, w: number, h: number): string {
  switch (shape) {
    case 'diamond':
      return `${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`;
    case 'hexagon': {
      const inset = Math.max(12, w * 0.16);
      return `${inset},0 ${w - inset},0 ${w},${h / 2} ${w - inset},${h} ${inset},${h} 0,${h / 2}`;
    }
    case 'parallelogram': {
      const skew = Math.max(10, w * 0.14);
      return `${skew},0 ${w},0 ${w - skew},${h} 0,${h}`;
    }
    default:
      return '';
  }
}

function renderNodeShape(shape: NodeShape, w: number, h: number, fill: string, stroke: string, strokeWidth: number, strokeDasharray?: string) {
  const common = { fill, stroke, strokeWidth, strokeDasharray };
  if (shape === 'rect') return <rect width={w} height={h} rx={0} {...common} />;
  if (shape === 'rounded') return <rect width={w} height={h} rx={8} {...common} />;
  if (shape === 'pill') return <rect width={w} height={h} rx={h / 2} {...common} />;
  if (shape === 'circle') return <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} {...common} />;
  if (shape === 'cloud') {
    const d = [
      `M ${w * 0.1} ${h * 0.6}`,
      `C ${w * 0.03} ${h * 0.58}, ${w * 0.03} ${h * 0.32}, ${w * 0.2} ${h * 0.33}`,
      `C ${w * 0.22} ${h * 0.12}, ${w * 0.42} ${h * 0.08}, ${w * 0.52} ${h * 0.22}`,
      `C ${w * 0.68} ${h * 0.07}, ${w * 0.9} ${h * 0.2}, ${w * 0.82} ${h * 0.4}`,
      `C ${w * 0.95} ${h * 0.44}, ${w * 0.96} ${h * 0.7}, ${w * 0.76} ${h * 0.7}`,
      `L ${w * 0.22} ${h * 0.7}`,
      `C ${w * 0.16} ${h * 0.72}, ${w * 0.08} ${h * 0.7}, ${w * 0.1} ${h * 0.6} Z`,
    ].join(' ');
    return <path d={d} {...common} />;
  }
  return <polygon points={getNodeShapePath(shape, w, h)} {...common} />;
}

function subtreeHeight(nodeId: string, childMap: globalThis.Map<string | null, MindMapNode[]>): number {
  const kids = childMap.get(nodeId) ?? [];
  if (kids.length === 0) return NODE_H + V_GAP;
  return kids.reduce((sum, k) => sum + subtreeHeight(k.id, childMap), 0);
}

function placeBranch(
  nodeId: string,
  parentX: number,
  centerY: number,
  dir: 1 | -1,
  childMap: globalThis.Map<string | null, MindMapNode[]>,
  positions: PosMap,
) {
  const kids = (childMap.get(nodeId) ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
  if (kids.length === 0) return;

  const totalH = kids.reduce((s, k) => s + subtreeHeight(k.id, childMap), 0) - V_GAP;
  let y = centerY - totalH / 2;
  const childX = parentX + dir * H_GAP;

  for (const kid of kids) {
    const kh = subtreeHeight(kid.id, childMap);
    const ky = y + (kh - V_GAP) / 2;
    positions.set(kid.id, { x: childX, y: ky });
    placeBranch(kid.id, childX, ky, dir, childMap, positions);
    y += kh;
  }
}

function mindmapLayout(nodes: MindMapNode[], cx = 600, cy = 400): PosMap {
  const positions: PosMap = new globalThis.Map();
  const { children } = buildNodeTree(nodes);
  const roots = (children.get(null) ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
  if (roots.length === 0) return positions;

  const placeRoot = (root: MindMapNode, rootCx: number, rootCy: number) => {
    positions.set(root.id, { x: rootCx, y: rootCy });
    const kids = (children.get(root.id) ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
    const half = Math.ceil(kids.length / 2);
    const rightKids = kids.slice(0, half);
    const leftKids = kids.slice(half);

    const placeSide = (sideKids: MindMapNode[], dir: 1 | -1) => {
      if (sideKids.length === 0) return;
      const totalH = sideKids.reduce((s, k) => s + subtreeHeight(k.id, children), 0) - V_GAP;
      let y = rootCy - totalH / 2;
      for (const kid of sideKids) {
        const kh = subtreeHeight(kid.id, children);
        const ky = y + (kh - V_GAP) / 2;
        positions.set(kid.id, { x: rootCx + dir * H_GAP, y: ky });
        placeBranch(kid.id, rootCx + dir * H_GAP, ky, dir, children, positions);
        y += kh;
      }
    };

    placeSide(rightKids, 1);
    placeSide(leftKids, -1);
  };

  if (roots.length === 1) {
    placeRoot(roots[0], cx, cy);
  } else {
    const rowH = NODE_H_ROOT + V_GAP;
    const totalH = roots.length * rowH - V_GAP;
    let ry = cy - totalH / 2;
    for (const root of roots) {
      placeRoot(root, cx, ry + NODE_H_ROOT / 2);
      ry += rowH;
    }
  }
  return positions;
}

function computeDownHeight(nodeId: string, childMap: globalThis.Map<string | null, MindMapNode[]>): number {
  const kids = childMap.get(nodeId) ?? [];
  if (kids.length === 0) return NODE_W;
  const sum = kids.reduce((acc, kid) => acc + computeDownHeight(kid.id, childMap), 0) + SIBLING_GAP * (kids.length - 1);
  return Math.max(NODE_W, sum);
}

function placeBranchDown(
  nodeId: string,
  centerX: number,
  y: number,
  childMap: globalThis.Map<string | null, MindMapNode[]>,
  positions: PosMap,
) {
  positions.set(nodeId, { x: centerX, y });
  const kids = (childMap.get(nodeId) ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
  if (kids.length === 0) return;

  const widths = kids.map((k) => computeDownHeight(k.id, childMap));
  const totalW = widths.reduce((a, b) => a + b, 0) + SIBLING_GAP * (kids.length - 1);
  let cursor = centerX - totalW / 2;

  kids.forEach((kid, idx) => {
    const subtreeW = widths[idx];
    const childX = cursor + subtreeW / 2;
    placeBranchDown(kid.id, childX, y + LEVEL_GAP, childMap, positions);
    cursor += subtreeW + SIBLING_GAP;
  });
}

function treeLayout(nodes: MindMapNode[], cx = 600, cy = 120): PosMap {
  const positions: PosMap = new globalThis.Map();
  const { children } = buildNodeTree(nodes);
  const roots = (children.get(null) ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
  if (roots.length === 0) return positions;

  const widths = roots.map((r) => computeDownHeight(r.id, children));
  const totalW = widths.reduce((a, b) => a + b, 0) + SIBLING_GAP * (roots.length - 1);
  let cursor = cx - totalW / 2;

  roots.forEach((root, idx) => {
    const subtreeW = widths[idx];
    const x = cursor + subtreeW / 2;
    placeBranchDown(root.id, x, cy, children, positions);
    cursor += subtreeW + SIBLING_GAP;
  });

  return positions;
}

function orgChartLayout(nodes: MindMapNode[], cx = 600, cy = 120): PosMap {
  return treeLayout(nodes, cx, cy);
}

/** 노드별 가지 색 — 부모를 따라 올라가며 첫 루트의 몇 번째 가지인지 찾는다.
 *  API 로 순환 `parent_id` 가 들어와도 멈추지 않도록 방문 집합으로 루프를 끊는다(15차 A-20). */
function computeBranchColors(nodes: MindMapNode[], palette: MindMapPalette): globalThis.Map<string, string> {
  const { byId, children } = buildNodeTree(nodes);
  const out = new globalThis.Map<string, string>();
  const roots = (children.get(null) ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
  const root = roots[0];
  if (!root) {
    for (const n of nodes) out.set(n.id, palette.root);
    return out;
  }

  const rootKids = (children.get(root.id) ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
  const branchIndex = new globalThis.Map(rootKids.map((kid, idx) => [kid.id, idx % palette.branch.length]));

  for (const n of nodes) {
    let color = palette.root;
    const visited = new Set<string>();
    let cur: MindMapNode | undefined = n;
    while (cur && cur.parentId && !visited.has(cur.id)) {
      visited.add(cur.id);
      if (cur.parentId === root.id) { color = palette.branch[branchIndex.get(cur.id) ?? 0]; break; }
      cur = byId.get(cur.parentId);
    }
    out.set(n.id, color);
  }
  return out;
}

/** 하위 노드 수(자기 자신 제외) — 순환이 있어도 방문 집합으로 끝난다. */
function countDescendants(nodeId: string, childMap: globalThis.Map<string | null, MindMapNode[]>): number {
  const visited = new Set<string>([nodeId]);
  const stack = [...(childMap.get(nodeId) ?? [])];
  let count = 0;
  while (stack.length) {
    const n = stack.pop()!;
    if (visited.has(n.id)) continue;
    visited.add(n.id);
    count += 1;
    stack.push(...(childMap.get(n.id) ?? []));
  }
  return count;
}

/** 개요 트리용 평탄화 — 루트부터 깊이 우선. 부모가 없거나 순환에 갇혀 루트에서 닿지 않는 노드는
 *  끝에 최상위로 붙여 목록 보기에서도 빠지지 않게 한다(방문 집합으로 순환 차단). */
interface OutlineRow {
  node: MindMapNode;
  level: number;
  parentId: string | null;
  hasKids: boolean;
  posInSet: number;
  setSize: number;
}

function flattenOutline(
  nodes: MindMapNode[],
  childMap: globalThis.Map<string | null, MindMapNode[]>,
  collapsed: Set<string>,
): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const visited = new Set<string>();
  const sortKids = (list: MindMapNode[]) => [...list].sort((a, b) => a.sortOrder - b.sortOrder);

  // 접힌 가지의 자손도 "닿은 노드"로 표시해 아래 고아 판정에 섞이지 않게 한다.
  const markVisited = (n: MindMapNode) => {
    if (visited.has(n.id)) return;
    visited.add(n.id);
    for (const k of childMap.get(n.id) ?? []) markVisited(k);
  };

  const walk = (list: MindMapNode[], level: number, parentId: string | null) => {
    const kids = sortKids(list).filter((k) => !visited.has(k.id));
    kids.forEach((n, idx) => {
      if (visited.has(n.id)) return;
      visited.add(n.id);
      const sub = (childMap.get(n.id) ?? []).filter((k) => !visited.has(k.id));
      rows.push({ node: n, level, parentId, hasKids: sub.length > 0, posInSet: idx + 1, setSize: kids.length });
      if (!collapsed.has(n.id)) walk(sub, level + 1, n.id);
      else for (const d of sub) markVisited(d);
    });
  };

  walk(childMap.get(null) ?? [], 1, null);
  const stray = nodes.filter((n) => !visited.has(n.id));
  if (stray.length) walk(stray.filter((n) => !visited.has(n.id)), 1, null);
  return rows;
}

// ── Node Editor ──────────────────────────────────────────────────────────────
interface NodeEditorValue {
  label: string;
  note: string;
  color: string;
  shape: NodeShape;
  borderStyle: NodeBorderStyle;
  size: NodeSize;
}

interface NodeEditorProps {
  initial: NodeEditorValue | null;
  onSave: (value: NodeEditorValue) => void;
  onClose: () => void;
  title: string;
  /** true = 저장 요청 중 — 저장 버튼을 잠그고 Escape·배경 클릭으로 닫히지 않는다. */
  busy?: boolean;
}

const chipClass = (active: boolean) =>
  `rounded-xl border ${active ? 'border-primary bg-primary/10' : 'border-border hover:bg-secondary'}`;

function NodeEditor({ initial, onSave, onClose, title, busy = false }: NodeEditorProps) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [color, setColor] = useState(initial?.color ?? '');
  const [shape, setShape] = useState<NodeShape>(initial?.shape ?? 'rounded');
  const [borderStyle, setBorderStyle] = useState<NodeBorderStyle>(initial?.borderStyle ?? 'solid');
  const [size, setSize] = useState<NodeSize>(initial?.size ?? 'md');

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;
  const dismiss = () => { if (!busy) onClose(); };
  const dialogRef = useModalA11y(true, dismiss);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || busy) return;
    onSave({
      label: label.trim(),
      note: note.trim(),
      color,
      shape,
      borderStyle,
      size,
    });
  };

  const inputClass = 'w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={dismiss} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={f('title')} className="relative bg-card border border-border rounded-md p-5 w-full max-w-lg shadow-card max-h-[88vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 id={f('title')} className="text-sm font-semibold">{title}</h3>
          <button type="button" onClick={onClose} className="p-1.5 hover:bg-secondary rounded-xl text-muted-foreground hover:text-foreground transition-colors" title="닫기" aria-label="닫기">
            <X className="w-4 h-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor={f('label')} className="block text-sm font-medium text-muted-foreground mb-1">노드 이름 *</label>
            <input id={f('label')} type="text" value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="노드 이름을 입력하세요" className={inputClass} autoFocus required />
          </div>
          <div>
            <label htmlFor={f('note')} className="block text-sm font-medium text-muted-foreground mb-1">메모 (선택 — 비우면 삭제)</label>
            <textarea id={f('note')} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="부연 설명이나 메모" rows={3} className={`${inputClass} resize-none`} />
          </div>
          <div role="group" aria-labelledby={f('color')}>
            <p id={f('color')} className="block text-sm font-medium text-muted-foreground mb-1">색상</p>
            <div className="grid grid-cols-5 gap-2">
              {NODE_COLORS.map((c) => (
                <button
                  key={`${c.label}-${c.value}`}
                  type="button"
                  onClick={() => setColor(c.value)}
                  aria-label={c.label}
                  aria-pressed={color === c.value}
                  className={`w-5 h-5 rounded-full border-2 transition-colors ${c.value ? '' : 'bg-muted-foreground'} ${
                    color === c.value ? 'border-foreground' : 'border-transparent opacity-75 hover:opacity-100'
                  }`}
                  style={c.value ? { backgroundColor: c.value } : undefined}
                  title={c.label}
                />
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <label htmlFor={f('custom')} className="text-sm text-muted-foreground">직접 고르기</label>
              <input id={f('custom')} type="color" value={color || '#6366f1'} onChange={(e) => setColor(e.target.value)} className="w-10 h-6 bg-transparent rounded-xl" />
              <button type="button" onClick={() => setColor('')} aria-pressed={color === ''} className="text-sm px-2 py-1 border border-border rounded-xl hover:bg-secondary">기본</button>
            </div>
          </div>

          <div role="group" aria-labelledby={f('shape')}>
            <p id={f('shape')} className="block text-sm font-medium text-muted-foreground mb-1">모양</p>
            <div className="grid grid-cols-4 gap-2">
              {NODE_SHAPES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setShape(s.value)}
                  aria-pressed={shape === s.value}
                  className={`p-2 flex flex-col items-center gap-1 text-xs ${chipClass(shape === s.value)}`}
                >
                  <svg width="42" height="24" viewBox="0 0 42 24" aria-hidden="true">
                    <g transform="translate(1,1)">
                      {renderNodeShape(s.value, 40, 22, 'hsl(var(--primary) / 0.15)', 'hsl(var(--primary))', 1.2)}
                    </g>
                  </svg>
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div role="group" aria-labelledby={f('border')}>
              <p id={f('border')} className="block text-sm font-medium text-muted-foreground mb-1">테두리</p>
              <div className="flex gap-1">
                {BORDER_OPTIONS.map((b) => (
                  <button key={b.value} type="button" onClick={() => setBorderStyle(b.value)} aria-pressed={borderStyle === b.value}
                    className={`flex-1 px-2 py-1.5 text-sm ${chipClass(borderStyle === b.value)}`}>
                    {b.label}
                  </button>
                ))}
              </div>
            </div>
            <div role="group" aria-labelledby={f('size')}>
              <p id={f('size')} className="block text-sm font-medium text-muted-foreground mb-1">크기</p>
              <div className="flex gap-1">
                {SIZE_OPTIONS.map((o) => (
                  <button key={o.value} type="button" onClick={() => setSize(o.value)} aria-pressed={size === o.value}
                    className={`flex-1 px-2 py-1.5 text-sm ${chipClass(size === o.value)}`}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="px-3.5 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors">
              취소
            </button>
            <button type="submit" disabled={busy || !label.trim()} aria-busy={busy || undefined}
              className="px-3.5 py-2 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl flex items-center gap-1.5 transition-colors disabled:opacity-60">
              <Check className="w-3.5 h-3.5" /> {busy ? '저장 중…' : '저장'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── 한 줄 입력 다이얼로그 (native prompt 대체, 15차 A-11) ─────────────────────
interface TextInputDialogProps {
  open: boolean;
  title: string;
  label: string;
  initialValue: string;
  placeholder?: string;
  type?: 'text' | 'url';
  /** true = 빈 값 저장 불가(제목 등). false 면 빈 값 = 해제(`null`). */
  required?: boolean;
  hint?: string;
  busy?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

function TextInputDialog({
  open, title, label, initialValue, placeholder, type = 'text', required = false, hint, busy = false, onSubmit, onCancel,
}: TextInputDialogProps) {
  const [value, setValue] = useState(initialValue);
  const fid = useId();
  const dismiss = () => { if (!busy) onCancel(); };
  const dialogRef = useModalA11y(open, dismiss);
  if (!open) return null;

  const empty = !value.trim();
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || (required && empty)) return;
    onSubmit(value.trim());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={dismiss} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={`${fid}-title`}
        className="relative bg-card border border-border rounded-md p-5 w-full max-w-md mx-4 shadow-card">
        <h2 id={`${fid}-title`} className="text-sm font-semibold mb-3">{title}</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label htmlFor={`${fid}-input`} className="block text-sm font-medium text-muted-foreground mb-1">{label}</label>
            <input
              id={`${fid}-input`}
              type={type}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              required={required}
              aria-invalid={required && empty ? true : undefined}
              aria-describedby={hint || (required && empty) ? `${fid}-hint` : undefined}
              data-autofocus
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            {(hint || (required && empty)) && (
              <p id={`${fid}-hint`} className="mt-1 text-xs text-muted-foreground">
                {required && empty ? '빈 값은 저장할 수 없습니다.' : hint}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onCancel}
              className="px-3.5 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors">
              취소
            </button>
            <button type="submit" disabled={busy || (required && empty)} aria-busy={busy || undefined}
              className="px-3.5 py-2 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors disabled:opacity-60">
              {busy ? '저장 중…' : '저장'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Canvas ───────────────────────────────────────────────────────────────────
function triggerDownload(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const ARROW_DIR: Record<string, 'left' | 'right' | 'up' | 'down'> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

const SHORTCUTS: [string, string][] = [
  ['방향키', '노드 선택 · 인접 노드 이동'],
  ['Insert / Ctrl + Enter', '자식 노드 추가'],
  ['Enter', '형제 노드 추가'],
  ['Delete / Backspace', '노드 삭제(확인 후)'],
  ['F2', '노드 수정'],
  ['Esc', '선택 해제'],
  ['+ / -', '확대 / 축소'],
  ['0', '100%'],
  ['Ctrl + 0', '화면 맞춤'],
  ['?', '도움말 열기 / 닫기'],
];

interface NodeActionProps {
  mindmap: MindMap;
  onNodeSelect: (nodeId: string | null) => void;
  selectedNodeId: string | null;
  onAddChild: (parentId: string) => void;
  onAddSibling: (nodeId: string) => void;
  onEditNode: (node: MindMapNode) => void;
  onDeleteNode: (nodeId: string) => void;
  /** 노드 편집기·확인 창 등 모달이 열려 있으면 단축키를 받지 않는다(15차 A-6). */
  keyboardDisabled: boolean;
}

function MindMapCanvas({
  mindmap,
  onNodeSelect,
  selectedNodeId,
  onAddChild,
  onAddSibling,
  onEditNode,
  onDeleteNode,
  keyboardDisabled,
}: NodeActionProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('mindmap');
  const [connStyle, setConnStyle] = useState<ConnStyle>('bezier');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [hoverShortcut, setHoverShortcut] = useState(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panOrigin = useRef({ x: 0, y: 0 });
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const [nodePositions, setNodePositions] = useState<PosMap>(new globalThis.Map());
  const { mutate: savePositions } = useBulkUpdatePositions(mindmap.id);
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 아직 서버에 보내지 않은 이동분 — 움직인 노드만 보낸다(15차 A-13, 정책 ⑦).
  const pendingMoves = useRef<PosMap>(new globalThis.Map());
  // 저장 실패 시 화면 좌표를 서버 값으로 되돌리는 트리거.
  const [resetTick, setResetTick] = useState(0);

  const nodes = mindmap.nodes;
  const { byId, children: childMap } = useMemo(() => buildNodeTree(nodes), [nodes]);
  const themeKey = useThemeColorKey();
  const palette = useMemo(() => { void themeKey; return mindMapPalette(); }, [themeKey]);
  const branchColors = useMemo(() => computeBranchColors(nodes, palette), [nodes, palette]);

  const getLayout = useCallback((targetNodes: MindMapNode[]) => {
    if (layoutMode === 'tree') return treeLayout(targetNodes, 600, 120);
    if (layoutMode === 'orgchart') return orgChartLayout(targetNodes, 600, 120);
    return mindmapLayout(targetNodes);
  }, [layoutMode]);

  useEffect(() => {
    void resetTick;
    if (nodes.length === 0) { setNodePositions(new globalThis.Map()); return; }
    const layout = getLayout(nodes);
    const map = new globalThis.Map<string, { x: number; y: number }>();
    for (const n of nodes) {
      // 30초 refetch 가 와도 아직 저장 대기 중인 이동은 덮지 않는다.
      const pending = pendingMoves.current.get(n.id);
      if (pending) map.set(n.id, pending);
      else if (n.x != null && n.y != null) map.set(n.id, { x: n.x, y: n.y });
      else map.set(n.id, layout.get(n.id) ?? { x: 600, y: 400 });
    }
    setNodePositions(map);
  }, [nodes, getLayout, resetTick]);

  /** 대기 중인 이동분을 바로 보낸다. 디바운스 타이머·언마운트(맵 전환은 key 로 언마운트)에서 호출. */
  const flushPositions = useCallback(() => {
    if (saveTimeout.current) {
      clearTimeout(saveTimeout.current);
      saveTimeout.current = null;
    }
    if (pendingMoves.current.size === 0) return;
    const updates = Array.from(pendingMoves.current.entries()).map(([id, pos]) => ({ id, ...pos }));
    pendingMoves.current = new globalThis.Map();
    savePositions(updates, { onError: () => setResetTick((t) => t + 1) });
  }, [savePositions]);

  // 화면 이탈·맵 전환 시 미반영 이동분 flush — 타이머만 지우면 마지막 800ms 안의 이동이 사라진다.
  useEffect(() => () => flushPositions(), [flushPositions]);

  // 휠 줌 — React 의 onWheel 은 passive 라 preventDefault 가 무시돼 페이지가 함께 스크롤된다(15차 A-22).
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => Math.min(3, Math.max(0.2, z - e.deltaY * 0.001)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const handleAutoLayout = () => {
    if (nodes.length === 0) return;
    const newPositions = getLayout(nodes);
    setNodePositions(newPositions);
    pendingMoves.current = new globalThis.Map(newPositions);
    flushPositions();
  };

  const fitToScreen = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const getPos = (nodeId: string) => nodePositions.get(nodeId) ?? { x: 400, y: 300 };
  const roots = childMap.get(null) ?? [];
  const rootIds = new Set(roots.map((n) => n.id));

  const handleSvgMouseDown = (e: React.MouseEvent) => {
    if (e.target === svgRef.current || (e.target as SVGElement).tagName === 'rect') {
      setIsPanning(true);
      panStart.current = { x: e.clientX, y: e.clientY };
      panOrigin.current = { ...pan };
    }
  };

  const handleSvgMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return;
    setPan({
      x: panOrigin.current.x + (e.clientX - panStart.current.x),
      y: panOrigin.current.y + (e.clientY - panStart.current.y),
    });
  }, [isPanning]);

  const handleSvgMouseUp = () => {
    setIsPanning(false);
    if (!dragNodeId) return;
    setDragNodeId(null);
    if (pendingMoves.current.size === 0) return;
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(flushPositions, 800);
  };

  const handleNodeMouseDown = (e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();
    surfaceRef.current?.focus({ preventScroll: true });
    setDragNodeId(nodeId);
    onNodeSelect(nodeId);
  };

  const handleNodeMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragNodeId || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left - pan.x) / zoom;
    const y = (e.clientY - rect.top - pan.y) / zoom;
    pendingMoves.current.set(dragNodeId, { x, y });
    setNodePositions((prev) => new globalThis.Map(prev).set(dragNodeId, { x, y }));
  }, [dragNodeId, pan, zoom]);

  const navigateToNearest = useCallback((direction: 'left' | 'right' | 'up' | 'down') => {
    if (!selectedNodeId) return;
    const from = nodePositions.get(selectedNodeId) ?? { x: 400, y: 300 };
    let bestId: string | null = null;
    let bestDist = Number.POSITIVE_INFINITY;

    for (const node of nodes) {
      if (node.id === selectedNodeId) continue;
      const p = nodePositions.get(node.id) ?? { x: 400, y: 300 };
      const dx = p.x - from.x;
      const dy = p.y - from.y;
      const valid =
        (direction === 'left' && dx < 0) ||
        (direction === 'right' && dx > 0) ||
        (direction === 'up' && dy < 0) ||
        (direction === 'down' && dy > 0);
      if (!valid) continue;
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = node.id;
      }
    }

    if (bestId) onNodeSelect(bestId);
  }, [selectedNodeId, nodes, onNodeSelect, nodePositions]);

  // 단축키는 캔버스(포커스 가능한 surface)에서만 받는다 — 모달·사이드바·툴바 버튼의 Tab·Enter·Backspace 를
  // 가로채지 않는다(15차 A-6). Tab 은 가로채지 않고, 자식 추가는 Insert / Ctrl+Enter.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (keyboardDisabled || e.target !== e.currentTarget || e.nativeEvent.isComposing || e.altKey) return;
    const key = e.key;
    const mod = e.ctrlKey || e.metaKey;

    if (key === '?') {
      e.preventDefault();
      setShowShortcuts((s) => !s);
      return;
    }
    if (!mod && (key === '+' || key === '=')) {
      e.preventDefault();
      setZoom((z) => Math.min(3, z + 0.1));
      return;
    }
    if (!mod && key === '-') {
      e.preventDefault();
      setZoom((z) => Math.max(0.2, z - 0.1));
      return;
    }
    if (key === '0') {
      e.preventDefault();
      if (mod) fitToScreen();
      else setZoom(1);
      return;
    }

    const dir = ARROW_DIR[key];
    if (!selectedNodeId) {
      // 선택이 없으면 방향키로 첫 루트(없으면 첫 노드)를 고른다 — 마우스 없이도 시작할 수 있게.
      if (dir) {
        e.preventDefault();
        const first = [...roots].sort((a, b) => a.sortOrder - b.sortOrder)[0] ?? nodes[0];
        if (first) onNodeSelect(first.id);
      }
      return;
    }

    if (key === 'Insert' || (key === 'Enter' && mod)) {
      e.preventDefault();
      onAddChild(selectedNodeId);
    } else if (key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onAddSibling(selectedNodeId);
    } else if (key === 'Delete' || key === 'Backspace') {
      e.preventDefault();
      onDeleteNode(selectedNodeId);
    } else if (key === 'F2') {
      e.preventDefault();
      const node = byId.get(selectedNodeId);
      if (node) onEditNode(node);
    } else if (key === 'Escape') {
      e.preventDefault();
      onNodeSelect(null);
    } else if (dir) {
      e.preventDefault();
      navigateToNearest(dir);
    }
  };

  const getEdgePath = (x1: number, y1: number, x2: number, y2: number) => {
    if (connStyle === 'straight') return `M ${x1} ${y1} L ${x2} ${y2}`;
    if (connStyle === 'elbow') {
      const mid = (x1 + x2) / 2;
      return `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`;
    }
    const mid = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
  };

  const exportMindMap = useCallback(async (format: 'svg' | 'png') => {
    const svg = svgRef.current;
    if (!svg) return;
    // 선택 핸들(추가·형제·수정·삭제)이 캡처되지 않도록 선택 해제 후 다음 프레임에 캡처.
    onNodeSelect(null);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    const innerG = svg.querySelector('g') as SVGGraphicsElement | null;
    if (!innerG) return;
    let bbox: DOMRect;
    try { bbox = innerG.getBBox(); } catch { return; }
    const pad = 40;
    const vbX = bbox.x - pad, vbY = bbox.y - pad;
    const vbW = Math.max(1, bbox.width + pad * 2), vbH = Math.max(1, bbox.height + pad * 2);

    const clone = svg.cloneNode(true) as SVGSVGElement;
    const cloneBg = clone.querySelector('rect'); // 첫 rect = 100%/100% 투명 배경
    if (cloneBg) cloneBg.remove();
    const cg = clone.querySelector('g');
    if (cg) cg.removeAttribute('transform'); // pan/zoom 제거 → 전체 1:1
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
    clone.setAttribute('width', String(vbW));
    clone.setAttribute('height', String(vbH));
    clone.removeAttribute('class');
    clone.removeAttribute('style');
    // 흰 배경
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bg.setAttribute('x', String(vbX)); bg.setAttribute('y', String(vbY));
    bg.setAttribute('width', String(vbW)); bg.setAttribute('height', String(vbH));
    bg.setAttribute('fill', '#ffffff');
    clone.insertBefore(bg, clone.firstChild);

    const svgStr = new XMLSerializer().serializeToString(clone);
    const svgBlob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svgStr}`], { type: 'image/svg+xml;charset=utf-8' });
    const ts = new Date().toISOString().slice(0, 10);

    if (format === 'svg') {
      const url = URL.createObjectURL(svgBlob);
      triggerDownload(url, `mindmap-${ts}.svg`);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }

    // PNG — SVG 를 이미지로 그려 canvas 래스터화 (2x).
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vbW * scale);
      canvas.height = Math.ceil(vbH * scale);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (blob) {
            const purl = URL.createObjectURL(blob);
            triggerDownload(purl, `mindmap-${ts}.png`);
            setTimeout(() => URL.revokeObjectURL(purl), 1000);
          }
        }, 'image/png');
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  }, [onNodeSelect]);

  const selectedNode = selectedNodeId ? byId.get(selectedNodeId) : undefined;

  return (
    <div className="relative w-full h-full">
      <div
        ref={surfaceRef}
        // 캔버스는 방향키·Insert·F2 등을 직접 처리하는 복합 위젯이라 포커스를 받아야 한다(15차 A-6).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        role="application"
        aria-roledescription="마인드맵 캔버스"
        aria-label={`${mindmap.title} 마인드맵 캔버스`}
        aria-describedby={hintId}
        onKeyDown={handleKeyDown}
        className="absolute inset-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
      >
        <p id={hintId} className="sr-only">
          방향키로 노드를 고르고 Insert 또는 Ctrl+Enter 로 자식, Enter 로 형제 노드를 추가합니다. F2 수정, Delete 삭제, 물음표 키로 단축키 도움말을 엽니다.
          키보드로 전체 구조를 보려면 상단의 목록 보기를 쓰세요.
        </p>
        <p className="sr-only" aria-live="polite">
          {selectedNode ? `선택: ${selectedNode.label}` : ''}
        </p>
        <svg
          ref={svgRef}
          className={`w-full h-full ${isPanning || dragNodeId ? 'cursor-grabbing' : 'cursor-grab'}`}
          onMouseDown={handleSvgMouseDown}
          onMouseMove={(e) => { handleSvgMouseMove(e); handleNodeMouseMove(e); }}
          onMouseUp={handleSvgMouseUp}
          onMouseLeave={handleSvgMouseUp}
          onClick={(e) => {
            const tag = (e.target as SVGElement).tagName;
            if (tag === 'svg' || tag === 'rect') onNodeSelect(null);
          }}
        >
          <rect x="0" y="0" width="100%" height="100%" fill="transparent" />
          <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
            {nodes.map((node) => {
              if (!node.parentId) return null;
              const parent = byId.get(node.parentId);
              if (!parent) return null;
              const from = getPos(parent.id);
              const to = getPos(node.id);
              const parentRoot = rootIds.has(parent.id);
              const childRoot = rootIds.has(node.id);
              const pDims = nodeDimensions(parent, parentRoot);
              const cDims = nodeDimensions(node, childRoot);

              let x1 = from.x;
              let y1 = from.y;
              let x2 = to.x;
              let y2 = to.y;

              if (layoutMode === 'mindmap') {
                const goRight = to.x >= from.x;
                x1 = goRight ? from.x + pDims.w / 2 : from.x - pDims.w / 2;
                x2 = goRight ? to.x - cDims.w / 2 : to.x + cDims.w / 2;
              } else {
                x1 = from.x;
                y1 = from.y + pDims.h / 2;
                x2 = to.x;
                y2 = to.y - cDims.h / 2;
              }

              const branchColor = branchColors.get(node.id) ?? palette.root;
              return (
                <path
                  key={`edge-${node.id}`}
                  d={getEdgePath(x1, y1, x2, y2)}
                  fill="none"
                  stroke={withAlpha(branchColor, 0.5)}
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              );
            })}

            {nodes.map((node) => {
              const pos = getPos(node.id);
              const isRoot = rootIds.has(node.id);
              const isSelected = selectedNodeId === node.id;
              const color = nodeColor(node, isRoot, palette);
              const kids = childMap.get(node.id) ?? [];
              const extra = getNodeExtra(node);
              const { w: nodeW, h: nodeH } = nodeDimensions(node, isRoot);
              const shape = extra.shape ?? 'rounded';
              const strokeDasharray = BORDER_DASH[extra.borderStyle ?? 'solid'];

              return (
                <g key={node.id}
                  transform={`translate(${pos.x - nodeW / 2},${pos.y - nodeH / 2})`}
                  onMouseDown={(e) => handleNodeMouseDown(e, node.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="cursor-pointer"
                >
                  {renderNodeShape(
                    shape,
                    nodeW,
                    nodeH,
                    withAlpha(color, 0.15),
                    color,
                    isSelected ? 2.5 : 1.5,
                    strokeDasharray,
                  )}

                  <text
                    x={nodeW / 2}
                    y={nodeH / 2}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={isRoot ? 12 : 11}
                    fontWeight={isRoot ? '600' : '400'}
                    fill={color}
                    className="pointer-events-none select-none"
                  >
                    {node.label.length > 18 ? `${node.label.slice(0, 16)}…` : node.label}
                  </text>

                  {kids.length > 0 && (
                    <g transform={`translate(${nodeW - 14}, -6)`}>
                      <circle r="8" fill={color} fillOpacity={0.8} />
                      <text x="0" y="0" textAnchor="middle" dominantBaseline="middle"
                        fontSize="8" fill={palette.badgeText} fontWeight="600" className="pointer-events-none select-none">
                        {kids.length}
                      </text>
                    </g>
                  )}

                  {isSelected && (
                    <g>
                      <g transform={`translate(${nodeW + 4}, ${nodeH / 2 - 20})`} onClick={(e) => { e.stopPropagation(); onAddChild(node.id); }} className="cursor-pointer">
                        <title>자식 노드 추가 (Insert)</title>
                        <circle r="9" className="fill-primary" fillOpacity={0.9} />
                        <Plus x={-5} y={-5} width={10} height={10} strokeWidth={2.5} className="text-primary-foreground pointer-events-none" aria-hidden />
                      </g>
                      <g transform={`translate(${nodeW + 4}, ${nodeH / 2})`} onClick={(e) => { e.stopPropagation(); onAddSibling(node.id); }} className="cursor-pointer">
                        <title>형제 노드 추가 (Enter)</title>
                        <circle r="9" className="fill-primary" fillOpacity={0.9} />
                        <ArrowLeftRight x={-5} y={-5} width={10} height={10} strokeWidth={2.5} className="text-primary-foreground pointer-events-none" aria-hidden />
                      </g>
                      <g transform={`translate(${nodeW + 4}, ${nodeH / 2 + 20})`} onClick={(e) => { e.stopPropagation(); onEditNode(node); }} className="cursor-pointer">
                        <title>노드 수정 (F2)</title>
                        <circle r="9" className="fill-muted-foreground" fillOpacity={0.9} />
                        <Edit2 x={-5} y={-5} width={10} height={10} strokeWidth={2.5} className="text-background pointer-events-none" aria-hidden />
                      </g>
                      <g transform={`translate(${nodeW / 2}, ${nodeH + 12})`} onClick={(e) => { e.stopPropagation(); onDeleteNode(node.id); }} className="cursor-pointer">
                        <title>노드 삭제 (Delete)</title>
                        <circle r="9" className="fill-status-critical" fillOpacity={0.8} />
                        <X x={-5} y={-5} width={10} height={10} strokeWidth={2.5} className="text-background pointer-events-none" aria-hidden />
                      </g>
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      <div className="absolute top-3 right-3 z-10 flex items-center gap-0.5 bg-card border border-border rounded-md p-1 shadow-card">
        <ToolGroup>
          <ToolBtn onClick={() => setZoom((z) => Math.min(3, z + 0.1))} title="확대 (+)"><ZoomIn className="w-4 h-4" /></ToolBtn>
          <ToolBtn onClick={() => setZoom((z) => Math.max(0.2, z - 0.1))} title="축소 (-)"><ZoomOut className="w-4 h-4" /></ToolBtn>
          <ToolBtn onClick={fitToScreen} title="화면 맞춤 (Ctrl+0)"><Maximize2 className="w-4 h-4" /></ToolBtn>
        </ToolGroup>
        <ToolDivider />
        <ToolGroup>
          <ToolBtn onClick={handleAutoLayout} title="자동 배치"><GitBranch className="w-4 h-4" /></ToolBtn>
        </ToolGroup>
        <ToolDivider />
        <ToolGroup>
          <ToolBtn onClick={() => setLayoutMode('mindmap')} active={layoutMode === 'mindmap'} title="마인드맵"><LayoutGrid className="w-4 h-4" /></ToolBtn>
          <ToolBtn onClick={() => setLayoutMode('tree')} active={layoutMode === 'tree'} title="트리"><Rows3 className="w-4 h-4" /></ToolBtn>
          <ToolBtn onClick={() => setLayoutMode('orgchart')} active={layoutMode === 'orgchart'} title="조직도"><Building2 className="w-4 h-4" /></ToolBtn>
        </ToolGroup>
        <ToolDivider />
        <ToolGroup>
          <ToolBtn onClick={() => setConnStyle('bezier')} active={connStyle === 'bezier'} title="베지어"><Spline className="w-4 h-4" /></ToolBtn>
          <ToolBtn onClick={() => setConnStyle('straight')} active={connStyle === 'straight'} title="직선"><Minus className="w-4 h-4" /></ToolBtn>
          <ToolBtn onClick={() => setConnStyle('elbow')} active={connStyle === 'elbow'} title="꺾은선"><CornerDownRight className="w-4 h-4" /></ToolBtn>
        </ToolGroup>
        <ToolDivider />
        <ToolGroup>
          <ToolBtn onClick={() => exportMindMap('png')} title="PNG 내보내기"><Download className="w-4 h-4" /></ToolBtn>
          <ToolBtn onClick={() => exportMindMap('svg')} title="SVG 내보내기"><FileImage className="w-4 h-4" /></ToolBtn>
        </ToolGroup>
        <span className="text-xs text-muted-foreground tabular-nums px-2 font-medium select-none">{Math.round(zoom * 100)}%</span>
      </div>

      <div className="absolute bottom-4 right-4">
        <button
          type="button"
          onClick={() => setShowShortcuts((s) => !s)}
          onMouseEnter={() => setHoverShortcut(true)}
          onMouseLeave={() => setHoverShortcut(false)}
          aria-expanded={showShortcuts}
          className="p-2 rounded-xl border border-border bg-card shadow-card hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          title="단축키 도움말 (?)"
          aria-label="단축키 도움말"
        >
          <HelpCircle className="w-4 h-4" />
        </button>
      </div>

      {(showShortcuts || hoverShortcut) && (
        <div className="absolute bottom-14 right-4 bg-card border border-border rounded-md p-4 text-sm shadow-card w-80 z-20">
          <div className="flex items-center justify-between mb-1">
            <p className="font-semibold">키보드 단축키</p>
            <span className="text-xs text-muted-foreground">? 키 토글</span>
          </div>
          <p className="text-xs text-muted-foreground mb-3">캔버스를 클릭하거나 Tab 으로 캔버스에 포커스한 뒤 씁니다.</p>
          <ul className="space-y-1.5">
            {SHORTCUTS.map(([k, v]) => (
              <li key={k} className="flex items-center justify-between gap-3 text-muted-foreground">
                <kbd className="px-1.5 py-0.5 rounded-md bg-secondary border border-border text-xs font-mono text-foreground">
                  {k}
                </kbd>
                <span className="text-xs">{v}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {selectedNode?.note && (
        <div className="absolute bottom-4 left-4 bg-card border border-border rounded-md px-4 py-3 max-w-sm shadow-card">
          <div className="flex items-center gap-1.5 mb-1">
            <span className="w-1.5 h-1.5 rounded-full bg-primary" />
            <p className="text-xs font-medium text-muted-foreground">{selectedNode.label}</p>
          </div>
          <p className="text-sm whitespace-pre-wrap text-foreground/90 leading-relaxed">{selectedNode.note}</p>
        </div>
      )}
    </div>
  );
}

// ── Outline (목록 보기 — 캔버스 대안, 15차 A-16·정책 ⑧) ─────────────────────────
function MindMapOutline({
  mindmap,
  onNodeSelect,
  selectedNodeId,
  onAddChild,
  onAddSibling,
  onEditNode,
  onDeleteNode,
  keyboardDisabled,
}: NodeActionProps) {
  const nodes = mindmap.nodes;
  const { children: childMap } = useMemo(() => buildNodeTree(nodes), [nodes]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const rows = useMemo(() => flattenOutline(nodes, childMap, collapsed), [nodes, childMap, collapsed]);
  const treeRef = useRef<HTMLUListElement>(null);
  const itemRefs = useRef(new globalThis.Map<string, HTMLLIElement>());
  const refocusAfterDelete = useRef(false);
  const fid = useId();

  const requestDelete = (id: string) => {
    refocusAfterDelete.current = true;
    onDeleteNode(id);
  };

  const activeId = rows.some((r) => r.node.id === selectedNodeId) ? selectedNodeId : rows[0]?.node.id ?? null;

  // 로빙 탭 인덱스 — 트리 안에 포커스가 있을 때만 선택 행으로 포커스를 옮긴다.
  useEffect(() => {
    if (!activeId) return;
    const el = itemRefs.current.get(activeId);
    const active = document.activeElement;
    // 트리 안에 있었거나, 트리에서 시작한 삭제로 포커스가 사라졌으면(body) 선택 행으로 되돌린다.
    const lost = refocusAfterDelete.current && active === document.body;
    if (el && (treeRef.current?.contains(active) || lost) && active !== el) {
      refocusAfterDelete.current = false;
      el.focus();
    }
  }, [activeId]);

  const setOpen = (id: string, open: boolean) => {
    setCollapsed((prev) => {
      if (open === !prev.has(id)) return prev;
      const next = new Set(prev);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addChild = (id: string) => {
    setOpen(id, true);
    onAddChild(id);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (keyboardDisabled || e.nativeEvent.isComposing || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.getAttribute('role') !== 'treeitem') return;
    const idx = rows.findIndex((r) => r.node.id === target.dataset.nodeId);
    if (idx < 0) return;
    const row = rows[idx];
    const id = row.node.id;
    const isOpen = row.hasKids && !collapsed.has(id);
    const mod = e.ctrlKey || e.metaKey;
    const select = (i: number) => { const r = rows[i]; if (r) onNodeSelect(r.node.id); };

    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); select(Math.min(rows.length - 1, idx + 1)); break;
      case 'ArrowUp': e.preventDefault(); select(Math.max(0, idx - 1)); break;
      case 'Home': e.preventDefault(); select(0); break;
      case 'End': e.preventDefault(); select(rows.length - 1); break;
      case 'ArrowRight':
        e.preventDefault();
        if (row.hasKids && !isOpen) setOpen(id, true);
        else if (isOpen) select(idx + 1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (isOpen) setOpen(id, false);
        else if (row.parentId) onNodeSelect(row.parentId);
        break;
      case 'Insert': e.preventDefault(); addChild(id); break;
      case 'Enter':
        e.preventDefault();
        if (mod) addChild(id);
        else if (!e.shiftKey) onAddSibling(id);
        break;
      case 'F2': e.preventDefault(); onEditNode(row.node); break;
      case 'Delete':
      case 'Backspace': e.preventDefault(); requestDelete(id); break;
      default:
    }
  };

  const actionBtn = 'p-1 rounded-xl text-muted-foreground hover:bg-secondary hover:text-foreground';

  return (
    <div className="absolute inset-0 overflow-y-auto p-4">
      <p id={`${fid}-hint`} className="text-xs text-muted-foreground mb-2">
        ↑↓ 이동 · ←→ 접기/펼치기 · Enter 형제 추가 · Insert 또는 Ctrl+Enter 자식 추가 · F2 수정 · Delete 삭제
      </p>
      <ul
        ref={treeRef}
        role="tree"
        aria-label={`${mindmap.title} 노드 목록`}
        aria-describedby={`${fid}-hint`}
        onKeyDown={handleKeyDown}
        className="space-y-0.5"
      >
        {rows.map((r) => {
          const n = r.node;
          const isSelected = n.id === selectedNodeId;
          const isOpen = r.hasKids && !collapsed.has(n.id);
          return (
            <li
              key={n.id}
              ref={(el) => { if (el) itemRefs.current.set(n.id, el); else itemRefs.current.delete(n.id); }}
              role="treeitem"
              data-node-id={n.id}
              aria-level={r.level}
              aria-posinset={r.posInSet}
              aria-setsize={r.setSize}
              aria-selected={isSelected}
              aria-expanded={r.hasKids ? isOpen : undefined}
              aria-label={n.label}
              aria-describedby={n.note ? `${fid}-note-${n.id}` : undefined}
              tabIndex={n.id === activeId ? 0 : -1}
              onClick={() => onNodeSelect(n.id)}
              onFocus={(e) => { if (e.target === e.currentTarget && !isSelected) onNodeSelect(n.id); }}
              className={`group flex items-center gap-1.5 pr-2 py-1.5 rounded-xl cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                isSelected ? 'bg-primary/10' : 'hover:bg-secondary'
              }`}
              style={{ paddingLeft: `${(r.level - 1) * 20 + 8}px` }}
            >
              {r.hasKids ? (
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); setOpen(n.id, !isOpen); }}
                  className="p-0.5 rounded-xl text-muted-foreground hover:bg-secondary"
                  title={isOpen ? '접기' : '펼치기'}
                  aria-label={isOpen ? `${n.label} 접기` : `${n.label} 펼치기`}
                >
                  <ChevronRight className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                </button>
              ) : (
                <span className="w-[18px] flex-shrink-0" aria-hidden="true" />
              )}
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${n.color ? '' : 'bg-muted-foreground'}`}
                style={n.color ? { backgroundColor: n.color } : undefined}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className={`block text-sm truncate ${r.level === 1 ? 'font-semibold' : ''}`}>{n.label}</span>
                {n.note && (
                  <span id={`${fid}-note-${n.id}`} className="block text-xs text-muted-foreground truncate">{n.note}</span>
                )}
              </span>
              <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                <button type="button" tabIndex={-1} onClick={(e) => { e.stopPropagation(); addChild(n.id); }}
                  className={actionBtn} title="자식 노드 추가" aria-label={`${n.label}에 자식 노드 추가`}>
                  <Plus className="w-3.5 h-3.5" />
                </button>
                <button type="button" tabIndex={-1} onClick={(e) => { e.stopPropagation(); onAddSibling(n.id); }}
                  className={actionBtn} title="형제 노드 추가" aria-label={`${n.label}의 형제 노드 추가`}>
                  <ArrowLeftRight className="w-3.5 h-3.5" />
                </button>
                <button type="button" tabIndex={-1} onClick={(e) => { e.stopPropagation(); onEditNode(n); }}
                  className={actionBtn} title="노드 수정" aria-label={`${n.label} 수정`}>
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
                <button type="button" tabIndex={-1} onClick={(e) => { e.stopPropagation(); requestDelete(n.id); }}
                  className={`${actionBtn} hover:text-status-critical`} title="노드 삭제" aria-label={`${n.label} 삭제`}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Toolbar primitives ───────────────────────────────────────────────────────
function ToolGroup({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-0.5">{children}</div>;
}

function ToolDivider() {
  return <span className="w-px h-5 bg-border mx-1" />;
}

function ToolBtn({
  onClick, title, active, children,
}: { onClick: () => void; title: string; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`p-1.5 rounded-xl transition-colors ${
        active
          ? 'bg-primary/15 text-primary'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────
type ViewMode = 'canvas' | 'outline';
const VIEW_MODE_KEY = 'mindmap.viewMode';

function readViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === 'outline' ? 'outline' : 'canvas';
  } catch {
    return 'canvas';
  }
}

const inputCls = 'w-full px-2.5 py-1.5 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/40';

export function MindMapPage() {
  const mapsQuery = useMindMaps();
  const maps = useMemo(() => mapsQuery.data ?? [], [mapsQuery.data]);
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);
  const mapQuery = useMindMap(selectedMapId);
  const currentMap = mapQuery.data;
  const createMap = useCreateMindMap();
  const updateMap = useUpdateMindMap();
  const deleteMap = useDeleteMindMap();
  const createNode = useCreateNode(selectedMapId ?? '');
  const updateNode = useUpdateNode(selectedMapId ?? '');
  const deleteNode = useDeleteNode(selectedMapId ?? '');
  const formId = useId();

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showCreateMap, setShowCreateMap] = useState(false);
  const [editingMapTitle, setEditingMapTitle] = useState('');
  const [editingMapConfluence, setEditingMapConfluence] = useState('');
  const [editingMapTenant, setEditingMapTenant] = useState<string | null>(null);
  const [nodeEditorState, setNodeEditorState] = useState<{
    mode: 'create' | 'edit';
    parentId?: string;
    node?: MindMapNode;
  } | null>(null);
  const [mapDialog, setMapDialog] = useState<{ kind: 'rename' | 'confluence'; map: MindMapListItem } | null>(null);
  const [mapToDelete, setMapToDelete] = useState<MindMapListItem | null>(null);
  const [nodeToDelete, setNodeToDelete] = useState<MindMapNode | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);

  const changeViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch { /* 저장 불가(사생활 보호 모드 등) — 이번 세션만 유지 */ }
  };

  // 목록이 바뀌면(첫 로드·삭제) 선택을 유효한 맵으로 맞춘다.
  useEffect(() => {
    if (!mapsQuery.isSuccess) return;
    if (selectedMapId && maps.some((m) => m.id === selectedMapId)) return;
    const next = maps[0]?.id ?? null;
    if (next !== selectedMapId) {
      setSelectedMapId(next);
      setSelectedNodeId(null);
    }
  }, [mapsQuery.isSuccess, maps, selectedMapId]);

  const resetCreateForm = () => {
    setShowCreateMap(false);
    setEditingMapTitle('');
    setEditingMapConfluence('');
    setEditingMapTenant(null);
  };

  const handleCreateMap = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = editingMapTitle.trim();
    if (!title || createMap.isPending) return;
    try {
      const m = await createMap.mutateAsync({
        title,
        confluenceUrl: editingMapConfluence.trim() || undefined,
        tenantId: editingMapTenant,
      });
      setSelectedMapId(m.id);
      setSelectedNodeId(null);
      resetCreateForm();
    } catch {
      /* 실패 사유는 hook 토스트가 알린다 — 입력은 그대로 둔다 */
    }
  };

  const handleMapDialogSubmit = async (value: string) => {
    if (!mapDialog) return;
    const data: MindMapUpdate = mapDialog.kind === 'rename'
      ? { title: value }
      : { confluenceUrl: value || null };
    try {
      await updateMap.mutateAsync({ id: mapDialog.map.id, data });
      setMapDialog(null);
    } catch {
      /* hook 토스트 */
    }
  };

  const confirmDeleteMap = async () => {
    if (!mapToDelete) return;
    const id = mapToDelete.id;
    try {
      await deleteMap.mutateAsync(id);
      if (selectedMapId === id) {
        setSelectedMapId(maps.find((m) => m.id !== id)?.id ?? null);
        setSelectedNodeId(null);
      }
      setMapToDelete(null);
    } catch {
      /* hook 토스트 — 선택은 그대로 */
    }
  };

  const handleAddRootNode = () => {
    if (!selectedMapId) return;
    setNodeEditorState({ mode: 'create', parentId: undefined });
  };

  const handleAddChild = useCallback((parentId: string) => {
    setNodeEditorState({ mode: 'create', parentId });
  }, []);

  const handleAddSibling = useCallback((nodeId: string) => {
    const selected = currentMap?.nodes.find((n) => n.id === nodeId);
    if (!selected) return;
    setNodeEditorState({ mode: 'create', parentId: selected.parentId ?? undefined });
  }, [currentMap]);

  const handleEditNode = useCallback((node: MindMapNode) => {
    setNodeEditorState({ mode: 'edit', node });
  }, []);

  // 삭제는 키보드·마우스 모두 확인을 거친다(15차 A-6).
  const handleDeleteNode = useCallback((nodeId: string) => {
    const node = currentMap?.nodes.find((n) => n.id === nodeId);
    if (node) setNodeToDelete(node);
  }, [currentMap]);

  const nodeToDeleteDescendants = useMemo(() => {
    if (!nodeToDelete || !currentMap) return 0;
    return countDescendants(nodeToDelete.id, buildNodeTree(currentMap.nodes).children);
  }, [nodeToDelete, currentMap]);

  const confirmDeleteNode = async () => {
    if (!nodeToDelete) return;
    const id = nodeToDelete.id;
    try {
      await deleteNode.mutateAsync(id);
      // 부모로 선택을 옮겨 키보드 사용자가 트리·캔버스에서 위치를 잃지 않게 한다.
      setSelectedNodeId(nodeToDelete.parentId ?? null);
      setNodeToDelete(null);
    } catch {
      /* hook 토스트 */
    }
  };

  const handleNodeSave = async (value: NodeEditorValue) => {
    if (!selectedMapId || !nodeEditorState) return;
    const shapeExtra = { shape: value.shape, borderStyle: value.borderStyle, size: value.size };

    try {
      if (nodeEditorState.mode === 'create') {
        const created = await createNode.mutateAsync({
          mindmapId: selectedMapId,
          parentId: nodeEditorState.parentId ?? null,
          label: value.label,
          note: value.note || undefined,
          color: value.color || undefined,
          extra: shapeExtra,
        });
        setSelectedNodeId(created.id);
      } else if (nodeEditorState.mode === 'edit' && nodeEditorState.node) {
        // 비운 메모·기본 색은 null 로 보내야 해제된다(undefined = 기존 값 유지).
        await updateNode.mutateAsync({
          nodeId: nodeEditorState.node.id,
          data: {
            label: value.label,
            note: value.note || null,
            color: value.color || null,
            extra: { ...(nodeEditorState.node.extra ?? {}), ...shapeExtra },
          },
        });
      }
      setNodeEditorState(null);
    } catch {
      /* hook 토스트 — 편집기는 열어 두어 입력을 잃지 않게 한다 */
    }
  };

  const modalOpen = !!nodeEditorState || !!nodeToDelete || !!mapDialog || !!mapToDelete;
  const nodeSaving = createNode.isPending || updateNode.isPending;

  const renderMain = () => {
    if (!selectedMapId) {
      if (mapsQuery.isLoading) return <LoadingState />;
      return (
        <EmptyState
          icon={MapIcon}
          title="선택된 마인드맵이 없습니다."
          description="왼쪽 목록에서 마인드맵을 고르거나 새로 만드세요."
        />
      );
    }
    if (mapQuery.isLoading) return <LoadingState label="마인드맵을 불러오는 중…" />;
    if (!currentMap) {
      return (
        <ErrorState
          error={mapQuery.error}
          title="마인드맵을 불러오지 못했습니다."
          onRetry={() => { void mapQuery.refetch(); }}
        />
      );
    }
    if (currentMap.nodes.length === 0) {
      return (
        <EmptyState
          icon={MapIcon}
          title="노드가 없습니다."
          description="루트 노드부터 시작해 자식 노드를 자유롭게 추가하세요."
          action={{ label: '첫 번째 노드 추가', onClick: handleAddRootNode }}
        />
      );
    }
    const common: NodeActionProps = {
      mindmap: currentMap,
      selectedNodeId,
      onNodeSelect: setSelectedNodeId,
      onAddChild: handleAddChild,
      onAddSibling: handleAddSibling,
      onEditNode: handleEditNode,
      onDeleteNode: handleDeleteNode,
      keyboardDisabled: modalOpen,
    };
    return viewMode === 'outline'
      ? <MindMapOutline key={currentMap.id} {...common} />
      : <MindMapCanvas key={currentMap.id} {...common} />;
  };

  const showCanvasGrid = viewMode === 'canvas' && !!currentMap && currentMap.nodes.length > 0;
  const centered = !(currentMap && currentMap.nodes.length > 0);

  return (
    <div className="app-min-h-screen bg-background flex">
      <h1 className="sr-only">마인드맵</h1>
      <aside className="w-64 flex-shrink-0 border-r border-border bg-card flex flex-col">
        <div className="px-4 py-3.5 border-b border-border flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight truncate">마인드맵</p>
            {mapsQuery.isSuccess && (
              <p className="text-xs text-muted-foreground tabular-nums">전체 {maps.length}개</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => { setShowCreateMap(true); setEditingMapTitle(''); }}
            className="p-1.5 rounded-xl hover:bg-secondary text-muted-foreground hover:text-primary transition-colors"
            title="새 마인드맵"
            aria-label="새 마인드맵"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        {showCreateMap && (
          <form onSubmit={handleCreateMap} className="px-3 py-2.5 border-b border-border bg-muted/20 space-y-1.5" aria-label="새 마인드맵 만들기">
            <label htmlFor={`${formId}-title`} className="block text-xs font-medium text-muted-foreground">제목</label>
            <input
              id={`${formId}-title`}
              type="text"
              value={editingMapTitle}
              onChange={(e) => setEditingMapTitle(e.target.value)}
              placeholder="제목을 입력하고 Enter"
              className={inputCls}
              required
              autoFocus
            />
            <label htmlFor={`${formId}-confluence`} className="block text-xs font-medium text-muted-foreground">Confluence URL (선택)</label>
            <input
              id={`${formId}-confluence`}
              type="url"
              value={editingMapConfluence}
              onChange={(e) => setEditingMapConfluence(e.target.value)}
              placeholder="https://…"
              className={inputCls}
            />
            <TenantScopeSelect
              value={editingMapTenant}
              onChange={setEditingMapTenant}
              labelClassName="block text-xs font-medium text-muted-foreground mb-1"
              selectClassName={inputCls}
            />
            <div className="flex gap-1.5">
              <button
                type="submit"
                disabled={createMap.isPending || !editingMapTitle.trim()}
                aria-busy={createMap.isPending || undefined}
                className="flex-1 py-1.5 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors disabled:opacity-60"
              >
                {createMap.isPending ? '생성 중…' : '생성'}
              </button>
              <button type="button" onClick={resetCreateForm} className="flex-1 py-1.5 text-sm bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors">취소</button>
            </div>
          </form>
        )}

        <div className="flex-1 overflow-y-auto py-2 space-y-0.5">
          {mapsQuery.isLoading ? (
            <div className="space-y-2 px-2">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="block w-full h-12 rounded-xl" />
              ))}
            </div>
          ) : mapsQuery.isError && maps.length === 0 ? (
            <ErrorState
              compact
              error={mapsQuery.error}
              title="마인드맵 목록을 불러오지 못했습니다."
              onRetry={() => { void mapsQuery.refetch(); }}
            />
          ) : maps.length === 0 ? (
            <EmptyState
              compact
              icon={MapIcon}
              title="마인드맵이 없습니다."
              description="새 마인드맵을 만들어 아이디어를 정리하세요."
              action={{ label: '새로 만들기', onClick: () => setShowCreateMap(true), variant: 'secondary' }}
            />
          ) : (
            maps.map((m) => {
              const isActive = selectedMapId === m.id;
              return (
                <div
                  key={m.id}
                  className={`group mx-2 rounded-xl transition-colors flex items-center gap-1 ${
                    isActive
                      ? 'bg-primary/10 text-primary ring-1 ring-primary/20'
                      : 'hover:bg-secondary text-foreground'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => { setSelectedMapId(m.id); setSelectedNodeId(null); }}
                    aria-current={isActive ? 'true' : undefined}
                    className="flex-1 min-w-0 text-left pl-3 py-2.5 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    <span className={`block text-sm truncate ${isActive ? 'font-semibold' : 'font-medium'}`}>{m.title}</span>
                    <span className="block text-xs text-muted-foreground tabular-nums">{m.nodeCount}개 노드</span>
                  </button>
                  {m.confluenceUrl && (
                    <a
                      href={m.confluenceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1 rounded-xl text-primary hover:bg-primary/10"
                      title={`Confluence: ${m.confluenceUrl}`}
                      aria-label={`${m.title} Confluence 문서 열기 (새 창)`}
                    >
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                  <div className="flex items-center gap-0.5 pr-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                    <button
                      type="button"
                      onClick={() => setMapDialog({ kind: 'confluence', map: m })}
                      className="p-1 hover:bg-secondary rounded-xl text-muted-foreground hover:text-primary"
                      title="Confluence 링크 변경"
                      aria-label={`${m.title} Confluence 링크 변경`}
                    >
                      <Link2 className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setMapDialog({ kind: 'rename', map: m })}
                      className="p-1 hover:bg-secondary rounded-xl text-muted-foreground hover:text-primary"
                      title="이름 변경"
                      aria-label={`${m.title} 이름 변경`}
                    >
                      <Edit2 className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setMapToDelete(m)}
                      className="p-1 hover:bg-status-critical/10 rounded-xl text-muted-foreground hover:text-status-critical"
                      title="삭제"
                      aria-label={`${m.title} 삭제`}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        <div className="px-6 py-3 border-b border-border flex items-center gap-3 bg-card">
          {currentMap ? (
            <>
              <span className="text-xs font-medium text-muted-foreground">마인드맵</span>
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="text-sm font-semibold truncate">{currentMap.title}</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground tabular-nums">
                {currentMap.nodes.length} 노드
              </span>
              <div className="flex-1" />
              <div className="flex items-center gap-0.5 p-0.5 rounded-xl border border-border" role="group" aria-label="보기 방식">
                <button
                  type="button"
                  onClick={() => changeViewMode('canvas')}
                  aria-pressed={viewMode === 'canvas'}
                  className={`px-2.5 py-1 text-sm rounded-xl flex items-center gap-1.5 transition-colors ${
                    viewMode === 'canvas' ? 'bg-secondary text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Network className="w-3.5 h-3.5" aria-hidden="true" /> 캔버스
                </button>
                <button
                  type="button"
                  onClick={() => changeViewMode('outline')}
                  aria-pressed={viewMode === 'outline'}
                  className={`px-2.5 py-1 text-sm rounded-xl flex items-center gap-1.5 transition-colors ${
                    viewMode === 'outline' ? 'bg-secondary text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <ListTree className="w-3.5 h-3.5" aria-hidden="true" /> 목록 보기
                </button>
              </div>
              <button
                type="button"
                onClick={handleAddRootNode}
                className="px-3 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors flex items-center gap-1.5 shadow-card"
              >
                <Plus className="w-3.5 h-3.5" /> 루트 노드
              </button>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">마인드맵을 선택하거나 새로 만드세요</span>
          )}
        </div>

        <div
          className={`flex-1 relative overflow-hidden bg-background ${
            showCanvasGrid ? 'bg-[radial-gradient(circle,hsl(var(--border))_1px,transparent_1px)] bg-[length:24px_24px]' : ''
          } ${centered ? 'flex items-center justify-center' : ''}`}
        >
          {renderMain()}
        </div>
      </main>

      {nodeEditorState && (
        <NodeEditor
          key={nodeEditorState.mode === 'edit' && nodeEditorState.node
            ? `edit-${nodeEditorState.node.id}`
            : `create-${nodeEditorState.parentId ?? 'root'}`}
          initial={nodeEditorState.mode === 'edit' && nodeEditorState.node
            ? {
              label: nodeEditorState.node.label,
              note: nodeEditorState.node.note ?? '',
              color: nodeEditorState.node.color ?? '',
              shape: ((nodeEditorState.node.extra?.shape as NodeShape) ?? 'rounded'),
              borderStyle: ((nodeEditorState.node.extra?.borderStyle as NodeBorderStyle) ?? 'solid'),
              size: ((nodeEditorState.node.extra?.size as NodeSize) ?? 'md'),
            }
            : null}
          title={nodeEditorState.mode === 'create' ? '노드 추가' : '노드 수정'}
          busy={nodeSaving}
          onSave={handleNodeSave}
          onClose={() => setNodeEditorState(null)}
        />
      )}

      {mapDialog && (
        <TextInputDialog
          key={`${mapDialog.kind}-${mapDialog.map.id}`}
          open
          title={mapDialog.kind === 'rename' ? '마인드맵 이름 변경' : 'Confluence 링크 변경'}
          label={mapDialog.kind === 'rename' ? '제목' : 'Confluence URL'}
          type={mapDialog.kind === 'rename' ? 'text' : 'url'}
          required={mapDialog.kind === 'rename'}
          initialValue={mapDialog.kind === 'rename' ? mapDialog.map.title : (mapDialog.map.confluenceUrl ?? '')}
          placeholder={mapDialog.kind === 'rename' ? '마인드맵 제목' : 'https://…'}
          hint={mapDialog.kind === 'confluence' ? '비우고 저장하면 링크를 제거합니다.' : undefined}
          busy={updateMap.isPending}
          onSubmit={handleMapDialogSubmit}
          onCancel={() => setMapDialog(null)}
        />
      )}

      <ConfirmDialog
        open={!!mapToDelete}
        title="마인드맵 삭제"
        description={mapToDelete
          ? `"${mapToDelete.title}" 과 노드 ${mapToDelete.nodeCount}개가 모두 삭제됩니다. 되돌릴 수 없습니다.`
          : undefined}
        confirmLabel="삭제"
        danger
        busy={deleteMap.isPending}
        onConfirm={() => { void confirmDeleteMap(); }}
        onCancel={() => setMapToDelete(null)}
      />

      <ConfirmDialog
        open={!!nodeToDelete}
        title="노드 삭제"
        description={nodeToDelete
          ? nodeToDeleteDescendants > 0
            ? `"${nodeToDelete.label}" 과 하위 노드 ${nodeToDeleteDescendants}개가 함께 삭제됩니다.`
            : `"${nodeToDelete.label}" 노드를 삭제합니다.`
          : undefined}
        confirmLabel="삭제"
        danger
        busy={deleteNode.isPending}
        onConfirm={() => { void confirmDeleteNode(); }}
        onCancel={() => setNodeToDelete(null)}
      />
    </div>
  );
}
