import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { serviceNowApi } from '@/services/api';
import { workItemKeys } from '@/hooks/useWorkItems';
import type { ServiceNowConfigUpdate } from '@/types';

export const serviceNowKeys = {
  config: ['servicenow', 'config'] as const,
};

export function useServiceNowConfig() {
  return useQuery({
    queryKey: serviceNowKeys.config,
    queryFn: async () => (await serviceNowApi.getConfig()).data,
    staleTime: 1000 * 30,
  });
}

export function useUpdateServiceNowConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ServiceNowConfigUpdate) => serviceNowApi.updateConfig(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: serviceNowKeys.config }),
  });
}

export function useServiceNowTest() {
  return useMutation({ mutationFn: () => serviceNowApi.test() });
}

/** 업무 → ServiceNow ITSM 등록(수동 버튼). 성공 시 게시판의 티켓 링크가 바로 보이도록 갱신. */
export function useServiceNowRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => serviceNowApi.register(itemId),
    onSuccess: (res) => {
      if (res.data.status === 'ok') qc.invalidateQueries({ queryKey: workItemKeys.all });
    },
  });
}
