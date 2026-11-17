// 토폴로지 캔버스 그리기 — 계층 띠 · 구간 상자 · 랙 카드 · leaf 칩 · 상위 장비 · 연결선 · 손잡이.
// 좌표는 전부 SVG 속성(인라인 스타일 없음), 색은 `--chart-*` 토큰. 이벤트 판단은 부모(DcTopologyBoard)가 한다.
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import type { DcTopoEdge, DcTopoFabricNode, DcTopoRack, DcTopology } from '@/types';
import { ROLE_LABEL, STATUS_LABEL } from '../shared';
import type { Selection } from '../DcTopologyInspector';
import {
  BAND_FILL, BANDS, NO_ZONE, RACK_MAX_ROWS, ROLE_ABBR, ROLE_FILL, ROW_H, leafTag, type Layout, type Rect,
} from '../topologyLayout';
import type { ShapeKind } from './Palette';
import { edgeKey } from './actions';


function curve(x1: number, y1: number, x2: number, y2: number): string {
  const my = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
}
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface CanvasHandlers {
  nodeDown: (e: PointerEvent, n: DcTopoFabricNode) => void;
  nodeClick: (e: MouseEvent, sel: Selection) => void;
  nodeDouble: (sel: Selection) => void;
  nodeKey: (e: KeyboardEvent, sel: Selection) => void;
  menu: (e: MouseEvent, sel: Selection | null) => void;
  handleDown: (e: PointerEvent, n: DcTopoFabricNode) => void;
  rackToggle: (id: string) => void;
}

interface Props {
  topo: DcTopology;
  layout: Layout;
  selection: Selection | null;
  expanded: Set<string>;
  canOperate: boolean;
  /** 연결 중일 때 출발 장비 — 이을 수 없는 장비는 흐리게. */
  linkFrom: DcTopoFabricNode | null;
  linkCursor: { x: number; y: number } | null;
  isValidTarget: (n: DcTopoFabricNode) => boolean;
  dragKind: ShapeKind | null;
  h: CanvasHandlers;
}

export function Canvas({ topo, layout, selection, expanded, canOperate, linkFrom, linkCursor, isValidTarget, dragKind, h }: Props) {
  const isSel = (kind: Selection['kind'], id: string) => selection?.kind === kind && selection.id === id;
  const fabricById = new Map(topo.fabric.map((n) => [n.id, n]));
  const rackTarget = dragKind === 'server' || dragKind === 'leaf';
  const zoneTarget = dragKind === 'rack';
  const W = layout.width;

  const nodeFocus = (sel: Selection, label: string) => ({
    tabIndex: 0,
    role: 'button' as const,
    'aria-label': label,
    onClick: (e: MouseEvent) => h.nodeClick(e, sel),
    onDoubleClick: () => h.nodeDouble(sel),
    onKeyDown: (e: KeyboardEvent) => h.nodeKey(e, sel),
    onContextMenu: (e: MouseEvent) => h.menu(e, sel),
  });

  const edgeLine = (edge: DcTopoEdge) => {
    const up = layout.nodes[edge.upperId];
    const low = layout.nodes[edge.lowerId];
    if (!up || !low) return null;
    const d = curve(up.x + up.w / 2, up.y + up.h, low.x + low.w / 2, low.y);
    const sel = isSel('edge', edgeKey(edge));
    const faded = linkFrom !== null;
    const label = `${fabricById.get(edge.upperId)?.hostname} → ${fabricById.get(edge.lowerId)?.hostname}`;
    return (
      <g key={edgeKey(edge)} className={faded ? 'opacity-30' : ''}>
        <title>{label}{edge.cableCount ? ` · 케이블 ${edge.cableCount}개` : ' · 화면에서 그은 연결(케이블 미등록)'}</title>
        <path d={d} className="fill-none stroke-transparent cursor-pointer" strokeWidth={12}
          onClick={(e) => h.nodeClick(e, { kind: 'edge', id: edgeKey(edge) })}
          onContextMenu={(e) => h.menu(e, { kind: 'edge', id: edgeKey(edge) })} />
        <path d={d} className={`fill-none pointer-events-none ${sel ? 'stroke-primary' : 'stroke-foreground/45'}`}
          strokeWidth={sel ? 2.5 : edge.cableCount ? 1.6 : 1.25} strokeDasharray={edge.cableCount ? undefined : '5 4'} />
      </g>
    );
  };

  const rackCard = (r: DcTopoRack, p: Rect) => {
    const open = expanded.has(r.id);
    const sel = isSel('rack', r.id);
    const tors = r.devices.filter((d) => d.role === 'leaf').length;
    const servers = r.devices.filter((d) => d.role === 'server').length;
    const ratio = r.uHeight > 0 ? Math.min(r.usedU / r.uHeight, 1) : 0;
    const rows = [...r.devices].sort((a, b) => (b.positionU ?? -1) - (a.positionU ?? -1));
    const shown = rows.slice(0, RACK_MAX_ROWS);
    return (
      <g key={r.id} transform={`translate(${p.x} ${p.y})`} data-rack-id={r.id}>
        <g {...nodeFocus({ kind: 'rack', id: r.id }, `랙 ${r.name} — ToR ${tors}대, 서버 ${servers}대, ${r.usedU}/${r.uHeight}U`)}
          className="cursor-pointer focus:outline-none">
          <rect width={p.w} height={p.h} rx={6}
            className={`fill-card ${sel ? 'stroke-primary' : rackTarget ? 'stroke-primary/60' : 'stroke-border'}`}
            strokeWidth={sel ? 2.5 : 1.25} strokeDasharray={rackTarget && !sel ? '4 3' : undefined} />
          <rect width={p.w} height={24} rx={6} className="fill-secondary" />
          <text x={8} y={16} className="fill-foreground text-xs font-semibold">{cut(r.name, open ? 22 : 8)}</text>
          {!open && (
            <>
              <text x={8} y={42} className="fill-muted-foreground text-xs">ToR {tors}</text>
              <text x={8} y={58} className="fill-muted-foreground text-xs">서버 {servers}</text>
              <rect x={8} y={68} width={p.w - 16} height={8} rx={3} className="fill-secondary" />
              <rect x={8} y={68} width={Math.max((p.w - 16) * ratio, ratio > 0 ? 2 : 0)} height={8} rx={3} className="fill-[hsl(var(--chart-1)/0.7)]" />
              <title>{r.name} · {r.usedU}/{r.uHeight}U 사용</title>
            </>
          )}
          {open && (
            <text x={p.w - 26} y={16} textAnchor="end" className="fill-muted-foreground text-xs">{r.usedU}/{r.uHeight}U</text>
          )}
        </g>
        {/* 펼침/접기 */}
        <g role="button" tabIndex={0} aria-label={open ? `${r.name} 접기` : `${r.name} 펼치기`} className="cursor-pointer focus:outline-none"
          onClick={(e) => { e.stopPropagation(); h.rackToggle(r.id); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); h.rackToggle(r.id); } }}>
          <title>{open ? '접기' : '펼쳐서 ToR · 서버 보기'}</title>
          <rect x={p.w - 22} y={3} width={18} height={18} rx={4} className="fill-transparent hover:fill-background" />
          <path d={open ? `M ${p.w - 18} 15 L ${p.w - 13} 9 L ${p.w - 8} 15` : `M ${p.w - 18} 9 L ${p.w - 13} 15 L ${p.w - 8} 9`}
            className="fill-none stroke-muted-foreground" strokeWidth={1.5} />
        </g>
        {open && shown.map((d, i) => {
          const dsel = isSel('device', d.id);
          return (
            <g key={d.id} transform={`translate(6 ${30 + i * ROW_H})`} data-node-id={d.id}
              {...nodeFocus({ kind: 'device', id: d.id }, `${ROLE_LABEL[d.role]} ${d.hostname}${d.positionU !== null ? ` U${d.positionU}` : ''}`)}
              className="cursor-pointer focus:outline-none">
              <title>{d.hostname} · {ROLE_LABEL[d.role]}{d.uRange ? ` · ${d.uRange}` : ' · U 미정'}{STATUS_LABEL[d.status] ? ` · ${STATUS_LABEL[d.status]}` : ''}</title>
              <rect width={p.w - 12} height={ROW_H - 3} rx={3} className={ROLE_FILL[d.role]} strokeWidth={dsel ? 2.5 : 1}
                strokeDasharray={d.status === 'planned' ? '3 2' : undefined} />
              <text x={5} y={13} className="fill-foreground text-xs font-bold">{ROLE_ABBR[d.role]}</text>
              <text x={28} y={13} className="fill-foreground text-xs">{cut(d.hostname, 18)}</text>
              <text x={p.w - 18} y={13} textAnchor="end" className="fill-muted-foreground text-xs">{d.positionU !== null ? `U${d.positionU}` : '—'}</text>
            </g>
          );
        })}
        {open && rows.length > shown.length && (
          <text x={10} y={30 + shown.length * ROW_H + 13} className="fill-muted-foreground text-xs">+{rows.length - shown.length}대 더 있음</text>
        )}
        {open && rows.length === 0 && (
          <text x={10} y={44} className="fill-muted-foreground text-xs">비어 있음 — 서버를 끌어다 놓으세요</text>
        )}
      </g>
    );
  };

  const fabricNode = (n: DcTopoFabricNode) => {
    const p = layout.nodes[n.id];
    if (!p) return null;
    const sel = isSel('device', n.id);
    const chip = n.tier === 3 && p.w < 60;
    const valid = linkFrom ? n.id === linkFrom.id || isValidTarget(n) : true;
    const off = STATUS_LABEL[n.status];
    const siblings = chip ? topo.fabric.filter((f) => f.tier === 3 && f.rackId === n.rackId) : [];
    return (
      <g key={n.id} transform={`translate(${p.x} ${p.y})`} data-node-id={n.id} className={valid ? '' : 'opacity-25'}>
        <g {...nodeFocus({ kind: 'device', id: n.id }, `${ROLE_LABEL[n.role]} ${n.hostname}${n.rackName ? ` — ${n.rackName}` : ''}`)}
          className={`${canOperate && n.tier < 3 ? 'cursor-grab' : 'cursor-pointer'} focus:outline-none`}
          onPointerDown={(e) => h.nodeDown(e, n)}>
          <title>{n.hostname} · {ROLE_LABEL[n.role]}{n.rackName ? ` · ${n.rackName}` : ''}{off ? ` · ${off}` : ''}</title>
          <rect width={p.w} height={p.h} rx={chip ? 5 : 8} className={ROLE_FILL[n.role]}
            strokeWidth={sel ? 3 : linkFrom && valid && n.id !== linkFrom.id ? 2.5 : 1.5}
            strokeDasharray={n.status === 'planned' ? '5 3' : undefined} />
          {linkFrom && valid && n.id !== linkFrom.id && (
            <rect x={-4} y={-4} width={p.w + 8} height={p.h + 8} rx={10} className="fill-none stroke-primary" strokeWidth={1.5} strokeDasharray="4 3" />
          )}
          {chip ? (
            <text x={p.w / 2} y={p.h / 2 + 4} textAnchor="middle" className="fill-foreground text-xs font-bold">
              {leafTag(n.hostname, siblings.findIndex((f) => f.id === n.id))}
            </text>
          ) : (
            <>
              <text x={8} y={17} className="fill-foreground text-xs font-bold">{ROLE_ABBR[n.role]}</text>
              <text x={28} y={17} className="fill-foreground text-xs font-semibold">{cut(n.hostname, 14)}</text>
              <text x={8} y={33} className="fill-muted-foreground text-xs">{off || ROLE_LABEL[n.role]}</text>
            </>
          )}
        </g>
        {sel && canOperate && !linkFrom && (
          <>
            {n.tier < 3 && (
              <circle cx={p.w / 2} cy={p.h + 9} r={7} className="fill-primary stroke-card cursor-crosshair" strokeWidth={2}
                onPointerDown={(e) => h.handleDown(e, n)}>
                <title>끌어서 아래 계층 장비에 연결</title>
              </circle>
            )}
            {n.tier > 0 && (
              <circle cx={p.w / 2} cy={-9} r={7} className="fill-primary stroke-card cursor-crosshair" strokeWidth={2}
                onPointerDown={(e) => h.handleDown(e, n)}>
                <title>끌어서 위 계층 장비에 연결</title>
              </circle>
            )}
          </>
        )}
      </g>
    );
  };

  const fromRect = linkFrom ? layout.nodes[linkFrom.id] : null;
  const empty = topo.zones.length === 0 && topo.fabric.length === 0 && topo.racks.length === 0;

  return (
    <>
      {BANDS.map((b) => (
        <g key={b.tier}>
          <rect x={0} y={b.y} width={W} height={b.h} rx={6} className={BAND_FILL[b.tier]} />
          <text x={8} y={b.y + 15} className="fill-muted-foreground text-xs font-semibold">{b.label}</text>
        </g>
      ))}

      {layout.zones.map((z) => {
        const sel = z.zone ? isSel('zone', z.zone.id) : false;
        const title = z.zone ? `${z.zone.zoneNo !== null ? `${z.zone.zoneNo}구간 · ` : ''}${z.zone.name}` : '구간 미지정';
        let cx = 10 + title.length * 7 + 14;
        return (
          <g key={z.id} transform={`translate(${z.x} ${z.y})`} data-zone-id={z.zone ? z.zone.id : NO_ZONE}>
            <g {...(z.zone ? nodeFocus({ kind: 'zone', id: z.zone.id }, `구간 ${title} — 랙 ${z.racks.length}개`) : {})}
              className={z.zone ? 'cursor-pointer focus:outline-none' : ''}>
              <rect width={z.w} height={z.h} rx={8}
                className={`fill-background ${sel ? 'stroke-primary' : zoneTarget && z.zone ? 'stroke-primary/60' : 'stroke-border'}`}
                strokeWidth={sel ? 2.5 : 1.25} strokeDasharray={z.zone ? (zoneTarget && !sel ? '6 4' : undefined) : '4 4'} />
              <text x={10} y={21} className="fill-foreground text-sm font-semibold">{title}</text>
            </g>
            {z.zone?.clusters.map((c) => {
              const w = c.name.length * 7 + 16;
              const x = cx;
              cx += w + 6;
              if (x + w > z.w - 6) return null;
              return (
                <g key={c.linkId} transform={`translate(${x} 8)`}>
                  <title>K8s 클러스터 {c.name}</title>
                  <rect width={w} height={18} rx={9} className="fill-[hsl(var(--chart-6)/0.14)] stroke-[hsl(var(--chart-6))]" strokeWidth={1} />
                  <text x={w / 2} y={13} textAnchor="middle" className="fill-foreground text-xs">{c.name}</text>
                </g>
              );
            })}
            {z.racks.length === 0 && z.zone && (
              <text x={12} y={60} className="fill-muted-foreground text-xs">랙을 끌어다 놓으세요</text>
            )}
          </g>
        );
      })}

      {/* leaf 칩 → 자기 랙 */}
      {topo.fabric.filter((n) => n.tier === 3 && n.rackId && layout.racks[n.rackId] && layout.nodes[n.id]).map((n) => {
        const a = layout.nodes[n.id];
        const r = layout.racks[n.rackId!];
        return <path key={`lr-${n.id}`} d={`M ${a.x + a.w / 2} ${a.y + a.h} L ${a.x + a.w / 2} ${r.y}`}
          className="fill-none stroke-border pointer-events-none" strokeWidth={1.25} />;
      })}

      {topo.edges.map(edgeLine)}
      {topo.racks.map((r) => (layout.racks[r.id] ? rackCard(r, layout.racks[r.id]) : null))}
      {topo.fabric.map(fabricNode)}

      {fromRect && linkCursor && (
        <path d={curve(fromRect.x + fromRect.w / 2, fromRect.y + fromRect.h / 2, linkCursor.x, linkCursor.y)}
          className="fill-none stroke-primary pointer-events-none" strokeWidth={2} strokeDasharray="5 4" />
      )}

      {empty && (
        <text x={W / 2} y={BANDS[3].y + BANDS[3].h + 70} textAnchor="middle" className="fill-muted-foreground text-sm">
          왼쪽에서 「구간」을 이 아래로 끌어다 놓아 시작하세요 — 그다음 랙, FA 코어 · spine · leaf, 서버 순서로.
        </text>
      )}
    </>
  );
}
