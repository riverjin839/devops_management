import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { reactionsApi } from '@/services/api';
import type { ReactionSummary, ReactionTargetType } from '@/types';

const key = (t: string, id: string) => ['reactions', t, id] as const;

export function useReactions(targetType: ReactionTargetType, targetId: string, enabled = true) {
  return useQuery({
    queryKey: key(targetType, targetId),
    queryFn: () => reactionsApi.get(targetType, targetId).then((r) => r.data),
    enabled: enabled && Boolean(targetId),
    staleTime: 30_000,
  });
}

export function useToggleReaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { targetType: ReactionTargetType; targetId: string; emoji: string }) =>
      reactionsApi.toggle(v.targetType, v.targetId, v.emoji).then((r) => r.data),
    onSuccess: (data: ReactionSummary) => {
      // 토글 응답이 최신 요약이므로 캐시를 그대로 갱신(추가 fetch 불필요).
      qc.setQueryData(key(data.targetType, data.targetId), data);
    },
  });
}
