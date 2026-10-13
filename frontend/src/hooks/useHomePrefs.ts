import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { homePrefsApi } from '@/services/api';
import { getAuthToken } from '@/stores/authStore';
import type { HomePrefs, HomePrefsDefaults, HomePrefsUpdate } from '@/types';

export const homePrefsKeys = {
  all: ['homePrefs'] as const,
  defaults: ['homePrefsDefaults'] as const,
};

/** 서버 저장 홈/네비게이션 개인화(기본 홈 탭, 즐겨찾기, 설치 앱) — 기기·브라우저를 넘어 따라온다. */
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

/** 서버 규칙(services/home_prefs.py apply_update)과 같은 순서로 캐시에 미리 반영한다:
 *  reset → 전체 교체 → remove → add. reset 은 조직 기본값을 모르므로 응답을 기다린다. */
function applyOptimistic(prev: HomePrefs, payload: HomePrefsUpdate): HomePrefs {
  const { installedAppsAdd, installedAppsRemove, installedAppsReset, ...simple } = payload;
  const next: HomePrefs = { ...prev, ...simple };
  if (installedAppsReset) return next;
  if (installedAppsAdd || installedAppsRemove) {
    const remove = new Set(installedAppsRemove ?? []);
    const apps = next.installedApps.filter((a) => !remove.has(a));
    for (const a of installedAppsAdd ?? []) if (!apps.includes(a)) apps.push(a);
    return { ...next, installedApps: apps, installedAppsCustomized: true };
  }
  if (simple.installedApps) return { ...next, installedAppsCustomized: true };
  return next;
}

export function useUpdateHomePrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: HomePrefsUpdate) => homePrefsApi.update(payload),
    // 낙관적 갱신 — 응답 전에 캐시를 반영해 연속 토글이 즉시 보이게 한다. 설치 앱은 델타
    // 연산(installedAppsAdd/Remove)으로 보내므로 서버가 행 잠금 아래에서 합치고, 다른 기기·탭의
    // 변경을 덮지 않는다(예전 전체 교체 방식의 lost update 해소).
    onMutate: async (payload) => {
      await qc.cancelQueries({ queryKey: homePrefsKeys.all });
      const previous = qc.getQueryData<HomePrefs>(homePrefsKeys.all);
      if (previous) qc.setQueryData<HomePrefs>(homePrefsKeys.all, applyOptimistic(previous, payload));
      return { previous };
    },
    onError: (_err, _payload, context) => {
      if (context?.previous) qc.setQueryData(homePrefsKeys.all, context.previous);
    },
    onSuccess: (res) => qc.setQueryData(homePrefsKeys.all, res.data),
  });
}

/** 조직 기본 설치 목록 — 개인화하지 않은 계정의 사이드바/상단바(Settings "화면 UI 설정"). */
export function useHomePrefsDefaults() {
  return useQuery({
    queryKey: homePrefsKeys.defaults,
    queryFn: async (): Promise<HomePrefsDefaults> => {
      const { data } = await homePrefsApi.getDefaults();
      return data;
    },
  });
}

export function useUpdateHomePrefsDefaults() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: HomePrefsDefaults) => homePrefsApi.updateDefaults(payload),
    onSuccess: (res) => {
      qc.setQueryData(homePrefsKeys.defaults, res.data);
      // 내가 기본값을 따르는 중이면 내 사이드바도 바로 바뀐다.
      qc.invalidateQueries({ queryKey: homePrefsKeys.all });
    },
  });
}
