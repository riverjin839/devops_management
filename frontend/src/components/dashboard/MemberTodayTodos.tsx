import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowRight, CalendarCheck2, CheckCircle2, Clock, CircleDashed,
  ShieldAlert, ChevronLeft, ChevronRight, RotateCcw,
} from 'lucide-react';
import { todayWorkItemsApi } from '@/services/api';
import { useAssignees } from '@/hooks/useAssignees';
import { stripHtml } from '@/lib/utils';
import { KanbanStatus } from '@/types';

interface MemberTodayTodosProps {
  selectedClusterId: string | null;
}

const STATUS_DOT: Record<KanbanStatus, string> = {
  backlog: 'bg-slate-400',
  todo: 'bg-blue-400',
  in_progress: 'bg-amber-400',
  review_test: 'bg-purple-400',
  done: 'bg-green-400',
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

  const { data, isLoading } = useQuery({
    queryKey: ['items', 'today', viewDate],
    queryFn: () => todayWorkItemsApi.getSummary(viewDate).then((r) => r.data),
    refetchInterval: isToday ? 60000 : false,
  });

  const { data: registeredAssignees = [] } = useAssignees();

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
    // 업무가 있는 담당자를 위로, 없는 담당자를 아래로 (안정 정렬).
    .map((g, i) => ({ g, i, count: (g.overdueTasks?.length ?? 0) + g.todayTasks.length + g.inProgressTasks.length }))
    .sort((a, b) => (b.count > 0 ? 1 : 0) - (a.count > 0 ? 1 : 0) || a.i - b.i)
    .map((x) => x.g);

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
            <span className="text-xs font-semibold tabular-nums">
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

        <div className="flex items-center gap-3 text-[11px]">
          {totals.overdue > 0 && (
            <span className="text-red-500 dark:text-red-400">지연 {totals.overdue}</span>
          )}
          <span className="text-blue-500 dark:text-blue-400">예정 {totals.today}</span>
          <span className="text-amber-500 dark:text-amber-400">진행 {totals.inProgress}</span>
          <span className="text-emerald-500 dark:text-emerald-400">완료 {totals.done}</span>
          <span className="text-primary font-semibold">{overall}%</span>
        </div>
      </div>

      <div className="text-[11px] text-muted-foreground">
        멤버별 진행 현황 (task + issue, primary/secondary 담당)
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-16 rounded-xl bg-secondary/40 animate-pulse" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 py-10 text-center text-sm text-muted-foreground">
          {isToday ? '오늘 예정된 업무가 없습니다.' : '해당 날짜에 예정된 업무가 없습니다.'}
        </div>
      ) : (
        <div className="space-y-2 pr-1">
          {groups.map((g) => {
            const overdue = g.overdueTasks ?? [];
            const all = [...overdue, ...g.todayTasks, ...g.inProgressTasks];
            const done = all.filter((t) => t.kanbanStatus === 'done').length;
            const total = all.length;
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;

            return (
              <div
                key={g.assignee}
                className="rounded-xl border border-border/70 bg-transparent p-2.5"
              >
                {/* 헤더 1줄 압축 — 이름은 작게, 카드 높이를 줄여 더 많은 담당자가 보이게 */}
                <div className="flex items-center gap-1.5 mb-1.5">
                  <div className="w-5 h-5 rounded-full bg-primary/15 flex items-center justify-center text-[9px] font-bold text-primary flex-shrink-0">
                    {g.assignee.slice(0, 2).toUpperCase()}
                  </div>
                  <span className="text-xs font-semibold truncate flex-1 min-w-0">{g.assignee}</span>
                  <span className="text-[10px] text-muted-foreground flex-shrink-0 tabular-nums">{done}/{total} · {pct}%</span>
                  <div className="hidden sm:flex items-center gap-1.5 text-[10px] flex-shrink-0">
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

                <ul className="space-y-1">
                  {all.slice(0, 4).map((t) => (
                    <li key={`${g.assignee}:${t.id}`}>
                      <Link
                        to={`/tasks-mgmt/${t.id}`}
                        className="flex items-center gap-2 text-xs min-w-0 px-1 py-0.5 -mx-1 rounded hover:bg-secondary/50 transition-colors"
                        title="상세 보기"
                      >
                        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[t.kanbanStatus]}`} />
                        {t.type === 'issue' ? (
                          <ShieldAlert className="w-3 h-3 text-amber-500 flex-shrink-0" />
                        ) : t.kanbanStatus === 'done' ? (
                          <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />
                        ) : null}
                        <span
                          className={`truncate flex-1 ${
                            t.kanbanStatus === 'done' ? 'text-muted-foreground line-through' : 'text-foreground'
                          }`}
                        >
                          {t.title?.trim() || stripHtml(t.content) || t.category}
                        </span>
                        {t.clusterName && (
                          <span className="text-[10px] text-muted-foreground/80 flex-shrink-0 hidden md:inline">
                            {t.clusterName}
                          </span>
                        )}
                      </Link>
                    </li>
                  ))}
                  {all.length > 4 && (
                    <li className="text-[10px] text-muted-foreground pl-3.5">+{all.length - 4}건 더…</li>
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
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors"
        >
          담당자별 상세 보기 <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
    </div>
  );
}
