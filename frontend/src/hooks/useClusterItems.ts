import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { clusterItemsApi } from '@/services/api';
import { ClusterItem } from '@/types';

export const clusterItemKeys = {
  all: ['clusterItems'] as const,
  list: (clusterId: string) => ['clusterItems', clusterId] as const,
};

export function useClusterItems(clusterId: string) {
  return useQuery({
    queryKey: clusterItemKeys.list(clusterId),
    queryFn: async () => {
      const { data } = await clusterItemsApi.list(clusterId);
      return data?.data ?? [];
    },
    enabled: !!clusterId,
    refetchInterval: 60000,
  });
}

export function useCreateClusterItem(clusterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<ClusterItem>) => clusterItemsApi.create(clusterId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: clusterItemKeys.list(clusterId) });
    },
  });
}

export function useUpdateClusterItem(clusterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<ClusterItem> }) =>
      clusterItemsApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: clusterItemKeys.list(clusterId) });
    },
  });
}

export function useDeleteClusterItem(clusterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => clusterItemsApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: clusterItemKeys.list(clusterId) });
    },
  });
}

export function useRunClusterItem(clusterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => clusterItemsApi.run(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: clusterItemKeys.list(clusterId) });
    },
  });
}
