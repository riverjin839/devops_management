import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/common/PageHeader';
import { useNavigate } from 'react-router-dom';
import { Database, Plus, AlertCircle } from 'lucide-react';
import { ClusterSidebar, EmptyState, PageShell, RunLogPanel, Skeleton } from '@/components/common';
import { useRunLog } from '@/hooks/useRunLog';
import { useLogPref } from '@/hooks/useLogPref';
import { useClusters } from '@/hooks/useCluster';
import {
  useLakeServices,
  useLakeServiceTypes,
  useRunLakeServiceCheck,
} from '@/hooks/useLakeServices';
import {
  LakeServiceCard,
  AddLakeServiceModal,
  runLakeCheckLogged,
} from '@/components/lake-services';
import type { LakeService } from '@/types';

type CategoryFilter = 'all' | 'catalog' | 'runtime' | 'analytics';

const CATEGORY_LABEL: Record<Exclude<CategoryFilter, 'all'>, string> = {
  catalog: '카탈로그',
  runtime: '런타임',
  analytics: '분석',
};

export function LakeServicesPage() {
  const navigate = useNavigate();
  const { data: clusters = [] } = useClusters();
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [addOpen, setAddOpen] = useState(false);

  const { data: types = [] } = useLakeServiceTypes();
  const typeLabelMap = useMemo(
    () => Object.fromEntries(types.map((t) => [t.serviceType, t.label])),
    [types],
  );

  const { data: listData, isLoading, error } = useLakeServices({
    clusterId: selectedClusterId ?? undefined,
    category: category === 'all' ? undefined : category,
    limit: 200,
  });
  const services = listData?.data ?? [];

  const runCheck = useRunLakeServiceCheck();

  const handleCardClick = (svc: LakeService) => {
    navigate(`/lake-services/${svc.id}`);
  };

  // 카드의 "지금 점검" — 페이지 상단 실행 로그 하나에 어느 서비스인지 제목으로 남긴다(D-128).
  const runLog = useRunLog();
  const [showRunLog, setShowRunLog] = useLogPref('lake-services-check');
  const handleRunCheck = async (svc: LakeService) => {
    await runLakeCheckLogged(runLog, {
      name: svc.name,
      endpoint: svc.endpointUrl,
      call: async () => (await runCheck.mutateAsync(svc.id)).data,
    });
  };

  // 카테고리별 카운트 (filter chip 보조) — listData?.data 를 직접 의존
  const allServices = useMemo(() => listData?.data ?? [], [listData?.data]);
  const countsByCategory = useMemo(() => {
    const c = { catalog: 0, runtime: 0, analytics: 0 };
    for (const s of allServices) {
      if (s.category in c) c[s.category as keyof typeof c]++;
    }
    return c;
  }, [allServices]);

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
        <div className="sticky top-4 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={selectedClusterId}
            onSelect={setSelectedClusterId}
            allowAll
            allLabel="전체 클러스터"
            iconOnly
          />
        </div>

        <div className="flex-1 min-w-0 space-y-4">
          {/* Header */}
          <div className="flex items-center gap-3 flex-wrap">
            <PageHeader
              icon={Database}
              title="LAKE 서비스"
              description="K8s 위의 LAKE 도메인 OSS (airflow / spark / iceberg / trino / starrocks / jupyterlab / superset / polaris) 모니터링"
              className="flex-1 min-w-[180px]"
            />
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              aria-label="LAKE 서비스 등록"
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-sm font-semibold hover:opacity-90"
            >
              <Plus className="w-3.5 h-3.5" />
              서비스 등록
            </button>
          </div>

          {/* Category filter chips */}
          <div className="flex items-center gap-2 flex-wrap">
            <FilterChip
              label="전체"
              count={allServices.length}
              active={category === 'all'}
              onClick={() => setCategory('all')}
            />
            {(['catalog', 'runtime', 'analytics'] as const).map((c) => (
              <FilterChip
                key={c}
                label={CATEGORY_LABEL[c]}
                count={countsByCategory[c]}
                active={category === c}
                onClick={() => setCategory(c)}
              />
            ))}
          </div>

          <RunLogPanel run={runLog} show={showRunLog} onShowChange={setShowRunLog} />

          {/* Error state */}
          {error && (
            <div className="rounded-md border border-status-critical/40 bg-status-critical/5 p-3 flex items-start gap-2 text-sm text-status-critical">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-medium">LAKE 서비스 조회 실패</div>
                <div className="text-sm text-muted-foreground mt-0.5">
                  {error instanceof Error ? error.message : 'API 호출 중 오류'} — 페이지를 새로고침하거나 잠시 후 다시 시도하세요.
                </div>
              </div>
            </div>
          )}

          {/* Loading state */}
          {isLoading && (
            <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="block w-full h-32 rounded-md" />
              ))}
            </div>
          )}

          {/* Empty state */}
          {!isLoading && !error && services.length === 0 && (
            <EmptyState
              icon={Database}
              title="등록된 LAKE 서비스 없음"
              description="「서비스 등록」으로 엔드포인트를 추가하면 여기서 상태를 모니터링하고 즉시 점검할 수 있습니다."
              action={{ label: '서비스 등록', onClick: () => setAddOpen(true) }}
            />
          )}

          {/* Cards grid */}
          {!isLoading && services.length > 0 && (
            <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
              {services.map((s) => (
                <LakeServiceCard
                  key={s.id}
                  service={s}
                  typeLabel={typeLabelMap[s.serviceType]}
                  onClick={handleCardClick}
                  onRunCheck={handleRunCheck}
                  isChecking={runCheck.isPending && runCheck.variables === s.id}
                />
              ))}
            </div>
          )}
        </div>
      </PageShell>

      <AddLakeServiceModal
        open={addOpen}
        defaultClusterId={selectedClusterId ?? undefined}
        onClose={() => setAddOpen(false)}
        onCreated={(id) => navigate(`/lake-services/${id}`)}
      />
    </div>
  );
}

function FilterChip({
  label, count, active, onClick,
}: {
  label: string; count: number; active: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium border transition-colors
        ${active
          ? 'bg-primary text-primary-foreground border-primary'
          : 'bg-card text-muted-foreground border-border hover:text-foreground hover:bg-secondary/60'}`}
    >
      {label}
      <span className={`text-xs font-mono ${active ? 'opacity-80' : 'opacity-60'}`}>
        {count}
      </span>
    </button>
  );
}
