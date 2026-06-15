import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Map as MapIcon,
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
} from 'lucide-react';
import {
  useMindMaps, useMindMap, useCreateMindMap, useUpdateMindMap, useDeleteMindMap,
  useCreateNode, useUpdateNode, useDeleteNode, useBulkUpdatePositions,
} from '@/hooks/useMindMap';
import type { MindMap, MindMapNode } from '@/types';

// ── Constants ───────────────────────────────────────────────────────────────
const NODE_COLORS = [
  { label: '기본', value: '' },
  { label: 'Slate', value: '#64748b' },
  { label: 'Gray', value: '#6b7280' },
  { label: 'Zinc', value: '#71717a' },
  { label: 'Stone', value: '#78716c' },
  { label: 'Red', value: '#ef4444' },
  { label: 'Orange', value: '#f97316' },
  { label: 'Amber', value: '#f59e0b' },
  { label: 'Yellow', value: '#eab308' },
  { label: 'Teal', value: '#14b8a6' },
  { label: 'Cyan', value: '#06b6d4' },
  { label: 'Sky', value: '#0ea5e9' },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Indigo', value: '#6366f1' },
  { label: 'Violet', value: '#8b5cf6' },
  { label: 'Purple', value: '#a855f7' },
  { label: 'Pink', value: '#ec4899' },
  { label: 'Rose', value: '#f43f5e' },
  { label: 'Emerald', value: '#10b981' },
  { label: 'Lime', value: '#84cc16' },
  { label: 'Fuchsia', value: '#d946ef' },
];

const BRANCH_COLORS = ['#6366f1', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#f97316', '#ec4899', '#ef4444'];

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
  { value: 'rect', label: 'Rectangle' },
  { value: 'rounded', label: 'Rounded' },
  { value: 'pill', label: 'Pill' },
  { value: 'circle', label: 'Circle' },
  { value: 'diamond', label: 'Diamond' },
  { value: 'hexagon', label: 'Hexagon' },
  { value: 'parallelogram', label: 'Parallelogram' },
  { value: 'cloud', label: 'Cloud' },
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

function nodeColor(node: MindMapNode, isRoot: boolean) {
  if (node.color) return node.color;
  return isRoot ? '#6366f1' : '#374151';
}

function rgbaFromHex(hex: string, alpha: number) {
  const raw = hex.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
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

function getBranchColor(nodeId: string, nodes: MindMapNode[]) {
  const { byId, children } = buildNodeTree(nodes);
  const roots = (children.get(null) ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
  const root = roots[0];
  if (!root) return '#6366f1';

  const rootKids = (children.get(root.id) ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
  const branchIndex = new globalThis.Map(rootKids.map((kid, idx) => [kid.id, idx % BRANCH_COLORS.length]));

  let cur = byId.get(nodeId);
  while (cur && cur.parentId) {
    if (cur.parentId === root.id) return BRANCH_COLORS[branchIndex.get(cur.id) ?? 0];
    cur = byId.get(cur.parentId);
  }
  return '#6366f1';
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
}

function NodeEditor({ initial, onSave, onClose, title }: NodeEditorProps) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [color, setColor] = useState(initial?.color ?? '');
  const [shape, setShape] = useState<NodeShape>(initial?.shape ?? 'rounded');
  const [borderStyle, setBorderStyle] = useState<NodeBorderStyle>(initial?.borderStyle ?? 'solid');
  const [size, setSize] = useState<NodeSize>(initial?.size ?? 'md');

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
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
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-2xl p-5 w-full max-w-lg mac-shadow max-h-[88vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <MapIcon className="w-4 h-4 text-primary" />
            {title}
          </h3>
          <button onClick={onClose} className="p-1.5 hover:bg-secondary rounded-lg text-muted-foreground hover:text-foreground transition-colors" aria-label="닫기">
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
            <label htmlFor={f('note')} className="block text-sm font-medium text-muted-foreground mb-1">메모 (선택)</label>
            <textarea id={f('note')} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="부연 설명이나 메모" rows={3} className={`${inputClass} resize-none`} />
          </div>
          <div>
            <p className="block text-sm font-medium text-muted-foreground mb-1">색상</p>
            <div className="grid grid-cols-5 gap-2">
              {NODE_COLORS.map((c) => (
                <button
                  key={`${c.label}-${c.value}`}
                  type="button"
                  onClick={() => setColor(c.value)}
                  className={`w-5 h-5 rounded-full border-2 transition-all ${
                    color === c.value ? 'scale-125 border-white' : 'border-transparent opacity-75 hover:opacity-100'
                  }`}
                  style={{ backgroundColor: c.value || '#9ca3af' }}
                  title={c.label}
                />
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Custom</span>
              <input type="color" value={color || '#6366f1'} onChange={(e) => setColor(e.target.value)} className="w-10 h-6 bg-transparent" />
              <button type="button" onClick={() => setColor('')} className="text-sm px-2 py-1 border border-border rounded-md hover:bg-secondary">기본</button>
            </div>
          </div>

          <div>
            <p className="block text-sm font-medium text-muted-foreground mb-1">모양</p>
            <div className="grid grid-cols-4 gap-2">
              {NODE_SHAPES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setShape(s.value)}
                  className={`p-2 border rounded-lg flex flex-col items-center gap-1 text-xs ${shape === s.value ? 'border-primary bg-primary/10' : 'border-border hover:bg-secondary/70'}`}
                >
                  <svg width="42" height="24" viewBox="0 0 42 24">
                    <g transform="translate(1,1)">
                      {renderNodeShape(s.value, 40, 22, 'rgba(99,102,241,0.15)', '#6366f1', 1.2)}
                    </g>
                  </svg>
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="block text-sm font-medium text-muted-foreground mb-1">테두리</p>
              <div className="flex gap-1">
                {(['solid', 'dashed', 'dotted'] as NodeBorderStyle[]).map((b) => (
                  <button key={b} type="button" onClick={() => setBorderStyle(b)}
                    className={`flex-1 px-2 py-1.5 text-sm rounded-md border ${borderStyle === b ? 'border-primary bg-primary/10' : 'border-border hover:bg-secondary'}`}>
                    {b}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="block text-sm font-medium text-muted-foreground mb-1">크기</p>
              <div className="flex gap-1">
                {(['sm', 'md', 'lg'] as NodeSize[]).map((s) => (
                  <button key={s} type="button" onClick={() => setSize(s)}
                    className={`flex-1 px-2 py-1.5 text-sm rounded-md border ${size === s ? 'border-primary bg-primary/10' : 'border-border hover:bg-secondary'}`}>
                    {s.toUpperCase()}
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
            <button type="submit"
              className="px-3.5 py-2 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl flex items-center gap-1.5 transition-colors">
              <Check className="w-3.5 h-3.5" /> 저장
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

interface CanvasProps {
  mindmap: MindMap;
  onNodeSelect: (nodeId: string | null) => void;
  selectedNodeId: string | null;
  onAddChild: (parentId: string) => void;
  onAddSibling: (nodeId: string) => void;
  onEditNode: (node: MindMapNode) => void;
  onDeleteNode: (nodeId: string) => void;
}

function MindMapCanvas({
  mindmap,
  onNodeSelect,
  selectedNodeId,
  onAddChild,
  onAddSibling,
  onEditNode,
  onDeleteNode,
}: CanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
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
  const bulkUpdate = useBulkUpdatePositions(mindmap.id);
  const saveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const nodes = mindmap.nodes;
  const { byId, children: childMap } = useMemo(() => buildNodeTree(nodes), [nodes]);

  const getLayout = useCallback((targetNodes: MindMapNode[]) => {
    if (layoutMode === 'tree') return treeLayout(targetNodes, 600, 120);
    if (layoutMode === 'orgchart') return orgChartLayout(targetNodes, 600, 120);
    return mindmapLayout(targetNodes);
  }, [layoutMode]);

  useEffect(() => {
    if (nodes.length === 0) { setNodePositions(new globalThis.Map()); return; }
    const layout = getLayout(nodes);
    const map = new globalThis.Map<string, { x: number; y: number }>();
    for (const n of nodes) {
      if (n.x != null && n.y != null) map.set(n.id, { x: n.x, y: n.y });
      else map.set(n.id, layout.get(n.id) ?? { x: 600, y: 400 });
    }
    setNodePositions(map);
  }, [nodes, getLayout]);

  const handleAutoLayout = () => {
    if (nodes.length === 0) return;
    const newPositions = getLayout(nodes);
    setNodePositions(newPositions);
    const updates = Array.from(newPositions.entries()).map(([id, pos]) => ({ id, ...pos }));
    bulkUpdate.mutate(updates);
  };

  const fitToScreen = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const getPos = (nodeId: string) => nodePositions.get(nodeId) ?? { x: 400, y: 300 };
  const rootIds = new Set((childMap.get(null) ?? []).map((n) => n.id));

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
    if (saveTimeout.current) clearTimeout(saveTimeout.current);
    saveTimeout.current = setTimeout(() => {
      const updates = Array.from(nodePositions.entries()).map(([id, pos]) => ({ id, ...pos }));
      bulkUpdate.mutate(updates);
    }, 800);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.min(3, Math.max(0.2, z - e.deltaY * 0.001)));
  };

  const handleNodeMouseDown = (e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();
    setDragNodeId(nodeId);
    onNodeSelect(nodeId);
  };

  const handleNodeMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragNodeId || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left - pan.x) / zoom;
    const y = (e.clientY - rect.top - pan.y) / zoom;
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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      if (e.key === '?') {
        e.preventDefault();
        setShowShortcuts((s) => !s);
        return;
      }

      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        setZoom((z) => Math.min(3, z + 0.1));
        return;
      }

      if (e.key === '-') {
        e.preventDefault();
        setZoom((z) => Math.max(0.2, z - 0.1));
        return;
      }

      if (e.key === '0') {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) fitToScreen();
        else setZoom(1);
        return;
      }

      if (!selectedNodeId) {
        if (e.key === 'Escape') onNodeSelect(null);
        return;
      }

      if (e.key === 'Tab') {
        e.preventDefault();
        onAddChild(selectedNodeId);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onAddSibling(selectedNodeId);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        onDeleteNode(selectedNodeId);
      } else if (e.key === 'F2') {
        e.preventDefault();
        const node = byId.get(selectedNodeId);
        if (node) onEditNode(node);
      } else if (e.key === 'Escape') {
        onNodeSelect(null);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigateToNearest('left');
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigateToNearest('right');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        navigateToNearest('up');
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        navigateToNearest('down');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedNodeId, onAddChild, onAddSibling, onDeleteNode, onEditNode, onNodeSelect, byId, navigateToNearest]);

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
    // 선택 핸들(+/↔/✎/✕)이 캡처되지 않도록 선택 해제 후 다음 프레임에 캡처.
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

  return (
    <div className="relative w-full h-full">
      <div className="absolute top-3 right-3 z-10 flex items-center gap-0.5 bg-card/90 backdrop-blur-md border border-border rounded-2xl p-1 mac-shadow">
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

      <svg
        ref={svgRef}
        className="w-full h-full cursor-grab"
        style={{ cursor: isPanning ? 'grabbing' : dragNodeId ? 'grabbing' : 'grab' }}
        onMouseDown={handleSvgMouseDown}
        onMouseMove={(e) => { handleSvgMouseMove(e); handleNodeMouseMove(e); }}
        onMouseUp={handleSvgMouseUp}
        onMouseLeave={handleSvgMouseUp}
        onWheel={handleWheel}
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

            const branchColor = getBranchColor(node.id, nodes);
            return (
              <path
                key={`edge-${node.id}`}
                d={getEdgePath(x1, y1, x2, y2)}
                fill="none"
                stroke={rgbaFromHex(branchColor, 0.5)}
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
            const color = nodeColor(node, isRoot);
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
                style={{ cursor: 'pointer' }}
              >
                {renderNodeShape(
                  shape,
                  nodeW,
                  nodeH,
                  rgbaFromHex(color, 0.15),
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
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {node.label.length > 18 ? `${node.label.slice(0, 16)}…` : node.label}
                </text>

                {kids.length > 0 && (
                  <g transform={`translate(${nodeW - 14}, -6)`}>
                    <circle r="8" fill={color} fillOpacity={0.8} />
                    <text x="0" y="0" textAnchor="middle" dominantBaseline="middle"
                      fontSize="8" fill="white" fontWeight="600" style={{ pointerEvents: 'none', userSelect: 'none' }}>
                      {kids.length}
                    </text>
                  </g>
                )}

                {isSelected && (
                  <g>
                    <g transform={`translate(${nodeW + 4}, ${nodeH / 2 - 20})`} onClick={(e) => { e.stopPropagation(); onAddChild(node.id); }} style={{ cursor: 'pointer' }}>
                      <circle r="9" fill="#6366f1" fillOpacity={0.9} />
                      <text x="0" y="0" textAnchor="middle" dominantBaseline="middle" fontSize="12" fill="white" style={{ pointerEvents: 'none' }}>+</text>
                    </g>
                    <g transform={`translate(${nodeW + 4}, ${nodeH / 2})`} onClick={(e) => { e.stopPropagation(); onAddSibling(node.id); }} style={{ cursor: 'pointer' }}>
                      <circle r="9" fill="#2563eb" fillOpacity={0.9} />
                      <text x="0" y="0" textAnchor="middle" dominantBaseline="middle" fontSize="11" fill="white" style={{ pointerEvents: 'none' }}>↔</text>
                    </g>
                    <g transform={`translate(${nodeW + 4}, ${nodeH / 2 + 20})`} onClick={(e) => { e.stopPropagation(); onEditNode(node); }} style={{ cursor: 'pointer' }}>
                      <circle r="9" fill="#374151" fillOpacity={0.9} />
                      <text x="0" y="0" textAnchor="middle" dominantBaseline="middle" fontSize="10" fill="white" style={{ pointerEvents: 'none' }}>✎</text>
                    </g>
                    <g transform={`translate(${nodeW / 2}, ${nodeH + 12})`} onClick={(e) => { e.stopPropagation(); onDeleteNode(node.id); }} style={{ cursor: 'pointer' }}>
                      <circle r="9" fill="#ef4444" fillOpacity={0.8} />
                      <text x="0" y="0" textAnchor="middle" dominantBaseline="middle" fontSize="10" fill="white" style={{ pointerEvents: 'none' }}>✕</text>
                    </g>
                  </g>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="absolute bottom-4 right-4">
        <button
          onClick={() => setShowShortcuts((s) => !s)}
          onMouseEnter={() => setHoverShortcut(true)}
          onMouseLeave={() => setHoverShortcut(false)}
          className="p-2 rounded-full border border-border bg-card/90 backdrop-blur-md mac-shadow hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
          title="단축키 도움말 (?)"
          aria-label="단축키 도움말"
        >
          <HelpCircle className="w-4 h-4" />
        </button>
      </div>

      {(showShortcuts || hoverShortcut) && (
        <div className="absolute bottom-14 right-4 bg-card/95 backdrop-blur-md border border-border rounded-2xl p-4 text-sm mac-shadow w-72 z-20">
          <div className="flex items-center justify-between mb-3">
            <p className="font-semibold flex items-center gap-1.5">
              <HelpCircle className="w-3.5 h-3.5 text-primary" />
              키보드 단축키
            </p>
            <span className="text-xs text-muted-foreground">? 키 토글</span>
          </div>
          <ul className="space-y-1.5">
            {[
              ['Tab', '자식 노드 추가'],
              ['Enter', '형제 노드 추가'],
              ['Delete / Backspace', '노드 삭제'],
              ['F2', '노드 수정'],
              ['Esc', '선택 해제'],
              ['← → ↑ ↓', '인접 노드 이동'],
              ['+ / -', '확대 / 축소'],
              ['0', '100%'],
              ['Ctrl + 0', '화면 맞춤'],
            ].map(([k, v]) => (
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

      {selectedNodeId && (() => {
        const node = nodes.find((n) => n.id === selectedNodeId);
        if (!node?.note) return null;
        return (
          <div className="absolute bottom-4 left-4 bg-card/95 backdrop-blur-md border border-border rounded-2xl px-4 py-3 max-w-sm mac-shadow">
            <div className="flex items-center gap-1.5 mb-1">
              <span className="w-1.5 h-1.5 rounded-full bg-primary" />
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{node.label}</p>
            </div>
            <p className="text-sm whitespace-pre-wrap text-foreground/90 leading-relaxed">{node.note}</p>
          </div>
        );
      })()}
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
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`p-1.5 rounded-lg transition-colors ${
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
export function MindMapPage() {
  const { data: maps = [], isLoading: mapsLoading } = useMindMaps();
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);
  const { data: currentMap } = useMindMap(selectedMapId);
  const createMap = useCreateMindMap();
  const updateMap = useUpdateMindMap();
  const deleteMap = useDeleteMindMap();
  const createNode = useCreateNode(selectedMapId ?? '');
  const updateNode = useUpdateNode(selectedMapId ?? '');
  const deleteNode = useDeleteNode(selectedMapId ?? '');

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showCreateMap, setShowCreateMap] = useState(false);
  const [editingMapTitle, setEditingMapTitle] = useState('');
  const [editingMapConfluence, setEditingMapConfluence] = useState('');
  const [nodeEditorState, setNodeEditorState] = useState<{
    mode: 'create' | 'edit';
    parentId?: string;
    node?: MindMapNode;
  } | null>(null);

  useEffect(() => {
    if (maps.length > 0 && !selectedMapId) setSelectedMapId(maps[0].id);
  }, [maps, selectedMapId]);

  const handleCreateMap = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMapTitle.trim()) return;
    const m = await createMap.mutateAsync({
      title: editingMapTitle.trim(),
      confluenceUrl: editingMapConfluence.trim() || undefined,
    });
    setSelectedMapId(m.id);
    setShowCreateMap(false);
    setEditingMapTitle('');
    setEditingMapConfluence('');
  };

  const handleDeleteMap = (mapId: string) => {
    if (!confirm('마인드맵을 삭제하시겠습니까? 모든 노드가 삭제됩니다.')) return;
    deleteMap.mutate(mapId);
    if (selectedMapId === mapId) setSelectedMapId(maps.find((m) => m.id !== mapId)?.id ?? null);
  };

  const handleAddRootNode = () => {
    if (!selectedMapId) return;
    setNodeEditorState({ mode: 'create', parentId: undefined });
  };

  const handleAddChild = (parentId: string) => {
    setNodeEditorState({ mode: 'create', parentId });
  };

  const handleAddSibling = (nodeId: string) => {
    const selected = currentMap?.nodes.find((n) => n.id === nodeId);
    if (!selected) return;
    setNodeEditorState({ mode: 'create', parentId: selected.parentId ?? undefined });
  };

  const handleEditNode = (node: MindMapNode) => {
    setNodeEditorState({ mode: 'edit', node });
  };

  const handleDeleteNode = (nodeId: string) => {
    if (!selectedMapId) return;
    const hasChildren = currentMap?.nodes.some((n) => n.parentId === nodeId);
    if (hasChildren && !confirm('자식 노드도 모두 삭제됩니다. 계속하시겠습니까?')) return;
    deleteNode.mutate(nodeId);
    setSelectedNodeId(null);
  };

  const handleNodeSave = (value: NodeEditorValue) => {
    if (!selectedMapId || !nodeEditorState) return;
    const extra = { shape: value.shape, borderStyle: value.borderStyle, size: value.size };

    if (nodeEditorState.mode === 'create') {
      createNode.mutate({
        mindmapId: selectedMapId,
        parentId: nodeEditorState.parentId ?? null,
        label: value.label,
        note: value.note || undefined,
        color: value.color || undefined,
        extra,
      });
    } else if (nodeEditorState.mode === 'edit' && nodeEditorState.node) {
      updateNode.mutate({
        nodeId: nodeEditorState.node.id,
        data: { label: value.label, note: value.note || undefined, color: value.color || undefined, extra },
      });
    }
    setNodeEditorState(null);
  };

  return (
    <div className="min-h-screen bg-background flex">
      <aside className="w-64 flex-shrink-0 border-r border-border bg-card flex flex-col">
        <div className="px-4 py-3.5 border-b border-border flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
              <MapIcon className="w-4 h-4 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold leading-tight truncate">마인드맵</p>
              <p className="text-xs text-muted-foreground tabular-nums">전체 {maps.length}개</p>
            </div>
          </div>
          <button
            onClick={() => { setShowCreateMap(true); setEditingMapTitle(''); }}
            className="p-1.5 rounded-lg hover:bg-secondary text-muted-foreground hover:text-primary transition-colors"
            title="새 마인드맵"
            aria-label="새 마인드맵"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        {showCreateMap && (
          <form onSubmit={handleCreateMap} className="px-3 py-2.5 border-b border-border bg-muted/20 space-y-1.5">
            <input
              type="text"
              value={editingMapTitle}
              onChange={(e) => setEditingMapTitle(e.target.value)}
              placeholder="제목을 입력하고 Enter"
              className="w-full px-2.5 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/40"
              autoFocus
            />
            <input
              type="url"
              value={editingMapConfluence}
              onChange={(e) => setEditingMapConfluence(e.target.value)}
              placeholder="Confluence URL (선택)"
              className="w-full px-2.5 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <div className="flex gap-1.5">
              <button type="submit" className="flex-1 py-1.5 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors">생성</button>
              <button type="button" onClick={() => { setShowCreateMap(false); setEditingMapConfluence(''); }} className="flex-1 py-1.5 text-sm bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors">취소</button>
            </div>
          </form>
        )}

        <div className="flex-1 overflow-y-auto py-2 space-y-0.5">
          {mapsLoading ? (
            <div className="space-y-2 px-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-12 rounded-xl bg-secondary/40 animate-pulse" />
              ))}
            </div>
          ) : maps.length === 0 ? (
            <div className="text-center py-10 px-4">
              <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-secondary flex items-center justify-center">
                <MapIcon className="w-6 h-6 text-muted-foreground/50" />
              </div>
              <p className="text-sm text-muted-foreground mb-3">마인드맵이 없습니다.</p>
              <button
                onClick={() => setShowCreateMap(true)}
                className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> 새로 만들기
              </button>
            </div>
          ) : (
            maps.map((m) => {
              const isActive = selectedMapId === m.id;
              return (
                <div
                  key={m.id}
                  onClick={() => { setSelectedMapId(m.id); setSelectedNodeId(null); }}
                  className={`group mx-2 px-3 py-2.5 rounded-xl cursor-pointer transition-colors flex items-center justify-between gap-2 ${
                    isActive
                      ? 'bg-primary/10 text-primary ring-1 ring-primary/20'
                      : 'hover:bg-secondary text-foreground'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1">
                      <p className={`text-sm truncate ${isActive ? 'font-semibold' : 'font-medium'}`}>{m.title}</p>
                      {m.confluenceUrl && (
                        <a
                          href={m.confluenceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="p-0.5 rounded text-primary hover:bg-primary/10"
                          title={`Confluence: ${m.confluenceUrl}`}
                        >
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground tabular-nums">{m.nodeCount}개 노드</p>
                  </div>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const next = prompt('Confluence URL (비우면 제거)', m.confluenceUrl ?? '');
                        if (next === null) return;
                        updateMap.mutate({ id: m.id, data: { confluenceUrl: next.trim() || undefined } });
                      }}
                      className="p-1 hover:bg-secondary rounded-md text-muted-foreground hover:text-primary"
                      title="Confluence 링크 변경"
                      aria-label="Confluence 링크 변경"
                    >
                      <Link2 className="w-3 h-3" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); updateMap.mutate({ id: m.id, data: { title: prompt('새 제목', m.title) ?? m.title } }); }}
                      className="p-1 hover:bg-secondary rounded-md text-muted-foreground hover:text-primary"
                      title="이름 변경"
                      aria-label="이름 변경"
                    >
                      <Edit2 className="w-3 h-3" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteMap(m.id); }}
                      className="p-1 hover:bg-red-500/10 rounded-md text-muted-foreground hover:text-red-500"
                      title="삭제"
                      aria-label="삭제"
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
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">마인드맵</span>
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
              <span className="text-sm font-semibold">{currentMap.title}</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-secondary text-muted-foreground tabular-nums">
                {currentMap.nodes.length} 노드
              </span>
              <div className="flex-1" />
              <button
                onClick={handleAddRootNode}
                className="px-3 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors flex items-center gap-1.5 mac-shadow"
              >
                <Plus className="w-3.5 h-3.5" /> 루트 노드
              </button>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">마인드맵을 선택하거나 새로 만드세요</span>
          )}
        </div>

        <div
          className="flex-1 relative overflow-hidden bg-background"
          style={{
            backgroundImage:
              'radial-gradient(circle, hsl(var(--border)) 1px, transparent 1px)',
            backgroundSize: '24px 24px',
          }}
        >
          {currentMap ? (
            currentMap.nodes.length === 0 ? (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-center px-6 py-8 rounded-2xl bg-card/80 backdrop-blur-md border border-border mac-shadow max-w-sm">
                  <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-primary/10 flex items-center justify-center">
                    <MapIcon className="w-7 h-7 text-primary" />
                  </div>
                  <p className="text-sm font-semibold mb-1">노드가 없습니다</p>
                  <p className="text-sm text-muted-foreground mb-4">루트 노드부터 시작해 자식 노드를 자유롭게 추가하세요.</p>
                  <button
                    onClick={handleAddRootNode}
                    className="px-4 py-2 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors inline-flex items-center gap-1.5"
                  >
                    <Plus className="w-4 h-4" /> 첫 번째 노드 추가
                  </button>
                </div>
              </div>
            ) : (
              <MindMapCanvas
                mindmap={currentMap}
                selectedNodeId={selectedNodeId}
                onNodeSelect={setSelectedNodeId}
                onAddChild={handleAddChild}
                onAddSibling={handleAddSibling}
                onEditNode={handleEditNode}
                onDeleteNode={handleDeleteNode}
              />
            )
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center">
                <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-secondary flex items-center justify-center">
                  <MapIcon className="w-7 h-7 text-muted-foreground/50" />
                </div>
                <p className="text-sm text-muted-foreground">좌측에서 마인드맵을 선택하세요</p>
              </div>
            </div>
          )}
        </div>
      </main>

      {nodeEditorState && (
        <NodeEditor
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
          onSave={handleNodeSave}
          onClose={() => setNodeEditorState(null)}
        />
      )}
    </div>
  );
}
