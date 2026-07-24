// frontend/src/components/batch-jobs/BatchJobRow.tsx
import type { BatchJob } from '@/services/api';
import type { Cluster } from '@/types';
import { StatusPill } from './StatusPill';

interface BatchJobRowProps {
  job: BatchJob;
  cluster?: Cluster; // 전체 모드에서만 전달 — 단일 모드에서는 undefined
  selected: boolean;
  onClick: () => void;
  /** 일괄 선택 체크박스 표시 여부 */
  checkbox?: boolean;
  checked?: boolean;
  onToggleSelect?: (id: string) => void;
}

function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z');
  if (isNaN(d.getTime())) return iso.replace('T', ' ').slice(5, 16);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function BatchJobRow({ job, cluster, selected, onClick, checkbox, checked, onToggleSelect }: BatchJobRowProps) {
  const hasMissingCreds =
    job.requiresSsh !== false && !!job.cron && !job.hasSavedPassword && !job.hasSavedPrivateKey;
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
      {checkbox && (
        <td className="px-3 py-2 align-top" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={!!checked}
            onChange={() => onToggleSelect?.(job.id)}
            aria-label={`${job.name} 선택`}
            className="cursor-pointer"
          />
        </td>
      )}
      <td className="px-3 py-2 align-top">
        <StatusPill status={job.lastStatus} />
      </td>
      <td className="px-3 py-2 align-top">
        <div className="font-semibold text-sm text-foreground truncate" title={job.name}>
          {job.name}
        </div>
        {!job.enabled && (
          <span className="inline-block mt-0.5 text-xs px-1.5 rounded bg-muted text-muted-foreground">
            off
          </span>
        )}
        {hasMissingCreds && (
          <div className="mt-0.5">
            <span className="text-xs text-amber-600 bg-amber-500/10 px-1.5 py-0.5 rounded">
              ⚠ 자격증명 없음
            </span>
          </div>
        )}
      </td>
      {showCluster && (
        <td className="px-3 py-2 align-top">
          <span className="text-sm px-2 py-0.5 rounded bg-secondary text-secondary-foreground">
            {cluster?.name}
          </span>
        </td>
      )}
      <td className="px-3 py-2 align-top">
        <code className="text-xs text-muted-foreground font-mono">{job.jobType}</code>
      </td>
      <td className="px-3 py-2 align-top">
        {job.cron ? (
          <>
            <code className="text-xs text-muted-foreground font-mono">{job.cron}</code>
            {job.lastScheduleNote && (
              <div
                className="text-xs text-muted-foreground/80 mt-0.5"
                title={job.lastScheduleCheckAt ? `스케줄러 평가: ${formatShortDate(job.lastScheduleCheckAt)}` : undefined}
              >
                {job.lastScheduleNote}
              </div>
            )}
          </>
        ) : (
          <span className="text-xs text-muted-foreground/60">—</span>
        )}
      </td>
      <td className="px-3 py-2 align-top text-xs text-muted-foreground font-mono whitespace-nowrap">
        {formatShortDate(job.lastRunAt)}
      </td>
    </tr>
  );
}
