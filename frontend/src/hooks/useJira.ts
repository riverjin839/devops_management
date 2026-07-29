import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { jiraApi } from '@/services/api';
import { workItemKeys } from '@/hooks/useWorkItems';
import type { JiraAuthType, JiraConfig, JiraImportRequest, JiraPushRequest } from '@/types';

export const jiraKeys = {
  config: ['jira', 'config'] as const,
  credential: ['jira', 'credential'] as const,
};

export function useJiraConfig() {
  return useQuery({
    queryKey: jiraKeys.config,
    queryFn: async () => (await jiraApi.getConfig()).data,
    staleTime: 1000 * 30,
  });
}

export function useUpdateJiraConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<JiraConfig>) => jiraApi.updateConfig(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: jiraKeys.config }),
  });
}

export function useJiraCredential() {
  return useQuery({
    queryKey: jiraKeys.credential,
    queryFn: async () => (await jiraApi.getCredential()).data,
    staleTime: 1000 * 30,
  });
}

export function useSaveJiraCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ token, authType, jiraAccount }: { token: string; authType?: JiraAuthType; jiraAccount?: string }) =>
      jiraApi.saveCredential(token, authType ?? 'pat', jiraAccount),
    onSuccess: () => qc.invalidateQueries({ queryKey: jiraKeys.credential }),
  });
}

export function useDeleteJiraCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => jiraApi.deleteCredential(),
    onSuccess: () => qc.invalidateQueries({ queryKey: jiraKeys.credential }),
  });
}

export function useJiraSsoLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data?: import('@/types').JiraSsoLoginRequest) => jiraApi.ssoLogin(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: jiraKeys.credential }),
  });
}

export function useJiraTest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => jiraApi.test(),
    onSuccess: () => qc.invalidateQueries({ queryKey: jiraKeys.credential }),
  });
}

export function useConfluenceTest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => jiraApi.confluenceTest(),
    // 자동 재로그인이 세션을 갱신했을 수 있으므로 상태 재조회.
    onSuccess: () => qc.invalidateQueries({ queryKey: jiraKeys.credential }),
  });
}

export function useSsoDiagnose() {
  return useMutation({ mutationFn: () => jiraApi.ssoDiagnose() });
}

export function useJiraImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: JiraImportRequest) => jiraApi.import(data),
    onSuccess: (res) => {
      // dry_run 이 아닐 때만 보드 갱신.
      if (!res.data.dryRun) qc.invalidateQueries({ queryKey: workItemKeys.all });
    },
  });
}

export function useProvisionDefaults(workItemId?: string, enabled = true) {
  return useQuery({
    queryKey: ['jira', 'provision-defaults', workItemId ?? ''] as const,
    queryFn: async () => (await jiraApi.provisionDefaults(workItemId)).data,
    enabled,
    staleTime: 1000 * 10,
  });
}

export function useProvision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: import('@/types').ProvisionRequest) => jiraApi.provision(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: workItemKeys.all }),
  });
}

export function useJiraRefreshItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => jiraApi.refreshItem(itemId),
    onSuccess: () => qc.invalidateQueries({ queryKey: workItemKeys.all }),
  });
}

export function useJiraCreateIssue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: import('@/types').JiraCreateRequest) => jiraApi.createIssue(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: workItemKeys.all }),
  });
}

export function useJiraDeleteIssue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => jiraApi.deleteIssue(key),
    onSuccess: () => qc.invalidateQueries({ queryKey: workItemKeys.all }),
  });
}

export function useWeeklyReportPreview() {
  return useMutation({
    mutationFn: (data?: import('@/types').WeeklyReportRequest) => jiraApi.weeklyPreview(data),
  });
}

export function useWeeklyReportPublish() {
  return useMutation({
    mutationFn: (data?: import('@/types').WeeklyPublishRequest) => jiraApi.weeklyPublish(data),
  });
}

export function useWeeklyReportSettings() {
  return useQuery({
    queryKey: [...jiraKeys.config, 'weekly'] as const,
    queryFn: async () => (await jiraApi.weeklySettings()).data,
    staleTime: 1000 * 30,
  });
}

export function useUpdateWeeklyReportSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: import('@/types').WeeklyReportSettings) => jiraApi.updateWeeklySettings(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...jiraKeys.config, 'weekly'] }),
  });
}

export function useJiraPush() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, data }: { itemId: string; data: JiraPushRequest }) =>
      jiraApi.push(itemId, data),
    onSuccess: (res) => {
      if (res.data.status === 'ok') qc.invalidateQueries({ queryKey: workItemKeys.all });
    },
  });
}
