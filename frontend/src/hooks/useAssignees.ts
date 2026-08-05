import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { assigneesApi } from '@/services/api';
import type { Assignee, SelfAssigneePatch } from '@/types';

export function useAssignees() {
  return useQuery({
    queryKey: ['assignees'],
    queryFn: () => assigneesApi.getAll().then(r => r.data.data ?? []),
    staleTime: 60_000,
  });
}

export function useUpdateAssignees() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (assignees: Assignee[]) => assigneesApi.update(assignees),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assignees'] }),
  });
}

/**
 * 본인 담당자 정보(이메일/IP/좌석/역할)만 수정. 전체 목록을 덮어쓰는 useUpdateAssignees 와
 * 달리 admin 권한이 필요 없어 operator/viewer 도 본인 정보를 저장할 수 있다.
 */
export function useUpdateMyAssignee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SelfAssigneePatch) => assigneesApi.updateMine(patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['assignees'] }),
  });
}
