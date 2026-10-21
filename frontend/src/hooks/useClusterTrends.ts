import { useQuery } from '@tanstack/react-query';
import { clusterTrendsApi } from '@/services/api';
import type { ClusterTrendsResponse, TrendMetricKey, TrendRange } from '@/types';

interface Params {
  range: TrendRange;
  metrics: TrendMetricKey[];
  nodes: string[];
}

/**
 * per-node 메트릭 추이. 노드를 1개 이상 선택해야 조회된다(과수집 방지).
 *
 * - D-184 ②: 이전 결과는 **같은 클러스터**일 때만 자리표시로 남긴다(시간창·지표·노드 변경 중
 *   깜빡임 방지). 클러스터가 바뀌면 이전 클러스터 차트를 새 클러스터 이름 아래 그리지 않는다.
 * - D-184 ⑤: `autoMs > 0` 이면 주기 갱신. 탭이 숨겨지면 멈춘다(`refetchIntervalInBackground: false`).
 */
export function useClusterTrends(clusterId: string, p: Params, autoMs = 0) {
  const metrics = [...p.metrics].sort();
  const nodes = [...p.nodes].sort();
  return useQuery({
    queryKey: ['cluster-trends', clusterId, p.range, metrics.join(','), nodes.join(',')],
    queryFn: async () =>
      (await clusterTrendsApi.get(clusterId, { range: p.range, metrics, nodes })).data,
    enabled: !!clusterId && nodes.length > 0 && metrics.length > 0,
    placeholderData: (prev: ClusterTrendsResponse | undefined, prevQuery) =>
      prevQuery?.queryKey[1] === clusterId ? prev : undefined,
    refetchInterval: autoMs > 0 ? autoMs : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
