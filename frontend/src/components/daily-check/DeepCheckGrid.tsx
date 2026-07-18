import { CheckCircle2, AlertTriangle, XCircle, Clock } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ExecutionStepsTimeline } from '@/components/daily-check/ExecutionStepsTimeline';
import type { DeepCheckResult, DeepCheckExecStep, Status } from '@/types';

interface Props {
  results: DeepCheckResult[];
}

const STATUS_ICON: Record<Status, { Icon: typeof CheckCircle2; color: string }> = {
  healthy:  { Icon: CheckCircle2,  color: 'text-emerald-500' },
  warning:  { Icon: AlertTriangle, color: 'text-amber-500'   },
  critical: { Icon: XCircle,       color: 'text-red-500'     },
  pending:  { Icon: Clock,         color: 'text-gray-400'    },
};

export function DeepCheckGrid({ results }: Props) {
  if (!results.length) {
    return (
      <MacCard title="Deep Check 결과">
        <div className="text-sm text-muted-foreground italic">
          아직 Deep Check 결과가 없습니다. Super Pod 가 다음 점검 회차에 결과를 보내거나,
          상단의 "지금 실행" 버튼을 눌러 즉시 실행할 수 있습니다.
        </div>
      </MacCard>
    );
  }

  return (
    <MacCard title="Deep Check 결과">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {results.map((r) => {
          const meta = STATUS_ICON[r.status] || STATUS_ICON.pending;
          const Icon = meta.Icon;
          return (
            <div
              key={r.id}
              className="rounded-xl border border-border bg-card p-3.5 space-y-2"
            >
              <div className="flex items-start gap-2">
                <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${meta.color}`} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm truncate">{r.checkType}</div>
                  <div className="text-sm text-muted-foreground mt-0.5 break-words">
                    {r.message}
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{new Date(r.checkedAt).toLocaleTimeString('ko-KR')}</span>
                <span>{r.durationMs}ms</span>
              </div>
              {/* 응답 인터셉터가 _steps 키를 camelize(→ Steps) 하므로 둘 다 조회 */}
              {(() => {
                const steps = (r.details?._steps ?? r.details?.Steps) as
                  | DeepCheckExecStep[]
                  | undefined;
                return Array.isArray(steps) && steps.length > 0 ? (
                  <ExecutionStepsTimeline steps={steps} />
                ) : null;
              })()}
              {r.details && Object.keys(r.details).length > 0 && (
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer hover:text-foreground">상세</summary>
                  <pre className="mt-1.5 rounded bg-muted p-2 overflow-x-auto text-xs max-h-48">
                    {JSON.stringify(r.details, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </MacCard>
  );
}
