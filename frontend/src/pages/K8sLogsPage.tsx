import { useEffect, useId, useState } from 'react';
import { PageHeader } from '@/components/common/PageHeader';
import { useSearchParams } from 'react-router-dom';
import { useClusterRouteParam } from '@/hooks/useClusterRouteParam';
import { ScrollText } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { PageShell } from '@/components/common/PageShell';
import {
  EmptyState, ErrorState, LogViewTabs, NamespaceSingleSelect, PodSingleSelect, SelectClusterEmptyState,
} from '@/components/common';
import { PodLogStream } from '@/components/k8s';
import { useClusters } from '@/hooks/useCluster';
import { useTerminalEnvSync } from '@/hooks/useTerminalEnvSync';
import type { Cluster } from '@/types';

const NO_CLUSTERS: Cluster[] = [];

/**
 * 파드 로그 페이지(메뉴 "파드 로그" — 화면 안 탭 이름만 "실시간 로그", D-191).
 * OpenLens P0 → freelens 파리티 고도화.
 * `?namespace=&pod=&container=` 쿼리 파라미터 딥링크를 지원한다 —
 * K8s 관리 콘솔의 파드 목록 "로그" 버튼에서 진입 시 자동으로 스트림을 시작.
 */
export function K8sLogsPage() {
  const clustersQ = useClusters();
  const clusters = clustersQ.data ?? NO_CLUSTERS;
  // 클러스터 선택은 URL(`/k8s-logs/:clusterId`)에 담기지만, 아일랜드 패널로 임베드되면
  // URL 이동이 앱 전체를 아일랜드 밖으로 끌고 나가므로 로컬 state 로 대체된다.
  const { clusterId, selectCluster } = useClusterRouteParam('/k8s-logs', clusters);
  // 로그 색 프로파일(개발/운영)을 이 화면의 클러스터 등급으로 — 다른 콘솔의 마지막 등급을 따라가지 않게(D-187 ⑤)
  useTerminalEnvSync(clusters, clusterId || null);
  const [searchParams] = useSearchParams();
  const fid = useId();

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
  const clustersFailed = clustersQ.isError && clusters.length === 0;

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" as="div" className="flex gap-3">
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
            <PageHeader
              back={{ to: '/', label: '홈' }}
              icon={ScrollText}
              title={cluster ? `${cluster.name} — 파드 로그` : '파드 로그'}
              className="min-w-[180px]"
            />
            <div className="flex-1" />
            <LogViewTabs current="stream" />
          </div>

          <MacCard
            title="로그 스트림"
            bodyPadding="p-4"
            actions={
              <>
                <div className="flex items-center gap-1.5">
                  <label htmlFor={`${fid}-ns`} className="text-xs text-muted-foreground">네임스페이스</label>
                  <div className="min-w-[200px] text-sm">
                    <NamespaceSingleSelect
                      id={`${fid}-ns`}
                      clusterId={clusterId}
                      value={namespace}
                      onChange={(ns) => { setNamespace(ns); setPod(''); }}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <label htmlFor={`${fid}-pod`} className="text-xs text-muted-foreground">파드</label>
                  <div className="min-w-[240px] text-sm">
                    <PodSingleSelect
                      id={`${fid}-pod`}
                      clusterId={clusterId}
                      namespace={namespace}
                      value={pod}
                      onChange={setPod}
                    />
                  </div>
                </div>
              </>
            }
          >
            {clustersFailed ? (
              // 클러스터 목록 실패를 "파드를 고르세요" 빈 상태로 보이지 않게(D-188)
              <ErrorState
                error={clustersQ.error}
                title="클러스터 목록을 불러오지 못했습니다"
                onRetry={() => { void clustersQ.refetch(); }}
              />
            ) : !clusterId ? (
              <SelectClusterEmptyState />
            ) : namespace && pod ? (
              <PodLogStream
                key={`${clusterId}/${namespace}/${pod}`}
                clusterId={clusterId}
                namespace={namespace}
                pod={pod}
                autoStart={deepLinked}
                initialContainer={deepLinked && qsContainer ? qsContainer : undefined}
              />
            ) : (
              <EmptyState
                icon={ScrollText}
                title="스트림할 파드를 고르세요"
                description="헤더에서 네임스페이스와 파드를 선택하면 로그를 실시간으로 받아 옵니다."
              />
            )}
          </MacCard>
        </div>
      </PageShell>
    </div>
  );
}
