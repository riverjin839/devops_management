import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { savedScriptsApi } from '@/services/api';
import type { SavedScriptCreate, SavedScriptUpdate, ScriptLanguage } from '@/types';

export const savedScriptKeys = {
  all: ['saved-scripts'] as const,
  list: (language?: ScriptLanguage) => ['saved-scripts', 'list', language ?? null] as const,
};

export function useSavedScripts(language?: ScriptLanguage) {
  return useQuery({
    queryKey: savedScriptKeys.list(language),
    queryFn: async () => {
      const { data } = await savedScriptsApi.list(language);
      return data;
    },
  });
}

export function useCreateSavedScript() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: SavedScriptCreate) => savedScriptsApi.create(payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: savedScriptKeys.all }),
  });
}

export function useUpdateSavedScript() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: SavedScriptUpdate }) =>
      savedScriptsApi.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: savedScriptKeys.all }),
  });
}

export function useDeleteSavedScript() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => savedScriptsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: savedScriptKeys.all }),
  });
}
