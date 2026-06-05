import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { sprintsApi } from '@/services/api';
import { SprintCreate, SprintUpdate } from '@/types';

export const sprintKeys = {
  all: ['sprints'] as const,
  list: (status?: string) => ['sprints', { status }] as const,
  current: ['sprints', 'current'] as const,
};

export function useSprints(status?: string) {
  return useQuery({
    queryKey: sprintKeys.list(status),
    queryFn: async () => (await sprintsApi.getAll(status)).data,
    staleTime: 1000 * 30,
  });
}

export function useCurrentSprint() {
  return useQuery({
    queryKey: sprintKeys.current,
    queryFn: async () => (await sprintsApi.getCurrent()).data,
    staleTime: 1000 * 30,
  });
}

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: sprintKeys.all });
  qc.invalidateQueries({ queryKey: ['workItems'] });
}

export function useCreateSprint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: SprintCreate) => sprintsApi.create(data),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useUpdateSprint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: SprintUpdate }) => sprintsApi.update(id, data),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useCarryOverSprint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) => sprintsApi.carryOver(id, to),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useDeleteSprint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => sprintsApi.delete(id),
    onSuccess: () => invalidateAll(qc),
  });
}
