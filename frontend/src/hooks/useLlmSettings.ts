import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { llmApi } from '@/services/api';
import type { LlmAnalysisScope, LlmSettings } from '@/types';

export const llmKeys = {
  all: ['llm'] as const,
  settings: () => ['llm', 'settings'] as const,
  health: () => ['llm', 'health'] as const,
  usage: () => ['llm', 'usage'] as const,
  credentials: () => ['llm', 'credentials'] as const,
  models: (profile: string) => ['llm', 'models', profile] as const,
  analysisScope: () => ['llm', 'analysis-scope'] as const,
};

export function useLlmSettings() {
  return useQuery({
    queryKey: llmKeys.settings(),
    queryFn: async () => (await llmApi.getSettings()).data,
  });
}

export function useUpdateLlmSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: LlmSettings) => llmApi.updateSettings(data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: llmKeys.all }),
  });
}

export function useLlmHealth() {
  return useQuery({
    queryKey: llmKeys.health(),
    queryFn: async () => (await llmApi.health()).data.data,
    refetchInterval: 30_000,
  });
}

export function useLlmUsage() {
  return useQuery({
    queryKey: llmKeys.usage(),
    queryFn: async () => (await llmApi.usage()).data.data,
    refetchInterval: 60_000,
  });
}

export function useLlmProfileModels(profile: string, enabled: boolean) {
  return useQuery({
    queryKey: llmKeys.models(profile),
    queryFn: async () => (await llmApi.profileModels(profile)).data.data,
    enabled: enabled && !!profile,
    staleTime: 60_000,
  });
}

export function useLlmCredentials() {
  return useQuery({
    queryKey: llmKeys.credentials(),
    queryFn: async () => (await llmApi.listCredentials()).data.data,
  });
}

export function useCreateLlmCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, apiKey }: { name: string; apiKey: string }) =>
      llmApi.createCredential(name, apiKey).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: llmKeys.credentials() }),
  });
}

export function useDeleteLlmCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => llmApi.deleteCredential(name).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: llmKeys.credentials() }),
  });
}

export function useLlmAnalysisScope() {
  return useQuery({
    queryKey: llmKeys.analysisScope(),
    queryFn: async () => (await llmApi.getAnalysisScope()).data.data,
  });
}

export function useUpdateLlmAnalysisScope() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: LlmAnalysisScope) => llmApi.updateAnalysisScope(data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: llmKeys.analysisScope() }),
  });
}
