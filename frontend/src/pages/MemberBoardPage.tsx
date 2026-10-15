import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, User, Search, X, ClipboardList, ListTodo, Mail, Hash, ChevronDown, ChevronUp, Copy } from 'lucide-react';
import { useAssignees } from '@/hooks/useAssignees';
import { useWorkItems } from '@/hooks/useWorkItems';
import { useToast, EmptyState, PageHeader, PageShell } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useAuthStore } from '@/stores/authStore';
import type { WorkItem, Assignee } from '@/types';

// ── 상태 스타일 ──────────────────────────────────────────────────────────────

const KANBAN_STYLE: Record<string, { label: string; cls: string }> = {
  backlog:     { label: 'Backlog',  cls: 'bg-chart-8/10 text-chart-8 border-chart-8/30' },
  todo:        { label: 'To Do',    cls: 'bg-chart-1/10 text-chart-1 border-chart-1/30' },
  in_progress: { label: 'WIP',      cls: 'bg-chart-3/10 text-chart-3 border-chart-3/30' },
  review_test: { label: 'Review',   cls: 'bg-chart-4/10 text-chart-4 border-chart-4/30' },
  done:        { label: 'Done',     cls: 'bg-secondary text-muted-foreground border-border' },
};

const PRIORITY_DOT: Record<string, string> = {
  high:   'bg-status-critical',
  medium: 'bg-chart-1',
  low:    'bg-chart-8',
};

// ── 유틸 ────────────────────────────────────────────────────────────────────

function formatDate(s?: string | null): string {
  if (!s) return '-';
  return s.slice(0, 10);
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '').trim();
}

// ── 기간(주) 범위 헬퍼 ────────────────────────────────────────────────────────
type Period = 'all' | 'thisWeek' | 'lastWeek';

/** 해당 날짜가 속한 주의 월요일 0시. */
function startOfWeekMon(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  const day = r.getDay();                 // 0=일 … 6=토
  r.setDate(r.getDate() + (day === 0 ? -6 : 1 - day));
  return r;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** period → [start, end) (ms). 'all' 이면 null. */
function weekRange(period: Period): { start: number; end: number } | null {
  if (period === 'all') return null;
  const thisMon = startOfWeekMon(new Date());
  if (period === 'thisWeek') return { start: thisMon.getTime(), end: addDays(thisMon, 7).getTime() };
  return { start: addDays(thisMon, -7).getTime(), end: thisMon.getTime() };
}

/** 업무가 해당 주에 "진행 또는 완료"되었는지 — [시작, 완료(또는 오늘)] 구간이 주와 겹치면 true.
 *  시작일이 없으면(미착수) 제외. */
function activeInRange(item: WorkItem, range: { start: number; end: number }): boolean {
  const s = item.startedAt?.slice(0, 10);
  if (!s) return false;
  const startedMs = Date.parse(s);
  if (Number.isNaN(startedMs)) return false;
  const closed = item.closedAt?.slice(0, 10);
  const endMs = closed ? Date.parse(closed) : Date.now();
  return startedMs < range.end && endMs >= range.start;
}

const PERIOD_LABEL: Record<Period, string> = { all: '전체 기간', thisWeek: '이번 주', lastWeek: '지난 주' };

function fmtRange(range: { start: number; end: number } | null): string {
  if (!range) return '';
  const a = new Date(range.start);
  const b = new Date(range.end - 86400000); // 마지막 포함일
  const f = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${f(a)} ~ ${f(b)}`;
}

interface MemberBucket {
  assignee: string;
  info?: Assignee;
  tasks: WorkItem[];
  issues: WorkItem[];
  openTasks: number;
  doneTasks: number;
  unresolvedIssues: number;
  resolvedIssues: number;
}

// "나만 / 전체" 보기 범위 (당일 스케줄과 동일한 패턴).
type ScopeMode = 'me' | 'all';

/** 버킷이 로그인 본인인지 — 업무 등록 폼의 담당자 기본값과 같은 공식(displayName→username),
 *  양쪽 trim, 사번(employeeId) 매칭 보조. */
function bucketIsMine(b: MemberBucket, myName: string, myId: string): boolean {
  const name = b.assignee.trim();
  if (myName && name === myName) return true;
  if (myId && (name === myId || (b.info?.employeeId ?? '').trim() === myId)) return true;
  return false;
}

// ── 멤버별 섹션 ──────────────────────────────────────────────────────────────

function MemberSection({ bucket, onTaskClick, onIssueClick }: {
  bucket: MemberBucket;
  onTaskClick: (t: WorkItem) => void;
  onIssueClick: (i: WorkItem) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <MacCard
      title={bucket.assignee}
      icon={User}
      description={(bucket.info?.employeeId || bucket.info?.email || bucket.info?.primaryRole) && (
        <span className="inline-flex items-center gap-2">
          {bucket.info?.employeeId && (
            <span className="inline-flex items-center gap-0.5"><Hash className="w-2.5 h-2.5" />{bucket.info.employeeId}</span>
          )}
          {bucket.info?.email && (
            <span className="inline-flex items-center gap-0.5"><Mail className="w-2.5 h-2.5" />{bucket.info.email}</span>
          )}
          {bucket.info?.primaryRole && (
            <span>{bucket.info.primaryRole}</span>
          )}
        </span>
      )}
      bodyPadding="p-0"
      actions={
        <>
          <span className="text-sm px-2 py-0.5 rounded-full bg-chart-1/10 text-chart-1 border border-chart-1/30">
            작업 {bucket.tasks.length} (진행 {bucket.openTasks} / 완료 {bucket.doneTasks})
          </span>
          <span className="text-sm px-2 py-0.5 rounded-full bg-status-warning/10 text-status-warning border border-status-warning/30">
            이슈 {bucket.issues.length} (미조치 {bucket.unresolvedIssues} / 완료 {bucket.resolvedIssues})
          </span>
          <button
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? '접기' : '펼치기'}
            className="p-1.5 hover:bg-secondary rounded text-muted-foreground"
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </>
      }
    >
      {/* 본문 */}
      {expanded && (
        <div className="grid grid-cols-1 md:grid-cols-2 divide-x divide-border">
          {/* 작업 */}
          <div className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <ListTodo className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium text-muted-foreground">작업</span>
            </div>
            {bucket.tasks.length === 0 ? (
              <EmptyState compact icon={ListTodo} title="할당된 작업이 없습니다." description="이 멤버를 담당자로 지정한 작업이 아직 없습니다." />
            ) : (
              <ul className="space-y-1">
                {bucket.tasks.slice(0, 10).map((t) => {
                  const ks = KANBAN_STYLE[t.kanbanStatus] ?? KANBAN_STYLE.todo;
                  return (
                    <li
                      key={t.id}
                      onClick={() => onTaskClick(t)}
                      className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted/40 cursor-pointer group"
                    >
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PRIORITY_DOT[t.priority] ?? 'bg-chart-8'}`} />
                      <span className={`text-xs px-1.5 py-0.5 rounded-full border flex-shrink-0 ${ks.cls}`}>{ks.label}</span>
                      <span className="text-sm text-foreground truncate flex-1" title={stripHtml(t.content)}>
                        {stripHtml(t.content) || t.category}
                      </span>
                      <span className="text-xs font-mono text-muted-foreground flex-shrink-0">
                        {formatDate(t.startedAt)}
                      </span>
                    </li>
                  );
                })}
                {bucket.tasks.length > 10 && (
                  <li className="text-xs text-muted-foreground text-center pt-1">
                    + {bucket.tasks.length - 10}개 더...
                  </li>
                )}
              </ul>
            )}
          </div>

          {/* 이슈 */}
          <div className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <ClipboardList className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm font-medium text-muted-foreground">이슈</span>
            </div>
            {bucket.issues.length === 0 ? (
              <EmptyState compact icon={ClipboardList} title="할당된 이슈가 없습니다." description="이 멤버를 담당자로 지정한 이슈가 아직 없습니다." />
            ) : (
              <ul className="space-y-1">
                {bucket.issues.slice(0, 10).map((i) => (
                  <li
                    key={i.id}
                    onClick={() => onIssueClick(i)}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/40 cursor-pointer"
                  >
                    <span className={`text-xs px-1.5 py-0.5 rounded-full border flex-shrink-0 ${
                      i.closedAt
                        ? 'bg-secondary text-muted-foreground border-border'
                        : 'bg-status-warning/10 text-status-warning border-status-warning/30'
                    }`}>
                      {i.closedAt ? '완료' : '미조치'}
                    </span>
                    <span className="text-sm text-foreground truncate flex-1" title={stripHtml(i.content)}>
                      {i.category}: {stripHtml(i.content)}
                    </span>
                    <span className="text-xs font-mono text-muted-foreground flex-shrink-0">
                      {formatDate(i.startedAt)}
                    </span>
                  </li>
                ))}
                {bucket.issues.length > 10 && (
                  <li className="text-xs text-muted-foreground text-center pt-1">
                    + {bucket.issues.length - 10}개 더...
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
      )}
    </MacCard>
  );
}

// ── 텍스트 일괄 복사 ──────────────────────────────────────────────────────────

/** 현재 필터된 멤버 버킷들을 사람이 읽기 좋은 plain text 로 직렬화. */
function buildCopyText(buckets: MemberBucket[], periodLabel: string, rangeLabel: string): string {
  const lines: string[] = [];
  lines.push(`[멤버별 업무] ${periodLabel}${rangeLabel ? ` (${rangeLabel})` : ''}`);
  lines.push('');
  for (const b of buckets) {
    lines.push(`■ ${b.assignee} — 작업 ${b.tasks.length} (진행 ${b.openTasks} / 완료 ${b.doneTasks}) · 이슈 ${b.issues.length} (미조치 ${b.unresolvedIssues} / 완료 ${b.resolvedIssues})`);
    if (b.tasks.length) {
      lines.push('  [작업]');
      for (const t of b.tasks) {
        const ks = KANBAN_STYLE[t.kanbanStatus]?.label ?? t.kanbanStatus;
        const period = `${formatDate(t.startedAt)}${t.closedAt ? ` ~ ${formatDate(t.closedAt)}` : ''}`;
        lines.push(`   - ${ks} | ${stripHtml(t.content) || t.category || '(제목 없음)'} (${period})`);
      }
    }
    if (b.issues.length) {
      lines.push('  [이슈]');
      for (const i of b.issues) {
        lines.push(`   - ${i.closedAt ? '완료' : '미조치'} | ${i.category ? `${i.category}: ` : ''}${stripHtml(i.content)} (${formatDate(i.startedAt)})`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

// ── 메인 페이지 ──────────────────────────────────────────────────────────────

type MemberFilter = 'all' | 'active' | 'withOpen';

export function MemberBoardPage() {
  const navigate = useNavigate();
  const { data: assignees = [] } = useAssignees();
  const { data: workItemsData } = useWorkItems();
  const toast = useToast();
  const me = useAuthStore((s) => s.user);

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<MemberFilter>('active');
  const [period, setPeriod] = useState<Period>('all');
  const [includeSecondary, setIncludeSecondary] = useState(false);

  // 보기 범위: 나만 / 전체 — 당일 스케줄과 동일하게 사용자별 localStorage 저장, 기본 '나만'.
  const scopeKey = `k8s:memberBoardScope:${me?.username ?? 'guest'}`;
  const [scope, setScope] = useState<ScopeMode>(() => {
    try { return localStorage.getItem(scopeKey) === 'all' ? 'all' : 'me'; } catch { return 'me'; }
  });
  useEffect(() => {
    try { setScope(localStorage.getItem(scopeKey) === 'all' ? 'all' : 'me'); } catch { /* noop */ }
  }, [scopeKey]);
  const changeScope = (next: ScopeMode) => {
    setScope(next);
    try { localStorage.setItem(scopeKey, next); } catch { /* noop */ }
  };

  const range = useMemo(() => weekRange(period), [period]);

  const buckets = useMemo<MemberBucket[]>(() => {
    const allItems = workItemsData?.data ?? [];
    const tasksAll  = allItems.filter((w) => w.type === 'task');
    const issuesAll = allItems.filter((w) => w.type === 'issue');

    // 담당자 필드에 쉼표로 여러 명이 들어올 수 있다 (예: "A,B") — 한 명씩 분리해 집계.
    const splitNames = (s?: string | null) =>
      s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [];

    // 담당자 이름 집합 = 등록된 Assignee + 작업/이슈에 실제로 등장한 이름
    const nameSet = new Set<string>();
    for (const a of assignees) nameSet.add(a.name);
    for (const t of tasksAll) {
      for (const n of splitNames(t.primaryAssignee)) nameSet.add(n);
      if (includeSecondary) for (const n of splitNames(t.secondaryAssignee)) nameSet.add(n);
    }
    for (const i of issuesAll) {
      for (const n of splitNames(i.primaryAssignee)) nameSet.add(n);
      if (includeSecondary) for (const n of splitNames(i.secondaryAssignee)) nameSet.add(n);
    }

    const assigneeByName = new Map(assignees.map((a) => [a.name, a]));
    const list: MemberBucket[] = [];

    for (const name of nameSet) {
      let memberTasks = tasksAll.filter(
        (t) => splitNames(t.primaryAssignee).includes(name) || (includeSecondary && splitNames(t.secondaryAssignee).includes(name)),
      );
      let memberIssues = issuesAll.filter(
        (i) => splitNames(i.primaryAssignee).includes(name) || (includeSecondary && splitNames(i.secondaryAssignee).includes(name)),
      );
      // 기간 필터 — 선택한 주에 진행/완료된 건만.
      if (range) {
        memberTasks = memberTasks.filter((t) => activeInRange(t, range));
        memberIssues = memberIssues.filter((i) => activeInRange(i, range));
      }
      list.push({
        assignee: name,
        info: assigneeByName.get(name),
        tasks: memberTasks,
        issues: memberIssues,
        openTasks: memberTasks.filter((t) => t.kanbanStatus !== 'done').length,
        doneTasks: memberTasks.filter((t) => t.kanbanStatus === 'done').length,
        unresolvedIssues: memberIssues.filter((i) => !i.closedAt).length,
        resolvedIssues: memberIssues.filter((i) => i.closedAt).length,
      });
    }

    // 정렬: 본인 최상단 → 열린 작업/이슈 많은 순 → 이름순
    const myName = (me?.displayName?.trim() || me?.username?.trim() || '');
    const myId = (me?.username ?? '').trim();
    list.sort((a, b) => {
      const am = me && bucketIsMine(a, myName, myId) ? 1 : 0;
      const bm = me && bucketIsMine(b, myName, myId) ? 1 : 0;
      if (am !== bm) return bm - am;
      return (b.openTasks + b.unresolvedIssues) - (a.openTasks + a.unresolvedIssues)
        || a.assignee.localeCompare(b.assignee);
    });

    return list;
  }, [assignees, workItemsData, includeSecondary, range, me]);

  const filtered = useMemo(() => {
    let list = buckets;
    // '나만' 범위 — 본인 버킷만. (이름 매칭 실패 시 빈 목록 → 안내 후 '전체' 전환 유도)
    if (scope === 'me') {
      const myName = (me?.displayName?.trim() || me?.username?.trim() || '');
      const myId = (me?.username ?? '').trim();
      list = list.filter((b) => bucketIsMine(b, myName, myId));
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((b) =>
        b.assignee.toLowerCase().includes(q)
        || (b.info?.employeeId ?? '').toLowerCase().includes(q)
        || (b.info?.email ?? '').toLowerCase().includes(q)
        || (b.info?.primaryRole ?? '').toLowerCase().includes(q),
      );
    }
    if (filter === 'active') {
      list = list.filter((b) => b.tasks.length > 0 || b.issues.length > 0);
    } else if (filter === 'withOpen') {
      list = list.filter((b) => b.openTasks > 0 || b.unresolvedIssues > 0);
    }
    return list;
  }, [buckets, search, filter, scope, me]);

  const totalOpen = buckets.reduce((acc, b) => acc + b.openTasks + b.unresolvedIssues, 0);

  const handleCopy = async () => {
    if (filtered.length === 0) { toast.info('복사할 내용이 없습니다.'); return; }
    const text = buildCopyText(filtered, PERIOD_LABEL[period], fmtRange(range));
    const itemCount = filtered.reduce((n, b) => n + b.tasks.length + b.issues.length, 0);
    try {
      await navigator.clipboard.writeText(text);
      toast.success('클립보드에 복사됨', `멤버 ${filtered.length}명 · ${itemCount}건`);
    } catch {
      toast.error('복사 실패', '브라우저 클립보드 권한을 확인하세요.');
    }
  };

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="hub" className="space-y-5">
        {/* 헤더 */}
        <PageHeader
          icon={Users}
          title="멤버별 업무"
          titleExtra={<>
            <span className="text-sm px-2 py-0.5 rounded-full bg-status-unknown/15 text-status-unknown border border-status-unknown/30">
              멤버 {filtered.length} / 전체 {buckets.length}
            </span>
            {totalOpen > 0 && (
              <span className="text-sm px-2 py-0.5 rounded-full bg-status-warning/10 text-status-warning border border-status-warning/30">
                진행중 합계 {totalOpen}
              </span>
            )}
          </>}
        />

        {/* 필터 — D-122: 툴바만 감싸던 카드를 걷음 */}
        <div className="flex flex-wrap items-center gap-3">
          {/* 보기 범위: 나만 / 전체 (당일 스케줄과 동일) */}
          <div className="flex items-center rounded-lg border border-border overflow-hidden text-sm">
            <button
              onClick={() => changeScope('me')}
              aria-pressed={scope === 'me'}
              className={`flex items-center gap-1 px-3 py-1.5 transition-colors ${
                scope === 'me' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground'
              }`}
            >
              <User className="w-3.5 h-3.5" /> 나만
            </button>
            <button
              onClick={() => changeScope('all')}
              aria-pressed={scope === 'all'}
              className={`flex items-center gap-1 px-3 py-1.5 border-l border-border transition-colors ${
                scope === 'all' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground'
              }`}
            >
              <Users className="w-3.5 h-3.5" /> 전체
            </button>
          </div>
          <div className="flex-1 min-w-[220px] relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="이름 / 사번 / 이메일 / 역할 검색"
              className="w-full pl-8 pr-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div className="flex items-center bg-secondary/60 rounded-lg p-[3px] gap-px">
            {(['all', 'active', 'withOpen'] as MemberFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  filter === f
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {f === 'all' ? '전체 멤버' : f === 'active' ? '업무 있음' : '미완료 있음'}
              </button>
            ))}
          </div>
          {/* 기간 필터 — 그 주에 진행/완료된 업무만 */}
          <div className="flex items-center bg-secondary/60 rounded-lg p-[3px] gap-px">
            {(['all', 'thisWeek', 'lastWeek'] as Period[]).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  period === p
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {PERIOD_LABEL[p]}
              </button>
            ))}
          </div>
          {range && (
            <span className="text-xs font-mono text-muted-foreground">{fmtRange(range)}</span>
          )}
          <button
            onClick={handleCopy}
            title="현재 목록을 텍스트로 클립보드에 복사"
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border border-border bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors"
          >
            <Copy className="w-3.5 h-3.5" /> 텍스트 복사
          </button>
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeSecondary}
              onChange={(e) => setIncludeSecondary(e.target.checked)}
              className="w-3.5 h-3.5 accent-primary"
            />
            부 담당자도 포함
          </label>
          {(search || filter !== 'active' || period !== 'all') && (
            <button
              onClick={() => { setSearch(''); setFilter('active'); setPeriod('all'); }}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-3 h-3" />
              초기화
            </button>
          )}
        </div>

        {/* 멤버 섹션 리스트 */}
        {filtered.length === 0 ? (
          <EmptyState
            icon={Users}
            title={scope === 'me' ? (me ? '내 담당 업무가 없습니다.' : '로그인하면 내 업무를 볼 수 있습니다.') : '조건에 맞는 멤버가 없습니다.'}
            description={scope === 'me' ? '전체 보기로 바꾸면 모든 멤버의 업무를 볼 수 있습니다.' : '검색어나 필터를 바꿔 보세요.'}
            action={scope === 'me' ? { label: '전체 보기', onClick: () => changeScope('all'), variant: 'secondary' } : undefined}
          />
        ) : (
          <div className="space-y-4">
            {filtered.map((b) => (
              <MemberSection
                key={b.assignee}
                bucket={b}
                onTaskClick={(t) => navigate(`/tasks-mgmt/${t.id}?edit=1`)}
                onIssueClick={(i) => navigate(`/tasks-mgmt/${i.id}?edit=1`)}
              />
            ))}
          </div>
        )}
      </PageShell>
    </div>
  );
}
