import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  ChevronLeft, ChevronRight, ArrowRight, CheckCircle2, Clock, ShieldAlert,
  Plus, CalendarPlus, X,
} from 'lucide-react';
import { useWorkItems } from '@/hooks/useWorkItems';
import { stripHtml } from '@/lib/utils';
import { WorkItem, KanbanStatus } from '@/types';
import { QuickAddTaskModal } from './QuickAddTaskModal';
import { WORK_ITEM_TYPE_CONFIG } from '@/components/work-items/workItemKanbanUtils';

interface WorkCalendarProps {
  selectedClusterId: string | null;
}

interface DayBucket {
  scheduled: WorkItem[];   // type !== 'issue' (작업/회의/교육/기타) 이고 startedAt 이 해당일
  completed: WorkItem[];   // 작업류이고 closedAt + kanbanStatus='done'
  issues: WorkItem[];      // type='issue' 이고 startedAt 이 해당일
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const t = new Date(iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z');
  return Number.isNaN(t.getTime()) ? null : t;
}

function buildMonthGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const startOffset = first.getDay();
  const start = new Date(year, month, 1 - startOffset);
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }
  return days;
}

const STATUS_LABEL: Record<KanbanStatus, string> = {
  backlog: '백로그',
  todo: '할일',
  in_progress: '진행 중',
  review_test: '검토',
  done: '완료',
};

export function WorkCalendar({ selectedClusterId }: WorkCalendarProps) {
  const today = useMemo(() => new Date(), []);
  const todayKey = toDateKey(today);
  const [cursor, setCursor] = useState<{ y: number; m: number }>({
    y: today.getFullYear(),
    m: today.getMonth(),
  });
  const [selected, setSelected] = useState<string>(todayKey);
  const [quickAddDate, setQuickAddDate] = useState<string | null>(null);
  // 사이드바 아이콘 클릭 → flyout 패턴처럼, 날짜 클릭 시 popover 를 띄우기 위한 앵커.
  // null 이면 popover 닫힘.
  const [popoverAnchor, setPopoverAnchor] = useState<DOMRect | null>(null);

  const { data: workItemsData } = useWorkItems();

  const buckets = useMemo<Map<string, DayBucket>>(() => {
    const all = workItemsData?.data ?? [];
    const map = new Map<string, DayBucket>();
    const ensure = (k: string): DayBucket => {
      let b = map.get(k);
      if (!b) {
        b = { scheduled: [], completed: [], issues: [] };
        map.set(k, b);
      }
      return b;
    };
    for (const w of all) {
      if (selectedClusterId && w.clusterId !== selectedClusterId) continue;
      if (w.type === 'issue') {
        if (w.startedAt) ensure(w.startedAt.slice(0, 10)).issues.push(w);
      } else {
        // task / meeting / training / etc — 모두 scheduled 버킷으로
        const sched = parseDate(w.startedAt);
        if (sched) ensure(toDateKey(sched)).scheduled.push(w);
        if (w.closedAt && w.kanbanStatus === 'done') {
          const done = parseDate(w.closedAt);
          if (done) ensure(toDateKey(done)).completed.push(w);
        }
      }
    }
    return map;
  }, [workItemsData, selectedClusterId]);

  const grid = useMemo(() => buildMonthGrid(cursor.y, cursor.m), [cursor]);

  const monthTotals = useMemo(() => {
    let scheduled = 0;
    let completed = 0;
    let issues = 0;
    for (const d of grid) {
      if (d.getMonth() !== cursor.m) continue;
      const b = buckets.get(toDateKey(d));
      if (!b) continue;
      scheduled += b.scheduled.length;
      completed += b.completed.length;
      issues += b.issues.length;
    }
    return { scheduled, completed, issues };
  }, [buckets, grid, cursor.m]);

  const selectedBucket = buckets.get(selected) ?? { scheduled: [], completed: [], issues: [] };

  const goPrev = () => {
    const d = new Date(cursor.y, cursor.m - 1, 1);
    setCursor({ y: d.getFullYear(), m: d.getMonth() });
  };
  const goNext = () => {
    const d = new Date(cursor.y, cursor.m + 1, 1);
    setCursor({ y: d.getFullYear(), m: d.getMonth() });
  };
  const goToday = () => {
    setCursor({ y: today.getFullYear(), m: today.getMonth() });
    setSelected(todayKey);
  };

  // Color intensity: 0..4 levels based on scheduled+completed+issues count
  const intensityLevel = (count: number): number => {
    if (count === 0) return 0;
    if (count <= 1) return 1;
    if (count <= 3) return 2;
    if (count <= 6) return 3;
    return 4;
  };
  const intensityClass = (lvl: number): string => {
    switch (lvl) {
      case 0: return 'bg-secondary/30';
      case 1: return 'bg-primary/10';
      case 2: return 'bg-primary/20';
      case 3: return 'bg-primary/40';
      case 4: return 'bg-primary/65';
      default: return '';
    }
  };

  const selectedDateLabel = (() => {
    const d = new Date(selected + 'T00:00:00');
    return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
  })();

  const handleDayClick = (key: string, e: React.MouseEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setSelected(key);
    setPopoverAnchor(rect);
  };

  const closePopover = () => setPopoverAnchor(null);

  return (
    <>
      <div className="space-y-3">
        {/* ── Calendar grid (full-width — 우측 상세 패널 제거됨, 날짜 클릭 시 popover) ─ */}
        <div className="space-y-3">
          {/* Month nav row */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1 bg-secondary/60 rounded-xl p-0.5">
              <button
                onClick={goPrev}
                className="p-1.5 rounded-lg text-muted-foreground hover:bg-card hover:text-foreground transition-colors"
                title="이전 달"
                aria-label="이전 달"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="px-2 text-sm font-semibold tabular-nums select-none">
                {cursor.y}년 {cursor.m + 1}월
              </span>
              <button
                onClick={goNext}
                className="p-1.5 rounded-lg text-muted-foreground hover:bg-card hover:text-foreground transition-colors"
                title="다음 달"
                aria-label="다음 달"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <button
                onClick={goToday}
                className="ml-0.5 px-2.5 py-1 rounded-lg text-[11px] font-medium hover:bg-card text-muted-foreground hover:text-foreground transition-colors"
              >
                오늘
              </button>
            </div>
            <div className="flex items-center gap-2 text-[11px]">
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-300">
                <Clock className="w-3 h-3" /> 예정 {monthTotals.scheduled}
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                <CheckCircle2 className="w-3 h-3" /> 완료 {monthTotals.completed}
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-300">
                <ShieldAlert className="w-3 h-3" /> 이슈 {monthTotals.issues}
              </span>
            </div>
          </div>

          {/* Week-day header */}
          <div className="grid grid-cols-7 gap-1 px-1 text-[11px] text-muted-foreground select-none">
            {WEEKDAYS.map((w, i) => (
              <div
                key={w}
                className={`text-center py-1.5 font-semibold ${
                  i === 0 ? 'text-red-400/90' : i === 6 ? 'text-blue-400/90' : ''
                }`}
              >
                {w}
              </div>
            ))}
          </div>

          {/* Day cells */}
          <div className="grid grid-cols-7 gap-1.5 p-1.5 rounded-2xl bg-secondary/20 border border-border/40">
            {grid.map((d) => {
              const key = toDateKey(d);
              const b = buckets.get(key) ?? { scheduled: [], completed: [], issues: [] };
              const total = b.scheduled.length + b.completed.length + b.issues.length;
              const lvl = intensityLevel(total);
              const inMonth = d.getMonth() === cursor.m;
              const isToday = key === todayKey;
              const isSelected = key === selected;
              const dow = d.getDay();
              const dayNumberClr = isToday
                ? 'text-primary'
                : dow === 0
                ? 'text-red-400/90'
                : dow === 6
                ? 'text-blue-400/90'
                : 'text-foreground/85';

              return (
                <div
                  key={key}
                  onClick={(e) => handleDayClick(key, e)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleDayClick(key, e as unknown as React.MouseEvent<HTMLDivElement>);
                    }
                  }}
                  className={`group relative rounded-xl border bg-card text-left cursor-pointer transition-all flex flex-col p-2 min-h-[110px] ${
                    isSelected
                      ? 'border-primary ring-2 ring-primary/30 shadow-sm'
                      : isToday
                      ? 'border-primary/45'
                      : 'border-border/60 hover:border-primary/40 hover:shadow-sm'
                  } ${!inMonth ? 'opacity-45' : ''}`}
                  title={`${key} · 예정 ${b.scheduled.length} · 완료 ${b.completed.length} · 이슈 ${b.issues.length} — 클릭하면 상세`}
                >
                  {/* Heatmap shade (background) */}
                  <span
                    className={`absolute inset-0 rounded-xl pointer-events-none ${intensityClass(lvl)} opacity-90`}
                    aria-hidden
                  />

                  {/* Day number row */}
                  <div className="relative flex items-start justify-between gap-1">
                    <span className={`text-[12px] font-semibold tabular-nums leading-none ${dayNumberClr}`}>
                      {d.getDate()}
                      {isToday && (
                        <span className="ml-1 align-super text-[8px] font-bold uppercase tracking-wider text-primary">today</span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected(key);
                        setQuickAddDate(key);
                      }}
                      className={`w-5 h-5 rounded-md inline-flex items-center justify-center bg-card/80 backdrop-blur-sm shadow-sm border border-border text-muted-foreground hover:text-primary hover:border-primary/40 transition-all ${
                        isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
                      }`}
                      title="이 날짜에 일정 등록"
                      aria-label={`${key} 일정 등록`}
                      tabIndex={inMonth ? 0 : -1}
                    >
                      <Plus className="w-3 h-3" />
                    </button>
                  </div>

                  {/* Mini event chips */}
                  {total > 0 && (
                    <div className="relative mt-1 space-y-0.5 overflow-hidden flex-1">
                      {b.completed.length > 0 && (
                        <DayChip
                          color="emerald"
                          count={b.completed.length}
                          label={truncate(stripHtml(b.completed[0].content) || '완료')}
                        />
                      )}
                      {b.scheduled.length > 0 && (
                        <DayChip
                          color="blue"
                          count={b.scheduled.length}
                          label={truncate(stripHtml(b.scheduled[0].content) || '예정')}
                        />
                      )}
                      {b.issues.length > 0 && (
                        <DayChip
                          color="amber"
                          count={b.issues.length}
                          label={truncate(stripHtml(b.issues[0].content) || '이슈')}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Legend */}
          <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1 px-1 flex-wrap gap-2">
            <div className="flex items-center gap-1.5">
              <span>적음</span>
              <span className={`w-3 h-3 rounded ${intensityClass(0)}`} />
              <span className={`w-3 h-3 rounded ${intensityClass(1)}`} />
              <span className={`w-3 h-3 rounded ${intensityClass(2)}`} />
              <span className={`w-3 h-3 rounded ${intensityClass(3)}`} />
              <span className={`w-3 h-3 rounded ${intensityClass(4)}`} />
              <span>많음</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-500" /> 완료
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-blue-500" /> 예정
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-amber-500" /> 이슈
              </span>
            </div>
          </div>
        </div>

      </div>

      {/* ── Day-detail popover — 사이드바 flyout 과 동일 패턴 ─────────────────── */}
      {popoverAnchor && (
        <DayDetailPopover
          anchorRect={popoverAnchor}
          label={selectedDateLabel}
          bucket={selectedBucket}
          onClose={closePopover}
          onQuickAdd={() => {
            closePopover();
            setQuickAddDate(selected);
          }}
        />
      )}

      <QuickAddTaskModal
        open={!!quickAddDate}
        defaultDate={quickAddDate ?? selected}
        defaultClusterId={selectedClusterId}
        onClose={() => setQuickAddDate(null)}
      />
    </>
  );
}

// ── Day-detail popover — 사이드바 그룹 flyout 패턴 그대로 (createPortal + 외부클릭 닫기) ──
interface DayDetailPopoverProps {
  anchorRect: DOMRect;
  label: string;
  bucket: DayBucket;
  onClose: () => void;
  onQuickAdd: () => void;
}

function DayDetailPopover({ anchorRect, label, bucket, onClose, onQuickAdd }: DayDetailPopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({
    top: anchorRect.bottom + 6,
    left: anchorRect.left,
  });

  // viewport clamp — 화면 밖으로 새지 않도록 보정.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const POPOVER_W = 320;
    const margin = 8;
    let top = anchorRect.bottom + 6;
    let left = anchorRect.left;
    // 가로: 우측 잘림 방지
    if (left + POPOVER_W > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - POPOVER_W - margin);
    }
    // 세로: 화면 아래 잘리면 위로 띄움
    const popH = el.getBoundingClientRect().height;
    if (top + popH > window.innerHeight - margin) {
      top = Math.max(margin, anchorRect.top - popH - 6);
    }
    setPos({ top, left });
  }, [anchorRect]);

  // ESC 로 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const total = bucket.scheduled.length + bucket.completed.length + bucket.issues.length;

  return createPortal(
    <>
      {/* 외부 클릭 캐처 */}
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden />

      <div
        ref={ref}
        role="dialog"
        aria-label={`${label} 상세`}
        style={{ top: pos.top, left: pos.left, width: 320 }}
        className="fixed z-50 bg-card border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border bg-muted/30">
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight truncate">{label}</p>
            <p className="text-[11px] text-muted-foreground tabular-nums">총 {total}건</p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              type="button"
              onClick={onQuickAdd}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold bg-primary hover:bg-primary/90 text-primary-foreground transition-colors"
              title={`${label} 에 일정 등록`}
            >
              <CalendarPlus className="w-3.5 h-3.5" />
              일정
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="닫기"
              className="p-1 rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="px-3 py-3 space-y-3 overflow-y-auto max-h-[360px]">
          {bucket.completed.length > 0 && (
            <DayList
              icon={<CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
              title="완료"
              count={bucket.completed.length}
              onItemClick={onClose}
              items={bucket.completed.map((t) => {
                const TypeIcon = WORK_ITEM_TYPE_CONFIG[t.type]?.Icon;
                return {
                  id: t.id,
                  primary: stripHtml(t.content) || t.category,
                  meta: `${WORK_ITEM_TYPE_CONFIG[t.type]?.label ?? t.type} · ${t.assignee || '미지정'} · ${STATUS_LABEL[t.kanbanStatus]}`,
                  leadingIcon: TypeIcon ? <TypeIcon className="w-3.5 h-3.5 text-emerald-500" /> : null,
                };
              })}
            />
          )}
          {bucket.scheduled.length > 0 && (
            <DayList
              icon={<Clock className="w-3.5 h-3.5 text-blue-500" />}
              title="예정"
              count={bucket.scheduled.length}
              onItemClick={onClose}
              items={bucket.scheduled.map((t) => {
                const TypeIcon = WORK_ITEM_TYPE_CONFIG[t.type]?.Icon;
                return {
                  id: t.id,
                  primary: stripHtml(t.content) || t.category,
                  meta: `${WORK_ITEM_TYPE_CONFIG[t.type]?.label ?? t.type} · ${t.assignee || '미지정'} · ${STATUS_LABEL[t.kanbanStatus]}`,
                  leadingIcon: TypeIcon ? <TypeIcon className="w-3.5 h-3.5 text-blue-500" /> : null,
                };
              })}
            />
          )}
          {bucket.issues.length > 0 && (
            <DayList
              icon={<ShieldAlert className="w-3.5 h-3.5 text-amber-500" />}
              title="이슈"
              count={bucket.issues.length}
              onItemClick={onClose}
              items={bucket.issues.map((i) => ({
                id: i.id,
                primary: stripHtml(i.content) || i.category,
                meta: `${i.assignee || '미지정'}${i.closedAt ? ' · 해결' : ''}`,
              }))}
            />
          )}
          {total === 0 && (
            <div className="flex flex-col items-center justify-center text-center text-xs text-muted-foreground py-8 gap-2">
              <div className="w-12 h-12 rounded-2xl bg-secondary flex items-center justify-center">
                <CalendarPlus className="w-5 h-5 opacity-50" />
              </div>
              <p>해당 날짜에 등록된 업무가 없습니다.</p>
              <button
                type="button"
                onClick={onQuickAdd}
                className="mt-1 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
              >
                <Plus className="w-3 h-3" /> 업무 등록
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end px-3 py-1.5 border-t border-border/60 bg-muted/10">
          <Link
            to="/todo-today"
            onClick={onClose}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors"
          >
            오늘 할일 상세 <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      </div>
    </>,
    document.body,
  );
}

function truncate(s: string, n = 14): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

interface DayChipProps {
  color: 'emerald' | 'blue' | 'amber';
  count: number;
  label: string;
}

const CHIP_COLOR: Record<DayChipProps['color'], string> = {
  emerald: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
  blue:    'bg-blue-500/15    text-blue-700    dark:text-blue-300    border-blue-500/30',
  amber:   'bg-amber-500/15   text-amber-700   dark:text-amber-300   border-amber-500/30',
};

function DayChip({ color, count, label }: DayChipProps) {
  return (
    <div
      className={`flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-md border truncate ${CHIP_COLOR[color]}`}
    >
      {count > 1 && <span className="font-bold tabular-nums">{count}</span>}
      <span className="truncate">{label}</span>
    </div>
  );
}

interface DayListProps {
  icon: React.ReactNode;
  title: string;
  count: number;
  items: Array<{ id: string; primary: string; meta: string; leadingIcon?: React.ReactNode }>;
  /** 항목 클릭 시 호출 — popover 를 닫는 용도. */
  onItemClick?: () => void;
}

function DayList({ icon, title, count, items, onItemClick }: DayListProps) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
        {icon}
        <span>{title}</span>
        <span className="text-foreground tabular-nums">{count}</span>
      </div>
      <ul className="space-y-1">
        {items.slice(0, 6).map((it) => (
          <li key={it.id}>
            <Link
              to={`/tasks-mgmt/${it.id}`}
              onClick={onItemClick}
              className="block text-xs px-2 py-1.5 rounded-lg bg-secondary/40 hover:bg-secondary/70 hover:ring-1 hover:ring-primary/30 transition-colors"
              title="상세 보기"
            >
              <div className="flex items-start gap-1.5 min-w-0">
                {it.leadingIcon && <span className="flex-shrink-0 mt-0.5">{it.leadingIcon}</span>}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-foreground">{it.primary}</p>
                  <p className="truncate text-[10px] text-muted-foreground">{it.meta}</p>
                </div>
              </div>
            </Link>
          </li>
        ))}
        {items.length > 6 && (
          <li className="text-[10px] text-muted-foreground px-2">+{items.length - 6}건 더…</li>
        )}
      </ul>
    </div>
  );
}
