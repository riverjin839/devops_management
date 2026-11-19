// 노드 OS 파라미터 감시 — 서버 상태(TanStack Query). 에이전트가 주기적으로 보고하므로 상태·이력은 폴링한다.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { nodeParamWatchApi } from '@/services/api';
import type { NodeParamRuleInput, NodeParamSettings } from '@/types';

const keys = {
  rules: (clusterId: string) => ['node-params', 'rules', clusterId] as const,
  nodes: (clusterId: string) => ['node-params', 'nodes', clusterId] as const,
  changes: (clusterId: string) => ['node-params', 'changes', clusterId] as const,
  manifest: (clusterId: string) => ['node-params', 'manifest', clusterId] as const,
  settings: ['node-params', 'settings'] as const,
};

export function useNodeParamRules(clusterId: string) {
  return useQuery({
    queryKey: keys.rules(clusterId),
    queryFn: async () => (await nodeParamWatchApi.rules(clusterId || undefined)).data,
    enabled: !!clusterId,
    staleTime: 30_000,
  });
}

export function useNodeParamNodes(clusterId: string) {
  return useQuery({
    queryKey: keys.nodes(clusterId),
    queryFn: async () => (await nodeParamWatchApi.nodes(clusterId)).data,
    enabled: !!clusterId,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useNodeParamChanges(clusterId: string) {
  return useQuery({
    queryKey: keys.changes(clusterId),
    queryFn: async () => (await nodeParamWatchApi.changes(clusterId, { limit: 200 })).data.items,
    enabled: !!clusterId,
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
}

export function useNodeParamManifest(clusterId: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.manifest(clusterId),
    queryFn: async () => (await nodeParamWatchApi.manifest(clusterId)).data,
    enabled: enabled && !!clusterId,
    staleTime: 60_000,
  });
}

export function useNodeParamSettings() {
  return useQuery({
    queryKey: keys.settings,
    queryFn: async () => (await nodeParamWatchApi.settings()).data,
    staleTime: 60_000,
  });
}

/** 규칙·설정·에이전트 변경 뒤 이 화면의 서버 상태를 모두 다시 읽는다(판정이 규칙·설정에 따라 바뀐다). */
function useInvalidateAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['node-params'] });
}

export function useSaveNodeParamRule() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: async ({ id, body }: { id?: string; body: NodeParamRuleInput }) =>
      (id ? await nodeParamWatchApi.updateRule(id, body) : await nodeParamWatchApi.createRule(body)).data,
    onSuccess: invalidate,
  });
}

export function useDeleteNodeParamRule() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: async (id: string) => { await nodeParamWatchApi.deleteRule(id); },
    onSuccess: invalidate,
  });
}

export function useDeleteNodeParamAgent(clusterId: string) {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: async (agentId: string) => { await nodeParamWatchApi.deleteAgent(clusterId, agentId); },
    onSuccess: invalidate,
  });
}

export function useUpdateNodeParamSettings() {
  const invalidate = useInvalidateAll();
  return useMutation({
    mutationFn: async (body: Partial<Omit<NodeParamSettings, 'tokenConfigured'>>) =>
      (await nodeParamWatchApi.updateSettings(body)).data,
    onSuccess: invalidate,
  });
}
