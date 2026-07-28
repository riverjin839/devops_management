import { useState } from 'react';
import type { PromTarget } from '@/types';
import {
  HealthIcon, LabelTable, ROW, TD, TH, TableMessage, formatDuration, formatTime, labelsSummary,
} from './shared';

const COLS = 7;

/** Prometheus 스크레이프 타겟 dense 테이블 — 어떤 exporter 가 안 걷히는지 즉시 보이게. */
export function TargetsTable({ rows, isLoading, emptyMessage }: {
  rows: PromTarget[];
  isLoading: boolean;
  emptyMessage?: string;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/20">
          <tr>
            <th className={`${TH} w-20`}>상태</th>
            <th className={`${TH} w-56`}>job</th>
            <th className={`${TH} w-56`}>instance</th>
            <th className={`${TH} w-32`}>최근 수집</th>
            <th className={`${TH} w-20 text-right`}>소요</th>
            <th className={TH}>오류</th>
            <th className={TH}>라벨</th>
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            <TableMessage colSpan={COLS}>타겟을 불러오는 중…</TableMessage>
          ) : rows.length === 0 ? (
            <TableMessage colSpan={COLS}>{emptyMessage ?? '표시할 타겟이 없습니다.'}</TableMessage>
          ) : (
            rows.map((target, idx) => {
              const rowKey = `${target.job}/${target.instance}/${idx}`;
              const isOpen = expanded === rowKey;
              const up = target.health === 'up';
              return [
                <tr
                  key={rowKey}
                  className={`${ROW} cursor-pointer`}
                  onClick={() => setExpanded(isOpen ? null : rowKey)}
                >
                  <td className={TD}>
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <HealthIcon healthy={up} />
                      <span className={up ? 'text-muted-foreground' : 'text-[hsl(var(--status-critical))]'}>
                        {target.health}
                      </span>
                    </span>
                  </td>
                  <td className={`${TD} font-medium truncate max-w-[14rem]`}>{target.job}</td>
                  <td className={`${TD} font-mono text-xs truncate max-w-[14rem]`}>{target.instance}</td>
                  <td className={`${TD} text-xs text-muted-foreground whitespace-nowrap`}>
                    {formatTime(target.lastScrape)}
                  </td>
                  <td className={`${TD} text-right text-xs font-mono text-muted-foreground`}>
                    {target.lastScrapeDuration !== null && target.lastScrapeDuration !== undefined
                      ? formatDuration(target.lastScrapeDuration)
                      : '-'}
                  </td>
                  <td className={`${TD} text-xs text-[hsl(var(--status-critical))] truncate max-w-[18rem]`}>
                    {target.lastError ?? ''}
                  </td>
                  <td className={`${TD} text-xs text-muted-foreground truncate max-w-[18rem]`}>
                    {labelsSummary(target.labels, ['job', 'instance'])}
                  </td>
                </tr>,
                isOpen ? (
                  <tr key={`${rowKey}-detail`} className="bg-muted/10 border-t border-border">
                    <td colSpan={COLS} className="px-4 py-3 space-y-3">
                      <div className="text-xs text-muted-foreground break-all">
                        스크레이프 URL: {target.scrapeUrl ?? '-'} · 풀: {target.scrapePool ?? '-'}
                      </div>
                      <LabelTable title="라벨" pairs={target.labels} />
                    </td>
                  </tr>
                ) : null,
              ];
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
