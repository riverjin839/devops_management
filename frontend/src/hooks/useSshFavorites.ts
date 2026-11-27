import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sshFavoritesApi } from '@/services/api';
import type { SshFavorite, SshFavoriteCreate, SshFavoriteUpdate } from '@/types';

const KEY = ['ssh-favorites'] as const;

/** SSH 터미널 즐겨찾기 명령 — 사용자별 서버 저장. 모든 분할 창이 같은 목록을 공유한다. */
export function useSshFavorites() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => sshFavoritesApi.list().then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export function useSshFavoriteMutations() {
  const qc = useQueryClient();
  const setList = (rows: SshFavorite[]) => qc.setQueryData(KEY, rows);
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });
  return {
    create: useMutation({
      mutationFn: (data: SshFavoriteCreate) => sshFavoritesApi.create(data).then((r) => r.data),
      onSettled: refresh,
    }),
    update: useMutation({
      mutationFn: ({ id, data }: { id: string; data: SshFavoriteUpdate }) => sshFavoritesApi.update(id, data).then((r) => r.data),
      onSettled: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: string) => sshFavoritesApi.delete(id),
      onSettled: refresh,
    }),
    reorder: useMutation({
      mutationFn: (ids: string[]) => sshFavoritesApi.reorder(ids).then((r) => r.data),
      onSuccess: setList,
      onError: refresh,
    }),
    reset: useMutation({
      mutationFn: () => sshFavoritesApi.reset().then((r) => r.data),
      onSuccess: setList,
    }),
  };
}
