import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { infraNodesApi } from '@/services/api';
import type { InfraNodeCreate, InfraNodeUpdate } from '@/types';

export function useInfraNodes(params?: { clusterId?: string; rackName?: string }) {
  return useQuery({
    queryKey: ['infra-nodes', params],
    queryFn: () => infraNodesApi.getAll(params).then(r => r.data),
    staleTime: 30_000,
  });
}

export function useCreateInfraNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: InfraNodeCreate) => infraNodesApi.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['infra-nodes'] }),
  });
}

export function useUpdateInfraNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: InfraNodeUpdate }) =>
      infraNodesApi.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['infra-nodes'] }),
  });
}

export function useDeleteInfraNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => infraNodesApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['infra-nodes'] }),
  });
}

export function useSyncInfraNodes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (clusterId: string) => infraNodesApi.sync(clusterId).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['infra-nodes'] }),
  });
}

// 노드 추가 검증 — 결과는 ephemeral(캐시 무효화 불필요).
export function useVerifyInfraNode() {
  return useMutation({
    mutationFn: (id: string) => infraNodesApi.verify(id).then(r => r.data),
  });
}
