import {
  keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient,
} from '@tanstack/react-query';
import { observabilityApi } from '@/services/api';
import type { AlertNotifyRuleInput, AlertSettings } from '@/types';

export const alertInboxKeys = {
  all: ['alert-inbox'] as const,
  list: (params?: object) => ['alert-inbox', 'list', params] as const,
  stats: (clusterId?: string | null) => ['alert-inbox', 'stats', clusterId ?? 'none'] as const,
  rules: () => ['alert-inbox', 'rules'] as const,
  settings: () => ['alert-inbox', 'settings'] as const,
};

interface UseAlertsParams {
  clusterId?: string | null;
  severity?: string;
  status?: string;
  q?: string;
  acked?: boolean;
  limit?: number;
}

/** 알람 목록 한 페이지 크기 (D-111). */
export const ALERT_PAGE_SIZE = 100;

/**
 * 알람 목록 — offset 페이지를 "더 보기"로 이어 붙인다(D-111: 예전엔 200건 고정이라 그 뒤는 열람 불가).
 * 키는 'alert-inbox' 접두사를 유지해 확인·삭제 후 무효화가 그대로 걸린다.
 * 검색어가 바뀌는 동안 이전 결과를 유지해(placeholderData) 표가 깜빡이지 않게 한다.
 */
export function useAlertsPaged(params: Omit<UseAlertsParams, 'limit'>) {
  return useInfiniteQuery({
    queryKey: [...alertInboxKeys.list(params), 'paged', ALERT_PAGE_SIZE] as const,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      (await observabilityApi.alerts({ ...params, limit: ALERT_PAGE_SIZE, offset: pageParam })).data,
    getNextPageParam: (last, _all, lastOffset) => {
      const next = lastOffset + last.data.length;
      // hasMore 가 없는 구버전 응답이면 total 로 판정한다.
      const more = last.hasMore ?? next < last.total;
      return more && last.data.length > 0 ? next : undefined;
    },
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
}

export function useAlertStats(clusterId?: string | null, hours = 24) {
  return useQuery({
    queryKey: alertInboxKeys.stats(clusterId),
    queryFn: async () => (await observabilityApi.alertStats(clusterId, hours)).data,
    refetchInterval: 30_000,
  });
}

function useAlertMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: alertInboxKeys.all }),
  });
}

export function useAckAlert() {
  return useAlertMutation(({ id, acked }: { id: string; acked: boolean }) =>
    observabilityApi.ackAlert(id, acked));
}

export function useAckAllAlerts() {
  const qc = useQueryClient();
  return useMutation({
    // 처리 건수를 토스트에 쓰므로 공용 헬퍼(unknown 반환) 대신 반환 타입을 유지한다.
    mutationFn: (filter: { clusterId?: string | null; severity?: string; status?: string; q?: string }) =>
      observabilityApi.ackAllAlerts(filter).then((res) => res.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: alertInboxKeys.all }),
  });
}

export function useDeleteAlert() {
  return useAlertMutation((id: string) => observabilityApi.deleteAlert(id));
}

export function useAlertRules() {
  return useQuery({
    queryKey: alertInboxKeys.rules(),
    queryFn: async () => (await observabilityApi.alertRules()).data,
    staleTime: 60_000,
  });
}

export function useCreateAlertRule() {
  return useAlertMutation((data: AlertNotifyRuleInput) => observabilityApi.createAlertRule(data));
}

export function useUpdateAlertRule() {
  return useAlertMutation(({ id, data }: { id: string; data: AlertNotifyRuleInput }) =>
    observabilityApi.updateAlertRule(id, data));
}

export function useDeleteAlertRule() {
  return useAlertMutation((id: string) => observabilityApi.deleteAlertRule(id));
}

export function useAlertSettings() {
  return useQuery({
    queryKey: alertInboxKeys.settings(),
    queryFn: async () => (await observabilityApi.alertSettings()).data,
    staleTime: 60_000,
  });
}

export function useUpdateAlertSettings() {
  return useAlertMutation((data: Partial<AlertSettings>) =>
    observabilityApi.updateAlertSettings(data));
}
