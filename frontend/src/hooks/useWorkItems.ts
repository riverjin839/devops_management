import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { workItemsApi, WorkItemFilters } from '@/services/api';
import { WorkItemCreate, WorkItemUpdate, KanbanStatus } from '@/types';

export const workItemKeys = {
  all: ['workItems'] as const,
  filtered: (params: object) => ['workItems', params] as const,
  detail: (id: string) => ['workItems', 'detail', id] as const,
};

export function useWorkItems(filters?: WorkItemFilters) {
  return useQuery({
    queryKey: filters ? workItemKeys.filtered(filters) : workItemKeys.all,
    queryFn: async () => {
      const { data } = await workItemsApi.getAll(filters);
      return data;
    },
    staleTime: 1000 * 30,
  });
}

export function useCreateWorkItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: WorkItemCreate) => workItemsApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workItemKeys.all });
    },
  });
}

export function useUpdateWorkItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: WorkItemUpdate }) =>
      workItemsApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workItemKeys.all });
    },
  });
}

export function useDeleteWorkItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => workItemsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workItemKeys.all });
    },
  });
}

export function usePatchWorkItemStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, kanbanStatus }: { id: string; kanbanStatus: KanbanStatus }) =>
      workItemsApi.patchStatus(id, kanbanStatus),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workItemKeys.all });
    },
  });
}
