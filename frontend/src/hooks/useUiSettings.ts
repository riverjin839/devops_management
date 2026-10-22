import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { uiSettingsApi } from '@/services/api';
import { ClusterEndpointAllowlist, ClusterLinksPayload, ClusterViewerMaskSetting, UiSettings, WorkItemBoardSettings } from '@/types';

export const uiSettingsKeys = {
  settings: ['uiSettings'] as const,
  clusterLinks: ['clusterLinks'] as const,
  workItemBoardSettings: ['workItemBoardSettings'] as const,
  clusterViewerMask: ['clusterViewerMask'] as const,
  clusterEndpointAllowlist: ['clusterEndpointAllowlist'] as const,
};

export function useUiSettings() {
  return useQuery({
    queryKey: uiSettingsKeys.settings,
    queryFn: async () => {
      const { data } = await uiSettingsApi.get();
      return data;
    },
  });
}

export function useUpdateUiSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Partial<UiSettings>) => uiSettingsApi.update(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: uiSettingsKeys.settings });
    },
  });
}

/** 응답의 문서 버전 — `data.version` 우선, 없으면 최상위 `version`(구버전 서버는 둘 다 없음 → null). */
function withLinksVersion(res: { data: ClusterLinksPayload; version?: string | null }): ClusterLinksPayload {
  const d = res.data ?? { commonLinks: [], clusterGroups: [] };
  return {
    commonLinks: d.commonLinks ?? [],
    clusterGroups: d.clusterGroups ?? [],
    version: d.version ?? res.version ?? null,
  };
}

/** 클러스터 주요 링크 문서 — 서버가 호출자에게 보이는 그룹만 돌려준다(고아 그룹은 admin 만). */
export function useClusterLinks() {
  return useQuery({
    queryKey: uiSettingsKeys.clusterLinks,
    queryFn: async () => {
      const { data } = await uiSettingsApi.getClusterLinks();
      return withLinksVersion(data);
    },
  });
}

/**
 * 링크 문서 저장(admin 전용). 성공하면 응답(새 버전 포함)을 캐시에 바로 넣어 다음 저장이 최신 버전을
 * 싣게 하고, 다시 읽어 서버 값과 맞춘다. 실패(403·409·422)는 호출자가 토스트·롤백한다.
 */
export function useUpdateClusterLinks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ClusterLinksPayload) => uiSettingsApi.updateClusterLinks(payload),
    onSuccess: (res) => {
      if (res?.data?.data) queryClient.setQueryData(uiSettingsKeys.clusterLinks, withLinksVersion(res.data));
      queryClient.invalidateQueries({ queryKey: uiSettingsKeys.clusterLinks });
    },
  });
}

export function useWorkItemBoardSettings() {
  return useQuery({
    queryKey: uiSettingsKeys.workItemBoardSettings,
    queryFn: async () => {
      const { data } = await uiSettingsApi.getWorkItemBoardSettings();
      return data.data;
    },
  });
}

export function useUpdateWorkItemBoardSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: WorkItemBoardSettings) => uiSettingsApi.updateWorkItemBoardSettings(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: uiSettingsKeys.workItemBoardSettings });
    },
  });
}

/** viewer 네트워크 정보 숨김 정책 — 켜고 끄면 /clusters 응답이 바뀌므로 클러스터 목록도 다시 읽는다. */
export function useClusterViewerMask() {
  return useQuery({
    queryKey: uiSettingsKeys.clusterViewerMask,
    queryFn: async () => {
      const { data } = await uiSettingsApi.getClusterViewerMask();
      return data.data;
    },
  });
}

export function useUpdateClusterViewerMask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ClusterViewerMaskSetting) => uiSettingsApi.updateClusterViewerMask(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: uiSettingsKeys.clusterViewerMask });
      queryClient.invalidateQueries({ queryKey: ['clusters'] });
    },
  });
}

/** 클러스터 API 엔드포인트 허용 대역 — 클러스터 생성·엔드포인트 변경·연결 검증에 적용. */
export function useClusterEndpointAllowlist() {
  return useQuery({
    queryKey: uiSettingsKeys.clusterEndpointAllowlist,
    queryFn: async () => {
      const { data } = await uiSettingsApi.getClusterEndpointAllowlist();
      return data.data;
    },
  });
}

export function useUpdateClusterEndpointAllowlist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ClusterEndpointAllowlist) => uiSettingsApi.updateClusterEndpointAllowlist(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: uiSettingsKeys.clusterEndpointAllowlist });
    },
  });
}
