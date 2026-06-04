import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { workItemCustomFieldsApi } from '@/services/api';
import type {
  WorkItemCustomField, WorkItemCustomFieldCreate, WorkItemCustomFieldUpdate,
} from '@/types';

export function useWorkItemCustomFields() {
  return useQuery({
    queryKey: ['work-item-custom-fields'],
    queryFn: () => workItemCustomFieldsApi.list().then((r) => r.data.data),
    staleTime: 60_000,
  });
}

export function useCreateWorkItemCustomField() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: WorkItemCustomFieldCreate) => workItemCustomFieldsApi.create(payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['work-item-custom-fields'] }),
  });
}

export function useUpdateWorkItemCustomField() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: WorkItemCustomFieldUpdate }) =>
      workItemCustomFieldsApi.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['work-item-custom-fields'] }),
  });
}

export function useDeleteWorkItemCustomField() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => workItemCustomFieldsApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['work-item-custom-fields'] });
      qc.invalidateQueries({ queryKey: ['workItems'] });
    },
  });
}

export function sortedWorkItemFields(fields: WorkItemCustomField[] | undefined): WorkItemCustomField[] {
  return [...(fields ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}
