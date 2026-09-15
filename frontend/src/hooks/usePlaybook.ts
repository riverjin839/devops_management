import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { playbooksApi } from '@/services/api';
import { usePlaybookStore } from '@/stores/playbookStore';
import { Playbook } from '@/types';

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
    mutationFn: ({ id, data }: { id: string; data: Partial<Playbook> }) =>
      playbooksApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: playbookKeys.all });
    },
  });
}

export function useDeletePlaybook() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => playbooksApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: playbookKeys.all });
    },
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

  return useMutation({
    mutationFn: (id: string) => playbooksApi.toggleDashboard(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: playbookKeys.all });
      // 모든 dashboard 쿼리도 invalidate
      queryClient.invalidateQueries({ queryKey: ['playbooks', 'dashboard'] });
    },
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
