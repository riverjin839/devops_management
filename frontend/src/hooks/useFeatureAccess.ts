import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { uiSettingsApi } from '@/services/api';
import type { FeatureAccessMap } from '@/types';
import type { AuthUser } from '@/stores/authStore';

/** 기능별 접근 제어 맵 조회. */
export function useFeatureAccess() {
  return useQuery({
    queryKey: ['feature-access'],
    queryFn: () => uiSettingsApi.getFeatureAccess().then((r) => r.data.data ?? {}),
    staleTime: 60_000,
  });
}

export function useUpdateFeatureAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (access: FeatureAccessMap) => uiSettingsApi.updateFeatureAccess(access),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['feature-access'] }),
  });
}

/**
 * 접근 가능 여부 판정 (백엔드 규칙과 동일).
 *  - admin 은 항상 허용.
 *  - 해당 feature 설정이 없거나 roles/users 가 모두 비면 전체 허용(기본 open).
 *  - 설정이 있으면 role ∈ roles 또는 본인(username/displayName) ∈ users 일 때만.
 */
export function canAccessFeature(
  map: FeatureAccessMap | undefined,
  feature: string,
  user: AuthUser | null,
): boolean {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const rule = map?.[feature];
  if (!rule || (!rule.roles.length && !rule.users.length)) return true;
  if (rule.roles.includes(user.role)) return true;
  const ids = [user.username, user.displayName].filter(Boolean) as string[];
  return rule.users.some((u) => ids.includes(u));
}
