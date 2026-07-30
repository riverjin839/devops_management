import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { confluenceDocsApi, workGuidesApi } from '@/services/api';
import { workGuideKeys } from '@/hooks/useWorkGuide';
import type {
  ConfluenceDocExportRequest,
  ConfluenceDocImportRequest,
  ConfluenceDocSearchRequest,
  ConfluenceDocsSettings,
} from '@/types';

export const confluenceDocsKeys = {
  settings: ['confluence-docs', 'settings'] as const,
  guideSearch: (q: string) => ['work-guides', 'search', q] as const,
};

/** Confluence 페이지 검색 (가져오기 위저드 1단계) */
export function useConfluenceDocSearch() {
  return useMutation({
    mutationFn: async (data: ConfluenceDocSearchRequest) =>
      (await confluenceDocsApi.search(data)).data,
  });
}

/** 가져오기 — dryRun 프리뷰와 커밋 모두 이 훅으로 호출한다 */
export function useConfluenceDocImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: ConfluenceDocImportRequest) =>
      (await confluenceDocsApi.import(data)).data,
    onSuccess: (result) => {
      if (!result.dryRun) qc.invalidateQueries({ queryKey: workGuideKeys.all });
    },
  });
}

/** 문서 → Confluence 게시 (신규 생성 또는 같은 페이지 새 버전) */
export function useConfluenceDocExport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ guideId, data }: { guideId: string; data?: ConfluenceDocExportRequest }) =>
      (await confluenceDocsApi.export(guideId, data)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: workGuideKeys.all }),
  });
}

/** 연결된 Confluence 페이지 내용으로 다시 가져오기 (로컬 덮어쓰기) */
export function useConfluenceDocPull() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (guideId: string) => (await confluenceDocsApi.pull(guideId)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: workGuideKeys.all }),
  });
}

export function useConfluenceDocsSettings() {
  return useQuery({
    queryKey: confluenceDocsKeys.settings,
    queryFn: async () => (await confluenceDocsApi.settings()).data,
    staleTime: 1000 * 60,
  });
}

export function useUpdateConfluenceDocsSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: ConfluenceDocsSettings) =>
      (await confluenceDocsApi.updateSettings(data)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: confluenceDocsKeys.settings }),
  });
}

/** 문서 시맨틱 검색 (AI 검색 토글 on 일 때만 enabled) */
export function useGuideSearch(q: string, enabled: boolean) {
  return useQuery({
    queryKey: confluenceDocsKeys.guideSearch(q),
    queryFn: async () => (await workGuidesApi.search(q)).data,
    enabled: enabled && q.trim().length > 0,
    staleTime: 1000 * 30,
  });
}
