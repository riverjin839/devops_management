// 공개 화면 공유 링크(만료 기한이 있는 접근 토큰) — admin 관리(TanStack Query).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { publicShareApi } from '@/services/api';
import type { PublicSharePage } from '@/types';

export function usePublicShareLinks(enabled: boolean, includeInactive: boolean) {
  return useQuery({
    queryKey: ['public-share-links', includeInactive],
    queryFn: async () => (await publicShareApi.list(includeInactive)).data.links,
    enabled,
  });
}

export function usePublicShareMutations() {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ['public-share-links'] });
  const create = useMutation({
    mutationFn: async (body: { label: string; page: PublicSharePage; expiresDays: number; clusterIds?: string[] }) =>
      (await publicShareApi.create(body)).data,
    onSuccess: done,
  });
  const revoke = useMutation({
    mutationFn: async (id: string) => (await publicShareApi.revoke(id)).data,
    onSuccess: done,
  });
  return { create, revoke };
}
