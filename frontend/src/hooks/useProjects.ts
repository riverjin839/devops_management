import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { projectsApi } from '@/services/api';
import type { ProjectCreate, ProjectUpdate } from '@/types';

export const projectKeys = {
  all: ['projects'] as const,
  detail: (id: string) => ['projects', 'detail', id] as const,
};

export function useProjects(status?: string) {
  return useQuery({
    queryKey: status ? [...projectKeys.all, status] : projectKeys.all,
    queryFn: () => projectsApi.getAll(status).then((r) => r.data),
  });
}

export function useProject(id: string) {
  return useQuery({
    queryKey: projectKeys.detail(id),
    queryFn: () => projectsApi.get(id).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ProjectCreate) => projectsApi.create(data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.all }),
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: ProjectUpdate }) =>
      projectsApi.update(id, data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.all }),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => projectsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.all }),
  });
}
