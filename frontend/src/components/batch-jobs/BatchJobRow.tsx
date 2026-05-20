// frontend/src/components/batch-jobs/BatchJobRow.tsx
import type { BatchJob } from '@/services/api';
import type { Cluster } from '@/types';
import { StatusPill } from './StatusPill';

interface BatchJobRowProps {
  job: BatchJob;
  cluster?: Cluster; // 전체 모드에서만 전달 — 단일 모드에서는 undefined
  selected: boolean;
  onClick: () => void;
}

function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(5, 16); // MM-DD HH:mm
}

export function BatchJobRow({ job, cluster, selected, onClick }: BatchJobRowProps) {
  const hasMissingCreds = !!job.cron && !job.hasSavedPassword && !job.hasSavedPrivateKey;
  const showCluster = !!cluster;

  return (
    <tr
      onClick={onClick}
      className={`cursor-pointer transition-colors ${
        selected
          ? 'bg-primary/5 border-l-[3px] border-l-primary'
          : 'hover:bg-secondary/50 border-l-[3px] border-l-transparent'
      }`}
    >
      <td className="px-3 py-2 align-top">
        <StatusPill status={job.lastStatus} />
      </td>
      <td className="px-3 py-2 align-top">
        <div className="font-semibold text-sm text-foreground truncate" title={job.name}>
          {job.name}
        </div>
        {!job.enabled && (
          <span className="inline-block mt-0.5 text-[10px] px-1.5 rounded bg-muted text-muted-foreground">
            off
          </span>
        )}
        {hasMissingCreds && (
          <div className="mt-0.5">
            <span className="text-[10px] text-amber-600 bg-amber-500/10 px-1.5 py-0.5 rounded">
              ⚠ 자격증명 없음
            </span>
          </div>
        )}
      </td>
      {showCluster && (
        <td className="px-3 py-2 align-top">
          <span className="text-xs px-2 py-0.5 rounded bg-secondary text-secondary-foreground">
            {cluster?.name}
          </span>
        </td>
      )}
      <td className="px-3 py-2 align-top">
        <code className="text-[11px] text-muted-foreground font-mono">{job.jobType}</code>
      </td>
      <td className="px-3 py-2 align-top">
        {job.cron ? (
          <code className="text-[11px] text-muted-foreground font-mono">{job.cron}</code>
        ) : (
          <span className="text-[11px] text-muted-foreground/60">—</span>
        )}
      </td>
      <td className="px-3 py-2 align-top text-[11px] text-muted-foreground font-mono whitespace-nowrap">
        {formatShortDate(job.lastRunAt)}
      </td>
    </tr>
  );
}
