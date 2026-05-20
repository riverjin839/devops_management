// frontend/src/components/batch-jobs/BatchJobTable.tsx
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { BatchJob } from '@/services/api';
import type { Cluster } from '@/types';
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
  label, sortKey, current, onChange, width,
}: {
  label: string; sortKey: SortKey; current: SortState; onChange: (s: SortState) => void; width?: string;
}) {
  const active = current.key === sortKey;
  const Icon = !active ? ArrowUpDown : current.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-secondary/40"
      style={width ? { width } : undefined}
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
}: BatchJobTableProps) {
  const clusterMap = clusters
    ? Object.fromEntries(clusters.map((c) => [c.id, c]))
    : null;

  const sorted = sortJobs(jobs, sort);

  if (sorted.length === 0) {
    return (
      <div className="text-center text-sm text-muted-foreground py-10">
        {emptyMessage ?? '표시할 잡이 없습니다.'}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-border">
            <SortHeader label="상태" sortKey="status" current={sort} onChange={onSortChange} width="100px" />
            <SortHeader label="잡" sortKey="name" current={sort} onChange={onSortChange} />
            {clusterMap && (
              <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-secondary/40" style={{ width: '110px' }}>
                클러스터
              </th>
            )}
            <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-secondary/40" style={{ width: '120px' }}>
              타입
            </th>
            <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground bg-secondary/40" style={{ width: '110px' }}>
              cron
            </th>
            <SortHeader label="최근 실행" sortKey="lastRunAt" current={sort} onChange={onSortChange} width="120px" />
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
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
