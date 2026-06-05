import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  CalendarCheck2, Clock, CheckCircle2, Circle, AlertTriangle,
  Plus, RefreshCw, ArrowRight, LayoutGrid, List as ListIcon,
  Server, Loader2, ChevronRight, ChevronLeft, CalendarClock, CalendarDays,
  Rocket, Target,
} from 'lucide-react';
import { useWorkItems, usePatchWorkItemStatus, useUpdateWorkItem } from '@/hooks/useWorkItems';
import { useCurrentSprint, useCreateSprint } from '@/hooks/useSprints';
import { useAuthStore } from '@/stores/authStore';
import { ViewModeBar, useToast } from '@/components/common';
import { stripHtml, formatApiError } from '@/lib/utils';
import type { WorkItem, KanbanStatus } from '@/types';

// ── helpers ─────────────────────────────────────────────────────────────────
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dateOf(t: WorkItem): string {
  return t.startedAt?.slice(0, 10) ?? '';
}
function fmtDue(t: WorkItem): string {
  const s = t.startedAt;
  if (!s) return '-';
  const d = new Date(s.endsWith('Z') ? s : s + 'Z');
  if (isNaN(d.getTime())) return s.slice(0, 16);
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return hm === '00:00' ? md : `${md} ${hm}`;
}
function timeLabel(t: WorkItem): string {
  const s = t.startedAt;
  if (!s) return '종일';
  const d = new Date(s.endsWith('Z') ? s : s + 'Z');
  if (isNaN(d.getTime())) return '종일';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return hm === '00:00' ? '종일' : hm;
}
function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDateLabel(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return dateStr;
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${days[d.getDay()]})`;
}
function clusterLabel(t: WorkItem): string | null {
  if (t.clusterNames && t.clusterNames.length) return t.clusterNames.join(', ');
  return t.clusterName || null;
}
function displayTitle(t: WorkItem): string {
  return t.title?.trim() || stripHtml(t.content) || t.category || '(제목 없음)';
}

const PRIORITY_DOT: Record<string, string> = {
  high: 'bg-red-500', medium: 'bg-blue-500', low: 'bg-slate-400',
};
const STATUS_META: Record<KanbanStatus, { label: string; cls: string }> = {
  backlog:     { label: '백로그',     cls: 'bg-slate-500/10 text-slate-400 border-slate-500/30' },
  todo:        { label: '할일',       cls: 'bg-blue-500/10 text-blue-400 border-blue-500/30' },
  in_progress: { label: '진행중',     cls: 'bg-amber-500/10 text-amber-500 border-amber-500/30' },
  review_test: { label: '검토/테스트', cls: 'bg-purple-500/10 text-purple-400 border-purple-500/30' },
  done:        { label: '완료',       cls: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30' },
};

type ViewMode = 'sprint' | 'schedule' | 'card' | 'list';

function daysBetween(fromStr: string, toStr: string): number {
  const a = new Date(fromStr + 'T00:00:00');
  const b = new Date(toStr + 'T00:00:00');
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}
function fmtRange(start: string, end: string): string {
  const f = (s: string) => {
    const d = new Date(s + 'T00:00:00');
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  return `${f(start)} – ${f(end)}`;
}
type BucketTone = 'overdue' | 'today' | 'upcoming' | 'done';
const TONE: Record<BucketTone, { ring: string; text: string; dot: string }> = {
  overdue:  { ring: 'border-red-500/30',    text: 'text-red-500',     dot: 'bg-red-500' },
  today:    { ring: 'border-blue-500/30',   text: 'text-blue-500',    dot: 'bg-blue-500' },
  upcoming: { ring: 'border-border',        text: 'text-muted-foreground', dot: 'bg-muted-foreground/50' },
  done:     { ring: 'border-emerald-500/30', text: 'text-emerald-600', dot: 'bg-emerald-500' },
};

// ── item renderers ────────────────────────────────────────────────────────────
interface ItemProps {
  item: WorkItem;
  busy: boolean;
  onToggleDone: (t: WorkItem) => void;
  onOpen: (t: WorkItem) => void;
}

function CompleteBtn({ item, busy, onToggleDone }: Omit<ItemProps, 'onOpen'>) {
  const done = item.kanbanStatus === 'done';
  return (
    <button
      type="button"
      disabled={busy}
      onClick={(e) => { e.stopPropagation(); onToggleDone(item); }}
      title={done ? '완료 취소' : '완료 처리'}
      className={`flex-shrink-0 rounded-full transition-colors disabled:opacity-50 ${done ? 'text-emerald-500' : 'text-muted-foreground/40 hover:text-emerald-500'}`}
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : done ? <CheckCircle2 className="w-4 h-4" /> : <Circle className="w-4 h-4" />}
    </button>
  );
}

function ItemCard({ item, busy, onToggleDone, onOpen }: ItemProps) {
  const cl = clusterLabel(item);
  const done = item.kanbanStatus === 'done';
  return (
    <div
      onClick={() => onOpen(item)}
      className="group cursor-pointer rounded-xl border border-border bg-card/60 hover:bg-card hover:border-primary/30 p-3 transition-colors"
    >
      <div className="flex items-start gap-2">
        <CompleteBtn item={item} busy={busy} onToggleDone={onToggleDone} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PRIORITY_DOT[item.priority] ?? PRIORITY_DOT.medium}`} />
            <span className={`text-sm font-medium truncate ${done ? 'line-through text-muted-foreground' : ''}`}>{displayTitle(item)}</span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-muted-foreground">
            <span className={`px-1.5 py-0.5 rounded border ${STATUS_META[item.kanbanStatus]?.cls ?? STATUS_META.todo.cls}`}>
              {STATUS_META[item.kanbanStatus]?.label ?? '할일'}
            </span>
            <span className="px-1.5 py-0.5 rounded-full bg-secondary">{item.category}</span>
            <span className="inline-flex items-center gap-0.5"><Clock className="w-2.5 h-2.5" />{fmtDue(item)}</span>
            {cl && <span className="inline-flex items-center gap-0.5"><Server className="w-2.5 h-2.5" />{cl}</span>}
          </div>
        </div>
        <ChevronRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-primary flex-shrink-0" />
      </div>
    </div>
  );
}

function ItemRow({ item, busy, onToggleDone, onOpen }: ItemProps) {
  const cl = clusterLabel(item);
  const done = item.kanbanStatus === 'done';
  return (
    <div
      onClick={() => onOpen(item)}
      className="group cursor-pointer flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-secondary/50 transition-colors text-sm"
    >
      <CompleteBtn item={item} busy={busy} onToggleDone={onToggleDone} />
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PRIORITY_DOT[item.priority] ?? PRIORITY_DOT.medium}`} />
      <span className={`flex-1 min-w-0 truncate ${done ? 'line-through text-muted-foreground' : ''}`}>{displayTitle(item)}</span>
      <span className={`hidden sm:inline px-1.5 py-0.5 rounded border text-[10px] flex-shrink-0 ${STATUS_META[item.kanbanStatus]?.cls ?? STATUS_META.todo.cls}`}>
        {STATUS_META[item.kanbanStatus]?.label ?? '할일'}
      </span>
      {cl && <span className="hidden md:inline text-[10px] text-muted-foreground flex-shrink-0 max-w-[140px] truncate">{cl}</span>}
      <span className="text-[11px] text-muted-foreground font-mono flex-shrink-0 w-20 text-right">{fmtDue(item)}</span>
    </div>
  );
}

// ── section ─────────────────────────────────────────────────────────────────
function Section({
  title, tone, items, view, busyId, onToggleDone, onOpen, defaultOpen = true,
}: {
  title: string; tone: BucketTone; items: WorkItem[]; view: ViewMode;
  busyId: string | null; onToggleDone: (t: WorkItem) => void; onOpen: (t: WorkItem) => void; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (items.length === 0) return null;
  const t = TONE[tone];
  return (
    <div className={`rounded-2xl border ${t.ring} bg-card/40 overflow-hidden`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-secondary/30 transition-colors"
      >
        <span className={`w-2 h-2 rounded-full ${t.dot}`} />
        <span className={`text-sm font-semibold ${t.text}`}>{title}</span>
        <span className="text-xs text-muted-foreground">{items.length}</span>
        <ChevronRight className={`w-4 h-4 text-muted-foreground ml-auto transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className={view === 'card' ? 'p-3 pt-0 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2' : 'px-2 pb-2 divide-y divide-border/40'}>
          {items.map((it) =>
            view === 'card'
              ? <ItemCard key={it.id} item={it} busy={busyId === it.id} onToggleDone={onToggleDone} onOpen={onOpen} />
              : <ItemRow key={it.id} item={it} busy={busyId === it.id} onToggleDone={onToggleDone} onOpen={onOpen} />,
          )}
        </div>
      )}
    </div>
  );
}

// ── page ────────────────────────────────────────────────────────────────────
export function TodoTodayPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const user = useAuthStore((s) => s.user);
  const myName = (user?.displayName?.trim() || user?.username || '').trim();

  const [view, setView] = useState<ViewMode>('sprint');
  const [scheduleDate, setScheduleDate] = useState<string>(todayStr());
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data: currentSprint } = useCurrentSprint();
  const createSprint = useCreateSprint();
  const updateItem = useUpdateWorkItem();

  const { data, isLoading, isError, refetch, isFetching } = useWorkItems(
    myName ? { assignee: myName } : undefined,
  );
  // 전체 참석(회의 등) — 담당자가 아니어도 모두의 일정에 포함.
  const { data: allAttendData } = useWorkItems({ allAttendees: true });
  const patchStatus = usePatchWorkItemStatus();

  // 정확히 "내" 업무만 (담당자 정/부/legacy 중 내 이름) + 전체 참석 항목.
  const mine = useMemo(() => {
    if (!myName) return [];
    const items = data?.data ?? [];
    const mineItems = items.filter((t) => {
      const names = [t.assignee, t.primaryAssignee, ...(t.secondaryAssignee?.split(',').map((s) => s.trim()) ?? [])];
      return names.includes(myName);
    });
    // 전체 참석 항목 merge (id 중복 제거).
    const seen = new Set(mineItems.map((t) => t.id));
    const allAttend = (allAttendData?.data ?? []).filter((t) => !seen.has(t.id));
    return [...mineItems, ...allAttend];
  }, [data, allAttendData, myName]);

  const today = todayStr();
  // 일정(시간표) 뷰 — 선택한 날짜의 내 일정만, 시간순.
  const daySchedule = useMemo(
    () => mine
      .filter((t) => dateOf(t) === scheduleDate)
      .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '')),
    [mine, scheduleDate],
  );
  const buckets = useMemo(() => {
    const open = mine.filter((t) => t.kanbanStatus !== 'done');
    const sortByDue = (a: WorkItem, b: WorkItem) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '');
    const overdue = open.filter((t) => dateOf(t) && dateOf(t) < today).sort(sortByDue);
    const todayList = open.filter((t) => dateOf(t) === today).sort(sortByDue);
    const upcoming = open.filter((t) => dateOf(t) > today).sort(sortByDue);
    const doneRecent = mine
      .filter((t) => t.kanbanStatus === 'done')
      .sort((a, b) => (b.closedAt ?? b.startedAt ?? '').localeCompare(a.closedAt ?? a.startedAt ?? ''))
      .slice(0, 12);
    const inProgress = open.filter((t) => t.kanbanStatus === 'in_progress').length;
    return { overdue, todayList, upcoming, doneRecent, inProgress };
  }, [mine, today]);

  // 스프린트 뷰 — 내 항목을 현재 스프린트 커밋 / 후보(미배정·미완료)로 분리.
  const sprint = useMemo(() => {
    const sid = currentSprint?.id;
    const committed = sid ? mine.filter((t) => t.sprintId === sid) : [];
    const sortByDue = (a: WorkItem, b: WorkItem) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '');
    const inProgress = committed.filter((t) => t.kanbanStatus === 'in_progress').sort(sortByDue);
    const todo = committed.filter((t) => t.kanbanStatus !== 'in_progress' && t.kanbanStatus !== 'done').sort(sortByDue);
    const done = committed.filter((t) => t.kanbanStatus === 'done').sort(sortByDue);
    // 후보: 이 스프린트에 없고 미완료인 내 항목 (이월/추가 대상)
    const candidates = mine
      .filter((t) => t.sprintId !== sid && t.kanbanStatus !== 'done')
      .sort(sortByDue);
    const total = committed.length;
    const doneCount = done.length;
    const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;
    const effort = committed.reduce((acc, t) => acc + (t.effortHours ?? 0), 0);
    return { committed, inProgress, todo, done, candidates, total, doneCount, pct, effort };
  }, [mine, currentSprint]);

  const onAddToSprint = (t: WorkItem, sprintId: string) => {
    setBusyId(t.id);
    updateItem.mutate(
      { id: t.id, data: { sprintId } },
      {
        onSettled: () => setBusyId(null),
        onError: (err) => toast.error('스프린트 배정 실패', formatApiError(err, '항목을 스프린트에 추가할 수 없습니다.')),
      },
    );
  };
  const onStartSprint = () => {
    const start = todayStr();
    const end = addDaysStr(start, 13); // 2주 (시작일 포함 14일)
    const d = new Date(start + 'T00:00:00');
    const name = `스프린트 ${d.getMonth() + 1}/${d.getDate()}`;
    createSprint.mutate(
      { name, startDate: start, endDate: end, status: 'active' },
      {
        onSuccess: () => toast.success('스프린트 시작', `${name} (${fmtRange(start, end)}) 가 생성되었습니다.`),
        onError: (err) => toast.error('스프린트 생성 실패', formatApiError(err, '스프린트를 만들 수 없습니다.')),
      },
    );
  };

  const onToggleDone = (t: WorkItem) => {
    const next: KanbanStatus = t.kanbanStatus === 'done' ? 'todo' : 'done';
    setBusyId(t.id);
    patchStatus.mutate(
      { id: t.id, kanbanStatus: next },
      {
        onSettled: () => setBusyId(null),
        onError: (err) => toast.error('상태 변경 실패', formatApiError(err, '상태를 변경할 수 없습니다.')),
      },
    );
  };
  const onOpen = (t: WorkItem) => navigate(`/tasks-mgmt/${t.id}`);

  const stats = [
    { label: '지연', value: buckets.overdue.length, cls: 'text-red-500' },
    { label: '오늘', value: buckets.todayList.length, cls: 'text-blue-500' },
    { label: '진행중', value: buckets.inProgress, cls: 'text-amber-500' },
    { label: '예정', value: buckets.upcoming.length, cls: 'text-foreground' },
  ];
  const totalOpen = buckets.overdue.length + buckets.todayList.length + buckets.upcoming.length;

  return (
    <div className="p-6 flex flex-col gap-5 min-h-screen max-w-[1200px] mx-auto">
      {/* 헤더 */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <CalendarCheck2 className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-bold">{myName ? `${myName}님의 Work To Do` : 'Work To Do'}</h1>
          </div>
          <p className="text-sm text-muted-foreground">내 일정·할일만 모아 봅니다 (다른 사람 일정은 표시되지 않습니다).</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <ViewModeBar
            modes={[
              { id: 'sprint', label: '스프린트', icon: <Rocket className="w-3.5 h-3.5" /> },
              { id: 'schedule', label: '일정', icon: <CalendarClock className="w-3.5 h-3.5" /> },
              { id: 'card', label: '카드', icon: <LayoutGrid className="w-3.5 h-3.5" /> },
              { id: 'list', label: '리스트', icon: <ListIcon className="w-3.5 h-3.5" /> },
            ]}
            active={view}
            onChange={(v) => setView(v as ViewMode)}
            showStylePanel={false}
          />
          <Link
            to="/tasks-mgmt"
            className="hidden sm:flex items-center gap-1.5 px-3 py-2 text-sm text-muted-foreground hover:text-foreground bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors"
          >
            업무 게시판 <ArrowRight className="w-3.5 h-3.5" />
          </Link>
          <button
            onClick={() => navigate('/tasks-mgmt/new')}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors"
          >
            <Plus className="w-4 h-4" /> 업무 추가
          </button>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="p-2 rounded-lg bg-secondary hover:bg-secondary/80 border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            title="새로고침"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* 요약 통계 */}
      <div className="grid grid-cols-4 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="bg-card border border-border rounded-xl px-4 py-3">
            <p className="text-xs text-muted-foreground mb-0.5">{s.label}</p>
            <p className={`text-2xl font-bold tabular-nums ${s.cls}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* 본문 */}
      {!myName ? (
        <div className="flex flex-col items-center justify-center py-20 gap-2 text-muted-foreground">
          <AlertTriangle className="w-8 h-8 opacity-40" />
          <p className="text-sm">로그인 후 본인 담당 업무가 표시됩니다.</p>
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
      ) : isError ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-destructive">
          <AlertTriangle className="w-8 h-8" />
          <p className="text-sm">데이터를 불러오는 중 오류가 발생했습니다.</p>
          <button onClick={() => refetch()} className="px-4 py-2 text-sm bg-secondary hover:bg-secondary/80 border border-border rounded-lg">다시 시도</button>
        </div>
      ) : view === 'sprint' ? (
        !currentSprint ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4 text-muted-foreground">
            <Rocket className="w-12 h-12 opacity-30 text-primary" />
            <div className="text-center">
              <p className="text-base font-medium text-foreground">진행 중인 스프린트가 없습니다</p>
              <p className="text-sm mt-1 opacity-70">이번 반복에 집중할 할일을 모아보세요. (기간은 스프린트 페이지에서 1~4주로 조절)</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onStartSprint}
                disabled={createSprint.isPending}
                className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-50"
              >
                {createSprint.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                2주 스프린트 시작
              </button>
              <button
                onClick={() => navigate('/sprints')}
                className="flex items-center gap-1.5 px-4 py-2 text-sm bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors"
              >
                기간 직접 설정
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {/* 스프린트 헤더 */}
            <div className="bg-card border border-border rounded-2xl p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
                <div className="flex items-center gap-2 min-w-0">
                  <Rocket className="w-5 h-5 text-primary flex-shrink-0" />
                  <div className="min-w-0">
                    <h2 className="text-base font-bold truncate">{currentSprint.name}</h2>
                    <p className="text-xs text-muted-foreground">
                      {fmtRange(currentSprint.startDate, currentSprint.endDate)}
                      {(() => {
                        const left = daysBetween(today, currentSprint.endDate);
                        if (left < 0) return <span className="ml-1.5 text-red-500 font-medium">종료됨</span>;
                        if (left === 0) return <span className="ml-1.5 text-amber-500 font-medium">오늘 마감</span>;
                        return <span className="ml-1.5 text-primary font-medium">D-{left}</span>;
                      })()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-emerald-600">완료 {sprint.doneCount}</span>
                  <span className="text-muted-foreground">전체 {sprint.total}</span>
                  {sprint.effort > 0 && <span className="text-muted-foreground">{sprint.effort}h</span>}
                  <span className="text-primary font-semibold">{sprint.pct}%</span>
                </div>
              </div>
              {currentSprint.goal && (
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground mb-3">
                  <Target className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-primary/70" />{currentSprint.goal}
                </p>
              )}
              <div className="h-2 rounded-full bg-secondary overflow-hidden">
                <div className="h-full bg-primary rounded-full transition-all duration-300" style={{ width: `${sprint.pct}%` }} />
              </div>
            </div>

            {sprint.total === 0 && sprint.candidates.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-14 gap-2 text-muted-foreground">
                <CheckCircle2 className="w-10 h-10 opacity-30 text-emerald-500" />
                <p className="text-sm">이번 스프린트에 담긴 내 할일이 없습니다.</p>
              </div>
            ) : (
              <>
                <Section title="진행중" tone="today" items={sprint.inProgress} view="list" busyId={busyId} onToggleDone={onToggleDone} onOpen={onOpen} />
                <Section title="할일" tone="upcoming" items={sprint.todo} view="list" busyId={busyId} onToggleDone={onToggleDone} onOpen={onOpen} />
                <Section title="완료" tone="done" items={sprint.done} view="list" busyId={busyId} onToggleDone={onToggleDone} onOpen={onOpen} defaultOpen={false} />

                {/* 스프린트에 추가 후보 */}
                {sprint.candidates.length > 0 && (
                  <div className="rounded-2xl border border-dashed border-border bg-card/30 overflow-hidden">
                    <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/60">
                      <Plus className="w-4 h-4 text-muted-foreground" />
                      <span className="text-sm font-semibold text-muted-foreground">스프린트에 추가</span>
                      <span className="text-xs text-muted-foreground">{sprint.candidates.length}</span>
                      <span className="ml-auto text-[11px] text-muted-foreground/70">미배정 · 미완료 내 할일</span>
                    </div>
                    <div className="px-2 py-1 divide-y divide-border/40">
                      {sprint.candidates.map((t) => {
                        const cl = clusterLabel(t);
                        return (
                          <div key={t.id} className="group flex items-center gap-2 px-2 py-2 text-sm">
                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PRIORITY_DOT[t.priority] ?? PRIORITY_DOT.medium}`} />
                            <button onClick={() => onOpen(t)} className="flex-1 min-w-0 truncate text-left hover:text-primary transition-colors">{displayTitle(t)}</button>
                            {cl && <span className="hidden md:inline text-[10px] text-muted-foreground flex-shrink-0 max-w-[120px] truncate">{cl}</span>}
                            <span className="text-[11px] text-muted-foreground font-mono flex-shrink-0 w-16 text-right">{fmtDue(t)}</span>
                            <button
                              onClick={() => onAddToSprint(t, currentSprint.id)}
                              disabled={busyId === t.id}
                              className="flex-shrink-0 flex items-center gap-1 px-2 py-1 text-[11px] rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50"
                            >
                              {busyId === t.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}추가
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )
      ) : view === 'schedule' ? (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
            <CalendarDays className="w-4 h-4 text-primary flex-shrink-0" />
            <button onClick={() => setScheduleDate((d) => addDaysStr(d, -1))} className="p-1 rounded hover:bg-secondary text-muted-foreground" aria-label="이전 날"><ChevronLeft className="w-4 h-4" /></button>
            <span className="text-sm font-semibold min-w-[150px] text-center">
              {fmtDateLabel(scheduleDate)}
              {scheduleDate === today && <span className="ml-1.5 text-xs text-primary font-medium">오늘</span>}
            </span>
            <button onClick={() => setScheduleDate((d) => addDaysStr(d, 1))} className="p-1 rounded hover:bg-secondary text-muted-foreground" aria-label="다음 날"><ChevronRight className="w-4 h-4" /></button>
            {scheduleDate !== today && (
              <button onClick={() => setScheduleDate(today)} className="text-xs px-2 py-0.5 rounded-full border border-primary/30 text-primary hover:bg-primary/10 transition-colors">오늘로</button>
            )}
            <span className="ml-auto text-xs text-muted-foreground">{daySchedule.length}건</span>
          </div>
          {daySchedule.length === 0 ? (
            <div className="py-14 text-center text-sm text-muted-foreground">이 날짜에 예정된 일정이 없습니다.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="text-left px-3 py-2 w-16">시간</th>
                    <th className="text-left px-3 py-2">업무</th>
                    <th className="text-left px-3 py-2 w-20">상태</th>
                    <th className="text-center px-2 py-2 w-12">우선</th>
                    <th className="text-left px-3 py-2 w-32">클러스터</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {daySchedule.map((t) => {
                    const done = t.kanbanStatus === 'done';
                    const cl = clusterLabel(t);
                    return (
                      <tr key={t.id} onClick={() => onOpen(t)} className="cursor-pointer hover:bg-secondary/40 transition-colors">
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground whitespace-nowrap">{timeLabel(t)}</td>
                        <td className="px-3 py-2"><span className={`font-medium ${done ? 'line-through text-muted-foreground' : ''}`}>{displayTitle(t)}</span></td>
                        <td className="px-3 py-2">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${STATUS_META[t.kanbanStatus]?.cls ?? STATUS_META.todo.cls}`}>
                            {STATUS_META[t.kanbanStatus]?.label ?? '할일'}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-center"><span className={`inline-block w-2 h-2 rounded-full ${PRIORITY_DOT[t.priority] ?? PRIORITY_DOT.medium}`} /></td>
                        <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-[140px]">{cl ?? '—'}</td>
                        <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
                          <CompleteBtn item={t} busy={busyId === t.id} onToggleDone={onToggleDone} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : totalOpen === 0 && buckets.doneRecent.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
          <CheckCircle2 className="w-12 h-12 opacity-30 text-emerald-500" />
          <div className="text-center">
            <p className="text-base font-medium">처리할 할일이 없습니다 🎉</p>
            <p className="text-sm mt-1 opacity-70">담당으로 지정된 미완료 업무가 없습니다.</p>
          </div>
          <button onClick={() => navigate('/tasks-mgmt/new')} className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary/10 text-primary hover:bg-primary/20 rounded-lg transition-colors">
            <Plus className="w-4 h-4" /> 업무 추가
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Section title="지연" tone="overdue" items={buckets.overdue} view={view} busyId={busyId} onToggleDone={onToggleDone} onOpen={onOpen} />
          <Section title="오늘" tone="today" items={buckets.todayList} view={view} busyId={busyId} onToggleDone={onToggleDone} onOpen={onOpen} />
          <Section title="예정" tone="upcoming" items={buckets.upcoming} view={view} busyId={busyId} onToggleDone={onToggleDone} onOpen={onOpen} />
          <Section title="최근 완료" tone="done" items={buckets.doneRecent} view={view} busyId={busyId} onToggleDone={onToggleDone} onOpen={onOpen} defaultOpen={false} />
        </div>
      )}
    </div>
  );
}
