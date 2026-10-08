import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { uiSettingsApi } from '@/services/api';
import { ClusterLinksPayload, ClusterViewerMaskSetting, UiSettings, WorkItemBoardSettings } from '@/types';

export const uiSettingsKeys = {
  settings: ['uiSettings'] as const,
  clusterLinks: ['clusterLinks'] as const,
  workItemBoardSettings: ['workItemBoardSettings'] as const,
  clusterViewerMask: ['clusterViewerMask'] as const,
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

export function useClusterLinks() {
  return useQuery({
    queryKey: uiSettingsKeys.clusterLinks,
    queryFn: async () => {
      const { data } = await uiSettingsApi.getClusterLinks();
      return data.data;
    },
  });
}

export function useUpdateClusterLinks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ClusterLinksPayload) => uiSettingsApi.updateClusterLinks(payload),
    onSuccess: () => {
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
