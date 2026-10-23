import { useQuery } from '@tanstack/react-query';
import { workGuidesApi } from '@/services/api';

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

