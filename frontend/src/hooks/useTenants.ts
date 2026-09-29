import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tenantsApi } from '@/services/api';
import type { ClusterAccessLevel } from '@/types';

const KEY = ['tenants'] as const;

/** 테넌트 목록(멤버·바인딩 포함) — admin 전용 API 라 enabled 로 호출 여부를 제어한다. */
export function useTenants(enabled = true) {
  return useQuery({
    queryKey: KEY,
    queryFn: () => tenantsApi.list().then((r) => r.data),
    enabled,
  });
}

export function useTenantMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: KEY });
  return {
    create: useMutation({
      mutationFn: (d: { name: string; description?: string | null }) => tenantsApi.create(d),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ id, ...d }: { id: string; name?: string; description?: string | null }) =>
        tenantsApi.update(id, d),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => tenantsApi.remove(id),
      onSuccess: invalidate,
    }),
    putMembers: useMutation({
      mutationFn: ({ id, userIds }: { id: string; userIds: string[] }) => tenantsApi.putMembers(id, userIds),
      onSuccess: invalidate,
    }),
    putBindings: useMutation({
      mutationFn: ({ id, bindings }: { id: string; bindings: { clusterId: string; access: ClusterAccessLevel }[] }) =>
        tenantsApi.putBindings(id, bindings),
      onSuccess: invalidate,
    }),
  };
}
