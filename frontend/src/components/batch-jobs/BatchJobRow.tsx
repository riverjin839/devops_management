// frontend/src/components/batch-jobs/BatchJobRow.tsx
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Play, Square } from 'lucide-react';
import type { BatchJob } from '@/services/api';
import type { Cluster } from '@/types';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ConfirmDialog, useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { useRunBatchJob, useStopBatchJob } from '@/hooks/useBatchJobs';
import { StatusPill } from './StatusPill';
import { CronBadge } from './CronBadge';
import { cronHealth, type CronHealth } from './filters';

// cron 상태 → 행 좌측 보더/hover 배경 색 — 표에서 스크롤만 해도 정상(초록)/
// 비정상(레드)/중지(회색)/실행 중(블루)이 판독되게 한다. 선택 시엔 primary 유지.
const ROW_BORDER: Record<CronHealth, string> = {
  ok: 'border-l-emerald-500/60',
  failed: 'border-l-red-500/70',
  running: 'border-l-blue-500/70',
  stopped: 'border-l-slate-400/50',
};
const ROW_HOVER: Record<CronHealth, string> = {
  ok: 'hover:bg-emerald-500/5',
  failed: 'hover:bg-red-500/5',
  running: 'hover:bg-blue-500/5',
  stopped: 'hover:bg-secondary/50',
};

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
  const isRunning = job.lastStatus === 'running';
  // 저장된 자격증명(or non-SSH)이 있어야 자격증명 입력 없이 즉시 실행 가능.
  const canQuickRun = job.requiresSsh === false || job.hasSavedPassword || job.hasSavedPrivateKey;

  const toast = useToast();
  const runMut = useRunBatchJob();
  const stopMut = useStopBatchJob();
  const [confirmStop, setConfirmStop] = useState(false);

  const quickRun = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const { data } = await runMut.mutateAsync({ id: job.id, payload: {} });
      if (data.status === 'ok') {
        toast.success(`${job.name} 실행 완료`, `${data.durationMs}ms`);
      } else {
        toast.error(`${job.name} 실행 실패`, data.error ?? data.status);
      }
    } catch (err) {
      toast.error('즉시 실행 실패', formatApiError(err));
    }
  };

  const doStop = async () => {
    setConfirmStop(false);
    try {
      const { data } = await stopMut.mutateAsync(job.id);
      toast[data.interrupted ? 'success' : 'warning']('중지 요청', data.message);
    } catch (err) {
      toast.error('중지 실패', formatApiError(err));
    }
  };

  const health = cronHealth(job);

  return (
    <>
    <tr
      onClick={onClick}
      className={`cursor-pointer transition-colors border-l-[3px] ${
        selected
          ? 'bg-primary/5 border-l-primary'
          : `${ROW_BORDER[health]} ${ROW_HOVER[health]}`
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
        <CronBadge job={job} />
      </td>
      <td className="px-3 py-2 align-top text-xs text-muted-foreground font-mono whitespace-nowrap">
        {formatShortDate(job.lastRunAt)}
      </td>
      <td className="px-3 py-2 align-top" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1">
          {isRunning ? (
            <Tooltip>
              <TooltipTrigger
                type="button"
                onClick={() => setConfirmStop(true)}
                disabled={stopMut.isPending}
                aria-label={`${job.name} 중지`}
                className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-red-500/30 bg-red-500/10 text-red-600 hover:bg-red-500/20 disabled:opacity-50"
              >
                <Square className="w-3 h-3" fill="currentColor" />
              </TooltipTrigger>
              <TooltipContent side="left">
                <p>지금 중지 — 갑자기 부하/문제가 생겼을 때 실행 중인 프로세스를 강제 종료합니다.</p>
              </TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger
                type="button"
                onClick={canQuickRun ? quickRun : undefined}
                disabled={!canQuickRun || runMut.isPending}
                aria-label={`${job.name} 즉시 실행`}
                className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-border bg-secondary hover:bg-primary/10 hover:text-primary hover:border-primary/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Play className="w-3 h-3" />
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-[260px]">
                <div className="space-y-1">
                  <p className="font-medium">{job.name}</p>
                  <p className="text-muted-foreground font-mono">{job.jobType}</p>
                  {job.defaultHost && <p className="text-muted-foreground">호스트: {job.defaultHost}</p>}
                  <p className="text-muted-foreground">최근 실행: {formatShortDate(job.lastRunAt)} ({job.lastStatus})</p>
                  {!canQuickRun && (
                    <p className="text-amber-500">
                      저장된 자격증명이 없어 즉시 실행할 수 없습니다 — 행을 열어 자격증명을 등록하세요.
                    </p>
                  )}
                </div>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </td>
    </tr>
    {/* <tr> 은 <div> 자식을 가질 수 없으므로(HTML 파서가 테이블 밖으로 튕겨냄)
        확인 다이얼로그는 포탈로 body 에 직접 렌더링한다. */}
    {confirmStop && createPortal(
      <ConfirmDialog
        open
        title="배치 잡 중지"
        description={`"${job.name}" 실행 중인 작업을 지금 강제 중지할까요? 원격 프로세스가 중간에 종료돼 부분 작업 상태가 남을 수 있습니다.`}
        confirmLabel="중지"
        danger
        onConfirm={doStop}
        onCancel={() => setConfirmStop(false)}
      />,
      document.body,
    )}
    </>
  );
}
