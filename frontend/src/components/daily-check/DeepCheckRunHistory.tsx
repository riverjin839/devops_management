import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Play, X } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ExecutionStepsTimeline } from '@/components/daily-check/ExecutionStepsTimeline';
import {
  useDefinitionResults,
  useRunDefinition,
} from '@/hooks/useDeepCheckDefinitions';
import type { Cluster, DeepCheckDefinition, DeepCheckExecStep, DeepCheckResult } from '@/types';

const PAGE_SIZE = 20;

const STATUS_DOT: Record<string, string> = {
  healthy: 'bg-emerald-500',
  warning: 'bg-amber-500',
  critical: 'bg-red-500',
  pending: 'bg-zinc-400',
};

const STATUS_FILTERS = ['all', 'healthy', 'warning', 'critical', 'pending'] as const;

/** 응답 인터셉터가 details._steps 키를 camelize(→ Steps) 하므로 둘 다 조회. */
function extractSteps(result: DeepCheckResult): DeepCheckExecStep[] | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const details = result.details as Record<string, any> | null | undefined;
  const raw = details?._steps ?? details?.Steps;
  return Array.isArray(raw) && raw.length > 0 ? (raw as DeepCheckExecStep[]) : undefined;
}

interface Props {
  definition: DeepCheckDefinition;
  clusters: Cluster[];
  /** 수동 실행 시 사용할 클러스터 (글로벌 정의일 때 필수) */
  runClusterId?: string | null;
  onClose: () => void;
}

/** 정의별 실행 이력 — 개별 실행의 단계 로그/상세 JSON 을 펼쳐볼 수 있다. */
export function DeepCheckRunHistory({ definition, clusters, runClusterId, onClose }: Props) {
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>('all');
  const [offset, setOffset] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading } = useDefinitionResults(definition.id, {
    limit: PAGE_SIZE,
    offset,
    status: statusFilter === 'all' ? undefined : statusFilter,
  });
  const run = useRunDefinition();

  const clusterName = useMemo(() => {
    const map = new Map(clusters.map((c) => [c.id, c.name]));
    return (id: string) => map.get(id) ?? id.slice(0, 8);
  }, [clusters]);

  const total = data?.total ?? 0;
  const results = data?.results ?? [];
  const effectiveRunClusterId = definition.clusterId ?? runClusterId ?? undefined;

  return (
    <MacCard title={`실행 이력 — ${definition.name}`} bodyPadding="p-0">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
        <div className="flex items-center gap-1">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setStatusFilter(s);
                setOffset(0);
              }}
              className={`rounded-lg px-2 py-1 text-xs ${
                statusFilter === s
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {s === 'all' ? '전체' : s}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground ml-1">총 {total}건</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => run.mutate({ id: definition.id, clusterId: effectiveRunClusterId })}
          disabled={run.isPending || !effectiveRunClusterId}
          title={
            effectiveRunClusterId
              ? '즉시 1회 실행하고 이력에 기록'
              : '글로벌 정의는 좌측에서 클러스터를 선택해야 실행할 수 있습니다'
          }
          className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50"
        >
          <Play className="w-3 h-3" />
          {run.isPending ? '실행 중…' : '지금 실행'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
          title="닫기"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {isLoading && (
        <div className="px-4 py-6 text-sm text-muted-foreground">이력을 불러오는 중…</div>
      )}
      {!isLoading && results.length === 0 && (
        <div className="px-4 py-6 text-sm text-muted-foreground italic">
          실행 이력이 없습니다. "지금 실행"으로 첫 기록을 남겨보세요.
        </div>
      )}

      <ul className="divide-y divide-border">
        {results.map((r) => {
          const expanded = expandedId === r.id;
          const steps = extractSteps(r);
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => setExpandedId(expanded ? null : r.id)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/40"
              >
                {expanded ? (
                  <ChevronDown className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />
                )}
                <span
                  className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${STATUS_DOT[r.status] ?? 'bg-zinc-400'}`}
                  title={r.status}
                />
                <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">
                  {r.checkedAt ? new Date(r.checkedAt).toLocaleString() : '-'}
                </span>
                <span className="text-xs text-muted-foreground bg-muted rounded px-1.5 py-0.5 whitespace-nowrap">
                  {clusterName(r.clusterId)}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{r.message ?? '-'}</span>
                <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                  {r.durationMs}ms
                </span>
              </button>
              {expanded && (
                <div className="px-4 pb-3 space-y-2">
                  {steps ? (
                    <ExecutionStepsTimeline steps={steps} />
                  ) : (
                    <div className="text-xs text-muted-foreground italic">
                      단계 로그가 없는 실행입니다 (구버전 결과 또는 비계측 체커).
                    </div>
                  )}
                  {r.details && (
                    <details>
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        상세(JSON)
                      </summary>
                      <pre className="mt-1 rounded-lg bg-muted p-2 overflow-x-auto max-h-64 text-xs">
                        {JSON.stringify(r.details, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border text-xs">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            className="rounded-lg border border-border px-2.5 py-1 hover:bg-muted disabled:opacity-40"
          >
            이전
          </button>
          <span className="text-muted-foreground">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} / {total}
          </span>
          <button
            type="button"
            disabled={offset + PAGE_SIZE >= total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            className="rounded-lg border border-border px-2.5 py-1 hover:bg-muted disabled:opacity-40"
          >
            다음
          </button>
        </div>
      )}
    </MacCard>
  );
}
