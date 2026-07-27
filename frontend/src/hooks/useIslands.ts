import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { islandsApi } from '@/services/api';
import { getAuthToken } from '@/stores/authStore';
import type { Island, IslandCreatePayload, IslandListResponse } from '@/types';

export const islandKeys = {
  all: ['islands'] as const,
};

/** 내 아일랜드 + 남이 공유한 아일랜드. */
export function useIslands() {
  return useQuery({
    queryKey: islandKeys.all,
    queryFn: async (): Promise<IslandListResponse> => {
      const { data } = await islandsApi.list();
      return data;
    },
    enabled: !!getAuthToken(),
    staleTime: 60_000,
    retry: false,
  });
}

export function useCreateIsland() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: IslandCreatePayload) => islandsApi.create(payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: islandKeys.all }),
  });
}

export function useUpdateIsland() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...payload }: Partial<IslandCreatePayload> & { id: string }) =>
      islandsApi.update(id, payload),
    // 패널 추가/순서변경이 잦아 목록 캐시를 즉시 갱신하고, 서버 정규화 결과를 반영한다.
    onSuccess: (res) => {
      qc.setQueryData<IslandListResponse>(islandKeys.all, (prev) =>
        prev
          ? { ...prev, data: prev.data.map((i) => (i.id === res.data.id ? res.data : i)) }
          : prev,
      );
    },
  });
}

export function useDeleteIsland() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => islandsApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: islandKeys.all }),
  });
}

export function useCloneIsland() {
  const qc = useQueryClient();
  return useMutation<{ data: Island }, unknown, string>({
    mutationFn: (id: string) => islandsApi.clone(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: islandKeys.all }),
  });
}

export function useReorderIslands() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (order: string[]) => islandsApi.reorder(order),
    onSuccess: (res) => qc.setQueryData(islandKeys.all, res.data),
  });
}
