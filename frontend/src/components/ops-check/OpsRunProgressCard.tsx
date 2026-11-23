import { useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, Loader2, X, Ban } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { StatusBadge, statusToVariant } from '@/components/common/StatusBadge';
import { LogViewer } from '@/components/common/LogViewer';
import { useToast } from '@/components/common';
import { formatApiError, parseUTC } from '@/lib/utils';
import { useOpsRun, useOpsRunItems, useCancelOpsRun } from '@/hooks/useOpsCheck';
import { useLogPref } from '@/hooks/useLogPref';
import { useCanOperate } from '@/hooks/useCanOperate';
import type { OpsCheckRunItem } from '@/types';
import { OpsRunItemDetailModal } from './OpsRunItemDetailModal';

interface Props {
  runId: string;
  clusterId: string | undefined;
  clusterName?: string;
  title?: string;
  onClose: () => void;
  /** 헤더 actions 앞에 붙는 추가 요소(예: "점검 항목에서 보기" 링크). */
  extraActions?: ReactNode;
}

/**
 * 운영 점검 실행 묶음(ops-check run) 1건의 진행 카드 — 총계·항목별 상태·실시간 로그(「로그 보기」)·취소·항목 상세.
 * 허브 개요의 「전체 점검」과 점검 ▸ 점검 항목(`ClusterOpsCheckPanel`)이 공유한다. 같은 run 을 두 곳에서 열어도
 * TanStack Query 키가 같아 폴링은 한 번만 나간다.
 */
export function OpsRunProgressCard({ runId, clusterId, clusterName, title = '실행 진행', onClose, extraActions }: Props) {
  const toast = useToast();
  const { canOperate, withHint } = useCanOperate(clusterId);
  // "로그 보기" — 항목별 실시간 로그를 펼칠지(화면별 기억, 기본 펼침).
  const [showRunLog, setShowRunLog] = useLogPref('ops-check-run');
  const [detail, setDetail] = useState<OpsCheckRunItem | null>(null);
  const cancelRun = useCancelOpsRun();

  const { data: run } = useOpsRun(runId);
  const isRunning = !!run && (run.status === 'pending' || run.status === 'running');
  const { data: runItems = [] } = useOpsRunItems(runId, isRunning);

  // 항목 상태를 시간순 실행 로그로 — 2초 폴링마다 다시 그려 지금 무엇을 돌고 있는지 보인다.
  const runLogText = useMemo(() => {
    if (!run) return '';
    const t = (iso?: string | null) => (iso ? parseUTC(iso).toLocaleTimeString('ko-KR') : '--:--:--');
    const lines = [`[${t(run.createdAt)}] 실행 묶음 등록 — ${clusterName ?? '클러스터'} · 항목 ${run.total}개${run.triggeredBy ? ` · 요청자 ${run.triggeredBy}` : ''}`];
    for (const it of runItems) {
      const name = it.name || it.checkType;
      if (it.status === 'queued') lines.push(`[--:--:--] 대기 — ${name}${it.message ? ` · ${it.message}` : ''}`);
      else if (it.status === 'running') lines.push(`[${t(it.startedAt)}] 실행 중 — ${name}`);
      else if (it.status === 'cancelled') lines.push(`[${t(it.finishedAt)}] 취소 — ${name}${it.message ? ` · ${it.message}` : ''}`);
      else {
        const verdict = it.status === 'error' ? '실패' : `판정 ${it.resultStatus ?? '-'}`;
        lines.push(`[${t(it.finishedAt)}] ${it.status === 'error' ? 'ERROR' : '완료'} — ${name} · ${verdict}${it.durationMs ? ` · ${it.durationMs}ms` : ''}${it.message ? ` · ${it.message.split('\n')[0].slice(0, 200)}` : ''}`);
      }
    }
    if (run.status === 'cancelled') lines.push(`[${t(run.finishedAt)}] 실행 묶음 취소됨 — 남은 항목을 건너뛰었다`);
    else if (run.status === 'done') lines.push(`[${t(run.finishedAt)}] 실행 묶음 완료 — 정상 ${run.okCount} · 경고 ${run.warnCount} · 위험 ${run.critCount} · 실패 ${run.errorCount}`);
    return lines.join('\n');
  }, [run, runItems, clusterName]);

  const doCancel = () => {
    cancelRun.mutate(runId, {
      onSuccess: () => toast.info('실행을 취소했습니다', '실행 중인 항목이 끝나면 멈추고, 남은 항목은 건너뜁니다.'),
      onError: (e) => toast.error('취소 실패', formatApiError(e)),
    });
  };

  if (!run) return null;

  return (
    <>
      <MacCard
        title={title}
        titleExtra={
          <span className="flex items-center gap-2 text-sm">
            {isRunning ? <Loader2 className="w-4 h-4 animate-spin text-primary" /> : <CheckCircle2 className="w-4 h-4 text-muted-foreground" />}
            <span className="font-medium">{isRunning ? '실행 중…' : run.status === 'cancelled' ? '취소됨' : '완료'}</span>
            <span className="text-sm text-muted-foreground tabular-nums">
              총 {run.total} · 정상 {run.okCount} · 경고 {run.warnCount} · 위험 {run.critCount} · 실패 {run.errorCount}
            </span>
          </span>
        }
        actions={
          <span className="flex items-center gap-2">
            {extraActions}
            <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={showRunLog} onChange={(e) => setShowRunLog(e.target.checked)} />
              로그 보기
            </label>
            {isRunning && (
              <button
                type="button"
                onClick={doCancel}
                disabled={!canOperate || cancelRun.isPending}
                title={withHint('남은 점검 취소')}
                className="inline-flex items-center gap-1 rounded-xl border border-border px-2 py-1 text-xs hover:bg-secondary disabled:opacity-40"
              >
                {cancelRun.isPending ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Ban className="w-3 h-3" aria-hidden="true" />}
                취소
              </button>
            )}
            <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground" title="닫기" aria-label="닫기">
              <X className="w-4 h-4" />
            </button>
          </span>
        }
      >
        {showRunLog && runLogText && (
          <div className="mb-3">
            <LogViewer text={runLogText} maxHeight="max-h-56" />
          </div>
        )}
        <div className="divide-y divide-border/50">
          {runItems.map((it) => (
            <button
              type="button"
              key={it.id}
              onClick={() => (it.status === 'done' || it.status === 'error') && setDetail(it)}
              className="w-full flex items-center gap-3 py-2 text-left hover:bg-secondary/20 px-1">
              <span className="w-32 text-sm truncate">{it.name || it.checkType}</span>
              {it.status === 'done' ? (
                <StatusBadge variant={statusToVariant(it.resultStatus)} />
              ) : it.status === 'error' ? (
                <StatusBadge variant="critical" label="실패" />
              ) : it.status === 'cancelled' ? (
                <span className="text-xs text-muted-foreground">취소</span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin" /> {it.status === 'running' ? '실행중' : '대기'}
                </span>
              )}
              <span className="flex-1 text-sm text-muted-foreground truncate">{it.message}</span>
              {it.durationMs > 0 && <span className="text-xs text-muted-foreground font-mono">{it.durationMs}ms</span>}
            </button>
          ))}
        </div>
      </MacCard>
      <OpsRunItemDetailModal item={detail} onClose={() => setDetail(null)} />
    </>
  );
}
