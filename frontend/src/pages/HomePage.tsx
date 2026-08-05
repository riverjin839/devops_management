import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ClipboardList, AlertCircle, CalendarClock, Server, CalendarDays, AlertTriangle, Palmtree,
  ListTodo, ServerCog, ShieldAlert,
} from 'lucide-react';
import { MemberTodayTodos } from '@/components/dashboard/MemberTodayTodos';
import { WorkCalendar } from '@/components/dashboard/WorkCalendar';
import { WeeklyStatusTimeline } from '@/components/dashboard/WeeklyStatusTimeline';
import { DayScheduleBoard } from '@/components/dashboard/DayScheduleBoard';
import { PlatformStatusMatrix } from '@/components/platform-status';
import { useAuthStore } from '@/stores/authStore';
import { useClusterStore } from '@/stores/clusterStore';
import { useClusters } from '@/hooks/useCluster';
import { useHomeWorkItems } from '@/hooks/useWorkItems';
import { useCheckMatrixFailureCount } from '@/hooks/useCheckMatrix';
import { useToday } from '@/hooks/useToday';
import { useHomeStore, type HomeTab } from '@/stores/homeStore';
import { useIslands } from '@/hooks/useIslands';
import { useIslandStore } from '@/stores/islandStore';
import type { WorkItem } from '@/types';
import { cn, parseUTC } from '@/lib/utils';
import { isMyDueTodo } from '@/lib/workItems';

function nextDueTask(items: WorkItem[]): WorkItem | null {
  const now = Date.now();
  const candidates = items
    .filter((t) => t.startedAt && t.kanbanStatus !== 'done')
    .map((t) => ({ t, ms: parseUTC(t.startedAt as string).getTime() }))
    // 진짜 "다음(=아직 오지 않은)" 일정만 — 지난 건은 다음 일정이 아니다.
    .filter(({ ms }) => Number.isFinite(ms) && ms >= now)
    .sort((a, b) => a.ms - b.ms);
  return candidates[0]?.t ?? null;
}

// ── Compact KPI pill ─────────────────────────────────────────────────────────
interface KpiPillProps {
  label: string;
  value: number | string;
  hint?: string;
  Icon: typeof ClipboardList;
  accent: string;
  to?: string;
  /** 라우트 이동 대신 같은 화면 안에서 상태만 바꿀 때(예: 홈 탭 전환). `to` 보다 우선한다. */
  onSelect?: () => void;
  isLoading?: boolean;
  isError?: boolean;
}

function KpiPill({ label, value, hint, Icon, accent, to, onSelect, isLoading, isError }: KpiPillProps) {
  const body = (
    <div className={cn(
      'flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-card border transition-colors text-xs whitespace-nowrap',
      isError ? 'border-status-critical/40' : 'border-border hover:border-primary/40',
    )}>
      {isError
        ? <AlertTriangle className="w-3 h-3 flex-shrink-0 text-status-critical" />
        : <Icon className={cn('w-3 h-3 flex-shrink-0', accent)} />}
      <span className="text-muted-foreground">{label}</span>
      {isError ? (
        <span className="font-semibold text-status-critical" title="불러오기 실패">!</span>
      ) : (
        <>
          <span className="font-semibold tabular-nums">{isLoading ? '…' : value}</span>
          {hint && !isLoading && <span className="text-muted-foreground">{hint}</span>}
        </>
      )}
    </div>
  );
  if (onSelect) {
    return <button type="button" onClick={onSelect}>{body}</button>;
  }
  return to ? <Link to={to}>{body}</Link> : body;
}

// ── Your Island 진입 필 ──────────────────────────────────────────────────────
// 사이드바 진입점은 푸터 개인 존으로 내려갔다(공용 그룹 레일과 성격이 달라서). 하단은
// 발견성이 낮으므로, 로그인 후 첫 화면인 여기 상단 KPI 줄 맨 앞에 진입점을 둔다.
// KPI 필과 달리 지표가 아니라 "목적지"라 accent 보더로 구분한다.
function IslandPill() {
  const { data } = useIslands();
  const lastIslandId = useIslandStore((s) => s.lastIslandId);

  const mine = data?.data ?? [];
  const target = mine.find((i) => i.id === lastIslandId) ?? mine[0] ?? null;
  const to = target ? `/island/${target.id}` : '/island';

  return (
    <Link to={to} className="flex-shrink-0">
      <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-primary/5 border border-primary/30 hover:border-primary/60 transition-colors text-xs whitespace-nowrap">
        <Palmtree className="w-3 h-3 flex-shrink-0 text-primary" />
        <span className="font-semibold text-primary">
          {target ? target.name : 'Your Island'}
        </span>
        {!target && <span className="text-muted-foreground">만들기</span>}
      </div>
    </Link>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
export function HomePage() {
  const homeTab = useHomeStore((s) => s.homeTab);
  const setHomeTab = useHomeStore((s) => s.setHomeTab);
  const scheduleBg = useHomeStore((s) => s.scheduleBg);

  const user = useAuthStore((s) => s.user);
  const myName = user?.displayName?.trim() || user?.username || null;

  const { clusters } = useClusterStore();
  const { isLoading: clustersLoading, isError: clustersError } = useClusters();
  const {
    data: checkFailureCount, isLoading: checkFailureLoading, isError: checkFailureError,
  } = useCheckMatrixFailureCount();

  const { data: workItemsData, isLoading: workItemsLoading, isError: workItemsError } = useHomeWorkItems();
  const allWorkItems = useMemo<WorkItem[]>(() => workItemsData?.data ?? [], [workItemsData]);
  const allIssues = useMemo<WorkItem[]>(() => allWorkItems.filter((w) => w.type === 'issue'), [allWorkItems]);
  // "다음 일정" 후보 — 이슈를 제외한 일정성 업무(작업/회의/교육/기타). 당일 스케줄 보드와 대상 일치.
  const allSchedulable = useMemo<WorkItem[]>(() => allWorkItems.filter((w) => w.type !== 'issue'), [allWorkItems]);

  const today = useToday();  // 자정 넘기면 자동 갱신 (상시 대시보드)
  // "내 할일" — /todo-today 의 지연+오늘(open) 집계와 동일 정의(공용 isMyDueTodo)를 공유해
  // KPI 와 상세 페이지가 같은 숫자를 보이도록 한다.
  const myTodayTasks = useMemo(
    () => (myName ? allWorkItems.filter((t) => isMyDueTodo(t, myName, today)) : []),
    [allWorkItems, myName, today],
  );

  const openIssueCount = useMemo(() => allIssues.filter((i) => !i.closedAt).length, [allIssues]);
  const criticalClusters = useMemo(() => clusters.filter((c) => c.status === 'critical').length, [clusters]);
  const upcomingTask = useMemo(() => nextDueTask(allSchedulable), [allSchedulable]);
  const upcomingLabel = upcomingTask?.startedAt
    ? parseUTC(upcomingTask.startedAt).toLocaleString('ko-KR', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : '없음';

  // 기본 탭 = '주간' — WeeklyStatusTimeline(담당자 기준 스윔레인 뷰)도 이제 담당자별
  // 표시 개수 제한(기본 5개) + "더보기/접기", 항상 최상단 "전체" 요약 행, 화면당 표시
  // 인원 수 제한(기본 20명, 옵션)을 모두 지원해 MemberTodayTodos(담당자 탭)와 동등한
  // 밀도로 보이므로 기본 탭으로 되돌린다.
  const [weeklyTab, setWeeklyTab] = useState<'week' | 'month' | 'member'>('week');

  // 플랫폼 탭 배지 — 위험 클러스터 + 점검 실패 합계. 0이면 배지를 숨겨 평상시엔 조용하다.
  const platformSignalCount = criticalClusters + (checkFailureCount ?? 0);
  const TABS: Array<{ key: HomeTab; label: string; Icon: typeof ListTodo; badge?: number }> = [
    { key: 'work', label: '내 업무', Icon: ListTodo },
    { key: 'platform', label: '플랫폼 현황', Icon: ServerCog, badge: platformSignalCount || undefined },
  ];
  const handleTabKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = (idx + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    setHomeTab(TABS[next].key);
  };

  return (
    <div className="app-h-screen overflow-hidden bg-background flex flex-col">

      {/* ── KPI 스트립 — 업무/플랫폼 신호를 탭과 무관하게 항상 함께 보여준다 ──────── */}
      <div className="flex-none flex items-center gap-1.5 pl-3 lg:pl-4 pr-3 lg:pr-4 py-2 border-b border-border bg-background/95 backdrop-blur flex-wrap">
        {/* Your Island — KPI 그룹 맨 앞. 지표가 아니라 목적지라 accent 로 구분. */}
        <IslandPill />
        <KpiPill
          label="내 할일"
          value={myName ? myTodayTasks.length : '—'}
          hint={myName ? '건' : undefined}
          Icon={ClipboardList}
          accent="text-primary"
          to="/todo-today"
          isLoading={workItemsLoading}
          isError={workItemsError}
        />
        <KpiPill
          label="미해결 이슈"
          value={openIssueCount}
          hint="건"
          Icon={AlertCircle}
          accent="text-status-critical"
          to="/tasks-mgmt"
          isLoading={workItemsLoading}
          isError={workItemsError}
        />
        <KpiPill
          label="위험 클러스터"
          value={criticalClusters}
          hint={`/ ${clusters.length}`}
          Icon={Server}
          accent="text-status-warning"
          to="/cluster-overview"
          isLoading={clustersLoading}
          isError={clustersError}
        />
        <KpiPill
          label="점검 실패"
          value={checkFailureCount ?? 0}
          hint="건"
          Icon={ShieldAlert}
          accent="text-status-critical"
          onSelect={() => setHomeTab('platform')}
          isLoading={checkFailureLoading}
          isError={checkFailureError}
        />
        <KpiPill
          label="다음 일정"
          value={upcomingLabel}
          Icon={CalendarClock}
          accent="text-status-info"
          to="/tasks-mgmt"
          isLoading={workItemsLoading}
          isError={workItemsError}
        />
      </div>

      {/* ── 세그먼트 탭 — 홈 본문에서 뭘 볼지 고르는 로컬 선택. 예전엔 사이드바 전체를
          게이팅하는 "모드"였지만(D-054), 지금은 이 홈 화면 안에서만 의미가 있다. ───────── */}
      <div className="flex-none px-3 lg:px-4 pt-2" role="tablist" aria-label="홈 화면 보기">
        <div className="inline-flex items-center rounded-xl border border-border overflow-hidden text-sm">
          {TABS.map((t, idx) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={homeTab === t.key}
              tabIndex={homeTab === t.key ? 0 : -1}
              onClick={() => setHomeTab(t.key)}
              onKeyDown={(e) => handleTabKeyDown(e, idx)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 transition-colors',
                idx > 0 && 'border-l border-border',
                homeTab === t.key
                  ? 'bg-primary text-primary-foreground font-semibold'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
            >
              <t.Icon className="w-3.5 h-3.5" />
              {t.label}
              {!!t.badge && (
                <span
                  className={cn(
                    'inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 rounded-full text-[10px] font-bold tabular-nums',
                    homeTab === t.key
                      ? 'bg-primary-foreground/20 text-primary-foreground'
                      : 'bg-status-critical/15 text-status-critical',
                  )}
                  title={`위험 클러스터·점검 실패 합계 ${t.badge}건`}
                >
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── 플랫폼 탭: 점검 매트릭스 — 남는 공간을 모두 채우고 카드 안쪽에서만 스크롤
          (matrix manages its own internal scroll region so it uses all available
          height instead of capping out and leaving/needing a second scrollbar) ── */}
      {homeTab === 'platform' && (
        <div className="flex-1 min-h-0 px-3 pt-2 pb-3 flex flex-col overflow-hidden">
          <PlatformStatusMatrix />
        </div>
      )}

      {/* ── 업무 탭: 스케줄/진행 현황 패널 ───────────────────────────────────── */}
      {homeTab === 'work' && (
        <div className={cn(
          'flex-1 min-h-0 flex flex-col px-3 py-3 gap-3 overflow-auto',
          scheduleBg === 'cream' ? 'schedule-bg-cream' : 'schedule-bg-white',
        )}>
          {/* xl 미만에서는 그리드를 뷰포트 높이에 가두지 않고(패널이 짓눌려 이중 스크롤 나던 문제)
              바깥 컨테이너 하나만 스크롤시키고, 패널은 최소 높이로 자연 배치한다. xl 이상만 높이 채움. */}
          <div className="grid grid-cols-10 gap-3 xl:flex-1 xl:min-h-0">

            {/* ── 당일 시간단위 스케줄 (담당자 기준) (4/10) ─────────────────── */}
            <div className="col-span-10 xl:col-span-4 flex flex-col min-h-[420px] xl:min-h-0 rounded-md border border-border bg-card overflow-hidden">
              <div className="flex-none flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/40">
                <CalendarClock className="w-3.5 h-3.5 text-primary" />
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground select-none">
                  당일 스케줄
                </span>
              </div>
              <div className="flex-1 min-h-0 p-3">
                <DayScheduleBoard selectedClusterId={null} />
              </div>
            </div>

            {/* ── 담당자별 진행 현황 (주간 / 월간 / 담당자) (6/10) ──────────── */}
            <div className="col-span-10 xl:col-span-6 flex flex-col min-h-[420px] xl:min-h-0 rounded-md border border-border bg-card overflow-hidden">
              <div className="flex-none flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/40">
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground select-none">
                  담당자별 진행 현황
                </span>
                <CalendarDays className="w-3.5 h-3.5 text-primary" />
                <div className="ml-auto flex items-center rounded-md border border-border overflow-hidden text-xs">
                  <button
                    onClick={() => setWeeklyTab('week')}
                    className={cn(
                      'px-2 py-1 transition-colors',
                      weeklyTab === 'week' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground',
                    )}
                  >
                    주간
                  </button>
                  <button
                    onClick={() => setWeeklyTab('month')}
                    className={cn(
                      'px-2 py-1 border-l border-border transition-colors',
                      weeklyTab === 'month' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground',
                    )}
                  >
                    월간
                  </button>
                  <button
                    onClick={() => setWeeklyTab('member')}
                    className={cn(
                      'px-2 py-1 border-l border-border transition-colors',
                      weeklyTab === 'member' ? 'bg-primary text-primary-foreground' : 'hover:bg-secondary text-muted-foreground',
                    )}
                  >
                    담당자
                  </button>
                </div>
              </div>
              <div className="flex-1 min-h-0 overflow-hidden">
                {weeklyTab === 'week' && (
                  <div className="h-full overflow-y-auto p-3"><WeeklyStatusTimeline selectedClusterId={null} /></div>
                )}
                {weeklyTab === 'month' && (
                  <div className="h-full overflow-y-auto p-4"><WorkCalendar selectedClusterId={null} /></div>
                )}
                {weeklyTab === 'member' && (
                  <div className="h-full overflow-y-auto p-4"><MemberTodayTodos selectedClusterId={null} /></div>
                )}
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}
