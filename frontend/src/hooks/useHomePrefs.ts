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
    // 낙관적 갱신 — 응답을 기다리지 않고 캐시를 즉시 병합해 반영한다. 이게 없으면 사이드바
    // "앱 추가" 다이얼로그처럼 응답이 오기 전에 연속으로 토글할 때, 각 호출이 같은(구)
    // installedApps 를 기준으로 계산해 뒤에 보낸 요청이 앞의 변경을 덮어써 버린다.
    onMutate: async (payload) => {
      await qc.cancelQueries({ queryKey: homePrefsKeys.all });
      const previous = qc.getQueryData<HomePrefs>(homePrefsKeys.all);
      if (previous) qc.setQueryData<HomePrefs>(homePrefsKeys.all, { ...previous, ...payload });
      return { previous };
    },
    onError: (_err, _payload, context) => {
      if (context?.previous) qc.setQueryData(homePrefsKeys.all, context.previous);
    },
    onSuccess: (res) => qc.setQueryData(homePrefsKeys.all, res.data),
  });
}
