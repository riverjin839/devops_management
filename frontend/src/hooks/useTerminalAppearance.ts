import type { CSSProperties } from 'react';
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { terminalAppearanceApi } from '@/services/api';
import { getAuthToken } from '@/stores/authStore';
import { useTerminalEnvStore } from '@/stores/terminalEnvStore';
import {
  DEFAULT_APPEARANCE,
  resolveActiveEnv,
  resolveProfileTheme,
  themeToCss,
} from '@/lib/terminalThemes';
import type { TerminalAppearance, TerminalAppearanceResponse, TerminalTemplate } from '@/types';

export const terminalAppearanceKeys = {
  all: ['terminalAppearance'] as const,
};

export function useTerminalAppearance() {
  return useQuery({
    queryKey: terminalAppearanceKeys.all,
    queryFn: async (): Promise<TerminalAppearanceResponse> => {
      const { data } = await terminalAppearanceApi.get();
      return data;
    },
    enabled: !!getAuthToken(),
    staleTime: 60_000,
    retry: false,
  });
}

export function useUpdateTerminalAppearance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (appearance: TerminalAppearance) => terminalAppearanceApi.save(appearance),
    onSuccess: (res) => {
      qc.setQueryData(terminalAppearanceKeys.all, res.data);
    },
  });
}

export function useUpdateSharedTemplates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (templates: TerminalTemplate[]) => terminalAppearanceApi.saveShared(templates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: terminalAppearanceKeys.all });
    },
  });
}

/**
 * 모든 LogViewer 가 사용하는 활성 터미널 테마(inline style + 글꼴 크기).
 * appearance 가 없거나 로딩 전이면 기본 팔레트로 안전하게 폴백한다.
 */
export function useLogTheme(): { style: CSSProperties; fontSize: number } {
  const { data } = useTerminalAppearance();
  const currentEnv = useTerminalEnvStore((s) => s.currentEnv);

  return useMemo(() => {
    const appearance = data?.appearance ?? DEFAULT_APPEARANCE;
    const shared = data?.shared ?? [];
    const env = resolveActiveEnv(appearance, currentEnv);
    const profile = appearance.profiles?.[env];
    const { palette, fontSize, fontFamily } = resolveProfileTheme(
      profile, appearance.customTemplates ?? [], shared,
    );
    return { style: themeToCss(palette, fontSize, fontFamily), fontSize };
  }, [data, currentEnv]);
}
