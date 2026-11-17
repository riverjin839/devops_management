// DC 인벤토리 ▸ 토폴로지 — draw.io 처럼 도형을 끌어다 놓고, 손잡이를 끌어 잇고, 그 자리에서 이름을 고치는 편집기.
//   왼쪽 도형 팔레트 · 가운데 캔버스(계층 띠 → 구간 상자 → 랙) · 오른쪽 속성 패널.
//   · 팔레트에서 끌어다 놓으면 자동 이름으로 바로 만든다(랙은 구간 안, 서버·leaf 는 랙 위, 빈 U 자동)
//   · 장비를 누르면 파란 손잡이 — 끌어서 다른 계층 장비에 놓으면 연결(이을 수 없는 장비는 흐려진다)
//   · 연결 모드: 두 장비를 차례로 누르면 연결
//   · 빈 곳 끌기 = 화면 이동, 휠 = 확대/축소, 처음 열 때 화면 맞춤
//   · 더블클릭/Enter = 이름 고치기, Delete = 삭제, ←/→ = 상위 장비 좌우 이동, Esc = 해제, 우클릭 = 보조 메뉴
// 쓰기는 전부 공통 CRUD(`dcApi`)로 가고 제약 위반은 서버 사유를 그대로 보여준다. 색은 `--chart-*` 토큰.
import { useCallback, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Cable, ChevronsDownUp, ChevronsUpDown, Maximize, Minus, MousePointer2, Plus, RotateCcw } from 'lucide-react';
import { ConfirmDialog, ErrorState, LoadingState, useToast } from '@/components/common';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useClusters } from '@/hooks/useCluster';
import { dcKeys, useDcTopology } from '@/hooks/useDcInventory';
import { formatApiError } from '@/lib/utils';
import { dcApi } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { DcDeviceRole, DcTopoFabricNode, DcTopoRack } from '@/types';
import { DcEntityDialog, type EntityDraft } from './DcEntityDialog';
import { DcTopologyInspector, type DeviceInfo, type Selection } from './DcTopologyInspector';
import { BTN } from './shared';
import { BANDS, NODE_W, computeLayout, contains, freeU, nextName } from './topologyLayout';
import { Canvas, type CanvasHandlers } from './topology/Canvas';
import { Palette, SHAPE_MIME, type ShapeKind } from './topology/Palette';
import { edgeKey, ensureRackRow, slug } from './topology/actions';
import { useCanvasView } from './topology/useCanvasView';

interface MenuItem { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string }
interface MenuState { x: number; y: number; title: string; items: MenuItem[] }
interface PendingDelete { resource: string; id: string; label: string; note?: string }
interface Pt { x: number; y: number }

const TIER_PREFIX: Record<string, string> = { 'fa-core': 'fa-core-', 'super-spine': 'super-spine-', spine: 'spine-', leaf: 'leaf-' };
const TIER_OF: Record<string, number> = { 'fa-core': 0, 'super-spine': 1, spine: 2, leaf: 3 };

export function DcTopologyBoard() {
  const toast = useToast();
  const qc = useQueryClient();
  const { canOperate, hint } = useCanOperate();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const query = useDcTopology();
  const clustersQuery = useClusters();
  const clusters = useMemo(() => (clustersQuery.data ?? []).map((c) => ({ id: c.id, name: c.name })), [clustersQuery.data]);
  const topo = query.data;

  const [selection, setSelection] = useState<Selection | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [override, setOverride] = useState<Record<string, number>>({});
  const [connectMode, setConnectMode] = useState(false);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [linking, setLinking] = useState<{ fromId: string; cur: Pt } | null>(null);
  const [dragNode, setDragNode] = useState<{ id: string; sx: number; ox: number; moved: boolean } | null>(null);
  const [dragKind, setDragKind] = useState<ShapeKind | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [draft, setDraft] = useState<EntityDraft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [busy, setBusy] = useState(false);
  const suppressClick = useRef(false);

  const layout = useMemo(() => (topo ? computeLayout(topo, expanded, override) : null), [topo, expanded, override]);
  const cv = useCanvasView(layout?.width ?? 0, layout?.height ?? 0);
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: dcKeys.all }), [qc]);

  /** 쓰기 1건 — 실패 사유는 서버 문구 그대로. 성공하면 결과를 돌려준다. */
  const act = useCallback(async <T,>(fn: () => Promise<T>, done: string, failed: string): Promise<T | null> => {
    setBusy(true);
    try {
      const r = await fn();
      if (done) toast.success(done);
      await refresh();
      return r;
    } catch (e) {
      toast.error(failed, e instanceof Error && !('response' in e) ? e.message : formatApiError(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, [refresh, toast]);
  const actVoid = useCallback(async (fn: () => Promise<unknown>, done: string, failed: string) => { await act(fn, done, failed); }, [act]);

  // ── 조회 보조 ─────────────────────────────────────────────────────────────
  const fabricById = useMemo(() => new Map((topo?.fabric ?? []).map((n) => [n.id, n])), [topo]);
  const rackOfDevice = useMemo(() => {
    const m = new Map<string, DcTopoRack>();
    for (const r of topo?.racks ?? []) for (const d of r.devices) m.set(d.id, r);
    return m;
  }, [topo]);
  const allHostnames = useMemo(() => {
    if (!topo) return [];
    return [...topo.fabric.map((n) => n.hostname), ...topo.racks.flatMap((r) => r.devices.map((d) => d.hostname)),
      ...topo.unracked.map((d) => d.hostname)];
  }, [topo]);

  const deviceInfo = (id: string): DeviceInfo | null => {
    const n = fabricById.get(id);
    const rack = rackOfDevice.get(id);
    const rd = rack?.devices.find((d) => d.id === id);
    if (n) return { id, hostname: n.hostname, role: n.role, status: n.status, rackId: n.rackId, positionU: rd?.positionU ?? null, clusterId: n.clusterId };
    if (rd && rack) return { id, hostname: rd.hostname, role: rd.role, status: rd.status, rackId: rack.id, positionU: rd.positionU, clusterId: rd.clusterId };
    return null;
  };

  const isValidTarget = useCallback((from: DcTopoFabricNode, n: DcTopoFabricNode) => {
    if (n.id === from.id || n.tier === from.tier) return false;
    return !(topo?.edges ?? []).some((e) => (e.upperId === from.id && e.lowerId === n.id) || (e.upperId === n.id && e.lowerId === from.id));
  }, [topo]);

  const link = (aId: string, bId: string) => {
    const a = fabricById.get(aId);
    const b = fabricById.get(bId);
    if (!a || !b || a.id === b.id) return;
    if (a.tier === b.tier) { toast.error('연결할 수 없습니다', '같은 계층끼리는 연결하지 않습니다 — 위·아래 계층 장비를 고르세요.'); return; }
    const [upper, lower] = a.tier < b.tier ? [a, b] : [b, a];
    void actVoid(() => dcApi.create('links', { upperDeviceId: upper.id, lowerDeviceId: lower.id }),
      `${upper.hostname} → ${lower.hostname} 연결`, '연결하지 못했습니다');
  };

  const select = (sel: Selection | null, rename = false) => {
    setSelection(sel);
    if (rename) setFocusToken((t) => t + 1);
  };

  // ── 만들기 ────────────────────────────────────────────────────────────────
  const createDevice = async (role: DcDeviceRole, hostname: string, rackId: string | null, positionU: number | null, x?: number) => {
    const res = await act(async () => {
      const { data } = await dcApi.create<{ id: string }>('devices', { hostname, role, status: 'active', rackId, positionU });
      if (x !== undefined && TIER_OF[role] !== undefined && TIER_OF[role] < 3) {
        await dcApi.savePositions([{ objectType: 'device', objectId: data.id, x: Math.round(x), y: BANDS[TIER_OF[role]].y + 10 }]);
      }
      return data;
    }, `${hostname} 추가`, '추가하지 못했습니다');
    if (res) select({ kind: 'device', id: res.id }, true);
  };

  const rackFromSelection = (): DcTopoRack | null => {
    if (!topo || !selection) return null;
    if (selection.kind === 'rack') return topo.racks.find((r) => r.id === selection.id) ?? null;
    if (selection.kind === 'device') return rackOfDevice.get(selection.id) ?? null;
    return null;
  };

  const placeInRack = (kind: 'server' | 'leaf', rack: DcTopoRack) => {
    const u = freeU(rack, kind === 'leaf');
    if (u === null) { toast.error('놓을 자리가 없습니다', `${rack.name} 에 빈 U 가 없습니다.`); return; }
    const base = slug(rack.name);
    let name: string;
    if (kind === 'leaf') {
      const taken = new Set(allHostnames.map((h) => h.toLowerCase()));
      const letter = 'abcdefgh'.split('').find((c) => !taken.has(`leaf-${base}-${c}`)) ?? 'x';
      name = `leaf-${base}-${letter}`;
    } else {
      name = nextName(allHostnames, `${base}-sv`);
    }
    setExpanded((p) => new Set(p).add(rack.id));
    void createDevice(kind, name, rack.id, u);
  };

  const createRack = async (zoneId: string) => {
    if (!topo) return;
    const name = nextName(topo.racks.map((r) => r.name), 'R');
    const res = await act(async () => {
      const rowId = await ensureRackRow(zoneId, 'A');
      return (await dcApi.create<{ id: string }>('racks', { rowId, name, rackNo: Number(name.slice(1)), uHeight: 42 })).data;
    }, `랙 ${name} 추가`, '랙을 추가하지 못했습니다');
    if (res) select({ kind: 'rack', id: res.id }, true);
  };

  const createZone = async () => {
    if (!topo) return;
    const no = Math.max(0, ...topo.zones.map((z) => z.zoneNo ?? 0)) + 1;
    const res = await act(async () => {
      let siteId = topo.sites[0]?.id;
      if (!siteId) siteId = (await dcApi.create<{ id: string }>('sites', { name: nextName([], 'DC', 1) })).data.id;
      return (await dcApi.create<{ id: string }>('halls', { siteId, name: `구간 ${no}`, zoneNo: no })).data;
    }, `구간 ${no} 추가`, '구간을 추가하지 못했습니다');
    if (res) select({ kind: 'zone', id: res.id }, true);
  };

  /** 놓은 위치(캔버스 좌표, 없으면 기본 위치)에 도형을 만든다. */
  const addShape = (kind: ShapeKind, at?: Pt) => {
    if (!topo || !layout || !canOperate) return;
    const rackAt = at ? topo.racks.find((r) => layout.racks[r.id] && contains(layout.racks[r.id], at.x, at.y)) : undefined;
    const zoneAt = at ? layout.zones.find((z) => z.zone && contains(z, at.x, at.y))?.zone ?? null : null;
    if (kind === 'zone') { void createZone(); return; }
    if (kind === 'rack') {
      const sel = rackFromSelection();
      const zoneId = zoneAt?.id ?? (selection?.kind === 'zone' ? selection.id : sel?.zoneId) ?? (at ? null : topo.zones[0]?.id);
      if (topo.zones.length === 0) { toast.error('구간이 없습니다', '먼저 「구간」을 끌어다 놓으세요.'); return; }
      if (!zoneId) { toast.error('여기에는 놓을 수 없습니다', '랙은 구간 상자 안에 놓으세요.'); return; }
      void createRack(zoneId);
      return;
    }
    if (kind === 'server' || (kind === 'leaf' && (rackAt || !at))) {
      const rack = rackAt ?? (at ? null : rackFromSelection());
      if (!rack) {
        if (kind === 'leaf' && !at) { void createDevice('leaf', nextName(allHostnames, 'leaf-'), null, null); return; }
        toast.error('랙을 고르세요', at ? '서버는 랙 위에 놓으세요.' : '랙을 먼저 선택한 뒤 누르세요(또는 랙 위로 끌어다 놓기).');
        return;
      }
      placeInRack(kind, rack);
      return;
    }
    // FA 코어 · super-spine · spine (· 랙 밖에 놓은 leaf)
    const role = kind as DcDeviceRole;
    void createDevice(role, nextName(allHostnames, TIER_PREFIX[role]), null, null, at ? at.x - NODE_W / 2 : undefined);
  };

  const onDrop = (e: DragEvent) => {
    const kind = e.dataTransfer.getData(SHAPE_MIME) as ShapeKind;
    setDragKind(null);
    if (!kind) return;
    e.preventDefault();
    addShape(kind, cv.toCanvas(e.clientX, e.clientY));
  };

  // ── 삭제 ─────────────────────────────────────────────────────────────────
  const requestDelete = (sel: Selection | null) => {
    if (!sel || !topo || !canOperate) return;
    if (sel.kind === 'device') {
      const info = deviceInfo(sel.id);
      if (!info) return;
      if (!isAdmin) { toast.error('장비 삭제는 admin 만 할 수 있습니다', '상태를 decommission(폐기)으로 바꾸세요.'); return; }
      setPendingDelete({ resource: 'devices', id: sel.id, label: info.hostname, note: '연결된 케이블이 있으면 삭제되지 않습니다.' });
    } else if (sel.kind === 'rack') {
      const r = topo.racks.find((x) => x.id === sel.id);
      if (r) setPendingDelete({ resource: 'racks', id: r.id, label: `랙 ${r.name}`, note: '장비가 남아 있는 랙은 삭제되지 않습니다.' });
    } else if (sel.kind === 'zone') {
      const z = topo.zones.find((x) => x.id === sel.id);
      if (z) setPendingDelete({ resource: 'halls', id: z.id, label: z.name, note: '랙이 남아 있는 구간은 삭제되지 않습니다.' });
    } else {
      const edge = topo.edges.find((x) => edgeKey(x) === sel.id);
      if (!edge) return;
      if (!edge.linkId) { toast.error('케이블에서 파생된 연결입니다', '케이블을 지워야 사라집니다.'); return; }
      void actVoid(() => dcApi.remove('links', edge.linkId!), '연결을 지웠습니다', '지우지 못했습니다');
      setSelection(null);
    }
  };

  // ── 포인터 ────────────────────────────────────────────────────────────────
  const capture = (e: ReactPointerEvent) => cv.boxRef.current?.setPointerCapture(e.pointerId);

  const h: CanvasHandlers = {
    nodeDown: (e, n) => {
      if (e.button !== 0 || !canOperate || connectMode || n.tier >= 3 || !layout) return;
      e.stopPropagation();
      capture(e);
      setDragNode({ id: n.id, sx: e.clientX, ox: layout.nodes[n.id]?.x ?? 0, moved: false });
    },
    nodeClick: (e, sel) => {
      e.stopPropagation();
      if (suppressClick.current) { suppressClick.current = false; return; }
      if (connectMode && sel.kind === 'device' && fabricById.has(sel.id)) {
        if (!connectFrom) { setConnectFrom(sel.id); setSelection(sel); return; }
        link(connectFrom, sel.id);
        setConnectFrom(null);
        return;
      }
      select(sel);
    },
    nodeDouble: (sel) => { if (sel.kind !== 'edge') select(sel, true); },
    nodeKey: (e, sel) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); select(sel, true); }
      else if (e.key === ' ') { e.preventDefault(); select(sel); }
      else if (e.key === 'ContextMenu') {
        e.preventDefault();
        const r = (e.currentTarget as Element).getBoundingClientRect();
        openMenuFor({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }, sel);
      }
    },
    menu: (e, sel) => { e.preventDefault(); e.stopPropagation(); openMenuFor(e, sel); },
    handleDown: (e, n) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      capture(e);
      setLinking({ fromId: n.id, cur: cv.toCanvas(e.clientX, e.clientY) });
    },
    rackToggle: (id) => setExpanded((p) => { const s = new Set(p); if (s.has(id)) s.delete(id); else s.add(id); return s; }),
  };

  const onBoxDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as Element;
    if (t.closest('[data-node-id],[data-rack-id]') || (t.closest('[data-zone-id]') && t.tagName !== 'svg')) return;
    capture(e);
    cv.panStart(e);
    if (!connectMode) setSelection(null);
  };

  const onBoxMove = (e: ReactPointerEvent) => {
    if (cv.panMove(e)) return;
    if (dragNode) {
      const dx = (e.clientX - dragNode.sx) / cv.view.k;
      if (!dragNode.moved && Math.abs(dx) < 4) return;
      if (!dragNode.moved) setDragNode({ ...dragNode, moved: true });
      setOverride((p) => ({ ...p, [dragNode.id]: Math.max(4, Math.round(dragNode.ox + dx)) }));
    } else if (linking) {
      setLinking({ ...linking, cur: cv.toCanvas(e.clientX, e.clientY) });
    }
  };

  const savePos = (id: string, x: number) => {
    const n = fabricById.get(id);
    if (!n) return;
    dcApi.savePositions([{ objectType: 'device', objectId: id, x, y: BANDS[n.tier].y + 10 }])
      .catch((err) => toast.error('위치를 저장하지 못했습니다', formatApiError(err)));
  };

  const onBoxUp = (e: ReactPointerEvent) => {
    cv.boxRef.current?.releasePointerCapture?.(e.pointerId);
    cv.panEnd();
    if (dragNode) {
      if (dragNode.moved && override[dragNode.id] !== undefined) {
        suppressClick.current = true;
        setSelection({ kind: 'device', id: dragNode.id });
        savePos(dragNode.id, override[dragNode.id]);
      }
      setDragNode(null);
    } else if (linking) {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node-id]')?.getAttribute('data-node-id');
      const from = linking.fromId;
      setLinking(null);
      if (target && target !== from) {
        if (!fabricById.has(target)) toast.error('연결할 수 없습니다', '서버는 케이블로 leaf 에 연결합니다 — 패브릭 장비에 놓으세요.');
        else link(from, target);
      }
    }
  };

  const onBoxKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') { setSelection(null); setLinking(null); setConnectFrom(null); setConnectMode(false); setMenu(null); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); requestDelete(selection); return; }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && selection?.kind === 'device' && canOperate && layout) {
      const n = fabricById.get(selection.id);
      if (!n || n.tier >= 3) return;
      e.preventDefault();
      const x = Math.max(4, (layout.nodes[n.id]?.x ?? 0) + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 50 : 10));
      setOverride((p) => ({ ...p, [n.id]: x }));
      savePos(n.id, x);
    }
  };

  // ── 보조 메뉴(우클릭) ──────────────────────────────────────────────────────
  const guard = (item: MenuItem): MenuItem => (canOperate ? item : { ...item, disabled: true, hint });
  const openMenuFor = (at: { clientX: number; clientY: number }, sel: Selection | null) => {
    if (!topo) return;
    const items: MenuItem[] = [];
    let title = '추가';
    if (!sel) {
      const p = cv.toCanvas(at.clientX, at.clientY);
      (['fa-core', 'super-spine', 'spine', 'zone'] as ShapeKind[]).forEach((k) =>
        items.push(guard({ label: `${{ 'fa-core': 'FA 코어', 'super-spine': 'super-spine', spine: 'spine', zone: '구간' }[k as string]} 추가`, onSelect: () => addShape(k, p) })));
    } else {
      select(sel);
      if (sel.kind === 'rack') {
        const r = topo.racks.find((x) => x.id === sel.id);
        if (!r) return;
        title = `랙 ${r.name}`;
        items.push(guard({ label: '서버 추가', onSelect: () => placeInRack('server', r) }));
        items.push(guard({ label: 'ToR(leaf) 추가', onSelect: () => placeInRack('leaf', r) }));
        items.push({ label: expanded.has(r.id) ? '접기' : '펼치기', onSelect: () => h.rackToggle(r.id) });
      } else if (sel.kind === 'device') {
        title = deviceInfo(sel.id)?.hostname ?? '장비';
      } else if (sel.kind === 'zone') {
        title = topo.zones.find((z) => z.id === sel.id)?.name ?? '구간';
        items.push(guard({ label: '랙 추가', onSelect: () => void createRack(sel.id) }));
      } else {
        title = '연결';
      }
      if (sel.kind !== 'edge') items.push(guard({ label: '이름 고치기', onSelect: () => select(sel, true) }));
      items.push(guard({ label: '삭제', danger: true, onSelect: () => requestDelete(sel) }));
    }
    setMenu({ x: at.clientX, y: at.clientY, title, items });
  };

  // ── 화면 ─────────────────────────────────────────────────────────────────
  if (query.isLoading) return <LoadingState label="토폴로지를 읽는 중" />;
  if (query.isError || !topo || !layout) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;

  const device = selection?.kind === 'device' ? deviceInfo(selection.id) : null;
  const rack = selection?.kind === 'rack' ? topo.racks.find((r) => r.id === selection.id) ?? null : null;
  const zone = selection?.kind === 'zone' ? topo.zones.find((z) => z.id === selection.id) ?? null : null;
  const edge = selection?.kind === 'edge' ? topo.edges.find((x) => edgeKey(x) === selection.id) ?? null : null;
  const linkFromId = linking?.fromId ?? (connectMode ? connectFrom : null);
  const linkFrom = linkFromId ? fabricById.get(linkFromId) ?? null : null;
  const { view, size } = cv;
  const mmScale = Math.min(200 / layout.width, 120 / layout.height);
  const allOpen = topo.racks.length > 0 && topo.racks.every((r) => expanded.has(r.id));

  return (
    <div className="flex flex-col lg:flex-row gap-3 items-stretch">
      <Palette disabled={!canOperate} hint={hint} onAdd={(k) => addShape(k)} onDragKind={setDragKind} />

      <section aria-label="패브릭 토폴로지 캔버스" className="flex-1 min-w-0 rounded-md border border-border bg-card flex flex-col">
        <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-border">
          <div role="group" aria-label="편집 모드" className="inline-flex rounded-xl border border-border overflow-hidden">
            <button type="button" aria-pressed={!connectMode} title="선택 · 이동 (Esc)"
              className={`text-sm inline-flex items-center gap-1.5 px-3 py-1.5 ${!connectMode ? 'bg-secondary font-medium' : 'hover:bg-secondary'}`}
              onClick={() => { setConnectMode(false); setConnectFrom(null); }}>
              <MousePointer2 className="w-4 h-4" aria-hidden /> 선택
            </button>
            <button type="button" aria-pressed={connectMode} disabled={!canOperate} title={hint ?? '두 장비를 차례로 누르면 연결'}
              className={`text-sm inline-flex items-center gap-1.5 px-3 py-1.5 border-l border-border disabled:opacity-40 ${connectMode ? 'bg-secondary font-medium' : 'hover:bg-secondary'}`}
              onClick={() => { setConnectMode(true); setConnectFrom(null); }}>
              <Cable className="w-4 h-4" aria-hidden /> 연결
            </button>
          </div>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {connectMode
              ? (connectFrom ? `${fabricById.get(connectFrom)?.hostname} 선택됨 — 이을 장비를 누르세요` : '첫 장비를 누르세요')
              : '도형을 끌어다 놓기 · 손잡이를 끌어 연결 · 더블클릭으로 이름 고치기'}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" className={BTN} title={allOpen ? '모든 랙 접기' : '모든 랙 펼치기'} aria-label={allOpen ? '모든 랙 접기' : '모든 랙 펼치기'}
              onClick={() => setExpanded(allOpen ? new Set() : new Set(topo.racks.map((r) => r.id)))}>
              {allOpen ? <ChevronsDownUp className="w-4 h-4" aria-hidden /> : <ChevronsUpDown className="w-4 h-4" aria-hidden />}
            </button>
            <button type="button" className={BTN} title="축소" aria-label="축소" onClick={() => cv.zoomAt(1 / 1.2)}>
              <Minus className="w-4 h-4" aria-hidden />
            </button>
            <span className="text-xs tabular-nums w-10 text-center">{Math.round(view.k * 100)}%</span>
            <button type="button" className={BTN} title="확대" aria-label="확대" onClick={() => cv.zoomAt(1.2)}>
              <Plus className="w-4 h-4" aria-hidden />
            </button>
            <button type="button" className={BTN} title="전체가 한 화면에 들어오게" onClick={cv.fit}>
              <Maximize className="w-4 h-4" aria-hidden /> 화면 맞춤
            </button>
            <button type="button" className={BTN} disabled={!canOperate || busy} title={hint ?? '끌어 놓은 위치를 지우고 자동 배치로'}
              onClick={() => void act(async () => { await dcApi.resetPositions(); setOverride({}); }, '자동 배치로 되돌렸습니다', '되돌리지 못했습니다')}>
              <RotateCcw className="w-4 h-4" aria-hidden /> 자동 배치
            </button>
          </div>
        </div>

        {/* 캔버스는 키보드(Delete·Esc·방향키)를 받아야 해서 포커스를 준다 — role=application 은 lint 상 비대화형으로 분류된다. */}
        <div
          ref={cv.boxRef}
          role="application"
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={0}
          aria-label="DC 패브릭 토폴로지 — 장비에서 Enter 로 이름 고치기, Delete 로 삭제"
          className={`relative h-[72vh] min-h-[420px] overflow-hidden select-none touch-none focus:outline-none bg-background
            ${cv.panning ? 'cursor-grabbing' : connectMode ? 'cursor-crosshair' : 'cursor-grab'}`}
          onPointerDown={onBoxDown}
          onPointerMove={onBoxMove}
          onPointerUp={onBoxUp}
          onKeyDown={onBoxKey}
          onContextMenu={(e) => { e.preventDefault(); openMenuFor(e, null); }}
          onDragOver={(e) => { if (e.dataTransfer.types.includes(SHAPE_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
          onDrop={onDrop}
          onClick={() => setMenu(null)}
        >
          <svg className="absolute inset-0 w-full h-full" aria-hidden={false}>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
              <Canvas topo={topo} layout={layout} selection={selection} expanded={expanded} canOperate={canOperate}
                linkFrom={linkFrom} linkCursor={linking?.cur ?? null}
                isValidTarget={(n) => (linkFrom ? isValidTarget(linkFrom, n) : true)} dragKind={dragKind} h={h} />
            </g>
          </svg>

          {/* 미니맵 — 누르면 그 자리로 이동 */}
          <svg width={layout.width * mmScale} height={layout.height * mmScale}
            className="absolute right-3 bottom-3 rounded-md border border-border bg-card cursor-pointer"
            aria-label="미니맵 — 누르면 그 위치로 이동" role="img"
            onPointerDown={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              cv.centerOn((e.clientX - r.left) / mmScale, (e.clientY - r.top) / mmScale);
            }}>
            <g transform={`scale(${mmScale})`}>
              {layout.zones.map((z) => <rect key={z.id} x={z.x} y={z.y} width={z.w} height={z.h} className="fill-secondary" />)}
              {Object.entries(layout.nodes).map(([id, n]) => (
                <rect key={id} x={n.x} y={n.y} width={n.w} height={n.h} className="fill-muted-foreground" />
              ))}
              <rect x={-view.x / view.k} y={-view.y / view.k} width={size.w / view.k} height={size.h / view.k}
                className="fill-primary/10 stroke-primary" strokeWidth={2 / mmScale} />
            </g>
          </svg>
        </div>

        {topo.unracked.filter((d) => !fabricById.has(d.id)).length > 0 && (
          <p className="px-3 py-2 border-t border-border text-xs text-muted-foreground">
            랙 미배정 장비 {topo.unracked.length}대 — {topo.unracked.slice(0, 8).map((d) => d.hostname).join(', ')}
            {topo.unracked.length > 8 ? ' …' : ''} (장비 탭 또는 속성 패널에서 랙 지정)
          </p>
        )}
      </section>

      <DcTopologyInspector
        topology={topo}
        selection={selection}
        device={device}
        rack={rack}
        zone={zone}
        edge={edge}
        clusters={clusters}
        canOperate={canOperate}
        hint={hint}
        isAdmin={isAdmin}
        focusToken={focusToken}
        act={actVoid}
        onEdit={setDraft}
        onDelete={() => requestDelete(selection)}
        onToggleRack={h.rackToggle}
        rackOpen={rack ? expanded.has(rack.id) : false}
      />

      {menu && (
        // 우클릭 위치에 띄우는 메뉴 — 좌표가 매번 달라 인라인 위치만 예외로 쓴다(워크플로 보드와 같은 방식).
        <div role="menu" tabIndex={-1} aria-label={`${menu.title} 메뉴`}
          className="fixed z-50 min-w-[200px] rounded-md border border-border bg-popover text-popover-foreground shadow-card py-1"
          style={{ left: Math.min(menu.x, window.innerWidth - 240), top: Math.min(menu.y, window.innerHeight - 40 - menu.items.length * 34) }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => { if (e.key === 'Escape') setMenu(null); }}>
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
          setSelection(null);
          void actVoid(() => dcApi.remove(target.resource, target.id), `${target.label} 삭제`, '삭제하지 못했습니다');
        }}
      />
    </div>
  );
}

