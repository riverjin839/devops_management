/**
 * NS 마이그레이션 서버 상태 — `/ns-migration` 화면 전용.
 * 실행(run)은 Celery 로 큐잉되고, 활성 상태인 동안 1.5초마다 폴링해 단계·로그를 실시간 표시한다.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { nsMigrationApi } from '@/services/api';
import type { NsMigRunState, NsMigSpec } from '@/types';

const ACTIVE: NsMigRunState[] = ['queued', 'running'];

export function useNsMigKinds() {
  return useQuery({
    queryKey: ['ns-mig-kinds'],
    queryFn: async () => (await nsMigrationApi.kinds()).data,
    staleTime: 10 * 60_000,
  });
}

export function useNsMigNamespaces(clusterId: string | null) {
  return useQuery({
    queryKey: ['ns-mig-namespaces', clusterId],
    queryFn: async () => (await nsMigrationApi.namespaces(clusterId as string)).data,
    enabled: !!clusterId,
    staleTime: 30_000,
    retry: false,
  });
}

export function useNsMigRuns() {
  return useQuery({
    queryKey: ['ns-mig-runs'],
    queryFn: async () => (await nsMigrationApi.runs()).data.data,
    refetchInterval: (q) => (q.state.data?.some((r) => ACTIVE.includes(r.runState)) ? 3000 : false),
  });
}

export function useNsMigRun(runId: string | null) {
  return useQuery({
    queryKey: ['ns-mig-run', runId],
    queryFn: async () => (await nsMigrationApi.run(runId as string)).data,
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data && ACTIVE.includes(q.state.data.runState) ? 1500 : false),
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

export function useNsMigProfiles() {
  return useQuery({
    queryKey: ['ns-mig-profiles'],
    queryFn: async () => (await nsMigrationApi.profiles()).data.data,
  });
}

export function useNsMigMutations() {
  const qc = useQueryClient();
  const invRuns = () => void qc.invalidateQueries({ queryKey: ['ns-mig-runs'] });
  const invProfiles = () => void qc.invalidateQueries({ queryKey: ['ns-mig-profiles'] });
  return {
    createRun: useMutation({
      mutationFn: async (body: NsMigSpec & { mode: 'plan' | 'apply' }) => (await nsMigrationApi.createRun(body)).data,
      onSuccess: invRuns,
    }),
    saveProfile: useMutation({
      mutationFn: async ({ id, ...body }: NsMigSpec & { name: string; id?: string | null }) =>
        (id ? await nsMigrationApi.updateProfile(id, body) : await nsMigrationApi.createProfile(body)).data,
      onSuccess: invProfiles,
    }),
    deleteProfile: useMutation({
      mutationFn: (id: string) => nsMigrationApi.deleteProfile(id),
      onSuccess: invProfiles,
    }),
  };
}
