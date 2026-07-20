import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Sun, ClipboardList, AlertCircle, CalendarClock, Server, CalendarDays,
} from 'lucide-react';
import { MemberTodayTodos } from '@/components/dashboard/MemberTodayTodos';
import { WorkCalendar } from '@/components/dashboard/WorkCalendar';
import { WeeklyStatusTimeline } from '@/components/dashboard/WeeklyStatusTimeline';
import { DayScheduleBoard } from '@/components/dashboard/DayScheduleBoard';
import { PlatformStatusMatrix } from '@/components/platform-status';
import { WorkAlarmBell } from '@/components/layout/WorkAlarmBell';
import { useAuthStore } from '@/stores/authStore';
import { useClusterStore } from '@/stores/clusterStore';
import { useClusters } from '@/hooks/useCluster';
import { useWorkItems } from '@/hooks/useWorkItems';
import { useHomeStore } from '@/stores/homeStore';
import type { WorkItem } from '@/types';
import { cn, parseUTC } from '@/lib/utils';

// ── helpers ──────────────────────────────────────────────────────────────────
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtKoreanDate(d: Date): string {
  const week = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} (${week[d.getDay()]})`;
}

function nextDueTask(items: WorkItem[]): WorkItem | null {
  const now = Date.now();
  const candidates = items
    .filter((t) => t.startedAt && t.kanbanStatus !== 'done')
    .map((t) => ({ t, ms: parseUTC(t.startedAt as string).getTime() }))
    .filter(({ ms }) => Number.isFinite(ms) && ms >= now - 1000 * 60 * 60 * 24)
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
}

function KpiPill({ label, value, hint, Icon, accent, to }: KpiPillProps) {
  const body = (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-card border border-border hover:border-primary/40 transition-colors text-xs whitespace-nowrap">
      <Icon className={`w-3 h-3 flex-shrink-0 ${accent}`} />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
      {hint && <span className="text-muted-foreground">{hint}</span>}
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

// ── Main ─────────────────────────────────────────────────────────────────────
export function HomePage() {
  const mode = useHomeStore((s) => s.mode);
  const scheduleBg = useHomeStore((s) => s.scheduleBg);

  const user = useAuthStore((s) => s.user);
  const myName = user?.displayName?.trim() || user?.username || null;

  const { clusters } = useClusterStore();
  const { isLoading: clustersLoading } = useClusters();

  const { data: workItemsData } = useWorkItems();
  const allWorkItems = useMemo<WorkItem[]>(() => workItemsData?.data ?? [], [workItemsData]);
  const allTasks  = useMemo<WorkItem[]>(() => allWorkItems.filter((w) => w.type === 'task'), [allWorkItems]);
  const allIssues = useMemo<WorkItem[]>(() => allWorkItems.filter((w) => w.type === 'issue'), [allWorkItems]);

  const today = dateKey(new Date());
  const myTodayTasks = useMemo(() => {
    if (!myName) return [];
    return allTasks.filter((t) => {
      if (t.kanbanStatus === 'done') return false;
      const match = t.assignee === myName || t.primaryAssignee === myName || t.secondaryAssignee === myName;
      if (!match) return false;
      const due = t.startedAt?.slice(0, 10);
      return !due || due <= today;
    });
  }, [allTasks, myName, today]);

  const openIssueCount = useMemo(() => allIssues.filter((i) => !i.closedAt).length, [allIssues]);
  const criticalClusters = useMemo(() => clusters.filter((c) => c.status === 'critical').length, [clusters]);
  const upcomingTask = useMemo(() => nextDueTask(allTasks), [allTasks]);
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

  const now = new Date();
  const dateStr = fmtKoreanDate(now);

  return (
    <div className="h-screen overflow-hidden bg-background flex flex-col">

      {/* ── Compact top strip — always visible ─────────────────────────────── */}
      <div className="flex-none flex items-center gap-3 pl-3 lg:pl-4 pr-3 lg:pr-4 py-2 border-b border-border bg-background/95 backdrop-blur flex-wrap">
        {/* 사용자 / 날짜 */}
        <div className="flex items-center gap-2 min-w-0">
          <Sun className="w-4 h-4 text-primary flex-shrink-0" />
          {myName && (
            <span className="text-sm font-bold leading-none whitespace-nowrap">{myName}님</span>
          )}
          <span className="text-xs text-muted-foreground tabular-nums hidden sm:inline">{dateStr}</span>
        </div>

        {/* KPI pills */}
        <div className="ml-auto flex items-center gap-1.5 flex-wrap">
          <KpiPill
            label="내 할일"
            value={myName ? myTodayTasks.length : '—'}
            hint={myName ? '건' : undefined}
            Icon={ClipboardList}
            accent="text-primary"
            to="/todo-today"
          />
          <KpiPill
            label="미해결 이슈"
            value={openIssueCount}
            hint="건"
            Icon={AlertCircle}
            accent="text-red-500"
            to="/items"
          />
          <KpiPill
            label="위험 클러스터"
            value={clustersLoading ? '…' : criticalClusters}
            hint={clustersLoading ? '' : `/ ${clusters.length}`}
            Icon={Server}
            accent="text-amber-500"
            to="/cluster-overview"
          />
          <KpiPill
            label="다음 일정"
            value={upcomingLabel}
            Icon={CalendarClock}
            accent="text-sky-500"
            to="/items"
          />
          {/* 업무 알람 종 — KPI pill 과 같은 높이/디자인으로 우측 끝에 배치 */}
          <div className="flex items-center rounded-lg border border-border bg-card overflow-hidden">
            <WorkAlarmBell />
          </div>
        </div>
      </div>

      {/* ── Mode B: platform status matrix — fills remaining space ───────────── */}
      {mode === 'platform' && (
        <div className="flex-1 min-h-0 px-3 pt-2 pb-3 flex flex-col overflow-auto">
          <PlatformStatusMatrix />
        </div>
      )}

      {/* ── Mode A: work panels — scrollable ────────────────────────────────── */}
      {mode === 'work' && (
        <div className={cn(
          'flex-1 min-h-0 flex flex-col px-3 py-3 gap-3 overflow-auto',
          scheduleBg === 'cream' ? 'schedule-bg-cream' : 'schedule-bg-white',
        )}>
          <div className="flex-1 min-h-0 grid grid-cols-10 gap-3">

            {/* ── 당일 시간단위 스케줄 (담당자 기준) (4/10) ─────────────────── */}
            <div className="col-span-10 xl:col-span-4 flex flex-col min-h-0 rounded-md border border-border bg-card overflow-hidden">
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
            <div className="col-span-10 xl:col-span-6 flex flex-col min-h-0 rounded-md border border-border bg-card overflow-hidden">
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
