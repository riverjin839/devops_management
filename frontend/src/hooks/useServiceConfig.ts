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

export function useServiceConfigView(clusterId: string, service: string, version?: number, groupId?: string | null) {
  return useQuery({
    queryKey: ['service-config', 'view', clusterId, service, version ?? 'latest', groupId ?? 'default'],
    queryFn: async () => (await serviceConfigApi.view(clusterId, service, version, groupId ?? undefined)).data,
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

/** 편집 중 초안의 의존 규칙 결과 — 호출부가 초안을 디바운스해서 넘긴다. 바뀐 값이 없으면 부르지 않는다. */
export function useServiceConfigEvaluate(
  clusterId: string, service: string, groupId: string | null, values: Record<string, string | null>, enabled: boolean,
) {
  return useQuery({
    queryKey: ['service-config', 'evaluate', clusterId, service, groupId ?? 'default', values],
    queryFn: async () => (await serviceConfigApi.evaluate(clusterId, service, groupId, values)).data,
    enabled: enabled && !!clusterId,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useSaveServiceConfigVersion(clusterId: string, service: string) {
  const invalidate = useInvalidateServiceConfig();
  return useMutation({
    mutationFn: async (body: { baseVersionNo: number; groupId: string | null; values: Record<string, string | null>; note?: string }) =>
      (await serviceConfigApi.saveVersion(clusterId, service, body)).data,
    onSuccess: invalidate,
  });
}

export function useServiceConfigCompare(
  clusterId: string, service: string, a: number | null, b: number | null, groupId: string | null, enabled: boolean,
) {
  return useQuery({
    queryKey: ['service-config', 'compare', clusterId, service, groupId ?? 'default', a, b],
    queryFn: async () => (await serviceConfigApi.compare(clusterId, service, a as number, b as number, groupId)).data,
    enabled: enabled && !!clusterId && a != null && b != null,
  });
}

export function useRevertServiceConfig(clusterId: string, service: string) {
  const invalidate = useInvalidateServiceConfig();
  return useMutation({
    mutationFn: async ({ versionNo, groupId }: { versionNo: number; groupId: string | null }) =>
      (await serviceConfigApi.revert(clusterId, service, versionNo, groupId)).data,
    onSuccess: invalidate,
  });
}

export function useSaveServiceConfigGroup(clusterId: string, service: string) {
  const invalidate = useInvalidateServiceConfig();
  return useMutation({
    mutationFn: async ({ id, body }: { id?: string; body: { name: string; nodePattern: string; description?: string | null } }) =>
      (id ? await serviceConfigApi.updateGroup(clusterId, service, id, body)
        : await serviceConfigApi.createGroup(clusterId, service, body)).data as { id: string; name: string },
    onSuccess: invalidate,
  });
}

export function useDeleteServiceConfigGroup(clusterId: string, service: string) {
  const invalidate = useInvalidateServiceConfig();
  return useMutation({
    mutationFn: async (groupId: string) => { await serviceConfigApi.deleteGroup(clusterId, service, groupId); },
    onSuccess: invalidate,
  });
}

export function useServiceConfigApplyPlan(clusterId: string, service: string, version: number | null, groupId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['service-config', 'apply-plan', clusterId, service, version, groupId ?? 'default'],
    queryFn: async () => (await serviceConfigApi.applyPlan(clusterId, service, version, groupId)).data,
    enabled: enabled && !!clusterId,
  });
}

export function useServiceConfigApplyRuns(clusterId: string, service: string, enabled: boolean) {
  return useQuery({
    queryKey: ['service-config', 'apply-runs', clusterId, service],
    queryFn: async () => (await serviceConfigApi.applyRuns(clusterId, service)).data.items,
    enabled: enabled && !!clusterId,
  });
}

/** 실행 상세 — 진행 중이면 2초마다 다시 읽어 노드별 결과를 채운다. */
export function useServiceConfigApplyRun(clusterId: string, service: string, runId: string | null) {
  return useQuery({
    queryKey: ['service-config', 'apply-run', clusterId, service, runId],
    queryFn: async () => (await serviceConfigApi.applyRun(clusterId, service, runId as string)).data,
    enabled: !!clusterId && !!runId,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });
}

export function useStopServiceConfigApply(clusterId: string, service: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (runId: string) => { await serviceConfigApi.stopApplyRun(clusterId, service, runId); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['service-config', 'apply-run'] }),
  });
}

export function useServiceConfigSettings(enabled: boolean) {
  return useQuery({
    queryKey: ['service-config', 'settings'],
    queryFn: async () => (await serviceConfigApi.settings()).data,
    enabled,
  });
}

export function useUpdateServiceConfigSettings() {
  const invalidate = useInvalidateServiceConfig();
  return useMutation({
    mutationFn: async (body: Partial<import('@/types').ServiceConfigApplySettings>) => (await serviceConfigApi.updateSettings(body)).data,
    onSuccess: invalidate,
  });
}
