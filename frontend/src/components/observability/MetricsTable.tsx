import { useState } from 'react';
import { ExternalLink, Pencil } from 'lucide-react';
import type { ObservabilityMetricValue } from '@/types';
import {
  LabelTable, ROW, StateDot, TD, TH, TableMessage,
  formatMetricValue, labelsSummary, stateTextClass,
} from './shared';

interface MetricsTableProps {
  rows: ObservabilityMetricValue[];
  isLoading: boolean;
  emptyMessage?: string;
  /** operator 이상일 때만 전달 — 행에서 바로 편집 진입. */
  onEdit?: (metricId: string) => void;
}

const COLS = 8;

/** 관측 스택의 개별 지표를 한 화면에 훑는 dense 테이블. */
export function MetricsTable({ rows, isLoading, emptyMessage, onEdit }: MetricsTableProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/20">
          <tr>
            <th className={`${TH} w-24`}>상태</th>
            <th className={TH}>지표</th>
            <th className={`${TH} w-28`}>카테고리</th>
            <th className={`${TH} w-32 text-right`}>현재값</th>
            <th className={`${TH} w-28`}>임계</th>
            <th className={`${TH} w-56`}>대상</th>
            <th className={TH}>PromQL</th>
            <th className={`${TH} w-10`}><span className="sr-only">편집</span></th>
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            <TableMessage colSpan={COLS}>지표를 불러오는 중…</TableMessage>
          ) : rows.length === 0 ? (
            <TableMessage colSpan={COLS}>{emptyMessage ?? '표시할 지표가 없습니다.'}</TableMessage>
          ) : (
            rows.map((row) => {
              const isOpen = expanded === row.metricId;
              const failed = row.status !== 'ok';
              return [
                <tr
                  key={row.metricId}
                  className={`${ROW} cursor-pointer`}
                  onClick={() => setExpanded(isOpen ? null : row.metricId)}
                >
                  <td className={TD}>
                    <StateDot state={failed ? 'unknown' : row.state} title={row.error ?? undefined} />
                  </td>
                  <td className={`${TD} font-medium`}>
                    {row.label}
                    <span className="ml-2 font-mono text-xs text-muted-foreground">{row.key}</span>
                  </td>
                  <td className={`${TD} text-xs text-muted-foreground`}>{row.category}</td>
                  <td className={`${TD} text-right font-mono tabular-nums ${
                    failed ? 'text-muted-foreground' : stateTextClass(row.state)
                  }`}>
                    {failed
                      ? (row.status === 'offline' ? '미연결' : '오류')
                      : formatMetricValue(row.value, row.displayType, row.unit)}
                  </td>
                  <td className={`${TD} text-xs text-muted-foreground font-mono`}>
                    {row.thresholds || '-'}
                  </td>
                  <td className={`${TD} text-xs text-muted-foreground truncate max-w-[14rem]`}>
                    {labelsSummary(row.labels, ['__name__']) || '-'}
                    {row.seriesCount > 1 ? (
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        (+{row.seriesCount - 1})
                      </span>
                    ) : null}
                  </td>
                  <td className={`${TD} font-mono text-xs text-muted-foreground truncate max-w-[20rem]`}>
                    {row.promql}
                  </td>
                  <td className={TD}>
                    {onEdit ? (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onEdit(row.metricId); }}
                        title="지표 편집"
                        aria-label={`${row.label} 지표 편집`}
                        className="p-1 rounded-xl text-muted-foreground hover:bg-secondary transition-colors"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                    ) : null}
                  </td>
                </tr>,
                isOpen ? (
                  <tr key={`${row.metricId}-detail`} className="bg-muted/10 border-t border-border">
                    <td colSpan={COLS} className="px-4 py-3">
                      <div className="space-y-3">
                        {row.help ? (
                          <p className="text-xs text-muted-foreground">{row.help}</p>
                        ) : null}
                        {row.error ? (
                          <p className="text-xs text-[hsl(var(--status-critical))]">{row.error}</p>
                        ) : null}
                        <div>
                          <div className="text-xs font-semibold text-muted-foreground mb-1">PromQL</div>
                          <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-secondary rounded-xl p-2">
                            {row.promql}
                          </pre>
                        </div>
                        <LabelTable title="라벨" pairs={row.labels} />
                        {row.docUrl ? (
                          <a
                            href={row.docUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            <ExternalLink className="w-3 h-3" aria-hidden /> 참고 문서
                          </a>
                        ) : null}
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
