// NIC 상태 — 서버 상태(TanStack Query). 에이전트 보고 주기(기본 60초)마다 다시 읽는다.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { nicWatchApi } from '@/services/api';
import type { NicWatchSettings } from '@/types';

const REFETCH_MS = 60_000;

export function useNicWatch(clusterId: string, enabled = true) {
  return useQuery({
    queryKey: ['nic-watch', 'cluster', clusterId],
    queryFn: async () => (await nicWatchApi.cluster(clusterId)).data,
    enabled: !!clusterId && enabled,
    refetchInterval: REFETCH_MS,
  });
}

export function useNicWatchSettings(open: boolean) {
  return useQuery({
    queryKey: ['nic-watch', 'settings'],
    queryFn: async () => (await nicWatchApi.settings()).data,
    enabled: open,
  });
}

export function useUpdateNicWatchSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Partial<NicWatchSettings>) => (await nicWatchApi.updateSettings(body)).data,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['nic-watch'] }); },
  });
}
