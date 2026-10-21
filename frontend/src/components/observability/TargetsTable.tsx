import { useId, useState } from 'react';
import type { PromTarget } from '@/types';
import {
  ExpandButton, HealthIcon, INCOMPLETE_HINT, LabelTable, ROW, TARGET_HEALTH_LABEL, TD, TH,
  formatDuration, formatTime, labelsSummary, tableStatus,
  type TableStateProps,
} from './shared';

const COLS = 7;

/** Prometheus 스크레이프 대상 dense 테이블 — 어떤 exporter 가 안 걷히는지 즉시 보이게. */
export function TargetsTable({
  rows, isLoading, error, onRetry, offline, clusterId, incomplete, emptyMessage,
}: TableStateProps & { rows: PromTarget[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const baseId = useId();

  const status = tableStatus({
    colSpan: COLS,
    isLoading,
    error,
    onRetry,
    offline,
    clusterId,
    isEmpty: rows.length === 0,
    emptyTitle: emptyMessage ?? '스크레이프 대상이 없습니다',
    emptyDescription: emptyMessage
      ? '상태 필터를 바꾸세요.'
      : (incomplete ? INCOMPLETE_HINT : 'ServiceMonitor·PodMonitor 가 Prometheus 에 선택됐는지 확인하세요.'),
    errorTitle: '스크레이프 대상을 불러오지 못했습니다',
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/20">
          <tr>
            <th className={`${TH} w-24`}>상태</th>
            <th className={`${TH} w-56`}>작업(job)</th>
            <th className={`${TH} w-56`}>인스턴스</th>
            <th className={`${TH} w-32`}>최근 수집</th>
            <th className={`${TH} w-20 text-right`}>소요</th>
            <th className={TH}>오류</th>
            <th className={TH}>라벨</th>
          </tr>
        </thead>
        <tbody>
          {status ?? rows.map((target, idx) => {
            const rowKey = `${target.job}/${target.instance}/${idx}`;
            const isOpen = expanded === rowKey;
            const detailId = `${baseId}-${idx}`;
            const toggle = () => setExpanded(isOpen ? null : rowKey);
            const up = target.health === 'up';
            return [
              <tr key={rowKey} className={`${ROW} cursor-pointer`} onClick={toggle}>
                <td className={TD}>
                  <span className="inline-flex items-center gap-1.5 text-xs" title={target.health}>
                    <HealthIcon healthy={up} />
                    <span className={up ? 'text-muted-foreground' : 'text-status-critical'}>
                      {TARGET_HEALTH_LABEL[target.health] ?? target.health}
                    </span>
                  </span>
                </td>
                <td className={`${TD} font-medium max-w-[14rem]`}>
                  <ExpandButton open={isOpen} controls={detailId} onToggle={toggle}>
                    {target.job}
                  </ExpandButton>
                </td>
                <td className={`${TD} font-mono text-xs truncate max-w-[14rem]`}>{target.instance}</td>
                <td className={`${TD} text-xs text-muted-foreground whitespace-nowrap`}>
                  {formatTime(target.lastScrape)}
                </td>
                <td className={`${TD} text-right text-xs tabular-nums text-muted-foreground`}>
                  {target.lastScrapeDuration !== null && target.lastScrapeDuration !== undefined
                    ? formatDuration(target.lastScrapeDuration)
                    : '—'}
                </td>
                <td className={`${TD} text-xs text-status-critical truncate max-w-[18rem]`}>
                  {target.lastError ?? ''}
                </td>
                <td className={`${TD} text-xs text-muted-foreground truncate max-w-[18rem]`}>
                  {labelsSummary(target.labels, ['job', 'instance']) || '—'}
                </td>
              </tr>,
              isOpen ? (
                <tr key={`${rowKey}-detail`} id={detailId} className="bg-muted/10 border-t border-border">
                  <td colSpan={COLS} className="px-4 py-3 space-y-3">
                    <div className="text-xs text-muted-foreground break-all">
                      스크레이프 URL: {target.scrapeUrl ?? '—'} · 풀: {target.scrapePool ?? '—'}
                    </div>
                    <LabelTable title="라벨" pairs={target.labels} />
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
