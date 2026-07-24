import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  batchJobsApi,
  type BatchJobCreate,
  type BatchJobRunRequest,
  type BatchJobTestConnectionRequest,
  type BatchJobUpdate,
} from '@/services/api';

export const batchJobKeys = {
  all: ['batchJobs'] as const,
  list: (clusterId?: string) => ['batchJobs', 'list', clusterId ?? null] as const,
  detail: (id: string) => ['batchJobs', 'detail', id] as const,
  runs: (id: string) => ['batchJobs', 'runs', id] as const,
  types: ['batchJobs', 'types'] as const,
};

export function useBatchJobTypes() {
  return useQuery({
    queryKey: batchJobKeys.types,
    queryFn: async () => {
      const { data } = await batchJobsApi.listTypes();
      return data.data;
    },
    staleTime: 1000 * 60 * 10,
  });
}

export function useBatchJobs(clusterId?: string) {
  return useQuery({
    queryKey: batchJobKeys.list(clusterId),
    queryFn: async () => {
      const { data } = await batchJobsApi.list({ clusterId });
      return data.data;
    },
    refetchInterval: 30000,
  });
}

export function useBatchJobRuns(jobId: string) {
  return useQuery({
    queryKey: batchJobKeys.runs(jobId),
    queryFn: async () => {
      const { data } = await batchJobsApi.listRuns(jobId);
      return data.data;
    },
    enabled: !!jobId,
    // 스케줄/일괄(백그라운드) 실행 결과가 슬라이드오버에 자동 반영되도록 주기 갱신.
    refetchInterval: 15000,
  });
}

export function useCreateBatchJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: BatchJobCreate) => batchJobsApi.create(payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: batchJobKeys.all }),
  });
}

export function useUpdateBatchJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: BatchJobUpdate }) =>
      batchJobsApi.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: batchJobKeys.all }),
  });
}

export function useDeleteBatchJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => batchJobsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: batchJobKeys.all }),
  });
}

export function useRunBatchJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: BatchJobRunRequest }) =>
      batchJobsApi.run(id, payload),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: batchJobKeys.all });
      qc.invalidateQueries({ queryKey: batchJobKeys.runs(vars.id) });
    },
  });
}

export function useTestBatchJobConnection() {
  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: BatchJobTestConnectionRequest }) =>
      batchJobsApi.testConnection(id, payload),
  });
}
