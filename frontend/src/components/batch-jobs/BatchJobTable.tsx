// frontend/src/components/batch-jobs/BatchJobTable.tsx
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { BatchJob } from '@/services/api';
import type { Cluster } from '@/types';
import { TooltipProvider } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/common/EmptyState';
import { RunLogPanel } from '@/components/common';
import { useRunLog } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { BatchJobRow } from './BatchJobRow';
import { type SortKey, type SortState } from './types';

interface BatchJobTableProps {
  jobs: BatchJob[];
  /** clusters 가 전달되면 클러스터 컬럼이 렌더된다 ('전체' 모드). */
  clusters?: Cluster[];
  selectedJobId: string | null;
  sort: SortState;
  onSortChange: (s: SortState) => void;
  onSelectJob: (job: BatchJob) => void;
  /** 빈 테이블 메시지. */
  emptyMessage?: string;
  /** 일괄 선택 — 제공되면 체크박스 컬럼이 렌더된다. */
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onToggleAll?: (ids: string[]) => void;
}

const STATUS_RANK: Record<string, number> = {
  error: 0,
  timeout: 1,
  auth_error: 2,
  connect_error: 3,
  running: 4,
  ok: 5,
  unknown: 6,
};

function sortJobs(jobs: BatchJob[], { key, dir }: SortState): BatchJob[] {
  const arr = [...jobs];
  arr.sort((a, b) => {
    let cmp = 0;
    if (key === 'status') {
      cmp = (STATUS_RANK[a.lastStatus] ?? 99) - (STATUS_RANK[b.lastStatus] ?? 99);
    } else if (key === 'name') {
      cmp = a.name.localeCompare(b.name);
    } else if (key === 'lastRunAt') {
      const av = a.lastRunAt ?? '';
      const bv = b.lastRunAt ?? '';
      cmp = av < bv ? -1 : av > bv ? 1 : 0;
    }
    return dir === 'asc' ? cmp : -cmp;
  });
  return arr;
}

function SortHeader({
  label, sortKey, current, onChange, widthClass = '',
}: {
  label: string; sortKey: SortKey; current: SortState; onChange: (s: SortState) => void;
  /** 열 폭 Tailwind 클래스(리터럴로 넘긴다 — 예: `w-[100px]`). 인라인 style 금지(D-149). */
  widthClass?: string;
}) {
  const active = current.key === sortKey;
  const Icon = !active ? ArrowUpDown : current.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      className={`px-3 py-2 text-left text-xs font-semibold text-muted-foreground bg-secondary/40 ${widthClass}`}
      aria-sort={active ? (current.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onChange({ key: sortKey, dir: active && current.dir === 'desc' ? 'asc' : 'desc' })}
        className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
      >
        {label}
        <Icon className="w-3 h-3" />
      </button>
    </th>
  );
}

export function BatchJobTable({
  jobs, clusters, selectedJobId, sort, onSortChange, onSelectJob, emptyMessage,
  selectedIds, onToggleSelect, onToggleAll,
}: BatchJobTableProps) {
  const clusterMap = clusters
    ? Object.fromEntries(clusters.map((c) => [c.id, c]))
    : null;

  // 행의 빠른 실행(▶) 로그 — 표 바로 위에 패널을 두고 행들이 공유한다(마지막 실행 1건).
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('batch-jobs-quick-run');

  const sorted = sortJobs(jobs, sort);
  const selectable = !!onToggleSelect && !!selectedIds;
  const allSelected = selectable && sorted.length > 0 && sorted.every((j) => selectedIds?.has(j.id) ?? false);

  if (sorted.length === 0) {
    return (
      <EmptyState compact title={emptyMessage ?? '표시할 잡이 없습니다.'}
        description={emptyMessage ? undefined : '상단의 잡 추가로 배치잡을 등록하면 여기에 표시됩니다.'} />
    );
  }

  return (
    <TooltipProvider delay={150}>
      <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
      <div className={`overflow-x-auto${runLog.running || runLog.lines.length > 0 ? ' mt-2' : ''}`}>
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-border">
              {selectable && (
                <th className="w-9 px-3 py-2 bg-secondary/40">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() => onToggleAll?.(sorted.map((j) => j.id))}
                    aria-label="전체 선택"
                    className="cursor-pointer"
                  />
                </th>
              )}
              <SortHeader label="상태" sortKey="status" current={sort} onChange={onSortChange} widthClass="w-[100px]" />
              <SortHeader label="잡" sortKey="name" current={sort} onChange={onSortChange} />
              {clusterMap && (
                <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground bg-secondary/40 w-[110px]">
                  클러스터
                </th>
              )}
              <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground bg-secondary/40 w-[120px]">
                타입
              </th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground bg-secondary/40 w-[110px]">
                cron
              </th>
              <SortHeader label="최근 실행" sortKey="lastRunAt" current={sort} onChange={onSortChange} widthClass="w-[120px]" />
              <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground bg-secondary/40 w-[60px]">
                실행
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((job) => (
              <BatchJobRow
                key={job.id}
                job={job}
                cluster={clusterMap ? clusterMap[job.clusterId] : undefined}
                selected={selectedJobId === job.id}
                onClick={() => onSelectJob(job)}
                checkbox={selectable}
                checked={selectedIds?.has(job.id) ?? false}
                onToggleSelect={onToggleSelect}
                runLog={runLog}
              />
            ))}
          </tbody>
        </table>
      </div>
    </TooltipProvider>
  );
}
