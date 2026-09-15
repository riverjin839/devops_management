import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { deepCheckDefinitionsApi } from '@/services/api';
import type { DeepCheckDefinitionInput, DeepCheckPreviewInput } from '@/types';

export const deepCheckDefinitionKeys = {
  list: (clusterId?: string, withStatus?: boolean, checkType?: string) =>
    ['deepCheckDefinitions', clusterId ?? 'all', withStatus ? 'status' : 'plain', checkType ?? 'any'] as const,
  checkTypes: ['deepCheckTypes'] as const,
  results: (definitionId: string) => ['deepCheckDefinitionResults', definitionId] as const,
};

export function useCheckTypes() {
  return useQuery({
    queryKey: deepCheckDefinitionKeys.checkTypes,
    queryFn: async () => {
      const { data } = await deepCheckDefinitionsApi.listCheckTypes();
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });
}

export function useDeepCheckDefinitions(
  clusterId?: string,
  includeGlobal = true,
  withStatus = false,
  checkType?: string,
) {
  return useQuery({
    queryKey: deepCheckDefinitionKeys.list(clusterId, withStatus, checkType),
    queryFn: async () => {
      const { data } = await deepCheckDefinitionsApi.list({
        clusterId,
        includeGlobal,
        withStatus,
        checkType,
      });
      return data;
    },
  });
}

/** 항목 상세(`/checks/:itemId`) 의 클러스터별 오버라이드 표 — cluster_id 없이 이 check_type 의
 *  글로벌+전 클러스터 정의를 한 번에 받는다. */
export function useDeepCheckDefinitionsByType(checkType: string | undefined) {
  return useQuery({
    queryKey: deepCheckDefinitionKeys.list(undefined, true, checkType),
    queryFn: async () => {
      const { data } = await deepCheckDefinitionsApi.list({ checkType, includeGlobal: true });
      return data;
    },
    enabled: !!checkType,
  });
}

/** 정의별 실행 이력 (개별 로그) — details._steps 에 단계별 실행 로그 포함. */
export function useDefinitionResults(
  definitionId: string | null,
  params?: { limit?: number; offset?: number; status?: string },
) {
  return useQuery({
    queryKey: [...deepCheckDefinitionKeys.results(definitionId ?? 'none'), params ?? {}],
    queryFn: async () => {
      const { data } = await deepCheckDefinitionsApi.results(definitionId!, params);
      return data;
    },
    enabled: !!definitionId,
  });
}

export function useCreateDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DeepCheckDefinitionInput) =>
      deepCheckDefinitionsApi.create(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deepCheckDefinitions'] });
    },
  });
}

export function useUpdateDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: DeepCheckDefinitionInput }) =>
      deepCheckDefinitionsApi.update(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deepCheckDefinitions'] });
    },
  });
}

export function useDeleteDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deepCheckDefinitionsApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deepCheckDefinitions'] });
      qc.invalidateQueries({ queryKey: ['deepCheckDefinitionResults'] });
    },
  });
}

export function useDuplicateDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deepCheckDefinitionsApi.duplicate(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deepCheckDefinitions'] });
    },
  });
}

export function useTestDefinition() {
  return useMutation({
    mutationFn: ({ id, clusterId }: { id: string; clusterId?: string }) =>
      deepCheckDefinitionsApi.test(id, clusterId),
  });
}

/** 즉시 1회 실행 + DeepCheckResult 영속화 — 이력에 남는 수동 실행. */
export function useRunDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, clusterId }: { id: string; clusterId?: string }) =>
      deepCheckDefinitionsApi.run(id, clusterId),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['deepCheckDefinitions'] });
      qc.invalidateQueries({ queryKey: deepCheckDefinitionKeys.results(vars.id) });
    },
  });
}

/** 저장 전 폼 값 그대로 ad-hoc 실행 (영속화 없음). */
export function usePreviewCheck() {
  return useMutation({
    mutationFn: (body: DeepCheckPreviewInput) => deepCheckDefinitionsApi.preview(body),
  });
}
