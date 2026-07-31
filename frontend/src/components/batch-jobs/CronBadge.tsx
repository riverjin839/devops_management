// frontend/src/components/batch-jobs/CronBadge.tsx
// cron 등록 상태를 한눈에 판독하기 어렵다는 피드백 반영 — 색상 코드 배지 +
// hover 시 cron 식/스케줄러 평가 결과/자격증명 상태를 상세히 보여주는 툴팁.
import { AlertTriangle, CheckCircle2, Clock, PowerOff } from 'lucide-react';
import type { BatchJob } from '@/services/api';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type Tone = 'ok' | 'waiting' | 'error' | 'off';

const TONE_META: Record<Tone, { cls: string; Icon: typeof Clock }> = {
  ok: { cls: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30', Icon: CheckCircle2 },
  waiting: { cls: 'bg-sky-500/10 text-sky-600 border-sky-500/30', Icon: Clock },
  error: { cls: 'bg-red-500/10 text-red-600 border-red-500/30', Icon: AlertTriangle },
  off: { cls: 'bg-muted text-muted-foreground border-border', Icon: PowerOff },
};

function classify(job: BatchJob): { tone: Tone; label: string } {
  if (!job.enabled) return { tone: 'off', label: '꺼짐' };
  const missingCreds = job.requiresSsh !== false && !job.hasSavedPassword && !job.hasSavedPrivateKey;
  if (missingCreds) return { tone: 'error', label: '자격증명 없음' };
  const note = job.lastScheduleNote ?? '';
  if (/오류/.test(note)) return { tone: 'error', label: '평가 오류' };
  if (/큐잉됨/.test(note)) return { tone: 'ok', label: '실행됨' };
  if (/대기/.test(note)) return { tone: 'waiting', label: '대기 중' };
  return { tone: 'waiting', label: '등록됨' };
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z');
  if (isNaN(d.getTime())) return iso.replace('T', ' ').slice(0, 16);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CronBadge({ job }: { job: BatchJob }) {
  if (!job.cron) return <span className="text-xs text-muted-foreground/60">—</span>;

  const { tone, label } = classify(job);
  const { cls, Icon } = TONE_META[tone];

  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        onClick={(e) => e.stopPropagation()}
        className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs font-medium ${cls}`}
      >
        <Icon className="w-3 h-3" />
        {label}
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-[280px]">
        <div className="space-y-1">
          <p className="font-mono font-medium">{job.cron}</p>
          <p className="text-muted-foreground">
            {job.enabled ? '활성화됨' : '비활성화됨(수동 실행만 가능)'}
          </p>
          {job.requiresSsh !== false && (
            <p className="text-muted-foreground">
              저장 자격증명: {job.hasSavedPassword || job.hasSavedPrivateKey
                ? [job.hasSavedPassword && '비밀번호', job.hasSavedPrivateKey && '개인키'].filter(Boolean).join(' / ')
                : '없음 (무인 실행 불가)'}
            </p>
          )}
          {job.lastScheduleNote && (
            <p className="text-muted-foreground">
              최근 평가: {job.lastScheduleNote}
              {job.lastScheduleCheckAt && ` (${formatDateTime(job.lastScheduleCheckAt)})`}
            </p>
          )}
          <p className="text-muted-foreground">최근 실행: {formatDateTime(job.lastRunAt)}</p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
