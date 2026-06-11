import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { serviceTopologyApi } from '@/services/api';

export interface TopologyGraphOptions {
  includePods?: boolean;
  includeOrphans?: boolean;
  withMetrics?: boolean;
}

/** (cluster, namespace) 자동 발견 그래프 + 수동 엣지/외부 노드 병합본. */
export function useServiceTopologyGraph(
  clusterId: string | null,
  namespace: string,
  opts: TopologyGraphOptions,
) {
  return useQuery({
    queryKey: ['serviceTopology', 'graph', clusterId, namespace, opts.includePods, opts.includeOrphans, opts.withMetrics],
    queryFn: async () => (await serviceTopologyApi.getGraph(clusterId!, namespace, opts)).data,
    enabled: !!clusterId && !!namespace,
    staleTime: 1000 * 15,
  });
}

/** 실트래픽 엣지(Hubble→conntrack). 수동 trigger 전용(자동 폴링 없음). */
export function useServiceTopologyTraffic(
  clusterId: string | null,
  namespace: string,
  enabled: boolean,
  opts?: { sinceSeconds?: number; limit?: number },
) {
  return useQuery({
    queryKey: ['serviceTopology', 'traffic', clusterId, namespace, opts?.sinceSeconds, opts?.limit],
    queryFn: async () => (await serviceTopologyApi.getTraffic(clusterId!, namespace, opts)).data,
    enabled: enabled && !!clusterId && !!namespace,
    staleTime: 1000 * 5,
    refetchOnWindowFocus: false,
  });
}

function useInvalidateGraph() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['serviceTopology', 'graph'] });
}

export function useCreateTopologyLink(clusterId: string) {
  const invalidate = useInvalidateGraph();
  return useMutation({
    mutationFn: (data: {
      namespace: string; sourceKind: string; sourceName: string;
      targetKind: string; targetName: string; linkType: string;
      label?: string | null; note?: string | null;
    }) => serviceTopologyApi.createLink(clusterId, data),
    onSuccess: invalidate,
  });
}

export function useUpdateTopologyLink() {
  const invalidate = useInvalidateGraph();
  return useMutation({
    mutationFn: ({ linkId, data }: {
      linkId: string; data: { linkType?: string; label?: string | null; note?: string | null };
    }) => serviceTopologyApi.updateLink(linkId, data),
    onSuccess: invalidate,
  });
}

export function useDeleteTopologyLink() {
  const invalidate = useInvalidateGraph();
  return useMutation({
    mutationFn: (linkId: string) => serviceTopologyApi.deleteLink(linkId),
    onSuccess: invalidate,
  });
}

export function useCreateExternalNode(clusterId: string) {
  const invalidate = useInvalidateGraph();
  return useMutation({
    mutationFn: (data: { namespace: string; name: string; nodeType: string; note?: string | null }) =>
      serviceTopologyApi.createExternalNode(clusterId, data),
    onSuccess: invalidate,
  });
}

export function useDeleteExternalNode() {
  const invalidate = useInvalidateGraph();
  return useMutation({
    mutationFn: (nodeId: string) => serviceTopologyApi.deleteExternalNode(nodeId),
    onSuccess: invalidate,
  });
}
