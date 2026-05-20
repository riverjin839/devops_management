import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Sun, ClipboardList, AlertCircle, CalendarClock, Server, CalendarDays,
} from 'lucide-react';
import { ClusterSidebar } from '@/components/common';
import { MemberTodayTodos } from '@/components/dashboard/MemberTodayTodos';
import { WorkCalendar } from '@/components/dashboard/WorkCalendar';
import { useAuthStore } from '@/stores/authStore';
import { useClusterStore } from '@/stores/clusterStore';
import { useClusters } from '@/hooks/useCluster';
import { useWorkItems } from '@/hooks/useWorkItems';
import type { WorkItem } from '@/types';

// ── helpers ──────────────────────────────────────────────────────────────────
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function greeting(hour: number): string {
  if (hour < 6)  return '늦은 시간 수고 많으세요';
  if (hour < 12) return '좋은 아침입니다';
  if (hour < 18) return '오후 운영 잘 부탁드립니다';
  return '오늘도 마무리 잘 부탁드립니다';
}

function fmtKoreanDate(d: Date): string {
  const week = ['일', '월', '화', '수', '목', '금', '토'];
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} (${week[d.getDay()]})`;
}

function nextDueTask(items: WorkItem[]): WorkItem | null {
  const now = Date.now();
  const candidates = items
    .filter((t) => t.startedAt && t.kanbanStatus !== 'done')
    .map((t) => ({ t, ms: new Date(t.startedAt as string).getTime() }))
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
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-card border border-border hover:border-primary/40 transition-colors text-[11px] whitespace-nowrap">
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
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);

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
    ? new Date(upcomingTask.startedAt).toLocaleString('ko-KR', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : '없음';

  const now = new Date();
  const hello = greeting(now.getHours());
  const dateStr = fmtKoreanDate(now);

  return (
    <div className="h-screen overflow-hidden bg-background flex flex-col">

      {/* ── Compact top strip ──────────────────────────────────────────────── */}
      <div className="flex-none flex items-center gap-3 px-3 lg:px-4 py-2 border-b border-border bg-background/95 backdrop-blur flex-wrap">
        {/* 인사 */}
        <div className="flex items-center gap-2 min-w-0">
          <Sun className="w-4 h-4 text-primary flex-shrink-0" />
          <span className="text-sm font-bold leading-none whitespace-nowrap">
            {hello}{myName ? `, ${myName}님` : ''}
          </span>
          <span className="text-[11px] text-muted-foreground tabular-nums hidden sm:inline">{dateStr}</span>
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
        </div>
      </div>

      {/* ── Main area: sidebar + 2-panel grid ──────────────────────────────── */}
      <div className="flex-1 min-h-0 flex px-3 py-3 gap-3">
        {/* Cluster sidebar */}
        <ClusterSidebar
          clusters={clusters}
          selectedId={selectedClusterId}
          onSelect={setSelectedClusterId}
          allowAll
          allLabel="전체 현황"
          iconOnly
        />

        {/* 2-panel grid: 4 (member) : 6 (calendar) */}
        <div className="flex-1 min-w-0 min-h-0 grid grid-cols-10 gap-3">

          {/* ── 담당자별 진행 현황 (4/10) ────────────────────────────────── */}
          <div className="col-span-10 xl:col-span-4 flex flex-col min-h-0 rounded-md border border-border bg-card overflow-hidden">
            <div className="flex-none px-4 py-2.5 border-b border-border bg-muted/40">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground select-none">
                DevOps 담당자별 진행 현황
              </span>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-4">
              <MemberTodayTodos selectedClusterId={selectedClusterId} />
            </div>
          </div>

          {/* ── 이번 달 일정 캘린더 (6/10) ───────────────────────────────── */}
          <div className="col-span-10 xl:col-span-6 flex flex-col min-h-0 rounded-md border border-border bg-card overflow-hidden">
            <div className="flex-none flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/40">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground select-none">
                이번 달 일정
              </span>
              <CalendarDays className="w-3.5 h-3.5 text-primary" />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-4">
              <WorkCalendar selectedClusterId={selectedClusterId} />
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
