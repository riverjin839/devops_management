import { useId, useState } from 'react';
import { ChevronRight, Pencil, Power } from 'lucide-react';
import { useToast } from '@/components/common';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useUpdateMetric } from '@/hooks/useObservability';
import type { ObservabilityMetric } from '@/types';
import { formatApiError } from '@/lib/utils';
import { ROW, TD, TH } from './shared';

/**
 * "사용 안 함" 지표 접힘 섹션(D-186 ②) — 끈 지표는 현재값 응답에서 빠지므로, 카탈로그 목록
 * (`include_disabled=true`)에서 따로 보여주고 화면에서 다시 켜거나 편집할 수 있게 한다.
 */
export function DisabledMetricsSection({ metrics, onEdit }: {
  metrics: ObservabilityMetric[];
  onEdit: (metricId: string) => void;
}) {
  const toast = useToast();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const { canOperate, withHint, ariaWithHint } = useCanOperate();
  const update = useUpdateMetric();
  const [pendingId, setPendingId] = useState<string | null>(null);

  if (metrics.length === 0) return null;

  const enable = async (metric: ObservabilityMetric) => {
    setPendingId(metric.id);
    try {
      await update.mutateAsync({ id: metric.id, data: { enabled: true } });
      toast.success(`'${metric.label}' 지표 다시 켬`);
    } catch (err) {
      toast.error(formatApiError(err, '지표 사용 전환 실패'));
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="border-t border-border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-4 py-2 text-xs text-muted-foreground hover:bg-muted/20 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden />
        사용 안 함 {metrics.length}개
        <span className="ml-1">— 조회하지 않는 지표. 다시 켜면 위 표에 나타납니다.</span>
      </button>
      {open ? (
        <div id={panelId} className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/20">
              <tr>
                <th className={TH}>지표</th>
                <th className={`${TH} w-28`}>카테고리</th>
                <th className={TH}>PromQL</th>
                <th className={`${TH} w-40`}><span className="sr-only">동작</span></th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => (
                <tr key={metric.id} className={ROW}>
                  <td className={`${TD} text-muted-foreground`}>
                    {metric.label}
                    <span className="ml-2 font-mono text-xs">{metric.key}</span>
                  </td>
                  <td className={`${TD} text-xs text-muted-foreground`}>{metric.category}</td>
                  <td className={`${TD} font-mono text-xs text-muted-foreground truncate max-w-[24rem]`}>
                    {metric.promql}
                  </td>
                  <td className={`${TD} text-right whitespace-nowrap`}>
                    <button
                      type="button"
                      onClick={() => void enable(metric)}
                      disabled={!canOperate || pendingId === metric.id}
                      title={withHint('다시 켜기')}
                      aria-label={ariaWithHint(`${metric.label} 지표 다시 켜기`)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl text-xs bg-secondary text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Power className="w-3.5 h-3.5" aria-hidden />
                      {pendingId === metric.id ? '켜는 중…' : '다시 켜기'}
                    </button>
                    <button
                      type="button"
                      onClick={() => onEdit(metric.id)}
                      disabled={!canOperate}
                      title={withHint('지표 편집')}
                      aria-label={ariaWithHint(`${metric.label} 지표 편집`)}
                      className="ml-1 p-1 rounded-xl text-muted-foreground hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Pencil className="w-3.5 h-3.5" aria-hidden />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
