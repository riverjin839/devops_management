import { useState, useMemo } from 'react';
import { StatTile, StatTileRow } from '@/components/common/StatTile';
import { PageHeader } from '@/components/common/PageHeader';
import { useQuery } from '@tanstack/react-query';
import { workItemsApi } from '@/services/api';
import type { WorkItem } from '@/types';
import {
  ChevronLeft, ChevronRight, Calendar, Users, Filter,
  CheckCircle2, Clock, AlertCircle, Circle, BarChart3,
  ListChecks, Activity, Plus, FolderOpen,
} from 'lucide-react';
import { ViewModeBar, SidePane, EmptyState, ErrorState, LoadingState, PageShell } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { stripHtml, toLocalDateKey } from '@/lib/utils';
import { useProjects } from '@/hooks/useProjects';
import { ProjectHeader } from '@/components/wbs/ProjectHeader';
import { ProjectFormModal } from '@/components/wbs/ProjectFormModal';

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
/** UTC 저장값 → 로컬(KST) 날짜 키. 예전 `.slice(0, 10)` 은 UTC 앞자리라 KST 오전 업무가 전날로 샜다(D-163②). */
function localKey(iso?: string | null): string | undefined {
  return toLocalDateKey(iso) || undefined;
}

// 담당자 필드에 쉼표로 여러 명이 들어올 수 있다 (예: "A,B") — 한 명씩 분리한다.
function splitAssignees(s?: string | null): string[] {
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

const KANBAN_LABEL: Record<string, string> = {
  backlog: '백로그', todo: '할일', in_progress: '진행중',
  review_test: '검토', done: '완료',
};
// 우선순위는 범주라 상태 토큰(status-*) 대신 --chart-* / 중립(§12.12-4).
const PRIORITY_COLOR: Record<string, string> = {
  high:   'bg-chart-5/15 text-chart-5-text border-chart-5/25',
  medium: 'bg-chart-3/15 text-chart-3-text border-chart-3/25',
  low:    'bg-secondary text-muted-foreground border-border',
};
const PRIORITY_LABEL: Record<string, string> = { high: '높음', medium: '보통', low: '낮음' };
const MODULE_COLOR: Record<string, string> = {
  k8s:        'bg-chart-1/15 text-chart-1-text',
  keycloak:   'bg-chart-4/15 text-chart-4-text',
  nexus:      'bg-chart-7/15 text-chart-7-text',
  cilium:     'bg-chart-6/15 text-chart-6-text',
  argocd:     'bg-chart-2/15 text-chart-2-text',
  jenkins:    'bg-chart-5/15 text-chart-5-text',
  backend:    'bg-chart-3/15 text-chart-3-text',
  frontend:   'bg-chart-5/15 text-chart-5-text',
  monitoring: 'bg-chart-2/15 text-chart-2-text',
  infra:      'bg-chart-8/15 text-chart-8-text',
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
      ? <CheckCircle2 className="w-3 h-3 text-muted-foreground flex-shrink-0" />
      : <AlertCircle className="w-3 h-3 text-status-critical flex-shrink-0" />;
  }
  const icons: Record<string, JSX.Element> = {
    done:        <CheckCircle2 className="w-3 h-3 text-muted-foreground flex-shrink-0" />,
    in_progress: <Clock className="w-3 h-3 text-chart-3 flex-shrink-0" />,
    review_test: <Clock className="w-3 h-3 text-chart-4 flex-shrink-0" />,
    todo:        <Circle className="w-3 h-3 text-muted-foreground flex-shrink-0" />,
    backlog:     <Circle className="w-3 h-3 text-muted-foreground flex-shrink-0" />,
  };
  return icons[status] ?? <Circle className="w-3 h-3 text-muted-foreground flex-shrink-0" />;
}

function ItemCard({ item, onClick }: { item: DayItem; onClick: () => void }) {
  const isIssue = item.type === 'issue';
  const base = isIssue
    ? (item.resolved
        ? 'border-l-border'
        : 'border-l-chart-7')
    : item.isSubTask
      ? 'border-l-chart-4 opacity-90'
      : 'border-l-chart-1';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full border-l-[3px] ${base} rounded-r-md px-2 py-1 cursor-pointer hover:bg-secondary/40 transition-colors text-left ${item.isSubTask ? 'ml-2' : ''}`}
    >
      <div className="flex items-center gap-1 min-w-0">
        <StatusIcon status={isIssue ? (item.resolved ? 'resolved' : 'open') : item.status} type={item.type} />
        <span className="text-xs font-medium truncate leading-tight">{item.label}</span>
      </div>
      {item.sub && (
        <p className="text-xs text-muted-foreground truncate mt-0.5 leading-tight pl-4">{item.sub}</p>
      )}
      <div className="flex items-center gap-1 mt-0.5 pl-4 flex-wrap">
        {item.module && (
          <span className={`text-[11px] px-1 rounded-md ${MODULE_COLOR[item.module] ?? 'bg-secondary text-muted-foreground'}`}>
            {item.module}
          </span>
        )}
        {item.priority && (
          <span className={`text-[11px] px-1 rounded-md border ${PRIORITY_COLOR[item.priority] ?? ''}`}>
            {PRIORITY_LABEL[item.priority] ?? item.priority}
          </span>
        )}
        {isIssue && (
          <span className={`text-[11px] px-1 rounded-md ${item.resolved ? 'bg-secondary text-muted-foreground' : 'bg-status-warning/15 text-status-warning'}`}>
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
      <span className={`text-xs px-2 py-0.5 rounded-full font-semibold flex-shrink-0 ${isIssue ? 'bg-chart-7/15 text-chart-7-text' : 'bg-chart-1/15 text-chart-1-text'}`}>
        {isIssue ? '이슈' : '작업'}
      </span>
      {item.module && (
        <span className={`text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${MODULE_COLOR[item.module] ?? 'bg-secondary text-muted-foreground'}`}>
          {item.module}
        </span>
      )}
      {item.priority && (
        <span className={`text-xs px-2 py-0.5 rounded-full border flex-shrink-0 ${PRIORITY_COLOR[item.priority] ?? ''}`}>
          우선순위 {PRIORITY_LABEL[item.priority] ?? item.priority}
        </span>
      )}
    </div>
  );
  return (
    <SidePane open onClose={onClose} title={title} bodyClassName="px-5 py-4" width="55%">
      <h3 className="text-base font-semibold leading-snug mb-1">{stripHtml(item.label)}</h3>
      {item.sub && <p className="text-sm text-muted-foreground mb-4">{item.sub}</p>}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div className="rounded-lg bg-secondary/40 px-3 py-2">
          <dt className="text-xs text-muted-foreground">시작일</dt>
          <dd className="font-medium tabular-nums">{item.startDate || '—'}</dd>
        </div>
        {item.endDate && (
          <div className="rounded-lg bg-secondary/40 px-3 py-2">
            <dt className="text-xs text-muted-foreground">완료일</dt>
            <dd className="font-medium tabular-nums">{item.endDate}</dd>
          </div>
        )}
        <div className="rounded-lg bg-secondary/40 px-3 py-2">
          <dt className="text-xs text-muted-foreground">상태</dt>
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
  const issueProgress = issueCounts.total > 0 ? Math.round((issueCounts.resolved / issueCounts.total) * 100) : 0;

  return (
    <StatTileRow>
      <StatTile icon={ListChecks} label="작업" value={taskCounts.total}>
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          <Chip color="emerald">완료 {taskCounts.done}</Chip>
          <Chip color="sky">진행 {taskCounts.in_progress}</Chip>
          <Chip color="slate">대기 {taskCounts.todo + taskCounts.backlog}</Chip>
        </div>
      </StatTile>
      <StatTile icon={BarChart3} label="작업 진행률" value={`${taskProgress}%`}>
        <ProgressBar value={taskProgress} />
      </StatTile>
      <StatTile icon={Activity} label="이슈" value={issueCounts.total} tone={issueCounts.open > 0 ? 'warning' : undefined}>
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          <Chip color="emerald">해결 {issueCounts.resolved}</Chip>
          <Chip color={issueCounts.open > 0 ? 'red' : 'slate'}>미해결 {issueCounts.open}</Chip>
        </div>
      </StatTile>
      <StatTile icon={CheckCircle2} label="이슈 해결률" value={`${issueProgress}%`}>
        <ProgressBar value={issueProgress} />
      </StatTile>
    </StatTileRow>
  );
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 mt-2 rounded-full bg-secondary overflow-hidden" role="progressbar" aria-label={`진행률 ${value}%`} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full bg-primary rounded-full" style={{ width: `${value}%` }} />
    </div>
  );
}

const CHIP_COLOR: Record<string, string> = {
  emerald: 'bg-secondary text-muted-foreground',
  sky:     'bg-chart-3/15 text-chart-3-text',
  slate:   'bg-secondary text-muted-foreground',
  red:     'bg-status-critical/15 text-status-critical',
};

function Chip({ color, children }: { color: keyof typeof CHIP_COLOR | string; children: React.ReactNode }) {
  return (
    <span className={`text-xs font-medium px-1.5 py-0.5 rounded-md ${CHIP_COLOR[color] ?? CHIP_COLOR.slate}`}>
      {children}
    </span>
  );
}

// ── 개인별 Gantt 보기 ──────────────────────────────────────────────────────────
const STATUS_CELL: Record<string, string> = {
  done:        'bg-muted-foreground/20 border-muted-foreground/30',
  in_progress: 'bg-chart-3/40 border-chart-3/55',
  review_test: 'bg-chart-4/30 border-chart-4/50',
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
  showAllAssignees = false,
}: {
  assignee: string;
  tasks: WorkItem[];
  issues: WorkItem[];
  dates: Date[];
  todayStr: string;
  onItemClick: (item: DayItem) => void;
  showAllAssignees?: boolean;
}) {
  const matchesAssignee = (raw?: string | null) => {
    const names = splitAssignees(raw);
    return names.length ? names.includes(assignee) : assignee === '미지정';
  };
  const myTasks = showAllAssignees ? tasks : tasks.filter(t => matchesAssignee(t.assignee));
  const myIssues = showAllAssignees ? issues : issues.filter(i => matchesAssignee(i.assignee));

  const startStr = dates.length > 0 ? fmtDate(dates[0]) : '';
  const endStr   = dates.length > 0 ? fmtDate(dates[dates.length - 1]) : '';

  // item → set of active date strings (within window)
  const taskActiveDates = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const item of myTasks) {
      const ts = localKey(item.startedAt);
      if (!ts) continue;
      const te = localKey(item.closedAt) ??
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
      const ds = localKey(issue.startedAt);
      if (ds && ds >= startStr && ds <= endStr) result.push({ item: issue, indent: false });
    }
    return result;
  }, [myTasks, myIssues, startStr, endStr]);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title={`"${assignee}"의 작업·이슈가 없습니다.`}
        description="이 기간에 담당한 작업이나 이슈가 없습니다. 기간을 바꿔 보세요."
      />
    );
  }

  const COL_W = dates.length > 14 ? 68 : 90;

  return (
    <div className="flex-1 overflow-auto">
      <table className="border-collapse min-w-full text-sm">
        <thead className="sticky top-0 z-20 bg-card">
          <tr>
            <th className="sticky left-0 z-30 bg-card border-b border-r border-border px-3 py-2 text-left min-w-[240px]">
              <span className="text-sm font-semibold text-muted-foreground">작업 / 이슈</span>
            </th>
            {dates.map(d => {
              const ds = fmtDate(d);
              const isTd = ds === todayStr;
              const isWE = isWeekend(d);
              return (
                <th key={ds} className={`border-b border-r border-border px-1 py-2 text-center font-medium ${isTd ? 'bg-primary/10 text-primary' : isWE ? 'text-muted-foreground bg-secondary/30' : 'text-muted-foreground'}`}
                  style={{ minWidth: COL_W, width: COL_W }}>
                  <div className="text-xs font-semibold">{dayLabel(d)}</div>
                  {isTd && <div className="text-[11px] text-primary font-semibold">오늘</div>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => {
            const bgClass = ri % 2 === 0 ? 'bg-background' : 'bg-secondary/5';
            // 고정 열 배경 — 인라인 style 대신 토큰 클래스(§12.12-2).
            const stickyBg = ri % 2 === 0 ? 'bg-background' : 'bg-secondary/10';

            if (row.item.type === 'task') {
              const t = row.item;
              const active = taskActiveDates.get(t.id) ?? new Set<string>();
              const cellColor = STATUS_CELL[t.kanbanStatus] ?? STATUS_CELL.todo;
              const dayItem: DayItem = {
                type: 'task', id: t.id, label: t.content, sub: t.category,
                status: t.kanbanStatus, priority: t.priority, module: t.module,
                startDate: localKey(t.startedAt) ?? '',
                endDate: localKey(t.closedAt),
              };
              const taskTitle = stripHtml(t.content);
              return (
                <tr key={t.id} className={bgClass}>
                  <td className={`sticky left-0 z-10 border-b border-r border-border px-3 py-1.5 align-middle ${stickyBg}`}>
                    <div className={`flex items-center gap-1.5 ${row.indent ? 'ml-4' : ''}`}>
                      {row.indent && <span className="text-muted-foreground/40 text-sm flex-shrink-0">└</span>}
                      <StatusIcon status={t.kanbanStatus} type="task" />
                      <span className={`truncate max-w-[180px] leading-tight ${row.indent ? 'text-muted-foreground text-xs' : 'font-medium text-sm'}`}>{stripHtml(t.content)}</span>
                    </div>
                    <div className={`text-xs text-muted-foreground mt-0.5 truncate ${row.indent ? 'ml-9' : 'ml-4'}`}>
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
                        className={`border-b border-r border-border align-middle ${isTd ? 'bg-primary/5' : isWeekend(d) ? 'bg-secondary/20' : ''}`}
                        style={{ minWidth: COL_W, width: COL_W, height: 34 }}>
                        {on && (
                          // D-165: 셀 클릭(<td onClick>) 대신 막대를 버튼으로 — 키보드로 상세를 연다.
                          <button type="button" onClick={() => onItemClick(dayItem)}
                            title={`${taskTitle} · ${ds}`} aria-label={`${taskTitle} 상세 (${ds})`}
                            className={`w-[calc(100%-4px)] mx-0.5 rounded border h-[22px] ${cellColor} flex items-center justify-center gap-0.5 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50`}>
                            {t.kanbanStatus === 'done' && <CheckCircle2 className="w-2.5 h-2.5 text-muted-foreground" />}
                            {t.kanbanStatus === 'in_progress' && <Clock className="w-2.5 h-2.5 text-chart-3" />}
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            } else {
              const iss = row.item;
              const ds = localKey(iss.startedAt);
              const issueTitle = stripHtml(iss.content);
              const dayItem: DayItem = {
                type: 'issue', id: iss.id, label: iss.content, sub: iss.category,
                status: iss.closedAt ? 'resolved' : 'open',
                startDate: ds ?? '', resolved: !!iss.closedAt,
              };
              return (
                <tr key={iss.id} className={bgClass}>
                  <td className={`sticky left-0 z-10 border-b border-r border-border px-3 py-1.5 align-middle ${stickyBg}`}>
                    <div className="flex items-center gap-1.5">
                      <AlertCircle className={`w-3 h-3 flex-shrink-0 ${iss.closedAt ? 'text-muted-foreground' : 'text-status-critical'}`} />
                      <span className="truncate max-w-[180px] font-medium leading-tight">{stripHtml(iss.content)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 ml-4">{iss.category}</div>
                  </td>
                  {dates.map(d => {
                    const colDs = fmtDate(d);
                    const on = colDs === ds;
                    const isTd = colDs === todayStr;
                    return (
                      <td key={colDs}
                        className={`border-b border-r border-border align-middle ${isTd ? 'bg-primary/5' : isWeekend(d) ? 'bg-secondary/20' : ''}`}
                        style={{ minWidth: COL_W, width: COL_W, height: 34 }}>
                        {on && (
                          <button type="button" onClick={() => onItemClick(dayItem)}
                            title={`${issueTitle} · ${colDs}`} aria-label={`이슈 ${issueTitle} 상세 (${colDs})`}
                            className={`w-[calc(100%-4px)] mx-0.5 rounded border h-[22px] ${iss.closedAt ? 'bg-muted-foreground/20 border-muted-foreground/30' : 'bg-chart-7/30 border-chart-7/50'} flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50`}>
                            <AlertCircle className={`w-2.5 h-2.5 ${iss.closedAt ? 'text-muted-foreground' : 'text-chart-7'}`} />
                          </button>
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
  const [pageView, setPageView] = useState<'project' | 'grid' | 'personal'>('project');
  const [personalAssignee, setPersonalAssignee] = useState<string>('');
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);

  // ── projects ──
  const projectsQuery = useProjects();
  const projectsData = projectsQuery.data;
  const projects = useMemo(() => projectsData?.data ?? [], [projectsData]);

  // ── data fetching ── 통합 work_items 한 번에 가져와 type 으로 분할
  const itemsQuery = useQuery({
    queryKey: ['wbs-work-items'],
    queryFn: () => workItemsApi.getAll().then(r => r.data.data),
  });
  const allRes = itemsQuery.data;
  // D-153: 로딩·실패를 "프로젝트 없음"·"작업 없음" 빈 상태로 보여 주지 않는다(빈 상태 CTA → 중복 생성).
  const itemsBody = itemsQuery.isLoading
    ? <LoadingState label="작업·이슈를 불러오는 중…" />
    : itemsQuery.isError
      ? <ErrorState error={itemsQuery.error} title="작업·이슈를 불러오지 못했습니다" onRetry={() => void itemsQuery.refetch()} />
      : null;
  const projectsBody = projectsQuery.isLoading
    ? <LoadingState label="프로젝트를 불러오는 중…" />
    : projectsQuery.isError
      ? <ErrorState error={projectsQuery.error} title="프로젝트를 불러오지 못했습니다" onRetry={() => void projectsQuery.refetch()} />
      : itemsBody;
  const allItems: WorkItem[] = useMemo(() => allRes ?? [], [allRes]);
  const tasks: WorkItem[]  = useMemo(() => allItems.filter(w => w.type === 'task'), [allItems]);
  const issues: WorkItem[] = useMemo(() => allItems.filter(w => w.type === 'issue'), [allItems]);



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
      const assignees = splitAssignees(task.assignee);
      if (assignees.length === 0) assignees.push('미지정');

      const taskStartStr = localKey(task.startedAt);
      const taskEndStr = localKey(task.closedAt);
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

      for (const assignee of assignees) {
        const row = ensureRow(assignee);
        if (task.module && !row.roles.includes(task.module)) row.roles.push(task.module);
        let cur = rangeStart;
        while (cur <= rangeEnd) {
          addItem(assignee, fmtDate(cur), dayItem);
          cur = addDays(cur, 1);
        }
      }
    }

    for (const issue of issues) {
      const assignees = splitAssignees(issue.assignee);
      if (assignees.length === 0) assignees.push('미지정');

      const issueDateStr = localKey(issue.startedAt);
      if (!issueDateStr) continue;

      const dayItem: DayItem = {
        type: 'issue',
        id: issue.id,
        label: issue.content,
        sub: issue.category,
        status: issue.closedAt ? 'resolved' : 'open',
        startDate: issueDateStr,
        endDate: localKey(issue.closedAt),
        resolved: !!issue.closedAt,
      };

      const inWindow = issueDateStr >= startStr && issueDateStr <= endStr;
      for (const assignee of assignees) {
        const row = ensureRow(assignee);
        if (issue.category && !row.roles.includes(issue.category)) row.roles.push(issue.category);
        if (inWindow) addItem(assignee, issueDateStr, dayItem);
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
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" sidebar={false} className="space-y-4">
        {/* ── Page header ─────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <PageHeader icon={BarChart3} title="WBS 작업 흐름" description="담당자별 역할 · 날짜별 업무 현황" className="flex-1 min-w-0" />
          <div className="flex items-center gap-2">
            {/* 보기 모드 토글 */}
            <div className="flex items-center gap-0.5 bg-secondary rounded-xl p-0.5 text-sm" role="group" aria-label="보기 방식">
              <button
                type="button"
                onClick={() => setPageView('project')}
                aria-pressed={pageView === 'project'}
                className={`px-3.5 py-1.5 rounded-lg font-medium transition-colors ${pageView === 'project' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                프로젝트
              </button>
              <button
                type="button"
                onClick={() => setPageView('grid')}
                aria-pressed={pageView === 'grid'}
                className={`px-3.5 py-1.5 rounded-lg font-medium transition-colors ${pageView === 'grid' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                전체 그리드
              </button>
              <button
                type="button"
                onClick={() => setPageView('personal')}
                aria-pressed={pageView === 'personal'}
                className={`px-3.5 py-1.5 rounded-lg font-medium transition-colors ${pageView === 'personal' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              >
                개인별 간트
              </button>
            </div>
            <button
              onClick={() => setShowNewProjectModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl transition-colors shadow-card"
            >
              <Plus className="w-3.5 h-3.5" /> 프로젝트
            </button>
          </div>
        </div>

        {/* ── Summary cards ───────────────────────────────────────────── */}
        {itemsQuery.isSuccess && <SummaryBar tasks={tasks} issues={issues} />}

        {/* ── Toolbar ─────────────────────────────────────────────────── */}
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
              title="오늘이 있는 기간으로 이동"
              aria-label={`표시 기간 ${startStr} ~ ${endStr} — 오늘로 이동`}
              className="px-3 py-1 text-sm font-medium hover:bg-card rounded-lg text-foreground transition-colors flex items-center gap-1.5 tabular-nums"
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

          {pageView === 'project' && projects.length > 0 && (
            <div className="flex items-center gap-1.5">
              <FolderOpen className="w-3.5 h-3.5 text-primary" aria-hidden />
              <select
                aria-label="프로젝트 선택"
                value={selectedProjectId}
                onChange={e => setSelectedProjectId(e.target.value)}
                className="text-sm bg-background border border-border rounded-xl px-2.5 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                <option value="">전체 프로젝트</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}

          {pageView === 'personal' && (
            <div className="flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-primary" aria-hidden />
              <select
                aria-label="간트 담당자 선택"
                value={personalAssignee}
                onChange={e => setPersonalAssignee(e.target.value)}
                className="text-sm bg-background border border-border rounded-xl px-2.5 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                <option value="">담당자 선택…</option>
                {allAssignees.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </div>
          )}

          <div className="flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />
            <select
              aria-label="담당자 필터"
              value={filterAssignee}
              onChange={e => setFilterAssignee(e.target.value)}
              className="text-sm bg-background border border-border rounded-xl px-2.5 py-1.5 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="">전체 담당자</option>
              {allAssignees.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>

          <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer select-none px-2.5 py-1.5 rounded-xl border border-border hover:bg-secondary/40 transition-colors">
            <input
              type="checkbox"
              checked={showOnlyActive}
              onChange={e => setShowOnlyActive(e.target.checked)}
              className="accent-primary"
            />
            진행중만
          </label>

          <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
            <Users className="w-3.5 h-3.5" />
            <span className="tabular-nums">{filteredRows.length}명</span>
            <span>·</span>
            <span className="tabular-nums">{totalItems}건</span>
          </div>
        </div>

        {/* ── 프로젝트 뷰 ─────────────────────────────────────────────── */}
        {pageView === 'project' && (
          <div className="space-y-4">
            {projectsBody ? (
              <MacCard title="프로젝트">{projectsBody}</MacCard>
            ) : projects.length === 0 ? (
              <EmptyState
                icon={FolderOpen}
                title="아직 프로젝트가 없습니다."
                description="프로젝트를 만들면 소속 업무를 묶어 흐름을 볼 수 있습니다."
                action={{ label: '첫 프로젝트 만들기', onClick: () => setShowNewProjectModal(true) }}
              />
            ) : (
              (selectedProjectId ? projects.filter(p => p.id === selectedProjectId) : projects).map((project) => {
                const pTasks = allItems.filter(w => w.projectId === project.id && w.type === 'task');
                const pIssues = allItems.filter(w => w.projectId === project.id && w.type === 'issue');
                return (
                  <div key={project.id} className="space-y-2">
                    <ProjectHeader
                      project={project}
                      onDeleted={() => selectedProjectId === project.id && setSelectedProjectId('')}
                    />
                    {(pTasks.length > 0 || pIssues.length > 0) ? (
                      <MacCard
                        title="간트"
                        icon={BarChart3}
                        titleExtra={<span className="text-xs text-muted-foreground tabular-nums">{pTasks.length + pIssues.length}건</span>}
                        bodyPadding="p-0"
                        className="overflow-hidden"
                      >
                        <PersonalGanttView
                          assignee=""
                          tasks={pTasks}
                          issues={pIssues}
                          dates={dates}
                          todayStr={todayStr}
                          onItemClick={setSelectedItem}
                          showAllAssignees
                        />
                      </MacCard>
                    ) : (
                      <EmptyState compact title="소속 업무가 없습니다." description="업무를 이 프로젝트에 연결하면 여기에 나타납니다." />
                    )}
                  </div>
                );
              })
            )}
            {/* 미분류 */}
            {!projectsBody && !selectedProjectId && (() => {
              const unclassified = allItems.filter(w => !w.projectId);
              if (unclassified.length === 0) return null;
              const uTasks = unclassified.filter(w => w.type === 'task');
              const uIssues = unclassified.filter(w => w.type === 'issue');
              return (
                <div className="space-y-2">
                  <MacCard
                    title="미분류"
                    titleExtra={<span className="text-xs text-muted-foreground tabular-nums">{unclassified.length}건</span>}
                    description="프로젝트에 소속되지 않은 업무"
                    bodyPadding="p-0"
                    className="overflow-hidden"
                  >
                    <PersonalGanttView
                      assignee=""
                      tasks={uTasks}
                      issues={uIssues}
                      dates={dates}
                      todayStr={todayStr}
                      onItemClick={setSelectedItem}
                      showAllAssignees
                    />
                  </MacCard>
                </div>
              );
            })()}
          </div>
        )}

        {/* ── Body ────────────────────────────────────────────────────── */}
        {pageView !== 'project' && (
        <MacCard
          bodyPadding="p-0"
          className="overflow-hidden"
          title={pageView === 'personal'
            ? (personalAssignee ? `${personalAssignee} 의 간트` : '개인별 간트')
            : `담당자 그리드 · ${dayCount}일`}
        >
        {itemsBody ? itemsBody : pageView === 'personal' ? (
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
            <EmptyState
              icon={Users}
              title="선택된 담당자가 없습니다."
              description="상단에서 담당자를 선택하면 작업 흐름이 나타납니다."
            />
          )
        ) : (
          <div className="overflow-auto">
            {filteredRows.length === 0 ? (
              <EmptyState
                icon={Users}
                title="이 기간에 해당하는 작업·이슈가 없습니다."
                description="기간을 넓히거나 다른 담당자를 선택해 보세요."
              />
            ) : (
              <table className="border-collapse min-w-full text-sm">
            <thead className="sticky top-0 z-20 bg-card">
              <tr>
                {/* Assignee header */}
                <th className="sticky left-0 z-30 bg-card border-b border-r border-border px-3 py-2 text-left w-40 min-w-[160px]">
                  <span className="text-sm font-semibold text-muted-foreground">담당자 / 역할</span>
                </th>
                {dates.map(d => {
                  const ds = fmtDate(d);
                  const isTodayCol = ds === todayStr;
                  const isWE = isWeekend(d);
                  return (
                    <th key={ds}
                      className={`border-b border-r border-border px-1 py-2 text-center font-medium transition-colors
                        ${isTodayCol ? 'bg-primary/10 text-primary' : isWE ? 'text-muted-foreground bg-secondary/30' : 'text-muted-foreground'}`}
                      style={{ minWidth: COL_W, width: COL_W }}>
                      <div className="leading-tight">
                        <div className={`text-xs font-semibold ${isTodayCol ? 'text-primary' : ''}`}>
                          {dayLabel(d)}
                        </div>
                        {isTodayCol && (
                          <div className="text-[11px] text-primary font-semibold">오늘</div>
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
                    <td className={`sticky left-0 z-10 border-b border-r border-border px-3 py-2 align-top ${rowIdx % 2 === 0 ? 'bg-background' : 'bg-secondary/10'}`}>
                      <div className="font-semibold text-foreground text-sm mb-0.5">{row.assignee}</div>
                      <div className="flex flex-wrap gap-1">
                        {row.roles.slice(0, 4).map(role => (
                          <span key={role}
                            className={`text-[11px] px-1.5 py-0.5 rounded-full ${MODULE_COLOR[role] ?? 'bg-secondary text-muted-foreground'}`}>
                            {role}
                          </span>
                        ))}
                        {row.roles.length > 4 && (
                          <span className="text-[11px] text-muted-foreground">+{row.roles.length - 4}</span>
                        )}
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">{totalItemsInRow}건</div>
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
        )}

        {/* ── Legend ──────────────────────────────────────────────────── */}
        <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap px-1">
          <span className="font-medium">범례:</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-chart-1/30 inline-block" /> 작업</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-chart-7/30 inline-block" /> 이슈</span>
          <span className="flex items-center gap-1"><CheckCircle2 className="w-3 h-3 text-muted-foreground" /> 완료/해결</span>
          <span className="flex items-center gap-1"><Clock className="w-3 h-3 text-chart-3" /> 진행중</span>
          <span className="flex items-center gap-1"><AlertCircle className="w-3 h-3 text-status-critical" /> 미해결</span>
          <span className="ml-auto text-xs">클릭 시 상세 정보</span>
        </div>
      </PageShell>

      {selectedItem && (
        <DetailModal item={selectedItem} onClose={() => setSelectedItem(null)} />
      )}
      {showNewProjectModal && (
        <ProjectFormModal onClose={() => setShowNewProjectModal(false)} />
      )}
    </div>
  );
}
