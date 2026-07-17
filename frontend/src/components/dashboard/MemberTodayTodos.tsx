import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowRight, CalendarCheck2, Clock, CircleDashed,
  ShieldAlert, ChevronLeft, ChevronRight, RotateCcw,
  Square, CheckSquare, Users,
} from 'lucide-react';
import { todayWorkItemsApi } from '@/services/api';
import { useAssignees } from '@/hooks/useAssignees';
import { useWorkItems } from '@/hooks/useWorkItems';
import { useAuthStore } from '@/stores/authStore';
import { stripHtml } from '@/lib/utils';
import { KanbanStatus } from '@/types';

const TEAM_ASSIGNEE = '전체';

// 인당 표시 개수 — 기본 5개, 사용자별로 localStorage 에 저장.
const ITEM_LIMIT_KEY = 'k8s:memberToday:itemLimit';
const ITEM_LIMIT_OPTIONS = [3, 5, 8, 10];
const DEFAULT_ITEM_LIMIT = 5;

function loadItemLimit(): number {
  try {
    const n = Number(localStorage.getItem(ITEM_LIMIT_KEY));
    return ITEM_LIMIT_OPTIONS.includes(n) ? n : DEFAULT_ITEM_LIMIT;
  } catch {
    return DEFAULT_ITEM_LIMIT;
  }
}

interface MemberTodayTodosProps {
  selectedClusterId: string | null;
}

// 노트(메모지) 느낌의 체크박스 불릿 색상 — 상태를 색으로 유지.
const STATUS_TEXT: Record<KanbanStatus, string> = {
  backlog: 'text-slate-400',
  todo: 'text-blue-400',
  in_progress: 'text-amber-500',
  review_test: 'text-purple-400',
  done: 'text-emerald-500',
};

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(dateStr: string, delta: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + delta);
  return dateKey(d);
}

function fmtLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const week = ['일', '월', '화', '수', '목', '금', '토'];
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} (${week[d.getDay()]})`;
}

export function MemberTodayTodos({ selectedClusterId }: MemberTodayTodosProps) {
  const todayStr = dateKey(new Date());
  const [viewDate, setViewDate] = useState(todayStr);
  const isToday = viewDate === todayStr;

  // "+N건 더" 클릭 시 해당 담당자 카드의 전체 목록을 펼친다.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (assignee: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(assignee)) next.delete(assignee);
      else next.add(assignee);
      return next;
    });

  const [itemLimit, setItemLimit] = useState(loadItemLimit);
  const changeItemLimit = (n: number) => {
    setItemLimit(n);
    try { localStorage.setItem(ITEM_LIMIT_KEY, String(n)); } catch { /* ignore */ }
  };

  const { data, isLoading } = useQuery({
    queryKey: ['items', 'today', viewDate],
    queryFn: () => todayWorkItemsApi.getSummary(viewDate).then((r) => r.data),
    refetchInterval: isToday ? 60000 : false,
  });

  // 공통업무(파트 회의 등, allAttendees=true) — 담당자 그룹과 별개로 "전체" 카드에 모아 0순위로 노출.
  const { data: allAttendData } = useWorkItems({ allAttendees: true });

  const { data: registeredAssignees = [] } = useAssignees();
  // 로그인한 사용자를 목록 맨 위로.
  const currentUser = useAuthStore((s) => s.user);
  const myName = (currentUser?.displayName?.trim() || currentUser?.username || '').trim();

  const apiGroups = (data?.groups ?? []).map((g) => {
    const filterByCluster = (t: { clusterId?: string }) =>
      !selectedClusterId || t.clusterId === selectedClusterId;
    return {
      ...g,
      overdueTasks: (g.overdueTasks ?? []).filter(filterByCluster),
      todayTasks: g.todayTasks.filter(filterByCluster),
      inProgressTasks: g.inProgressTasks.filter(filterByCluster),
    };
  });

  // 해당일 등록된 업무가 없어도 등록된 모든 담당자를 노출한다.
  // 등록된 담당자 순서를 먼저 깔고, 목록에 없는(레거시/자유입력) 담당자는 뒤에 붙인다.
  const byName = new Map(apiGroups.map((g) => [g.assignee, g]));
  const orderedNames: string[] = [];
  const pushed = new Set<string>();
  for (const a of registeredAssignees) {
    if (a.name && !pushed.has(a.name)) { pushed.add(a.name); orderedNames.push(a.name); }
  }
  for (const g of apiGroups) {
    if (g.assignee && !pushed.has(g.assignee)) { pushed.add(g.assignee); orderedNames.push(g.assignee); }
  }
  const groups = orderedNames
    .map((name) => byName.get(name) ?? { assignee: name, todayTasks: [], inProgressTasks: [], overdueTasks: [] })
    // 정렬 우선순위: ① 로그인 사용자 → ② 업무가 있는 담당자 → ③ 등록 순서(안정 정렬).
    .map((g, i) => ({ g, i, count: (g.overdueTasks?.length ?? 0) + g.todayTasks.length + g.inProgressTasks.length }))
    .sort((a, b) =>
      (b.g.assignee === myName ? 1 : 0) - (a.g.assignee === myName ? 1 : 0)
      || (b.count > 0 ? 1 : 0) - (a.count > 0 ? 1 : 0)
      || a.i - b.i,
    )
    .map((x) => x.g);

  // "전체" 카드 — allAttendees=true(공통업무/파트 회의 등) 항목을 담당자 그룹과 별개로 모아
  // 0순위(맨 앞)에 노출한다. 개별 담당자 카드(회의 주최자 등)에도 그대로 남아있을 수 있음(의도적 —
  // TodoTodayPage 의 "내 업무 + 공통업무" 병합과 동일한 전제, 전체 카드는 가시성용 오버레이).
  const teamCandidates = (allAttendData?.data ?? [])
    .filter((t) => !selectedClusterId || t.clusterId === selectedClusterId);
  const teamGroup = {
    assignee: TEAM_ASSIGNEE,
    overdueTasks: teamCandidates.filter((t) => {
      const d = t.startedAt?.slice(0, 10) ?? '';
      return !!d && d < viewDate && t.kanbanStatus !== 'done';
    }),
    todayTasks: teamCandidates.filter((t) =>
      (t.startedAt?.slice(0, 10) ?? '') === viewDate && t.kanbanStatus !== 'in_progress'),
    inProgressTasks: teamCandidates.filter((t) =>
      t.kanbanStatus === 'in_progress' && (t.startedAt?.slice(0, 10) ?? '') <= viewDate),
  };
  const teamHasItems = teamGroup.overdueTasks.length + teamGroup.todayTasks.length + teamGroup.inProgressTasks.length > 0;
  // 담당자별 집계(totals)는 원래 groups 기준으로만 계산 — "전체" 카드는 가시성용 중복 노출이라
  // 상단 합계에 포함하면 과대집계된다.
  const displayGroups = teamHasItems ? [teamGroup, ...groups] : groups;

  const totals = groups.reduce(
    (acc, g) => {
      acc.overdue += g.overdueTasks.length;
      acc.today += g.todayTasks.length;
      acc.inProgress += g.inProgressTasks.length;
      const all = [...g.overdueTasks, ...g.todayTasks, ...g.inProgressTasks];
      acc.done += all.filter((t) => t.kanbanStatus === 'done').length;
      acc.total += all.length;
      return acc;
    },
    { overdue: 0, today: 0, inProgress: 0, done: 0, total: 0 },
  );
  const overall = totals.total > 0 ? Math.round((totals.done / totals.total) * 100) : 0;

  return (
    <div className="space-y-3">
      {/* 날짜 네비게이션 */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setViewDate((d) => addDays(d, -1))}
            className="w-6 h-6 rounded-lg flex items-center justify-center hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
            title="이전 날"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>

          <div className="flex items-center gap-1.5 px-2">
            <CalendarCheck2 className="w-3.5 h-3.5 text-primary flex-shrink-0" />
            <span className="text-sm font-semibold tabular-nums">
              {isToday ? `오늘 · ${fmtLabel(viewDate)}` : fmtLabel(viewDate)}
            </span>
          </div>

          <button
            onClick={() => setViewDate((d) => addDays(d, 1))}
            className="w-6 h-6 rounded-lg flex items-center justify-center hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
            title="다음 날"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>

          {!isToday && (
            <button
              onClick={() => setViewDate(todayStr)}
              className="ml-1 w-6 h-6 rounded-lg flex items-center justify-center hover:bg-secondary transition-colors text-muted-foreground hover:text-primary"
              title="오늘로 돌아가기"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 text-xs">
          {totals.overdue > 0 && (
            <span className="text-red-500 dark:text-red-400">지연 {totals.overdue}</span>
          )}
          <span className="text-blue-500 dark:text-blue-400">예정 {totals.today}</span>
          <span className="text-amber-500 dark:text-amber-400">진행 {totals.inProgress}</span>
          <span className="text-emerald-500 dark:text-emerald-400">완료 {totals.done}</span>
          <span className="text-primary font-semibold">{overall}%</span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          멤버별 진행 현황 (task + issue, primary/secondary 담당)
        </div>
        <label className="flex items-center gap-1 text-xs text-muted-foreground flex-shrink-0">
          인당 표시
          <select
            value={itemLimit}
            onChange={(e) => changeItemLimit(Number(e.target.value))}
            className="px-1 py-0.5 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
          >
            {ITEM_LIMIT_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}개</option>
            ))}
          </select>
        </label>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-16 rounded-xl bg-secondary/40 animate-pulse" />
          ))}
        </div>
      ) : displayGroups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 py-10 text-center text-sm text-muted-foreground">
          {isToday ? '오늘 예정된 업무가 없습니다.' : '해당 날짜에 예정된 업무가 없습니다.'}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2 pr-1">
          {displayGroups.map((g) => {
            const isTeam = g.assignee === TEAM_ASSIGNEE;
            const overdue = g.overdueTasks ?? [];
            const all = [...overdue, ...g.todayTasks, ...g.inProgressTasks];
            const done = all.filter((t) => t.kanbanStatus === 'done').length;
            const total = all.length;
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            const isExpanded = expanded.has(g.assignee);
            const visible = isExpanded ? all : all.slice(0, itemLimit);

            return (
              <div
                key={g.assignee}
                className={`rounded-xl border p-2.5 ${
                  isTeam ? 'lg:col-span-2 border-primary/40 bg-primary/5' : 'border-border/70 bg-transparent'
                }`}
              >
                {/* 헤더 1줄 압축 — 이름은 작게, 카드 높이를 줄여 더 많은 담당자가 보이게 */}
                <div className="flex items-center gap-1.5 mb-1.5">
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 ${
                    isTeam ? 'bg-primary/25 text-primary' : 'bg-primary/15 text-primary'
                  }`}>
                    {isTeam ? <Users className="w-3 h-3" /> : g.assignee.slice(0, 2).toUpperCase()}
                  </div>
                  <span className="text-sm font-semibold truncate flex-1 min-w-0">{g.assignee}</span>
                  <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums">{done}/{total} · {pct}%</span>
                  <div className="hidden sm:flex items-center gap-1.5 text-xs flex-shrink-0">
                    {overdue.length > 0 && (
                      <span className="inline-flex items-center gap-0.5 text-red-500" title="지연">
                        <ShieldAlert className="w-2.5 h-2.5" />
                        {overdue.length}
                      </span>
                    )}
                    {g.todayTasks.length > 0 && (
                      <span className="inline-flex items-center gap-0.5 text-blue-500">
                        <CircleDashed className="w-2.5 h-2.5" />
                        {g.todayTasks.length}
                      </span>
                    )}
                    {g.inProgressTasks.length > 0 && (
                      <span className="inline-flex items-center gap-0.5 text-amber-500">
                        <Clock className="w-2.5 h-2.5" />
                        {g.inProgressTasks.length}
                      </span>
                    )}
                  </div>
                </div>

                <div className="h-1 rounded-full bg-secondary overflow-hidden mb-1.5">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>

                {/* 업무리스트 — 노트(메모지) 느낌: 크림 배경 + 좌측 마진선 + 점선 줄 + 체크박스 */}
                <ul className="relative space-y-0 rounded-lg border border-amber-100 bg-amber-50/60 pl-6 pr-2 py-1 dark:border-border/50 dark:bg-secondary/20 before:absolute before:left-3.5 before:top-1.5 before:bottom-1.5 before:w-px before:bg-red-300/60 dark:before:bg-border">
                  {visible.map((t) => {
                    const isDone = t.kanbanStatus === 'done';
                    return (
                      <li key={`${g.assignee}:${t.id}`}>
                        <Link
                          to={`/tasks-mgmt/${t.id}`}
                          className="flex items-center gap-2 text-sm min-w-0 py-1 border-b border-dashed border-amber-200/70 last:border-b-0 hover:bg-amber-100/50 dark:border-border/40 dark:hover:bg-secondary/40 transition-colors"
                          title="상세 보기"
                        >
                          {isDone ? (
                            <CheckSquare className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
                          ) : (
                            <Square className={`w-3.5 h-3.5 flex-shrink-0 ${STATUS_TEXT[t.kanbanStatus]}`} />
                          )}
                          {t.type === 'issue' && (
                            <ShieldAlert className="w-3 h-3 text-amber-500 flex-shrink-0" />
                          )}
                          <span
                            className={`truncate flex-1 ${
                              isDone ? 'text-muted-foreground line-through' : 'text-foreground'
                            }`}
                          >
                            {t.title?.trim() || stripHtml(t.content) || t.category}
                          </span>
                          {t.clusterName && (
                            <span className="text-xs text-muted-foreground/80 flex-shrink-0 hidden md:inline">
                              {t.clusterName}
                            </span>
                          )}
                        </Link>
                      </li>
                    );
                  })}
                  {all.length > itemLimit && (
                    <li>
                      <button
                        type="button"
                        onClick={() => toggleExpand(g.assignee)}
                        className="text-xs text-muted-foreground hover:text-primary py-1 transition-colors"
                        aria-expanded={isExpanded}
                      >
                        {isExpanded ? '접기' : `+${all.length - itemLimit}건 더…`}
                      </button>
                    </li>
                  )}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-end">
        <Link
          to="/todo-today"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          담당자별 상세 보기 <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
    </div>
  );
}
