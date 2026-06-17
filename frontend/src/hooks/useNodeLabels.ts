import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query';
import { nodeLabelsApi } from '@/services/api';

export interface NodeInfo {
  name: string;
  labels: Record<string, string>;
  taints: string[];
  role: string;
  status: string;
}

/** 여러 클러스터를 취합할 때 각 노드에 출처 클러스터를 붙인 행. */
export interface NodeRow extends NodeInfo {
  clusterId: string;
  clusterName: string;
}

export interface NodeLabelPatchPayload {
  add: Record<string, string>;
  remove: string[];
}

export const nodeLabelKeys = {
  list: (clusterId: string) => ['nodes', clusterId] as const,
};

export function useNodeList(clusterId: string) {
  return useQuery({
    queryKey: nodeLabelKeys.list(clusterId),
    queryFn: async () => {
      const { data } = await nodeLabelsApi.getNodes(clusterId);
      return data.data as NodeInfo[];
    },
    enabled: !!clusterId,
    refetchInterval: 60000,
    placeholderData: keepPreviousData,
  });
}

/**
 * 여러 클러스터의 노드를 한 번에 취합한다 (전 노드 대상).
 * - 각 클러스터별로 독립 쿼리 → 한 클러스터가 실패해도 나머지는 그대로 표시(부분 결과).
 * - keepPreviousData 로 주기적 refetch 시 깜빡임(로딩 blank) 방지.
 * - 노드명은 클러스터 간 충돌 가능하므로 clusterId/clusterName 을 함께 보관.
 */
export function useClustersNodes(
  clusters: { id: string; name: string }[],
  opts: { autoRefresh?: boolean; intervalMs?: number } = {},
) {
  const { autoRefresh = true, intervalMs = 60000 } = opts;
  const results = useQueries({
    queries: clusters.map((c) => ({
      queryKey: nodeLabelKeys.list(c.id),
      queryFn: async () => {
        const { data } = await nodeLabelsApi.getNodes(c.id);
        return data.data as NodeInfo[];
      },
      enabled: !!c.id,
      // 자동 새로고침 토글 — 끄면 주기 refetch 중단 (수동 버튼으로만 갱신).
      refetchInterval: autoRefresh ? intervalMs : (false as const),
      refetchOnWindowFocus: autoRefresh,
      placeholderData: keepPreviousData,
      staleTime: 20000,
    })),
  });

  const nodes: NodeRow[] = [];
  results.forEach((r, i) => {
    const c = clusters[i];
    if (!c) return;
    for (const n of r.data ?? []) {
      nodes.push({ ...n, clusterId: c.id, clusterName: c.name });
    }
  });

  const errors = results
    .map((r, i) => ({ cluster: clusters[i], error: r.error as unknown }))
    .filter((e) => e.error);

  return {
    nodes,
    // 초기 로딩(아직 아무 노드도 없을 때)만 true — 백그라운드 refetch 는 깜빡이지 않게.
    isLoading: nodes.length === 0 && results.some((r) => r.isLoading),
    isFetching: results.some((r) => r.isFetching),
    errors,
    // 모든 클러스터가 실패하고 노드가 0 일 때만 전체 에러로 본다(일부 실패는 부분 표시).
    isError: clusters.length > 0 && errors.length === clusters.length && nodes.length === 0,
    // 수동 새로고침 — 대상 클러스터 전부 refetch.
    refetch: () => results.forEach((r) => r.refetch()),
  };
}

/** 노드 라벨 patch — 노드마다 출처 클러스터가 다를 수 있어 clusterId 를 mutate 시점에 받는다. */
export function usePatchNodeLabels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ clusterId, nodeName, payload }: { clusterId: string; nodeName: string; payload: NodeLabelPatchPayload }) =>
      nodeLabelsApi.patchNodeLabels(clusterId, nodeName, payload),
    onSuccess: (_data, { clusterId }) => {
      queryClient.invalidateQueries({ queryKey: nodeLabelKeys.list(clusterId) });
    },
  });
}
