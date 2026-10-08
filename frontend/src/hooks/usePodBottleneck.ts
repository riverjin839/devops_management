import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { podBottleneckApi } from '@/services/api';
import type { BottleneckRunInput } from '@/types';

export const bottleneckKeys = {
  probes: () => ['bottleneckProbes'] as const,
  runs: (params?: Record<string, unknown>) => ['bottleneckRuns', params ?? {}] as const,
  run: (id: string) => ['bottleneckRun', id] as const,
};

export function useBottleneckProbes() {
  return useQuery({
    queryKey: bottleneckKeys.probes(),
    queryFn: async () => (await podBottleneckApi.listProbes()).data,
    staleTime: 10 * 60 * 1000, // 10분 — catalog 라 자주 안 바뀜
  });
}

/** 이력 목록 — "더 보기"로 offset 페이지를 이어 붙인다(D-094: 예전엔 50건 고정이라 그 뒤는 열람 불가).
 *  키는 'bottleneckRuns' 접두사를 유지해 실행·삭제 후 무효화가 그대로 걸린다. */
export function useBottleneckRunsPaged(params: { clusterId?: string; pageSize?: number }) {
  const pageSize = params.pageSize ?? 50;
  return useInfiniteQuery({
    queryKey: ['bottleneckRuns', 'paged', params.clusterId ?? null, pageSize] as const,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      (await podBottleneckApi.listRuns({ clusterId: params.clusterId, offset: pageParam, limit: pageSize })).data,
    getNextPageParam: (last) => (last.hasMore ? last.offset + last.data.length : undefined),
  });
}

export function useBottleneckRun(id: string | undefined) {
  return useQuery({
    queryKey: bottleneckKeys.run(id || ''),
    queryFn: async () => (await podBottleneckApi.getRun(id!)).data,
    enabled: !!id,
  });
}

export function useRunBottleneckAnalysis() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: BottleneckRunInput) => podBottleneckApi.runAnalysis(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bottleneckRuns'] });
    },
  });
}

export function useDeleteBottleneckRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => podBottleneckApi.deleteRun(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bottleneckRuns'] });
    },
  });
}
