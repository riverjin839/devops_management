// 외부 서비스(도메인·IP:Port) — 공개 조회(비인증) + 설정(admin) 서버 상태(TanStack Query).
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { externalServicesApi } from '@/services/api';
import type { ExternalServicesSettings } from '@/types';

export function useExternalServiceClusters() {
  return useQuery({
    queryKey: ['external-services-clusters'],
    queryFn: async () => (await externalServicesApi.clusters()).data,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useExternalServices(clusterId: string) {
  return useQuery({
    queryKey: ['external-services', clusterId],
    queryFn: async () => (await externalServicesApi.view(clusterId)).data,
    enabled: !!clusterId,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useExternalServicesSettings(enabled: boolean) {
  return useQuery({
    queryKey: ['external-services-settings'],
    queryFn: async () => (await externalServicesApi.settings()).data,
    enabled,
  });
}

export function useSaveExternalServicesSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Partial<ExternalServicesSettings>) => (await externalServicesApi.putSettings(body)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['external-services-settings'] });
      void qc.invalidateQueries({ queryKey: ['external-services-clusters'] });
      void qc.invalidateQueries({ queryKey: ['external-services'] });
    },
  });
}
