import { useQuery } from '@tanstack/react-query';
import { workItemCustomFieldsApi } from '@/services/api';
import type {
  WorkItemCustomField,
} from '@/types';

export function useWorkItemCustomFields() {
  return useQuery({
    queryKey: ['work-item-custom-fields'],
    queryFn: () => workItemCustomFieldsApi.list().then((r) => r.data.data),
    staleTime: 60_000,
  });
}

export function sortedWorkItemFields(fields: WorkItemCustomField[] | undefined): WorkItemCustomField[] {
  return [...(fields ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}
