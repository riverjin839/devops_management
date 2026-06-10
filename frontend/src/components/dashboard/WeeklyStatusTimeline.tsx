import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronLeft, ChevronRight, CalendarDays, Star, Flag,
  CheckCircle2, Clock, Circle, AlertCircle, ListTree, Users,
  ClipboardList, CalendarCheck, Plus, Contrast,
} from 'lucide-react';
import type { WorkItem, KanbanStatus } from '@/types';
import { useWorkItems } from '@/hooks/useWorkItems';
import { useAuthStore } from '@/stores/authStore';
import { stripHtml, cn } from '@/lib/utils';

// 평일(월~금)만 표시한다.
const DAY_COUNT = 5;

// ── date helpers ──────────────────────────────────────────────────────────────
function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
/** 해당 날짜가 속한 주의 월요일 0시. */
function startOfWeek(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  const day = r.getDay();               // 0=일 … 6=토
  const diff = day === 0 ? -6 : 1 - day; // 월요일로 back
  r.setDate(r.getDate() + diff);
  return r;
}
function weeksBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (7 * 86400000));
}
const KR_DAYS = ['일', '월', '화', '수', '목', '금', '토'];

type ViewMode = 'task' | 'assignee';

// ── status visual map (macOS / Claude soft gradient bars) ───────────────────────
const STATUS_BAR: Record<KanbanStatus, { grad: string; ring: string; label: string }> = {
  done:        { grad: 'from-emerald-400 to-emerald-500', ring: 'ring-emerald-500/30', label: '완료' },
  in_progress: { grad: 'from-sky-400 to-blue-500',        ring: 'ring-blue-500/30',    label: '진행중' },
  review_test: { grad: 'from-violet-400 to-purple-500',   ring: 'ring-purple-500/30',  label: '검토' },
  todo:        { grad: 'from-amber-300 to-orange-400',    ring: 'ring-orange-500/30',  label: 'Todo' },
  backlog:     { grad: 'from-slate-300 to-slate-400',     ring: 'ring-slate-500/30',   label: 'Backlog' },
};

function StatusGlyph({ status }: { status: KanbanStatus }) {
  if (status === 'done') return <CheckCircle2 className="w-3 h-3 flex-shrink-0" />;
  if (status === 'in_progress') return <Clock className="w-3 h-3 flex-shrink-0" />;
  if (status === 'review_test') return <Clock className="w-3 h-3 flex-shrink-0" />;
  return <Circle className="w-3 h-3 flex-shrink-0" />;
}

// ── derived row models ──────────────────────────────────────────────────────────
interface TaskBar {
  item: WorkItem;
  startIdx: number;     // 0..DAY_COUNT-1 within the visible week
  endIdx: number;       // 0..DAY_COUNT-1 within the visible week
  clippedLeft: boolean; // bar starts before this week
  clippedRight: boolean;// bar ends after this week (or after Fri)
}
interface Milestone {
  issue: WorkItem;
  dayIdx: number;       // 0..DAY_COUNT-1
}
interface AssigneeRow {
  name: string;
  lanes: TaskBar[][];   // greedy-packed sub-lanes so overlapping bars never collide
}

/** 겹치지 않게 막대를 sub-lane 으로 분배 (greedy interval packing). */
function packLanes(bars: TaskBar[]): TaskBar[][] {
  const lanes: TaskBar[][] = [];
  const sorted = [...bars].sort((a, b) => a.startIdx - b.startIdx || a.endIdx - b.endIdx);
  for (const bar of sorted) {
    let placed = false;
    for (const lane of lanes) {
      if (lane[lane.length - 1].endIdx < bar.startIdx) { lane.push(bar); placed = true; break; }
    }
    if (!placed) lanes.push([bar]);
  }
  return lanes;
}

interface WeeklyStatusTimelineProps {
  /** 외부에서 work item 을 주입하면 그대로 사용, 미지정 시 useWorkItems 로 직접 조회. */
  items?: WorkItem[];
  isLoading?: boolean;
  selectedClusterId?: string | null;
}

export function WeeklyStatusTimeline({ items, isLoading, selectedClusterId }: WeeklyStatusTimelineProps) {
  const navigate = useNavigate();
  const { data, isLoading: queryLoading } = useWorkItems();
  const workItems = items ?? data?.data ?? [];
  const loading = isLoading ?? queryLoading;

  // 막대/마일스톤 클릭 → 상세 업무 페이지로 이동.
  const openWorkItem = (id: string) => navigate(`/tasks-mgmt/${id}`);

  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [viewMode, setViewMode] = useState<ViewMode>('assignee');

  // ── 슬라이더 색 반전 — 사용자별 설정(localStorage) ──
  const currentUser = useAuthStore((s) => s.user);
  const sliderInvertKey = `k8s:weekSliderInvert:${currentUser?.username ?? 'guest'}`;
  const [sliderInvert, setSliderInvert] = useState<boolean>(() => {
    try { return localStorage.getItem(sliderInvertKey) === '1'; } catch { return false; }
  });
  // 로그인 사용자가 바뀌면 그 사용자의 저장값으로 동기화.
  useEffect(() => {
    try { setSliderInvert(localStorage.getItem(sliderInvertKey) === '1'); } catch { /* noop */ }
  }, [sliderInvertKey]);
  const toggleSliderInvert = () => {
    setSliderInvert((prev) => {
      const next = !prev;
      try { localStorage.setItem(sliderInvertKey, next ? '1' : '0'); } catch { /* noop */ }
      return next;
    });
  };

  // 월~금 5일.
  const days = useMemo(() => Array.from({ length: DAY_COUNT }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const weekStartStr = fmtDate(weekStart);
  const weekEndStr = fmtDate(days[DAY_COUNT - 1]);
  const todayStr = fmtDate(today);

  // cluster filter + type split (작업류 = bar, issue = milestone)
  const scoped = selectedClusterId ? workItems.filter((w) => w.clusterId === selectedClusterId) : workItems;
  const taskItems  = useMemo(() => scoped.filter((w) => w.type !== 'issue'), [scoped]);
  const issueItems = useMemo(() => scoped.filter((w) => w.type === 'issue'), [scoped]);

  // ── task bars overlapping this week ──
  const taskBars: TaskBar[] = useMemo(() => {
    const out: TaskBar[] = [];
    for (const item of taskItems) {
      const s = item.startedAt?.slice(0, 10);
      if (!s) continue;
      // ongoing tasks extend to today; done/closed use closedAt (fallback start)
      const eRaw = item.closedAt?.slice(0, 10)
        ?? ((item.kanbanStatus ?? 'todo') === 'done' ? s : fmtDate(today));
      const e = eRaw < s ? s : eRaw;
      // overlap test against [weekStartStr(월), weekEndStr(금)]
      if (e < weekStartStr || s > weekEndStr) continue;

      const startIdx = days.findIndex(d => fmtDate(d) >= s);
      const startClamped = startIdx === -1 ? 0 : (s <= weekStartStr ? 0 : startIdx);
      let endClamped = DAY_COUNT - 1;
      for (let i = DAY_COUNT - 1; i >= 0; i--) { if (fmtDate(days[i]) <= e) { endClamped = i; break; } }
      out.push({
        item,
        startIdx: startClamped,
        endIdx: Math.max(startClamped, endClamped),
        clippedLeft: s < weekStartStr,
        clippedRight: e > weekEndStr,
      });
    }
    // sort: by start day, then priority (high first)
    const prio: Record<string, number> = { high: 0, medium: 1, low: 2 };
    return out.sort((a, b) =>
      a.startIdx - b.startIdx || (prio[a.item.priority] ?? 1) - (prio[b.item.priority] ?? 1));
  }, [taskItems, days, weekStartStr, weekEndStr, today]);

  // ── assignee swimlanes (작업자 기준 보기) ──
  const assigneeRows: AssigneeRow[] = useMemo(() => {
    const map = new Map<string, TaskBar[]>();
    for (const b of taskBars) {
      // 담당자 필드에 쉼표로 여러 명이 들어올 수 있다 (예: "A,B") — 한 명씩 분리해 각자 레인에 배치.
      const raw = b.item.primaryAssignee || b.item.assignee || '';
      const names = raw.split(',').map((n) => n.trim()).filter(Boolean);
      if (names.length === 0) names.push('미지정');
      for (const name of names) {
        const arr = map.get(name);
        if (arr) arr.push(b); else map.set(name, [b]);
      }
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0], 'ko'))
      .map(([name, bars]) => ({ name, lanes: packLanes(bars) }));
  }, [taskBars]);

  // ── milestones (issues that occurred this week) ──
  const milestones: Milestone[] = useMemo(() => {
    const out: Milestone[] = [];
    for (const issue of issueItems) {
      const d = issue.startedAt?.slice(0, 10);
      if (!d || d < weekStartStr || d > weekEndStr) continue;
      const idx = days.findIndex(x => fmtDate(x) === d);
      if (idx >= 0) out.push({ issue, dayIdx: idx });
    }
    return out;
  }, [issueItems, days, weekStartStr, weekEndStr]);

  const monthLabel = (() => {
    const a = weekStart, b = days[DAY_COUNT - 1];
    const fa = `${a.getMonth() + 1}월`;
    const fb = `${b.getMonth() + 1}월`;
    return fa === fb ? fa : `${fa}–${fb}`;
  })();

  // ── slider range: span from earliest to latest dated item (+1 week padding) ──
  const { minWeek, totalWeeks } = useMemo(() => {
    const stamps: number[] = [startOfWeek(today).getTime()];
    const consider = (s?: string | null) => {
      if (!s) return;
      const d = startOfWeek(new Date(s.slice(0, 10) + 'T00:00:00'));
      if (!Number.isNaN(d.getTime())) stamps.push(d.getTime());
    };
    for (const w of scoped) { consider(w.startedAt); consider(w.closedAt); }
    const lo = addDays(new Date(Math.min(...stamps)), -7);   // 1-week padding each side
    const hi = addDays(new Date(Math.max(...stamps)), 7);
    return { minWeek: lo, totalWeeks: weeksBetween(lo, hi) + 1 };
  }, [scoped, today]);

  const currentIndex = Math.max(0, Math.min(totalWeeks - 1, weeksBetween(minWeek, weekStart)));
  const setIndex = (idx: number) => {
    const c = Math.max(0, Math.min(totalWeeks - 1, idx));
    setWeekStart(addDays(minWeek, c * 7));
  };
  const goPrev = () => setIndex(currentIndex - 1);
  const goNext = () => setIndex(currentIndex + 1);
  const goToday = () => setWeekStart(startOfWeek(new Date()));
  const isThisWeek = weekStartStr === fmtDate(startOfWeek(today));
  const rangeStart = minWeek;
  const rangeEnd = addDays(minWeek, (totalWeeks - 1) * 7 + (DAY_COUNT - 1));
  const shortDate = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;

  // thumb-center alignment for ticks/tooltip (thumb is 16px wide)
  const frac = totalWeeks > 1 ? currentIndex / (totalWeeks - 1) : 0;
  const centerLeft = (f: number) => `calc(${f} * (100% - 16px) + 8px)`;
  const todayIdx = Math.max(0, Math.min(totalWeeks - 1, weeksBetween(minWeek, startOfWeek(today))));
  const showTicks = totalWeeks > 1 && totalWeeks <= 24;

  // ── mouse-wheel over the slider → move week by week (non-passive) ──
  const sliderWrapRef = useRef<HTMLDivElement>(null);
  const wheelAcc = useRef(0);
  useEffect(() => {
    const el = sliderWrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheelAcc.current += e.deltaY;
      const TH = 40; // trackpad-friendly threshold
      if (wheelAcc.current >= TH) { wheelAcc.current = 0; setIndex(currentIndex + 1); }
      else if (wheelAcc.current <= -TH) { wheelAcc.current = 0; setIndex(currentIndex - 1); }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, totalWeeks, minWeek]);

  // 공통: 요일 컬럼 배경 셀 (track 뒤에 깔리는 grid lines)
  const DayCells = () => (
    <>
      {days.map((d) => {
        const isTd = fmtDate(d) === todayStr;
        return <div key={fmtDate(d)} className={`border-l border-border/40 ${isTd ? 'bg-primary/[0.04]' : ''}`} />;
      })}
    </>
  );

  const colsClass = 'grid-cols-5'; // 평일 5컬럼 (Tailwind 가 literal 로 인식하도록 고정)

  return (
    <div className="space-y-3">
      {/* ── toolbar ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-sm">
          <CalendarDays className="w-4 h-4 text-primary" />
          <span className="font-semibold">{monthLabel}</span>
          <span className="text-muted-foreground text-xs font-mono">{weekStartStr} ~ {weekEndStr}</span>
          {!isThisWeek && (
            <button onClick={goToday}
              className="ml-1 px-2 py-0.5 text-[11px] font-medium rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors">
              이번 주
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* 보기 전환: 업무 기준 ↔ 담당자 기준 */}
          <div className="flex items-center rounded-lg border border-border overflow-hidden text-[11px]">
            <button
              onClick={() => setViewMode('task')}
              aria-pressed={viewMode === 'task'}
              className={`flex items-center gap-1 px-2 py-1 transition-colors ${
                viewMode === 'task' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground'}`}>
              <ListTree className="w-3 h-3" /> 업무 기준
            </button>
            <button
              onClick={() => setViewMode('assignee')}
              aria-pressed={viewMode === 'assignee'}
              className={`flex items-center gap-1 px-2 py-1 border-l border-border transition-colors ${
                viewMode === 'assignee' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground'}`}>
              <Users className="w-3 h-3" /> 담당자 기준
            </button>
          </div>
          {/* 단축키 — 업무 관리 / 오늘 할일 페이지로 바로 이동 */}
          <div className="flex items-center gap-1 text-[11px]">
            <button
              type="button"
              onClick={() => navigate('/tasks-mgmt')}
              title="업무 관리로 이동"
              className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors">
              <ClipboardList className="w-3 h-3" /> 업무 관리
            </button>
            <button
              type="button"
              onClick={() => navigate('/tasks-mgmt/new')}
              title="새 업무 등록"
              className="flex items-center gap-1 px-2 py-1 rounded-lg border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 transition-colors">
              <Plus className="w-3 h-3" /> 업무 등록
            </button>
            <button
              type="button"
              onClick={() => navigate('/todo-today')}
              title="Work To Do 로 이동"
              className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors">
              <CalendarCheck className="w-3 h-3" /> Work To Do
            </button>
          </div>
          <div className="hidden sm:flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-gradient-to-r from-sky-400 to-blue-500" />업무 {taskBars.length}</span>
            <span className="flex items-center gap-1"><Star className="w-3 h-3 text-amber-500 fill-amber-400" />마일스톤 {milestones.length}</span>
          </div>
        </div>
      </div>

      {/* ── week slider (◀ ━━●━━ ▶) — drag to move week by week ──────────────── */}
      <div className={cn(
        'flex items-center gap-2.5 px-1 transition-colors',
        sliderInvert && 'bg-foreground rounded-2xl py-2 px-2',
      )}>
        {/* 색 반전 토글 — 사용자별 설정. 작게. */}
        <button
          onClick={toggleSliderInvert}
          aria-pressed={sliderInvert}
          title={sliderInvert ? '슬라이더 색 반전 끄기' : '슬라이더 색 반전 켜기'}
          className={cn(
            'p-1 rounded-lg transition-colors flex-shrink-0',
            sliderInvert
              ? 'bg-background/15 text-background hover:bg-background/25'
              : 'bg-secondary text-muted-foreground hover:bg-card hover:text-foreground',
          )}>
          <Contrast className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={goPrev}
          disabled={currentIndex <= 0}
          aria-label="이전 주"
          className={cn(
            'p-1.5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
            sliderInvert
              ? 'bg-background/15 text-background hover:bg-background/25'
              : 'bg-secondary text-muted-foreground hover:bg-card hover:text-foreground',
          )}>
          <ChevronLeft className="w-4 h-4" />
        </button>

        <div ref={sliderWrapRef} className="flex-1 flex flex-col gap-1" title="휠을 굴려 주를 넘길 수 있어요">
          {/* slider + drag tooltip */}
          <div className="relative pt-1 group">
            <input
              type="range"
              min={0}
              max={Math.max(0, totalWeeks - 1)}
              step={1}
              value={currentIndex}
              onChange={(e) => setIndex(Number(e.target.value))}
              aria-label="주간 슬라이더"
              className={cn('week-slider peer w-full h-1.5 cursor-pointer accent-primary', sliderInvert && 'week-slider-invert')}
            />
            {/* tooltip: shows currently-viewed week range above the thumb */}
            <div
              className={cn(
                'pointer-events-none absolute -top-6 -translate-x-1/2 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-medium opacity-0 shadow-md transition-opacity peer-hover:opacity-100 peer-focus-visible:opacity-100 peer-active:opacity-100',
                sliderInvert ? 'bg-background text-foreground' : 'bg-foreground text-background',
              )}
              style={{ left: centerLeft(frac) }}
            >
              {shortDate(weekStart)} ~ {shortDate(days[DAY_COUNT - 1])}
            </div>
          </div>

          {/* week tick ruler */}
          {showTicks && (
            <div className="relative h-2">
              {Array.from({ length: totalWeeks }, (_, i) => {
                const f = totalWeeks > 1 ? i / (totalWeeks - 1) : 0;
                const isTd = i === todayIdx;
                const isCur = i === currentIndex;
                return (
                  <span
                    key={i}
                    className={`absolute top-0 -translate-x-1/2 rounded-full ${
                      isCur ? 'bg-primary w-[3px] h-2'
                      : isTd ? (sliderInvert ? 'bg-background/60 w-px h-2' : 'bg-primary/50 w-px h-2')
                      : (sliderInvert ? 'bg-background/30 w-px h-1.5' : 'bg-border w-px h-1.5')
                    }`}
                    style={{ left: centerLeft(f) }}
                  />
                );
              })}
            </div>
          )}

          <div className={cn(
            'flex justify-between text-[10px] font-mono',
            sliderInvert ? 'text-background/70' : 'text-muted-foreground/70',
          )}>
            <span>{shortDate(rangeStart)}</span>
            <span className={cn('font-semibold', sliderInvert ? 'text-background' : 'text-primary')}>{currentIndex + 1} / {totalWeeks}주</span>
            <span>{shortDate(rangeEnd)}</span>
          </div>
        </div>

        <button
          onClick={goNext}
          disabled={currentIndex >= totalWeeks - 1}
          aria-label="다음 주"
          className={cn(
            'p-1.5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
            sliderInvert
              ? 'bg-background/15 text-background hover:bg-background/25'
              : 'bg-secondary text-muted-foreground hover:bg-card hover:text-foreground',
          )}>
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* ── timeline grid ───────────────────────────────────────────────────── */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden mac-shadow">
        {/* header: weekday columns (월~금) */}
        <div className="grid grid-cols-[140px_1fr] sm:grid-cols-[200px_1fr] border-b border-border bg-secondary/30">
          <div className="px-4 py-2.5 text-[11px] font-semibold text-muted-foreground">
            {viewMode === 'assignee' ? '담당자 / 마일스톤' : '업무 / 마일스톤'}
          </div>
          <div className={`grid ${colsClass}`}>
            {days.map((d) => {
              const ds = fmtDate(d);
              const isTd = ds === todayStr;
              return (
                <div key={ds}
                  className={`px-1 py-2 text-center border-l border-border/60 ${isTd ? 'bg-primary/10' : ''}`}>
                  <div className={`text-[10px] ${isTd ? 'text-primary font-bold' : 'text-muted-foreground'}`}>
                    {KR_DAYS[d.getDay()]}
                  </div>
                  <div className={`text-[11px] font-semibold ${isTd ? 'text-primary' : ''}`}>
                    {d.getMonth() + 1}/{d.getDate()}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* body */}
        {loading ? (
          <div className="divide-y divide-border/60">
            {[0, 1, 2, 3].map(i => (
              <div key={i} className="grid grid-cols-[140px_1fr] sm:grid-cols-[200px_1fr]">
                <div className="px-4 py-3"><div className="h-3 w-24 bg-muted/50 rounded animate-pulse" /></div>
                <div className="px-3 py-3"><div className="h-5 bg-muted/40 rounded-lg animate-pulse" style={{ width: `${40 + i * 12}%`, marginLeft: `${i * 10}%` }} /></div>
              </div>
            ))}
          </div>
        ) : taskBars.length === 0 && milestones.length === 0 ? (
          <div className="py-14 flex flex-col items-center justify-center text-muted-foreground">
            <CalendarDays className="w-9 h-9 mb-2 opacity-30" />
            <p className="text-sm">이번 주에 예정된 작업이 없습니다.</p>
            <p className="text-[11px] mt-0.5 opacity-70">다른 주를 보려면 화살표를 사용하세요.</p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {/* milestone strip */}
            {milestones.length > 0 && (
              <div className="grid grid-cols-[140px_1fr] sm:grid-cols-[200px_1fr] bg-amber-500/[0.04]">
                <div className="px-4 py-2.5 flex items-center gap-1.5 text-[11px] font-semibold text-amber-600">
                  <Flag className="w-3.5 h-3.5" /> 마일스톤
                </div>
                <div className={`relative grid ${colsClass} min-h-[44px]`}>
                  <DayCells />
                  {milestones.map(({ issue, dayIdx }) => {
                    const resolved = !!issue.closedAt;
                    return (
                      <button key={issue.id} type="button"
                        onClick={() => openWorkItem(issue.id)}
                        className="absolute top-1/2 -translate-y-1/2 flex items-center gap-1 px-1 text-left rounded hover:bg-amber-500/10 transition-colors cursor-pointer"
                        style={{ left: `${(dayIdx / DAY_COUNT) * 100}%`, width: `${(1 / DAY_COUNT) * 100}%` }}
                        title={stripHtml(issue.content)}>
                        <Star className={`w-3.5 h-3.5 flex-shrink-0 ${resolved ? 'text-emerald-500 fill-emerald-400' : 'text-amber-500 fill-amber-400'}`} />
                        <span className={`text-[10px] font-medium truncate ${resolved ? 'text-emerald-600' : 'text-amber-700'}`}>
                          {issue.title?.trim() || stripHtml(issue.content)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── 업무 기준: 한 업무 = 한 행 ── */}
            {viewMode === 'task' && taskBars.map(({ item, startIdx, endIdx, clippedLeft, clippedRight }) => {
              const status = item.kanbanStatus ?? 'todo';
              const sv = STATUS_BAR[status] ?? STATUS_BAR.todo;
              const span = endIdx - startIdx + 1;
              const team = item.primaryAssignee || item.assignee;
              return (
                <div key={item.id} className="grid grid-cols-[140px_1fr] sm:grid-cols-[200px_1fr] hover:bg-secondary/20 transition-colors">
                  {/* label */}
                  <div className="px-4 py-2.5 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full bg-gradient-to-r ${sv.grad}`} />
                      <span className="text-xs font-medium truncate">{item.title?.trim() || stripHtml(item.content)}</span>
                    </div>
                    {item.category && (
                      <p className="text-[10px] text-muted-foreground truncate mt-0.5 pl-3">{item.category}</p>
                    )}
                  </div>
                  {/* track */}
                  <div className={`relative grid ${colsClass} min-h-[44px]`}>
                    <DayCells />
                    {/* bar */}
                    <div
                      className="absolute top-1/2 -translate-y-1/2 px-1.5 py-1"
                      style={{ left: `${(startIdx / DAY_COUNT) * 100}%`, width: `${(span / DAY_COUNT) * 100}%` }}
                    >
                      <button type="button"
                        onClick={() => openWorkItem(item.id)}
                        title={stripHtml(item.content)}
                        className={`w-full h-6 rounded-lg bg-gradient-to-r ${sv.grad} ring-1 ${sv.ring} shadow-sm flex items-center gap-1 px-2 text-white overflow-hidden cursor-pointer hover:brightness-110 transition
                        ${clippedLeft ? 'rounded-l-none' : ''} ${clippedRight ? 'rounded-r-none' : ''}`}>
                        <StatusGlyph status={status} />
                        <span className="text-[10px] font-semibold truncate">{team || sv.label}</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}

            {/* ── 담당자 기준: 한 담당자 = 한 swimlane(여러 sub-lane) ── */}
            {viewMode === 'assignee' && assigneeRows.map(({ name, lanes }) => {
              const LANE_H = 32; // px per sub-lane
              const trackH = lanes.length * LANE_H + 12;
              const total = lanes.reduce((n, l) => n + l.length, 0);
              return (
                <div key={name} className="grid grid-cols-[140px_1fr] sm:grid-cols-[200px_1fr] hover:bg-secondary/20 transition-colors">
                  {/* label */}
                  <div className="px-4 py-3 min-w-0 flex flex-col justify-center">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Users className="w-3.5 h-3.5 flex-shrink-0 text-primary" />
                      <span className="text-xs font-semibold truncate">{name}</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5 pl-5">{total}건</p>
                  </div>
                  {/* track */}
                  <div className={`relative grid ${colsClass}`} style={{ minHeight: trackH }}>
                    <DayCells />
                    {lanes.map((lane, laneIdx) =>
                      lane.map(({ item, startIdx, endIdx, clippedLeft, clippedRight }) => {
                        const status = item.kanbanStatus ?? 'todo';
                        const sv = STATUS_BAR[status] ?? STATUS_BAR.todo;
                        const span = endIdx - startIdx + 1;
                        return (
                          <div key={item.id}
                            className="absolute px-1.5"
                            style={{
                              left: `${(startIdx / DAY_COUNT) * 100}%`,
                              width: `${(span / DAY_COUNT) * 100}%`,
                              top: laneIdx * LANE_H + 6,
                            }}>
                            <button type="button"
                              onClick={() => openWorkItem(item.id)}
                              title={stripHtml(item.content)}
                              className={`w-full h-6 rounded-lg bg-gradient-to-r ${sv.grad} ring-1 ${sv.ring} shadow-sm flex items-center gap-1 px-2 text-white overflow-hidden cursor-pointer hover:brightness-110 transition
                              ${clippedLeft ? 'rounded-l-none' : ''} ${clippedRight ? 'rounded-r-none' : ''}`}>
                              <StatusGlyph status={status} />
                              <span className="text-[10px] font-semibold truncate">{item.title?.trim() || stripHtml(item.content)}</span>
                            </button>
                          </div>
                        );
                      }),
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── legend ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap text-[11px] text-muted-foreground px-1">
        <span className="font-medium">범례</span>
        {(Object.keys(STATUS_BAR) as KanbanStatus[]).map((k) => (
          <span key={k} className="flex items-center gap-1">
            <span className={`w-3 h-2.5 rounded-sm bg-gradient-to-r ${STATUS_BAR[k].grad}`} />
            {STATUS_BAR[k].label}
          </span>
        ))}
        <span className="flex items-center gap-1"><Star className="w-3 h-3 text-amber-500 fill-amber-400" />미해결 이슈</span>
        <span className="flex items-center gap-1"><AlertCircle className="w-3 h-3 text-emerald-500" />해결 이슈</span>
      </div>
    </div>
  );
}
