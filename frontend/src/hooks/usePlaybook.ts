import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { playbooksApi } from '@/services/api';
import { usePlaybookStore } from '@/stores/playbookStore';
import { useToastSafe } from '@/components/common/Toast';
import { formatApiError } from '@/lib/utils';
import type { Playbook, PlaybookUpdatePayload } from '@/types';

/*
 * 실패 피드백 분담(D-143) — 호출부와 토스트가 겹치지 않게 hook 별로 한 곳에서만 알린다.
 *  - 생성·수정: 호출부(AddPlaybookModal)가 결과를 기다려 모달 안에 사유를 띄운다 → hook 토스트 없음.
 *  - 실행: `runLogged` 가 실행 로그에 실패 사유를 남긴다 → hook 토스트 없음.
 *  - 삭제·대시보드 토글: 화면마다 호출부가 따로 알리지 않는다 → hook 의 onError 가 토스트.
 */

export const playbookKeys = {
  all: ['playbooks'] as const,
  byCluster: (clusterId: string) => ['playbooks', clusterId] as const,
  dashboard: (clusterId: string) => ['playbooks', 'dashboard', clusterId] as const,
  detail: (id: string) => ['playbooks', 'detail', id] as const,
  runs: (id: string) => ['playbooks', 'runs', id] as const,
};

export function usePlaybooks(clusterId?: string) {
  const { setPlaybooks } = usePlaybookStore();

  return useQuery({
    queryKey: clusterId ? playbookKeys.byCluster(clusterId) : playbookKeys.all,
    queryFn: async () => {
      const { data } = await playbooksApi.getAll(clusterId);
      const playbooks = data?.data ?? [];
      setPlaybooks(playbooks);
      return playbooks;
    },
    refetchInterval: 15000,
  });
}

export function useCreatePlaybook() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Partial<Playbook>) => playbooksApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: playbookKeys.all });
    },
  });
}

export function useUpdatePlaybook() {
  const queryClient = useQueryClient();

  return useMutation({
    // 비운 설명·태그는 null 로 그대로 JSON 에 실린다(D-144).
    mutationFn: ({ id, data }: { id: string; data: PlaybookUpdatePayload }) =>
      playbooksApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: playbookKeys.all });
    },
  });
}

export function useDeletePlaybook() {
  const queryClient = useQueryClient();
  const toast = useToastSafe();

  return useMutation({
    mutationFn: (id: string) => playbooksApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: playbookKeys.all });
    },
    onError: (e) => toast.error('플레이북 삭제 실패', formatApiError(e)),
  });
}

export function useDashboardPlaybooks(clusterId: string) {
  return useQuery({
    queryKey: playbookKeys.dashboard(clusterId),
    queryFn: async () => {
      const { data } = await playbooksApi.getDashboard(clusterId);
      return data?.data ?? [];
    },
    enabled: !!clusterId,
    refetchInterval: 15000,
  });
}

export function useToggleDashboard() {
  const queryClient = useQueryClient();
  const toast = useToastSafe();

  return useMutation({
    mutationFn: (id: string) => playbooksApi.toggleDashboard(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: playbookKeys.all });
      // 모든 dashboard 쿼리도 invalidate
      queryClient.invalidateQueries({ queryKey: ['playbooks', 'dashboard'] });
    },
    onError: (e) => toast.error('대시보드 표시 변경 실패', formatApiError(e)),
  });
}

export function useRunPlaybook() {
  const queryClient = useQueryClient();
  const { setRunning, clearRunning } = usePlaybookStore();

  return useMutation({
    mutationFn: ({ id, creds }: { id: string; creds?: import('@/types').PlaybookSshCreds }) => {
      setRunning(id);
      return playbooksApi.run(id, creds);
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: playbookKeys.all });
      queryClient.invalidateQueries({ queryKey: playbookKeys.runs(vars.id) });
    },
    onSettled: (_, __, vars) => {
      clearRunning(vars.id);
    },
  });
}

/** D-066 — 실행 이력(append-only). 로그 다이얼로그가 열려 있을 때만 조회한다. */
export function usePlaybookRuns(playbookId: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: playbookKeys.runs(playbookId ?? ''),
    queryFn: async () => {
      const { data } = await playbooksApi.getRuns(playbookId as string);
      return data?.data ?? [];
    },
    enabled: enabled && !!playbookId,
  });
}
