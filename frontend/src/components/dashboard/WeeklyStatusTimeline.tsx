import { useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronLeft, ChevronRight, CalendarDays, Star, Flag,
  AlertCircle, ListTree, Users, ArrowDownAZ, ListOrdered,
  ClipboardList, CalendarCheck, AlertTriangle, RotateCcw,
} from 'lucide-react';
import type { WorkItem, KanbanStatus } from '@/types';
import { useHomeWorkItems } from '@/hooks/useWorkItems';
import { useToday } from '@/hooks/useToday';
import { useAuthStore } from '@/stores/authStore';
import { useHomeStore } from '@/stores/homeStore';
import { stripHtml, cn, toLocalDateKey } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { STATUS_COLOR } from '@/lib/statusColors';
import { StatusGlyph } from './StatusGlyph';

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
type RowSort = 'name' | 'count';

/** 상태 막대 배경 inline style — 공용 토큰(STATUS_COLOR, lib/statusColors.ts) + 투명도(0~100) 반영. */
function barBackgroundStyle(sv: { cssVar: string }, opacityPct: number): CSSProperties {
  const pct = Math.max(0, Math.min(100, opacityPct));
  return { background: `hsl(var(${sv.cssVar}) / ${pct}%)` };
}

/**
 * 막대 텍스트 가독성 그림자 — 사용자가 고른 텍스트 색(barTextColor)의 밝기에 따라 반대 색
 * 그림자를 넣어, 막대 투명도를 낮추거나(라이트 테마) 상태색이 밝아도 글씨가 묻히지 않게 한다.
 * 색 자체는 사용자 선택을 존중하고 대비만 보강한다.
 */
function readableTextShadow(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return '0 1px 2px rgba(0,0,0,0.55)';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.5
    ? '0 1px 2px rgba(0,0,0,0.55)'        // 밝은 글씨 → 어두운 그림자
    : '0 1px 2px rgba(255,255,255,0.6)';  // 어두운 글씨 → 밝은 그림자
}

// ── derived row models ──────────────────────────────────────────────────────────
interface TaskBar {
  item: WorkItem;
  startIdx: number;     // 0..DAY_COUNT-1 within the visible week
  endIdx: number;       // 0..DAY_COUNT-1 within the visible week
  clippedLeft: boolean; // bar starts before this week
  clippedRight: boolean;// bar ends after this week (or after Fri)
  growing: boolean;     // 완료일(closedAt) 미입력 → 오늘까지 계속 진행 중(우측이 "성장 중")
}
interface Milestone {
  issue: WorkItem;
  dayIdx: number;       // 0..DAY_COUNT-1
}
interface AssigneeRow {
  name: string;
  bars: TaskBar[];   // 이 담당자(또는 "전체")의 업무 막대 — packLanes 는 표시 시점(펼침 여부)에 따라 렌더에서 계산
}

/** 파트 전체 대상 공통업무(all_attendees) 요약 행 이름 — 항상 목록 최상단(본인 행보다 위)에 온다. */
const TEAM_ROW_NAME = '공통';

// 담당자별 기본 표시 업무 수 — 넘으면 "+N건 더보기"/"접기" 토글(주간 스윔레인 뷰).
const ASSIGNEE_ITEM_LIMIT = 5;

// 한 화면에 보일 담당자(행) 수 — 기본 20, 사용자별로 localStorage 에 저장.
const ROWS_LIMIT_KEY = 'pep:weekTimeline:rowsLimit';
const ROWS_LIMIT_OPTIONS = [10, 20, 30, 50];
const DEFAULT_ROWS_LIMIT = 20;

function loadRowsLimit(): number {
  try {
    const n = Number(localStorage.getItem(ROWS_LIMIT_KEY));
    return ROWS_LIMIT_OPTIONS.includes(n) ? n : DEFAULT_ROWS_LIMIT;
  } catch {
    return DEFAULT_ROWS_LIMIT;
  }
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
  const { data, isLoading: queryLoading, isError: queryError, refetch } = useHomeWorkItems();
  const workItems = items ?? data?.data ?? [];
  const loading = isLoading ?? queryLoading;
  // 외부에서 items 를 주입받은 경우 내부 쿼리 상태는 무의미하므로 에러로 보지 않는다.
  const errored = items ? false : queryError;

  // 막대/마일스톤 클릭 → 상세 업무 페이지로 이동.
  const openWorkItem = (id: string) => navigate(`/tasks-mgmt/${id}`);

  // 자정 넘기면 자동 갱신 — 상시 대시보드에서 '오늘' 컬럼 강조가 어긋나지 않게 한다.
  const todayKey = useToday();
  const today = useMemo(() => new Date(todayKey + 'T00:00:00'), [todayKey]);
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeek(new Date()));
  const [viewMode, setViewMode] = useState<ViewMode>('assignee');

  const currentUser = useAuthStore((s) => s.user);
  // 담당자 스윔레인 정렬 기준 — 이름순(기본) 또는 업무량순(누가 바쁜지 한눈에 보기 위함).
  // 본인 행은 정렬 기준과 무관하게 항상 최상단(담당자 탭과 동일 규칙).
  const [rowSort, setRowSort] = useState<RowSort>('name');
  const barOpacity = useHomeStore((s) => s.weeklyBarOpacity);
  const barTextColor = useHomeStore((s) => s.weeklyBarTextColor);
  const barTextShadow = readableTextShadow(barTextColor);

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
    const todayD = fmtDate(today);
    for (const item of taskItems) {
      const s = toLocalDateKey(item.startedAt);
      if (!s) continue;
      const closed = toLocalDateKey(item.closedAt) || undefined;
      // 완료일 미입력 + 시작이 오늘 이전/오늘 → 진행 중(성장 중)으로 본다.
      const growing = !closed && s <= todayD;
      // 완료일(closedAt)이 있으면 그날까지. 진행 중이면 "오늘"에서 끊지 않고 보이는 주의
      // 끝(금)까지 꽉 채워, 다음 주로 넘어가도 계속 이어지게 한다. 완료일도 없고 시작이
      // 미래면(아직 시작 전) 시작일 하루만 표시.
      const eRaw = closed ?? (growing ? weekEndStr : s);
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
        growing,
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
    // 로그인 본인을 최상단으로 — '담당자' 보기(MemberTodayTodos)와 동일하게 맞춘다.
    // 본인 행 아래는 rowSort 에 따라 이름순 또는 업무량(건수)순.
    const myName = (currentUser?.displayName?.trim() || currentUser?.username || '').trim();
    const individual = Array.from(map.entries())
      .sort((a, b) => {
        const selfDiff = (b[0] === myName ? 1 : 0) - (a[0] === myName ? 1 : 0);
        if (selfDiff !== 0) return selfDiff;
        if (rowSort === 'count') return b[1].length - a[1].length || a[0].localeCompare(b[0], 'ko');
        return a[0].localeCompare(b[0], 'ko');
      })
      .map(([name, bars]) => ({ name, bars }));
    // "공통" 요약 행 — 특정 담당자가 아닌 파트 전체 대상 업무(allAttendees, 예: 파트 회의)만
    // 모아 항상 맨 위(본인 행보다도 위)에 노출한다. 전체 업무 병합이 아니다.
    const teamBars = taskBars.filter((b) => b.item.allAttendees);
    return teamBars.length > 0 ? [{ name: TEAM_ROW_NAME, bars: teamBars }, ...individual] : individual;
  }, [taskBars, currentUser, rowSort]);

  // ── 담당자별 "+N건 더보기"/"접기" (기본 ASSIGNEE_ITEM_LIMIT 개만 표시) ──
  const [expandedAssignees, setExpandedAssignees] = useState<Set<string>>(new Set());
  const toggleAssigneeExpand = (name: string) =>
    setExpandedAssignees((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });

  // ── 한 화면에 보일 담당자(행) 수 — 사용자별 설정(localStorage) ──
  const [rowsLimit, setRowsLimit] = useState(loadRowsLimit);
  const changeRowsLimit = (n: number) => {
    setRowsLimit(n);
    try { localStorage.setItem(ROWS_LIMIT_KEY, String(n)); } catch { /* ignore */ }
  };
  const visibleAssigneeRows = useMemo(() => assigneeRows.slice(0, rowsLimit), [assigneeRows, rowsLimit]);
  const hiddenAssigneeCount = Math.max(0, assigneeRows.length - visibleAssigneeRows.length);

  // ── milestones (issues that occurred this week) ──
  const milestones: Milestone[] = useMemo(() => {
    const out: Milestone[] = [];
    for (const issue of issueItems) {
      const d = toLocalDateKey(issue.startedAt);
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
      const key = toLocalDateKey(s);   // UTC 저장 → KST 날짜로 변환한 뒤 주 시작 계산
      if (!key) return;
      const d = startOfWeek(new Date(key + 'T00:00:00'));
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
  const canPrev = currentIndex > 0;
  const canNext = currentIndex < totalWeeks - 1;

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
          <span className="font-semibold text-foreground">{monthLabel}</span>
          <span className="text-muted-foreground text-sm font-mono">{weekStartStr} ~ {weekEndStr}</span>
          {!isThisWeek && (
            <button onClick={goToday}
              className="ml-1 px-2 py-0.5 text-xs font-medium rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors">
              이번 주
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* 보기 전환: 업무 기준 ↔ 담당자 기준 */}
          <div className="flex items-center rounded-lg border border-border overflow-hidden text-xs">
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
          {/* 담당자 기준 뷰에서만 의미 있는 컨트롤 — 정렬 기준(이름순/업무량순) + 표시 인원 제한
              (기본 20, 사용자별 저장). "누가 바쁜지" 확인이 목적일 때는 업무량순이 이름순보다
              유용하므로 토글로 제공한다. */}
          {viewMode === 'assignee' && (
            <>
              <div className="flex items-center rounded-lg border border-border overflow-hidden text-xs flex-shrink-0">
                <button
                  type="button"
                  onClick={() => setRowSort('name')}
                  aria-pressed={rowSort === 'name'}
                  title="담당자 이름 가나다순 정렬"
                  className={`flex items-center gap-1 px-1.5 py-1 transition-colors ${
                    rowSort === 'name' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground'}`}>
                  <ArrowDownAZ className="w-3 h-3" /> 이름순
                </button>
                <button
                  type="button"
                  onClick={() => setRowSort('count')}
                  aria-pressed={rowSort === 'count'}
                  title="업무 건수 많은 순 정렬 — 누가 바쁜지 확인할 때 사용"
                  className={`flex items-center gap-1 px-1.5 py-1 border-l border-border transition-colors ${
                    rowSort === 'count' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground'}`}>
                  <ListOrdered className="w-3 h-3" /> 업무량순
                </button>
              </div>
              <label className="flex items-center gap-1 text-xs text-muted-foreground flex-shrink-0">
                표시 인원
                <select
                  value={rowsLimit}
                  onChange={(e) => changeRowsLimit(Number(e.target.value))}
                  className="px-1 py-0.5 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {ROWS_LIMIT_OPTIONS.map((n) => (
                    <option key={n} value={n}>{n}명</option>
                  ))}
                </select>
              </label>
            </>
          )}
          {/* 단축키 — 업무 관리 / 오늘 할일 페이지로 바로 이동 */}
          <div className="flex items-center gap-1 text-xs">
            <button
              type="button"
              onClick={() => navigate('/tasks-mgmt')}
              title="업무 관리로 이동"
              className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors">
              <ClipboardList className="w-3 h-3" /> 업무 관리
            </button>
            <button
              type="button"
              onClick={() => navigate('/todo-today')}
              title="오늘 할일 전체 보기"
              className="flex items-center gap-1 px-2 py-1 rounded-lg border border-border bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors">
              <CalendarCheck className="w-3 h-3" /> 오늘 할일 전체 보기
            </button>
          </div>
          <div className="hidden sm:flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-primary" />업무 {taskBars.length}</span>
            <span className="flex items-center gap-1"><Star className="w-3 h-3 text-status-warning fill-status-warning" />마일스톤 {milestones.length}</span>
          </div>
        </div>
      </div>

      {/* ── legend ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap text-xs text-muted-foreground px-1">
        <span className="font-medium">범례</span>
        {(Object.keys(STATUS_COLOR) as KanbanStatus[]).map((k) => (
          <span key={k} className="flex items-center gap-1">
            <span className="w-3 h-2.5 rounded-sm" style={barBackgroundStyle(STATUS_COLOR[k], barOpacity)} />
            {STATUS_COLOR[k].label}
          </span>
        ))}
        <span className="flex items-center gap-1"><Star className="w-3 h-3 text-status-warning fill-status-warning" />미해결 이슈</span>
        <span className="flex items-center gap-1"><AlertCircle className="w-3 h-3 text-status-healthy" />해결 이슈</span>
        <span className="flex items-center gap-1"><ChevronRight className="w-3 h-3 text-foreground/60" />진행 중(완료일 미입력)</span>
      </div>

      {/* ── timeline grid ───────────────────────────────────────────────────── */}
      {/* 부모(HomePage)가 이미 MacCard 로 카드 테두리/배경을 제공하므로 여기선 내부 그룹핑만
          (이중 카드 중첩 방지). */}
      <div className="rounded-lg border border-border/50 overflow-hidden">
        {/* header: weekday columns (월~금) — 주 이동은 양끝 화살표(월 옆 ◀ / 금 옆 ▶)로 한다 */}
        <div className="relative grid grid-cols-[140px_1fr] sm:grid-cols-[200px_1fr] border-b border-border bg-secondary/30">
          <div className="px-3 py-2 text-xs font-semibold text-muted-foreground flex items-center justify-between gap-1">
            <span className="truncate">{viewMode === 'assignee' ? '담당자 / 마일스톤' : '업무 / 마일스톤'}</span>
            {/* ◀ 이전 주 — 월 바로 옆 */}
            <button
              type="button"
              onClick={goPrev}
              disabled={!canPrev}
              aria-label="이전 주"
              title="이전 주"
              className="p-1 rounded-md bg-secondary text-muted-foreground hover:bg-card hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0">
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
          <div className={`grid ${colsClass}`}>
            {days.map((d) => {
              const ds = fmtDate(d);
              const isTd = ds === todayStr;
              return (
                <div key={ds}
                  className={`px-1 py-2 text-center border-l border-border/60 ${isTd ? 'bg-primary/10' : ''}`}>
                  <div className={`text-xs ${isTd ? 'text-primary font-bold' : 'text-muted-foreground'}`}>
                    {KR_DAYS[d.getDay()]}
                  </div>
                  <div className={`text-xs font-semibold ${isTd ? 'text-primary' : 'text-foreground'}`}>
                    {d.getMonth() + 1}/{d.getDate()}
                  </div>
                </div>
              );
            })}
          </div>
          {/* ▶ 다음 주 — 금 바로 옆(오른쪽 끝) */}
          <button
            type="button"
            onClick={goNext}
            disabled={!canNext}
            aria-label="다음 주"
            title="다음 주"
            className="absolute right-1 top-1/2 -translate-y-1/2 z-[1] p-1 rounded-md bg-card/90 backdrop-blur-sm text-muted-foreground border border-border shadow-sm hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            <ChevronRight className="w-4 h-4" />
          </button>
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
        ) : errored ? (
          <div className="py-14 flex flex-col items-center justify-center text-status-critical">
            <AlertTriangle className="w-9 h-9 mb-2 opacity-40" />
            <p className="text-sm">업무 정보를 불러오지 못했습니다.</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>
              <RotateCcw className="w-3.5 h-3.5" /> 다시 시도
            </Button>
          </div>
        ) : taskBars.length === 0 && milestones.length === 0 ? (
          <div className="py-14 flex flex-col items-center justify-center text-muted-foreground">
            <CalendarDays className="w-9 h-9 mb-2 opacity-30" />
            <p className="text-sm">이번 주에 예정된 작업이 없습니다.</p>
            <p className="text-xs mt-0.5 opacity-70">다른 주를 보려면 화살표를 사용하세요.</p>
          </div>
        ) : (
          <div className="divide-y divide-border/60">
            {/* milestone strip */}
            {milestones.length > 0 && (
              <div className="grid grid-cols-[140px_1fr] sm:grid-cols-[200px_1fr] bg-status-warning/5">
                <div className="px-4 py-2.5 flex items-center gap-1.5 text-xs font-semibold text-status-warning">
                  <Flag className="w-3.5 h-3.5" /> 마일스톤
                </div>
                {/* 같은 날 마일스톤이 여러 건이면 절대배치로 겹치지 않도록, 요일 컬럼 셀 안에
                    세로로 쌓는다(행 높이는 내용에 맞춰 늘어남). */}
                <div className={`grid ${colsClass} min-h-[44px]`}>
                  {days.map((d, idx) => {
                    const isTd = fmtDate(d) === todayStr;
                    const dayMs = milestones.filter((m) => m.dayIdx === idx);
                    return (
                      <div key={fmtDate(d)}
                        className={`border-l border-border/40 flex flex-col justify-center gap-0.5 py-1 px-1 min-w-0 ${isTd ? 'bg-primary/[0.04]' : ''}`}>
                        {dayMs.map(({ issue }) => {
                          const resolved = !!issue.closedAt;
                          return (
                            <button key={issue.id} type="button"
                              onClick={() => openWorkItem(issue.id)}
                              className="flex items-center gap-1 px-1 text-left rounded hover:bg-status-warning/10 transition-colors cursor-pointer min-w-0"
                              title={stripHtml(issue.content)}>
                              <Star className={`w-3.5 h-3.5 flex-shrink-0 ${resolved ? 'text-status-healthy fill-status-healthy' : 'text-status-warning fill-status-warning'}`} />
                              <span className={`text-xs font-medium truncate ${resolved ? 'text-status-healthy' : 'text-status-warning'}`}>
                                {issue.title?.trim() || stripHtml(issue.content)}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── 업무 기준: 한 업무 = 한 행 ── */}
            {viewMode === 'task' && taskBars.map(({ item, startIdx, endIdx, clippedLeft, clippedRight, growing }) => {
              const status = item.kanbanStatus ?? 'todo';
              const sv = STATUS_COLOR[status] ?? STATUS_COLOR.todo;
              const span = endIdx - startIdx + 1;
              const team = item.primaryAssignee || item.assignee;
              return (
                <div key={item.id} className="grid grid-cols-[140px_1fr] sm:grid-cols-[200px_1fr] hover:bg-secondary/20 transition-colors">
                  {/* label */}
                  <div className="px-4 py-2.5 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full" style={barBackgroundStyle(sv, barOpacity)} />
                      <span className="text-sm font-medium truncate">{item.title?.trim() || stripHtml(item.content)}</span>
                    </div>
                    {item.category && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5 pl-3">{item.category}</p>
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
                        title={growing ? `${stripHtml(item.content)} · 진행 중(완료일 미입력)` : stripHtml(item.content)}
                        style={{ ...barBackgroundStyle(sv, barOpacity), color: barTextColor, textShadow: barTextShadow }}
                        className={`w-full h-6 rounded-lg ring-1 ${sv.ringClass} shadow-sm flex items-center gap-1 px-2 overflow-hidden cursor-pointer hover:brightness-110 transition
                        ${clippedLeft ? 'rounded-l-none' : ''} ${clippedRight || growing ? 'rounded-r-none' : ''}`}>
                        <StatusGlyph status={status} />
                        <span className="text-xs font-semibold truncate">{team || sv.label}</span>
                        {growing && <ChevronRight className="w-3 h-3 flex-shrink-0 ml-auto animate-pulse" aria-label="진행 중" />}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}

            {/* ── 담당자 기준: 한 담당자 = 한 swimlane(여러 sub-lane) ──
                라인 밀도를 낮춰(LANE_H 24px, 축소된 글씨) 한 화면에 더 많은 담당자가
                보이게 하고, 담당자별 기본 ASSIGNEE_ITEM_LIMIT 개만 보여준 뒤
                "+N건 더보기"/"접기" 로 펼치고 다시 접을 수 있다. "공통" 행은 파트 전체
                대상 업무(allAttendees)만 모아 항상 맨 위(본인 행보다도 위)에 강조 표시된다. */}
            {viewMode === 'assignee' && visibleAssigneeRows.map(({ name, bars }) => {
              const LANE_H = 24; // px per sub-lane (축소 — 기존 32px)
              const isTeamRow = name === TEAM_ROW_NAME;
              const isExpanded = expandedAssignees.has(name);
              const visibleBars = isExpanded ? bars : bars.slice(0, ASSIGNEE_ITEM_LIMIT);
              const lanes = packLanes(visibleBars);
              const hasMore = bars.length > ASSIGNEE_ITEM_LIMIT;
              const trackH = lanes.length * LANE_H + 10;
              return (
                <div key={name} className={cn(
                  'grid grid-cols-[140px_1fr] sm:grid-cols-[200px_1fr] transition-colors',
                  isTeamRow ? 'bg-primary/[0.03] hover:bg-primary/[0.06]' : 'hover:bg-secondary/20',
                )}>
                  {/* label */}
                  <div className="px-4 py-2 min-w-0 flex flex-col justify-center">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Users className="w-3.5 h-3.5 flex-shrink-0 text-primary" />
                      <span className={`text-[13px] truncate ${isTeamRow ? 'font-bold text-primary' : 'font-semibold'}`}>{name}</span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 pl-5">
                      <p className="text-[11px] text-muted-foreground">{bars.length}건</p>
                      {hasMore && (
                        <button
                          type="button"
                          onClick={() => toggleAssigneeExpand(name)}
                          className="text-[11px] text-muted-foreground hover:text-primary transition-colors"
                          aria-expanded={isExpanded}
                        >
                          {isExpanded ? '접기' : `+${bars.length - ASSIGNEE_ITEM_LIMIT}건 더보기`}
                        </button>
                      )}
                    </div>
                  </div>
                  {/* track */}
                  <div className={`relative grid ${colsClass}`} style={{ minHeight: trackH }}>
                    <DayCells />
                    {lanes.map((lane, laneIdx) =>
                      lane.map(({ item, startIdx, endIdx, clippedLeft, clippedRight, growing }) => {
                        const status = item.kanbanStatus ?? 'todo';
                        const sv = STATUS_COLOR[status] ?? STATUS_COLOR.todo;
                        const span = endIdx - startIdx + 1;
                        return (
                          <div key={item.id}
                            className="absolute px-1.5"
                            style={{
                              left: `${(startIdx / DAY_COUNT) * 100}%`,
                              width: `${(span / DAY_COUNT) * 100}%`,
                              top: laneIdx * LANE_H + 4,
                            }}>
                            <button type="button"
                              onClick={() => openWorkItem(item.id)}
                              title={growing ? `${stripHtml(item.content)} · 진행 중(완료일 미입력)` : stripHtml(item.content)}
                              style={{ ...barBackgroundStyle(sv, barOpacity), color: barTextColor, textShadow: barTextShadow }}
                              className={`w-full h-5 rounded-md ring-1 ${sv.ringClass} shadow-sm flex items-center gap-1 px-1.5 overflow-hidden cursor-pointer hover:brightness-110 transition
                              ${clippedLeft ? 'rounded-l-none' : ''} ${clippedRight || growing ? 'rounded-r-none' : ''}`}>
                              <StatusGlyph status={status} />
                              <span className="text-[11px] font-semibold truncate">{item.title?.trim() || stripHtml(item.content)}</span>
                              {growing && <ChevronRight className="w-3 h-3 flex-shrink-0 ml-auto animate-pulse" aria-label="진행 중" />}
                            </button>
                          </div>
                        );
                      }),
                    )}
                  </div>
                </div>
              );
            })}
            {viewMode === 'assignee' && hiddenAssigneeCount > 0 && (
              <div className="px-4 py-2 text-xs text-muted-foreground text-center">
                외 {hiddenAssigneeCount}명 더 있음 — 상단 "표시 인원"에서 늘려보세요.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
