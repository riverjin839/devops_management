import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  CheckCircle2,
  ShieldAlert,
  Activity,
  Server,
  ArrowRight,
  CalendarClock,
} from 'lucide-react';
import { useWorkItems } from '@/hooks/useWorkItems';
import { useLogs } from '@/hooks/useCluster';
import { stripHtml } from '@/lib/utils';
import { WorkItem, CheckLog } from '@/types';

interface YesterdayChangesProps {
  selectedClusterId: string | null;
}

interface Bucket {
  clusterName: string;
  tasks: WorkItem[];
  issues: WorkItem[];
  alerts: CheckLog[];
}

function getDateBoundaries() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startStr = start.toISOString().slice(0, 10);
  return {
    startMs: start.getTime(),
    endMs: end.getTime(),
    startStr,
  };
}

function isWithinYesterday(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const t = new Date(iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z').getTime();
  if (Number.isNaN(t)) return false;
  const { startMs, endMs } = getDateBoundaries();
  return t >= startMs && t < endMs;
}

export function YesterdayChanges({ selectedClusterId }: YesterdayChangesProps) {
  const { data: workItemsData } = useWorkItems();
  const { data: logsData } = useLogs();
  const { startStr } = getDateBoundaries();

  const buckets = useMemo<Bucket[]>(() => {
    const allItems = workItemsData?.data ?? [];
    const logs = logsData?.data ?? [];

    const completedTasks = allItems.filter(
      (w) =>
        w.type === 'task' &&
        w.kanbanStatus === 'done' &&
        isWithinYesterday(w.closedAt) &&
        (!selectedClusterId || w.clusterId === selectedClusterId),
    );
    const resolvedIssues = allItems.filter(
      (w) =>
        w.type === 'issue' &&
        w.closedAt?.slice(0, 10) === startStr &&
        (!selectedClusterId || w.clusterId === selectedClusterId),
    );
    const alertLogs = logs.filter(
      (l) =>
        (l.status === 'warning' || l.status === 'critical') &&
        isWithinYesterday(l.checkedAt) &&
        (!selectedClusterId || l.clusterId === selectedClusterId),
    );

    const map = new Map<string, Bucket>();
    const ensure = (clusterName: string): Bucket => {
      const key = clusterName || '미지정';
      let bucket = map.get(key);
      if (!bucket) {
        bucket = { clusterName: key, tasks: [], issues: [], alerts: [] };
        map.set(key, bucket);
      }
      return bucket;
    };
    for (const t of completedTasks) ensure(t.clusterName ?? '').tasks.push(t);
    for (const i of resolvedIssues) ensure(i.clusterName ?? '').issues.push(i);
    for (const l of alertLogs) ensure(l.clusterName ?? '').alerts.push(l);
    return Array.from(map.values()).sort((a, b) => {
      const aTotal = a.tasks.length + a.issues.length + a.alerts.length;
      const bTotal = b.tasks.length + b.issues.length + b.alerts.length;
      return bTotal - aTotal;
    });
  }, [workItemsData, logsData, selectedClusterId, startStr]);

  const totals = useMemo(() => {
    let tasks = 0;
    let issues = 0;
    let alerts = 0;
    for (const b of buckets) {
      tasks += b.tasks.length;
      issues += b.issues.length;
      alerts += b.alerts.length;
    }
    return { tasks, issues, alerts };
  }, [buckets]);

  const yLabel = (() => {
    const d = new Date(startStr + 'T00:00:00');
    const days = ['일', '월', '화', '수', '목', '금', '토'];
    return `${d.getMonth() + 1}/${d.getDate()} (${days[d.getDay()]})`;
  })();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CalendarClock className="w-4 h-4 text-primary" />
          <span>어제 ({yLabel})</span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-1 text-emerald-500 dark:text-emerald-400">
            <CheckCircle2 className="w-3.5 h-3.5" /> 완료 {totals.tasks}
          </span>
          <span className="inline-flex items-center gap-1 text-blue-500 dark:text-blue-400">
            <ShieldAlert className="w-3.5 h-3.5" /> 해결 {totals.issues}
          </span>
          <span className="inline-flex items-center gap-1 text-amber-500 dark:text-amber-400">
            <Activity className="w-3.5 h-3.5" /> 알림 {totals.alerts}
          </span>
        </div>
      </div>

      {buckets.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 py-10 text-center text-sm text-muted-foreground">
          어제 기록된 변경 사항이 없습니다.
        </div>
      ) : (
        <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
          {buckets.map((b) => (
            <div
              key={b.clusterName}
              className="rounded-xl border border-border/70 bg-card/60 p-3"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Server className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="text-sm font-semibold truncate">{b.clusterName}</span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  {b.tasks.length > 0 && <span>완료 {b.tasks.length}</span>}
                  {b.issues.length > 0 && <span>해결 {b.issues.length}</span>}
                  {b.alerts.length > 0 && <span>알림 {b.alerts.length}</span>}
                </div>
              </div>

              <ul className="space-y-1.5">
                {b.tasks.slice(0, 5).map((t) => (
                  <li key={`t-${t.id}`} className="flex items-start gap-2 text-xs">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" />
                    <span className="text-muted-foreground truncate flex-1">
                      <span className="text-foreground font-medium">{t.assignee || '미지정'}</span>
                      <span className="mx-1">·</span>
                      {stripHtml(t.content) || t.category}
                    </span>
                  </li>
                ))}
                {b.issues.slice(0, 5).map((i) => (
                  <li key={`i-${i.id}`} className="flex items-start gap-2 text-xs">
                    <ShieldAlert className="w-3.5 h-3.5 text-blue-500 flex-shrink-0 mt-0.5" />
                    <span className="text-muted-foreground truncate flex-1">
                      <span className="text-foreground font-medium">{i.assignee || '미지정'}</span>
                      <span className="mx-1">·</span>
                      {stripHtml(i.content) || i.category}
                    </span>
                  </li>
                ))}
                {b.alerts.slice(0, 3).map((l) => (
                  <li key={`l-${l.id}`} className="flex items-start gap-2 text-xs">
                    <Activity
                      className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${
                        l.status === 'critical' ? 'text-red-500' : 'text-amber-500'
                      }`}
                    />
                    <span className="text-muted-foreground truncate flex-1">{l.message}</span>
                  </li>
                ))}
              </ul>

              {b.tasks.length + b.issues.length + b.alerts.length >
                Math.min(b.tasks.length, 5) +
                  Math.min(b.issues.length, 5) +
                  Math.min(b.alerts.length, 3) && (
                <p className="text-[11px] text-muted-foreground mt-2">…더 보기</p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-end gap-3 text-[11px]">
        <Link
          to="/tasks-mgmt"
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-primary transition-colors"
        >
          업무 관리 게시판 <ArrowRight className="w-3 h-3" />
        </Link>
      </div>
    </div>
  );
}
