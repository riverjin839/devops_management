import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { scriptsApi } from '@/services/api';
import type {
  ExecutableScriptCreate,
  ExecutableScriptUpdate,
  ExecutableScriptVersionCreate,
  ScriptKind,
  ScriptTestRunRequest,
} from '@/types';

export const scriptsKeys = {
  list: (filter?: { kind?: ScriptKind; tag?: string; q?: string }) => ['scripts', filter] as const,
  detail: (id: string) => ['scripts', id] as const,
  versions: (id: string) => ['scripts', id, 'versions'] as const,
  accessSettings: ['scripts', 'access-settings'] as const,
};

export function useScripts(filter?: { kind?: ScriptKind; tag?: string; q?: string }) {
  return useQuery({
    queryKey: scriptsKeys.list(filter),
    queryFn: async () => {
      const { data } = await scriptsApi.list(filter);
      return data;
    },
  });
}

export function useScript(id: string | undefined) {
  return useQuery({
    queryKey: scriptsKeys.detail(id ?? ''),
    queryFn: async () => {
      const { data } = await scriptsApi.get(id!);
      return data;
    },
    enabled: !!id,
  });
}

export function useScriptVersions(id: string | undefined) {
  return useQuery({
    queryKey: scriptsKeys.versions(id ?? ''),
    queryFn: async () => {
      const { data } = await scriptsApi.listVersions(id!);
      return data;
    },
    enabled: !!id,
  });
}

export function useCreateScript() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ExecutableScriptCreate) => scriptsApi.create(data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scripts'] }),
  });
}

export function useUpdateScript(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ExecutableScriptUpdate) => scriptsApi.update(id, data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: scriptsKeys.detail(id) });
      qc.invalidateQueries({ queryKey: ['scripts'] });
    },
  });
}

export function useDeleteScript() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => scriptsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scripts'] }),
  });
}

export function useCreateScriptVersion(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ExecutableScriptVersionCreate) => scriptsApi.createVersion(id, data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: scriptsKeys.detail(id) });
      qc.invalidateQueries({ queryKey: scriptsKeys.versions(id) });
      qc.invalidateQueries({ queryKey: ['scripts'] });
    },
  });
}

export function useSetCurrentScriptVersion(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (versionId: string) => scriptsApi.setCurrentVersion(id, versionId).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: scriptsKeys.detail(id) });
      qc.invalidateQueries({ queryKey: ['scripts'] });
    },
  });
}

/** 테스트 실행 — 결과를 어디에도 영속화하지 않으므로 쿼리 무효화가 필요 없다. */
export function useTestRunScript(id: string) {
  return useMutation({
    mutationFn: (data: ScriptTestRunRequest) => scriptsApi.testRun(id, data).then((r) => r.data),
  });
}

export function useScriptAccessSettings() {
  return useQuery({
    queryKey: scriptsKeys.accessSettings,
    queryFn: async () => {
      const { data } = await scriptsApi.getAccessSettings();
      return data;
    },
  });
}

export function useUpdateScriptAccessSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (adminOnly: boolean) => scriptsApi.updateAccessSettings(adminOnly).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: scriptsKeys.accessSettings }),
  });
}
