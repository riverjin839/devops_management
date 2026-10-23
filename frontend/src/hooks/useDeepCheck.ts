import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { deepCheckApi } from '@/services/api';

export const deepCheckKeys = {
  results: (clusterId: string) => ['deepCheckResults', clusterId] as const,
  latest: (clusterId: string) => ['deepCheckResults', clusterId, 'latest'] as const,
  review: (id: string) => ['deepCheckReview', id] as const,
  trend: (clusterId: string, days: number) =>
    ['deepCheckTrend', clusterId, days] as const,
};

export function useDeepCheckReview(dailyCheckLogId: string | undefined) {
  return useQuery({
    queryKey: deepCheckKeys.review(dailyCheckLogId || ''),
    queryFn: async () => {
      const { data } = await deepCheckApi.review(dailyCheckLogId!);
      return data;
    },
    enabled: !!dailyCheckLogId,
  });
}

export function useDailyCheckTrend(clusterId: string | undefined, days = 7) {
  return useQuery({
    queryKey: deepCheckKeys.trend(clusterId || '', days),
    queryFn: async () => {
      const { data } = await deepCheckApi.trend(clusterId!, days);
      return data;
    },
    enabled: !!clusterId,
  });
}

export function useRegenerateReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dailyCheckLogId: string) =>
      deepCheckApi.regenerateReview(dailyCheckLogId),
    onSuccess: (_, dailyCheckLogId) => {
      qc.invalidateQueries({ queryKey: deepCheckKeys.review(dailyCheckLogId) });
    },
  });
}

export function useRunDeepCheckNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (clusterId: string) => deepCheckApi.runNow(clusterId),
    onSuccess: (_, clusterId) => {
      qc.invalidateQueries({ queryKey: deepCheckKeys.latest(clusterId) });
      qc.invalidateQueries({ queryKey: deepCheckKeys.results(clusterId) });
    },
  });
}
