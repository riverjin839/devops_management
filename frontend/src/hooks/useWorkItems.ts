import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { workItemsApi, WorkItemFilters } from '@/services/api';
import { WorkItemCreate, WorkItemUpdate, KanbanStatus } from '@/types';

export const workItemKeys = {
  all: ['workItems'] as const,
  filtered: (params: object) => ['workItems', params] as const,
  detail: (id: string) => ['workItems', 'detail', id] as const,
};

export function useWorkItems(filters?: WorkItemFilters) {
  return useQuery({
    queryKey: filters ? workItemKeys.filtered(filters) : workItemKeys.all,
    queryFn: async () => {
      const { data } = await workItemsApi.getAll(filters);
      return data;
    },
    staleTime: 1000 * 30,
  });
}

export function useCreateWorkItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: WorkItemCreate) => workItemsApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workItemKeys.all });
    },
  });
}

export function useUpdateWorkItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: WorkItemUpdate }) =>
      workItemsApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workItemKeys.all });
    },
  });
}

export function useDeleteWorkItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => workItemsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workItemKeys.all });
    },
  });
}

export function useWorkItemComments(itemId?: string) {
  return useQuery({
    queryKey: ['workItemComments', itemId],
    queryFn: async () => (await workItemsApi.listComments(itemId!)).data,
    enabled: !!itemId,
  });
}

export function useAddWorkItemComment(itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => workItemsApi.addComment(itemId, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workItemComments', itemId] }),
  });
}

export function useDeleteWorkItemComment(itemId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) => workItemsApi.deleteComment(commentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workItemComments', itemId] }),
  });
}

export function useWorkItemActivities(itemId?: string) {
  return useQuery({
    queryKey: ['workItemActivities', itemId],
    queryFn: async () => (await workItemsApi.listActivities(itemId!)).data,
    enabled: !!itemId,
  });
}

export function usePatchWorkItemStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, kanbanStatus }: { id: string; kanbanStatus: KanbanStatus }) =>
      workItemsApi.patchStatus(id, kanbanStatus),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: workItemKeys.all });
    },
  });
}

// ── 날짜별 시간 블록 (time blocks) ──────────────────────────────────────────────
export const timeBlockKeys = {
  range: (start: string, end: string) => ['workItemTimeBlocks', 'range', start, end] as const,
};

/** 기간 내 모든 업무의 시간 블록 — 당일 스케줄 보드용. */
export function useTimeBlocksRange(start: string, end: string, enabled = true) {
  return useQuery({
    queryKey: timeBlockKeys.range(start, end),
    queryFn: async () => (await workItemsApi.listTimeBlocksRange(start, end)).data,
    enabled,
    staleTime: 1000 * 15,
  });
}

function useInvalidateTimeBlocks() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['workItemTimeBlocks'] });
    qc.invalidateQueries({ queryKey: workItemKeys.all });
  };
}

export function useCreateTimeBlock() {
  const invalidate = useInvalidateTimeBlocks();
  return useMutation({
    mutationFn: ({ itemId, data }: {
      itemId: string;
      data: { blockDate: string; startMinute: number; endMinute: number; note?: string | null };
    }) => workItemsApi.createTimeBlock(itemId, data),
    onSuccess: invalidate,
  });
}

export function useUpdateTimeBlock() {
  const invalidate = useInvalidateTimeBlocks();
  return useMutation({
    mutationFn: ({ blockId, data }: {
      blockId: string;
      data: { blockDate?: string; startMinute?: number; endMinute?: number; note?: string | null };
    }) => workItemsApi.updateTimeBlock(blockId, data),
    onSuccess: invalidate,
  });
}

export function useDeleteTimeBlock() {
  const invalidate = useInvalidateTimeBlocks();
  return useMutation({
    mutationFn: (blockId: string) => workItemsApi.deleteTimeBlock(blockId),
    onSuccess: invalidate,
  });
}
