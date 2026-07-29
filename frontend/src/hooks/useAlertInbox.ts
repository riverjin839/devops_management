import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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

export function useAlerts(params?: UseAlertsParams) {
  return useQuery({
    queryKey: alertInboxKeys.list(params),
    queryFn: async () => (await observabilityApi.alerts(params)).data,
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
    mutationFn: ({ clusterId, severity }: { clusterId?: string | null; severity?: string }) =>
      observabilityApi.ackAllAlerts(clusterId, severity).then((res) => res.data),
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
