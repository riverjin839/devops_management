import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { alarmRequestsApi } from '@/services/api';
import type { AlarmApplySettings, AlarmCatalogItemInput, AlarmRequestActionKind, AlarmRequestInput } from '@/types';

export const alarmRequestKeys = {
  all: ['alarm-requests'] as const,
  meta: ['alarm-requests', 'meta'] as const,
  list: ['alarm-requests', 'list'] as const,
  catalog: (includeDisabled: boolean) => ['alarm-requests', 'catalog', includeDisabled] as const,
  applySettings: ['alarm-requests', 'apply-settings'] as const,
  preview: (id: number) => ['alarm-requests', 'rule-preview', id] as const,
};

export function useAlarmRequestMeta() {
  return useQuery({
    queryKey: alarmRequestKeys.meta,
    queryFn: async () => (await alarmRequestsApi.meta()).data,
    staleTime: 5 * 60_000,
  });
}

/** 전체 요청 목록 — 필터는 화면에서 한다(요청 수가 많지 않고, 필터 전환마다 왕복하지 않게). */
export function useAlarmRequests() {
  return useQuery({
    queryKey: alarmRequestKeys.list,
    queryFn: async () => (await alarmRequestsApi.list()).data.data,
    staleTime: 15_000,
    refetchInterval: 60_000,
  });
}

export function useAlarmCatalog(includeDisabled = false) {
  return useQuery({
    queryKey: alarmRequestKeys.catalog(includeDisabled),
    queryFn: async () => (await alarmRequestsApi.catalog({ includeDisabled })).data,
    staleTime: 60_000,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: alarmRequestKeys.all });
}

export function useSaveAlarmRequest() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ id, data }: { id?: number | null; data: AlarmRequestInput }) =>
      (id ? await alarmRequestsApi.update(id, data) : await alarmRequestsApi.create(data)).data,
    onSuccess: invalidate,
  });
}

export function useCancelAlarmRequest() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: number) => alarmRequestsApi.cancel(id), onSuccess: invalidate });
}

export function useActOnAlarmRequest() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ id, action, comment }: { id: number; action: AlarmRequestActionKind; comment?: string }) =>
      (await alarmRequestsApi.act(id, { action, comment })).data,
    onSuccess: invalidate,
  });
}

export function useSaveAlarmCatalogItem() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ id, data }: { id?: number | null; data: AlarmCatalogItemInput }) =>
      (id ? await alarmRequestsApi.updateCatalog(id, data) : await alarmRequestsApi.createCatalog(data)).data,
    onSuccess: invalidate,
  });
}

export function useDeleteAlarmCatalogItem() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (id: number) => alarmRequestsApi.deleteCatalog(id), onSuccess: invalidate });
}

export function useAlarmApplySettings(enabled = true) {
  return useQuery({
    queryKey: alarmRequestKeys.applySettings,
    queryFn: async () => (await alarmRequestsApi.applySettings()).data,
    enabled,
    staleTime: 60_000,
  });
}

export function useSaveAlarmApplySettings() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (data: AlarmApplySettings) => (await alarmRequestsApi.saveApplySettings(data)).data,
    onSuccess: invalidate,
  });
}

/** 적용하면 만들어질 PrometheusRule YAML — 클러스터에 아무것도 보내지 않는다. */
export function useAlarmRulePreview(id: number | null, enabled: boolean) {
  return useQuery({
    queryKey: alarmRequestKeys.preview(id ?? 0),
    queryFn: async () => (await alarmRequestsApi.rulePreview(id as number)).data,
    enabled: enabled && id != null,
    staleTime: 0,
  });
}
