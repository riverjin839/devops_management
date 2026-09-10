import { Link } from 'react-router-dom';
import { ArrowLeft, ClipboardCheck, Settings, AlertTriangle, Loader2 } from 'lucide-react';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { MacCard } from '@/components/ui/MacCard';
import { StatusBadge, statusToVariant } from '@/components/common/StatusBadge';
import { useClusters, useClusterStatusBreakdown } from '@/hooks/useCluster';
import { useClusterRouteParam } from '@/hooks/useClusterRouteParam';
import { ClusterOpsCheckPanel } from '@/components/ops-check';
import { parseUTC } from '@/lib/utils';
import type { ClusterStatusContributor } from '@/types';

const SOURCE_LABEL: Record<ClusterStatusContributor['sourceType'], string> = {
  core_bundle: '핵심 점검 번들', addon: '애드온', deep_check: '심층 점검',
};

function ContributorRow({ c }: { c: ClusterStatusContributor }) {
  return (
    <div className="flex items-center gap-2 py-1.5 px-1 text-sm">
      <StatusBadge variant={statusToVariant(c.status)} size="sm" />
      <span className="text-xs rounded-full border border-border px-1.5 py-0.5 text-muted-foreground shrink-0">
        {SOURCE_LABEL[c.sourceType] ?? c.sourceType}
      </span>
      <span className="font-medium truncate max-w-[220px]">{c.name}</span>
      {c.message && <span className="text-muted-foreground truncate flex-1 min-w-0">{c.message}</span>}
      {c.checkedAt && (
        <span className="text-xs text-muted-foreground/70 font-mono ml-auto shrink-0">
          {parseUTC(c.checkedAt).toLocaleString()}
        </span>
      )}
    </div>
  );
}

/**
 * 클러스터 상세 — 종합 상태(원인 목록) + 점검 카탈로그(등록된 모든 실행 기술)를 한 화면에.
 * 매트릭스 재편 로드맵 3단계(F3): `PlatformStatusMatrix` 의 클러스터명 클릭이 여기로 온다.
 * 카탈로그/실행/로그는 `ClusterOpsCheckPanel`(구 `/ops-checks/:clusterId` 에서 추출) 재사용.
 */
export function ClusterDetailPage() {
  const { data: clusters = [] } = useClusters();
  const { clusterId, selectCluster } = useClusterRouteParam('/clusters', clusters);
  const cluster = clusters.find((c) => c.id === clusterId);

  const { data: breakdown, isLoading: breakdownLoading, isError: breakdownError } =
    useClusterStatusBreakdown(clusterId || undefined);

  return (
    <div className="app-min-h-screen bg-background py-3 pr-3">
      <div className="flex gap-3">
        <div className="sticky top-4 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            onSelect={selectCluster}
            iconOnly
          />
        </div>

        <div className="flex-1 min-w-0 space-y-4">
          {/* header */}
          <div className="flex items-center gap-3 flex-wrap">
            <Link to="/" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted">
              <ArrowLeft className="w-3.5 h-3.5" /> 대시보드
            </Link>
            <h1 className="text-lg font-semibold flex-1 min-w-[200px]">
              {cluster ? `${cluster.name} — 클러스터 상세` : '클러스터 상세'}
            </h1>
            {clusterId && (
              <>
                <Link to={`/daily-check/review/${clusterId}`} className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted">
                  <ClipboardCheck className="w-3.5 h-3.5" /> 결과 리뷰
                </Link>
                <Link to="/daily-check/settings" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted">
                  <Settings className="w-3.5 h-3.5" /> 점검 항목 관리
                </Link>
              </>
            )}
          </div>

          {/* 종합 상태 */}
          <MacCard title="종합 상태">
            {breakdownLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                <Loader2 className="w-4 h-4 animate-spin" /> 불러오는 중…
              </div>
            ) : breakdownError || !breakdown ? (
              <div className="flex items-center gap-2 text-sm text-destructive py-4">
                <AlertTriangle className="w-4 h-4" /> 종합 상태를 불러오지 못했습니다.
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <StatusBadge variant={statusToVariant(breakdown.status)} />
                  <span className="text-sm text-muted-foreground">
                    {breakdown.contributors.length === 0
                      ? '아직 점검 결과가 없습니다.'
                      : `${breakdown.contributors.length}개 신호를 종합한 결과입니다.`}
                  </span>
                </div>
                {breakdown.contributors.length > 0 && (
                  <div className="divide-y divide-border/50 border-t border-border pt-1">
                    {breakdown.contributors.map((c, i) => (
                      <ContributorRow key={`${c.sourceType}-${c.sourceRef}-${i}`} c={c} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </MacCard>

          <ClusterOpsCheckPanel clusterId={clusterId} clusterName={cluster?.name} />
        </div>
      </div>
    </div>
  );
}
