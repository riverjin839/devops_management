import { useState } from 'react';
import { Pencil, Trash2, Power, PowerOff, Globe2 } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { useUpdateDefinition, useDeleteDefinition } from '@/hooks/useDeepCheckDefinitions';
import type { DeepCheckDefinition } from '@/types';

interface Props {
  definitions: DeepCheckDefinition[];
  onEdit: (d: DeepCheckDefinition) => void;
}

export function DeepCheckDefinitionList({ definitions, onEdit }: Props) {
  const update = useUpdateDefinition();
  const remove = useDeleteDefinition();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const toggle = (d: DeepCheckDefinition) => {
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
    if (!window.confirm('이 정의를 삭제하시겠습니까?')) return;
    setDeletingId(id);
    try {
      await remove.mutateAsync(id);
    } finally {
      setDeletingId(null);
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
                <span className="truncate">{d.name}</span>
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
                {d.thresholds && (
                  <span className="truncate">
                    임계: {JSON.stringify(d.thresholds)}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onEdit(d)}
              className="flex-shrink-0 rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              title="편집"
            >
              <Pencil className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => del(d.id)}
              disabled={deletingId === d.id}
              className="flex-shrink-0 rounded-lg p-1.5 text-red-500 hover:bg-red-500/10 disabled:opacity-50"
              title="삭제"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </li>
        ))}
      </ul>
    </MacCard>
  );
}
