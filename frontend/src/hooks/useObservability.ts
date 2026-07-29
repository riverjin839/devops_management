import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { observabilityApi } from '@/services/api';
import type { ObservabilityMetricInput } from '@/types';

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
