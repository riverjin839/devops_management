import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { checkMatrixApi } from '@/services/api';
import type { CheckMatrixItemInput } from '@/types';

export const checkMatrixKeys = {
  items: ['checkMatrixItems'] as const,
  grid: ['checkMatrixGrid'] as const,
  history: (itemId: string, clusterId: string, days: number) =>
    ['checkMatrixHistory', itemId, clusterId, days] as const,
  settings: ['checkMatrixSettings'] as const,
};

export function useCheckMatrixItems() {
  return useQuery({
    queryKey: checkMatrixKeys.items,
    queryFn: async () => {
      const { data } = await checkMatrixApi.listItems();
      return data;
    },
  });
}

export function useCheckMatrixGrid() {
  return useQuery({
    queryKey: checkMatrixKeys.grid,
    queryFn: async () => {
      const { data } = await checkMatrixApi.getGrid();
      return data;
    },
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  });
}

export function useCheckMatrixCellHistory(itemId: string | undefined, clusterId: string | undefined, days = 30) {
  return useQuery({
    queryKey: checkMatrixKeys.history(itemId || '', clusterId || '', days),
    queryFn: async () => {
      const { data } = await checkMatrixApi.getCellHistory(itemId!, clusterId!, days);
      return data;
    },
    enabled: !!itemId && !!clusterId,
  });
}

function invalidateGridAndItems(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: checkMatrixKeys.items });
  qc.invalidateQueries({ queryKey: checkMatrixKeys.grid });
}

export function useCreateCheckMatrixItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CheckMatrixItemInput) => checkMatrixApi.createItem(body),
    onSuccess: () => invalidateGridAndItems(qc),
  });
}

export function useUpdateCheckMatrixItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: CheckMatrixItemInput }) =>
      checkMatrixApi.updateItem(id, body),
    onSuccess: () => invalidateGridAndItems(qc),
  });
}

export function useDeleteCheckMatrixItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => checkMatrixApi.removeItem(id),
    onSuccess: () => invalidateGridAndItems(qc),
  });
}

export function useReorderCheckMatrixItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemIds: string[]) => checkMatrixApi.reorderItems(itemIds),
    onSuccess: () => invalidateGridAndItems(qc),
  });
}

export function usePostManualEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      itemId, clusterId, status, value, message,
    }: { itemId: string; clusterId: string; status: string; value?: number | null; message?: string | null }) =>
      checkMatrixApi.postManualEntry(itemId, clusterId, { status, value, message }),
    onSuccess: (_, { itemId, clusterId }) => {
      qc.invalidateQueries({ queryKey: checkMatrixKeys.grid });
      qc.invalidateQueries({ queryKey: ['checkMatrixHistory', itemId, clusterId] });
    },
  });
}

export function usePutSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      itemId, clusterId, cronExpr, enabled,
    }: { itemId: string; clusterId: string; cronExpr: string | null; enabled: boolean }) =>
      checkMatrixApi.putSchedule(itemId, clusterId, { cronExpr, enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: checkMatrixKeys.grid }),
  });
}

export function usePutClusterCron() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clusterId, checkCronExpr }: { clusterId: string; checkCronExpr: string | null }) =>
      checkMatrixApi.putClusterCron(clusterId, checkCronExpr),
    onSuccess: () => qc.invalidateQueries({ queryKey: checkMatrixKeys.grid }),
  });
}

export function useCheckMatrixSettings() {
  return useQuery({
    queryKey: checkMatrixKeys.settings,
    queryFn: async () => {
      const { data } = await checkMatrixApi.getSettings();
      return data;
    },
  });
}

export function useUpdateCheckMatrixSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (retentionDays: number) => checkMatrixApi.putSettings(retentionDays),
    onSuccess: () => qc.invalidateQueries({ queryKey: checkMatrixKeys.settings }),
  });
}
