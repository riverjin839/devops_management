import { useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ErrorState, LoadingState } from '@/components/common/EmptyState';
import { SwitchToggle } from '@/components/common/SwitchToggle';
import { useToastSafe } from '@/components/common/Toast';
import { useNotificationChannels, useNotificationDelivery, useSaveNotificationDelivery } from '@/hooks/useNotifications';
import { useAuthStore } from '@/stores/authStore';
import { formatApiError } from '@/lib/utils';
import type { NotificationDeliverySettings } from '@/types';

const ADMIN_HINT = 'admin 권한이 필요합니다';

/**
 * 개인 알림 외부 발송 채널 지정 — 메일(email 형 채널의 SMTP 설정 재사용)·메신저(webhook 형 채널).
 * 채널 자체의 등록·테스트 발송은 점검 리뷰/심층 점검 화면의 알림 채널 패널에서 한다. 조회는 operator, 저장은 admin.
 */
export function DeliverySettingsCard() {
  const toast = useToastSafe();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const { data, isLoading, error, refetch } = useNotificationDelivery(true);
  const { data: channels = [] } = useNotificationChannels(true);
  const save = useSaveNotificationDelivery();
  const [draft, setDraft] = useState<NotificationDeliverySettings | null>(null);

  useEffect(() => { if (data) setDraft(data); }, [data]);

  if (isLoading) return <MacCard title="발송 채널" icon={Send}><LoadingState compact /></MacCard>;
  if (error || !draft) return <MacCard title="발송 채널" icon={Send}><ErrorState compact error={error} onRetry={() => refetch()} /></MacCard>;

  const emailChannels = channels.filter((c) => c.channelType === 'email');
  const webhookChannels = channels.filter((c) => c.channelType === 'webhook');
  const dirty = JSON.stringify(draft) !== JSON.stringify(data);
  const set = (patch: Partial<NotificationDeliverySettings>) => setDraft((d) => d && ({ ...d, ...patch }));

  const onSave = () => save.mutate(draft, {
    onSuccess: () => toast.success('발송 채널을 저장했습니다'),
    onError: (e) => toast.error('발송 채널 저장 실패', formatApiError(e)),
  });

  const selectCls = 'h-8 min-w-[220px] px-2 rounded-xl border border-border bg-background text-sm disabled:opacity-60';

  return (
    <MacCard
      title="발송 채널"
      icon={Send}
      description="사용자가 메일·메신저로 받기를 고른 알림을 이 채널로 보냅니다(매분, 사용자별 방해 금지·요약 설정 적용)."
      actions={
        <button
          type="button"
          disabled={!isAdmin || !dirty || save.isPending}
          onClick={onSave}
          title={isAdmin ? '저장' : ADMIN_HINT}
          aria-label={isAdmin ? '발송 채널 저장' : `발송 채널 저장 — ${ADMIN_HINT}`}
          className="px-3 py-1.5 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {save.isPending ? '저장 중…' : '저장'}
        </button>
      }
    >
      <div className="space-y-3 text-sm">
        <SwitchToggle checked={draft.enabled} onChange={(v) => set({ enabled: v })} label="외부 발송 사용"
          disabled={!isAdmin} hint={ADMIN_HINT} />
        <label className="flex flex-wrap items-center gap-3">
          <span className="w-32 text-foreground">메일 채널</span>
          <select value={draft.emailChannelId ?? ''} disabled={!isAdmin}
            onChange={(e) => set({ emailChannelId: e.target.value || null })} className={selectCls}>
            <option value="">사용 안 함</option>
            {emailChannels.map((c) => <option key={c.id} value={c.id}>{c.name}{c.enabled ? '' : ' (꺼짐)'}</option>)}
          </select>
          <span className="text-xs text-muted-foreground">SMTP 설정을 쓰고 받는 사람만 각 사용자 메일로 바꿉니다.</span>
        </label>
        <label className="flex flex-wrap items-center gap-3">
          <span className="w-32 text-foreground">메신저 채널</span>
          <select value={draft.webhookChannelId ?? ''} disabled={!isAdmin}
            onChange={(e) => set({ webhookChannelId: e.target.value || null })} className={selectCls}>
            <option value="">사용 안 함</option>
            {webhookChannels.map((c) => <option key={c.id} value={c.id}>{c.name}{c.enabled ? '' : ' (꺼짐)'}</option>)}
          </select>
          <span className="text-xs text-muted-foreground">
            본문에 <code className="font-mono">recipient</code>·<code className="font-mono">employee_id</code>·<code className="font-mono">email</code>·<code className="font-mono">link</code> 를 함께 보냅니다.
          </span>
        </label>
        <label className="flex flex-wrap items-center gap-3">
          <span className="w-32 text-foreground">PEP 주소</span>
          <input value={draft.appBaseUrl} disabled={!isAdmin} placeholder="https://pep.example.com"
            onChange={(e) => set({ appBaseUrl: e.target.value })}
            className="h-8 w-72 px-2 rounded-xl border border-border bg-background text-sm disabled:opacity-60" />
          <span className="text-xs text-muted-foreground">메일·메신저의 링크 앞에 붙습니다. 비우면 경로만 보냅니다.</span>
        </label>
        {emailChannels.length + webhookChannels.length === 0 && (
          <p className="text-xs text-muted-foreground">
            등록된 email·webhook 채널이 없습니다. 심층 점검 설정 화면의 알림 채널에서 먼저 추가하세요.
          </p>
        )}
      </div>
    </MacCard>
  );
}
