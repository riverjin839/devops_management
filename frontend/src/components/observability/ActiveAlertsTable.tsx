import { useState } from 'react';
import type { PromActiveAlert } from '@/types';
import { LabelTable, ROW, TD, TH, TableMessage, formatTime } from './shared';

const COLS = 7;

const SEVERITY_CLS: Record<string, string> = {
  critical: 'text-[hsl(var(--status-critical))] font-semibold',
  warning: 'text-[hsl(var(--status-warning))]',
  info: 'text-[hsl(var(--status-info))]',
};

/** 지금 발화/대기 중인 알람 (Prometheus + Alertmanager 병합). */
export function ActiveAlertsTable({ rows, isLoading, emptyMessage }: {
  rows: PromActiveAlert[];
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
            <th className={`${TH} w-20`}>심각도</th>
            <th className={TH}>알람</th>
            <th className={`${TH} w-32`}>네임스페이스</th>
            <th className={`${TH} w-48`}>대상</th>
            <th className={TH}>요약</th>
            <th className={`${TH} w-32`}>발생</th>
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            <TableMessage colSpan={COLS}>알람을 불러오는 중…</TableMessage>
          ) : rows.length === 0 ? (
            <TableMessage colSpan={COLS}>{emptyMessage ?? '발화 중인 알람이 없습니다.'}</TableMessage>
          ) : (
            rows.map((alert, idx) => {
              const rowKey = `${alert.alertname}/${alert.resource ?? ''}/${idx}`;
              const isOpen = expanded === rowKey;
              return [
                <tr
                  key={rowKey}
                  className={`${ROW} cursor-pointer`}
                  onClick={() => setExpanded(isOpen ? null : rowKey)}
                >
                  <td className={`${TD} text-xs ${
                    alert.state === 'firing'
                      ? 'text-[hsl(var(--status-critical))]'
                      : 'text-[hsl(var(--status-warning))]'
                  }`}>
                    {alert.state}
                  </td>
                  <td className={`${TD} text-xs ${SEVERITY_CLS[alert.severity ?? ''] ?? 'text-muted-foreground'}`}>
                    {alert.severity ?? '-'}
                  </td>
                  <td className={`${TD} font-medium truncate max-w-[16rem]`}>
                    {alert.alertname}
                    <span className="ml-2 text-[10px] text-muted-foreground uppercase">{alert.origin}</span>
                  </td>
                  <td className={`${TD} text-xs text-muted-foreground truncate`}>{alert.namespace ?? '-'}</td>
                  <td className={`${TD} font-mono text-xs truncate max-w-[12rem]`}>{alert.resource ?? '-'}</td>
                  <td className={`${TD} text-xs text-muted-foreground truncate max-w-[20rem]`}>
                    {alert.summary ?? '-'}
                  </td>
                  <td className={`${TD} text-xs text-muted-foreground whitespace-nowrap`}>
                    {formatTime(alert.activeAt)}
                  </td>
                </tr>,
                isOpen ? (
                  <tr key={`${rowKey}-detail`} className="bg-muted/10 border-t border-border">
                    <td colSpan={COLS} className="px-4 py-3">
                      <div className="grid gap-4 md:grid-cols-2">
                        <LabelTable title="라벨" pairs={alert.labels} />
                        <LabelTable title="어노테이션" pairs={alert.annotations} />
                      </div>
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
