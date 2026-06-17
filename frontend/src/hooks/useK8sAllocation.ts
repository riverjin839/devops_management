import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';

import { k8sAllocationApi } from '@/services/api';
import type { AllocNodeRow, AllocNodesResponse } from '@/types';

// 집계 중(status==='computing')이면 1.5s 폴링; 아니면 autoMs(자동갱신 간격) 또는 멈춤.
function refetchIntervalFor(autoMs: number | false) {
  return (query: { state: { data?: { status?: string } } }) =>
    query.state.data?.status === 'computing' ? 1500 : (autoMs || false);
}

/** 노드별 allocatable vs request vs 사용량(slack). autoMs: 자동갱신 간격(ms) 또는 false. */
export function useAllocNodes(clusterId: string, autoMs: number | false = false) {
  return useQuery({
    queryKey: ['alloc-nodes', clusterId],
    queryFn: async () => (await k8sAllocationApi.nodes(clusterId)).data,
    enabled: !!clusterId,
    staleTime: 30_000,
    retry: 1,
    placeholderData: keepPreviousData,  // refetch/클러스터 변경 시 이전 데이터 유지(화면 안 사라짐)
    refetchInterval: refetchIntervalFor(autoMs),
  });
}

/** 네임스페이스별 request/limit/usage 총합 + 클러스터 summary. */
export function useAllocNamespaces(clusterId: string, autoMs: number | false = false) {
  return useQuery({
    queryKey: ['alloc-namespaces', clusterId],
    queryFn: async () => (await k8sAllocationApi.namespaces(clusterId)).data,
    enabled: !!clusterId,
    staleTime: 30_000,
    retry: 1,
    placeholderData: keepPreviousData,
    refetchInterval: refetchIntervalFor(autoMs),
  });
}

/** 단일 노드 즉시 재계산(개별 REFRESH) → alloc-nodes 캐시의 해당 행만 patch. */
export function useRefreshAllocNode(clusterId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (node: string) => (await k8sAllocationApi.node(clusterId, node)).data,
    onSuccess: (res) => {
      const row = res.item as AllocNodeRow;
      qc.setQueryData<AllocNodesResponse>(['alloc-nodes', clusterId], (prev) => {
        if (!prev) return prev;
        return { ...prev, items: prev.items.map((r) => (r.name === row.name ? row : r)) };
      });
    },
  });
}

/** NS 내 워크로드 집계 — 행 펼칠 때만 enabled(lazy 드릴다운). */
export function useAllocWorkloads(clusterId: string, namespace: string, enabled: boolean) {
  return useQuery({
    queryKey: ['alloc-workloads', clusterId, namespace],
    queryFn: async () => (await k8sAllocationApi.workloads(clusterId, namespace)).data,
    enabled: !!clusterId && !!namespace && enabled,
    staleTime: 30_000,
    retry: 1,
  });
}

/** 워크로드 소속 파드/컨테이너 — 행 펼칠 때만 enabled(lazy 드릴다운). */
export function useAllocPods(
  clusterId: string,
  namespace: string,
  kind: string,
  name: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['alloc-pods', clusterId, namespace, kind, name],
    queryFn: async () => (await k8sAllocationApi.pods(clusterId, namespace, kind, name)).data,
    enabled: !!clusterId && !!namespace && !!kind && !!name && enabled,
    staleTime: 30_000,
    retry: 1,
  });
}
