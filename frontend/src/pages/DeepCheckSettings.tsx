import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Plus } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import {
  DeepCheckDefinitionForm,
  DeepCheckDefinitionList,
  NotificationSettingsPanel,
} from '@/components/daily-check';
import { useClusters } from '@/hooks/useCluster';
import {
  useDeepCheckDefinitions,
  useCreateDefinition,
  useUpdateDefinition,
} from '@/hooks/useDeepCheckDefinitions';
import type { DeepCheckDefinition } from '@/types';

export function DeepCheckSettingsPage() {
  const { data: clusters = [] } = useClusters();
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [editing, setEditing] = useState<DeepCheckDefinition | null>(null);
  const [adding, setAdding] = useState(false);

  const filterClusterId = selectedClusterId ?? undefined;
  const { data: definitions = [] } = useDeepCheckDefinitions(filterClusterId, true);
  const create = useCreateDefinition();
  const update = useUpdateDefinition();

  const sorted = useMemo(
    () =>
      [...definitions].sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.name.localeCompare(b.name);
      }),
    [definitions],
  );

  return (
    <div className="min-h-screen bg-background p-5">
      <div className="flex gap-4 max-w-[1400px] mx-auto">
        <div className="sticky top-4 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={selectedClusterId}
            onSelect={setSelectedClusterId}
            allowAll
            allLabel="글로벌 + 전체"
            iconOnly
          />
        </div>
        <div className="flex-1 min-w-0 space-y-4">
          <div className="flex items-center gap-3">
            <Link
              to="/"
              className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              대시보드
            </Link>
            <h1 className="text-lg font-semibold flex-1">Deep Check 정의 관리</h1>
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setAdding((v) => !v);
              }}
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium hover:opacity-90"
            >
              <Plus className="w-3.5 h-3.5" />
              {adding ? '닫기' : '정의 추가'}
            </button>
          </div>

          {adding && (
            <MacCard title="새 정의">
              <DeepCheckDefinitionForm
                clusterId={selectedClusterId ?? undefined}
                onSubmit={async (body) => {
                  await create.mutateAsync(body);
                  setAdding(false);
                }}
                onCancel={() => setAdding(false)}
              />
            </MacCard>
          )}

          {editing && (
            <MacCard title={`편집 — ${editing.name}`}>
              <DeepCheckDefinitionForm
                initial={editing}
                clusterId={editing.clusterId ?? undefined}
                onSubmit={async (body) => {
                  await update.mutateAsync({ id: editing.id, body });
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            </MacCard>
          )}

          <DeepCheckDefinitionList definitions={sorted} onEdit={(d) => setEditing(d)} />

          <NotificationSettingsPanel />
        </div>
      </div>
    </div>
  );
}
