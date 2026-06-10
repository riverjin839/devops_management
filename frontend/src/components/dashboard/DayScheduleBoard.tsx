import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronLeft, ChevronRight, RotateCcw, Plus, CalendarClock, Clock3,
} from 'lucide-react';
import { useWorkItems } from '@/hooks/useWorkItems';
import { useAuthStore } from '@/stores/authStore';
import { stripHtml, cn } from '@/lib/utils';
import { WORK_ITEM_TYPE_CONFIG } from '@/components/work-items/workItemKanbanUtils';
import { QuickAddTaskModal } from './QuickAddTaskModal';
import type { WorkItem, KanbanStatus } from '@/types';

interface DayScheduleBoardProps {
  selectedClusterId: string | null;
}

// ── date / time helpers ───────────────────────────────────────────────────────
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(dateStr: string, delta: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return dateKey(d);
}
function fmtLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const week = ['일', '월', '화', '수', '목', '금', '토'];
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} (${week[d.getDay()]})`;
}
/** ISO 문자열에 실제 시각 성분(T HH:mm)이 있는지 — 없으면 "시간 미지정". */
function hasClock(iso?: string | null): boolean {
  return !!iso && /T\d{2}:\d{2}/.test(iso);
}
function parseLocal(iso?: string | null): Date | null {
  if (!iso) return null;
  const norm = iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z';
  const d = new Date(norm);
  return Number.isNaN(d.getTime()) ? null : d;
}
function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── status visual map (macOS / Claude soft tints) ──────────────────────────────
const STATUS_STYLE: Record<KanbanStatus, { dot: string; bar: string; tint: string }> = {
  backlog:     { dot: 'bg-slate-400',   bar: 'bg-slate-400',   tint: 'bg-slate-500/[0.06]' },
  todo:        { dot: 'bg-blue-400',    bar: 'bg-blue-400',    tint: 'bg-blue-500/[0.06]' },
  in_progress: { dot: 'bg-amber-400',   bar: 'bg-amber-400',   tint: 'bg-amber-500/[0.07]' },
  review_test: { dot: 'bg-purple-400',  bar: 'bg-purple-400',  tint: 'bg-purple-500/[0.06]' },
  done:        { dot: 'bg-emerald-400', bar: 'bg-emerald-400', tint: 'bg-emerald-500/[0.06]' },
};

// 담당자 칩/아바타용 안정적 색상 — 이름 해시 기반.
const ASSIGNEE_PALETTE = [
  'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
  'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
];
function assigneeColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return ASSIGNEE_PALETTE[h % ASSIGNEE_PALETTE.length];
}

/** primary/secondary/assignee 필드를 쉼표 분리해 담당자 이름 배열로. */
function assigneeNames(w: WorkItem): string[] {
  const raw = [w.primaryAssignee, w.secondaryAssignee, w.assignee]
    .filter(Boolean)
    .join(',');
  const out: string[] = [];
  for (const n of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

interface PlacedItem {
  item: WorkItem;
  time: string | null; // HH:mm — null 이면 시간 미지정
  hour: number;        // 시간 미지정은 -1
}

/**
 * 좌측 메인 — 나의 당일 시간단위 스케줄.
 * 로그인한 사용자가 담당(primary/secondary/assignee)인 항목만 세로 시간축에 배치하고,
 * 빈 시간대를 클릭하면 그 시각으로 바로 등록(담당자 = 나)할 수 있다.
 */
export function DayScheduleBoard({ selectedClusterId }: DayScheduleBoardProps) {
  const navigate = useNavigate();
  const todayStr = dateKey(new Date());
  const [viewDate, setViewDate] = useState(todayStr);
  const isToday = viewDate === todayStr;

  const [quickAdd, setQuickAdd] = useState<{ time: string; assignee?: string } | null>(null);

  const currentUser = useAuthStore((s) => s.user);
  const myName = (currentUser?.displayName?.trim() || currentUser?.username || '').trim();

  const { data: workItemsData, isLoading } = useWorkItems();

  // viewDate 에 잡힌 "나의" 항목만 (startedAt 기준), 클러스터 필터 적용.
  const dayItems = useMemo<PlacedItem[]>(() => {
    const all = workItemsData?.data ?? [];
    const out: PlacedItem[] = [];
    for (const w of all) {
      if (selectedClusterId && w.clusterId !== selectedClusterId) continue;
      if (!myName || !assigneeNames(w).includes(myName)) continue;
      const parsed = parseLocal(w.startedAt);
      if (!parsed || dateKey(parsed) !== viewDate) continue;
      const timed = hasClock(w.startedAt);
      out.push({
        item: w,
        time: timed ? hhmm(parsed) : null,
        hour: timed ? parsed.getHours() : -1,
      });
    }
    return out;
  }, [workItemsData, selectedClusterId, viewDate, myName]);

  const filtered = dayItems;

  // 시간 미지정 / 시간대별 분리.
  const allDay = useMemo(() => filtered.filter((p) => p.hour < 0), [filtered]);
  const timed = useMemo(() => filtered.filter((p) => p.hour >= 0), [filtered]);

  // 표시 시간 범위 — 기본 08~19, 업무가 있으면 그에 맞춰 확장.
  const { startHour, endHour } = useMemo(() => {
    let lo = 8;
    let hi = 19;
    for (const p of timed) {
      if (p.hour < lo) lo = p.hour;
      if (p.hour > hi) hi = p.hour;
    }
    return { startHour: Math.max(0, lo), endHour: Math.min(23, hi) };
  }, [timed]);

  const hours = useMemo(
    () => Array.from({ length: endHour - startHour + 1 }, (_, i) => startHour + i),
    [startHour, endHour],
  );
  const byHour = useMemo(() => {
    const m = new Map<number, PlacedItem[]>();
    for (const p of timed) {
      const arr = m.get(p.hour);
      if (arr) arr.push(p); else m.set(p.hour, [p]);
    }
    for (const arr of m.values()) arr.sort((a, b) => (a.time ?? '').localeCompare(b.time ?? ''));
    return m;
  }, [timed]);

  const nowHour = new Date().getHours();
  const nowMin = new Date().getMinutes();

  const openItem = (id: string) => navigate(`/tasks-mgmt/${id}`);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── header: 날짜 네비 + 등록 ──────────────────────────────────────────── */}
      <div className="flex-none flex items-center gap-1.5 mb-2">
        <button
          onClick={() => setViewDate((d) => addDays(d, -1))}
          className="w-6 h-6 rounded-lg flex items-center justify-center hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
          title="이전 날"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <div className="flex items-center gap-1.5 px-1">
          <CalendarClock className="w-3.5 h-3.5 text-primary flex-shrink-0" />
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
            className="w-6 h-6 rounded-lg flex items-center justify-center hover:bg-secondary transition-colors text-muted-foreground hover:text-primary"
            title="오늘로 돌아가기"
          >
            <RotateCcw className="w-3 h-3" />
          </button>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{filtered.length}건</span>
        <button
          onClick={() => setQuickAdd({ time: isToday ? `${String(Math.min(nowHour, 23)).padStart(2, '0')}:00` : '09:00', assignee: myName || undefined })}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-primary/30 bg-primary/10 text-primary text-[11px] font-semibold hover:bg-primary/20 transition-colors"
          title="업무 등록"
        >
          <Plus className="w-3 h-3" /> 등록
        </button>
      </div>

      {/* ── "나의 일정" 표시 ─────────────────────────────────────────────────── */}
      {myName && (
        <div className="flex-none flex items-center gap-1.5 pb-2 mb-1">
          <span className={cn('w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold', assigneeColor(myName))}>
            {myName.slice(0, 2).toUpperCase()}
          </span>
          <span className="text-[11px] font-medium text-muted-foreground">{myName}님의 일정</span>
        </div>
      )}

      {/* ── body ────────────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-y-auto pr-1 -mr-1">
        {isLoading ? (
          <div className="space-y-2 pt-1">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-12 rounded-xl bg-secondary/40 animate-pulse" />
            ))}
          </div>
        ) : (
          <>
            {/* 시간 미지정 (종일) */}
            {allDay.length > 0 && (
              <div className="mb-2 rounded-xl border border-border/60 bg-secondary/20 p-2">
                <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
                  <Clock3 className="w-3 h-3" /> 시간 미지정 · {allDay.length}
                </div>
                <div className="space-y-1">
                  {allDay.map((p) => <EventCard key={p.item.id} placed={p} onOpen={openItem} />)}
                </div>
              </div>
            )}

            {/* 시간축 */}
            <div className="relative">
              {hours.map((h) => {
                const items = byHour.get(h) ?? [];
                const isNow = isToday && h === nowHour;
                return (
                  <div key={h} className="group relative flex gap-2 min-h-[44px]">
                    {/* 시각 라벨 */}
                    <div className="flex-none w-10 pt-1.5 text-right">
                      <span className={cn('text-[11px] tabular-nums', isNow ? 'text-primary font-semibold' : 'text-muted-foreground')}>
                        {String(h).padStart(2, '0')}:00
                      </span>
                    </div>
                    {/* 레인 */}
                    <div className="flex-1 min-w-0 border-l border-border/50 pl-2 py-1 relative">
                      {/* now 라인 */}
                      {isNow && (
                        <div
                          className="absolute left-0 right-1 flex items-center pointer-events-none z-10"
                          style={{ top: `${4 + (nowMin / 60) * 36}px` }}
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-primary -ml-[3px]" />
                          <span className="flex-1 h-px bg-primary/40" />
                        </div>
                      )}

                      {items.length > 0 ? (
                        <div className="space-y-1">
                          {items.map((p) => <EventCard key={p.item.id} placed={p} onOpen={openItem} />)}
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setQuickAdd({ time: `${String(h).padStart(2, '0')}:00`, assignee: myName || undefined })}
                          className="w-full h-7 rounded-lg border border-dashed border-transparent group-hover:border-border/70 flex items-center justify-center text-muted-foreground/0 group-hover:text-muted-foreground transition-all"
                          title={`${String(h).padStart(2, '0')}:00 에 업무 등록`}
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {filtered.length === 0 && (
              <div className="rounded-xl border border-dashed border-border/60 py-10 mt-2 text-center text-sm text-muted-foreground">
                {!myName
                  ? '로그인 후 나의 일정을 볼 수 있습니다.'
                  : `${isToday ? '오늘' : '해당 날짜'} 나의 일정이 없습니다.`}
                {myName && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setQuickAdd({ time: '09:00', assignee: myName })}
                      className="mt-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                    >
                      <Plus className="w-3 h-3" /> 업무 등록
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <QuickAddTaskModal
        open={!!quickAdd}
        defaultDate={viewDate}
        defaultTime={quickAdd?.time}
        defaultAssignee={quickAdd?.assignee}
        defaultClusterId={selectedClusterId}
        onClose={() => setQuickAdd(null)}
      />
    </div>
  );
}

// ── event card ─────────────────────────────────────────────────────────────────
function EventCard({ placed, onOpen }: { placed: PlacedItem; onOpen: (id: string) => void }) {
  const { item, time } = placed;
  const status = item.kanbanStatus ?? 'todo';
  const sv = STATUS_STYLE[status] ?? STATUS_STYLE.todo;
  const TypeIcon = WORK_ITEM_TYPE_CONFIG[item.type]?.Icon;
  const names = assigneeNames(item);
  const primary = names[0] ?? '미지정';
  const label = item.title?.trim() || stripHtml(item.content) || item.category;
  const done = status === 'done';

  return (
    <button
      type="button"
      onClick={() => onOpen(item.id)}
      title={label}
      className={cn(
        'w-full flex items-center gap-2 rounded-lg border border-border/60 pl-0 pr-2 py-1.5 text-left transition-colors hover:border-primary/40 hover:shadow-sm overflow-hidden',
        sv.tint,
      )}
    >
      <span className={cn('flex-none w-1 self-stretch rounded-full', sv.bar)} />
      <span className={cn('flex-none w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold', assigneeColor(primary))}>
        {primary.slice(0, 2).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 min-w-0">
          {TypeIcon && <TypeIcon className="w-3 h-3 flex-shrink-0 text-muted-foreground" />}
          <span className={cn('text-xs truncate', done ? 'text-muted-foreground line-through' : 'text-foreground font-medium')}>
            {label}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-muted-foreground min-w-0">
          <span className="truncate">{names.join(', ')}</span>
          {item.clusterName && <span className="flex-none hidden md:inline">· {item.clusterName}</span>}
        </div>
      </div>
      <div className="flex-none flex items-center gap-1.5">
        {time && <span className="text-[10px] tabular-nums text-muted-foreground">{time}</span>}
        <span className={cn('w-1.5 h-1.5 rounded-full', sv.dot)} />
      </div>
    </button>
  );
}
