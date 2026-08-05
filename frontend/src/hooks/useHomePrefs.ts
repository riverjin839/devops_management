import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { homePrefsApi } from '@/services/api';
import { getAuthToken } from '@/stores/authStore';
import type { HomePrefs, HomePrefsUpdate } from '@/types';

export const homePrefsKeys = {
  all: ['homePrefs'] as const,
};

/** 서버 저장 홈/네비게이션 개인화(기본 홈 탭, 즐겨찾기) — 기기·브라우저를 넘어 따라온다. */
export function useHomePrefs() {
  return useQuery({
    queryKey: homePrefsKeys.all,
    queryFn: async (): Promise<HomePrefs> => {
      const { data } = await homePrefsApi.get();
      return data;
    },
    enabled: !!getAuthToken(),
    staleTime: 60_000,
    retry: false,
  });
}

export function useUpdateHomePrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: HomePrefsUpdate) => homePrefsApi.update(payload),
    onSuccess: (res) => qc.setQueryData(homePrefsKeys.all, res.data),
  });
}
