import { useMemo, useState, type ComponentType } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Search, Pin, Terminal, AlertCircle, BookMarked,
  GitFork, StickyNote, AlertTriangle,
  Library, X, ChevronRight, ChevronUp, ChevronDown, ArrowUpDown,
  FileQuestion,
} from 'lucide-react';
import {
  opsNotesApi, commandsApi, workGuidesApi, workItemsApi, workflowsApi,
} from '@/services/api';
import type {
  OpsNote, CommandEntry, WorkGuide, WorkItem, Workflow, CommandImportance,
} from '@/types';
import { formatRelativeTime, stripHtml } from '@/lib/utils';
import { ServiceSidebar } from '@/components/common';
import { useServiceCatalog } from '@/hooks/useServiceCatalog';

// ── 통합 항목 모델 ───────────────────────────────────────────────────────────
type HubKind = 'note' | 'command' | 'guide' | 'item' | 'workflow';

interface HubItem {
  id: string;
  kind: HubKind;
  title: string;
  category?: string;
  service?: string;
  statusLabel?: string;
  statusTone?: 'amber' | 'emerald' | 'red' | 'slate' | 'primary' | 'sky';
  pinned?: boolean;
  updatedAt: string;
  href: string;
  searchBlob: string;
}

const KIND_META: Record<HubKind, {
  label: string;
  Icon: ComponentType<{ className?: string }>;
  accent: string;
  chip: string;
}> = {
  note:     { label: '노트',       Icon: StickyNote,    accent: 'text-amber-500',   chip: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30' },
  command:  { label: '명령어',     Icon: Terminal,      accent: 'text-sky-500',     chip: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/30' },
  guide:    { label: '가이드',     Icon: BookMarked,    accent: 'text-emerald-500', chip: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30' },
  item:     { label: '이슈',       Icon: AlertCircle,   accent: 'text-red-500',     chip: 'bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/30' },
  workflow: { label: '워크플로우', Icon: GitFork,       accent: 'text-violet-500',  chip: 'bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30' },
};

const STATUS_DOT_TONE: Record<NonNullable<HubItem['statusTone']>, string> = {
  amber:   'bg-amber-500',
  emerald: 'bg-emerald-500',
  red:     'bg-red-500',
  slate:   'bg-slate-400',
  primary: 'bg-primary',
  sky:     'bg-sky-500',
};

const STATUS_TEXT_TONE: Record<NonNullable<HubItem['statusTone']>, string> = {
  amber:   'text-amber-600 dark:text-amber-400',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  red:     'text-red-600 dark:text-red-400',
  slate:   'text-slate-600 dark:text-slate-400',
  primary: 'text-primary',
  sky:     'text-sky-600 dark:text-sky-400',
};

const IMPORTANCE_TONE: Record<CommandImportance, HubItem['statusTone']> = {
  info: 'slate',
  low: 'sky',
  medium: 'amber',
  high: 'amber',
  critical: 'red',
};

// ── 정렬 ─────────────────────────────────────────────────────────────────────
type SortKey = 'kind' | 'title' | 'category' | 'status' | 'updatedAt';
type SortDir = 'asc' | 'desc';

function SortTh({
  label, col, sortKey, sortDir, onSort, className,
}: {
  label: string;
  col: SortKey;
  sortKey: SortKey | '';
  sortDir: SortDir;
  onSort: (col: SortKey) => void;
  className?: string;
}) {
  const isActive = sortKey === col;
  return (
    <th
      onClick={() => onSort(col)}
      className={`px-4 py-3 text-left font-medium text-muted-foreground whitespace-nowrap cursor-pointer select-none group hover:text-foreground transition-colors ${className ?? ''}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive ? (
          sortDir === 'asc' ? <ChevronUp className="w-3 h-3 text-primary" /> : <ChevronDown className="w-3 h-3 text-primary" />
        ) : (
          <ArrowUpDown className="w-3 h-3 opacity-0 group-hover:opacity-40 transition-opacity" />
        )}
      </span>
    </th>
  );
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
export function KnowledgeHubPage() {
  const navigate = useNavigate();
  const services = useServiceCatalog();
  const [search, setSearch] = useState('');
  const [serviceFilter, setServiceFilter] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<HubKind | ''>('');
  const [openOnly, setOpenOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey | ''>('updatedAt');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const handleSort = (col: SortKey) => {
    if (sortKey === col) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(col); setSortDir('asc'); }
  };

  const { data: opsData,      isLoading: opsLoading      } = useQuery({ queryKey: ['ops-notes'],   queryFn: () => opsNotesApi.getAll().then((r) => r.data),    staleTime: 1000 * 30 });
  const { data: cmdData,      isLoading: cmdLoading      } = useQuery({ queryKey: ['commands'],    queryFn: () => commandsApi.list().then((r) => r.data),      staleTime: 1000 * 30 });
  const { data: guideData,    isLoading: guideLoading    } = useQuery({ queryKey: ['work-guides'], queryFn: () => workGuidesApi.getAll().then((r) => r.data),  staleTime: 1000 * 30 });
  const { data: issueData,    isLoading: issueLoading    } = useQuery({ queryKey: ['items'],       queryFn: () => workItemsApi.getAll().then((r) => r.data),   staleTime: 1000 * 30 });
  const { data: workflowData, isLoading: workflowLoading } = useQuery({ queryKey: ['workflows'],   queryFn: () => workflowsApi.getAll().then((r) => r.data),   staleTime: 1000 * 30 });

  const isLoading = opsLoading || cmdLoading || guideLoading || issueLoading || workflowLoading;

  const opsNotes  = useMemo<OpsNote[]>(()      => opsData?.data ?? [],      [opsData]);
  const commands  = useMemo<CommandEntry[]>(() => cmdData?.data ?? [],      [cmdData]);
  const guides    = useMemo<WorkGuide[]>(()    => guideData?.data ?? [],    [guideData]);
  const workItems = useMemo<WorkItem[]>(()     => issueData?.data ?? [],    [issueData]);
  const workflows = useMemo<Workflow[]>(()     => workflowData?.data ?? [], [workflowData]);

  // ── 5종을 단일 HubItem 배열로 정규화 ──
  const items: HubItem[] = useMemo<HubItem[]>(() => {
    const out: HubItem[] = [];

    for (const n of opsNotes) {
      out.push({
        id: `note-${n.id}`,
        kind: 'note',
        title: n.title,
        category: n.service,
        service: n.service,
        pinned: n.pinned,
        statusLabel: n.pinned ? '고정' : undefined,
        statusTone: n.pinned ? 'amber' : undefined,
        updatedAt: n.updatedAt,
        href: `/ops-notes/${n.id}`,
        searchBlob: `${n.title} ${stripHtml(n.content ?? '')} ${stripHtml(n.backContent ?? '')} ${n.author ?? ''} ${n.service}`.toLowerCase(),
      });
    }

    for (const c of commands) {
      out.push({
        id: `command-${c.id}`,
        kind: 'command',
        title: c.command,
        category: c.category ?? undefined,
        pinned: c.pinned,
        statusLabel: c.importance === 'critical' ? '치명' : c.importance === 'high' ? '높음' : c.importance === 'medium' ? '보통' : c.importance === 'low' ? '낮음' : '정보',
        statusTone: IMPORTANCE_TONE[c.importance],
        updatedAt: c.updatedAt,
        href: '/commands',
        searchBlob: `${c.command} ${c.description ?? ''} ${c.category ?? ''} ${c.tags ?? ''}`.toLowerCase(),
      });
    }

    for (const g of guides) {
      const tone: HubItem['statusTone'] = g.status === 'active' ? 'emerald' : g.status === 'archived' ? 'slate' : 'amber';
      const label = g.status === 'active' ? '활성' : g.status === 'archived' ? '보관' : '초안';
      out.push({
        id: `guide-${g.id}`,
        kind: 'guide',
        title: g.title,
        statusLabel: label,
        statusTone: tone,
        updatedAt: g.updatedAt,
        href: `/work-guides/${g.id}`,
        searchBlob: `${g.title} ${stripHtml(g.content ?? '')}`.toLowerCase(),
      });
    }

    for (const i of workItems) {
      if (i.type !== 'issue') continue;
      const resolved = !!i.closedAt;
      out.push({
        id: `item-${i.id}`,
        kind: 'item',
        title: i.content.split('\n')[0] || i.category,
        category: i.category,
        service: i.service,
        statusLabel: resolved ? '조치완료' : '미조치',
        statusTone: resolved ? 'emerald' : 'red',
        updatedAt: i.updatedAt,
        href: `/tasks-mgmt/${i.id}`,
        searchBlob: `${i.content} ${i.resolution ?? ''} ${i.category} ${i.assignee} ${i.clusterName ?? ''}`.toLowerCase(),
      });
    }

    for (const w of workflows) {
      out.push({
        id: `workflow-${w.id}`,
        kind: 'workflow',
        title: w.title,
        category: w.description ?? undefined,
        updatedAt: w.updatedAt,
        href: '/workflow',
        searchBlob: `${w.title} ${w.description ?? ''}`.toLowerCase(),
      });
    }

    return out;
  }, [opsNotes, commands, guides, workItems, workflows]);

  // ── 검색 + 필터 ──
  const trimmed = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    let list = items;
    if (serviceFilter) list = list.filter((it) => it.service === serviceFilter);
    if (kindFilter) list = list.filter((it) => it.kind === kindFilter);
    if (openOnly) list = list.filter((it) => it.kind === 'item' && it.statusLabel === '미조치');
    if (trimmed) list = list.filter((it) => it.searchBlob.includes(trimmed));
    return list;
  }, [items, serviceFilter, kindFilter, openOnly, trimmed]);

  // ── 정렬 ──
  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      let av: string = '';
      let bv: string = '';
      switch (sortKey) {
        case 'kind':       av = KIND_META[a.kind].label; bv = KIND_META[b.kind].label; break;
        case 'title':      av = a.title;                 bv = b.title; break;
        case 'category':   av = a.category ?? '';        bv = b.category ?? ''; break;
        case 'status':     av = a.statusLabel ?? '';     bv = b.statusLabel ?? ''; break;
        case 'updatedAt':  av = a.updatedAt;             bv = b.updatedAt; break;
      }
      return av.localeCompare(bv) * dir;
    });
  }, [filtered, sortKey, sortDir]);

  // 5종별 카운트 (필터 chip에 표시)
  const countByKind = useMemo<Record<HubKind, number>>(() => {
    const map: Record<HubKind, number> = { note: 0, command: 0, guide: 0, item: 0, workflow: 0 };
    for (const it of items) map[it.kind] += 1;
    return map;
  }, [items]);

  // 미해결 이슈 카운트 (kind='item' && 미조치)
  const openIssueCount = useMemo(
    () => items.filter((it) => it.kind === 'item' && it.statusLabel === '미조치').length,
    [items],
  );

  const hasFilters = !!serviceFilter || !!kindFilter || openOnly || !!trimmed;
  const clearFilters = () => { setServiceFilter(null); setKindFilter(''); setOpenOnly(false); setSearch(''); };

  return (
    // 메인 사이드바 바로 옆에 서비스 사이드바를 붙인다(공백 없이 flush). 본문은 flex-1.
    <div className="min-h-screen bg-background flex">
      <ServiceSidebar services={services} selectedKey={serviceFilter} onSelect={setServiceFilter} allLabel="전체 서비스" />
      <main className="flex-1 min-w-0 px-4 lg:px-6 py-5 space-y-4 max-w-[1600px]">
        {/* ── Page header ─────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
              <Library className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold leading-tight">지식 허브</h1>
              <p className="text-sm text-muted-foreground">
                운영 노트 · 명령어 · 작업 가이드 · 이슈 · 워크플로우를 한 대장에서.
              </p>
            </div>
          </div>
        </div>

        {/* ── Filter / Search bar ─────────────────────────────────────── */}
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3">
            <Search className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">필터</span>
            {hasFilters && (
              <button
                onClick={clearFilters}
                className="ml-auto flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-3 h-3" /> 초기화
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setKindFilter('')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-full border transition-colors ${
                !kindFilter
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background border-border text-muted-foreground hover:border-primary/50'
              }`}
            >
              전체 <span className="opacity-70">({items.length})</span>
            </button>
            {(Object.keys(KIND_META) as HubKind[]).map((k) => {
              const meta = KIND_META[k];
              const Icon = meta.Icon;
              const count = countByKind[k];
              const isActive = kindFilter === k;
              if (count === 0 && !isActive) return null;
              return (
                <button
                  key={k}
                  onClick={() => setKindFilter(isActive ? '' : k)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-full border transition-colors ${
                    isActive
                      ? `${meta.chip} border-transparent ring-1 ring-current/30`
                      : 'bg-background border-border text-muted-foreground hover:border-primary/50'
                  }`}
                >
                  <Icon className={`w-3.5 h-3.5 ${meta.accent}`} /> {meta.label}
                  <span className="opacity-70">({count})</span>
                </button>
              );
            })}

            {/* 미해결 이슈 빠른 필터 — kind='item' && statusLabel='미조치' 교차 필터 */}
            {(openIssueCount > 0 || openOnly) && (
              <button
                onClick={() => setOpenOnly((v) => !v)}
                title="미조치 상태인 이슈만 보기"
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-full border transition-colors ${
                  openOnly
                    ? 'bg-red-500/10 text-red-700 dark:text-red-300 border-red-500/40 ring-1 ring-red-500/30'
                    : 'bg-background border-border text-muted-foreground hover:border-red-500/50'
                }`}
              >
                <AlertCircle className={`w-3.5 h-3.5 ${openOnly ? 'text-red-500' : 'text-red-500/70'}`} />
                미해결 이슈
                <span className="opacity-70">({openIssueCount})</span>
              </button>
            )}

            <div className="ml-auto relative w-full sm:w-80">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="제목, 본문, 카테고리에서 찾기…"
                className="w-full pl-9 pr-8 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-secondary text-muted-foreground"
                  aria-label="검색어 지우기"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── Table (list) view ───────────────────────────────────────── */}
        {isLoading ? (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-14 border-b border-border last:border-b-0 animate-pulse bg-muted/30" />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="text-center py-20 bg-card border border-border rounded-xl">
            <FileQuestion className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
            <p className="text-muted-foreground mb-4">
              {hasFilters ? '검색 조건에 해당하는 지식 항목이 없습니다.' : '아직 등록된 지식 항목이 없습니다.'}
            </p>
            {hasFilters && (
              <button
                onClick={clearFilters}
                className="px-4 py-2 text-sm font-medium bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 rounded-lg transition-colors"
              >
                필터 초기화
              </button>
            )}
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="text-sm w-full">
                <colgroup>
                  <col style={{ width: '110px' }} />
                  <col />
                  <col style={{ width: '180px' }} />
                  <col style={{ width: '120px' }} />
                  <col style={{ width: '140px' }} />
                  <col style={{ width: '80px' }} />
                </colgroup>
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <SortTh label="종류"     col="kind"      sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                    <SortTh label="제목"     col="title"     sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                    <SortTh label="카테고리" col="category"  sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                    <SortTh label="상태"     col="status"    sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                    <SortTh label="업데이트" col="updatedAt" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />
                    <th className="px-4 py-3 text-center font-medium text-muted-foreground whitespace-nowrap">열기</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((it) => {
                    const meta = KIND_META[it.kind];
                    const KindIcon = meta.Icon;
                    return (
                      <tr
                        key={it.id}
                        onClick={() => navigate(it.href)}
                        className="border-b border-border last:border-b-0 hover:bg-muted/20 transition-colors cursor-pointer"
                      >
                        <td className="px-4 py-3 whitespace-nowrap">
                          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full border ${meta.chip}`}>
                            <KindIcon className="w-3 h-3" /> {meta.label}
                          </span>
                        </td>
                        <td className="px-4 py-3 min-w-0">
                          <div className="flex items-center gap-1.5">
                            {it.pinned && <Pin className="w-3 h-3 text-amber-500 flex-shrink-0" />}
                            <span className="line-clamp-1 font-medium text-foreground">{it.title}</span>
                            {it.kind === 'command' && it.statusTone === 'red' && (
                              <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {it.category ? (
                            <span className="line-clamp-1 text-sm text-muted-foreground">{it.category}</span>
                          ) : (
                            <span className="text-sm text-muted-foreground/40">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {it.statusLabel && it.statusTone ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span className={`w-2 h-2 rounded-full ${STATUS_DOT_TONE[it.statusTone]}`} />
                              <span className={`text-sm font-medium ${STATUS_TEXT_TONE[it.statusTone]}`}>{it.statusLabel}</span>
                            </span>
                          ) : (
                            <span className="text-sm text-muted-foreground/40">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-sm text-muted-foreground tabular-nums">
                          {formatRelativeTime(it.updatedAt)}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <ChevronRight className="w-4 h-4 text-muted-foreground/60 inline-block" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2 border-t border-border bg-muted/20 text-xs text-muted-foreground tabular-nums">
              총 {sorted.length}건{hasFilters && items.length !== sorted.length ? ` · 전체 ${items.length}건 중` : ''}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
