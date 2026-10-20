import { useMemo, useState } from 'react';
import { StatTile, StatTileRow } from '@/components/common/StatTile';
import { Link, useNavigate } from 'react-router-dom';
import {
  CalendarCheck2, Clock, CheckCircle2, Circle, AlertTriangle,
  Plus, RefreshCw, ArrowRight, LayoutGrid, List as ListIcon,
  Server, Loader2, ChevronRight, ChevronLeft, CalendarClock, CalendarDays,
  Rocket, Target,
} from 'lucide-react';
import { useWorkItems, usePatchWorkItemStatus, useUpdateWorkItem } from '@/hooks/useWorkItems';
import { useCurrentSprint, useCreateSprint } from '@/hooks/useSprints';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useToday } from '@/hooks/useToday';
import { useAuthStore } from '@/stores/authStore';
import {
  ViewModeBar, useToast, PageHeader, PageShell, EmptyState, LoadingState, ErrorState,
} from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { stripHtml, formatApiError } from '@/lib/utils';
import { isAssignedTo, isMyDueTodo, itemDateKey } from '@/lib/workItems';
import type { WorkItem, KanbanStatus } from '@/types';

// ── helpers ─────────────────────────────────────────────────────────────────
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dateOf(t: WorkItem): string {
  // 저장은 UTC canonical → 로컬(KST) 날짜로 변환해 비교. (구 slice(0,10) 은 UTC 앞자리라
  // 이른 아침 KST 업무가 전날로 새던 버그의 원인 — 홈 KPI 와 동일 정의를 공유한다.)
  return itemDateKey(t);
}
function fmtDue(t: WorkItem): string {
  const s = t.startedAt;
  if (!s) return '일정 미정';
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

// 우선순위는 상태가 아니라 범주 — 상태 토큰(status-*) 대신 --chart-* (§12.12-4).
const PRIORITY_DOT: Record<string, string> = {
  high: 'bg-chart-5', medium: 'bg-chart-1', low: 'bg-chart-8',
};
const PRIORITY_LABEL: Record<string, string> = { high: '높음', medium: '보통', low: '낮음' };

/** 우선순위 점 — 색만으로 전달하지 않도록 스크린리더 텍스트·title 을 함께 둔다(D-166). */
function PriorityDot({ priority, className = 'w-1.5 h-1.5' }: { priority: string; className?: string }) {
  const label = `우선순위 ${PRIORITY_LABEL[priority] ?? PRIORITY_LABEL.medium}`;
  return (
    <span className="inline-flex flex-shrink-0" title={label}>
      <span className={`${className} rounded-full ${PRIORITY_DOT[priority] ?? PRIORITY_DOT.medium}`} aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}
const STATUS_META: Record<KanbanStatus, { label: string; cls: string }> = {
  backlog:     { label: '백로그',     cls: 'bg-chart-8/10 text-chart-8-text border-chart-8/30' },
  todo:        { label: '할일',       cls: 'bg-chart-1/10 text-chart-1-text border-chart-1/30' },
  in_progress: { label: '진행중',     cls: 'bg-chart-3/10 text-chart-3-text border-chart-3/30' },
  review_test: { label: '검토/테스트', cls: 'bg-chart-4/10 text-chart-4-text border-chart-4/30' },
  done:        { label: '완료',       cls: 'bg-secondary text-muted-foreground border-border' },
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
  overdue:  { ring: 'border-border', text: 'text-status-critical', dot: 'bg-status-critical' },
  today:    { ring: 'border-border', text: 'text-foreground', dot: 'bg-chart-1' },
  upcoming: { ring: 'border-border',        text: 'text-muted-foreground', dot: 'bg-muted-foreground/50' },
  done:     { ring: 'border-border', text: 'text-muted-foreground', dot: 'bg-muted-foreground/40' },
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
  // 상태 변경은 operator 이상(routers/work_items.py) — viewer 는 비활성 + 사유(§12.9).
  const { canOperate, withHint, ariaWithHint } = useCanOperate();
  const label = `${displayTitle(item)} ${done ? '완료 취소' : '완료 처리'}`;
  return (
    <button
      type="button"
      disabled={busy || !canOperate}
      onClick={(e) => { e.stopPropagation(); onToggleDone(item); }}
      title={withHint(done ? '완료 취소' : '완료 처리')}
      aria-label={ariaWithHint(label)}
      className={`relative z-10 flex-shrink-0 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${done ? 'text-muted-foreground' : 'text-muted-foreground/40 hover:text-primary'}`}
    >
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : done ? <CheckCircle2 className="w-4 h-4" /> : <Circle className="w-4 h-4" />}
    </button>
  );
}

function ItemCard({ item, busy, onToggleDone, onOpen }: ItemProps) {
  const cl = clusterLabel(item);
  const done = item.kanbanStatus === 'done';
  return (
    // D-165: 카드 전체 <div onClick> 대신 제목 버튼이 카드 면적을 덮는다(stretched button) — 키보드로 열 수 있다.
    <div className="group relative rounded-md border border-border bg-card hover:border-primary/30 focus-within:border-primary/40 p-2 transition-colors">
      <div className="flex items-start gap-2">
        <CompleteBtn item={item} busy={busy} onToggleDone={onToggleDone} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1">
            <PriorityDot priority={item.priority} />
            <button type="button" onClick={() => onOpen(item)} title={`${displayTitle(item)} 상세 열기`}
              className={`min-w-0 text-left text-sm font-medium truncate focus-visible:outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-primary/50 ${done ? 'line-through text-muted-foreground' : ''}`}>
              {displayTitle(item)}
            </button>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap text-xs text-muted-foreground">
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
    <div className="group relative flex items-center gap-2 px-3 py-1 rounded-lg hover:bg-secondary/50 transition-colors text-sm">
      <CompleteBtn item={item} busy={busy} onToggleDone={onToggleDone} />
      <PriorityDot priority={item.priority} />
      <button type="button" onClick={() => onOpen(item)} title={`${displayTitle(item)} 상세 열기`}
        className={`flex-1 min-w-0 truncate text-left focus-visible:outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-primary/50 ${done ? 'line-through text-muted-foreground' : ''}`}>
        {displayTitle(item)}
      </button>
      <span className={`hidden sm:inline px-1.5 py-0.5 rounded border text-xs flex-shrink-0 ${STATUS_META[item.kanbanStatus]?.cls ?? STATUS_META.todo.cls}`}>
        {STATUS_META[item.kanbanStatus]?.label ?? '할일'}
      </span>
      {cl && <span className="hidden md:inline text-xs text-muted-foreground flex-shrink-0 max-w-[140px] truncate">{cl}</span>}
      <span className="text-xs text-muted-foreground font-mono flex-shrink-0 w-20 text-right">{fmtDue(item)}</span>
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
    // D-122: 손으로 그린 접이식 헤더 행 → MacCard 슬롯(제목·건수·접기 버튼).
    <MacCard
      title={title}
      titleExtra={
        <span className="inline-flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${t.dot}`} aria-hidden />
          <span className={`text-xs tabular-nums ${tone === 'overdue' ? t.text : 'text-muted-foreground'}`}>{items.length}</span>
        </span>
      }
      actions={
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? `${title} 접기` : `${title} 펼치기`}
          title={open ? '접기' : '펼치기'}
          className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
        >
          <ChevronRight className={`w-4 h-4 transition-transform ${open ? 'rotate-90' : ''}`} />
        </button>
      }
      bodyPadding={open ? (view === 'card' ? 'p-3' : 'px-2 py-1') : 'p-0'}
    >
      {open && (
        <div className={view === 'card' ? 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2' : 'divide-y divide-border/40'}>
          {items.map((it) =>
            view === 'card'
              ? <ItemCard key={it.id} item={it} busy={busyId === it.id} onToggleDone={onToggleDone} onOpen={onOpen} />
              : <ItemRow key={it.id} item={it} busy={busyId === it.id} onToggleDone={onToggleDone} onOpen={onOpen} />,
          )}
        </div>
      )}
    </MacCard>
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

  const sprintQuery = useCurrentSprint();
  const currentSprint = sprintQuery.data;
  const createSprint = useCreateSprint();
  // 스프린트 생성·업무 추가·스프린트 배정·완료 토글은 operator 이상(routers/sprint.py·work_items.py)
  // — viewer 에게는 비활성 + 사유(§12.9).
  const { canOperate, withHint, ariaWithHint } = useCanOperate();
  const updateItem = useUpdateWorkItem();

  const { data, isLoading, isError, error, refetch, isFetching } = useWorkItems(
    myName ? { assignee: myName } : undefined,
  );
  // 공통업무(파트 회의 등) — 담당자가 아니어도 모두의 일정에 포함.
  const allAttendQuery = useWorkItems({ allAttendees: true });
  const allAttendData = allAttendQuery.data;
  const patchStatus = usePatchWorkItemStatus();

  // 정확히 "내" 업무만 (담당자 정/부/legacy 중 내 이름) + 공통업무 항목.
  const mine = useMemo(() => {
    if (!myName) return [];
    const items = data?.data ?? [];
    // 담당자 필드(정/부/legacy, 쉼표 복수)에 내 이름이 있으면 내 업무 — 공용 isAssignedTo.
    const mineItems = items.filter((t) => isAssignedTo(t, myName));
    // 공통업무 항목 merge (id 중복 제거).
    const seen = new Set(mineItems.map((t) => t.id));
    const allAttend = (allAttendData?.data ?? []).filter((t) => !seen.has(t.id));
    return [...mineItems, ...allAttend];
  }, [data, allAttendData, myName]);

  const today = useToday();  // 자정 넘기면 자동 갱신
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
    // D-163①: 지연+오늘은 홈 KPI 와 같은 정의(isMyDueTodo — 시작일이 오늘 이하 또는 미지정)를 쓴다.
    // 예전엔 시작일 없는 미완료 업무가 어느 구역에도 들지 않아 화면·통계에서 사라졌다. 일정 미정은 오늘 구역 끝에 둔다.
    const due = open.filter((t) => isMyDueTodo(t, myName, today));
    const overdue = due.filter((t) => dateOf(t) && dateOf(t) < today).sort(sortByDue);
    const todayList = [
      ...due.filter((t) => dateOf(t) === today).sort(sortByDue),
      ...due.filter((t) => !dateOf(t)),
    ];
    const upcoming = open.filter((t) => dateOf(t) > today).sort(sortByDue);
    const doneRecent = mine
      .filter((t) => t.kanbanStatus === 'done')
      .sort((a, b) => (b.closedAt ?? b.startedAt ?? '').localeCompare(a.closedAt ?? a.startedAt ?? ''))
      .slice(0, 12);
    const inProgress = open.filter((t) => t.kanbanStatus === 'in_progress').length;
    return { overdue, todayList, upcoming, doneRecent, inProgress };
  }, [mine, today, myName]);

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

  const stats: Array<{ label: string; value: number; tone?: 'critical' | 'warning' | 'info' }> = [
    { label: '지연', value: buckets.overdue.length, tone: 'critical' },
    { label: '오늘', value: buckets.todayList.length, tone: 'info' },
    { label: '진행중', value: buckets.inProgress },
    { label: '예정', value: buckets.upcoming.length },
  ];
  const totalOpen = buckets.overdue.length + buckets.todayList.length + buckets.upcoming.length;
  // D-153: 로딩·실패 중에는 0 타일을 보이지 않는다(장애를 "할일 0"으로 읽게 된다).
  const bodyReady = !!myName && !isLoading && !isError;

  return (
    <PageShell density="hub" className="flex flex-col gap-5 app-min-h-screen">
      {/* 헤더 */}
      <PageHeader
        icon={CalendarCheck2}
        title={myName ? `${myName}님의 오늘 할일` : '오늘 할일'}
        description="내 일정·할일만 모아 봅니다 (다른 사람 일정은 표시되지 않습니다)."
        actions={<>
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
            disabled={!canOperate}
            title={withHint('업무 추가')}
            aria-label={ariaWithHint('업무 추가')}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="w-4 h-4" /> 업무 추가
          </button>
          <button
            onClick={() => { void refetch(); void allAttendQuery.refetch(); void sprintQuery.refetch(); }}
            disabled={isFetching}
            className="p-2 rounded-lg bg-secondary hover:bg-secondary/80 border border-border text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            title="새로고침"
            aria-label="새로고침"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </>}
      />

      {/* 요약 통계 — 본문 조회가 끝난 뒤에만 */}
      {bodyReady && (
        <StatTileRow>
          {stats.map((s) => (
            <StatTile key={s.label} label={s.label} value={s.value} tone={s.tone} />
          ))}
        </StatTileRow>
      )}

      {/* 공통업무(파트 회의 등) 조회 실패 — 무음이면 일정이 빠진 줄 모른다 */}
      {bodyReady && allAttendQuery.isError && (
        <ErrorState compact error={allAttendQuery.error} title="공통업무를 불러오지 못했습니다 — 아래 목록에서 빠져 있습니다"
          onRetry={() => void allAttendQuery.refetch()} />
      )}

      {/* 본문 */}
      {!myName ? (
        <EmptyState
          icon={AlertTriangle}
          title="로그인 정보가 없습니다."
          description="로그인하면 본인이 담당한 업무가 여기에 표시됩니다."
        />
      ) : isLoading ? (
        <LoadingState label="할일을 불러오는 중…" />
      ) : isError ? (
        <ErrorState error={error} title="할일을 불러오지 못했습니다" onRetry={() => void refetch()} />
      ) : view === 'sprint' ? (
        sprintQuery.isLoading ? (
          <LoadingState label="스프린트를 불러오는 중…" />
        ) : sprintQuery.isError ? (
          // D-153: 조회 실패를 "진행 중인 스프린트 없음"으로 보여 주면 중복 스프린트를 만들게 된다.
          <ErrorState error={sprintQuery.error} title="현재 스프린트를 불러오지 못했습니다" onRetry={() => void sprintQuery.refetch()} />
        ) : !currentSprint ? (
          <EmptyState
            icon={Rocket}
            title="진행 중인 스프린트가 없습니다."
            description="이번 반복에 집중할 할일을 모아 보세요. 기간은 스프린트 화면에서 1~4주로 조절합니다."
          >
            <div className="flex items-center gap-2 mt-4">
              <button
                onClick={onStartSprint}
                disabled={createSprint.isPending || !canOperate}
                title={withHint('2주 스프린트 시작')}
                aria-label={ariaWithHint('2주 스프린트 시작')}
                className="flex items-center gap-1.5 px-4 py-2 text-sm bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-3">
            {/* 스프린트 헤더 */}
            {/* D-122: 스프린트 이름·기간·통계 수제 헤더 행 → MacCard 슬롯 */}
            <MacCard
              title={currentSprint.name}
              icon={Rocket}
              description={
                <>
                  {fmtRange(currentSprint.startDate, currentSprint.endDate)}
                  {(() => {
                    const left = daysBetween(today, currentSprint.endDate);
                    if (left < 0) return <span className="ml-1.5 text-status-critical font-medium">종료됨</span>;
                    if (left === 0) return <span className="ml-1.5 text-status-warning font-medium">오늘 마감</span>;
                    return <span className="ml-1.5 text-primary font-medium">D-{left}</span>;
                  })()}
                </>
              }
              actions={
                <div className="flex items-center gap-3 text-sm tabular-nums">
                  <span className="text-muted-foreground">완료 {sprint.doneCount}</span>
                  <span className="text-muted-foreground">전체 {sprint.total}</span>
                  {sprint.effort > 0 && <span className="text-muted-foreground">{sprint.effort}h</span>}
                  <span className="text-primary font-semibold">{sprint.pct}%</span>
                </div>
              }
            >
              {currentSprint.goal && (
                <p className="flex items-start gap-1.5 text-sm text-muted-foreground mb-3">
                  <Target className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-primary/70" />{currentSprint.goal}
                </p>
              )}
              <div className="h-2 rounded-full bg-secondary overflow-hidden">
                <div className="h-full bg-primary rounded-full transition-[width] duration-300" style={{ width: `${sprint.pct}%` }} />
              </div>
            </MacCard>

            {sprint.total === 0 && sprint.candidates.length === 0 ? (
              <EmptyState
                icon={CheckCircle2}
                title="이번 스프린트에 담긴 내 할일이 없습니다."
                description="업무 게시판에서 업무를 이 스프린트에 배정하면 여기에 나타납니다."
              />
            ) : (
              <>
                <Section title="진행중" tone="today" items={sprint.inProgress} view="list" busyId={busyId} onToggleDone={onToggleDone} onOpen={onOpen} />
                <Section title="할일" tone="upcoming" items={sprint.todo} view="list" busyId={busyId} onToggleDone={onToggleDone} onOpen={onOpen} />
                <Section title="완료" tone="done" items={sprint.done} view="list" busyId={busyId} onToggleDone={onToggleDone} onOpen={onOpen} defaultOpen={false} />

                {/* 스프린트에 추가 후보 */}
                {sprint.candidates.length > 0 && (
                  <MacCard
                    title="스프린트에 추가"
                    icon={Plus}
                    titleExtra={<span className="text-xs text-muted-foreground tabular-nums">{sprint.candidates.length}</span>}
                    description="미배정 · 미완료 내 할일"
                    bodyPadding="px-2 py-1"
                  >
                    <div className="divide-y divide-border/40">
                      {sprint.candidates.map((t) => {
                        const cl = clusterLabel(t);
                        return (
                          <div key={t.id} className="group flex items-center gap-2 px-2 py-1 text-sm">
                            <PriorityDot priority={t.priority} />
                            <button type="button" onClick={() => onOpen(t)} className="flex-1 min-w-0 truncate text-left hover:text-primary transition-colors">{displayTitle(t)}</button>
                            {cl && <span className="hidden md:inline text-xs text-muted-foreground flex-shrink-0 max-w-[120px] truncate">{cl}</span>}
                            <span className="text-xs text-muted-foreground font-mono flex-shrink-0 w-16 text-right">{fmtDue(t)}</span>
                            <button
                              type="button"
                              onClick={() => onAddToSprint(t, currentSprint.id)}
                              disabled={busyId === t.id || !canOperate}
                              title={withHint('스프린트에 추가')}
                              aria-label={ariaWithHint(`${displayTitle(t)} 스프린트에 추가`)}
                              className="flex-shrink-0 flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {busyId === t.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}추가
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </MacCard>
                )}
              </>
            )}
          </div>
        )
      ) : view === 'schedule' ? (
        // D-122: 날짜 내비 수제 헤더 바 → MacCard 슬롯(제목·건수·내비 actions)
        <MacCard
          title="일정"
          icon={CalendarDays}
          titleExtra={<span className="text-xs text-muted-foreground tabular-nums">{daySchedule.length}건</span>}
          bodyPadding="p-0"
          actions={
            <div className="flex items-center gap-2">
              <button onClick={() => setScheduleDate((d) => addDaysStr(d, -1))} className="p-1 rounded hover:bg-secondary text-muted-foreground" aria-label="이전 날" title="이전 날"><ChevronLeft className="w-4 h-4" /></button>
              <span className="text-sm font-semibold min-w-[150px] text-center">
                {fmtDateLabel(scheduleDate)}
                {scheduleDate === today && <span className="ml-1.5 text-sm text-primary font-medium">오늘</span>}
              </span>
              <button onClick={() => setScheduleDate((d) => addDaysStr(d, 1))} className="p-1 rounded hover:bg-secondary text-muted-foreground" aria-label="다음 날" title="다음 날"><ChevronRight className="w-4 h-4" /></button>
              {scheduleDate !== today && (
                <button onClick={() => setScheduleDate(today)} className="text-sm px-2 py-0.5 rounded-full border border-primary/30 text-primary hover:bg-primary/10 transition-colors">오늘로</button>
              )}
            </div>
          }
        >
          {daySchedule.length === 0 ? (
            <EmptyState compact icon={CalendarDays} title="이 날짜에 예정된 일정이 없습니다." description="이전·다음 날로 이동하거나 업무에 일정을 지정해 보세요." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 border-b border-border text-xs font-medium text-muted-foreground">
                    <th className="text-left px-3 py-2 w-16">시간</th>
                    <th className="text-left px-3 py-2">업무</th>
                    <th className="text-left px-3 py-2 w-20">상태</th>
                    <th className="text-center px-2 py-2 w-12">우선</th>
                    <th className="text-left px-3 py-2 w-32">클러스터</th>
                    <th className="w-10"><span className="sr-only">작업</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {daySchedule.map((t) => {
                    const done = t.kanbanStatus === 'done';
                    const cl = clusterLabel(t);
                    return (
                      <tr key={t.id} onClick={() => onOpen(t)} className="cursor-pointer hover:bg-secondary/40 transition-colors">
                        <td className="px-3 py-2 font-mono text-sm text-muted-foreground whitespace-nowrap">{timeLabel(t)}</td>
                        <td className="px-3 py-2">
                          {/* D-165: 행 클릭은 마우스 편의 — 키보드는 제목 버튼으로 연다. */}
                          <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(t); }}
                            title={`${displayTitle(t)} 상세 열기`}
                            className={`text-left font-medium hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded ${done ? 'line-through text-muted-foreground' : ''}`}>
                            {displayTitle(t)}
                          </button>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`text-xs px-1.5 py-0.5 rounded border ${STATUS_META[t.kanbanStatus]?.cls ?? STATUS_META.todo.cls}`}>
                            {STATUS_META[t.kanbanStatus]?.label ?? '할일'}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-center"><PriorityDot priority={t.priority} className="w-2 h-2" /></td>
                        <td className="px-3 py-2 text-sm text-muted-foreground truncate max-w-[140px]">{cl ?? '—'}</td>
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
        </MacCard>
      ) : totalOpen === 0 && buckets.doneRecent.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="처리할 할일이 없습니다."
          description="담당으로 지정된 미완료 업무가 없습니다. 새 업무를 추가해 보세요."
          action={canOperate ? { label: '업무 추가', onClick: () => navigate('/tasks-mgmt/new') } : undefined}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <Section title="지연" tone="overdue" items={buckets.overdue} view={view} busyId={busyId} onToggleDone={onToggleDone} onOpen={onOpen} />
          <Section title="오늘" tone="today" items={buckets.todayList} view={view} busyId={busyId} onToggleDone={onToggleDone} onOpen={onOpen} />
          <Section title="예정" tone="upcoming" items={buckets.upcoming} view={view} busyId={busyId} onToggleDone={onToggleDone} onOpen={onOpen} />
          <Section title="최근 완료" tone="done" items={buckets.doneRecent} view={view} busyId={busyId} onToggleDone={onToggleDone} onOpen={onOpen} defaultOpen={false} />
        </div>
      )}
    </PageShell>
  );
}
