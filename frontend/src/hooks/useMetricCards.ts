import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { promqlApi } from '@/services/api';
import { MetricCard } from '@/types';

export const metricCardKeys = {
  cards: ['metricCards'] as const,
  card: (id: string) => ['metricCards', id] as const,
  results: ['metricResults'] as const,
  result: (id: string) => ['metricResults', id] as const,
  sparkline: (id: string) => ['metricSparkline', id] as const,
  health: ['prometheusHealth'] as const,
};

export function useMetricCards() {
  return useQuery({
    queryKey: metricCardKeys.cards,
    queryFn: async () => {
      const { data } = await promqlApi.getCards();
      return data?.data ?? [];
    },
    refetchInterval: 60000, // 1분마다
  });
}

export function useMetricResults() {
  return useQuery({
    queryKey: metricCardKeys.results,
    queryFn: async () => {
      const { data } = await promqlApi.queryAll();
      // Backend returns array directly (not wrapped in data.data)
      return Array.isArray(data) ? data : (data as unknown as { data: typeof data }).data ?? data;
    },
    refetchInterval: 30000, // 30초마다 자동 리페치
  });
}

export function useMetricCardResult(cardId: string) {
  return useQuery({
    queryKey: metricCardKeys.result(cardId),
    queryFn: async () => {
      const { data } = await promqlApi.queryCard(cardId);
      return data;
    },
    enabled: !!cardId,
    refetchInterval: 30000,
  });
}

/** KPI 카드 하단 Sparkline 용 최근 1시간 추이. Prometheus 미연결이어도 500 없이
 *  status: 'offline'/'error' 로 응답(fail-safe) — 카드 쪽에서 조용히 숨기면 됨. */
export function useMetricSparkline(cardId: string, enabled = true) {
  return useQuery({
    queryKey: metricCardKeys.sparkline(cardId),
    queryFn: async () => {
      const { data } = await promqlApi.querySparkline(cardId);
      return data;
    },
    enabled: !!cardId && enabled,
    refetchInterval: 60000,
    staleTime: 30000,
  });
}

export function usePrometheusHealth() {
  return useQuery({
    queryKey: metricCardKeys.health,
    queryFn: async () => {
      const { data } = await promqlApi.health();
      return data;
    },
    refetchInterval: 60000,
  });
}

export function useCreateMetricCard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<MetricCard>) => promqlApi.createCard(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: metricCardKeys.cards });
      queryClient.invalidateQueries({ queryKey: metricCardKeys.results });
    },
  });
}

export function useUpdateMetricCard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<MetricCard> }) =>
      promqlApi.updateCard(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: metricCardKeys.cards });
    },
  });
}

export function useDeleteMetricCard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => promqlApi.deleteCard(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: metricCardKeys.cards });
      queryClient.invalidateQueries({ queryKey: metricCardKeys.results });
    },
  });
}

export function useTestPromql() {
  return useMutation({
    mutationFn: (promql: string) => promqlApi.testQuery(promql),
  });
}
