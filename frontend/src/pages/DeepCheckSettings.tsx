import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Plus, Search } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import {
  DeepCheckDefinitionForm,
  DeepCheckDefinitionList,
  DeepCheckRunHistory,
  NotificationSettingsPanel,
} from '@/components/daily-check';
import { useClusters } from '@/hooks/useCluster';
import {
  useCheckTypes,
  useDeepCheckDefinitions,
  useCreateDefinition,
  useUpdateDefinition,
} from '@/hooks/useDeepCheckDefinitions';
import type { DeepCheckDefinition } from '@/types';

const CATEGORY_LABELS: Record<string, string> = {
  all: '전체',
  k8s: 'K8s',
  os: 'OS',
  storage: '스토리지',
  network: '네트워크',
  app: '앱',
};

export function DeepCheckSettingsPage() {
  const { data: clusters = [] } = useClusters();
  const { data: checkTypes = [] } = useCheckTypes();
  const toast = useToast();
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [editing, setEditing] = useState<DeepCheckDefinition | null>(null);
  const [adding, setAdding] = useState(false);
  const [historyOf, setHistoryOf] = useState<DeepCheckDefinition | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');

  const filterClusterId = selectedClusterId ?? undefined;
  const { data: definitions = [] } = useDeepCheckDefinitions(filterClusterId, true, true);
  const create = useCreateDefinition();
  const update = useUpdateDefinition();

  const categoryByType = useMemo(
    () => new Map(checkTypes.map((t) => [t.checkType, t.category ?? 'k8s'])),
    [checkTypes],
  );

  const sorted = useMemo(() => {
    const term = search.trim().toLowerCase();
    return [...definitions]
      .filter((d) => {
        if (category !== 'all' && (categoryByType.get(d.checkType) ?? 'k8s') !== category) {
          return false;
        }
        if (!term) return true;
        return `${d.name} ${d.checkType} ${d.description ?? ''}`.toLowerCase().includes(term);
      })
      .sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
        return a.name.localeCompare(b.name);
      });
  }, [definitions, search, category, categoryByType]);

  const selectedCluster = clusters.find((c) => c.id === selectedClusterId);

  // 글로벌 정의를 현재 선택 클러스터 전용으로 복제 — 임계/파라미터를 그대로 이어받아
  // 운영자가 매번 다시 입력하지 않게 한다.
  const duplicateToCluster = async (d: DeepCheckDefinition) => {
    if (!selectedClusterId) return;
    try {
      await create.mutateAsync({
        clusterId: selectedClusterId,
        checkType: d.checkType,
        name: `${d.name} (${selectedCluster?.name ?? '클러스터'})`,
        description: d.description ?? null,
        enabled: d.enabled,
        scheduleCron: d.scheduleCron ?? null,
        thresholds: d.thresholds ?? null,
        params: d.params ?? null,
        sortOrder: d.sortOrder,
      });
      toast.success('복제됨', `${selectedCluster?.name ?? '클러스터'} 전용 정의를 생성했습니다.`);
    } catch (e) {
      toast.error('복제 실패', formatApiError(e));
    }
  };

  return (
    <div className="min-h-screen bg-background py-3 pr-3">
      <div className="flex gap-3">
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
            <div className="flex-1 min-w-0">
              <h1 className="text-lg font-semibold">점검 항목 관리 (Deep Check 정의)</h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                여기서 만든 정의가 <span className="font-medium">운영 점검</span> 콘솔의 카탈로그로 노출되고,
                활성 정의는 스케줄(cron)에 따라 자동 실행됩니다.
              </p>
            </div>
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

          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative max-w-xs">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="이름/타입/설명 검색"
                className="w-56 rounded-xl border border-border bg-card pl-7 pr-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="flex items-center gap-1">
              {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setCategory(key)}
                  className={`rounded-lg px-2.5 py-1 text-xs ${
                    category === key
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
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
                clusterId={editing.clusterId ?? selectedClusterId ?? undefined}
                onSubmit={async (body) => {
                  await update.mutateAsync({ id: editing.id, body });
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            </MacCard>
          )}

          {historyOf && (
            <DeepCheckRunHistory
              definition={historyOf}
              clusters={clusters}
              runClusterId={selectedClusterId}
              onClose={() => setHistoryOf(null)}
            />
          )}

          <DeepCheckDefinitionList
            definitions={sorted}
            onEdit={(d) => {
              setAdding(false);
              setEditing(d);
            }}
            onShowHistory={(d) => setHistoryOf(d)}
            runClusterId={selectedClusterId}
            onDuplicateToCluster={selectedClusterId ? duplicateToCluster : undefined}
          />

          <NotificationSettingsPanel />
        </div>
      </div>
    </div>
  );
}
