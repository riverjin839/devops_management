import { useMemo, type ComponentType } from 'react';
import { PageHeader } from '@/components/common/PageHeader';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Search, Pin, Terminal, AlertCircle, BookMarked,
  GitFork, StickyNote, AlertTriangle,
  Library, X, ChevronRight, ChevronUp, ChevronDown, ArrowUpDown,
  FileQuestion, ListTodo, Map as MapIcon, Share2, Rss,
} from 'lucide-react';
import {
  opsNotesApi, commandsApi, workGuidesApi, workItemsApi, workflowsApi,
} from '@/services/api';
import type {
  OpsNote, CommandEntry, WorkGuide, WorkItem, Workflow, CommandImportance,
} from '@/types';
import { formatRelativeTime, stripHtml, parseUTC } from '@/lib/utils';
import { ServiceSidebar, EmptyState, Skeleton, PageShell } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useServiceCatalog } from '@/hooks/useServiceCatalog';
import { useSprints } from '@/hooks/useSprints';
import { useUrlParams, pickParam } from '@/hooks/useUrlParams';
// 허브 탭으로 임베드하는 기존 도구 페이지들 (개별 메뉴는 제거됨)
import { OpsNotesPage } from './OpsNotesPage';
import { MindMapPage } from './MindMapPage';
import { OntologyPage } from './OntologyPage';
import { TrendDigestPage } from './TrendDigestPage';

// ── 통합 항목 모델 ───────────────────────────────────────────────────────────
type HubKind = 'task' | 'note' | 'command' | 'guide' | 'item' | 'workflow';

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
  sprintId?: string | null;
}

const KIND_META: Record<HubKind, {
  label: string;
  Icon: ComponentType<{ className?: string }>;
  accent: string;
  chip: string;
}> = {
  task:     { label: '업무',       Icon: ListTodo,      accent: 'text-chart-1-text', chip: 'bg-chart-1/15 text-chart-1-text border-chart-1/30' },
  note:     { label: '노트',       Icon: StickyNote,    accent: 'text-chart-3-text', chip: 'bg-chart-3/15 text-chart-3-text border-chart-3/30' },
  command:  { label: '명령어',     Icon: Terminal,      accent: 'text-chart-6-text', chip: 'bg-chart-6/15 text-chart-6-text border-chart-6/30' },
  guide:    { label: '가이드',     Icon: BookMarked,    accent: 'text-chart-2-text', chip: 'bg-chart-2/15 text-chart-2-text border-chart-2/30' },
  item:     { label: '이슈',       Icon: AlertCircle,   accent: 'text-chart-5-text', chip: 'bg-chart-5/15 text-chart-5-text border-chart-5/30' },
  workflow: { label: '워크플로', Icon: GitFork,       accent: 'text-chart-4-text', chip: 'bg-chart-4/15 text-chart-4-text border-chart-4/30' },
};

const STATUS_DOT_TONE: Record<NonNullable<HubItem['statusTone']>, string> = {
  amber:   'bg-status-warning',
  emerald: 'bg-muted-foreground/40',
  red:     'bg-status-critical',
  slate:   'bg-status-unknown',
  primary: 'bg-primary',
  sky:     'bg-status-info',
};

// 허브 상단 탭 — 지식 목록(집계 표) + 임베드 도구(Q&A·마인드맵·온톨로지·기술동향).
type HubTab = 'list' | 'qa' | 'mindmap' | 'ontology' | 'trends';
const HUB_TABS: { key: HubTab; label: string; Icon: ComponentType<{ className?: string }> }[] = [
  { key: 'list',     label: '지식 목록', Icon: Library },
  { key: 'qa',       label: 'Q&A 노트',  Icon: StickyNote },
  { key: 'mindmap',  label: '마인드맵',  Icon: MapIcon },
  { key: 'ontology', label: '온톨로지',  Icon: Share2 },
  { key: 'trends',   label: '기술동향',  Icon: Rss },
];

const HUB_TAB_KEYS: readonly HubTab[] = HUB_TABS.map((t) => t.key);
const HUB_KINDS: readonly (HubKind | '')[] = ['', 'task', 'note', 'command', 'guide', 'item', 'workflow'];

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

// ── 기간 필터 (주 / 월 / 분기) ──────────────────────────────────────────────
type PeriodFilter = '' | 'week' | 'month' | 'quarter';
const PERIOD_KEYS: readonly PeriodFilter[] = ['', 'week', 'month', 'quarter'];
const SORT_KEYS: readonly SortKey[] = ['kind', 'title', 'category', 'status', 'updatedAt'];
const PERIOD_META: { key: PeriodFilter; label: string }[] = [
  { key: 'week',    label: '이번 주' },
  { key: 'month',   label: '이번 달' },
  { key: 'quarter', label: '이번 분기' },
];

function periodStart(period: PeriodFilter): Date | null {
  const now = new Date();
  if (period === 'week') {
    const day = now.getDay() === 0 ? 7 : now.getDay(); // 월요일 시작
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(now.getDate() - (day - 1));
    return start;
  }
  if (period === 'month') {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  if (period === 'quarter') {
    const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
    return new Date(now.getFullYear(), qStartMonth, 1);
  }
  return null;
}

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
  // 탭·필터·검색어·정렬은 URL 쿼리에 둔다(D-029) — 새로고침·링크 공유·항목 상세에서 뒤로가기로
  // 돌아와도 같은 조건이 열린다. 허브 탭에 임베드되는 하위 화면(Q&A 노트·온톨로지)은 임베드
  // 상태에서 로컬 state 를 쓰므로 이 키들과 섞이지 않는다.
  const [p, setP] = useUrlParams({
    tab: 'list', q: '', service: '', kind: '', open: '', period: '', sprint: '', sort: 'updatedAt', dir: 'desc',
  });
  const search = p.q;
  const setSearch = (v: string) => setP({ q: v });
  const serviceFilter = p.service || null;
  const setServiceFilter = (v: string | null) => setP({ service: v });
  const kindFilter = pickParam(p.kind, HUB_KINDS, '');
  const setKindFilter = (v: HubKind | '') => setP({ kind: v });
  const openOnly = p.open === '1';
  const periodFilter = pickParam(p.period, PERIOD_KEYS, '');
  const setPeriodFilter = (v: PeriodFilter) => setP({ period: v });
  const sprintFilter = p.sprint;
  const sortKey: SortKey | '' = pickParam(p.sort, SORT_KEYS, 'updatedAt');
  const sortDir = pickParam<SortDir>(p.dir, ['asc', 'desc'], 'desc');

  const { data: sprintData } = useSprints();
  const sprints = useMemo(() => sprintData?.data ?? [], [sprintData]);

  const handleSort = (col: SortKey) => {
    if (sortKey === col) setP({ dir: sortDir === 'asc' ? 'desc' : 'asc' });
    else setP({ sort: col, dir: 'asc' });
  };

  const { data: opsData,      isLoading: opsLoading      } = useQuery({ queryKey: ['ops-notes'],   queryFn: () => opsNotesApi.getAll().then((r) => r.data),    staleTime: 1000 * 30 });
  const { data: cmdData,      isLoading: cmdLoading      } = useQuery({ queryKey: ['commands'],    queryFn: () => commandsApi.list().then((r) => r.data),      staleTime: 1000 * 30 });
  const { data: guideData,    isLoading: guideLoading    } = useQuery({ queryKey: ['work-guides'], queryFn: () => workGuidesApi.getAll().then((r) => r.data),  staleTime: 1000 * 30 });
  // 기간/스프린트 필터가 로드된 목록 전체를 대상으로 동작하도록 백엔드 최대 limit(500)까지 요청.
  const { data: issueData,    isLoading: issueLoading    } = useQuery({ queryKey: ['items'],       queryFn: () => workItemsApi.getAll({ limit: 500 }).then((r) => r.data),   staleTime: 1000 * 30 });
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
        statusTone: n.pinned ? 'primary' : undefined,
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
      const resolved = !!i.closedAt;
      const isIssue = i.type === 'issue';
      out.push({
        id: `${isIssue ? 'item' : 'task'}-${i.id}`,
        kind: isIssue ? 'item' : 'task',
        title: (i.title?.trim() || i.content.split('\n')[0] || i.category),
        category: i.category,
        service: i.service,
        statusLabel: resolved ? '완료' : isIssue ? '미조치' : '진행',
        statusTone: resolved ? 'emerald' : isIssue ? 'red' : 'amber',
        updatedAt: i.updatedAt,
        href: `/tasks-mgmt/${i.id}`,
        searchBlob: `${i.content} ${i.resolution ?? ''} ${i.category} ${i.assignee} ${i.clusterName ?? ''}`.toLowerCase(),
        sprintId: i.sprintId ?? null,
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
    if (periodFilter) {
      const start = periodStart(periodFilter);
      if (start) list = list.filter((it) => parseUTC(it.updatedAt) >= start);
    }
    if (sprintFilter) list = list.filter((it) => it.sprintId === sprintFilter);
    if (trimmed) list = list.filter((it) => it.searchBlob.includes(trimmed));
    return list;
  }, [items, serviceFilter, kindFilter, openOnly, periodFilter, sprintFilter, trimmed]);

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
    const map: Record<HubKind, number> = { task: 0, note: 0, command: 0, guide: 0, item: 0, workflow: 0 };
    for (const it of items) map[it.kind] += 1;
    return map;
  }, [items]);

  // 미해결 이슈 카운트 (kind='item' && 미조치)
  const openIssueCount = useMemo(
    () => items.filter((it) => it.kind === 'item' && it.statusLabel === '미조치').length,
    [items],
  );

  const hasFilters = !!serviceFilter || !!kindFilter || openOnly || !!periodFilter || !!sprintFilter || !!trimmed;
  const clearFilters = () => {
    setP({ service: null, kind: null, open: null, period: null, sprint: null, q: null });
  };

  const tab = pickParam(p.tab, HUB_TAB_KEYS, 'list');
  const setTab = (v: HubTab) => setP({ tab: v });

  return (
    // 메인 사이드바 바로 옆에 서비스 사이드바를 붙인다(공백 없이 flush). 본문은 flex-1.
    <div className="app-min-h-screen bg-background flex">
      {tab === 'list' && (
        <ServiceSidebar services={services} selectedKey={serviceFilter} onSelect={setServiceFilter} allLabel="전체 서비스" />
      )}
      <main className="flex-1 min-w-0">
        {/* ── 헤더 + 탭 ─────────────────────────────────────────────── */}
        <div className="px-4 lg:px-6 pt-5 pb-2 border-b border-border">
          <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
            <PageHeader
              icon={Library}
              title="지식 허브"
              description="업무 · 노트 · 명령어 · 가이드 · 이슈 · 워크플로 + 분석 도구를 한 곳에서."
              className="flex-1 min-w-0"
            />
          </div>
          {/* 탭 바 */}
          <div className="flex items-center gap-1 flex-wrap">
            {HUB_TABS.map((t) => {
              const TabIcon = t.Icon;
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border-b-2 transition-colors ${
                    active ? 'text-primary border-primary' : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-secondary'
                  }`}
                >
                  <TabIcon className="w-3.5 h-3.5" /> {t.label}
                </button>
              );
            })}
          </div>
        </div>

        {tab !== 'list' ? (
          // 임베드 도구 — 자체 레이아웃을 가진 기존 페이지를 그대로 렌더.
          tab === 'qa' ? <OpsNotesPage /> :
          tab === 'mindmap' ? <MindMapPage /> :
          tab === 'ontology' ? <OntologyPage embedded /> :
          <TrendDigestPage />
        ) : (
        <PageShell density="hub" as="div">
        {/* ── 필터·검색 바 + 목록 — D-122: 툴바 전용 카드를 걷고 목록 카드의 헤더 바로 올림 ── */}
        <MacCard
          bodyPadding="p-0"
          actions={
            <>
            {hasFilters && (
              <div className="w-full flex items-center justify-end">
                <button
                  onClick={clearFilters}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="w-3 h-3" /> 초기화
                </button>
              </div>
            )}

            <div className="w-full flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setKindFilter('')}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-full border transition-colors ${
                  !kindFilter
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background border-border text-muted-foreground hover:border-primary/50'
                }`}
              >
                전체 <span className="tabular-nums">({items.length})</span>
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
                    <span className="tabular-nums">({count})</span>
                  </button>
                );
              })}

              {/* 미해결 이슈 빠른 필터 — kind='item' && statusLabel='미조치' 교차 필터 */}
              {(openIssueCount > 0 || openOnly) && (
                <button
                  onClick={() => setP({ open: openOnly ? '' : '1' })}
                  title="미조치 상태인 이슈만 보기"
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-full border transition-colors ${
   openOnly
   ? 'bg-status-critical/10 text-status-critical border-status-critical/40 ring-1 ring-status-critical/30'
   : 'bg-background border-border text-muted-foreground hover:border-status-critical/50'
   }`}
                >
                  <AlertCircle className={`w-3.5 h-3.5 ${openOnly ? 'text-status-critical' : 'text-status-critical/70'}`} />
                  미해결 이슈
                  <span className="tabular-nums">({openIssueCount})</span>
                </button>
              )}

              <div className="w-px h-5 bg-border mx-1" />

              {/* 기간 필터 — 주 / 월 / 분기 (updatedAt 기준) */}
              {PERIOD_META.map(({ key, label }) => {
                const isActive = periodFilter === key;
                return (
                  <button
                    key={key}
                    onClick={() => setPeriodFilter(isActive ? '' : key)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-full border transition-colors ${
                      isActive
                        ? 'bg-primary/10 text-primary border-primary/40 ring-1 ring-primary/30'
                        : 'bg-background border-border text-muted-foreground hover:border-primary/50'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}

              {/* 스프린트 필터 — sprintId 매칭 (업무/이슈에만 적용) */}
              {sprints.length > 0 && (
                <select
                  value={sprintFilter}
                  onChange={(e) => setP({ sprint: e.target.value })}
                  className={`px-3 py-1.5 text-sm font-medium rounded-full border bg-background focus:outline-none focus:ring-2 focus:ring-primary/40 ${
                    sprintFilter ? 'text-primary border-primary/40' : 'text-muted-foreground border-border'
                  }`}
                >
                  <option value="">스프린트 전체</option>
                  {sprints.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
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
            </>
          }
        >
          {/* ── Table (list) view ───────────────────────────────────────── */}
          {isLoading ? (
            [...Array(6)].map((_, i) => (
              <div key={i} className="h-14 px-4 flex items-center border-b border-border last:border-b-0">
                <Skeleton className="block w-full h-4 rounded" />
              </div>
            ))
          ) : sorted.length === 0 ? (
            <EmptyState
              icon={FileQuestion}
              title={hasFilters ? '검색 조건에 해당하는 지식 항목이 없습니다.' : '아직 등록된 지식 항목이 없습니다.'}
              description={hasFilters ? '검색어나 필터를 바꿔 보세요.' : '업무·노트·명령어·가이드를 등록하면 여기에 모입니다.'}
              action={hasFilters ? { label: '필터 초기화', onClick: clearFilters, variant: 'secondary' } : undefined}
            />
          ) : (
            <>
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
                              {it.pinned && <Pin className="w-3 h-3 text-status-warning flex-shrink-0" />}
                              <span className="line-clamp-1 font-medium text-foreground">{it.title}</span>
                              {it.kind === 'command' && it.statusTone === 'red' && (
                                <AlertTriangle className="w-3.5 h-3.5 text-status-critical flex-shrink-0" />
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
                                <span className="text-sm font-medium text-foreground">{it.statusLabel}</span>
                              </span>
                            ) : (
                              <span className="text-sm text-muted-foreground/40">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-sm text-muted-foreground tabular-nums">
                            {formatRelativeTime(it.updatedAt)}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <ChevronRight className="w-4 h-4 text-muted-foreground inline-block" />
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
            </>
          )}
        </MacCard>
        </PageShell>
        )}
      </main>
    </div>
  );
}
