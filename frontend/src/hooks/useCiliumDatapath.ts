// Cilium 데이터패스 — 서버 상태(TanStack Query). 에이전트가 주기적으로 보고하므로 클러스터 화면은 폴링한다.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ciliumDatapathApi } from '@/services/api';
import type { CiliumDatapathSettings } from '@/types';

export const ciliumDatapathKeys = {
  all: ['cilium-datapath'] as const,
  view: (clusterId: string) => ['cilium-datapath', 'view', clusterId] as const,
  manifest: (clusterId: string) => ['cilium-datapath', 'manifest', clusterId] as const,
  settings: ['cilium-datapath', 'settings'] as const,
};

export function useCiliumDatapath(clusterId: string) {
  return useQuery({
    queryKey: ciliumDatapathKeys.view(clusterId),
    queryFn: async () => (await ciliumDatapathApi.view(clusterId)).data,
    enabled: !!clusterId,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useCiliumDatapathManifest(clusterId: string, enabled: boolean) {
  return useQuery({
    queryKey: ciliumDatapathKeys.manifest(clusterId),
    queryFn: async () => (await ciliumDatapathApi.manifest(clusterId)).data,
    enabled: enabled && !!clusterId,
    staleTime: 60_000,
  });
}

export function useCiliumDatapathSettings() {
  return useQuery({
    queryKey: ciliumDatapathKeys.settings,
    queryFn: async () => (await ciliumDatapathApi.settings()).data,
    staleTime: 60_000,
  });
}

/** 설정·에이전트 변경 뒤 이 화면의 서버 상태를 모두 다시 읽는다(판정이 임계치에 따라 바뀐다). */
function useInvalidateAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ciliumDatapathKeys.all });
}

export function useUpdateCiliumDatapathSettings() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: async (body: Partial<Omit<CiliumDatapathSettings, 'tokenConfigured'>>) =>
      (await ciliumDatapathApi.updateSettings(body)).data,
    onSuccess: invalidate,
  });
}

export function useSetCiliumProgramBaseline(clusterId: string) {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: async (agentId: string) => (await ciliumDatapathApi.setBaseline(clusterId, agentId)).data,
    onSuccess: invalidate,
  });
}

export function useDeleteCiliumBpfAgent(clusterId: string) {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: async (agentId: string) => { await ciliumDatapathApi.deleteAgent(clusterId, agentId); },
    onSuccess: invalidate,
  });
}
