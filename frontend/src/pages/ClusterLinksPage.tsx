import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Link2, Plus, Pencil, Trash2, ExternalLink, X, Check, Globe,
  GripVertical, Table2, LayoutList, LayoutGrid, Search,
} from 'lucide-react';
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, horizontalListSortingStrategy,
  arrayMove, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useClusters } from '@/hooks/useCluster';
import { useClusterLinks, useUpdateClusterLinks } from '@/hooks/useUiSettings';
import { useClusterStore } from '@/stores/clusterStore';
import { useTableViewStore, TS } from '@/stores/tableViewStore';
import { ViewModeBar, EmptyState } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterLink, ClusterLinkGroup } from '@/types';

type LayoutMode = 'table' | 'vertical' | 'horizontal';
const LAYOUT_KEY   = 'cluster-links-layout';
const COLW_KEY     = 'cluster-links-col-widths';
const DEFAULT_COL  = 220;
const MIN_COL      = 110;

function genId() { return Math.random().toString(36).slice(2, 10); }

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
interface LinkFormProps { initial?: ClusterLink; onSave: (l: ClusterLink) => void; onCancel: () => void; }
function LinkForm({ initial, onSave, onCancel }: LinkFormProps) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [url,   setUrl]   = useState(initial?.url ?? '');
  const [desc,  setDesc]  = useState(initial?.description ?? '');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !url.trim()) return;
    onSave({ id: initial?.id ?? genId(), label: label.trim(), url: url.trim(), description: desc.trim() || undefined });
  };
  const cls = 'w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary';
  return (
    <form onSubmit={submit} className="bg-secondary/40 border border-border/60 rounded-lg p-3 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <input type="text"  value={label} onChange={e => setLabel(e.target.value)} placeholder="링크 이름 *"       className={cls} required autoFocus />
        <input type="url"   value={url}   onChange={e => setUrl(e.target.value)}   placeholder="URL * (https://...)" className={cls} required />
      </div>
      <input type="text" value={desc} onChange={e => setDesc(e.target.value)} placeholder="설명 (선택)" className={cls} />
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel}
          className="px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors flex items-center gap-1">
          <X className="w-3.5 h-3.5" /> 취소
        </button>
        <button type="submit"
          className="px-3 py-1.5 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors flex items-center gap-1">
          <Check className="w-3.5 h-3.5" /> 저장
        </button>
      </div>
    </form>
  );
}

// ── Link card (vertical/horizontal modes) ─────────────────────────────────────
function LinkCard({ link, onEdit, onDelete }: { link: ClusterLink; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="group relative flex items-start gap-3 px-3.5 py-3 bg-background/60 hover:bg-secondary/60 border border-border/60 hover:border-primary/30 rounded-xl transition-all hover:shadow-sm">
      <div className="w-8 h-8 bg-primary/10 ring-1 ring-primary/15 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5">
        <Link2 className="w-4 h-4 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <a href={link.url} target="_blank" rel="noopener noreferrer"
          className="font-semibold text-sm text-foreground hover:text-primary transition-colors flex items-center gap-1 truncate">
          {link.label}
          <ExternalLink className="w-3 h-3 flex-shrink-0 opacity-60" />
        </a>
        {link.description && <p className="text-sm text-muted-foreground mt-0.5 truncate">{link.description}</p>}
        <p className="text-xs text-muted-foreground/60 font-mono truncate mt-1">{link.url}</p>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
        <button onClick={onEdit}   className="p-1.5 hover:bg-secondary rounded-md text-muted-foreground hover:text-foreground" title="편집" aria-label="편집"><Pencil className="w-3.5 h-3.5" /></button>
        <button onClick={onDelete} className="p-1.5 hover:bg-red-500/10 rounded-md text-muted-foreground hover:text-red-500" title="삭제" aria-label="삭제"><Trash2 className="w-3.5 h-3.5" /></button>
      </div>
    </div>
  );
}

// ── Compact link cell (table mode) ────────────────────────────────────────────
function CompactLinkCell({ link, onEdit, onDelete, fontClass, fsClass }: {
  link: ClusterLink; onEdit: () => void; onDelete: () => void;
  fontClass: string; fsClass: string;
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
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
        <button onClick={onEdit}   className="p-1 hover:bg-secondary rounded text-muted-foreground hover:text-foreground" aria-label="편집"><Pencil className="w-2.5 h-2.5" /></button>
        <button onClick={onDelete} className="p-1 hover:bg-red-500/10 rounded text-muted-foreground hover:text-red-400" aria-label="삭제"><Trash2 className="w-2.5 h-2.5" /></button>
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
export function ClusterLinksPage() {
  const { clusters } = useClusterStore();
  useClusters();
  const { data: linksData } = useClusterLinks();
  const updateClusterLinks   = useUpdateClusterLinks();
  const { style }            = useTableViewStore();

  // Layout
  const [layout, setLayout] = useState<LayoutMode>(() =>
    (localStorage.getItem(LAYOUT_KEY) as LayoutMode) ?? 'table',
  );
  const changeLayout = (mode: string) => {
    setLayout(mode as LayoutMode);
    localStorage.setItem(LAYOUT_KEY, mode);
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

  // Data
  const [linkGroups,       setLinkGroups]       = useState<ClusterLinkGroup[]>([]);
  const [groupOrder,       setGroupOrder]        = useState<string[]>([]);
  const [addingTo,         setAddingTo]          = useState<string | null>(null);
  const [editingLink,      setEditingLink]       = useState<{ clusterId: string; link: ClusterLink } | null>(null);
  const [commonLinks,      setCommonLinks]       = useState<ClusterLink[]>([]);
  const [addingCommon,     setAddingCommon]      = useState(false);
  const [editingCommon,    setEditingCommon]     = useState<ClusterLink | null>(null);
  const [tableFormTarget,  setTableFormTarget]   = useState<string | null>(null); // 'common' | clusterId

  useEffect(() => {
    if (!linksData) return;
    setLinkGroups(linksData.clusterGroups || []);
    setCommonLinks(linksData.commonLinks  || []);
  }, [linksData]);

  const persist = (groups: ClusterLinkGroup[], common: ClusterLink[]) =>
    updateClusterLinks.mutate({ clusterGroups: groups, commonLinks: common });

  const allGroups: ClusterLinkGroup[] = clusters.map(c => {
    const ex = linkGroups.find(g => g.clusterId === c.id);
    return ex ?? { clusterId: c.id, clusterName: c.name, links: [] };
  });
  const orphanGroups = linkGroups.filter(g => !clusters.find(c => c.id === g.clusterId));
  const orderedGroups = groupOrder.length > 0
    ? [...allGroups].sort((a, b) => {
        const ia = groupOrder.indexOf(a.clusterId);
        const ib = groupOrder.indexOf(b.clusterId);
        if (ia === -1) return 1; if (ib === -1) return -1;
        return ia - ib;
      })
    : allGroups;


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

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const handleDragEnd = (ev: DragEndEvent) => {
    const { active, over } = ev;
    if (!over || active.id === over.id) return;
    const oi = orderedGroups.findIndex(g => g.clusterId === active.id);
    const ni = orderedGroups.findIndex(g => g.clusterId === over.id);
    setGroupOrder(arrayMove(orderedGroups, oi, ni).map(g => g.clusterId));
  };

  const upsert = (groups: ClusterLinkGroup[], g: ClusterLinkGroup) => {
    const i = groups.findIndex(x => x.clusterId === g.clusterId);
    if (i >= 0) { const n = [...groups]; n[i] = g; return n; }
    return [...groups, g];
  };

  const handleAddLink = (cid: string, cname: string, link: ClusterLink) => {
    const g = allGroups.find(x => x.clusterId === cid) ?? orphanGroups.find(x => x.clusterId === cid) ?? { clusterId: cid, clusterName: cname, links: [] };
    const next = upsert(linkGroups, { ...g, links: [...g.links, link] });
    setLinkGroups(next); persist(next, commonLinks);
    setAddingTo(null); setTableFormTarget(null);
  };
  const handleEditLink = (cid: string, cname: string, updated: ClusterLink) => {
    const g = allGroups.find(x => x.clusterId === cid) ?? orphanGroups.find(x => x.clusterId === cid) ?? { clusterId: cid, clusterName: cname, links: [] };
    const next = upsert(linkGroups, { ...g, links: g.links.map(l => l.id === updated.id ? updated : l) });
    setLinkGroups(next); persist(next, commonLinks); setEditingLink(null);
  };
  const handleDeleteLink = (cid: string, lid: string) => {
    const next = linkGroups.map(g => g.clusterId === cid ? { ...g, links: g.links.filter(l => l.id !== lid) } : g);
    setLinkGroups(next); persist(next, commonLinks);
  };
  const handleAddCommon = (link: ClusterLink) => {
    const next = [...commonLinks, link];
    setCommonLinks(next); persist(linkGroups, next);
    setAddingCommon(false); setTableFormTarget(null);
  };
  const handleEditCommon = (updated: ClusterLink) => {
    const next = commonLinks.map(l => l.id === updated.id ? updated : l);
    setCommonLinks(next); persist(linkGroups, next); setEditingCommon(null);
  };
  const handleDeleteCommon = (lid: string) => {
    if (!confirm('이 링크를 삭제하시겠습니까?')) return;
    const next = commonLinks.filter(l => l.id !== lid);
    setCommonLinks(next); persist(linkGroups, next);
  };

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
      <div key="h-common" className={`relative flex items-center gap-1.5 border-b border-r ${borderCls} px-3 py-2 bg-emerald-500/10 sticky top-0 z-10`}>
        <Globe className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
        <span className="font-semibold text-xs uppercase tracking-wider text-emerald-700 dark:text-emerald-300 truncate">공통 링크</span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums flex-shrink-0">({filteredCommonLinks.length})</span>
        <button onClick={() => { setTableFormTarget('common'); setEditingCommon(null); setEditingLink(null); }}
          className="ml-1 p-0.5 rounded text-emerald-600/60 dark:text-emerald-400/60 hover:text-emerald-700 dark:hover:text-emerald-300 hover:bg-emerald-500/15 transition-colors flex-shrink-0" title="공통 링크 추가" aria-label="공통 링크 추가">
          <Plus className="w-3 h-3" />
        </button>
        <ColResizeHandle colId="common" currentWidth={colW('common')} onResize={handleColResize} onResizeDone={handleColResizeDone} />
      </div>,
    );
    groups.forEach((g, idx) => {
      cells.push(
        <div key={`h-${g.clusterId}`}
          className={`relative flex items-center gap-1.5 border-b ${borderCls} px-3 py-2 ${hdrBg} sticky top-0 z-10${idx < groups.length - 1 ? ` border-r ${borderCls}` : ''}`}>
          <span className="text-sm leading-none text-primary">☸</span>
          <span className={`font-semibold text-xs uppercase tracking-wider truncate ${hdrText}`}>{g.clusterName}</span>
          <span className="ml-auto text-xs text-muted-foreground tabular-nums flex-shrink-0">({g.links.length})</span>
          <button onClick={() => { setTableFormTarget(g.clusterId); setEditingLink(null); setEditingCommon(null); }}
            className={`ml-1 p-0.5 rounded transition-colors flex-shrink-0 ${hdrText} opacity-60 hover:opacity-100 hover:bg-muted`} title="링크 추가" aria-label="링크 추가">
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
                <CompactLinkCell link={filteredCommonLinks[rowIdx]} fontClass={fontClass} fsClass={fsClass}
                  onEdit={() => { setEditingCommon(filteredCommonLinks[rowIdx]); setTableFormTarget(null); }}
                  onDelete={() => handleDeleteCommon(filteredCommonLinks[rowIdx].id)} />
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
                    onSave={updated => handleEditLink(g.clusterId, g.clusterName, updated)}
                    onCancel={() => setEditingLink(null)} />
                ) : (
                  <CompactLinkCell link={link} fontClass={fontClass} fsClass={fsClass}
                    onEdit={() => { setEditingLink({ clusterId: g.clusterId, link }); setTableFormTarget(null); }}
                    onDelete={() => { if (confirm(`"${link.label}" 링크를 삭제하시겠습니까?`)) handleDeleteLink(g.clusterId, link.id); }} />
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
                  onSave={link => handleAddLink(g.clusterId, g.clusterName, link)}
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
                  <span className="text-sm text-muted-foreground/70 w-28 truncate">{g.clusterName}</span>
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
    <div className="bg-card rounded-md border border-border overflow-hidden h-full flex flex-col">
      <div className="flex items-center px-4 py-2.5 border-b border-border bg-muted/40 gap-2">
        {!isOrphan && (
          <span {...dragHandle} className="cursor-grab active:cursor-grabbing p-0.5 rounded text-muted-foreground/50 hover:text-foreground hover:bg-secondary transition-colors" title="드래그하여 순서 변경">
            <GripVertical className="w-3.5 h-3.5" />
          </span>
        )}
        <span className="text-sm leading-none text-primary">☸</span>
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground select-none truncate">
          {g.clusterName}
        </span>
        {isOrphan && (
          <span className="text-xs text-muted-foreground/70 px-1.5 py-0.5 rounded bg-muted">삭제됨</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground/70 tabular-nums">{g.links.length}</span>
        {!isOrphan && (
          <button onClick={() => { setAddingTo(g.clusterId); setEditingLink(null); }}
            className="ml-2 px-2 py-1 text-xs font-medium bg-primary/10 hover:bg-primary/15 text-primary border border-primary/20 rounded-md transition-colors flex items-center gap-1"
            title="링크 추가">
            <Plus className="w-3 h-3" /> 추가
          </button>
        )}
      </div>
      <div className="p-4 space-y-2 flex-1">
        {addingTo === g.clusterId && (
          <LinkForm onSave={link => handleAddLink(g.clusterId, g.clusterName, link)} onCancel={() => setAddingTo(null)} />
        )}
        {g.links.length === 0 && addingTo !== g.clusterId ? (
          <EmptyState
            compact
            icon={Link2}
            title="등록된 링크가 없습니다"
            description={isOrphan ? '클러스터가 삭제되어 링크 추가가 비활성화되었습니다.' : undefined}
            action={isOrphan ? undefined : {
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
                    onSave={updated => handleEditLink(g.clusterId, g.clusterName, updated)}
                    onCancel={() => setEditingLink(null)} />
                ) : (
                  <LinkCard link={link}
                    onEdit={() => { setEditingLink({ clusterId: g.clusterId, link }); setAddingTo(null); }}
                    onDelete={() => { if (confirm(`"${link.label}" 링크를 삭제하시겠습니까?`)) handleDeleteLink(g.clusterId, link.id); }} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const noClusters = clusters.length === 0 && orphanGroups.length === 0;

  return (
    <div className="app-min-h-screen bg-background">
      <main className="mx-auto max-w-[1600px] px-5 md:px-8 py-6 md:py-8 space-y-3">
        {/* ── Hero / Header ─────────────────────────────────────────────── */}
        <MacCard bodyPadding="p-4 md:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <span
                aria-hidden="true"
                className="inline-flex items-center justify-center w-9 h-9 rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15 flex-shrink-0"
              >
                <Link2 className="w-4 h-4" />
              </span>
              <div className="min-w-0">
                <h1 className="text-lg font-semibold leading-tight truncate">클러스터 주요 링크</h1>
                <p className="text-sm text-muted-foreground mt-0.5">
                  운영 클러스터별 대시보드 · 모니터링 · 관리 콘솔을 한곳에서 빠르게 접근하세요.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <ViewModeBar modes={VIEW_MODES} active={layout} onChange={changeLayout} />
            </div>
          </div>

          {/* Stats row */}
          <div className="mt-4 grid grid-cols-3 gap-2">
            <StatTile label="전체 링크"   value={totalLinks} />
            <StatTile label="클러스터"    value={orderedGroups.length} />
            <StatTile label="공통 링크"   value={commonLinks.length} accent />
          </div>

          {/* Search */}
          <div className="mt-3 relative">
            <Search aria-hidden="true" className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              placeholder="링크 이름, 설명, URL 검색"
              aria-label="링크 검색"
              className="w-full rounded-lg border border-border bg-background pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors"
            />
          </div>
        </MacCard>

        {/* ── Empty: no clusters ────────────────────────────────────────── */}
        {noClusters ? (
          <MacCard bodyPadding="p-0">
            <EmptyState
              icon={Link2}
              title="등록된 클러스터가 없습니다"
              description="Settings에서 클러스터를 먼저 등록한 뒤 링크를 관리할 수 있습니다."
            />
          </MacCard>
        ) : layout === 'table' ? (
          /* ── Table view ── */
          renderTableView()
        ) : (
          /* ── Card views (vertical / horizontal) ── */
          <>
            {/* Common links section */}
            <MacCard bodyPadding="p-0">
              <div className="flex items-center px-4 py-2.5 border-b border-border bg-muted/40 gap-2">
                <Globe aria-hidden="true" className="w-3.5 h-3.5 text-emerald-500" />
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground select-none">
                  공통 서비스 링크
                </span>
                <span className="text-xs text-muted-foreground/70 tabular-nums">({filteredCommonLinks.length})</span>
                <button onClick={() => { setAddingCommon(true); setEditingCommon(null); }}
                  className="ml-auto px-2 py-1 text-xs font-medium bg-emerald-500/10 hover:bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 rounded-md transition-colors flex items-center gap-1">
                  <Plus className="w-3 h-3" /> 추가
                </button>
              </div>
              <div className="p-4 space-y-2">
                {addingCommon && <LinkForm onSave={handleAddCommon} onCancel={() => setAddingCommon(false)} />}
                {filteredCommonLinks.length === 0 && !addingCommon ? (
                  <EmptyState
                    compact
                    icon={Globe}
                    title="공통 링크가 없습니다"
                    description="모든 클러스터에서 공통으로 사용하는 링크를 등록하세요."
                    action={{ label: '+ 첫 번째 공통 링크 추가', variant: 'secondary', onClick: () => setAddingCommon(true) }}
                  />
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                    {filteredCommonLinks.map(link => (
                      <div key={link.id}>
                        {editingCommon?.id === link.id ? (
                          <LinkForm initial={link} onSave={handleEditCommon} onCancel={() => setEditingCommon(null)} />
                        ) : (
                          <LinkCard link={link}
                            onEdit={() => { setEditingCommon(link); setAddingCommon(false); }}
                            onDelete={() => handleDeleteCommon(link.id)} />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </MacCard>

            {/* Cluster groups */}
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext
                items={filteredOrderedGroups.map(g => g.clusterId)}
                strategy={layout === 'vertical' ? verticalListSortingStrategy : horizontalListSortingStrategy}
              >
                <div className={layout === 'horizontal' ? 'grid grid-cols-1 md:grid-cols-2 gap-3' : 'flex flex-col gap-3'}>
                  {filteredOrderedGroups.map(g => (
                    <SortableItem key={g.clusterId} id={g.clusterId}>
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
      </main>
    </div>
  );
}

// ── Small stat tile (header) ──────────────────────────────────────────────────
function StatTile({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums leading-tight ${accent ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground'}`}>
        {value}
      </p>
    </div>
  );
}
