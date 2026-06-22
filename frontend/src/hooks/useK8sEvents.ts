import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { k8sEventsApi } from '@/services/api';

export const k8sEventKeys = {
  all: ['k8s-events'] as const,
  list: (params?: object) => ['k8s-events', 'list', params] as const,
  detail: (id: string) => ['k8s-events', id] as const,
};

interface UseK8sEventsParams {
  clusterId?: string;
  severity?: string;
  resourceKind?: string;
  limit?: number;
  offset?: number;
}

export function useK8sEvents(params?: UseK8sEventsParams) {
  return useQuery({
    queryKey: k8sEventKeys.list(params),
    queryFn: async () => {
      const { data } = await k8sEventsApi.list(params);
      return data;
    },
    refetchInterval: 30_000,
  });
}

export function useDeleteK8sEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => k8sEventsApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: k8sEventKeys.all });
    },
  });
}
