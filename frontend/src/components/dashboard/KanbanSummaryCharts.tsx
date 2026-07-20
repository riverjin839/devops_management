import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, Legend,
} from 'recharts';
import type { WorkItem } from '@/types';

// ── 색상 (D-005: 차트 토큰 체계) ─────────────────────────────────────────────
// 시리즈 구분색은 --chart-N, 의미 있는 색(완료/해결=성공, 미해결=경고)은 --status-*.
const TASK_COLORS: Record<string, string> = {
  'Backlog':        'hsl(var(--chart-8))',
  'To Do':          'hsl(var(--chart-1))',
  'In Progress':    'hsl(var(--chart-3))',
  'Review & Test':  'hsl(var(--chart-4))',
  'Done':           'hsl(var(--status-healthy))',
};

const ISSUE_COLORS: Record<string, string> = {
  '미해결': 'hsl(var(--status-warning))',
  '해결':   'hsl(var(--status-healthy))',
};

// ── 커스텀 툴팁 ───────────────────────────────────────────────────────────────
interface TooltipPayload {
  name: string;
  value: number;
  fill: string;
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: TooltipPayload[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-lg px-3 py-2 text-sm shadow-lg">
      <p className="font-semibold mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.fill }}>{p.name}: {p.value}건</p>
      ))}
    </div>
  );
}

// ── 스켈레톤 ──────────────────────────────────────────────────────────────────
function ChartSkeleton() {
  return (
    <div className="flex items-end gap-3 h-32 px-4 pb-2">
      {[60, 90, 40].map((h, i) => (
        <div key={i} className="flex-1 bg-muted/40 rounded animate-pulse" style={{ height: `${h}%` }} />
      ))}
    </div>
  );
}

// ── 메인 컴포넌트 ──────────────────────────────────────────────────────────────
interface KanbanSummaryChartsProps {
  /** 통합 work items — 컴포넌트 내부에서 type='task'/'issue' 로 분할. */
  items: WorkItem[];
  isLoading?: boolean;
  selectedClusterId?: string | null;
}

export function KanbanSummaryCharts({ items, isLoading, selectedClusterId }: KanbanSummaryChartsProps) {
  // 클러스터 필터 적용 + type 분할
  const scoped = selectedClusterId ? items.filter((w) => w.clusterId === selectedClusterId) : items;
  const filteredTasks  = scoped.filter((w) => w.type === 'task');
  const filteredIssues = scoped.filter((w) => w.type === 'issue');

  // 집계 (5컬럼 칸반 기준)
  const taskCounts = {
    'Backlog':       filteredTasks.filter((t) => (t.kanbanStatus ?? 'todo') === 'backlog').length,
    'To Do':         filteredTasks.filter((t) => (t.kanbanStatus ?? 'todo') === 'todo').length,
    'In Progress':   filteredTasks.filter((t) => (t.kanbanStatus ?? 'todo') === 'in_progress').length,
    'Review & Test': filteredTasks.filter((t) => (t.kanbanStatus ?? 'todo') === 'review_test').length,
    'Done':          filteredTasks.filter((t) => (t.kanbanStatus ?? 'todo') === 'done').length,
  };

  const issueCounts = {
    '미해결': filteredIssues.filter((i) => !i.closedAt).length,
    '해결':   filteredIssues.filter((i) => !!i.closedAt).length,
  };

  const taskData  = Object.entries(taskCounts).map(([name, value]) => ({ name, value }));
  const issueData = Object.entries(issueCounts).map(([name, value]) => ({ name, value }));

  const totalTasks  = filteredTasks.length;
  const totalIssues = filteredIssues.length;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* WorkItem 상태 분포 */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold">작업 상태 분포</h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              전체 {totalTasks}건
              {selectedClusterId && ' (선택 클러스터)'}
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {taskData.map((d) => (
              <span key={d.name} className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ background: TASK_COLORS[d.name] }} />
                <span className="text-muted-foreground">{d.name}</span>
                <span className="font-semibold">{d.value}</span>
              </span>
            ))}
          </div>
        </div>

        {isLoading ? (
          <ChartSkeleton />
        ) : totalTasks === 0 ? (
          <div className="h-32 flex items-center justify-center text-sm text-muted-foreground/50">
            데이터 없음
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={taskData} barCategoryGap="35%">
              <XAxis dataKey="name" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={24} />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: 'hsl(var(--foreground) / 0.06)' }} />
              <Bar dataKey="value" radius={[4, 4, 0, 0]} name="건수">
                {taskData.map((entry) => (
                  <Cell key={entry.name} fill={TASK_COLORS[entry.name] ?? 'hsl(var(--chart-8))'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* WorkItem 상태 분포 */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold">이슈 상태 분포</h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              전체 {totalIssues}건
              {selectedClusterId && ' (선택 클러스터)'}
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs">
            {issueData.map((d) => (
              <span key={d.name} className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ background: ISSUE_COLORS[d.name] }} />
                <span className="text-muted-foreground">{d.name}</span>
                <span className="font-semibold">{d.value}</span>
              </span>
            ))}
          </div>
        </div>

        {isLoading ? (
          <ChartSkeleton />
        ) : totalIssues === 0 ? (
          <div className="h-32 flex items-center justify-center text-sm text-muted-foreground/50">
            데이터 없음
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={issueData} barCategoryGap="50%">
              <XAxis dataKey="name" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={24} />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: 'hsl(var(--foreground) / 0.06)' }} />
              <Legend wrapperStyle={{ display: 'none' }} />
              <Bar dataKey="value" radius={[4, 4, 0, 0]} name="건수">
                {issueData.map((entry) => (
                  <Cell key={entry.name} fill={ISSUE_COLORS[entry.name] ?? 'hsl(var(--chart-8))'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
