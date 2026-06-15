import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { useWorkItems } from '@/hooks/useWorkItems';
import { KANBAN_STATUS_LABEL, WORK_ITEM_TYPE_CONFIG } from '@/components/work-items/workItemKanbanUtils';
import { stripHtml, cn } from '@/lib/utils';
import type { WorkItem, KanbanStatus } from '@/types';

const WEEKDAY_SHORT = ['일', '월', '화', '수', '목', '금', '토'];

const STATUS_DOT: Record<KanbanStatus, string> = {
  backlog: 'bg-slate-400',
  todo: 'bg-blue-400',
  in_progress: 'bg-amber-400',
  review_test: 'bg-purple-400',
  done: 'bg-green-400',
};

interface WeekDay {
  dateKey: string;
  date: Date;
  label: string;
  items: WorkItem[];
  isToday: boolean;
}

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getWeekStart(offsetWeeks: number): Date {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7) + offsetWeeks * 7);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function fmtWeekRange(start: Date): string {
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const fmt = (d: Date) =>
    `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} (${WEEKDAY_SHORT[d.getDay()]})`;
  return `${fmt(start)} ~ ${fmt(end)}`;
}

export function WeeklyWorkTable() {
  const navigate = useNavigate();
  const [weekOffset, setWeekOffset] = useState(0);
  const { data: workItemsData } = useWorkItems();

  const todayKey = toDateKey(new Date());

  const weekDays = useMemo<WeekDay[]>(() => {
    const weekStart = getWeekStart(weekOffset);
    const all = workItemsData?.data ?? [];

    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + i);
      const dateKey = toDateKey(date);
      const label = `${WEEKDAY_SHORT[date.getDay()]} ${date.getMonth() + 1}/${date.getDate()}`;
      const items = all.filter((w) => w.startedAt?.slice(0, 10) === dateKey);
      return { dateKey, date, label, items, isToday: dateKey === todayKey };
    });
  }, [weekOffset, workItemsData, todayKey]);

  const weekStart = getWeekStart(weekOffset);
  const rangeLabel = fmtWeekRange(weekStart);

  return (
    <div className="flex flex-col h-full">
      {/* 네비게이션 바 */}
      <div className="flex-none flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/20">
        <button
          onClick={() => setWeekOffset((n) => n - 1)}
          className="p-0.5 rounded hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
          title="이전 주"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <span className="text-xs font-medium tabular-nums text-muted-foreground">{rangeLabel}</span>
        <div className="flex items-center gap-1">
          {weekOffset !== 0 && (
            <button
              onClick={() => setWeekOffset(0)}
              className="p-0.5 rounded hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
              title="이번 주"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
          )}
          <button
            onClick={() => setWeekOffset((n) => n + 1)}
            className="p-0.5 rounded hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
            title="다음 주"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 표 */}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10">
            <tr className="bg-muted/30 border-b border-border">
              <th className="w-20 px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap">날짜</th>
              <th className="w-20 px-2 py-1.5 text-left font-medium text-muted-foreground">담당자</th>
              <th className="w-12 px-2 py-1.5 text-left font-medium text-muted-foreground">타입</th>
              <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">업무</th>
              <th className="w-20 px-2 py-1.5 text-left font-medium text-muted-foreground">상태</th>
            </tr>
          </thead>
          <tbody>
            {weekDays.map((day) => {
              if (day.items.length === 0) {
                return (
                  <tr
                    key={day.dateKey}
                    className={cn('border-b border-border/40', day.isToday && 'bg-primary/5')}
                  >
                    <td className="px-2 py-1.5 font-medium text-muted-foreground whitespace-nowrap">
                      {day.label}
                    </td>
                    <td colSpan={4} className="px-2 py-1.5 text-muted-foreground/40 italic text-xs">
                      업무 없음
                    </td>
                  </tr>
                );
              }
              return day.items.map((item, idx) => (
                <tr
                  key={item.id}
                  onClick={() => navigate(`/tasks-mgmt/${item.id}`)}
                  className={cn(
                    'border-b border-border/40 hover:bg-secondary/50 cursor-pointer transition-colors',
                    day.isToday && 'bg-primary/5',
                  )}
                >
                  <td className="px-2 py-1.5 font-medium text-muted-foreground whitespace-nowrap">
                    {idx === 0 ? day.label : ''}
                  </td>
                  <td className="px-2 py-1.5 truncate max-w-[80px]">
                    {item.primaryAssignee || item.assignee || '—'}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {WORK_ITEM_TYPE_CONFIG[item.type]?.label ?? item.type}
                  </td>
                  <td className="px-2 py-1.5 truncate max-w-[200px]">
                    {stripHtml(item.content).slice(0, 40) || item.category}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="flex items-center gap-1 whitespace-nowrap">
                      <span
                        className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', STATUS_DOT[item.kanbanStatus])}
                      />
                      {KANBAN_STATUS_LABEL[item.kanbanStatus]}
                    </span>
                  </td>
                </tr>
              ));
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
