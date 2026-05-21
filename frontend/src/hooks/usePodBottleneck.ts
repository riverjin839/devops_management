import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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

export function useBottleneckRuns(params?: {
  clusterId?: string;
  namespace?: string;
  sourcePod?: string;
  destPod?: string;
  offset?: number;
  limit?: number;
}) {
  return useQuery({
    queryKey: bottleneckKeys.runs(params),
    queryFn: async () => (await podBottleneckApi.listRuns(params)).data,
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
