import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tenantsApi } from '@/services/api';
import type { ClusterAccessLevel, TenantLlmRouting } from '@/types';

const KEY = ['tenants'] as const;

/** 테넌트 목록(멤버·바인딩 포함) — admin 전용 API 라 enabled 로 호출 여부를 제어한다. */
export function useTenants(enabled = true) {
  return useQuery({
    queryKey: KEY,
    queryFn: () => tenantsApi.list().then((r) => r.data),
    enabled,
  });
}

/** 작성 폼의 "공유 범위" 선택지 — 내가 속한 테넌트(admin 은 전체). */
export function useMyTenants() {
  return useQuery({
    queryKey: ['tenants', 'mine'],
    queryFn: () => tenantsApi.mine().then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useTenantMutations() {
  const qc = useQueryClient();
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: KEY });
    qc.invalidateQueries({ queryKey: ['my-cluster-access'] });
  };
  return {
    create: useMutation({
      mutationFn: (d: { name: string; description?: string | null }) => tenantsApi.create(d),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({ id, ...d }: { id: string; name?: string; description?: string | null; maxConcurrentRuns?: number | null }) =>
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
    putLlmRouting: useMutation({
      mutationFn: ({ id, routing }: { id: string; routing: TenantLlmRouting }) =>
        tenantsApi.putLlmRouting(id, routing),
      onSuccess: invalidate,
    }),
  };
}

/** 테넌트별 최근 24h LLM 사용량 (admin) — Redis 미가용이면 빈 목록. */
export function useTenantLlmUsage() {
  return useQuery({
    queryKey: ['tenants', 'llm-usage'],
    queryFn: () => tenantsApi.llmUsage().then((r) => r.data),
    refetchInterval: 60_000,
  });
}

/** 테넌트별 백그라운드 실행 슬롯(실행 중·대기) — admin. 대기 상황을 보는 용도라 짧게 폴링한다. */
export function useTenantRunSlots(enabled = true) {
  return useQuery({
    queryKey: ['tenants', 'run-slots'],
    queryFn: () => tenantsApi.runSlots().then((r) => r.data),
    refetchInterval: 5_000,
    enabled,
  });
}
