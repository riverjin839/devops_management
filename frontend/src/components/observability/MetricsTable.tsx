import { useId, useState } from 'react';
import { ExternalLink, Pencil } from 'lucide-react';
import type { ObservabilityMetricValue } from '@/types';
import {
  ExpandButton, INCOMPLETE_HINT, LabelTable, ROW, StateDot, TD, TH, tableStatus,
  formatMetricValue, labelsSummary, stateTextClass,
  type TableStateProps,
} from './shared';

/** 편집 버튼 상태 — 숨기지 않고 비활성 + 사유(§12.9, D-186 ④⑥). */
export interface MetricEditAction {
  onEdit: (metricId: string) => void;
  /** 행별 비활성 사유(undefined = 활성). 권한 없음·정의 로딩 중·정의 없음. */
  disabledReason: (metricId: string) => string | undefined;
}

interface MetricsTableProps extends TableStateProps {
  rows: ObservabilityMetricValue[];
  edit?: MetricEditAction;
}

const COLS = 8;

/** 실패 행의 값 칸·상태 점이 같은 문구를 쓰도록 한곳에서 정한다(D-191). */
function failedLabel(row: ObservabilityMetricValue): string {
  return row.status === 'offline' ? '미연결' : '오류';
}

/** 관측 스택의 개별 지표를 한 화면에 훑는 dense 테이블. */
export function MetricsTable({
  rows, isLoading, error, onRetry, offline, clusterId, incomplete, emptyMessage, edit,
}: MetricsTableProps) {
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
    emptyTitle: emptyMessage ?? '표시할 지표가 없습니다',
    emptyDescription: emptyMessage ? '검색어를 바꾸거나 지우세요.' : (incomplete ? INCOMPLETE_HINT : undefined),
    errorTitle: '지표 현재값을 불러오지 못했습니다',
  });

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
          {status ?? rows.map((row, idx) => {
            const isOpen = expanded === row.metricId;
            const failed = row.status !== 'ok';
            const detailId = `${baseId}-${idx}`;
            const toggle = () => setExpanded(isOpen ? null : row.metricId);
            const editReason = edit?.disabledReason(row.metricId);
            return [
              <tr key={row.metricId} className={`${ROW} cursor-pointer`} onClick={toggle}>
                <td className={TD}>
                  <StateDot
                    state={failed ? 'unknown' : row.state}
                    label={failed ? failedLabel(row) : undefined}
                    title={row.error ?? undefined}
                  />
                </td>
                <td className={`${TD} font-medium max-w-[22rem]`}>
                  <ExpandButton open={isOpen} controls={detailId} onToggle={toggle}>
                    {row.label}
                    <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">{row.key}</span>
                  </ExpandButton>
                </td>
                <td className={`${TD} text-xs text-muted-foreground`}>{row.category}</td>
                <td className={`${TD} text-right tabular-nums ${
                  failed ? 'text-muted-foreground' : stateTextClass(row.state)
                }`}>
                  {failed ? failedLabel(row) : formatMetricValue(row.value, row.displayType, row.unit)}
                </td>
                <td className={`${TD} text-xs text-muted-foreground font-mono`}>
                  {row.thresholds || '—'}
                </td>
                <td className={`${TD} text-xs text-muted-foreground truncate max-w-[14rem]`}>
                  {labelsSummary(row.labels, ['__name__']) || '—'}
                  {row.seriesCount > 1 ? (
                    <span className="ml-1 text-xs text-muted-foreground">
                      (+{row.seriesCount - 1})
                    </span>
                  ) : null}
                </td>
                <td className={`${TD} font-mono text-xs text-muted-foreground truncate max-w-[20rem]`}>
                  {row.promql}
                </td>
                <td className={TD}>
                  {edit ? (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); edit.onEdit(row.metricId); }}
                      disabled={!!editReason}
                      title={editReason ?? '지표 편집'}
                      aria-label={editReason ? `${row.label} 지표 편집 — ${editReason}` : `${row.label} 지표 편집`}
                      className="p-1 rounded-xl text-muted-foreground hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Pencil className="w-3.5 h-3.5" aria-hidden />
                    </button>
                  ) : null}
                </td>
              </tr>,
              isOpen ? (
                <tr key={`${row.metricId}-detail`} id={detailId} className="bg-muted/10 border-t border-border">
                  <td colSpan={COLS} className="px-4 py-3">
                    <div className="space-y-3">
                      {row.help ? (
                        <p className="text-xs text-muted-foreground">{row.help}</p>
                      ) : null}
                      {row.error ? (
                        <p className="text-xs text-status-critical">{row.error}</p>
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
          })}
        </tbody>
      </table>
    </div>
  );
}
