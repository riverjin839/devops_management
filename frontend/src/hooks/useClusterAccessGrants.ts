import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clusterAccessApi } from '@/services/api';
import type { ClusterGrantChange } from '@/types';

const KEY = ['cluster-access'] as const;

/** 사용자별 직접 지정 개수 — Settings ▸ 클러스터 권한 좌측 목록 (admin 전용). */
export function useClusterGrantSummary() {
  return useQuery({
    queryKey: [...KEY, 'summary'],
    queryFn: () => clusterAccessApi.summary().then((r) => r.data),
  });
}

/** 한 사용자의 클러스터별 직접 지정 · 실제 적용 · 근거. */
export function useUserClusterAccess(userId: string | null) {
  return useQuery({
    queryKey: [...KEY, 'user', userId],
    queryFn: () => clusterAccessApi.getUser(userId as string).then((r) => r.data),
    enabled: Boolean(userId),
  });
}

export function useSaveClusterGrants() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (changes: ClusterGrantChange[]) => clusterAccessApi.saveGrants(changes),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['my-cluster-access'] });
      qc.invalidateQueries({ queryKey: ['clusters'] });
    },
  });
}
