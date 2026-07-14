import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { lakeServicesApi, lakeServiceTypesApi } from '@/services/api';
import type {
  LakeServiceInput, LakeServiceUpdate,
  LakeServiceTypeInput, LakeServiceTypeUpdate,
} from '@/types';

// Query key 정책 — invalidate 시 prefix 일치만 보면 됨.
export const lakeServiceKeys = {
  types: () => ['lakeServiceTypes'] as const,
  list: (params?: Record<string, unknown>) => ['lakeServices', params ?? {}] as const,
  detail: (id: string) => ['lakeService', id] as const,
  checks: (id: string, params?: Record<string, unknown>) =>
    ['lakeServiceChecks', id, params ?? {}] as const,
};

export function useLakeServiceTypes() {
  return useQuery({
    queryKey: lakeServiceKeys.types(),
    queryFn: async () => (await lakeServicesApi.listTypes()).data,
    staleTime: 5 * 60 * 1000, // 5분 — 코드 catalog 라 자주 안 바뀜
  });
}

export function useLakeServices(params?: {
  clusterId?: string;
  serviceType?: string;
  category?: string;
  enabled?: boolean;
  domain?: string;
  offset?: number;
  limit?: number;
}) {
  return useQuery({
    queryKey: lakeServiceKeys.list(params),
    queryFn: async () => (await lakeServicesApi.list(params)).data,
  });
}

export function useLakeService(id: string | undefined) {
  return useQuery({
    queryKey: lakeServiceKeys.detail(id || ''),
    queryFn: async () => (await lakeServicesApi.get(id!)).data,
    enabled: !!id,
  });
}

export function useLakeServiceChecks(
  id: string | undefined,
  params?: { offset?: number; limit?: number },
) {
  return useQuery({
    queryKey: lakeServiceKeys.checks(id || '', params),
    queryFn: async () => (await lakeServicesApi.listChecks(id!, params)).data,
    enabled: !!id,
  });
}

export function useCreateLakeService() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: LakeServiceInput) => lakeServicesApi.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lakeServices'] });
    },
  });
}

export function useUpdateLakeService() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: LakeServiceUpdate }) =>
      lakeServicesApi.update(id, data),
    onSuccess: (_res, { id }) => {
      qc.invalidateQueries({ queryKey: ['lakeServices'] });
      qc.invalidateQueries({ queryKey: lakeServiceKeys.detail(id) });
    },
  });
}

export function useDeleteLakeService() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => lakeServicesApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lakeServices'] });
    },
  });
}

export function useRunLakeServiceCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => lakeServicesApi.runCheck(id),
    onSuccess: (_res, id) => {
      // service.status 가 갱신됐으므로 list/detail/checks 전부 invalidate
      qc.invalidateQueries({ queryKey: ['lakeServices'] });
      qc.invalidateQueries({ queryKey: lakeServiceKeys.detail(id) });
      qc.invalidateQueries({ queryKey: ['lakeServiceChecks', id] });
    },
  });
}

// ─── LAKE service type 카탈로그 CRUD (lake-service-type-management PDCA) ─

export const lakeServiceTypeKeys = {
  rows: (params?: Record<string, unknown>) => ['lakeServiceTypeRows', params ?? {}] as const,
  row: (id: string) => ['lakeServiceTypeRow', id] as const,
};

export function useLakeServiceTypeRows(params?: {
  enabled?: boolean;
  domain?: string;
  offset?: number;
  limit?: number;
}) {
  return useQuery({
    queryKey: lakeServiceTypeKeys.rows(params),
    queryFn: async () => (await lakeServiceTypesApi.list(params)).data,
  });
}

function _invalidateAllLakeTypeQueries(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['lakeServiceTypeRows'] });
  // 카탈로그 변경 → 등록 모달의 select 도 갱신
  qc.invalidateQueries({ queryKey: lakeServiceKeys.types() });
}

export function useCreateLakeServiceType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: LakeServiceTypeInput) => lakeServiceTypesApi.create(data),
    onSuccess: () => _invalidateAllLakeTypeQueries(qc),
  });
}

export function useUpdateLakeServiceType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: LakeServiceTypeUpdate }) =>
      lakeServiceTypesApi.update(id, data),
    onSuccess: () => _invalidateAllLakeTypeQueries(qc),
  });
}

export function useToggleLakeServiceType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      lakeServiceTypesApi.toggleEnabled(id, enabled),
    onSuccess: () => _invalidateAllLakeTypeQueries(qc),
  });
}

export function useDeleteLakeServiceType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => lakeServiceTypesApi.remove(id),
    onSuccess: () => _invalidateAllLakeTypeQueries(qc),
  });
}
