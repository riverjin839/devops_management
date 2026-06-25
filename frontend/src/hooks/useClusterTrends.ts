import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { clusterTrendsApi } from '@/services/api';
import type { TrendMetricKey, TrendRange } from '@/types';

interface Params {
  range: TrendRange;
  metrics: TrendMetricKey[];
  nodes: string[];
}

/**
 * per-node 메트릭 추이. 노드를 1개 이상 선택해야 조회된다(과수집 방지).
 * autoMs > 0 이면 주기적 갱신, 기본은 off.
 */
export function useClusterTrends(clusterId: string, p: Params, autoMs = 0) {
  const metrics = [...p.metrics].sort();
  const nodes = [...p.nodes].sort();
  return useQuery({
    queryKey: ['cluster-trends', clusterId, p.range, metrics.join(','), nodes.join(',')],
    queryFn: async () =>
      (await clusterTrendsApi.get(clusterId, { range: p.range, metrics, nodes })).data,
    enabled: !!clusterId && nodes.length > 0 && metrics.length > 0,
    placeholderData: keepPreviousData,
    refetchInterval: autoMs > 0 ? autoMs : false,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
