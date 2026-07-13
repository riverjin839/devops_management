import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { serviceCategoriesApi } from '@/services/api';
import type { ServiceCategoryInput, ServiceCategoryUpdate, ServiceDomain } from '@/types';

export const serviceCategoryKeys = {
  list: (params?: Record<string, unknown>) => ['serviceCategories', params ?? {}] as const,
};

export function useServiceCategories(domain?: ServiceDomain, params?: { enabled?: boolean }) {
  const query = { domain, ...params, limit: 200 };
  return useQuery({
    queryKey: serviceCategoryKeys.list(query),
    queryFn: async () => (await serviceCategoriesApi.list(query)).data,
  });
}

function _invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['serviceCategories'] });
}

export function useCreateServiceCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ServiceCategoryInput) => serviceCategoriesApi.create(data),
    onSuccess: () => _invalidate(qc),
  });
}

export function useUpdateServiceCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: ServiceCategoryUpdate }) =>
      serviceCategoriesApi.update(id, data),
    onSuccess: () => _invalidate(qc),
  });
}

export function useDeleteServiceCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => serviceCategoriesApi.remove(id),
    onSuccess: () => _invalidate(qc),
  });
}
