import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, Search, X, ClipboardList, ListTodo, Mail, Hash, ChevronDown, ChevronUp } from 'lucide-react';
import { useAssignees } from '@/hooks/useAssignees';
import { useWorkItems } from '@/hooks/useWorkItems';
import type { WorkItem, Assignee } from '@/types';

// ── 상태 스타일 ──────────────────────────────────────────────────────────────

const KANBAN_STYLE: Record<string, { label: string; cls: string }> = {
  backlog:     { label: 'Backlog',  cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30' },
  todo:        { label: 'To Do',    cls: 'bg-blue-500/10 text-blue-400 border-blue-500/30' },
  in_progress: { label: 'WIP',      cls: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
  review_test: { label: 'Review',   cls: 'bg-purple-500/10 text-purple-400 border-purple-500/30' },
  done:        { label: 'Done',     cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
};

const PRIORITY_DOT: Record<string, string> = {
  high:   'bg-red-500',
  medium: 'bg-blue-500',
  low:    'bg-slate-400',
};

// ── 유틸 ────────────────────────────────────────────────────────────────────

function formatDate(s?: string | null): string {
  if (!s) return '-';
  return s.slice(0, 10);
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '').trim();
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

// ── 멤버별 섹션 ──────────────────────────────────────────────────────────────

function MemberSection({ bucket, onTaskClick, onIssueClick }: {
  bucket: MemberBucket;
  onTaskClick: (t: WorkItem) => void;
  onIssueClick: (i: WorkItem) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      {/* 헤더 */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-border bg-muted/20">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-bold">
            {bucket.assignee.slice(0, 2)}
          </div>
          <div>
            <p className="text-sm font-semibold">{bucket.assignee}</p>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
              {bucket.info?.employeeId && (
                <span className="flex items-center gap-0.5"><Hash className="w-2.5 h-2.5" />{bucket.info.employeeId}</span>
              )}
              {bucket.info?.email && (
                <span className="flex items-center gap-0.5"><Mail className="w-2.5 h-2.5" />{bucket.info.email}</span>
              )}
              {bucket.info?.primaryRole && (
                <span>{bucket.info.primaryRole}</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/30">
            작업 {bucket.tasks.length} (진행 {bucket.openTasks} / 완료 {bucket.doneTasks})
          </span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/30">
            이슈 {bucket.issues.length} (미조치 {bucket.unresolvedIssues} / 완료 {bucket.resolvedIssues})
          </span>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="p-1.5 hover:bg-secondary rounded text-muted-foreground"
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* 본문 */}
      {expanded && (
        <div className="grid grid-cols-1 md:grid-cols-2 divide-x divide-border">
          {/* 작업 */}
          <div className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <ListTodo className="w-4 h-4 text-primary" />
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">작업</span>
            </div>
            {bucket.tasks.length === 0 ? (
              <p className="text-xs text-muted-foreground/50 text-center py-6">할당된 작업 없음</p>
            ) : (
              <ul className="space-y-1.5">
                {bucket.tasks.slice(0, 10).map((t) => {
                  const ks = KANBAN_STYLE[t.kanbanStatus] ?? KANBAN_STYLE.todo;
                  return (
                    <li
                      key={t.id}
                      onClick={() => onTaskClick(t)}
                      className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/40 cursor-pointer group"
                    >
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PRIORITY_DOT[t.priority] ?? 'bg-slate-400'}`} />
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full border flex-shrink-0 ${ks.cls}`}>{ks.label}</span>
                      <span className="text-xs text-foreground truncate flex-1" title={stripHtml(t.content)}>
                        {stripHtml(t.content) || t.category}
                      </span>
                      <span className="text-[10px] font-mono text-muted-foreground flex-shrink-0">
                        {formatDate(t.startedAt)}
                      </span>
                    </li>
                  );
                })}
                {bucket.tasks.length > 10 && (
                  <li className="text-[10px] text-muted-foreground/70 text-center pt-1">
                    + {bucket.tasks.length - 10}개 더...
                  </li>
                )}
              </ul>
            )}
          </div>

          {/* 이슈 */}
          <div className="p-4">
            <div className="flex items-center gap-2 mb-3">
              <ClipboardList className="w-4 h-4 text-amber-400" />
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">이슈</span>
            </div>
            {bucket.issues.length === 0 ? (
              <p className="text-xs text-muted-foreground/50 text-center py-6">할당된 이슈 없음</p>
            ) : (
              <ul className="space-y-1.5">
                {bucket.issues.slice(0, 10).map((i) => (
                  <li
                    key={i.id}
                    onClick={() => onIssueClick(i)}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/40 cursor-pointer"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${i.closedAt ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border flex-shrink-0 ${
                      i.closedAt
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                        : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                    }`}>
                      {i.closedAt ? '완료' : '미조치'}
                    </span>
                    <span className="text-xs text-foreground truncate flex-1" title={stripHtml(i.content)}>
                      {i.category}: {stripHtml(i.content)}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground flex-shrink-0">
                      {formatDate(i.startedAt)}
                    </span>
                  </li>
                ))}
                {bucket.issues.length > 10 && (
                  <li className="text-[10px] text-muted-foreground/70 text-center pt-1">
                    + {bucket.issues.length - 10}개 더...
                  </li>
                )}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 메인 페이지 ──────────────────────────────────────────────────────────────

type MemberFilter = 'all' | 'active' | 'withOpen';

export function MemberBoardPage() {
  const navigate = useNavigate();
  const { data: assignees = [] } = useAssignees();
  const { data: workItemsData } = useWorkItems();

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<MemberFilter>('active');
  const [includeSecondary, setIncludeSecondary] = useState(false);

  const buckets = useMemo<MemberBucket[]>(() => {
    const allItems = workItemsData?.data ?? [];
    const tasksAll  = allItems.filter((w) => w.type === 'task');
    const issuesAll = allItems.filter((w) => w.type === 'issue');

    // 담당자 이름 집합 = 등록된 Assignee + 작업/이슈에 실제로 등장한 이름
    const nameSet = new Set<string>();
    for (const a of assignees) nameSet.add(a.name);
    for (const t of tasksAll) {
      if (t.primaryAssignee) nameSet.add(t.primaryAssignee);
      if (includeSecondary && t.secondaryAssignee) nameSet.add(t.secondaryAssignee);
    }
    for (const i of issuesAll) {
      if (i.primaryAssignee) nameSet.add(i.primaryAssignee);
      if (includeSecondary && i.secondaryAssignee) nameSet.add(i.secondaryAssignee);
    }

    const assigneeByName = new Map(assignees.map((a) => [a.name, a]));
    const list: MemberBucket[] = [];

    for (const name of nameSet) {
      const memberTasks = tasksAll.filter(
        (t) => t.primaryAssignee === name || (includeSecondary && t.secondaryAssignee === name),
      );
      const memberIssues = issuesAll.filter(
        (i) => i.primaryAssignee === name || (includeSecondary && i.secondaryAssignee === name),
      );
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

    // 정렬: 열린 작업/이슈 많은 순
    list.sort((a, b) =>
      (b.openTasks + b.unresolvedIssues) - (a.openTasks + a.unresolvedIssues)
      || a.assignee.localeCompare(b.assignee),
    );

    return list;
  }, [assignees, workItemsData, includeSecondary]);

  const filtered = useMemo(() => {
    let list = buckets;
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
  }, [buckets, search, filter]);

  const totalOpen = buckets.reduce((acc, b) => acc + b.openTasks + b.unresolvedIssues, 0);

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto px-8 py-8">
        {/* 헤더 */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Users className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">멤버별 업무</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-500/15 text-slate-400 border border-slate-500/30">
              멤버 {filtered.length} / 전체 {buckets.length}
            </span>
            {totalOpen > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/30">
                진행중 합계 {totalOpen}
              </span>
            )}
          </div>
        </div>

        {/* 필터 */}
        <div className="bg-card border border-border rounded-xl p-4 mb-5">
          <div className="flex flex-wrap items-center gap-3">
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
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                    filter === f
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground/70 hover:text-foreground'
                  }`}
                >
                  {f === 'all' ? '전체 멤버' : f === 'active' ? '업무 있음' : '미완료 있음'}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeSecondary}
                onChange={(e) => setIncludeSecondary(e.target.checked)}
                className="w-3.5 h-3.5 accent-primary"
              />
              부 담당자도 포함
            </label>
            {(search || filter !== 'active') && (
              <button
                onClick={() => { setSearch(''); setFilter('active'); }}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="w-3 h-3" />
                초기화
              </button>
            )}
          </div>
        </div>

        {/* 멤버 섹션 리스트 */}
        {filtered.length === 0 ? (
          <div className="text-center py-20">
            <Users className="w-12 h-12 mx-auto mb-4 text-muted-foreground/30" />
            <p className="text-muted-foreground">조건에 맞는 멤버가 없습니다.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {filtered.map((b) => (
              <MemberSection
                key={b.assignee}
                bucket={b}
                onTaskClick={(t) => navigate(`/tasks-mgmt/${t.id}/edit`)}
                onIssueClick={(i) => navigate(`/tasks-mgmt/${i.id}/edit`)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
