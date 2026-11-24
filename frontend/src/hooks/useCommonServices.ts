// 공통 서비스(/common-services) 서버 상태 — 카탈로그·인스턴스·설정·변경·실행 이력·감시 설정.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { commonServicesApi } from '@/services/api';
import type { CommonServiceInstanceInput, CommonServiceWatchSettings } from '@/types';

const KEY = 'common-services';
/** 주기 수집 결과가 들어오는 걸 화면이 따라가도록(감시 주기는 분 단위). */
const REFETCH_MS = 60_000;

export function useCommonServiceCatalog() {
  return useQuery({
    queryKey: [KEY, 'catalog'],
    queryFn: async () => (await commonServicesApi.catalog()).data.services,
    staleTime: 10 * 60_000,
  });
}

export function useCommonServiceStatus() {
  return useQuery({
    queryKey: [KEY, 'status'],
    queryFn: async () => (await commonServicesApi.status()).data.services,
    refetchInterval: REFETCH_MS,
  });
}

export function useCommonServiceInstances(serviceType: string) {
  return useQuery({
    queryKey: [KEY, 'instances', serviceType],
    queryFn: async () => (await commonServicesApi.instances(serviceType)).data.items,
    enabled: !!serviceType,
    placeholderData: keepPreviousData,
    refetchInterval: REFETCH_MS,
  });
}

export function useCommonServiceConfig(id: string | null) {
  return useQuery({
    queryKey: [KEY, 'config', id],
    queryFn: async () => (await commonServicesApi.config(id as string)).data,
    enabled: !!id,
    refetchInterval: REFETCH_MS,
  });
}

export function useCommonServiceChanges(id: string | null) {
  return useQuery({
    queryKey: [KEY, 'changes', id],
    queryFn: async () => (await commonServicesApi.changes(id as string)).data.items,
    enabled: !!id,
    refetchInterval: REFETCH_MS,
  });
}

export function useCommonServiceRuns(id: string | null) {
  return useQuery({
    queryKey: [KEY, 'runs', id],
    queryFn: async () => (await commonServicesApi.runs(id as string)).data.items,
    enabled: !!id,
    refetchInterval: REFETCH_MS,
  });
}

export function useCommonServiceRun(id: string | null, runId: string | null) {
  return useQuery({
    queryKey: [KEY, 'run', id, runId],
    queryFn: async () => (await commonServicesApi.run(id as string, runId as string)).data,
    enabled: !!id && !!runId,
  });
}

export function useInvalidateCommonServices() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: [KEY] });
}

export function useSaveCommonService() {
  const invalidate = useInvalidateCommonServices();
  return useMutation({
    mutationFn: async ({ id, body }: { id?: string; body: CommonServiceInstanceInput }) =>
      (id ? await commonServicesApi.update(id, body) : await commonServicesApi.create(body)).data,
    onSuccess: () => invalidate(),
  });
}

export function useDeleteCommonService() {
  const invalidate = useInvalidateCommonServices();
  return useMutation({
    mutationFn: async (id: string) => (await commonServicesApi.remove(id)).data,
    onSuccess: () => invalidate(),
  });
}

export function useDiscoverCommonServices() {
  return useMutation({
    mutationFn: async (body: { clusterId: string; namespace?: string | null; serviceType?: string | null }) =>
      (await commonServicesApi.discover(body)).data.items,
  });
}

export function useCommonServiceWatchSettings() {
  return useQuery({
    queryKey: [KEY, 'watch-settings'],
    queryFn: async () => (await commonServicesApi.watchSettings()).data,
  });
}

export function useUpdateCommonServiceWatchSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Partial<CommonServiceWatchSettings>) => (await commonServicesApi.updateWatchSettings(body)).data,
    onSuccess: (data) => qc.setQueryData([KEY, 'watch-settings'], data),
  });
}
