import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useClusterRouteParam } from '@/hooks/useClusterRouteParam';
import { Link } from 'react-router-dom';
import { ArrowLeft, ScrollText } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { LogViewTabs, NamespaceSingleSelect, PodSingleSelect } from '@/components/common';
import { PodLogStream } from '@/components/k8s';
import { useClusters } from '@/hooks/useCluster';

/**
 * 실시간 파드 로그 페이지 (OpenLens P0 → freelens 파리티 고도화).
 * `?namespace=&pod=&container=` 쿼리 파라미터 딥링크를 지원한다 —
 * K8s 관리 콘솔의 파드 목록 "로그" 버튼에서 진입 시 자동으로 스트림을 시작.
 */
export function K8sLogsPage() {
  const { data: clusters = [] } = useClusters();
  // 클러스터 선택은 URL(`/k8s-logs/:clusterId`)에 담기지만, 아일랜드 패널로 임베드되면
  // URL 이동이 앱 전체를 아일랜드 밖으로 끌고 나가므로 로컬 state 로 대체된다.
  const { clusterId, selectCluster } = useClusterRouteParam('/k8s-logs', clusters);
  const [searchParams] = useSearchParams();

  const qsNamespace = searchParams.get('namespace') ?? '';
  const qsPod = searchParams.get('pod') ?? '';
  const qsContainer = searchParams.get('container') ?? '';


  const cluster = clusters.find((c) => c.id === clusterId);

  const [namespace, setNamespace] = useState(qsNamespace);
  const [pod, setPod] = useState(qsPod);

  // 클러스터 변경 시 선택 초기화 (딥링크 파라미터는 최초 마운트에만 적용)
  useEffect(() => {
    setNamespace(qsNamespace);
    setPod(qsPod);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId]);

  const deepLinked = !!(qsNamespace && qsPod && namespace === qsNamespace && pod === qsPod);

  return (
    <div className="min-h-screen bg-background py-3 pr-3">
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
          <div className="flex items-center gap-3 flex-wrap">
            <Link to="/" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted">
              <ArrowLeft className="w-3.5 h-3.5" /> 대시보드
            </Link>
            <h1 className="text-lg font-semibold min-w-[180px] flex items-center gap-2">
              <ScrollText className="w-4 h-4 text-primary" />
              {cluster ? `${cluster.name} — 실시간 로그` : '실시간 로그'}
            </h1>
            <div className="flex-1" />
            <LogViewTabs current="stream" />
          </div>

          <MacCard title="로그 스트림" bodyPadding="p-4">
            {/* 대상 선택 */}
            <div className="flex items-end gap-2 flex-wrap mb-3">
              <div className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">네임스페이스</span>
                <div className="min-w-[200px]">
                  <NamespaceSingleSelect
                    clusterId={clusterId}
                    value={namespace}
                    onChange={(ns) => { setNamespace(ns); setPod(''); }}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">파드</span>
                <div className="min-w-[240px]">
                  <PodSingleSelect
                    clusterId={clusterId}
                    namespace={namespace}
                    value={pod}
                    onChange={setPod}
                  />
                </div>
              </div>
            </div>

            {namespace && pod ? (
              <PodLogStream
                key={`${clusterId}/${namespace}/${pod}`}
                clusterId={clusterId}
                namespace={namespace}
                pod={pod}
                autoStart={deepLinked}
                initialContainer={deepLinked && qsContainer ? qsContainer : undefined}
              />
            ) : (
              <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                네임스페이스와 파드를 선택하세요.
              </div>
            )}
          </MacCard>
        </div>
      </div>
    </div>
  );
}
