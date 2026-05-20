import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowRight, CalendarCheck2, CheckCircle2, Clock, CircleDashed,
  ShieldAlert, ChevronLeft, ChevronRight, RotateCcw,
} from 'lucide-react';
import { todayWorkItemsApi } from '@/services/api';
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

  const groups = (data?.groups ?? [])
    .map((g) => {
      const filterByCluster = (t: { clusterId?: string }) =>
        !selectedClusterId || t.clusterId === selectedClusterId;
      return {
        ...g,
        todayTasks: g.todayTasks.filter(filterByCluster),
        inProgressTasks: g.inProgressTasks.filter(filterByCluster),
      };
    })
    .filter((g) => g.todayTasks.length + g.inProgressTasks.length > 0);

  const totals = groups.reduce(
    (acc, g) => {
      acc.today += g.todayTasks.length;
      acc.inProgress += g.inProgressTasks.length;
      const all = [...g.todayTasks, ...g.inProgressTasks];
      acc.done += all.filter((t) => t.kanbanStatus === 'done').length;
      acc.total += all.length;
      return acc;
    },
    { today: 0, inProgress: 0, done: 0, total: 0 },
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
          {isToday ? '오늘 예정된 작업이 없습니다.' : '해당 날짜에 예정된 작업이 없습니다.'}
        </div>
      ) : (
        <div className="space-y-2.5 pr-1">
          {groups.map((g) => {
            const all = [...g.todayTasks, ...g.inProgressTasks];
            const done = all.filter((t) => t.kanbanStatus === 'done').length;
            const total = all.length;
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;

            return (
              <div
                key={g.assignee}
                className="rounded-xl border border-border/70 bg-card/60 p-3"
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-7 h-7 rounded-full bg-primary/15 flex items-center justify-center text-[11px] font-bold text-primary flex-shrink-0">
                    {g.assignee.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{g.assignee}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {done}/{total}건 · {pct}%
                    </p>
                  </div>
                  <div className="hidden sm:flex items-center gap-2 text-[11px] flex-shrink-0">
                    {g.todayTasks.length > 0 && (
                      <span className="inline-flex items-center gap-1 text-blue-500">
                        <CircleDashed className="w-3 h-3" />
                        {g.todayTasks.length}
                      </span>
                    )}
                    {g.inProgressTasks.length > 0 && (
                      <span className="inline-flex items-center gap-1 text-amber-500">
                        <Clock className="w-3 h-3" />
                        {g.inProgressTasks.length}
                      </span>
                    )}
                  </div>
                </div>

                <div className="h-1 rounded-full bg-secondary overflow-hidden mb-2">
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
                          {stripHtml(t.content) || t.category}
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
