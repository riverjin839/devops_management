import { useMemo } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { commandsApi } from '@/services/api';
import type { CommandEntryCreate } from '@/types';

export const commandKeys = {
  all: ['commands'] as const,
  list: (params?: { category?: string; importance?: string; q?: string }) =>
    ['commands', 'list', params ?? null] as const,
  detail: (id: string) => ['commands', 'detail', id] as const,
};

/**
 * 수정 payload — 비운 선택 필드는 `null` 로 보내야 서버(`exclude_unset`)가 컬럼을 비운다(D-144).
 * `types` 의 `CommandEntryCreate` 는 `null` 을 허용하지 않아 여기서만 넓힌다.
 */
export type CommandEntryPatch = { [K in keyof CommandEntryCreate]?: CommandEntryCreate[K] | null };

/** 필터가 바뀌는 동안 이전 결과를 유지한다 — 검색어 입력마다 표가 로딩으로 비지 않게(D-148). */
export function useCommands(params?: { category?: string; importance?: string; q?: string }) {
  return useQuery({
    queryKey: commandKeys.list(params),
    queryFn: async () => {
      const { data } = await commandsApi.list(params);
      return data;
    },
    placeholderData: keepPreviousData,
  });
}

/** 카테고리 옵션 — 필터 없는 전체 목록에서 뽑는다. 필터 결과에서 뽑으면 카테고리 하나를 고른 순간
 *  드롭다운에 그 하나만 남아 다른 카테고리로 바로 바꿀 수 없다(D-148). 캐시는 `useCommands()` 와 공유. */
export function useCommandCategories() {
  const q = useCommands();
  const entries = q.data?.data;
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries ?? []) if (e.category) set.add(e.category);
    return Array.from(set).sort();
  }, [entries]);
  return categories;
}

export function useCreateCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: CommandEntryCreate) => commandsApi.create(payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: commandKeys.all }),
  });
}

export function useUpdateCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: CommandEntryPatch }) =>
      // null 은 "비우기" — api 시그니처가 null 을 모르는 타입이라 경계에서만 좁힌다.
      commandsApi.update(id, data as Partial<CommandEntryCreate>),
    onSuccess: () => qc.invalidateQueries({ queryKey: commandKeys.all }),
  });
}

export function useDeleteCommand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => commandsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: commandKeys.all }),
  });
}
