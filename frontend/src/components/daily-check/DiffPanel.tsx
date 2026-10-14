import { Plus, Minus, ArrowRight } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { EmptyState } from '@/components/common/EmptyState';
import type { DiffSummary } from '@/types';

interface Props {
  diff: DiffSummary | null | undefined;
}

export function DiffPanel({ diff }: Props) {
  if (!diff || !diff.available) {
    return (
      <EmptyState
        compact
        title="비교할 이전 회차 없음"
        description="비교할 이전 점검 회차가 없습니다. 기본 점검이 두 번 이상 쌓이면 새로 생기거나 해소된 에러·경고가 표시됩니다."
      />
    );
  }

  const sections: { label: string; items: string[] | undefined; positive: boolean }[] = [
    { label: '새로 발생한 에러', items: diff.errorsAdded, positive: false },
    { label: '해소된 에러', items: diff.errorsRemoved, positive: true },
    { label: '새로 발생한 경고', items: diff.warningsAdded, positive: false },
    { label: '해소된 경고', items: diff.warningsRemoved, positive: true },
  ];

  return (
    <MacCard title="이전 점검 대비 변동">
      <div className="space-y-3">
        {diff.statusChanged && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">전체 상태</span>
            <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="font-mono text-sm rounded bg-muted px-2 py-0.5">
              {diff.previousStatus} → {diff.currentStatus}
            </span>
          </div>
        )}
        {(diff.readyNodesDelta ?? 0) !== 0 && (
          <div className="text-sm">
            <span className="text-muted-foreground">Ready 노드 변화: </span>
            <span className={(diff.readyNodesDelta ?? 0) < 0 ? 'text-status-critical' : 'text-status-healthy'}>
              {(diff.readyNodesDelta ?? 0) > 0 ? '+' : ''}
              {diff.readyNodesDelta}
            </span>
          </div>
        )}
        {sections.map((s) =>
          s.items && s.items.length > 0 ? (
            <div key={s.label}>
              <div className="text-xs font-semibold text-muted-foreground mb-1">
                {s.label}
              </div>
              <ul className="space-y-1">
                {s.items.map((it, i) => (
                  <li key={i} className="flex items-start gap-1.5 text-sm">
                    {s.positive ? (
                      <Minus className="w-3 h-3 mt-0.5 flex-shrink-0 text-status-healthy" />
                    ) : (
                      <Plus className="w-3 h-3 mt-0.5 flex-shrink-0 text-status-critical" />
                    )}
                    <span className="break-words">{it}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null
        )}
        {!diff.statusChanged &&
          !diff.errorsAdded?.length &&
          !diff.errorsRemoved?.length &&
          !diff.warningsAdded?.length &&
          !diff.warningsRemoved?.length &&
          (diff.readyNodesDelta ?? 0) === 0 && (
            <div className="text-sm text-muted-foreground italic">
              이전 점검과 비교해 변동이 없습니다.
            </div>
          )}
      </div>
    </MacCard>
  );
}
