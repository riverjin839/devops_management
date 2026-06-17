import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { knowledgeApi } from '@/services/api';
import type {
  KnowledgePageNode,
  KnowledgePage,
  KnowledgePageVersion,
  KnowledgePageCreate,
  KnowledgePageUpdate,
} from '@/types';

const TREE_KEY = (service?: string) => ['knowledge', 'tree', service ?? 'all'];
const PAGE_KEY = (id: string) => ['knowledge', 'page', id];
const VERSIONS_KEY = (id: string) => ['knowledge', 'versions', id];

export function useKnowledgeTree(service?: string) {
  return useQuery<KnowledgePageNode[]>({
    queryKey: TREE_KEY(service),
    queryFn: () => knowledgeApi.tree(service).then((r) => r.data.data ?? []),
    staleTime: 30_000,
  });
}

export function useKnowledgePage(id?: string) {
  return useQuery<KnowledgePage>({
    queryKey: PAGE_KEY(id ?? ''),
    queryFn: () => knowledgeApi.get(id as string).then((r) => r.data),
    enabled: !!id,
  });
}

export function usePageVersions(id?: string) {
  return useQuery<KnowledgePageVersion[]>({
    queryKey: VERSIONS_KEY(id ?? ''),
    queryFn: () => knowledgeApi.versions(id as string).then((r) => r.data.data ?? []),
    enabled: !!id,
  });
}

export function useCreatePage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: KnowledgePageCreate) => knowledgeApi.create(data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['knowledge', 'tree'] }),
  });
}

export function useUpdatePage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: KnowledgePageUpdate }) =>
      knowledgeApi.update(id, data).then((r) => r.data),
    onSuccess: (page) => {
      qc.invalidateQueries({ queryKey: ['knowledge', 'tree'] });
      qc.invalidateQueries({ queryKey: PAGE_KEY(page.id) });
      qc.invalidateQueries({ queryKey: VERSIONS_KEY(page.id) });
    },
  });
}

export function useMovePage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, parentId, sortOrder }: { id: string; parentId?: string | null; sortOrder: number }) =>
      knowledgeApi.move(id, { parentId, sortOrder }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['knowledge', 'tree'] }),
  });
}

export function useDeletePage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => knowledgeApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['knowledge', 'tree'] }),
  });
}

export function useSaveMilestone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      knowledgeApi.saveMilestone(id, label).then((r) => r.data),
    onSuccess: (v) => qc.invalidateQueries({ queryKey: VERSIONS_KEY(v.pageId) }),
  });
}

export function useRestoreVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, versionId }: { id: string; versionId: string }) =>
      knowledgeApi.restore(id, versionId).then((r) => r.data),
    onSuccess: (page) => {
      qc.invalidateQueries({ queryKey: ['knowledge', 'tree'] });
      qc.invalidateQueries({ queryKey: PAGE_KEY(page.id) });
      qc.invalidateQueries({ queryKey: VERSIONS_KEY(page.id) });
    },
  });
}

export function useRoadmap(service?: string, category = 'enhancement') {
  return useQuery<KnowledgePage[]>({
    queryKey: ['knowledge', 'roadmap', service ?? 'all', category],
    queryFn: () => knowledgeApi.roadmap({ service, category }).then((r) => r.data.data ?? []),
    staleTime: 30_000,
  });
}

export function useReorder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ parentId, orderedIds }: { parentId: string | null; orderedIds: string[] }) =>
      knowledgeApi.reorder(parentId, orderedIds),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['knowledge', 'tree'] }),
  });
}

export function usePageBacklinks(id?: string) {
  return useQuery<KnowledgePage[]>({
    queryKey: ['knowledge', 'backlinks', id ?? ''],
    queryFn: () => knowledgeApi.backlinks(id as string).then((r) => r.data.data ?? []),
    enabled: !!id,
  });
}
