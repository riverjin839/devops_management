import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { workItemsApi } from '@/services/api';
import type { WorkItem } from '@/types';
import {
  ChevronLeft, ChevronRight, Calendar, Users, Filter,
  CheckCircle2, Clock, AlertCircle, Circle, BarChart3,
  ListChecks, Activity,
} from 'lucide-react';
import { ViewModeBar, SidePane } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { stripHtml } from '@/lib/utils';

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function parseDate(s: string): Date {
  return new Date(s + 'T00:00:00');
}
const KR_DAYS = ['일', '월', '화', '수', '목', '금', '토'];
function dayLabel(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}(${KR_DAYS[d.getDay()]})`;
}
function isWeekend(d: Date): boolean {
  return d.getDay() === 0 || d.getDay() === 6;
}

const KANBAN_LABEL: Record<string, string> = {
  backlog: 'Backlog', todo: 'Todo', in_progress: '진행중',
  review_test: '검토', done: '완료',
};
const PRIORITY_COLOR: Record<string, string> = {
  high:   'bg-red-500/15 text-red-600 dark:text-red-300 border-red-500/25',
  medium: 'bg-amber-500/15 text-amber-600 dark:text-amber-300 border-amber-500/25',
  low:    'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border-emerald-500/25',
};
const MODULE_COLOR: Record<string, string> = {
  k8s:        'bg-sky-500/15 text-sky-600 dark:text-sky-300',
  keycloak:   'bg-purple-500/15 text-purple-600 dark:text-purple-300',
  nexus:      'bg-orange-500/15 text-orange-600 dark:text-orange-300',
  cilium:     'bg-cyan-500/15 text-cyan-600 dark:text-cyan-300',
  argocd:     'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
  jenkins:    'bg-red-500/15 text-red-600 dark:text-red-300',
  backend:    'bg-indigo-500/15 text-indigo-600 dark:text-indigo-300',
  frontend:   'bg-pink-500/15 text-pink-600 dark:text-pink-300',
  monitoring: 'bg-teal-500/15 text-teal-600 dark:text-teal-300',
  infra:      'bg-slate-500/15 text-slate-600 dark:text-slate-300',
};

// ── types ─────────────────────────────────────────────────────────────────────

type ViewMode = 'week' | 'twoWeek' | 'month';

interface DayItem {
  type: 'task' | 'issue';
  id: string;
  label: string;
  sub?: string;
  status: string;
  priority?: string;
  module?: string;
  startDate: string;
  endDate?: string;
  resolved?: boolean;
  isSubTask?: boolean;
  parentId?: string;
}

interface AssigneeRow {
  assignee: string;
  roles: string[];        // modules/areas
  items: Map<string, DayItem[]>; // date → items
}

// ── small components ──────────────────────────────────────────────────────────

function StatusIcon({ status, type }: { status: string; type: 'task' | 'issue' }) {
  if (type === 'issue') {
    return status === 'resolved'
      ? <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />
      : <AlertCircle className="w-3 h-3 text-red-500 flex-shrink-0" />;
  }
  const icons: Record<string, JSX.Element> = {
    done:        <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />,
    in_progress: <Clock className="w-3 h-3 text-sky-500 flex-shrink-0" />,
    review_test: <Clock className="w-3 h-3 text-amber-500 flex-shrink-0" />,
    todo:        <Circle className="w-3 h-3 text-muted-foreground flex-shrink-0" />,
    backlog:     <Circle className="w-3 h-3 text-muted-foreground/60 flex-shrink-0" />,
  };
  return icons[status] ?? <Circle className="w-3 h-3 text-muted-foreground flex-shrink-0" />;
}

function ItemCard({ item, onClick }: { item: DayItem; onClick: () => void }) {
  const isIssue = item.type === 'issue';
  const base = isIssue
    ? (item.resolved
        ? 'border-l-emerald-500 bg-emerald-500/5'
        : 'border-l-orange-500 bg-orange-500/5')
    : item.isSubTask
      ? 'border-l-indigo-400 bg-indigo-500/5 opacity-90'
      : 'border-l-sky-500 bg-sky-500/5';

  return (
    <button
      onClick={onClick}
      className={`w-full border-l-[3px] ${base} rounded-r-md px-2 py-1 cursor-pointer hover:bg-secondary/40 hover:shadow-sm transition-all text-left ${item.isSubTask ? 'ml-2' : ''}`}
    >
      <div className="flex items-center gap-1 min-w-0">
        <StatusIcon status={isIssue ? (item.resolved ? 'resolved' : 'open') : item.status} type={item.type} />
        <span className="text-[11px] font-medium truncate leading-tight">{item.label}</span>
      </div>
      {item.sub && (
        <p className="text-[10px] text-muted-foreground truncate mt-0.5 leading-tight pl-4">{item.sub}</p>
      )}
      <div className="flex items-center gap-1 mt-0.5 pl-4 flex-wrap">
        {item.module && (
          <span className={`text-[9px] px-1 rounded-md ${MODULE_COLOR[item.module] ?? 'bg-secondary text-muted-foreground'}`}>
            {item.module}
          </span>
        )}
        {item.priority && (
          <span className={`text-[9px] px-1 rounded-md border ${PRIORITY_COLOR[item.priority] ?? ''}`}>
            {item.priority}
          </span>
        )}
        {isIssue && (
          <span className={`text-[9px] px-1 rounded-md ${item.resolved ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300' : 'bg-orange-500/15 text-orange-600 dark:text-orange-300'}`}>
            {item.resolved ? '해결' : '미해결'}
          </span>
        )}
      </div>
    </button>
  );
}

// ── detail modal ──────────────────────────────────────────────────────────────

function DetailModal({ item, onClose }: { item: DayItem; onClose: () => void }) {
  const isIssue = item.type === 'issue';
  const title = (
    <div className="flex items-center gap-2 flex-wrap min-w-0">
      <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold flex-shrink-0 ${isIssue ? 'bg-orange-500/15 text-orange-600 dark:text-orange-300' : 'bg-sky-500/15 text-sky-600 dark:text-sky-300'}`}>
        {isIssue ? '이슈' : '작업'}
      </span>
      {item.module && (
        <span className={`text-[11px] px-2 py-0.5 rounded-full flex-shrink-0 ${MODULE_COLOR[item.module] ?? 'bg-secondary text-muted-foreground'}`}>
          {item.module}
        </span>
      )}
      {item.priority && (
        <span className={`text-[11px] px-2 py-0.5 rounded-full border flex-shrink-0 ${PRIORITY_COLOR[item.priority] ?? ''}`}>
          {item.priority}
        </span>
      )}
    </div>
  );
  return (
    <SidePane open onClose={onClose} title={title} bodyClassName="px-5 py-4" width="55%">
      <h3 className="text-base font-semibold leading-snug mb-1">{stripHtml(item.label)}</h3>
      {item.sub && <p className="text-sm text-muted-foreground mb-4">{item.sub}</p>}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <div className="rounded-lg bg-secondary/40 px-3 py-2">
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">시작일</dt>
          <dd className="font-medium tabular-nums">{item.startDate || '-'}</dd>
        </div>
        {item.endDate && (
          <div className="rounded-lg bg-secondary/40 px-3 py-2">
            <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">완료일</dt>
            <dd className="font-medium tabular-nums">{item.endDate}</dd>
          </div>
        )}
        <div className="rounded-lg bg-secondary/40 px-3 py-2">
          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">상태</dt>
          <dd className="font-medium">
            {isIssue ? (item.resolved ? '해결' : '미해결') : (KANBAN_LABEL[item.status] ?? item.status)}
          </dd>
        </div>
      </dl>
    </SidePane>
  );
}

// ── summary bar ───────────────────────────────────────────────────────────────

function SummaryBar({ tasks, issues }: { tasks: WorkItem[]; issues: WorkItem[] }) {
  const taskCounts = useMemo(() => {
    const c = { total: tasks.length, done: 0, in_progress: 0, todo: 0, backlog: 0 };
    for (const t of tasks) {
      if (t.kanbanStatus === 'done') c.done++;
      else if (t.kanbanStatus === 'in_progress') c.in_progress++;
      else if (t.kanbanStatus === 'todo') c.todo++;
      else c.backlog++;
    }
    return c;
  }, [tasks]);

  const issueCounts = useMemo(() => ({
    total: issues.length,
    resolved: issues.filter(i => i.closedAt).length,
    open: issues.filter(i => !i.closedAt).length,
  }), [issues]);

  const taskProgress = taskCounts.total > 0 ? Math.round((taskCounts.done / taskCounts.total) * 100) : 0;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <SummaryStat
        icon={<ListChecks className="w-4 h-4" />}
        label="작업"
        value={taskCounts.total}
        breakdown={
          <>
            <Chip color="emerald">완료 {taskCounts.done}</Chip>
            <Chip color="sky">진행 {taskCounts.in_progress}</Chip>
            <Chip color="slate">대기 {taskCounts.todo + taskCounts.backlog}</Chip>
          </>
        }
      />
      <SummaryStat
        icon={<BarChart3 className="w-4 h-4" />}
        label="작업 진행률"
        value={`${taskProgress}%`}
        accent="text-primary"
        progress={taskProgress}
      />
      <SummaryStat
        icon={<Activity className="w-4 h-4" />}
        label="이슈"
        value={issueCounts.total}
        breakdown={
          <>
            <Chip color="emerald">해결 {issueCounts.resolved}</Chip>
            <Chip color="red">미해결 {issueCounts.open}</Chip>
          </>
        }
      />
      <SummaryStat
        icon={<CheckCircle2 className="w-4 h-4" />}
        label="이슈 해결률"
        value={`${issueCounts.total > 0 ? Math.round((issueCounts.resolved / issueCounts.total) * 100) : 0}%`}
        accent="text-emerald-500"
        progress={issueCounts.total > 0 ? Math.round((issueCounts.resolved / issueCounts.total) * 100) : 0}
      />
    </div>
  );
}

interface SummaryStatProps {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  accent?: string;
  breakdown?: React.ReactNode;
  progress?: number;
}

function SummaryStat({ icon, label, value, accent = 'text-foreground', breakdown, progress }: SummaryStatProps) {
  return (
    <div className="rounded-2xl border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-3">
        <div className={`w-9 h-9 rounded-xl bg-secondary flex items-center justify-center ${accent}`}>
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-muted-foreground">{label}</p>
          <p className={`text-lg font-bold leading-tight ${accent}`}>{value}</p>
        </div>
      </div>
      {breakdown && <div className="flex items-center gap-1.5 mt-2 flex-wrap">{breakdown}</div>}
      {progress != null && (
        <div className="h-1.5 mt-2 rounded-full bg-secondary overflow-hidden">
          <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${progress}%` }} />
        </div>
      )}
    </div>
  );
}

const CHIP_COLOR: Record<string, string> = {
  emerald: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
  sky:     'bg-sky-500/15 text-sky-600 dark:text-sky-300',
  slate:   'bg-slate-500/15 text-slate-600 dark:text-slate-300',
  red:     'bg-red-500/15 text-red-600 dark:text-red-300',
};

function Chip({ color, children }: { color: keyof typeof CHIP_COLOR | string; children: React.ReactNode }) {
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-md ${CHIP_COLOR[color] ?? CHIP_COLOR.slate}`}>
      {children}
    </span>
  );
}

// ── 개인별 Gantt 보기 ──────────────────────────────────────────────────────────
const STATUS_CELL: Record<string, string> = {
  done:        'bg-emerald-500/30 border-emerald-500/50',
  in_progress: 'bg-sky-500/40 border-sky-500/55',
  review_test: 'bg-amber-500/30 border-amber-500/50',
  todo:        'bg-primary/20 border-primary/30',
  backlog:     'bg-secondary border-border',
};

function PersonalGanttView({
  assignee,
  tasks,
  issues,
  dates,
  todayStr,
  onItemClick,
}: {
  assignee: string;
  tasks: WorkItem[];
  issues: WorkItem[];
  dates: Date[];
  todayStr: string;
  onItemClick: (item: DayItem) => void;
}) {
  const myTasks = tasks.filter(t => (t.assignee || '미지정') === assignee);
  const myIssues = issues.filter(i => (i.assignee || '미지정') === assignee);

  const startStr = dates.length > 0 ? fmtDate(dates[0]) : '';
  const endStr   = dates.length > 0 ? fmtDate(dates[dates.length - 1]) : '';

  // item → set of active date strings (within window)
  const taskActiveDates = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const item of myTasks) {
      const ts = item.startedAt?.slice(0, 10);
      if (!ts) continue;
      const te = item.closedAt?.slice(0, 10) ??
        ((item as WorkItem & { parentId?: string }).kanbanStatus !== 'done' ? fmtDate(new Date()) : ts);
      const loopStart = ts > startStr ? parseDate(ts) : parseDate(startStr);
      const loopEnd   = te < endStr   ? parseDate(te)  : parseDate(endStr);
      const active = new Set<string>();
      let d = new Date(loopStart);
      while (fmtDate(d) <= fmtDate(loopEnd)) {
        active.add(fmtDate(d));
        d = addDays(d, 1);
      }
      map.set(item.id, active);
    }
    return map;
  }, [myTasks, startStr, endStr]);

  type GanttRow = { item: WorkItem; indent: boolean };

  const rows: GanttRow[] = useMemo(() => {
    const result: GanttRow[] = [];
    const parentTasks = myTasks.filter(t => !t.parentId);
    const childTasks  = myTasks.filter(t =>  t.parentId);
    const addedIds = new Set<string>();

    for (const pt of parentTasks) {
      result.push({ item: pt, indent: false });
      addedIds.add(pt.id);
      for (const ct of childTasks.filter(ct => ct.parentId === pt.id)) {
        result.push({ item: ct, indent: true });
        addedIds.add(ct.id);
      }
    }
    for (const ct of childTasks) {
      if (!addedIds.has(ct.id)) result.push({ item: ct, indent: true });
    }
    for (const issue of myIssues) {
      const ds = issue.startedAt?.slice(0, 10);
      if (ds && ds >= startStr && ds <= endStr) result.push({ item: issue, indent: false });
    }
    return result;
  }, [myTasks, myIssues, startStr, endStr]);

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-muted-foreground">
        <Users className="w-12 h-12 mb-3 opacity-30" />
        <p className="text-sm">"{assignee}"의 작업/이슈가 없습니다.</p>
      </div>
    );
  }

  const COL_W = dates.length > 14 ? 68 : 90;

  return (
    <div className="flex-1 overflow-auto">
      <table className="border-collapse min-w-full text-xs">
        <thead className="sticky top-0 z-20 bg-card">
          <tr>
            <th className="sticky left-0 z-30 bg-card border-b border-r border-border px-3 py-2 text-left min-w-[240px]">
              <span className="text-xs font-semibold text-muted-foreground">작업 / 이슈</span>
            </th>
            {dates.map(d => {
              const ds = fmtDate(d);
              const isTd = ds === todayStr;
              const isWE = isWeekend(d);
              return (
                <th key={ds} className={`border-b border-r border-border px-1 py-2 text-center font-medium ${isTd ? 'bg-primary/10 text-primary' : isWE ? 'text-muted-foreground/50 bg-secondary/30' : 'text-muted-foreground'}`}
                  style={{ minWidth: COL_W, width: COL_W }}>
                  <div className="text-[11px] font-semibold">{dayLabel(d)}</div>
                  {isTd && <div className="text-[9px] text-primary font-bold">TODAY</div>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => {
            const bgBase = ri % 2 === 0 ? 'hsl(var(--background))' : 'hsl(var(--secondary)/0.08)';
            const bgClass = ri % 2 === 0 ? 'bg-background' : 'bg-secondary/5';

            if (row.item.type === 'task') {
              const t = row.item;
              const active = taskActiveDates.get(t.id) ?? new Set<string>();
              const cellColor = STATUS_CELL[t.kanbanStatus] ?? STATUS_CELL.todo;
              const dayItem: DayItem = {
                type: 'task', id: t.id, label: t.content, sub: t.category,
                status: t.kanbanStatus, priority: t.priority, module: t.module,
                startDate: t.startedAt?.slice(0, 10) ?? '',
                endDate: t.closedAt?.slice(0, 10),
              };
              return (
                <tr key={t.id} className={bgClass}>
                  <td className="sticky left-0 z-10 border-b border-r border-border px-3 py-1.5 align-middle"
                    style={{ backgroundColor: bgBase }}>
                    <div className={`flex items-center gap-1.5 ${row.indent ? 'ml-4' : ''}`}>
                      {row.indent && <span className="text-muted-foreground/40 text-xs flex-shrink-0">└</span>}
                      <StatusIcon status={t.kanbanStatus} type="task" />
                      <span className={`truncate max-w-[180px] leading-tight ${row.indent ? 'text-muted-foreground text-[11px]' : 'font-medium text-xs'}`}>{stripHtml(t.content)}</span>
                    </div>
                    <div className={`text-[10px] text-muted-foreground mt-0.5 truncate ${row.indent ? 'ml-9' : 'ml-4'}`}>
                      {t.category}
                      {t.module && <span className={`ml-1 px-1 rounded ${MODULE_COLOR[t.module] ?? 'bg-secondary text-muted-foreground'}`}>{t.module}</span>}
                    </div>
                  </td>
                  {dates.map(d => {
                    const ds = fmtDate(d);
                    const on = active.has(ds);
                    const isTd = ds === todayStr;
                    return (
                      <td key={ds}
                        onClick={() => on && onItemClick(dayItem)}
                        className={`border-b border-r border-border align-middle ${isTd ? 'bg-primary/5' : isWeekend(d) ? 'bg-secondary/20' : ''} ${on ? 'cursor-pointer hover:brightness-110' : ''}`}
                        style={{ minWidth: COL_W, width: COL_W, height: 34 }}>
                        {on && (
                          <div className={`mx-0.5 rounded border h-[22px] ${cellColor} flex items-center justify-center gap-0.5`}>
                            {t.kanbanStatus === 'done' && <CheckCircle2 className="w-2.5 h-2.5 text-green-500" />}
                            {t.kanbanStatus === 'in_progress' && <Clock className="w-2.5 h-2.5 text-blue-400" />}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            } else {
              const iss = row.item;
              const ds = iss.startedAt?.slice(0, 10);
              const dayItem: DayItem = {
                type: 'issue', id: iss.id, label: iss.content, sub: iss.category,
                status: iss.closedAt ? 'resolved' : 'open',
                startDate: ds ?? '', resolved: !!iss.closedAt,
              };
              return (
                <tr key={iss.id} className={bgClass}>
                  <td className="sticky left-0 z-10 border-b border-r border-border px-3 py-1.5 align-middle"
                    style={{ backgroundColor: bgBase }}>
                    <div className="flex items-center gap-1.5">
                      <AlertCircle className={`w-3 h-3 flex-shrink-0 ${iss.closedAt ? 'text-green-400' : 'text-red-400'}`} />
                      <span className="truncate max-w-[180px] font-medium leading-tight">{stripHtml(iss.content)}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5 ml-4">{iss.category}</div>
                  </td>
                  {dates.map(d => {
                    const colDs = fmtDate(d);
                    const on = colDs === ds;
                    const isTd = colDs === todayStr;
                    return (
                      <td key={colDs}
                        onClick={() => on && onItemClick(dayItem)}
                        className={`border-b border-r border-border align-middle ${isTd ? 'bg-primary/5' : isWeekend(d) ? 'bg-secondary/20' : ''} ${on ? 'cursor-pointer' : ''}`}
                        style={{ minWidth: COL_W, width: COL_W, height: 34 }}>
                        {on && (
                          <div className={`mx-0.5 rounded border h-[22px] ${iss.closedAt ? 'bg-green-500/30 border-green-500/50' : 'bg-orange-500/30 border-orange-500/50'} flex items-center justify-center`}>
                            <AlertCircle className={`w-2.5 h-2.5 ${iss.closedAt ? 'text-green-400' : 'text-orange-400'}`} />
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            }
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

export function WbsFlowPage() {
  const today = new Date();
  const [baseDate, setBaseDate] = useState<Date>(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - d.getDay()); // start of current week (Sunday)
    return d;
  });
  const [viewMode, setViewMode] = useState<ViewMode>('twoWeek');
  const [filterAssignee, setFilterAssignee] = useState('');
  const [selectedItem, setSelectedItem] = useState<DayItem | null>(null);
  const [showOnlyActive, setShowOnlyActive] = useState(false);
  const [pageView, setPageView] = useState<'grid' | 'personal'>('personal');
  const [personalAssignee, setPersonalAssignee] = useState<string>('');

  // ── data fetching ── 통합 work_items 한 번에 가져와 type 으로 분할
  const { data: allRes } = useQuery({
    queryKey: ['wbs-work-items'],
    queryFn: () => workItemsApi.getAll().then(r => r.data.data),
  });
  const tasks: WorkItem[]  = useMemo(() => (allRes ?? []).filter(w => w.type === 'task'), [allRes]);
  const issues: WorkItem[] = useMemo(() => (allRes ?? []).filter(w => w.type === 'issue'), [allRes]);

  // ── date range ──
  const dayCount = viewMode === 'week' ? 7 : viewMode === 'twoWeek' ? 14 : 30;
  const dates = useMemo(() => {
    return Array.from({ length: dayCount }, (_, i) => addDays(baseDate, i));
  }, [baseDate, dayCount]);

  const todayStr = fmtDate(today);
  const startStr = fmtDate(baseDate);
  const endStr = fmtDate(addDays(baseDate, dayCount - 1));

  const movePrev = () => setBaseDate(d => addDays(d, -dayCount));
  const moveNext = () => setBaseDate(d => addDays(d, dayCount));
  const moveToday = () => {
    const d = new Date(today);
    if (viewMode !== 'month') d.setDate(d.getDate() - d.getDay());
    setBaseDate(d);
  };

  // ── build assignee rows ──
  const rows: AssigneeRow[] = useMemo(() => {
    const map = new Map<string, AssigneeRow>();
    const ensureRow = (assignee: string) => {
      if (!map.has(assignee)) {
        map.set(assignee, { assignee, roles: [], items: new Map() });
      }
      return map.get(assignee)!;
    };
    const addItem = (assignee: string, date: string, item: DayItem) => {
      const row = ensureRow(assignee);
      if (!row.items.has(date)) row.items.set(date, []);
      row.items.get(date)!.push(item);
    };

    for (const task of tasks) {
      const assignee = task.assignee || '미지정';
      const row = ensureRow(assignee);
      if (task.module && !row.roles.includes(task.module)) row.roles.push(task.module);

      const taskStartStr = task.startedAt?.slice(0, 10);
      const taskEndStr = task.closedAt?.slice(0, 10);
      const startD = taskStartStr ? parseDate(taskStartStr) : null;
      const endD = taskEndStr ? parseDate(taskEndStr) : null;
      if (!startD) continue;

      const dayItem: DayItem = {
        type: 'task',
        id: task.id,
        label: task.content,
        sub: task.category,
        status: task.kanbanStatus,
        priority: task.priority,
        module: task.module,
        startDate: taskStartStr!,
        endDate: taskEndStr,
        isSubTask: !!task.parentId,
        parentId: task.parentId,
      };

      const effectiveEnd = endD ?? (task.kanbanStatus !== 'done' ? new Date() : startD);
      const rangeStart = startD < parseDate(startStr) ? parseDate(startStr) : startD;
      const rangeEnd = effectiveEnd > parseDate(endStr) ? parseDate(endStr) : effectiveEnd;

      let cur = rangeStart;
      while (cur <= rangeEnd) {
        addItem(assignee, fmtDate(cur), dayItem);
        cur = addDays(cur, 1);
      }
    }

    for (const issue of issues) {
      const assignee = issue.assignee || '미지정';
      const row = ensureRow(assignee);
      if (issue.category && !row.roles.includes(issue.category)) row.roles.push(issue.category);

      const issueDateStr = issue.startedAt?.slice(0, 10);
      if (!issueDateStr) continue;

      const dayItem: DayItem = {
        type: 'issue',
        id: issue.id,
        label: issue.content,
        sub: issue.category,
        status: issue.closedAt ? 'resolved' : 'open',
        startDate: issueDateStr,
        endDate: issue.closedAt ? issue.closedAt.slice(0, 10) : undefined,
        resolved: !!issue.closedAt,
      };

      if (issueDateStr >= startStr && issueDateStr <= endStr) {
        addItem(assignee, issueDateStr, dayItem);
      }
    }

    return Array.from(map.values()).sort((a, b) => a.assignee.localeCompare(b.assignee));
  }, [tasks, issues, startStr, endStr]);

  // ── filtered rows ──
  const filteredRows = useMemo(() => {
    let r = rows;
    if (filterAssignee) r = r.filter(row => row.assignee.includes(filterAssignee));
    if (showOnlyActive) r = r.filter(row => {
      for (const items of row.items.values()) {
        if (items.some(i => i.status !== 'done' && i.status !== 'resolved')) return true;
      }
      return false;
    });
    return r;
  }, [rows, filterAssignee, showOnlyActive]);

  // unique assignees for filter dropdown
  const allAssignees = useMemo(() => [...new Set(rows.map(r => r.assignee))].sort(), [rows]);

  // ── stats ──
  const totalItems = useMemo(() =>
    filteredRows.reduce((sum, row) => {
      let cnt = 0;
      for (const items of row.items.values()) cnt += items.length;
      return sum + cnt;
    }, 0), [filteredRows]);

  const COL_W = viewMode === 'month' ? 80 : 110;

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto px-4 lg:px-6 py-5 space-y-4 max-w-[1800px]">
        {/* ── Page header ─────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
              <BarChart3 className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold leading-tight">WBS 작업 흐름</h1>
              <p className="text-xs text-muted-foreground">담당자별 역할 · 날짜별 업무 현황</p>
            </div>
          </div>
          {/* 보기 모드 토글 */}
          <div className="flex items-center gap-0.5 bg-secondary rounded-xl p-0.5 text-xs">
            <button
              onClick={() => setPageView('grid')}
              className={`px-3.5 py-1.5 rounded-lg font-medium transition-colors ${pageView === 'grid' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              전체 그리드
            </button>
            <button
              onClick={() => setPageView('personal')}
              className={`px-3.5 py-1.5 rounded-lg font-medium transition-colors ${pageView === 'personal' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              개인별 간트
            </button>
          </div>
        </div>

        {/* ── Summary cards ───────────────────────────────────────────── */}
        <SummaryBar tasks={tasks} issues={issues} />

        {/* ── Toolbar ─────────────────────────────────────────────────── */}
        <MacCard bodyPadding="p-3">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Date nav */}
            <div className="flex items-center gap-0.5 bg-secondary rounded-xl p-0.5">
              <button
                onClick={movePrev}
                className="p-1.5 hover:bg-card rounded-lg text-muted-foreground hover:text-foreground transition-colors"
                aria-label="이전 기간"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={moveToday}
                className="px-3 py-1 text-xs font-medium hover:bg-card rounded-lg text-foreground transition-colors flex items-center gap-1.5 tabular-nums"
              >
                <Calendar className="w-3.5 h-3.5 text-primary" />
                {startStr} <span className="text-muted-foreground">~</span> {endStr}
              </button>
              <button
                onClick={moveNext}
                className="p-1.5 hover:bg-card rounded-lg text-muted-foreground hover:text-foreground transition-colors"
                aria-label="다음 기간"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <ViewModeBar
              modes={[
                { id: 'week',    label: '1주' },
                { id: 'twoWeek', label: '2주' },
                { id: 'month',   label: '1달' },
              ]}
              active={viewMode}
              onChange={(v) => setViewMode(v as ViewMode)}
              showStylePanel={false}
            />

            {pageView === 'personal' && (
              <div className="flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-primary" />
                <select
                  value={personalAssignee}
                  onChange={e => setPersonalAssignee(e.target.value)}
                  className="text-xs bg-background border border-border rounded-xl px-2.5 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value="">담당자 선택…</option>
                  {allAssignees.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
            )}

            <div className="flex items-center gap-1.5">
              <Filter className="w-3.5 h-3.5 text-muted-foreground" />
              <select
                value={filterAssignee}
                onChange={e => setFilterAssignee(e.target.value)}
                className="text-xs bg-background border border-border rounded-xl px-2.5 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                <option value="">전체 담당자</option>
                {allAssignees.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>

            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none px-2.5 py-1.5 rounded-xl border border-border hover:bg-secondary/40 transition-colors">
              <input
                type="checkbox"
                checked={showOnlyActive}
                onChange={e => setShowOnlyActive(e.target.checked)}
                className="accent-primary"
              />
              진행중만
            </label>

            <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              <Users className="w-3.5 h-3.5" />
              <span className="tabular-nums">{filteredRows.length}명</span>
              <span>·</span>
              <span className="tabular-nums">{totalItems}건</span>
            </div>
          </div>
        </MacCard>

        {/* ── Body ────────────────────────────────────────────────────── */}
        <MacCard
          bodyPadding="p-0"
          className="overflow-hidden"
          title={pageView === 'personal'
            ? (personalAssignee ? `${personalAssignee} 의 간트` : '개인별 간트')
            : `담당자 그리드 · ${dayCount}일`}
        >
        {pageView === 'personal' ? (
          personalAssignee ? (
            <PersonalGanttView
              assignee={personalAssignee}
              tasks={tasks}
              issues={issues}
              dates={dates}
              todayStr={todayStr}
              onItemClick={setSelectedItem}
            />
          ) : (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center mb-3">
                <Users className="w-7 h-7 opacity-50" />
              </div>
              <p className="text-sm">상단에서 담당자를 선택하세요.</p>
            </div>
          )
        ) : (
          <div className="overflow-auto">
            {filteredRows.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                <div className="w-14 h-14 rounded-2xl bg-secondary flex items-center justify-center mb-3">
                  <Users className="w-7 h-7 opacity-50" />
                </div>
                <p className="text-sm">이 기간에 해당하는 작업/이슈가 없습니다.</p>
              </div>
            ) : (
              <table className="border-collapse min-w-full text-xs">
            <thead className="sticky top-0 z-20 bg-card">
              <tr>
                {/* Assignee header */}
                <th className="sticky left-0 z-30 bg-card border-b border-r border-border px-3 py-2 text-left w-40 min-w-[160px]">
                  <span className="text-xs font-semibold text-muted-foreground">담당자 / 역할</span>
                </th>
                {dates.map(d => {
                  const ds = fmtDate(d);
                  const isTodayCol = ds === todayStr;
                  const isWE = isWeekend(d);
                  return (
                    <th key={ds}
                      className={`border-b border-r border-border px-1 py-2 text-center font-medium transition-colors
                        ${isTodayCol ? 'bg-primary/10 text-primary' : isWE ? 'text-muted-foreground/50 bg-secondary/30' : 'text-muted-foreground'}`}
                      style={{ minWidth: COL_W, width: COL_W }}>
                      <div className="leading-tight">
                        <div className={`text-[11px] font-semibold ${isTodayCol ? 'text-primary' : ''}`}>
                          {dayLabel(d)}
                        </div>
                        {isTodayCol && (
                          <div className="text-[9px] text-primary font-bold">TODAY</div>
                        )}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row, rowIdx) => {
                const totalItemsInRow = Array.from(row.items.values()).flat().length;
                return (
                  <tr key={row.assignee}
                    className={rowIdx % 2 === 0 ? 'bg-background' : 'bg-secondary/10'}>
                    {/* Assignee cell */}
                    <td className="sticky left-0 z-10 border-b border-r border-border px-3 py-2 align-top"
                      style={{ backgroundColor: rowIdx % 2 === 0 ? 'hsl(var(--background))' : 'hsl(var(--secondary)/0.1)' }}>
                      <div className="font-semibold text-foreground text-xs mb-0.5">{row.assignee}</div>
                      <div className="flex flex-wrap gap-1">
                        {row.roles.slice(0, 4).map(role => (
                          <span key={role}
                            className={`text-[9px] px-1.5 py-0.5 rounded-full ${MODULE_COLOR[role] ?? 'bg-secondary text-muted-foreground'}`}>
                            {role}
                          </span>
                        ))}
                        {row.roles.length > 4 && (
                          <span className="text-[9px] text-muted-foreground">+{row.roles.length - 4}</span>
                        )}
                      </div>
                      <div className="mt-1 text-[9px] text-muted-foreground/60">{totalItemsInRow}건</div>
                    </td>
                    {dates.map(d => {
                      const ds = fmtDate(d);
                      const items = row.items.get(ds) ?? [];
                      const isTodayCol = ds === todayStr;
                      const isWE = isWeekend(d);
                      // Deduplicate items by id (item spans multiple days)
                      const seen = new Set<string>();
                      const uniqueItems = items.filter(item => {
                        if (seen.has(item.id)) return false;
                        seen.add(item.id);
                        return true;
                      });
                      return (
                        <td key={ds}
                          className={`border-b border-r border-border px-1 py-1 align-top
                            ${isTodayCol ? 'bg-primary/5' : isWE ? 'bg-secondary/20' : ''}`}
                          style={{ minWidth: COL_W, width: COL_W }}>
                          <div className="flex flex-col gap-0.5">
                            {uniqueItems.map(item => (
                              <ItemCard key={`${item.id}-${ds}`} item={item} onClick={() => setSelectedItem(item)} />
                            ))}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
                </tbody>
              </table>
            )}
          </div>
        )}
        </MacCard>

        {/* ── Legend ──────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap px-1">
          <span className="font-medium">범례:</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-sky-500/30 inline-block" /> 작업</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-orange-500/30 inline-block" /> 이슈</span>
          <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-emerald-500" /> 완료/해결</span>
          <span className="flex items-center gap-1"><Clock className="w-3 h-3 text-sky-500" /> 진행중</span>
          <span className="flex items-center gap-1"><AlertCircle className="w-3 h-3 text-red-500" /> 미해결</span>
          <span className="ml-auto text-[10px]">클릭 시 상세 정보</span>
        </div>
      </main>

      {selectedItem && (
        <DetailModal item={selectedItem} onClose={() => setSelectedItem(null)} />
      )}
    </div>
  );
}
