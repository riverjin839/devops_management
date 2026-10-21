import { useId, useState } from 'react';
import type { PromRule } from '@/types';
import {
  ExpandButton, INCOMPLETE_HINT, LabelTable, ROW, RULE_HEALTH_LABEL, RULE_STATE_LABEL, SEVERITY_LABEL,
  TD, TH, formatDuration, formatTime, tableStatus,
  type TableStateProps,
} from './shared';

const COLS = 8;

const STATE_CLS: Record<string, string> = {
  firing: 'text-status-critical',
  pending: 'text-status-warning',
  inactive: 'text-muted-foreground',
};

const SEVERITY_CLS: Record<string, string> = {
  critical: 'text-status-critical',
  warning: 'text-status-warning',
  info: 'text-muted-foreground', // 정상 범주는 무채색(§12.12-3)
};

/** Prometheus 알람/기록 규칙 dense 테이블. */
export function RulesTable({
  rows, isLoading, error, onRetry, offline, clusterId, incomplete, emptyMessage,
}: TableStateProps & { rows: PromRule[] }) {
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
    emptyTitle: emptyMessage ?? '등록된 알람 규칙이 없습니다',
    emptyDescription: emptyMessage
      ? '검색어나 상태 필터를 바꾸세요.'
      : (incomplete ? INCOMPLETE_HINT : 'PrometheusRule 리소스가 Prometheus 에 로드됐는지 확인하세요.'),
    errorTitle: '알람 규칙을 불러오지 못했습니다',
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/20">
          <tr>
            <th className={`${TH} w-24`}>상태</th>
            <th className={TH}>규칙</th>
            <th className={`${TH} w-44`}>그룹</th>
            <th className={`${TH} w-20`}>심각도</th>
            <th className={`${TH} w-28 text-right`}>대기 시간(for)</th>
            <th className={`${TH} w-16 text-right`}>발화</th>
            <th className={`${TH} w-24`}>평가 상태</th>
            <th className={TH}>표현식</th>
          </tr>
        </thead>
        <tbody>
          {status ?? rows.map((rule, idx) => {
            const rowKey = `${rule.group}/${rule.name}/${idx}`;
            const isOpen = expanded === rowKey;
            const detailId = `${baseId}-${idx}`;
            const toggle = () => setExpanded(isOpen ? null : rowKey);
            const unhealthy = rule.health && rule.health !== 'ok';
            const stateRaw = rule.type === 'recording' ? 'recording' : (rule.state ?? '');
            const severity = rule.severity ?? '';
            return [
              <tr key={rowKey} className={`${ROW} cursor-pointer`} onClick={toggle}>
                <td
                  className={`${TD} text-xs ${STATE_CLS[stateRaw] ?? 'text-muted-foreground'}`}
                  title={stateRaw || undefined}
                >
                  {stateRaw ? (RULE_STATE_LABEL[stateRaw] ?? stateRaw) : '—'}
                </td>
                <td className={`${TD} font-medium max-w-[18rem]`}>
                  <ExpandButton open={isOpen} controls={detailId} onToggle={toggle}>
                    {rule.name}
                  </ExpandButton>
                </td>
                <td className={`${TD} text-xs text-muted-foreground truncate max-w-[11rem]`}>
                  {rule.group}
                </td>
                <td
                  className={`${TD} text-xs ${SEVERITY_CLS[severity] ?? 'text-muted-foreground'}`}
                  title={severity || undefined}
                >
                  {severity ? (SEVERITY_LABEL[severity] ?? severity) : '—'}
                </td>
                <td className={`${TD} text-right text-xs tabular-nums text-muted-foreground`}>
                  {rule.duration ? formatDuration(rule.duration) : '—'}
                </td>
                <td className={`${TD} text-right text-xs tabular-nums ${
                  rule.activeAlerts > 0 ? 'text-status-critical' : 'text-muted-foreground'
                }`}>
                  {rule.activeAlerts || '—'}
                </td>
                <td
                  className={`${TD} text-xs ${unhealthy ? 'text-status-critical' : 'text-muted-foreground'}`}
                  title={rule.health ?? undefined}
                >
                  {rule.health ? (RULE_HEALTH_LABEL[rule.health] ?? rule.health) : '—'}
                </td>
                <td className={`${TD} font-mono text-xs text-muted-foreground truncate max-w-[22rem]`}>
                  {rule.query}
                </td>
              </tr>,
              isOpen ? (
                <tr key={`${rowKey}-detail`} id={detailId} className="bg-muted/10 border-t border-border">
                  <td colSpan={COLS} className="px-4 py-3 space-y-3">
                    <div>
                      <div className="text-xs font-semibold text-muted-foreground mb-1">표현식</div>
                      <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-secondary rounded-xl p-2">
                        {rule.query}
                      </pre>
                    </div>
                    {rule.lastError ? (
                      <p className="text-xs text-status-critical">
                        마지막 평가 오류: {rule.lastError}
                      </p>
                    ) : null}
                    <div className="grid gap-4 md:grid-cols-2">
                      <LabelTable title="라벨" pairs={rule.labels} />
                      <LabelTable title="어노테이션" pairs={rule.annotations} />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      파일 {rule.file ?? '—'} · 마지막 평가 {formatTime(rule.lastEvaluation)}
                      {rule.evaluationTime !== null && rule.evaluationTime !== undefined
                        ? ` · 소요 ${formatDuration(rule.evaluationTime)}`
                        : ''}
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
