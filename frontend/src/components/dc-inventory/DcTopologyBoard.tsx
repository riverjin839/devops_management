// DC 인벤토리 ▸ 토폴로지 — 워크플로 보드처럼 끌어서 배치하고 우클릭으로 고치는 캔버스.
//   위에서 아래로: FA 코어 → super-spine → spine → leaf(ToR) → 랙(ToR + 실제 서버 배치 박스)
//   · 노드를 끌면 위치가 저장된다(모든 사용자가 같은 배치를 본다)
//   · 노드 아래 점(연결 손잡이)을 다른 패브릭 장비로 끌면 연결이 생긴다(위·아래 계층은 서버가 판정)
//   · 빈 곳·노드·랙·장비 줄·연결선을 우클릭하면 추가·수정·삭제 메뉴
// 좌표가 계속 바뀌므로 전부 SVG 속성으로 그린다(인라인 스타일 없이). 색은 `--chart-*` 토큰.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import { ConfirmDialog, EmptyState, ErrorState, LoadingState, useToast } from '@/components/common';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useClusters } from '@/hooks/useCluster';
import { dcKeys, useDcTopology } from '@/hooks/useDcInventory';
import { formatApiError } from '@/lib/utils';
import { dcApi } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { DcDeviceRole, DcTopoEdge, DcTopoFabricNode, DcTopoRack, DcTopoRackDevice } from '@/types';
import { DcEntityDialog, type EntityDraft } from './DcEntityDialog';
import { DcZonePanel } from './DcZonePanel';
import { BTN, ROLE_LABEL, STATUS_LABEL } from './shared';
import {
  NODE_H, NODE_W, RACK_HEAD, RACK_MAX_ROWS, RACK_W, ROLE_ABBR, ROLE_FILL, ROW_H, TIER_LABEL,
  computeLayout, linkPath, type Point,
} from './topologyLayout';

interface MenuItem { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string }
interface MenuState { x: number; y: number; title: string; items: MenuItem[] }
interface DragState { id: string; kind: 'device' | 'rack'; startX: number; startY: number; origin: Point; moved: boolean }
interface PendingDelete { resource: string; id: string; label: string; note?: string }

const ZOOMS = [0.5, 0.65, 0.8, 1, 1.25];

export function DcTopologyBoard() {
  const toast = useToast();
  const qc = useQueryClient();
  const { canOperate, hint } = useCanOperate();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const query = useDcTopology();
  const clustersQuery = useClusters();
  const clusters = useMemo(
    () => (clustersQuery.data ?? []).map((c) => ({ id: c.id, name: c.name })),
    [clustersQuery.data],
  );
  const topo = query.data;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [zoom, setZoom] = useState(0.8);
  const [override, setOverride] = useState<Record<string, Point>>({});
  const [drag, setDrag] = useState<DragState | null>(null);
  const [linking, setLinking] = useState<{ fromId: string; cur: Point } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [zoneFilter, setZoneFilter] = useState<string | null>(null);
  const [draft, setDraft] = useState<EntityDraft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [busy, setBusy] = useState(false);

  const layout = useMemo(() => (topo ? computeLayout(topo, override) : null), [topo, override]);
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: dcKeys.all }), [qc]);

  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey); };
  }, [menu]);

  /** 쓰기 1건 실행 — 실패 사유는 서버 문구 그대로 보여준다. */
  const act = useCallback(async (fn: () => Promise<unknown>, done: string, failed: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      await refresh();
    } catch (e) {
      toast.error(failed, formatApiError(e));
    } finally {
      setBusy(false);
    }
  }, [refresh, toast]);

  const toCanvas = useCallback((clientX: number, clientY: number): Point => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
  }, [zoom]);

  const startDrag = (e: ReactPointerEvent, id: string, kind: 'device' | 'rack', origin: Point) => {
    if (e.button !== 0 || !canOperate) return;
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    setSelected(id);
    setDrag({ id, kind, startX: e.clientX, startY: e.clientY, origin, moved: false });
  };

  const startLink = (e: ReactPointerEvent, id: string) => {
    if (e.button !== 0 || !canOperate) return;
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    setLinking({ fromId: id, cur: toCanvas(e.clientX, e.clientY) });
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (drag) {
      const dx = (e.clientX - drag.startX) / zoom;
      const dy = (e.clientY - drag.startY) / zoom;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!drag.moved) setDrag({ ...drag, moved: true });
      setOverride((prev) => ({
        ...prev,
        [drag.id]: { x: Math.max(0, Math.round(drag.origin.x + dx)), y: Math.max(0, Math.round(drag.origin.y + dy)) },
      }));
    } else if (linking) {
      setLinking({ ...linking, cur: toCanvas(e.clientX, e.clientY) });
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    svgRef.current?.releasePointerCapture(e.pointerId);
    if (drag) {
      const pos = override[drag.id];
      if (drag.moved && pos) {
        dcApi.savePositions([{ objectType: drag.kind, objectId: drag.id, x: pos.x, y: pos.y }])
          .catch((err) => toast.error('위치를 저장하지 못했습니다', formatApiError(err)));
      }
      setDrag(null);
    } else if (linking) {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-fabric-id]');
      const targetId = el?.getAttribute('data-fabric-id');
      const from = topo?.fabric.find((n) => n.id === linking.fromId);
      const to = topo?.fabric.find((n) => n.id === targetId);
      setLinking(null);
      if (from && to && from.id !== to.id) {
        // 어느 쪽에서 끌었든 계층이 위인 장비가 상위가 된다. 같은 계층이면 서버가 사유와 함께 거부한다.
        const [upper, lower] = from.tier <= to.tier ? [from, to] : [to, from];
        void act(
          () => dcApi.create('links', { upperDeviceId: upper.id, lowerDeviceId: lower.id }),
          `${upper.hostname} → ${lower.hostname} 연결`, '연결하지 못했습니다',
        );
      }
    }
  };

  const openMenu = (e: ReactMouseEvent | { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void },
    title: string, items: MenuItem[]) => {
    e.preventDefault?.();
    e.stopPropagation?.();
    setMenu({ x: e.clientX, y: e.clientY, title, items });
  };

  const guard = (item: MenuItem): MenuItem => (canOperate ? item : { ...item, disabled: true, hint });

  const resetLayout = () => act(async () => { await dcApi.resetPositions(); setOverride({}); }, '자동 배치로 되돌렸습니다', '되돌리지 못했습니다');

  const canvasMenu = (e: ReactMouseEvent) => openMenu(e, '추가', [
    ...(['fa-core', 'super-spine', 'spine', 'leaf'] as DcDeviceRole[]).map((role) => guard({
      label: `${ROLE_LABEL[role]} 추가`, onSelect: () => setDraft({ kind: 'device', role }),
    })),
    guard({ label: '랙 추가', onSelect: () => setDraft({ kind: 'rack', zoneId: zoneFilter ?? undefined }) }),
    guard({ label: '구간 추가', onSelect: () => setDraft({ kind: 'zone' }) }),
    guard({ label: '자동 배치로 되돌리기', onSelect: () => void resetLayout() }),
  ]);

  const deviceDraft = (d: { id: string; hostname: string; role: DcDeviceRole; status: string; clusterId: string | null },
    rackId: string | null, positionU: number | null): EntityDraft => ({
    kind: 'device', id: d.id, hostname: d.hostname, role: d.role, status: d.status, rackId, positionU, clusterId: d.clusterId,
  });

  const deviceItems = (d: { id: string; hostname: string; status: string }, edit: EntityDraft): MenuItem[] => [
    guard({ label: '수정', onSelect: () => setDraft(edit) }),
    ...(d.status !== 'decommission' ? [guard({
      label: '폐기 처리', onSelect: () => void act(
        () => dcApi.update('devices', d.id, { status: 'decommission' }), `${d.hostname} 폐기 처리`, '바꾸지 못했습니다'),
    })] : []),
    {
      label: '삭제', danger: true, disabled: !isAdmin, hint: isAdmin ? undefined : '장비 삭제는 admin 만 할 수 있습니다 (폐기 처리를 쓰세요)',
      onSelect: () => setPendingDelete({ resource: 'devices', id: d.id, label: d.hostname, note: '연결된 케이블이 있으면 삭제되지 않습니다.' }),
    },
  ];

  /** 패브릭 노드의 수정 초안 — 랙 안 위치(U)는 랙 박스 데이터에서 찾아 그대로 유지한다. */
  const fabricDraft = (n: DcTopoFabricNode): EntityDraft => {
    const rackDev = topo?.racks.find((r) => r.id === n.rackId)?.devices.find((d) => d.id === n.id);
    return deviceDraft(n, n.rackId, rackDev?.positionU ?? null);
  };
  const fabricMenu = (e: ReactMouseEvent | { clientX: number; clientY: number }, n: DcTopoFabricNode) =>
    openMenu(e, n.hostname, deviceItems(n, fabricDraft(n)));

  const rackMenu = (e: ReactMouseEvent | { clientX: number; clientY: number }, r: DcTopoRack) => openMenu(e, r.name, [
    guard({ label: '서버 추가', onSelect: () => setDraft({ kind: 'device', role: 'server', rackId: r.id }) }),
    guard({ label: 'ToR(leaf) 추가', onSelect: () => setDraft({ kind: 'device', role: 'leaf', rackId: r.id, positionU: r.uHeight }) }),
    guard({
      label: '랙 수정', onSelect: () => setDraft({
        kind: 'rack', id: r.id, zoneId: r.zoneId ?? undefined, rowName: r.rowName ?? 'A', name: r.name, rackNo: r.rackNo, uHeight: r.uHeight,
      }),
    }),
    guard({
      label: '랙 삭제', danger: true,
      onSelect: () => setPendingDelete({ resource: 'racks', id: r.id, label: r.name, note: '장비가 남아 있는 랙은 삭제되지 않습니다.' }),
    }),
  ]);

  const rackDeviceMenu = (e: ReactMouseEvent, r: DcTopoRack, d: DcTopoRackDevice) =>
    openMenu(e, d.hostname, deviceItems(d, deviceDraft(d, r.id, d.positionU)));

  const edgeMenu = (e: ReactMouseEvent, edge: DcTopoEdge, label: string) => openMenu(e, label, [
    edge.linkId
      ? guard({
        label: '연결 삭제', danger: true,
        onSelect: () => void act(() => dcApi.remove('links', edge.linkId!), '연결을 지웠습니다', '지우지 못했습니다'),
      })
      : { label: '케이블에서 파생된 연결 — 케이블을 지워야 사라집니다', disabled: true, onSelect: () => undefined },
  ]);

  const onNodeKey = (e: ReactKeyboardEvent, open: (at: { clientX: number; clientY: number }) => void) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'ContextMenu') return;
    e.preventDefault();
    const rect = (e.currentTarget as Element).getBoundingClientRect();
    open({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 });
  };

  if (query.isLoading) return <LoadingState label="토폴로지를 읽는 중" />;
  if (query.isError || !topo || !layout) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const empty = topo.fabric.length === 0 && topo.racks.length === 0;
  const dim = (zoneId: string | null) => (zoneFilter && zoneId !== zoneFilter ? 'opacity-30' : '');
  const fabricById = new Map(topo.fabric.map((n) => [n.id, n]));

  return (
    <div className="flex flex-wrap gap-4 items-start">
      <DcZonePanel
        topology={topo}
        clusters={clusters}
        canOperate={canOperate}
        hint={hint}
        zoneFilter={zoneFilter}
        onZoneFilter={setZoneFilter}
        selected={selected}
        onEdit={setDraft}
        onDelete={setPendingDelete}
        act={act}
      />

      <section aria-label="패브릭 토폴로지 캔버스" className="flex-1 min-w-[320px] rounded-md border border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border">
          <span className="text-sm font-semibold">패브릭 · 랙</span>
          <span className="text-xs text-muted-foreground">
            노드를 끌어 배치 · 아래 점을 끌어 연결 · 우클릭으로 추가·수정·삭제
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" className={BTN} title="축소" aria-label="축소"
              onClick={() => setZoom((z) => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)])} disabled={zoom === ZOOMS[0]}>
              <Minus className="w-4 h-4" aria-hidden />
            </button>
            <span className="text-xs tabular-nums w-10 text-center">{Math.round(zoom * 100)}%</span>
            <button type="button" className={BTN} title="확대" aria-label="확대"
              onClick={() => setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)])} disabled={zoom === ZOOMS[ZOOMS.length - 1]}>
              <Plus className="w-4 h-4" aria-hidden />
            </button>
            <button type="button" className={BTN} disabled={!canOperate || busy} title={hint ?? '저장된 위치를 지우고 계층별로 다시 놓는다'}
              onClick={() => void resetLayout()}>
              <RotateCcw className="w-4 h-4" aria-hidden /> 자동 배치
            </button>
          </div>
        </div>

        {empty ? (
          <EmptyState title="아직 그릴 장비가 없습니다"
            description="왼쪽에서 DC 와 구간을 만든 뒤, 캔버스를 우클릭해 FA 코어·spine·leaf·랙을 추가하세요. Excel 일괄 등록으로 한 번에 올릴 수도 있습니다."
            action={canOperate ? { label: 'FA 코어 추가', onClick: () => setDraft({ kind: 'device', role: 'fa-core' }) } : undefined} />
        ) : (
          <div className="overflow-auto max-h-[72vh]">
            <svg
              ref={svgRef}
              role="application"
              aria-label="DC 패브릭 토폴로지 — 노드에서 Enter 로 메뉴"
              width={layout.width * zoom}
              height={layout.height * zoom}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              className={`block select-none touch-none ${drag?.moved ? 'cursor-grabbing' : ''}`}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onContextMenu={canvasMenu}
              onPointerDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}
            >
              {TIER_LABEL.map((label, i) => (
                <text key={label} x={8} y={[40, 170, 300, 430][i] - 10} className="fill-muted-foreground text-xs">{label}</text>
              ))}
              <text x={8} y={570} className="fill-muted-foreground text-xs">랙 (ToR + 서버)</text>

              {/* leaf → 자기 랙 */}
              {topo.fabric.filter((n) => n.rackId && layout.racks[n.rackId]).map((n) => {
                const from = layout.fabric[n.id];
                const to = layout.racks[n.rackId!];
                return (
                  <path key={`lr-${n.id}`} d={linkPath({ x: from.x + NODE_W / 2, y: from.y + NODE_H }, { x: to.x + RACK_W / 2, y: to.y })}
                    className={`fill-none stroke-border ${dim(n.zoneId)}`} strokeWidth={1.5} />
                );
              })}

              {/* 패브릭 연결 */}
              {topo.edges.map((edge) => {
                const up = layout.fabric[edge.upperId];
                const low = layout.fabric[edge.lowerId];
                if (!up || !low) return null;
                const from = { x: up.x + NODE_W / 2, y: up.y + NODE_H };
                const to = { x: low.x + NODE_W / 2, y: low.y };
                const label = `${fabricById.get(edge.upperId)?.hostname} → ${fabricById.get(edge.lowerId)?.hostname}`;
                return (
                  <g key={`${edge.upperId}-${edge.lowerId}`} onContextMenu={(e) => edgeMenu(e, edge, label)}>
                    <title>{label}{edge.cableCount ? ` · 케이블 ${edge.cableCount}개` : ' · 논리 연결(케이블 미등록)'}{edge.note ? ` · ${edge.note}` : ''}</title>
                    <path d={linkPath(from, to)} className="fill-none stroke-transparent" strokeWidth={12} />
                    <path d={linkPath(from, to)} className="fill-none stroke-foreground/60" strokeWidth={edge.cableCount ? 2 : 1.5}
                      strokeDasharray={edge.cableCount ? undefined : '5 4'} />
                    {edge.cableCount > 0 && (
                      <text x={(from.x + to.x) / 2 + 4} y={(from.y + to.y) / 2} className="fill-muted-foreground text-xs">×{edge.cableCount}</text>
                    )}
                  </g>
                );
              })}

              {/* 랙 박스 */}
              {topo.racks.map((r) => {
                const p = layout.racks[r.id];
                const shown = r.devices.slice(0, RACK_MAX_ROWS);
                const rest = r.devices.length - shown.length;
                return (
                  <g key={r.id} transform={`translate(${p.x} ${p.y})`} className={dim(r.zoneId)} data-rack-id={r.id}>
                    <rect width={RACK_W} height={layout.rackHeight[r.id]} rx={6}
                      className={`fill-background ${selected === r.id ? 'stroke-primary' : 'stroke-border'}`} strokeWidth={selected === r.id ? 2 : 1.25} />
                    <g tabIndex={0} role="button" aria-label={`랙 ${r.name} — ${r.devices.length}대, ${r.usedU}/${r.uHeight}U`}
                      className={canOperate ? 'cursor-grab focus:outline-none' : 'focus:outline-none'}
                      onPointerDown={(e) => startDrag(e, r.id, 'rack', p)}
                      onClick={(e) => { e.stopPropagation(); setSelected(r.id); }}
                      onContextMenu={(e) => rackMenu(e, r)}
                      onKeyDown={(e) => onNodeKey(e, (at) => rackMenu(at, r))}>
                      <rect width={RACK_W} height={RACK_HEAD} rx={6} className="fill-secondary" />
                      <text x={10} y={19} className="fill-foreground text-xs font-semibold">{r.name}</text>
                      <text x={RACK_W - 10} y={19} textAnchor="end" className="fill-muted-foreground text-xs">{r.usedU}/{r.uHeight}U</text>
                    </g>
                    {r.devices.length === 0 && (
                      <text x={RACK_W / 2} y={RACK_HEAD + 14} textAnchor="middle" className="fill-muted-foreground text-xs">비어 있음 · 우클릭으로 추가</text>
                    )}
                    {shown.map((d, i) => (
                      <g key={d.id} transform={`translate(6 ${RACK_HEAD + 4 + i * ROW_H})`}
                        onContextMenu={(e) => rackDeviceMenu(e, r, d)} onDoubleClick={() => canOperate && setDraft(deviceDraft(d, r.id, d.positionU))}>
                        <title>{d.hostname} · {ROLE_LABEL[d.role]}{d.uRange ? ` · ${d.uRange}` : ' · U 미정'}{STATUS_LABEL[d.status] ? ` · ${STATUS_LABEL[d.status]}` : ''}</title>
                        <rect width={RACK_W - 12} height={ROW_H - 2} rx={3} className={ROLE_FILL[d.role]} strokeWidth={1}
                          strokeDasharray={d.status === 'planned' ? '3 2' : undefined} />
                        <text x={5} y={11} className="fill-foreground text-xs font-bold">{ROLE_ABBR[d.role]}</text>
                        <text x={26} y={12} className="fill-foreground text-xs">{d.hostname.length > 17 ? `${d.hostname.slice(0, 16)}…` : d.hostname}</text>
                        <text x={RACK_W - 18} y={11} textAnchor="end" className="fill-muted-foreground text-xs">{d.positionU !== null ? `U${d.positionU}` : '—'}</text>
                      </g>
                    ))}
                    {rest > 0 && (
                      <text x={10} y={RACK_HEAD + 4 + shown.length * ROW_H + 11} className="fill-muted-foreground text-xs">+{rest}대 더 있음</text>
                    )}
                  </g>
                );
              })}

              {/* 패브릭 장비 */}
              {topo.fabric.map((n) => {
                const p = layout.fabric[n.id];
                const off = n.status !== 'active';
                return (
                  <g key={n.id} transform={`translate(${p.x} ${p.y})`} className={dim(n.zoneId)} data-fabric-id={n.id}>
                    <g tabIndex={0} role="button"
                      aria-label={`${ROLE_LABEL[n.role]} ${n.hostname}${n.rackName ? ` — ${n.rackName}` : ''}`}
                      className={canOperate ? 'cursor-grab focus:outline-none' : 'focus:outline-none'}
                      onPointerDown={(e) => startDrag(e, n.id, 'device', p)}
                      onClick={(e) => { e.stopPropagation(); setSelected(n.id); }}
                      onDoubleClick={() => canOperate && setDraft(fabricDraft(n))}
                      onContextMenu={(e) => fabricMenu(e, n)}
                      onKeyDown={(e) => onNodeKey(e, (at) => fabricMenu(at, n))}>
                      <title>{n.hostname} · {ROLE_LABEL[n.role]}{n.rackName ? ` · ${n.rackName}` : ''}{off ? ` · ${STATUS_LABEL[n.status]}` : ''}</title>
                      <rect width={NODE_W} height={NODE_H} rx={8} className={ROLE_FILL[n.role]}
                        strokeWidth={selected === n.id ? 2.5 : 1.5} strokeDasharray={n.status === 'planned' ? '5 3' : undefined} />
                      <text x={10} y={18} className="fill-foreground text-xs font-bold">{ROLE_ABBR[n.role]}</text>
                      <text x={30} y={18} className="fill-foreground text-xs font-semibold">{n.hostname.length > 15 ? `${n.hostname.slice(0, 14)}…` : n.hostname}</text>
                      <text x={10} y={34} className="fill-muted-foreground text-xs">
                        {ROLE_LABEL[n.role]}{n.rackName ? ` · ${n.rackName}` : ''}{off ? ` · ${STATUS_LABEL[n.status]}` : ''}
                      </text>
                    </g>
                    {canOperate && n.tier < 3 && (
                      <circle cx={NODE_W / 2} cy={NODE_H} r={6} className="fill-card stroke-foreground cursor-crosshair" strokeWidth={1.5}
                        onPointerDown={(e) => startLink(e, n.id)}>
                        <title>끌어서 아래 계층 장비에 연결</title>
                      </circle>
                    )}
                    {canOperate && n.tier > 0 && (
                      <circle cx={NODE_W / 2} cy={0} r={5} className="fill-card stroke-muted-foreground cursor-crosshair" strokeWidth={1.25}
                        onPointerDown={(e) => startLink(e, n.id)}>
                        <title>끌어서 위 계층 장비에 연결</title>
                      </circle>
                    )}
                  </g>
                );
              })}

              {linking && layout.fabric[linking.fromId] && (
                <path d={linkPath(
                  { x: layout.fabric[linking.fromId].x + NODE_W / 2, y: layout.fabric[linking.fromId].y + NODE_H / 2 }, linking.cur)}
                  className="fill-none stroke-primary pointer-events-none" strokeWidth={2} strokeDasharray="4 3" />
              )}
            </svg>
          </div>
        )}

        {topo.unracked.length > 0 && (
          <p className="px-3 py-2 border-t border-border text-xs text-muted-foreground">
            랙 미배정 장비 {topo.unracked.length}대 — {topo.unracked.slice(0, 8).map((d) => d.hostname).join(', ')}
            {topo.unracked.length > 8 ? ' …' : ''} (장비 탭에서 확인)
          </p>
        )}
      </section>

      {menu && (
        // 우클릭 위치에 띄우는 메뉴 — 좌표가 매번 달라 인라인 위치만 예외로 쓴다(워크플로 보드와 같은 방식).
        <div role="menu" tabIndex={-1} aria-label={`${menu.title} 메뉴`}
          className="fixed z-50 min-w-[200px] rounded-md border border-border bg-popover text-popover-foreground shadow-card py-1"
          style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 40 - menu.items.length * 34) }}
          onClick={(e) => e.stopPropagation()}>
          <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground border-b border-border truncate">{menu.title}</div>
          {menu.items.map((item) => (
            <button key={item.label} type="button" role="menuitem" disabled={item.disabled} title={item.hint}
              className={`w-full text-left text-sm px-3 py-1.5 hover:bg-secondary disabled:opacity-50 disabled:cursor-not-allowed ${item.danger ? 'text-status-critical' : ''}`}
              onClick={() => { setMenu(null); item.onSelect(); }}>
              {item.label}
              {item.disabled && item.hint && <span className="block text-xs text-muted-foreground">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}

      <DcEntityDialog draft={draft} topology={topo} clusters={clusters} onClose={() => setDraft(null)} onSaved={() => void refresh()} />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`${pendingDelete?.label ?? ''} 삭제`}
        description={pendingDelete?.note ?? '삭제하면 되돌릴 수 없습니다. 변경 이력에는 남습니다.'}
        confirmLabel="삭제"
        danger
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete;
          if (!target) return;
          setPendingDelete(null);
          void act(() => dcApi.remove(target.resource, target.id), `${target.label} 삭제`, '삭제하지 못했습니다');
        }}
      />
    </div>
  );
}
