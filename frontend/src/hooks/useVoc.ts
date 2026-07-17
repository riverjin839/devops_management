import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { vocApi } from '@/services/api';
import type { VocCreate, VocUpdate, VocReply } from '@/types';

export const vocKeys = {
  all: ['voc'] as const,
  list: (filters?: { category?: string; status?: string }) => ['voc', 'list', filters ?? {}] as const,
};

export function useVocPosts(
  enabled: boolean,
  filters?: { category?: string; status?: string },
) {
  return useQuery({
    queryKey: vocKeys.list(filters),
    queryFn: async () => (await vocApi.getAll(filters)).data.data,
    enabled,
    staleTime: 30_000,
  });
}

export function useCreateVoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: VocCreate) => vocApi.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: vocKeys.all }),
  });
}

export function useUpdateVoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: VocUpdate }) => vocApi.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: vocKeys.all }),
  });
}

export function useReplyVoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: VocReply }) => vocApi.reply(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: vocKeys.all }),
  });
}

export function useDeleteVoc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => vocApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: vocKeys.all }),
  });
}
