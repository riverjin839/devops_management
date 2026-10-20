import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { k8sEventsApi } from '@/services/api';

export const k8sEventKeys = {
  all: ['k8s-events'] as const,
  paged: (params?: object) => ['k8s-events', 'paged', params] as const,
  stats: (clusterId?: string | null) => ['k8s-events', 'stats', clusterId ?? null] as const,
  detail: (id: string) => ['k8s-events', id] as const,
};

interface UseK8sEventsParams {
  clusterId?: string;
  severity?: string;
  resourceKind?: string;
  limit?: number;
  offset?: number;
}

/**
 * 이벤트 목록 — 키셋 커서 페이지를 "더 보기"로 이어 붙인다(D-111: 예전엔 200건 고정이라 그 뒤는 열람 불가).
 * 직전 페이지 마지막 행 기준 커서로 읽으므로 페이지 사이 이벤트가 정리·삭제돼도 뒤쪽 행을 건너뛰지 않는다.
 * 키는 'k8s-events' 접두사를 유지해 삭제·분석 트리거 후 무효화가 그대로 걸린다.
 */
export function useK8sEventsPaged(params: Omit<UseK8sEventsParams, 'limit' | 'offset'> & { pageSize?: number }) {
  const { pageSize = 100, ...filters } = params;
  return useInfiniteQuery({
    queryKey: k8sEventKeys.paged({ ...filters, pageSize }),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      (await k8sEventsApi.list({ ...filters, limit: pageSize, cursor: pageParam ?? undefined })).data,
    getNextPageParam: (last) => (last.hasMore && last.nextCursor ? last.nextCursor : undefined),
    refetchInterval: 30_000,
  });
}

/** 심각도별 건수 — 목록의 심각도 필터·페이지와 무관한 서버 집계(D-111). */
export function useK8sEventStats(clusterId?: string | null) {
  return useQuery({
    queryKey: k8sEventKeys.stats(clusterId),
    queryFn: async () => (await k8sEventsApi.stats(clusterId)).data,
    refetchInterval: 30_000,
  });
}

export function useDeleteK8sEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => k8sEventsApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: k8sEventKeys.all });
    },
  });
}
