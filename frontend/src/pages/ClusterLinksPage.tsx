import React, { useState, useEffect, useCallback, useId, useMemo, useRef } from 'react';
import {
  Link2, Plus, Pencil, Trash2, ExternalLink, X, Check, Globe, Server,
  GripVertical, Table2, LayoutList, LayoutGrid, Search, RefreshCw, AlertTriangle,
} from 'lucide-react';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, horizontalListSortingStrategy,
  arrayMove, sortableKeyboardCoordinates, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useClusters } from '@/hooks/useCluster';
import { useClusterLinks, useUpdateClusterLinks } from '@/hooks/useUiSettings';
import { useAuthStore, hasRole } from '@/stores/authStore';
import { useTableViewStore, TS } from '@/stores/tableViewStore';
import {
  ViewModeBar, EmptyState, ErrorState, LoadingState, ConfirmDialog, PageHeader, PageShell, StatTile, StatTileRow,
  useToast,
} from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { formatApiError } from '@/lib/utils';
import { ClusterLink, ClusterLinkGroup } from '@/types';

type LayoutMode = 'table' | 'vertical' | 'horizontal';
const LAYOUT_KEY   = 'cluster-links-layout';
const COLW_KEY     = 'cluster-links-col-widths';
const DEFAULT_COL  = 220;
const MIN_COL      = 110;

function genId() { return Math.random().toString(36).slice(2, 10); }

/** 편집 권한 사유 — 서버(`PUT /ui-settings/cluster-links`)가 admin 만 받는다(정책 ⑥). */
const ADMIN_ONLY_HINT = '관리자만 링크를 편집할 수 있습니다';
const HTTP_URL = /^https?:\/\/\S+$/i;

/** 편집 버튼 게이트 — 비활성일 때 사유를 title/aria-label 에 붙인다(DESIGN_SYSTEM §12.9 패턴). */
interface EditGate {
  canEdit: boolean;
  withHint: (title: string) => string;
  ariaWithHint: (label: string) => string;
}

function saveColWidths(w: Record<string, number>) {
  try { localStorage.setItem(COLW_KEY, JSON.stringify(w)); } catch { /* noop */ }
}
function loadColWidths(): Record<string, number> {
  try { const r = localStorage.getItem(COLW_KEY); return r ? JSON.parse(r) : {}; } catch { return {}; }
}

// ── Column resize handle ───────────────────────────────────────────────────────
function ColResizeHandle({ colId, currentWidth, onResize, onResizeDone }: {
  colId: string;
  currentWidth: number;
  onResize: (id: string, w: number) => void;
  onResizeDone: () => void;
}) {
  const start = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const sw = currentWidth;
    const move = (ev: MouseEvent) => onResize(colId, Math.max(MIN_COL, sw + ev.clientX - sx));
    const up   = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      onResizeDone(); // persist to localStorage once on drag end
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }, [colId, currentWidth, onResize, onResizeDone]);

  return (
    <div
      onMouseDown={start}
      className="absolute right-0 top-0 bottom-0 w-3 flex items-center justify-center cursor-col-resize z-10 group"
      title="드래그하여 열 너비 조정"
    >
      <div className="w-px h-4 bg-border/30 group-hover:bg-primary/50 group-active:bg-primary transition-colors" />
    </div>
  );
}

// ── Link form ─────────────────────────────────────────────────────────────────
/** onSave 가 true(저장 성공)를 돌려줄 때만 부모가 폼을 닫는다 — 실패하면 입력이 그대로 남는다. */
interface LinkFormProps { initial?: ClusterLink; onSave: (l: ClusterLink) => Promise<boolean>; onCancel: () => void; }
function LinkForm({ initial, onSave, onCancel }: LinkFormProps) {
  const uid = useId();
  const [label, setLabel] = useState(initial?.label ?? '');
  const [url,   setUrl]   = useState(initial?.url ?? '');
  const [desc,  setDesc]  = useState(initial?.description ?? '');
  const [busy,  setBusy]  = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !label.trim() || !url.trim()) return;
    if (!HTTP_URL.test(url.trim())) {
      setUrlError('http:// 또는 https:// 로 시작하는 주소만 저장할 수 있습니다');
      return;
    }
    setUrlError(null);
    setBusy(true);
    try {
      await onSave({ id: initial?.id ?? genId(), label: label.trim(), url: url.trim(), description: desc.trim() || undefined });
    } finally {
      setBusy(false);
    }
  };
  const cls = 'w-full px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-1 focus:ring-primary';
  const lbl = 'block text-xs font-medium text-muted-foreground mb-1';
  return (
    <form onSubmit={submit} className="bg-secondary/40 border border-border/60 rounded-md p-3 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label htmlFor={`${uid}-label`} className={lbl}>링크 이름 *</label>
          <input id={`${uid}-label`} type="text" value={label} onChange={e => setLabel(e.target.value)} placeholder="예: Grafana" className={cls} required autoFocus />
        </div>
        <div>
          <label htmlFor={`${uid}-url`} className={lbl}>URL *</label>
          <input id={`${uid}-url`} type="url" value={url} onChange={e => { setUrl(e.target.value); setUrlError(null); }}
            placeholder="https://…" className={cls} required
            aria-invalid={urlError ? true : undefined} aria-describedby={urlError ? `${uid}-url-err` : undefined} />
        </div>
      </div>
      {urlError && <p id={`${uid}-url-err`} role="alert" className="text-xs text-status-critical">{urlError}</p>}
      <div>
        <label htmlFor={`${uid}-desc`} className={lbl}>설명 (선택)</label>
        <input id={`${uid}-desc`} type="text" value={desc} onChange={e => setDesc(e.target.value)} className={cls} />
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel}
          className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl transition-colors flex items-center gap-1">
          <X className="w-3.5 h-3.5" /> 취소
        </button>
        <button type="submit" disabled={busy}
          className="px-3 py-1.5 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors flex items-center gap-1 disabled:opacity-50">
          <Check className="w-3.5 h-3.5" /> {busy ? '저장 중…' : '저장'}
        </button>
      </div>
    </form>
  );
}

// ── Link card (vertical/horizontal modes) ─────────────────────────────────────
function LinkCard({ link, onEdit, onDelete, gate }: { link: ClusterLink; onEdit: () => void; onDelete: () => void; gate: EditGate }) {
  return (
    <div className="group relative flex items-start gap-3 px-3.5 py-3 bg-background hover:bg-secondary/60 border border-border/60 hover:border-primary/30 rounded-md transition-colors">
      <div className="w-8 h-8 bg-secondary rounded-md flex items-center justify-center flex-shrink-0 mt-0.5">
        <Link2 className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <a href={link.url} target="_blank" rel="noopener noreferrer"
          className="font-semibold text-sm text-foreground hover:text-primary transition-colors flex items-center gap-1 truncate">
          {link.label}
          <ExternalLink className="w-3 h-3 flex-shrink-0 opacity-60" />
        </a>
        {link.description && <p className="text-sm text-muted-foreground mt-0.5 truncate">{link.description}</p>}
        <p className="text-xs text-muted-foreground font-mono truncate mt-1">{link.url}</p>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity flex-shrink-0">
        <button type="button" onClick={onEdit} disabled={!gate.canEdit}
          className="p-1.5 hover:bg-secondary rounded-xl text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
          title={gate.withHint('편집')} aria-label={gate.ariaWithHint(`${link.label} 편집`)}><Pencil className="w-3.5 h-3.5" /></button>
        <button type="button" onClick={onDelete} disabled={!gate.canEdit}
          className="p-1.5 hover:bg-status-critical/10 rounded-xl text-muted-foreground hover:text-status-critical disabled:opacity-40 disabled:cursor-not-allowed"
          title={gate.withHint('삭제')} aria-label={gate.ariaWithHint(`${link.label} 삭제`)}><Trash2 className="w-3.5 h-3.5" /></button>
      </div>
    </div>
  );
}

// ── Compact link cell (table mode) ────────────────────────────────────────────
function CompactLinkCell({ link, onEdit, onDelete, fontClass, fsClass, gate }: {
  link: ClusterLink; onEdit: () => void; onDelete: () => void;
  fontClass: string; fsClass: string; gate: EditGate;
}) {
  return (
    <div className={`group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 transition-colors ${fontClass} ${fsClass}`}>
      <div className="flex-1 min-w-0">
        <a href={link.url} target="_blank" rel="noopener noreferrer"
          className="font-medium text-foreground hover:text-primary transition-colors flex items-center gap-1 truncate">
          {link.label}<ExternalLink className="w-2.5 h-2.5 flex-shrink-0 opacity-50" />
        </a>
        {link.description && <p className="text-muted-foreground truncate leading-tight mt-0.5">{link.description}</p>}
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity flex-shrink-0">
        <button type="button" onClick={onEdit} disabled={!gate.canEdit}
          className="p-1 hover:bg-secondary rounded-xl text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
          title={gate.withHint('편집')} aria-label={gate.ariaWithHint(`${link.label} 편집`)}><Pencil className="w-2.5 h-2.5" /></button>
        <button type="button" onClick={onDelete} disabled={!gate.canEdit}
          className="p-1 hover:bg-status-critical/10 rounded-xl text-muted-foreground hover:text-status-critical disabled:opacity-40 disabled:cursor-not-allowed"
          title={gate.withHint('삭제')} aria-label={gate.ariaWithHint(`${link.label} 삭제`)}><Trash2 className="w-2.5 h-2.5" /></button>
      </div>
    </div>
  );
}

// ── Sortable wrapper ───────────────────────────────────────────────────────────
function SortableItem({ id, disabled, children }: {
  id: string; disabled?: boolean;
  children: (h: React.HTMLAttributes<HTMLElement>) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}>
      {children({ ...attributes, ...listeners })}
    </div>
  );
}

// ── View mode config ───────────────────────────────────────────────────────────
const VIEW_MODES = [
  { id: 'table',      label: '표',  icon: <Table2     className="w-3.5 h-3.5" /> },
  { id: 'vertical',   label: '종',  icon: <LayoutList className="w-3.5 h-3.5" /> },
  { id: 'horizontal', label: '횡',  icon: <LayoutGrid className="w-3.5 h-3.5" /> },
];

// ── Main page ──────────────────────────────────────────────────────────────────
type PendingDelete = { scope: 'common' } | { scope: 'cluster'; clusterId: string };

export function ClusterLinksPage() {
  const clustersQ = useClusters();
  const clusters = useMemo(() => clustersQ.data ?? [], [clustersQ.data]);
  const linksQ = useClusterLinks();
  const linksData = linksQ.data;
  const updateClusterLinks   = useUpdateClusterLinks();
  const { style }            = useTableViewStore();
  const toast = useToast();
  const isAdmin = useAuthStore((st) => hasRole(st.user, 'admin'));

  // Layout
  const [layout, setLayout] = useState<LayoutMode>(() => {
    try { return (localStorage.getItem(LAYOUT_KEY) as LayoutMode) ?? 'table'; } catch { return 'table'; }
  });
  const changeLayout = (mode: string) => {
    setLayout(mode as LayoutMode);
    try { localStorage.setItem(LAYOUT_KEY, mode); } catch { /* noop */ }
  };

  // Column widths (table mode)
  const [colWidths, setColWidths] = useState<Record<string, number>>(loadColWidths);
  const colWidthsRef = useRef(colWidths);
  useEffect(() => { colWidthsRef.current = colWidths; }, [colWidths]);

  // Update state on every mousemove (live preview), persist to localStorage only on drag end
  const handleColResize = useCallback((id: string, w: number) => {
    setColWidths(prev => ({ ...prev, [id]: w }));
  }, []);
  const handleColResizeDone = useCallback(() => {
    saveColWidths(colWidthsRef.current);
  }, []);
  const colW = (id: string) => colWidths[id] ?? DEFAULT_COL;

  // UI state — 링크 데이터 자체는 서버 캐시(linksData)가 원천이다. 저장이 성공한 뒤에만 화면이 바뀌고
  // (응답이 캐시에 들어감), 실패하면 서버 값이 그대로 남는다(A-4).
  const [addingTo,         setAddingTo]          = useState<string | null>(null);
  const [editingLink,      setEditingLink]       = useState<{ clusterId: string; link: ClusterLink } | null>(null);
  const [addingCommon,     setAddingCommon]      = useState(false);
  const [editingCommon,    setEditingCommon]     = useState<ClusterLink | null>(null);
  const [tableFormTarget,  setTableFormTarget]   = useState<string | null>(null); // 'common' | clusterId
  const [pendingDelete,    setPendingDelete]     = useState<{ target: PendingDelete; link: ClusterLink } | null>(null);
  // 드래그 직후 저장 응답까지만 쓰는 순서(실패하면 지워져 서버 순서로 돌아간다).
  const [pendingOrder,     setPendingOrder]      = useState<string[] | null>(null);
  // 409(다른 관리자가 먼저 저장) — 새로고침 전까지 편집을 막는다.
  const [conflict,         setConflict]          = useState<string | null>(null);

  const linksReady    = !!linksData && !linksQ.isError;
  const clustersReady = clustersQ.isSuccess;
  const serverGroups  = useMemo(() => linksData?.clusterGroups ?? [], [linksData]);
  const commonLinks   = useMemo(() => linksData?.commonLinks ?? [], [linksData]);

  // 편집 게이트 — admin + 링크 로드 완료 + 충돌 없음(A-4·A-5).
  const editHint = !isAdmin
    ? ADMIN_ONLY_HINT
    : !linksReady
      ? '링크를 불러온 뒤 편집할 수 있습니다'
      : conflict
        ? '다른 곳에서 바뀐 링크를 새로고침한 뒤 편집할 수 있습니다'
        : undefined;
  const gate: EditGate = {
    canEdit: !editHint,
    withHint: (title) => editHint ?? title,
    ariaWithHint: (label) => (editHint ? `${label} — ${editHint}` : label),
  };

  // 보이는 클러스터의 그룹 — 저장된 배열 순서 그대로, 링크가 없는 클러스터는 클러스터 목록 순서로 뒤에 붙인다.
  const orderedGroups = useMemo<ClusterLinkGroup[]>(() => {
    const byId = new Map(clusters.map(c => [c.id, c]));
    const seen = new Set<string>();
    const out: ClusterLinkGroup[] = [];
    for (const g of serverGroups) {
      const c = byId.get(g.clusterId);
      if (!c || seen.has(g.clusterId)) continue;
      seen.add(g.clusterId);
      out.push({ ...g, clusterName: c.name });
    }
    for (const c of clusters) {
      if (!seen.has(c.id)) out.push({ clusterId: c.id, clusterName: c.name, links: [] });
    }
    if (!pendingOrder) return out;
    const idx = (id: string) => { const i = pendingOrder.indexOf(id); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
    return [...out].sort((a, b) => idx(a.clusterId) - idx(b.clusterId));
  }, [serverGroups, clusters, pendingOrder]);

  // 고아(삭제된 클러스터) 판정은 클러스터 목록과 링크가 둘 다 로드된 뒤에만 한다(A-12). 서버는 고아 그룹을
  // admin 에게만 내려주고, 구버전 서버가 다른 테넌트 그룹을 내려줘도 admin 이 아니면 보이지 않게 거른다.
  const orphanGroups = useMemo<ClusterLinkGroup[]>(() => {
    if (!clustersReady || !linksReady || !isAdmin) return [];
    const ids = new Set(clusters.map(c => c.id));
    return serverGroups.filter(g => !ids.has(g.clusterId));
  }, [clustersReady, linksReady, isAdmin, clusters, serverGroups]);

  const [keyword, setKeyword] = useState('');

  const normalizedKeyword = keyword.trim().toLowerCase();
  const filteredCommonLinks = normalizedKeyword
    ? commonLinks.filter(link =>
        [link.label, link.description ?? '', link.url].join(' ').toLowerCase().includes(normalizedKeyword),
      )
    : commonLinks;

  const filteredOrderedGroups = orderedGroups
    .map(group => ({
      ...group,
      links: normalizedKeyword
        ? group.links.filter(link =>
            [link.label, link.description ?? '', link.url].join(' ').toLowerCase().includes(normalizedKeyword),
          )
        : group.links,
    }))
    .filter(group => !normalizedKeyword || group.links.length > 0 || group.clusterName.toLowerCase().includes(normalizedKeyword));

  const totalLinks = commonLinks.length + orderedGroups.reduce((acc, g) => acc + g.links.length, 0);

  const refreshLinks = () => {
    setConflict(null);
    void linksQ.refetch();
  };

  /** 문서 저장 — 그룹 배열 순서가 곧 저장 순서. 성공하면 true, 실패하면 토스트 후 false(화면은 서버 값 유지). */
  const save = async (groups: ClusterLinkGroup[], common: ClusterLink[], okMessage?: string): Promise<boolean> => {
    if (!linksData || !gate.canEdit) return false;
    // 화면에 없는 그룹(고아 등)은 저장된 문서에서 그대로 뒤에 붙여 보낸다 — 요청에 빠졌다고 지워지지 않게.
    const ids = new Set(groups.map(g => g.clusterId));
    const rest = serverGroups.filter(g => !ids.has(g.clusterId));
    try {
      await updateClusterLinks.mutateAsync({
        clusterGroups: [...groups, ...rest],
        commonLinks: common,
        version: linksData.version ?? undefined,
      });
      if (okMessage) toast.success(okMessage);
      return true;
    } catch (err) {
      const status = (err as { response?: { status?: number } } | null)?.response?.status;
      if (status === 409) {
        const detail = formatApiError(err, '다른 곳에서 링크가 먼저 바뀌었습니다.');
        setConflict(detail);
        toast.show({
          variant: 'error',
          title: '저장 충돌 — 최신 링크를 다시 불러오세요',
          description: detail,
          action: { label: '새로고침', onClick: refreshLinks },
          durationMs: 0,
        });
      } else {
        toast.error(status === 403 ? '링크 저장 실패 — 권한이 없습니다' : '링크 저장 실패', formatApiError(err));
      }
      return false;
    }
  };

  /** 보이는 그룹 + 고아 그룹 중 cid 의 링크 목록만 바꾼 그룹 배열(보이는 순서 유지). */
  const withGroupLinks = (cid: string, fn: (links: ClusterLink[]) => ClusterLink[]): ClusterLinkGroup[] =>
    [...orderedGroups, ...orphanGroups].map(g => (g.clusterId === cid ? { ...g, links: fn(g.links) } : g));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = (ev: DragEndEvent) => {
    const { active, over } = ev;
    if (!over || active.id === over.id || !gate.canEdit) return;
    const oi = orderedGroups.findIndex(g => g.clusterId === active.id);
    const ni = orderedGroups.findIndex(g => g.clusterId === over.id);
    if (oi < 0 || ni < 0) return;
    const next = arrayMove(orderedGroups, oi, ni);
    setPendingOrder(next.map(g => g.clusterId));
    void save(next, commonLinks).finally(() => setPendingOrder(null));
  };

  const handleAddLink = async (cid: string, link: ClusterLink) => {
    const ok = await save(withGroupLinks(cid, links => [...links, link]), commonLinks, `"${link.label}" 링크를 추가했습니다`);
    if (ok) { setAddingTo(null); setTableFormTarget(null); }
    return ok;
  };
  const handleEditLink = async (cid: string, updated: ClusterLink) => {
    const ok = await save(withGroupLinks(cid, links => links.map(l => l.id === updated.id ? updated : l)), commonLinks, '링크를 저장했습니다');
    if (ok) setEditingLink(null);
    return ok;
  };
  const handleAddCommon = async (link: ClusterLink) => {
    const ok = await save(orderedGroups, [...commonLinks, link], `"${link.label}" 공통 링크를 추가했습니다`);
    if (ok) { setAddingCommon(false); setTableFormTarget(null); }
    return ok;
  };
  const handleEditCommon = async (updated: ClusterLink) => {
    const ok = await save(orderedGroups, commonLinks.map(l => l.id === updated.id ? updated : l), '링크를 저장했습니다');
    if (ok) setEditingCommon(null);
    return ok;
  };
  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const { target, link } = pendingDelete;
    const ok = target.scope === 'common'
      ? await save(orderedGroups, commonLinks.filter(l => l.id !== link.id), `"${link.label}" 링크를 삭제했습니다`)
      : await save(withGroupLinks(target.clusterId, links => links.filter(l => l.id !== link.id)), commonLinks, `"${link.label}" 링크를 삭제했습니다`);
    if (ok) setPendingDelete(null);
  };
  const askDeleteCommon  = (link: ClusterLink) => setPendingDelete({ target: { scope: 'common' }, link });
  const askDeleteCluster = (clusterId: string, link: ClusterLink) => setPendingDelete({ target: { scope: 'cluster', clusterId }, link });

  // ── Derived style helpers ──────────────────────────────────────────────────
  const fsClass   = TS.fontSize[style.fontSize];
  const padClass  = TS.cellPad[style.density];
  const rowMinH   = TS.rowMinH[style.density];
  const borderCls = TS.border[style.border];
  const hdrBg     = TS.headerBg[style.headerTheme];
  const hdrText   = TS.headerText[style.headerTheme];
  const fontClass = style.monoFont ? 'font-mono' : '';

  // ── Table view renderer ────────────────────────────────────────────────────
  const renderTableView = () => {
    const groups = filteredOrderedGroups; // show all — no pagination
    const maxRows = Math.max(filteredCommonLinks.length, ...groups.map(g => g.links.length), 0);

    // Build grid template
    const gridCols = [
      `${colW('common')}px`,
      ...groups.map(g => `${colW(g.clusterId)}px`),
    ].join(' ');

    const cellBase = `border ${borderCls} ${padClass}`;
    const altRowBg = (i: number) => style.altRow && i % 2 === 1 ? 'bg-muted/30' : '';

    const cells: React.ReactNode[] = [];

    // ── Header row ──
    // Common header
    cells.push(
      <div key="h-common" className={`relative flex items-center gap-1.5 border-b border-r ${borderCls} px-3 py-2 bg-secondary sticky top-0 z-10`}>
        <Globe className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
        <span className="font-semibold text-xs text-foreground truncate">공통 링크</span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums flex-shrink-0">({filteredCommonLinks.length})</span>
        <button type="button" onClick={() => { setTableFormTarget('common'); setEditingCommon(null); setEditingLink(null); }}
          disabled={!gate.canEdit}
          className="ml-1 p-0.5 rounded-xl text-muted-foreground opacity-60 hover:opacity-100 hover:text-foreground hover:bg-muted transition-colors flex-shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
          title={gate.withHint('공통 링크 추가')} aria-label={gate.ariaWithHint('공통 링크 추가')}>
          <Plus className="w-3 h-3" />
        </button>
        <ColResizeHandle colId="common" currentWidth={colW('common')} onResize={handleColResize} onResizeDone={handleColResizeDone} />
      </div>,
    );
    groups.forEach((g, idx) => {
      cells.push(
        <div key={`h-${g.clusterId}`}
          className={`relative flex items-center gap-1.5 border-b ${borderCls} px-3 py-2 ${hdrBg} sticky top-0 z-10${idx < groups.length - 1 ? ` border-r ${borderCls}` : ''}`}>
          <Server aria-hidden="true" className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          <span className={`font-semibold text-xs truncate ${hdrText}`}>{g.clusterName}</span>
          <span className="ml-auto text-xs text-muted-foreground tabular-nums flex-shrink-0">({g.links.length})</span>
          <button type="button" onClick={() => { setTableFormTarget(g.clusterId); setEditingLink(null); setEditingCommon(null); }}
            disabled={!gate.canEdit}
            className={`ml-1 p-0.5 rounded-xl transition-colors flex-shrink-0 ${hdrText} opacity-60 hover:opacity-100 hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed`}
            title={gate.withHint('링크 추가')} aria-label={gate.ariaWithHint(`${g.clusterName} 링크 추가`)}>
            <Plus className="w-3 h-3" />
          </button>
          <ColResizeHandle colId={g.clusterId} currentWidth={colW(g.clusterId)} onResize={handleColResize} onResizeDone={handleColResizeDone} />
        </div>,
      );
    });

    // ── Data rows ──
    if (maxRows === 0) {
      cells.push(
        <div key="empty-common" className={`${cellBase} text-center`} style={{ minHeight: rowMinH }}>
          <span className="text-sm text-muted-foreground/40">—</span>
        </div>,
      );
      groups.forEach((g, idx) => cells.push(
        <div key={`empty-${g.clusterId}`}
          className={`${cellBase} text-center${idx < groups.length - 1 ? ` border-r ${borderCls}` : ''}`}
          style={{ minHeight: rowMinH }}>
          <span className="text-sm text-muted-foreground/40">—</span>
        </div>,
      ));
    } else {
      for (let rowIdx = 0; rowIdx < maxRows; rowIdx++) {
        const isLast = rowIdx === maxRows - 1;
        const rowAlt = altRowBg(rowIdx);

        // common cell
        cells.push(
          <div key={`c-${rowIdx}`}
            className={`border-r ${borderCls}${isLast ? '' : ` border-b ${borderCls}`} ${padClass} ${rowAlt}`}
            style={{ minHeight: rowMinH }}>
            {filteredCommonLinks[rowIdx] ? (
              editingCommon?.id === filteredCommonLinks[rowIdx].id ? (
                <LinkForm initial={filteredCommonLinks[rowIdx]} onSave={handleEditCommon} onCancel={() => setEditingCommon(null)} />
              ) : (
                <CompactLinkCell link={filteredCommonLinks[rowIdx]} fontClass={fontClass} fsClass={fsClass} gate={gate}
                  onEdit={() => { setEditingCommon(filteredCommonLinks[rowIdx]); setTableFormTarget(null); }}
                  onDelete={() => askDeleteCommon(filteredCommonLinks[rowIdx])} />
              )
            ) : null}
          </div>,
        );

        // cluster cells
        groups.forEach((g, idx) => {
          const link = g.links[rowIdx];
          cells.push(
            <div key={`${g.clusterId}-${rowIdx}`}
              className={`${isLast ? '' : `border-b ${borderCls}`}${idx < groups.length - 1 ? ` border-r ${borderCls}` : ''} ${padClass} ${rowAlt}`}
              style={{ minHeight: rowMinH }}>
              {link ? (
                editingLink?.clusterId === g.clusterId && editingLink.link.id === link.id ? (
                  <LinkForm initial={link}
                    onSave={updated => handleEditLink(g.clusterId, updated)}
                    onCancel={() => setEditingLink(null)} />
                ) : (
                  <CompactLinkCell link={link} fontClass={fontClass} fsClass={fsClass} gate={gate}
                    onEdit={() => { setEditingLink({ clusterId: g.clusterId, link }); setTableFormTarget(null); }}
                    onDelete={() => askDeleteCluster(g.clusterId, link)} />
                )
              ) : null}
            </div>,
          );
        });
      }
    }

    return (
      <div className="space-y-3">
        {/* Scrollable table */}
        <MacCard title="클러스터별 링크 매트릭스" bodyPadding="p-0">
          <div className="overflow-auto">
            <div style={{ display: 'grid', gridTemplateColumns: gridCols, minWidth: 'max-content' }}>
              {cells}
            </div>
          </div>
        </MacCard>

        {/* Add-link form panel */}
        {tableFormTarget && (
          <MacCard
            title={tableFormTarget === 'common'
              ? '공통 링크 추가'
              : `${orderedGroups.find(x => x.clusterId === tableFormTarget)?.clusterName ?? ''} — 링크 추가`}
            bodyPadding="p-4"
          >
            {tableFormTarget === 'common' ? (
              <LinkForm onSave={handleAddCommon} onCancel={() => setTableFormTarget(null)} />
            ) : (() => {
              const g = orderedGroups.find(x => x.clusterId === tableFormTarget);
              return g ? (
                <LinkForm
                  onSave={link => handleAddLink(g.clusterId, link)}
                  onCancel={() => setTableFormTarget(null)} />
              ) : null;
            })()}
          </MacCard>
        )}

        {/* Orphan groups */}
        {orphanGroups.length > 0 && (
          <MacCard title="삭제된 클러스터의 링크" bodyPadding="p-4">
            <div className="space-y-1.5">
              {orphanGroups.map(g => (
                <div key={g.clusterId} className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground w-28 truncate">{g.clusterName}</span>
                  <div className="flex flex-wrap gap-2">
                    {g.links.map(l => (
                      <a key={l.id} href={l.url} target="_blank" rel="noopener noreferrer"
                        className="text-sm text-muted-foreground hover:text-primary flex items-center gap-0.5 transition-colors">
                        {l.label}<ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </MacCard>
        )}
      </div>
    );
  };

  // ── Cluster group card (vertical/horizontal modes) ─────────────────────────
  const renderGroupCard = (g: ClusterLinkGroup, isOrphan: boolean, dragHandle: React.HTMLAttributes<HTMLElement>) => (
    <MacCard
      title={g.clusterName}
      icon={Server}
      titleExtra={
        <>
          {isOrphan && (
            <span className="text-xs text-muted-foreground px-1.5 py-0.5 rounded bg-muted">삭제됨</span>
          )}
          <span className="text-xs text-muted-foreground tabular-nums">{g.links.length}</span>
        </>
      }
      actions={!isOrphan && (
        <>
          <button type="button" onClick={() => { setAddingTo(g.clusterId); setEditingLink(null); }}
            disabled={!gate.canEdit}
            className="px-2 py-1 text-xs font-medium bg-primary/10 hover:bg-primary/15 text-primary border border-primary/20 rounded-xl transition-colors flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
            title={gate.withHint('링크 추가')} aria-label={gate.ariaWithHint(`${g.clusterName} 링크 추가`)}>
            <Plus className="w-3 h-3" /> 추가
          </button>
          {/* 순서 변경 손잡이 — 마우스 드래그 또는 포커스 후 Space → 화살표 → Space(KeyboardSensor). 순서는 저장된다. */}
          <button type="button" {...dragHandle} disabled={!gate.canEdit || !!normalizedKeyword}
            className="cursor-grab active:cursor-grabbing p-0.5 rounded-xl text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:cursor-not-allowed disabled:opacity-40"
            title={normalizedKeyword && gate.canEdit ? '검색 중에는 순서를 바꿀 수 없습니다' : gate.withHint('드래그하거나 Space·화살표로 순서 변경')}
            aria-label={gate.ariaWithHint(`${g.clusterName} 순서 변경`)}>
            <GripVertical className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </>
      )}
      rootClassName="h-full flex flex-col"
      className="space-y-2 flex-1"
    >
      {addingTo === g.clusterId && (
        <LinkForm onSave={link => handleAddLink(g.clusterId, link)} onCancel={() => setAddingTo(null)} />
      )}
      {g.links.length === 0 && addingTo !== g.clusterId ? (
        <EmptyState
          compact
          icon={Link2}
          title="등록된 링크가 없습니다"
          description={isOrphan
            ? '클러스터가 삭제되어 링크 추가가 비활성화되었습니다.'
            : gate.canEdit ? undefined : `${editHint}.`}
          action={isOrphan || !gate.canEdit ? undefined : {
            label: '+ 첫 번째 링크 추가',
            variant: 'secondary',
            onClick: () => { setAddingTo(g.clusterId); setEditingLink(null); },
          }}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
          {g.links.map(link => (
            <div key={link.id}>
              {editingLink?.clusterId === g.clusterId && editingLink.link.id === link.id ? (
                <LinkForm initial={link}
                  onSave={updated => handleEditLink(g.clusterId, updated)}
                  onCancel={() => setEditingLink(null)} />
              ) : (
                <LinkCard link={link} gate={gate}
                  onEdit={() => { setEditingLink({ clusterId: g.clusterId, link }); setAddingTo(null); }}
                  onDelete={() => askDeleteCluster(g.clusterId, link)} />
              )}
            </div>
          ))}
        </div>
      )}
    </MacCard>
  );

  const noClusters = clustersReady && clusters.length === 0 && orphanGroups.length === 0;

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="hub" className="space-y-3">
        <PageHeader
          icon={Link2}
          title="클러스터 주요 링크"
          description="운영 클러스터별 대시보드 · 모니터링 · 관리 콘솔을 한곳에서 빠르게 접근하세요."
          actions={<ViewModeBar modes={VIEW_MODES} active={layout} onChange={changeLayout} />}
        />

        <StatTileRow>
          <StatTile label="전체 링크" value={totalLinks} />
          <StatTile label="클러스터" value={orderedGroups.length} />
          <StatTile label="공통 링크" value={commonLinks.length} />
        </StatTileRow>

        {/* Search */}
        <div className="relative">
          <Search aria-hidden="true" className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            placeholder="링크 이름, 설명, URL 검색"
            aria-label="링크 검색"
            className="w-full rounded-xl border border-border bg-background pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors"
          />
        </div>

        {/* 저장 충돌(409) — 새로고침 전까지 편집이 잠긴다 */}
        {conflict && (
          <div role="alert" className="flex items-center gap-3 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-sm">
            <AlertTriangle className="w-4 h-4 text-status-warning flex-shrink-0" aria-hidden="true" />
            <p className="flex-1 min-w-0 text-foreground">{conflict}</p>
            <button type="button" onClick={refreshLinks}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-muted border border-border rounded-xl transition-colors flex-shrink-0">
              <RefreshCw className={`w-3.5 h-3.5 ${linksQ.isFetching ? 'animate-spin' : ''}`} aria-hidden="true" /> 새로고침
            </button>
          </div>
        )}

        {/* 조회 순서: 로딩 → 실패(ErrorState) → 빈 상태(A-12). 링크·클러스터 둘 다 와야 그룹·고아를 판정한다. */}
        {linksQ.isLoading || (clustersQ.isLoading && !clustersQ.data) ? (
          <LoadingState />
        ) : linksQ.isError ? (
          <ErrorState error={linksQ.error} title="링크를 불러오지 못했습니다" onRetry={() => { void linksQ.refetch(); }} />
        ) : clustersQ.isError ? (
          <ErrorState error={clustersQ.error} title="클러스터 목록을 불러오지 못했습니다" onRetry={() => { void clustersQ.refetch(); }} />
        ) : noClusters ? (
          <EmptyState
            icon={Link2}
            title="등록된 클러스터가 없습니다"
            description="설정에서 클러스터를 먼저 등록한 뒤 링크를 관리할 수 있습니다."
          />
        ) : layout === 'table' ? (
          /* ── Table view ── */
          renderTableView()
        ) : (
          /* ── Card views (vertical / horizontal) ── */
          <>
            {/* Common links section */}
            <MacCard
              title="공통 서비스 링크"
              icon={Globe}
              titleExtra={<span className="text-xs text-muted-foreground tabular-nums">{filteredCommonLinks.length}</span>}
              actions={
                <button type="button" onClick={() => { setAddingCommon(true); setEditingCommon(null); }}
                  disabled={!gate.canEdit}
                  title={gate.withHint('공통 링크 추가')} aria-label={gate.ariaWithHint('공통 링크 추가')}
                  className="px-2 py-1 text-xs font-medium bg-secondary hover:bg-muted text-foreground border border-border rounded-xl transition-colors flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed">
                  <Plus className="w-3 h-3" /> 추가
                </button>
              }
              className="space-y-2"
            >
              {addingCommon && <LinkForm onSave={handleAddCommon} onCancel={() => setAddingCommon(false)} />}
              {filteredCommonLinks.length === 0 && !addingCommon ? (
                <EmptyState
                  compact
                  icon={Globe}
                  title="공통 링크가 없습니다"
                  description={gate.canEdit
                    ? '모든 클러스터에서 공통으로 사용하는 링크를 등록하세요.'
                    : `모든 클러스터에서 공통으로 쓰는 링크가 여기에 표시됩니다. ${editHint}.`}
                  action={gate.canEdit ? { label: '+ 첫 번째 공통 링크 추가', variant: 'secondary', onClick: () => setAddingCommon(true) } : undefined}
                />
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                  {filteredCommonLinks.map(link => (
                    <div key={link.id}>
                      {editingCommon?.id === link.id ? (
                        <LinkForm initial={link} onSave={handleEditCommon} onCancel={() => setEditingCommon(null)} />
                      ) : (
                        <LinkCard link={link} gate={gate}
                          onEdit={() => { setEditingCommon(link); setAddingCommon(false); }}
                          onDelete={() => askDeleteCommon(link)} />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </MacCard>

            {/* Cluster groups */}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext
                items={filteredOrderedGroups.map(g => g.clusterId)}
                strategy={layout === 'vertical' ? verticalListSortingStrategy : horizontalListSortingStrategy}
              >
                <div className={layout === 'horizontal' ? 'grid grid-cols-1 md:grid-cols-2 gap-3' : 'flex flex-col gap-3'}>
                  {filteredOrderedGroups.map(g => (
                    <SortableItem key={g.clusterId} id={g.clusterId} disabled={!gate.canEdit || !!normalizedKeyword}>
                      {h => renderGroupCard(g, false, h)}
                    </SortableItem>
                  ))}
                  {orphanGroups.map(g => (
                    <SortableItem key={g.clusterId} id={g.clusterId} disabled>
                      {h => renderGroupCard(g, true, h)}
                    </SortableItem>
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </>
        )}
      </PageShell>

      <ConfirmDialog
        open={!!pendingDelete}
        danger
        title="링크 삭제"
        description={pendingDelete ? `"${pendingDelete.link.label}" 링크를 삭제합니다. 모든 사용자의 화면에서 사라집니다.` : undefined}
        confirmLabel="삭제"
        busy={updateClusterLinks.isPending}
        onConfirm={() => { void confirmDelete(); }}
        onCancel={() => setPendingDelete(null)}
      >
        {pendingDelete && <p className="text-xs font-mono text-muted-foreground break-all">{pendingDelete.link.url}</p>}
      </ConfirmDialog>
    </div>
  );
}
