// NIC 상태 — 서버 상태(TanStack Query). 에이전트 보고 주기(기본 60초)마다 다시 읽는다.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { nicWatchApi } from '@/services/api';
import type { NicWatchSettings } from '@/types';

type ClusterSettingsBody = Partial<NicWatchSettings> & { resetFields?: string[] };

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

/** 이 클러스터의 실효 기준 + 공통 기준 + 재정의한 항목. */
export function useNicClusterSettings(clusterId: string, open: boolean) {
  return useQuery({
    queryKey: ['nic-watch', 'cluster-settings', clusterId],
    queryFn: async () => (await nicWatchApi.clusterSettings(clusterId)).data,
    enabled: !!clusterId && open,
  });
}

export function useUpdateNicClusterSettings(clusterId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ClusterSettingsBody) => (await nicWatchApi.updateClusterSettings(clusterId, body)).data,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['nic-watch'] }); },
  });
}

export function useClearNicClusterSettings(clusterId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await nicWatchApi.clearClusterSettings(clusterId)).data,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['nic-watch'] }); },
  });
}

/** 보고된 구성에서 뽑은 기준 제안("관측 값으로 채우기"). */
export function useNicObserved(clusterId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['nic-watch', 'observed', clusterId],
    queryFn: async () => (await nicWatchApi.observed(clusterId)).data,
    enabled: !!clusterId && enabled,
  });
}

/** 재정의한 클러스터 목록(공통 기준 탭). */
export function useNicOverrides(enabled: boolean) {
  return useQuery({
    queryKey: ['nic-watch', 'overrides'],
    queryFn: async () => (await nicWatchApi.overrides()).data,
    enabled,
  });
}
