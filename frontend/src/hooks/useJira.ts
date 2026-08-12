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

// Confluence 연동 — "Jira 가져오기"와 동일한 검색→선택→반영 패턴 + 행 단위 동기화(반영).
export function useConfluenceSearch() {
  return useMutation({
    mutationFn: ({ cql, limit }: { cql: string; limit?: number }) => jiraApi.confluenceSearch(cql, limit),
  });
}

export function useConfluenceLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: import('@/types').ConfluenceLinkRequest) => jiraApi.confluenceLink(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: workItemKeys.all }),
  });
}

export function useConfluenceSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => jiraApi.confluenceSync(itemId),
    onSuccess: (res) => {
      if (res.data.status === 'ok') qc.invalidateQueries({ queryKey: workItemKeys.all });
    },
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

// 프로비저닝 화면의 Epic/상위 이슈 선택 버튼 — 클릭 시점에만 조회하므로 useQuery 대신
// useMutation(다른 Confluence 검색류와 동일 패턴)으로 둔다.
export function useJiraIssueLookup() {
  return useMutation({
    mutationFn: ({ projectKey, issueType }: { projectKey: string; issueType: string }) =>
      jiraApi.lookupIssues(projectKey, issueType),
  });
}

// 상위 페이지 ID 입력칸 mouseover 툴팁 — 입력이 멈춘 뒤(디바운스)에만 조회하므로
// useJiraIssueLookup 과 동일하게 useMutation 으로 필요할 때만 부른다.
export function useConfluencePageInfo() {
  return useMutation({
    mutationFn: (pageId: string) => jiraApi.confluencePageInfo(pageId),
  });
}

// 상위 페이지 ID 아래 하위 페이지 "가져오기" 피커.
export function useConfluenceChildren() {
  return useMutation({
    mutationFn: (pageId: string) => jiraApi.confluenceChildren(pageId),
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

/** 연결 해제 (선택적으로 업무 삭제까지) — Jira 이슈는 건드리지 않는다. */
export function useJiraUnlink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, data }: { itemId: string; data?: import('@/types').JiraUnlinkRequest }) =>
      jiraApi.unlink(itemId, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: workItemKeys.all }),
  });
}

/** 연결을 다른 이슈로 갈아끼우기 — 서버가 존재를 확인한 뒤에만 반영한다. */
export function useJiraRelink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, data }: { itemId: string; data: import('@/types').JiraRelinkRequest }) =>
      jiraApi.relink(itemId, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: workItemKeys.all }),
  });
}

/** 죽은 Jira 링크 일괄 점검. */
export function useJiraVerifyLinks() {
  return useMutation({
    mutationFn: (allUsers?: boolean) => jiraApi.verifyLinks(allUsers ?? false),
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
