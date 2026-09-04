import { useCallback, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';

import { k8sAllocationApi } from '@/services/api';
import type {
  AllocNodeRow, AllocNodesResponse, AllocNamespaceRow, AllocNamespacesResponse, AllocSnapshotMeta,
} from '@/types';

// 집계 중(status==='computing')에만 1.5s 폴링(누적 진행 표시). 그 외엔 멈춤 —
// 완료된 결과는 그대로 유지하고, 재집계는 명시적 새로고침/주기 갱신(force)으로만.
const pollWhileComputing = (query: { state: { data?: { status?: string } } }) =>
  query.state.data?.status === 'computing' ? 1500 : false;

// 자동 재페치(포커스/마운트/주기) 끔 → 백엔드 재집계가 멋대로 0부터 시작되는 일 방지.
// 데이터는 클라이언트 캐시로 유지(멀티워커 환경에서도 리셋 안 됨). placeholderData 로
// 클러스터 전환/재조회 중에도 직전 데이터를 유지해 카드가 blank-out 되지 않게 한다.
const HOLD_OPTS = {
  staleTime: Infinity,
  refetchOnWindowFocus: false,
  refetchOnMount: false,
  refetchOnReconnect: false,
  placeholderData: keepPreviousData,
  refetchInterval: pollWhileComputing,
  retry: 1,
};

/** 노드별 allocatable vs request vs 사용량(slack). */
export function useAllocNodes(clusterId: string) {
  return useQuery({
    queryKey: ['alloc-nodes', clusterId],
    queryFn: async () => (await k8sAllocationApi.nodes(clusterId)).data,
    enabled: !!clusterId,
    ...HOLD_OPTS,
  });
}

/** 네임스페이스별 request/limit/usage 총합 + 클러스터 summary. */
export function useAllocNamespaces(clusterId: string) {
  return useQuery({
    queryKey: ['alloc-namespaces', clusterId],
    queryFn: async () => (await k8sAllocationApi.namespaces(clusterId)).data,
    enabled: !!clusterId,
    ...HOLD_OPTS,
  });
}

export type AllocProgress = Pick<AllocSnapshotMeta, 'status' | 'progress' | 'processed' | 'total' | 'partial' | 'stale'>;
const selectProgress = (d: AllocNamespacesResponse): AllocProgress => ({
  status: d.status, progress: d.progress, processed: d.processed, total: d.total, partial: d.partial, stale: d.stale,
});

/** 페이지 루트용 경량 구독 — 같은 캐시(['alloc-namespaces'])에서 진행 메타만 select 해
 * 폴링마다 페이지 전체(요약·카드·활성 뷰)가 리렌더되지 않게 한다. */
export function useAllocProgress(clusterId: string) {
  return useQuery({
    queryKey: ['alloc-namespaces', clusterId],
    queryFn: async () => (await k8sAllocationApi.namespaces(clusterId)).data,
    enabled: !!clusterId,
    ...HOLD_OPTS,
    select: selectProgress,
  });
}

/** Pod 용량(스케줄 가능/전체/할당가능)·상태별(running/pending/error 등) 수 — 개요 스냅샷에서 파생. */
export function usePodsSummary(clusterId: string) {
  return useQuery({
    queryKey: ['alloc-pods-summary', clusterId],
    queryFn: async () => (await k8sAllocationApi.podsSummary(clusterId)).data,
    enabled: !!clusterId,
    ...HOLD_OPTS,
  });
}

/** 명시적 새로고침/주기 갱신 — namespaces 를 refresh=1 로 한 번만 강제(세 엔드포인트가 같은
 * 스냅샷 키를 공유하므로 두 번 강제하면 재집계가 겹친다) 하고, nodes/pods-summary 는 같은
 * 스냅샷을 읽어 캐시에 반영한다. isPending/error 를 노출해 버튼 스피너·실패 피드백에 쓴다. */
export function useForceAllocRefresh(clusterId: string) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: async () => {
      const ns = await k8sAllocationApi.namespaces(clusterId, true);
      const [n, ps] = await Promise.all([
        k8sAllocationApi.nodes(clusterId),
        k8sAllocationApi.podsSummary(clusterId),
      ]);
      return { n: n.data, ns: ns.data, ps: ps.data };
    },
    onSuccess: ({ n, ns, ps }) => {
      qc.setQueryData(['alloc-nodes', clusterId], n);
      qc.setQueryData(['alloc-namespaces', clusterId], ns);
      qc.setQueryData(['alloc-pods-summary', clusterId], ps);
    },
  });
  const { mutateAsync, isPending, isError, error } = mutation;
  // in-flight 여부는 ref 로 — refresh 의 참조를 안정적으로 유지해 호출부 effect 가 재생성되지 않게.
  const pendingRef = useRef(false);
  pendingRef.current = isPending;
  const refresh = useCallback(async () => {
    if (!clusterId || pendingRef.current) return;
    try {
      await mutateAsync();
    } catch { /* isError/error 로 조회 가능 — 호출부에서 처리 */ }
  }, [clusterId, mutateAsync]);
  return { refresh, isPending, isError, error };
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

/** 단일 네임스페이스 즉시 재계산 → alloc-namespaces 캐시의 해당 행만 patch. */
export function useRefreshAllocNamespace(clusterId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (namespace: string) => (await k8sAllocationApi.namespace(clusterId, namespace)).data,
    onSuccess: (res) => {
      const row = res.item as AllocNamespaceRow;
      qc.setQueryData<AllocNamespacesResponse>(['alloc-namespaces', clusterId], (prev) => {
        if (!prev) return prev;
        return { ...prev, items: prev.items.map((r) => (r.namespace === row.namespace ? row : r)) };
      });
    },
  });
}

/** NS 내 워크로드 집계 — 행 펼칠 때만 enabled(lazy 드릴다운). 포커스 복귀 재조회는 끈다
 * (펼친 행 수만큼 동시 재요청되던 문제). */
export function useAllocWorkloads(clusterId: string, namespace: string, enabled: boolean) {
  return useQuery({
    queryKey: ['alloc-workloads', clusterId, namespace],
    queryFn: async () => (await k8sAllocationApi.workloads(clusterId, namespace)).data,
    enabled: !!clusterId && !!namespace && enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
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
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
    retry: 1,
  });
}
