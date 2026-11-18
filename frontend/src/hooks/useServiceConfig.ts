// 서비스 구성 — 서버 상태(TanStack Query). 현재 값은 수집 스냅샷에서 오므로 수집 모달이 끝나면 무효화한다.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { serviceConfigApi } from '@/services/api';

export function useServiceConfigServices() {
  return useQuery({
    queryKey: ['service-config', 'services'],
    queryFn: async () => (await serviceConfigApi.services()).data.items,
    staleTime: 5 * 60_000,
  });
}

export function useServiceConfigView(clusterId: string, service: string, version?: number) {
  return useQuery({
    queryKey: ['service-config', 'view', clusterId, service, version ?? 'latest'],
    queryFn: async () => (await serviceConfigApi.view(clusterId, service, version)).data,
    enabled: !!clusterId && !!service,
    placeholderData: keepPreviousData,
  });
}

/** 수집·가져오기 뒤 이 화면의 서버 상태를 다시 읽는다. */
export function useInvalidateServiceConfig() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['service-config'] });
}

export function useImportServiceConfig(clusterId: string, service: string) {
  const invalidate = useInvalidateServiceConfig();
  return useMutation({
    mutationFn: async () => (await serviceConfigApi.importCurrent(clusterId, service)).data,
    onSuccess: invalidate,
  });
}
