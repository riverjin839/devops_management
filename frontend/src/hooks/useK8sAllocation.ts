import { useQuery } from '@tanstack/react-query';

import { k8sAllocationApi } from '@/services/api';

// 백그라운드 집계가 진행 중(status==='computing')이면 1.5s 폴링, 완료되면 멈춘다.
const pollWhileComputing = (query: { state: { data?: { status?: string } } }) =>
  query.state.data?.status === 'computing' ? 1500 : false;

/** 노드별 allocatable vs request vs 사용량(slack). */
export function useAllocNodes(clusterId: string) {
  return useQuery({
    queryKey: ['alloc-nodes', clusterId],
    queryFn: async () => (await k8sAllocationApi.nodes(clusterId)).data,
    enabled: !!clusterId,
    staleTime: 30_000,
    retry: 1,
    refetchInterval: pollWhileComputing,
  });
}

/** 네임스페이스별 request/limit/usage 총합 + 클러스터 summary. */
export function useAllocNamespaces(clusterId: string) {
  return useQuery({
    queryKey: ['alloc-namespaces', clusterId],
    queryFn: async () => (await k8sAllocationApi.namespaces(clusterId)).data,
    enabled: !!clusterId,
    staleTime: 30_000,
    retry: 1,
    refetchInterval: pollWhileComputing,
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
