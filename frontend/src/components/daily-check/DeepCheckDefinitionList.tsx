import { useState } from 'react';
import {
  Copy,
  CopyPlus,
  Globe2,
  History,
  Pencil,
  Play,
  Power,
  PowerOff,
  Trash2,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import {
  useDeleteDefinition,
  useDuplicateDefinition,
  useRunDefinition,
  useUpdateDefinition,
} from '@/hooks/useDeepCheckDefinitions';
import type { DeepCheckDefinition } from '@/types';
import { parseUTC } from '@/lib/utils';

const STATUS_DOT: Record<string, string> = {
  healthy: 'bg-emerald-500',
  warning: 'bg-amber-500',
  critical: 'bg-red-500',
  pending: 'bg-zinc-400',
};

interface Props {
  definitions: DeepCheckDefinition[];
  onEdit: (d: DeepCheckDefinition) => void;
  onShowHistory: (d: DeepCheckDefinition) => void;
  /** 글로벌 정의를 즉시 실행할 때 사용할 클러스터 (사이드바 선택) */
  runClusterId?: string | null;
  /** 글로벌 정의를 현재 선택 클러스터 전용으로 복제 — 제공 시 글로벌 행에 복제 버튼 노출. */
  onDuplicateToCluster?: (d: DeepCheckDefinition) => void;
}

export function DeepCheckDefinitionList({
  definitions,
  onEdit,
  onShowHistory,
  runClusterId,
  onDuplicateToCluster,
}: Props) {
  const update = useUpdateDefinition();
  const remove = useDeleteDefinition();
  const duplicate = useDuplicateDefinition();
  const run = useRunDefinition();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const toggle = (d: DeepCheckDefinition) => {
    // 글로벌 정의를 끄면 전 클러스터에 영향 → 실수 방지용 확인.
    if (d.enabled && !d.clusterId) {
      if (!window.confirm(`"${d.name}" 은 글로벌 정의입니다. 비활성화하면 모든 클러스터에서 이 점검이 cron 실행되지 않습니다. 계속할까요?`)) {
        return;
      }
    }
    update.mutate({
      id: d.id,
      body: {
        clusterId: d.clusterId ?? null,
        checkType: d.checkType,
        name: d.name,
        description: d.description ?? null,
        enabled: !d.enabled,
        scheduleCron: d.scheduleCron ?? null,
        thresholds: d.thresholds ?? null,
        params: d.params ?? null,
        sortOrder: d.sortOrder,
      },
    });
  };

  const del = async (id: string) => {
    if (!window.confirm('이 정의를 삭제하시겠습니까? (실행 이력은 남습니다)')) return;
    setDeletingId(id);
    try {
      await remove.mutateAsync(id);
    } finally {
      setDeletingId(null);
    }
  };

  const runNow = async (d: DeepCheckDefinition) => {
    const clusterId = d.clusterId ?? runClusterId ?? undefined;
    if (!clusterId) {
      window.alert('글로벌 정의는 좌측 사이드바에서 클러스터를 선택한 뒤 실행할 수 있습니다.');
      return;
    }
    setRunningId(d.id);
    try {
      await run.mutateAsync({ id: d.id, clusterId });
      onShowHistory(d);
    } finally {
      setRunningId(null);
    }
  };

  if (definitions.length === 0) {
    return (
      <MacCard title="Deep Check 정의">
        <div className="text-sm text-muted-foreground italic">
          정의가 없습니다. 우측 상단의 "추가" 버튼으로 새 deep check 정의를 생성하세요.
        </div>
      </MacCard>
    );
  }

  return (
    <MacCard title="Deep Check 정의" bodyPadding="p-0">
      <ul className="divide-y divide-border">
        {definitions.map((d) => (
          <li key={d.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40">
            <button
              type="button"
              onClick={() => toggle(d)}
              title={d.enabled ? '비활성화' : '활성화'}
              aria-label={d.enabled ? `${d.name} 비활성화` : `${d.name} 활성화`}
              className={`flex-shrink-0 rounded-lg p-1.5 ${
                d.enabled
                  ? 'text-emerald-600 hover:bg-emerald-500/10'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {d.enabled ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                {d.lastStatus && (
                  <span
                    className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${STATUS_DOT[d.lastStatus] ?? 'bg-zinc-400'}`}
                    title={`최근 실행: ${d.lastStatus}`}
                  />
                )}
                <span className="truncate">{d.name}</span>
                {!d.enabled && (
                  <span
                    title="비활성 — cron 미실행, 수동 실행만 가능"
                    className="text-xs rounded px-1.5 py-0.5 bg-muted text-muted-foreground border border-border"
                  >
                    비활성
                  </span>
                )}
                {!d.clusterId && (
                  <span
                    title="글로벌 (모든 클러스터)"
                    className="inline-flex items-center gap-1 text-xs uppercase tracking-wider text-muted-foreground bg-muted rounded px-1.5 py-0.5"
                  >
                    <Globe2 className="w-3 h-3" />
                    글로벌
                  </span>
                )}
                <span className="text-xs font-mono text-muted-foreground bg-muted rounded px-1.5 py-0.5">
                  {d.checkType}
                </span>
              </div>
              {d.description && (
                <div className="text-sm text-muted-foreground truncate mt-0.5">
                  {d.description}
                </div>
              )}
              <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                {d.scheduleCron && (
                  <span className="font-mono">cron: {d.scheduleCron}</span>
                )}
                {d.lastCheckedAt && (
                  <span>
                    최근 {parseUTC(d.lastCheckedAt).toLocaleString()}
                    {d.lastDurationMs != null && ` · ${d.lastDurationMs}ms`}
                  </span>
                )}
                {d.lastMessage && (
                  <span className="truncate max-w-[24rem]" title={d.lastMessage}>
                    {d.lastMessage}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => runNow(d)}
              disabled={runningId === d.id}
              className="flex-shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              title="즉시 실행 (이력에 기록)"
              aria-label={`${d.name} 즉시 실행`}
            >
              <Play className={`w-4 h-4 ${runningId === d.id ? 'animate-pulse' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => onShowHistory(d)}
              className="flex-shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="실행 이력 / 개별 로그"
              aria-label={`${d.name} 실행 이력`}
            >
              <History className="w-4 h-4" />
            </button>
            {onDuplicateToCluster && !d.clusterId && (
              <button
                type="button"
                onClick={() => onDuplicateToCluster(d)}
                className="flex-shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                title="이 클러스터 전용으로 복제"
                aria-label={`${d.name} 클러스터 전용 복제`}
              >
                <CopyPlus className="w-4 h-4" />
              </button>
            )}
            <button
              type="button"
              onClick={() => duplicate.mutate(d.id)}
              disabled={duplicate.isPending}
              className="flex-shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              title="복제 (비활성 상태로 생성)"
              aria-label={`${d.name} 복제`}
            >
              <Copy className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => onEdit(d)}
              className="flex-shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="편집"
              aria-label={`${d.name} 편집`}
            >
              <Pencil className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => del(d.id)}
              disabled={deletingId === d.id}
              className="flex-shrink-0 rounded-lg p-1.5 text-red-500 hover:bg-red-500/10 disabled:opacity-50"
              title="삭제"
              aria-label={`${d.name} 삭제`}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </li>
        ))}
      </ul>
    </MacCard>
  );
}
