import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { dailyCheckApi } from '@/services/api';
import { deepCheckKeys } from '@/hooks/useDeepCheck';

export const dailyCheckKeys = {
  latest: (clusterId: string) => ['dailyCheckLatest', clusterId] as const,
  logs: (clusterId: string, limit: number) =>
    ['dailyCheckLogs', clusterId, limit] as const,
};

export function useLatestDailyCheckLog(clusterId: string | undefined) {
  return useQuery({
    queryKey: dailyCheckKeys.latest(clusterId || ''),
    queryFn: async () => {
      try {
        const { data } = await dailyCheckApi.latestLog(clusterId!);
        return data;
      } catch {
        // 점검 기록 없음 — 404 가 정상 케이스. null 반환해서 UI 가 empty state 표시.
        return null;
      }
    },
    enabled: !!clusterId,
  });
}

export function useDailyCheckLogs(
  clusterId: string | undefined,
  limit = 20,
) {
  return useQuery({
    queryKey: dailyCheckKeys.logs(clusterId || '', limit),
    queryFn: async () => {
      try {
        const { data } = await dailyCheckApi.listLogs(clusterId!, { limit });
        return data;
      } catch {
        return [];
      }
    },
    enabled: !!clusterId,
  });
}

export function useRunDailyCheckNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (clusterId: string) => dailyCheckApi.runNow(clusterId),
    onSuccess: (_, clusterId) => {
      qc.invalidateQueries({ queryKey: dailyCheckKeys.latest(clusterId) });
      qc.invalidateQueries({ queryKey: ['dailyCheckLogs', clusterId] });
      // deep-check 가 daily log 와 묶여 있어 함께 invalidate
      qc.invalidateQueries({ queryKey: deepCheckKeys.latest(clusterId) });
    },
  });
}
