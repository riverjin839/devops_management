import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToastSafe } from '@/components/common/Toast';
import { formatApiError } from '@/lib/utils';
import { homePrefsApi } from '@/services/api';
import { getAuthToken } from '@/stores/authStore';
import type { HomePrefs, HomePrefsDefaults, HomePrefsUpdate } from '@/types';

export const homePrefsKeys = {
  all: ['homePrefs'] as const,
  defaults: ['homePrefsDefaults'] as const,
};

/** 서버 저장 홈/네비게이션 개인화(기본 홈 탭, 즐겨찾기, 설치 앱, 테마, 표시 언어 `locale`) — 기기·브라우저를
 *  넘어 따라온다. `locale` 의 화면 반영은 `i18n/useLocale.ts`(useLocaleSync·useLocale)가 한다. */
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
 *  reset → 전체 교체 → remove → add → move. reset 은 조직 기본값을 모르므로 응답을 기다린다. */
function applyOptimistic(prev: HomePrefs, payload: HomePrefsUpdate): HomePrefs {
  const { installedAppsAdd, installedAppsRemove, installedAppsReset, installedAppsMove, ...simple } = payload;
  const next: HomePrefs = { ...prev, ...simple };
  if (installedAppsReset) return next;
  if (installedAppsAdd || installedAppsRemove || installedAppsMove) {
    const remove = new Set(installedAppsRemove ?? []);
    let apps = next.installedApps.filter((a) => !remove.has(a));
    for (const a of installedAppsAdd ?? []) if (!apps.includes(a)) apps.push(a);
    if (installedAppsMove && apps.includes(installedAppsMove.id)) {
      apps = apps.filter((a) => a !== installedAppsMove.id);
      const idx = installedAppsMove.before ? apps.indexOf(installedAppsMove.before) : -1;
      apps.splice(idx >= 0 ? idx : apps.length, 0, installedAppsMove.id);
    }
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

/**
 * 사이드바·상단바 "앱 추가" 조작 — 실패를 조용히 삼키지 않는다.
 *
 * 예전엔 설정을 못 받았으면(로딩·오류) 클릭을 그냥 무시하고, 저장이 실패하면 낙관적 갱신만 조용히
 * 되돌려 "눌러도 추가가 안 되고 아무 메시지도 없는" 상태가 됐다(1.59 배포 직후 서버 응답 지연).
 * 이제 두 경우 모두 사유를 토스트로 알리고, 못 받은 설정은 다시 불러온다.
 */
export function useInstalledAppsActions() {
  const toast = useToastSafe();
  const prefsQuery = useHomePrefs();
  const homePrefs = prefsQuery.data;
  const update = useUpdateHomePrefs();
  const installedApps = useMemo(() => homePrefs?.installedApps ?? [], [homePrefs?.installedApps]);

  const send = (payload: HomePrefsUpdate, failTitle: string) => {
    // 설정을 아직 못 받았거나(로딩·오류) 빈 [] 폴백 상태에서 저장하면 서버 목록 전체를 덮어쓴다 —
    // 로드된 원본이 있을 때만 저장하고, 없으면 이유를 알리고 다시 불러온다.
    if (!homePrefs) {
      toast.show({
        variant: 'warning',
        title: failTitle,
        description: prefsQuery.isError
          ? `내 화면 설정을 불러오지 못했습니다 — ${formatApiError(prefsQuery.error)}. 다시 불러오는 중입니다.`
          : '내 화면 설정을 아직 불러오는 중입니다. 잠시 뒤 다시 눌러 주세요.',
      });
      void prefsQuery.refetch();
      return;
    }
    update.mutate(payload, { onError: (e) => toast.error(failTitle, formatApiError(e)) });
  };

  return {
    homePrefs,
    installedApps,
    // 델타 연산 — 서버가 행 잠금 아래에서 합쳐 다른 기기·탭의 변경을 덮지 않는다.
    toggle: (id: string) => send(
      installedApps.includes(id) ? { installedAppsRemove: [id] } : { installedAppsAdd: [id] },
      installedApps.includes(id) ? '앱 제거 실패' : '앱 추가 실패',
    ),
    move: (id: string, before: string | null) => send({ installedAppsMove: { id, before } }, '앱 순서 변경 실패'),
    reset: () => send({ installedAppsReset: true }, '앱 구성 초기화 실패'),
  };
}
