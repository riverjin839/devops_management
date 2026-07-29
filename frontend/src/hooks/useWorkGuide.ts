import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { workGuidesApi } from '@/services/api';
import type { WorkGuideCreate, WorkGuideUpdate } from '@/types';

export const workGuideKeys = {
  all: ['work-guides'] as const,
  filtered: (params: Record<string, string | undefined>) => ['work-guides', params] as const,
  detail: (id: string) => ['work-guides', id] as const,
};

const guideKeys = workGuideKeys;

export function useWorkGuides(params?: { category?: string; status?: string; priority?: string }) {
  return useQuery({
    queryKey: params ? guideKeys.filtered(params as Record<string, string | undefined>) : guideKeys.all,
    queryFn: () => workGuidesApi.getAll(params).then((r) => r.data),
    staleTime: 1000 * 30,
  });
}

export function useCreateWorkGuide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: WorkGuideCreate) => workGuidesApi.create(data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: guideKeys.all }),
  });
}

export function useUpdateWorkGuide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: WorkGuideUpdate }) =>
      workGuidesApi.update(id, data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: guideKeys.all }),
  });
}

export function useDeleteWorkGuide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => workGuidesApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: guideKeys.all }),
  });
}
