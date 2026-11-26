import { Eye, EyeOff } from 'lucide-react';
import { useToast } from '@/components/common';
import { useToggleWatchWorkItem } from '@/hooks/useWorkItems';
import { useAuthStore } from '@/stores/authStore';
import { formatApiError } from '@/lib/utils';
import type { WorkItem } from '@/types';

/** 업무 상세 헤더의 구독 버튼 — 구독하면 이 업무의 댓글·상태 변경을 알림으로 받는다(본인 설정이라 viewer 도 가능). */
export function WatchButton({ item }: { item: WorkItem }) {
  const username = useAuthStore((s) => s.user?.username);
  const toggle = useToggleWatchWorkItem();
  const toast = useToast();
  const watching = !!username && (item.watchers ?? []).includes(username);
  const count = (item.watchers ?? []).length;
  const label = watching ? '구독 해제' : '구독';
  return (
    <button
      type="button"
      disabled={!username || toggle.isPending}
      onClick={() => toggle.mutate({ id: item.id, watch: !watching }, {
        onSuccess: () => toast.success(watching ? '구독을 해제했습니다' : '구독했습니다 — 댓글·상태 변경을 알려 드립니다'),
        onError: (e) => toast.error('구독 변경 실패', formatApiError(e)),
      })}
      aria-pressed={watching}
      title={watching ? '이 업무의 알림을 그만 받습니다' : '담당자가 아니어도 이 업무의 댓글·상태 변경을 알림으로 받습니다'}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors disabled:opacity-50"
    >
      {watching ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      {label}{count > 0 ? ` ${count}` : ''}
    </button>
  );
}
