// NIC 상태 — 서버 상태(TanStack Query). 에이전트 보고 주기(기본 60초)마다 다시 읽는다.
// 대형 클러스터(노드 수백 대)를 위해 목록은 서버에서 필터·페이지하고, 행 상세는 펼칠 때만 읽는다.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { nicWatchApi } from '@/services/api';
import type { NicViewQuery, NicWatchSettings } from '@/types';

const REFETCH_MS = 60_000;

export function useNicWatch(clusterId: string, query: NicViewQuery = {}, enabled = true) {
  return useQuery({
    queryKey: ['nic-watch', 'cluster', clusterId, query],
    queryFn: async () => (await nicWatchApi.cluster(clusterId, query)).data,
    enabled: !!clusterId && enabled,
    refetchInterval: REFETCH_MS,
    placeholderData: keepPreviousData,
  });
}

/** 레일 상태 점용 — 요약만(인터페이스 행 없음). */
export function useNicWatchSummary(clusterId: string) {
  return useNicWatch(clusterId, { limit: 0 });
}

export function useNicInterfaceDetail(clusterId: string, node: string, iface: string, enabled: boolean) {
  return useQuery({
    queryKey: ['nic-watch', 'detail', clusterId, node, iface],
    queryFn: async () => (await nicWatchApi.interfaceDetail(clusterId, node, iface)).data,
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
