import { useId, useState } from 'react';
import type { PromActiveAlert } from '@/types';
import {
  ALERT_STATE_LABEL, ExpandButton, INCOMPLETE_HINT, LabelTable, ORIGIN_LABEL, ROW, SEVERITY_LABEL,
  TD, TH, formatTime, tableStatus,
  type TableStateProps,
} from './shared';

const COLS = 7;

const SEVERITY_CLS: Record<string, string> = {
  critical: 'text-status-critical font-semibold',
  warning: 'text-status-warning',
  info: 'text-muted-foreground', // 정상 범주는 무채색(§12.12-3)
};

/**
 * 지금 발화/대기 중인 알람 (Prometheus + Alertmanager 병합).
 * 미연결·조회 실패는 "알람 없음"으로 보이지 않게 `tableStatus` 가 먼저 가른다(D-183).
 */
export function ActiveAlertsTable({
  rows, isLoading, error, onRetry, offline, clusterId, incomplete, emptyMessage,
}: TableStateProps & { rows: PromActiveAlert[] }) {
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
    emptyTitle: emptyMessage ?? (incomplete ? '확인된 발화 알람이 없습니다' : '발화 중인 알람이 없습니다'),
    emptyDescription: incomplete ? INCOMPLETE_HINT : undefined,
    errorTitle: '발화 중 알람을 불러오지 못했습니다',
  });

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
          {status ?? rows.map((alert, idx) => {
            const rowKey = `${alert.alertname}/${alert.resource ?? ''}/${idx}`;
            const isOpen = expanded === rowKey;
            const detailId = `${baseId}-${idx}`;
            const toggle = () => setExpanded(isOpen ? null : rowKey);
            const severity = alert.severity ?? '';
            return [
              <tr key={rowKey} className={`${ROW} cursor-pointer`} onClick={toggle}>
                <td
                  className={`${TD} text-xs ${
                    alert.state === 'pending' ? 'text-status-warning' : 'text-status-critical'
                  }`}
                  title={alert.state}
                >
                  {ALERT_STATE_LABEL[alert.state] ?? alert.state}
                </td>
                <td
                  className={`${TD} text-xs ${SEVERITY_CLS[severity] ?? 'text-muted-foreground'}`}
                  title={severity || undefined}
                >
                  {severity ? (SEVERITY_LABEL[severity] ?? severity) : '—'}
                </td>
                <td className={`${TD} font-medium max-w-[16rem]`}>
                  <ExpandButton open={isOpen} controls={detailId} onToggle={toggle}>
                    {alert.alertname}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {ORIGIN_LABEL[alert.origin] ?? alert.origin}
                    </span>
                  </ExpandButton>
                </td>
                <td className={`${TD} text-xs text-muted-foreground truncate`}>{alert.namespace ?? '—'}</td>
                <td className={`${TD} font-mono text-xs truncate max-w-[12rem]`}>{alert.resource ?? '—'}</td>
                <td className={`${TD} text-xs text-muted-foreground truncate max-w-[20rem]`}>
                  {alert.summary ?? '—'}
                </td>
                <td className={`${TD} text-xs text-muted-foreground whitespace-nowrap`}>
                  {formatTime(alert.activeAt)}
                </td>
              </tr>,
              isOpen ? (
                <tr key={`${rowKey}-detail`} id={detailId} className="bg-muted/10 border-t border-border">
                  <td colSpan={COLS} className="px-4 py-3">
                    <div className="grid gap-4 md:grid-cols-2">
                      <LabelTable title="라벨" pairs={alert.labels} />
                      <LabelTable title="어노테이션" pairs={alert.annotations} />
                    </div>
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
