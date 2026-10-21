import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { observabilityApi } from '@/services/api';
import type { ObservabilityMetricInput, ObservabilitySettings } from '@/types';

export const observabilityKeys = {
  all: ['observability'] as const,
  modules: () => ['observability', 'modules'] as const,
  metrics: (module?: string) => ['observability', 'metrics', module ?? 'all'] as const,
  values: (module: string, clusterId?: string | null) =>
    ['observability', 'values', module, clusterId ?? 'none'] as const,
  rules: (clusterId?: string | null, state?: string, q?: string) =>
    ['observability', 'rules', clusterId ?? 'none', state ?? 'all', q ?? ''] as const,
  targets: (clusterId?: string | null, health?: string) =>
    ['observability', 'targets', clusterId ?? 'none', health ?? 'all'] as const,
  activeAlerts: (clusterId?: string | null) =>
    ['observability', 'active-alerts', clusterId ?? 'none'] as const,
  settings: () => ['observability', 'settings'] as const,
};

// 지표/규칙/타겟은 30초 폴링 — Dashboard 의 PromQL 카드(useMetricCards)와 같은 주기.
const POLL_MS = 30_000;

export function useObservabilityModules() {
  return useQuery({
    queryKey: observabilityKeys.modules(),
    queryFn: async () => (await observabilityApi.modules()).data,
    staleTime: 60_000,
  });
}

export function useObservabilityMetrics(module?: string) {
  return useQuery({
    queryKey: observabilityKeys.metrics(module),
    queryFn: async () => (await observabilityApi.metrics(module)).data,
    staleTime: 60_000,
  });
}

export function useMetricValues(module: string, clusterId?: string | null, enabled = true) {
  return useQuery({
    queryKey: observabilityKeys.values(module, clusterId),
    queryFn: async () => (await observabilityApi.metricValues(module, clusterId)).data,
    refetchInterval: POLL_MS,
    enabled,
  });
}

export function usePromRules(clusterId?: string | null, state?: string, q?: string, enabled = true) {
  return useQuery({
    queryKey: observabilityKeys.rules(clusterId, state, q),
    queryFn: async () => (await observabilityApi.promRules(clusterId, state, q)).data,
    refetchInterval: POLL_MS,
    enabled,
  });
}

export function usePromTargets(clusterId?: string | null, health?: string, enabled = true) {
  return useQuery({
    queryKey: observabilityKeys.targets(clusterId, health),
    queryFn: async () => (await observabilityApi.promTargets(clusterId, health)).data,
    refetchInterval: POLL_MS,
    enabled,
  });
}

export function usePromActiveAlerts(clusterId?: string | null, enabled = true) {
  return useQuery({
    queryKey: observabilityKeys.activeAlerts(clusterId),
    queryFn: async () => (await observabilityApi.promActiveAlerts(clusterId)).data,
    refetchInterval: POLL_MS,
    enabled,
  });
}

function useMetricMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: observabilityKeys.all }),
  });
}

export function useCreateMetric() {
  return useMetricMutation((data: ObservabilityMetricInput) => observabilityApi.createMetric(data));
}

export function useUpdateMetric() {
  return useMetricMutation(({ id, data }: { id: string; data: Partial<ObservabilityMetricInput> }) =>
    observabilityApi.updateMetric(id, data));
}

export function useDeleteMetric() {
  return useMetricMutation((id: string) => observabilityApi.deleteMetric(id));
}

/** PromQL 미리 조회(D-186) — 저장하지 않으므로 캐시 무효화 없음. */
export function usePreviewMetric() {
  return useMutation({
    mutationFn: async ({ clusterId, query }: { clusterId: string; query: string }) =>
      (await observabilityApi.previewMetric(clusterId, query)).data,
  });
}

/** push 스냅샷 "오래됨" 기준(D-183). 구버전 서버(404)면 오류로 남고 화면은 설정 버튼만 실패를 보여준다. */
export function useObservabilitySettings(enabled = true) {
  return useQuery({
    queryKey: observabilityKeys.settings(),
    queryFn: async () => (await observabilityApi.settings()).data,
    staleTime: 60_000,
    retry: false,
    enabled,
  });
}

export function useUpdateObservabilitySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: ObservabilitySettings) => (await observabilityApi.updateSettings(data)).data,
    // 기준이 바뀌면 stale 판정이 달라지므로 조회 결과도 다시 받는다.
    onSuccess: () => qc.invalidateQueries({ queryKey: observabilityKeys.all }),
  });
}
