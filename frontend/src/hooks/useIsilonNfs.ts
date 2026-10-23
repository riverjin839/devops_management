import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { isilonNfsApi } from '@/services/api';
import type {
  IsilonServerCreate,
  IsilonServerUpdate,
  IsilonCommandCreate,
  IsilonCommandUpdate,
} from '@/types';

export const isilonKeys = {
  servers: ['isilonServers'] as const,
  commands: (serverId?: string) => ['isilonCommands', serverId ?? 'global'] as const,
  overview: (serverId?: string) => ['isilonOverview', serverId ?? 'default'] as const,
};

export function useIsilonServers() {
  return useQuery({
    queryKey: isilonKeys.servers,
    queryFn: async () => {
      const { data } = await isilonNfsApi.servers.getAll();
      return data ?? [];
    },
  });
}

export function useIsilonCommands(serverId?: string, enabled = true) {
  return useQuery({
    queryKey: isilonKeys.commands(serverId),
    queryFn: async () => {
      const { data } = await isilonNfsApi.commands.getAll(serverId);
      return data ?? [];
    },
    enabled,
  });
}

export function useCreateIsilonServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: IsilonServerCreate) => isilonNfsApi.servers.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: isilonKeys.servers }),
  });
}

export function useUpdateIsilonServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: IsilonServerUpdate }) =>
      isilonNfsApi.servers.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: isilonKeys.servers }),
  });
}

export function useDeleteIsilonServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => isilonNfsApi.servers.delete(id),
    onSuccess: () => {
      // 서버 전용 명령은 FK ON DELETE CASCADE 로 함께 지워진다 — 명령 캐시도 비운다.
      qc.invalidateQueries({ queryKey: isilonKeys.servers });
      qc.invalidateQueries({ queryKey: ['isilonCommands'] });
    },
  });
}

export function useTestIsilonServer() {
  return useMutation({
    mutationFn: (id: string) => isilonNfsApi.servers.test(id),
  });
}

export function useCreateIsilonCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: IsilonCommandCreate) => isilonNfsApi.commands.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['isilonCommands'] }),
  });
}

export function useUpdateIsilonCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: IsilonCommandUpdate }) =>
      isilonNfsApi.commands.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['isilonCommands'] }),
  });
}

/** mc 클라이언트 패턴 — 등록된 명령 중 선택한 키만 온디맨드 실행(캐시 미사용). */
export function useRunIsilonCommands() {
  return useMutation({
    mutationFn: ({ serverId, keys }: { serverId: string; keys: string[] }) =>
      isilonNfsApi.runCommands(serverId, keys).then((r) => r.data),
  });
}

export function useDeleteIsilonCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => isilonNfsApi.commands.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['isilonCommands'] }),
  });
}
