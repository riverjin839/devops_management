import { useState } from 'react';
import type { PromRule } from '@/types';
import {
  LabelTable, ROW, TD, TH, TableMessage, formatDuration, formatTime,
} from './shared';

const COLS = 8;

const STATE_CLS: Record<string, string> = {
  firing: 'text-[hsl(var(--status-critical))]',
  pending: 'text-[hsl(var(--status-warning))]',
  inactive: 'text-muted-foreground',
};

const SEVERITY_CLS: Record<string, string> = {
  critical: 'text-[hsl(var(--status-critical))]',
  warning: 'text-[hsl(var(--status-warning))]',
  info: 'text-[hsl(var(--status-info))]',
};

/** Prometheus 알람/기록 규칙 dense 테이블. */
export function RulesTable({ rows, isLoading, emptyMessage }: {
  rows: PromRule[];
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
            <th className={TH}>규칙</th>
            <th className={`${TH} w-44`}>그룹</th>
            <th className={`${TH} w-20`}>심각도</th>
            <th className={`${TH} w-16 text-right`}>for</th>
            <th className={`${TH} w-16 text-right`}>발화</th>
            <th className={`${TH} w-20`}>health</th>
            <th className={TH}>표현식</th>
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            <TableMessage colSpan={COLS}>규칙을 불러오는 중…</TableMessage>
          ) : rows.length === 0 ? (
            <TableMessage colSpan={COLS}>{emptyMessage ?? '표시할 규칙이 없습니다.'}</TableMessage>
          ) : (
            rows.map((rule, idx) => {
              const rowKey = `${rule.group}/${rule.name}/${idx}`;
              const isOpen = expanded === rowKey;
              const unhealthy = rule.health && rule.health !== 'ok';
              return [
                <tr
                  key={rowKey}
                  className={`${ROW} cursor-pointer`}
                  onClick={() => setExpanded(isOpen ? null : rowKey)}
                >
                  <td className={`${TD} text-xs ${STATE_CLS[rule.state ?? ''] ?? 'text-muted-foreground'}`}>
                    {rule.type === 'recording' ? 'record' : (rule.state ?? '-')}
                  </td>
                  <td className={`${TD} font-medium truncate max-w-[18rem]`}>{rule.name}</td>
                  <td className={`${TD} text-xs text-muted-foreground truncate max-w-[11rem]`}>
                    {rule.group}
                  </td>
                  <td className={`${TD} text-xs ${SEVERITY_CLS[rule.severity ?? ''] ?? 'text-muted-foreground'}`}>
                    {rule.severity ?? '-'}
                  </td>
                  <td className={`${TD} text-right text-xs font-mono text-muted-foreground`}>
                    {rule.duration ? formatDuration(rule.duration) : '-'}
                  </td>
                  <td className={`${TD} text-right text-xs font-mono ${
                    rule.activeAlerts > 0 ? 'text-[hsl(var(--status-critical))]' : 'text-muted-foreground'
                  }`}>
                    {rule.activeAlerts || '-'}
                  </td>
                  <td className={`${TD} text-xs ${
                    unhealthy ? 'text-[hsl(var(--status-critical))]' : 'text-muted-foreground'
                  }`}>
                    {rule.health ?? '-'}
                  </td>
                  <td className={`${TD} font-mono text-xs text-muted-foreground truncate max-w-[22rem]`}>
                    {rule.query}
                  </td>
                </tr>,
                isOpen ? (
                  <tr key={`${rowKey}-detail`} className="bg-muted/10 border-t border-border">
                    <td colSpan={COLS} className="px-4 py-3 space-y-3">
                      <div>
                        <div className="text-xs font-semibold text-muted-foreground mb-1">표현식</div>
                        <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-secondary rounded-xl p-2">
                          {rule.query}
                        </pre>
                      </div>
                      {rule.lastError ? (
                        <p className="text-xs text-[hsl(var(--status-critical))]">
                          마지막 평가 오류: {rule.lastError}
                        </p>
                      ) : null}
                      <div className="grid gap-4 md:grid-cols-2">
                        <LabelTable title="라벨" pairs={rule.labels} />
                        <LabelTable title="어노테이션" pairs={rule.annotations} />
                      </div>
                      <div className="text-xs text-muted-foreground">
                        파일 {rule.file ?? '-'} · 마지막 평가 {formatTime(rule.lastEvaluation)}
                        {rule.evaluationTime !== null && rule.evaluationTime !== undefined
                          ? ` · 소요 ${formatDuration(rule.evaluationTime)}`
                          : ''}
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
