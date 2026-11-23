import { RefreshCw, X } from 'lucide-react';
import { StatusBadge, statusToVariant } from '@/components/common/StatusBadge';
import { LogViewer } from '@/components/common/LogViewer';
import { useModalA11y } from '@/components/common';
import { ExecutionStepsTimeline } from '@/components/daily-check/ExecutionStepsTimeline';
import type { OpsCheckRunItem } from '@/types';

interface Props {
  item: OpsCheckRunItem | null;
  onClose: () => void;
}

/** 운영 점검 실행 항목 1건의 결과 상세(판정·단계 타임라인·상세 로그). 점검 항목 표와 진행 카드가 공유한다. */
export function OpsRunItemDetailModal({ item, onClose }: Props) {
  const ref = useModalA11y(!!item, onClose);
  if (!item) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ops-detail-title"
        className="bg-card rounded-md border border-border w-full max-w-3xl max-h-[85vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-card flex items-center gap-2 px-5 py-3 border-b border-border">
          {item.status === 'done'
            ? <StatusBadge variant={statusToVariant(item.resultStatus)} />
            : <StatusBadge variant="critical" label="실패" />}
          <h2 id="ops-detail-title" className="font-semibold text-sm truncate">{item.name || item.checkType}</h2>
          <span className="text-xs text-muted-foreground font-mono ml-1">{item.durationMs}ms</span>
          <button onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground" title="닫기" aria-label="닫기">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-3">
          {item.message && <p className="text-sm">{item.message}</p>}
          {Array.isArray(item.details?._steps) && item.details!._steps.length > 0 && (
            <ExecutionStepsTimeline steps={item.details!._steps} />
          )}
          <div>
            <div className="text-xs font-semibold text-muted-foreground mb-1 flex items-center gap-1">
              <RefreshCw className="w-3 h-3" /> 상세 로그
            </div>
            <LogViewer text={item.details ? JSON.stringify(item.details, null, 2) : '(상세 없음)'} maxHeight="max-h-[55vh]" />
          </div>
        </div>
      </div>
    </div>
  );
}
