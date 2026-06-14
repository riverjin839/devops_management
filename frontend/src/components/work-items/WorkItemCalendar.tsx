import { useEffect, useState, useRef } from 'react';
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import { WorkItem } from '@/types';
import { WorkItemForm } from './WorkItemForm';
import { useQueryClient } from '@tanstack/react-query';
import { workItemKeys } from '@/hooks/useWorkItems';

interface WorkItemCalendarProps {
  items: WorkItem[];
  onItemClick: (item: WorkItem) => void;
}

const PRIORITY_BAR_COLORS: Record<string, string> = {
  high: 'bg-red-500',
  medium: 'bg-blue-500',
  low: 'bg-slate-500',
};

const PRIORITY_LABELS: Record<string, string> = {
  high: '높음',
  medium: '보통',
  low: '낮음',
};

const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];

interface TaskBar {
  item: WorkItem;
  isStart: boolean;
  isEnd: boolean;
  isMultiDay: boolean;
}

interface TooltipState {
  item: WorkItem;
  x: number;
  y: number;
}

export function WorkItemCalendar({ items, onItemClick }: WorkItemCalendarProps) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [registerDate, setRegisterDate] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const prevMonth = () => {
    if (month === 0) { setMonth(11); setYear((y) => y - 1); }
    else setMonth((m) => m - 1);
  };

  const nextMonth = () => {
    if (month === 11) { setMonth(0); setYear((y) => y + 1); }
    else setMonth((m) => m + 1);
  };

  const goToToday = () => {
    setYear(today.getFullYear());
    setMonth(today.getMonth());
  };

  // Build calendar grid
  const firstDayOfWeek = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array(firstDayOfWeek).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const toDateKey = (day: number) =>
    `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  // Build per-date item map spanning startedAt → closedAt
  const tasksByDate: Record<string, TaskBar[]> = {};
  for (const item of items) {
    const startStr = item.startedAt?.slice(0, 10);
    if (!startStr) continue;
    const endStr = item.closedAt?.slice(0, 10) || startStr;
    const isMultiDay = endStr > startStr;

    const curr = new Date(startStr + 'T00:00:00');
    const endDate = new Date(endStr + 'T00:00:00');
    while (curr <= endDate) {
      const key = `${curr.getFullYear()}-${String(curr.getMonth() + 1).padStart(2, '0')}-${String(curr.getDate()).padStart(2, '0')}`;
      if (!tasksByDate[key]) tasksByDate[key] = [];
      tasksByDate[key].push({
        item,
        isStart: key === startStr,
        isEnd: key === endStr,
        isMultiDay,
      });
      curr.setDate(curr.getDate() + 1);
    }
  }

  const isToday = (day: number) =>
    today.getFullYear() === year &&
    today.getMonth() === month &&
    today.getDate() === day;

  const handleBarEnter = (e: React.MouseEvent<HTMLElement>, item: WorkItem) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTooltip({ item, x: rect.left + rect.width / 2, y: rect.top });
  };

  const handleBarLeave = () => {
    hideTimer.current = setTimeout(() => setTooltip(null), 200);
  };

  const handleTooltipEnter = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
  };

  const handleTooltipLeave = () => {
    hideTimer.current = setTimeout(() => setTooltip(null), 200);
  };

  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;

  return (
    <div className="relative select-none">
      {/* Month navigation */}
      <div className="flex items-center justify-between mb-4 px-1">
        <button
          onClick={prevMonth}
          className="p-1.5 hover:bg-secondary rounded-lg transition-colors text-muted-foreground hover:text-foreground"
          aria-label="이전 달"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-3">
          <span className="text-base font-semibold">{year}년 {month + 1}월</span>
          {!isCurrentMonth && (
            <button
              onClick={goToToday}
              className="text-sm px-2 py-0.5 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
            >
              오늘
            </button>
          )}
        </div>

        <button
          onClick={nextMonth}
          className="p-1.5 hover:bg-secondary rounded-lg transition-colors text-muted-foreground hover:text-foreground"
          aria-label="다음 달"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Day name row */}
      <div className="grid grid-cols-7 border-l border-t border-border">
        {DAY_NAMES.map((name, i) => (
          <div
            key={name}
            className={`text-center text-sm font-medium py-2 border-r border-b border-border ${
              i === 0 ? 'text-red-400' : i === 6 ? 'text-blue-400' : 'text-muted-foreground'
            }`}
          >
            {name}
          </div>
        ))}
      </div>

      {/* Calendar cells */}
      <div className="grid grid-cols-7 border-l border-border">
        {cells.map((day, idx) => {
          const colIdx = idx % 7;
          const dayKey = day ? toDateKey(day) : '';
          const dayBars = day ? (tasksByDate[dayKey] ?? []) : [];
          const cellKey = day ? `day-${day}` : `empty-${idx}`;
          const MAX_BARS = 3;

          return (
            <div
              key={cellKey}
              className={`group min-h-[90px] border-r border-b border-border ${
                day ? 'bg-card hover:bg-secondary/20 cursor-pointer' : 'bg-muted/5'
              }`}
              onClick={() => day && setRegisterDate(toDateKey(day))}
            >
              {day && (
                <>
                  {/* Date number + add button */}
                  <div className="px-1.5 pt-1.5 mb-1 flex items-center justify-between">
                    <div
                      className={`text-sm font-medium w-6 h-6 flex items-center justify-center rounded-full ${
                        isToday(day)
                          ? 'bg-primary text-primary-foreground font-bold'
                          : colIdx === 0
                          ? 'text-red-400'
                          : colIdx === 6
                          ? 'text-blue-400'
                          : 'text-foreground/80'
                      }`}
                    >
                      {day}
                    </div>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setRegisterDate(toDateKey(day)); }}
                      className="w-4 h-4 rounded flex items-center justify-center text-muted-foreground hover:text-primary opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                      aria-label={`${toDateKey(day)} 업무 등록`}
                    >
                      <Plus className="w-3 h-3" />
                    </button>
                  </div>

                  {/* WorkItem bars */}
                  <div className="space-y-px pb-1">
                    {dayBars.slice(0, MAX_BARS).map(({ item, isStart, isEnd, isMultiDay }) => {
                      const color = PRIORITY_BAR_COLORS[item.priority] ?? 'bg-slate-500';
                      const isDone = !!item.closedAt;

                      // Rounding and margin based on position
                      const barClass = !isMultiDay || (isStart && isEnd)
                        ? 'mx-1 rounded-full'        // single day: pill
                        : isStart
                        ? 'ml-1 rounded-l-full'      // range start
                        : isEnd
                        ? 'mr-1 rounded-r-full'      // range end
                        : '';                         // middle: full width, no rounding

                      return (
                        <button
                          key={item.id}
                          className={`w-full h-[18px] flex items-center px-1.5 text-[10px] text-white truncate cursor-pointer
                            focus:outline-none transition-opacity hover:brightness-110
                            ${color} ${barClass} ${isDone ? 'opacity-50' : ''}`}
                          onClick={(e) => { e.stopPropagation(); onItemClick(item); }}
                          onMouseEnter={(e) => handleBarEnter(e, item)}
                          onMouseLeave={handleBarLeave}
                          aria-label={item.category}
                        >
                          {/* Show label only on start day or single-day item */}
                          {(isStart || !isMultiDay) && (
                            <span className="truncate leading-none">{item.category}</span>
                          )}
                        </button>
                      );
                    })}
                    {dayBars.length > MAX_BARS && (
                      <p className="text-[10px] text-muted-foreground pl-2">
                        +{dayBars.length - MAX_BARS}개
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-3 px-1 flex-wrap">
        <span className="text-sm text-muted-foreground">우선순위:</span>
        {(['high', 'medium', 'low'] as const).map((p) => (
          <span key={p} className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <span className={`w-2 h-2 rounded-full ${PRIORITY_BAR_COLORS[p]}`} />
            {PRIORITY_LABELS[p]}
          </span>
        ))}
        <span className="text-sm text-muted-foreground ml-1">|</span>
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <span className="w-2 h-2 rounded-full bg-slate-500 opacity-50" />
          완료된 작업
        </span>
        <span className="text-sm text-muted-foreground ml-1">|</span>
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <span className="inline-block w-8 h-2 bg-blue-500 rounded-full" />
          기간 표시 (예정일 → 완료일)
        </span>
      </div>

      {/* Hover tooltip */}
      {tooltip && (
        <div
          className="fixed z-50"
          style={{ left: tooltip.x, top: tooltip.y - 10, transform: 'translate(-50%, -100%)' }}
          onMouseEnter={handleTooltipEnter}
          onMouseLeave={handleTooltipLeave}
        >
          <div className="bg-popover border border-border rounded-lg shadow-xl p-3 w-56 text-sm">
            <div className="flex items-start gap-2 mb-2 pb-2 border-b border-border/60">
              <span
                className={`w-2.5 h-2.5 rounded-full flex-shrink-0 mt-0.5
                  ${PRIORITY_BAR_COLORS[tooltip.item.priority] ?? 'bg-slate-500'}
                  ${tooltip.item.closedAt ? 'opacity-40' : ''}`}
              />
              <p className="text-sm font-medium leading-tight line-clamp-2 text-foreground">
                {tooltip.item.content}
              </p>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground w-[68px] flex-shrink-0">담당자</span>
                <span className="text-sm font-medium text-foreground truncate">{tooltip.item.assignee}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground w-[68px] flex-shrink-0">대상 클러스터</span>
                <span className="text-sm text-foreground truncate">{tooltip.item.clusterName || '-'}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground w-[68px] flex-shrink-0">작업 분류</span>
                <span className="text-sm px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 truncate">
                  {tooltip.item.category}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground w-[68px] flex-shrink-0">예정일</span>
                <span className="text-sm text-foreground font-mono">
                  {tooltip.item.startedAt.slice(0, 10)}
                </span>
              </div>
              {tooltip.item.closedAt && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground w-[68px] flex-shrink-0">완료일</span>
                  <span className="text-sm text-emerald-400 font-mono">
                    {tooltip.item.closedAt.slice(0, 10)}
                  </span>
                </div>
              )}
            </div>

            <p className="text-xs text-muted-foreground/50 mt-2 pt-1.5 border-t border-border/40">
              클릭하여 상세보기
            </p>
          </div>

          <div
            className="absolute left-1/2 -translate-x-1/2 bottom-0 translate-y-full"
            style={{
              width: 0, height: 0,
              borderLeft: '6px solid transparent',
              borderRight: '6px solid transparent',
              borderTop: '6px solid hsl(var(--border))',
            }}
          />
        </div>
      )}

      {/* 날짜 클릭 업무 등록 슬라이드 오버 */}
      {registerDate && (
        <CalendarRegisterPanel
          date={registerDate}
          onClose={() => setRegisterDate(null)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: workItemKeys.all });
            setRegisterDate(null);
          }}
        />
      )}
    </div>
  );
}

interface CalendarRegisterPanelProps {
  date: string;
  onClose: () => void;
  onSaved: () => void;
}

function CalendarRegisterPanel({ date, onClose, onSaved }: CalendarRegisterPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const d = new Date(date + 'T00:00:00');
  const DAY = ['일', '월', '화', '수', '목', '금', '토'];
  const dateLabel = `${d.getMonth() + 1}월 ${d.getDate()}일 (${DAY[d.getDay()]})`;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-label={`${dateLabel} 업무 등록`}
        className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-[520px] bg-card border-l border-border shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-border bg-muted/30 flex-shrink-0">
          <div>
            <p className="text-sm font-semibold">업무 등록</p>
            <p className="text-xs text-muted-foreground">{dateLabel}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="p-1.5 rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <WorkItemForm
            defaultStartedAt={`${date}T09:00`}
            onCancel={onClose}
            onSaved={onSaved}
            embedded
          />
        </div>
      </div>
    </>
  );
}
