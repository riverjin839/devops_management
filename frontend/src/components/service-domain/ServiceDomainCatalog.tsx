import { useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Plus, AlertCircle, Settings2 } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useServiceCategories } from '@/hooks/useServiceCategories';
import { useLakeServices, useLakeServiceTypeRows, useRunLakeServiceCheck } from '@/hooks/useLakeServices';
import { LakeServiceCard } from '@/components/lake-services';
import { CategoryRail } from './CategoryRail';
import { AddServiceInstanceModal } from './AddServiceInstanceModal';
import type { LakeService, ServiceDomain } from '@/types';

interface ServiceDomainCatalogProps {
  domain: ServiceDomain;
  title: string;
  description: string;
}

/** PEP 서비스 / APP 서비스 공용 카탈로그 화면 — 좌측 카테고리 레일(Runtime/Catalog/Workflow/
 *  JupyterLab 등) 클릭 시 우측에 해당 카테고리 하위 서비스 인스턴스가 표시된다.
 *  카테고리 자체의 추가/편집은 Settings → "관리 서비스" 탭의 PEP/APP 서브탭에서 관리한다. */
export function ServiceDomainCatalog({ domain, title, description }: ServiceDomainCatalogProps) {
  const navigate = useNavigate();
  const { data: clusters = [] } = useClusters();
  const { data: categoriesResp } = useServiceCategories(domain, { enabled: true });
  const categories = useMemo(() => categoriesResp?.data ?? [], [categoriesResp]);
  const { data: typeRows } = useLakeServiceTypeRows({ domain, enabled: true, limit: 200 });
  const types = useMemo(() => typeRows?.data ?? [], [typeRows]);

  const [selectedCategoryKey, setSelectedCategoryKey] = useState<string | null>(null);
  const [selectedClusterId, setSelectedClusterId] = useState<string>('');
  const [addOpen, setAddOpen] = useState(false);

  const typeLabelMap = useMemo(
    () => Object.fromEntries(types.map((t) => [t.serviceType, t.label])),
    [types],
  );
  const typeCategoryMap = useMemo(
    () => Object.fromEntries(types.map((t) => [t.serviceType, t.categoryId ?? null])),
    [types],
  );
  const selectedCategory = categories.find((c) => c.key === selectedCategoryKey) ?? null;

  const { data: listData, isLoading, error } = useLakeServices({ domain, limit: 500 });
  const allServices = useMemo(() => listData?.data ?? [], [listData]);

  // category_id/cluster_id 쿼리 파라미터는 axios 가 camelCase 로 보내 백엔드 snake_case 필터와
  // 어긋날 수 있어(기존 코드베이스 공통 이슈) 안전하게 클라이언트에서 필터링한다.
  const services = useMemo(() => {
    return allServices.filter((s) => {
      if (selectedClusterId && s.clusterId !== selectedClusterId) return false;
      if (selectedCategory && typeCategoryMap[s.serviceType] !== selectedCategory.id) return false;
      return true;
    });
  }, [allServices, selectedClusterId, selectedCategory, typeCategoryMap]);

  const countByCategoryKey = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of allServices) {
      const catId = typeCategoryMap[s.serviceType];
      const cat = categories.find((c) => c.id === catId);
      if (cat) counts[cat.key] = (counts[cat.key] ?? 0) + 1;
    }
    return counts;
  }, [allServices, typeCategoryMap, categories]);

  const runCheck = useRunLakeServiceCheck();

  const handleCardClick = (svc: LakeService) => navigate(`/lake-services/${svc.id}`);
  const handleRunCheck = (svc: LakeService) => runCheck.mutate(svc.id);

  return (
    <div className="min-h-screen bg-background">
      <main className="pr-3 py-3 flex gap-3">
        <CategoryRail
          categories={categories}
          selectedKey={selectedCategoryKey}
          onSelect={setSelectedCategoryKey}
          allLabel="전체"
        />

        <div className="flex-1 min-w-0 space-y-4">
          {/* Header */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex-1 min-w-[180px]">
              <h1 className="text-lg font-semibold">{title}</h1>
              <p className="text-sm text-muted-foreground">{description}</p>
            </div>
            <select
              value={selectedClusterId}
              onChange={(e) => setSelectedClusterId(e.target.value)}
              aria-label="클러스터 필터"
              className="rounded-xl border border-border bg-background px-3 py-1.5 text-sm"
            >
              <option value="">전체 클러스터</option>
              {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <Link
              to="/settings?tab=mgmt-service"
              className="inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary"
            >
              <Settings2 className="w-3.5 h-3.5" />
              카테고리 관리
            </Link>
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              aria-label="서비스 등록"
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-sm font-semibold hover:opacity-90"
            >
              <Plus className="w-3.5 h-3.5" />
              서비스 등록
            </button>
          </div>

          {/* Category chip summary (모바일/좁은 화면에서 레일 대체 보조 정보) */}
          {categories.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap text-sm text-muted-foreground">
              {categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelectedCategoryKey(c.key === selectedCategoryKey ? null : c.key)}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 border transition-colors ${
                    selectedCategoryKey === c.key
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-card border-border hover:text-foreground hover:bg-secondary/60'
                  }`}
                >
                  {c.label}
                  <span className="text-xs font-mono opacity-70">{countByCategoryKey[c.key] ?? 0}</span>
                </button>
              ))}
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-500/40 bg-red-500/5 p-3 flex items-start gap-2 text-sm text-red-600 dark:text-red-400">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-medium">서비스 조회 실패</div>
                <div className="text-sm text-muted-foreground mt-0.5">
                  {error instanceof Error ? error.message : 'API 호출 중 오류'} — 페이지를 새로고침하거나 잠시 후 다시 시도하세요.
                </div>
              </div>
            </div>
          )}

          {isLoading && (
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-32 rounded-md bg-muted/30 animate-pulse" />
              ))}
            </div>
          )}

          {!isLoading && !error && categories.length === 0 && (
            <div className="text-center py-16 text-muted-foreground text-sm">
              <Settings2 className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
              <p className="mb-2">등록된 카테고리가 없습니다.</p>
              <p className="text-sm text-muted-foreground/70">
                <Link to="/settings?tab=mgmt-service" className="text-primary hover:underline">
                  카테고리 관리
                </Link>
                에서 Runtime/Catalog 같은 상위 카테고리를 먼저 추가하세요.
              </p>
            </div>
          )}

          {!isLoading && !error && categories.length > 0 && services.length === 0 && (
            <div className="text-center py-16 text-muted-foreground text-sm">
              <p className="mb-2">등록된 서비스가 없습니다.</p>
              <p className="text-sm text-muted-foreground/70">
                상단의 <strong>"서비스 등록"</strong> 버튼으로 인스턴스를 추가하세요.
              </p>
            </div>
          )}

          {!isLoading && services.length > 0 && (
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
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
      </main>

      <AddServiceInstanceModal
        open={addOpen}
        domain={domain}
        categories={categories}
        defaultClusterId={selectedClusterId || undefined}
        defaultCategoryKey={selectedCategoryKey}
        onClose={() => setAddOpen(false)}
        onCreated={(id) => navigate(`/lake-services/${id}`)}
      />
    </div>
  );
}
